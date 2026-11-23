import "server-only";

import { sendTransactionalEmail } from "@/lib/transactional-email";
import { getSquareCoursePayment } from "@/lib/payments/square/payments-client";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { deliverEntitlement, PurchaseDependencyError } from "./course-api";
import {
  claimCourseJob,
  findCoursePayment,
  finishCourseJob,
  observeCoursePayment,
  readCourseOrder,
  readCourseRefund,
  readCourseRefundConfirmation,
  withCurrentCourseRegrant,
  type CourseJob,
  type CourseOrder,
} from "./store";
import { courseRecoveryEnabled } from "./policy";
import { renderCourseReceipt, renderCourseRefundReceipt } from "./receipt";
import { resolveCourseReceiptDestination } from "./receipt-destination";
import { rateTableTaxReference, recordCourseTax, reverseCourseTax } from "./tax";

export async function recoverCourseCapture(
  scope: { orderId: string; customerId: string; courseId: string },
  candidatePaymentId?: string,
) {
  const order = await readCourseOrder(scope.orderId, scope.customerId);
  if (!order || order.courseId !== scope.courseId) return "missing";
  if (candidatePaymentId && order.squarePaymentId && order.squarePaymentId !== candidatePaymentId)
    return "conflict";
  if (order.status !== "charging" || order.chargedAt)
    return candidatePaymentId && !order.squarePaymentId ? "conflict" : "skipped";
  const paymentId = candidatePaymentId ?? order.squarePaymentId;
  if (!paymentId) return "skipped";

  let unboundFingerprint: string | undefined;
  if (!order.squarePaymentId) {
    if (
      !order.sourceFingerprint ||
      !/^[a-f0-9]{64}$/u.test(order.sourceFingerprint)
    )
      return "skipped";
    unboundFingerprint = order.sourceFingerprint;
    if (await findCoursePayment(paymentId)) return "conflict";
  }
  const { requireCourseSquare } = await import("./checkout");
  const square = requireCourseSquare();
  if (square.locationId !== order.squareLocationId) throw new PurchaseDependencyError(502);
  const { payment } = await getSquareCoursePayment(square, paymentId);
  const observed = await observeCoursePayment(
    scope.orderId,
    payment,
    undefined,
    undefined,
    { paymentId, unboundFingerprint, customerId: scope.customerId, courseId: scope.courseId },
  );
  if (!observed) return "skipped";
  return observed.status === "charging" ? "pending" : "settled";
}

async function sendCourseDocument(
  order: CourseOrder,
  job: CourseJob,
  render: () => { subject: string; html: string } | Promise<{ subject: string; html: string }>,
) {
  const to = resolveCourseReceiptDestination(order, job.kind);
  if (to === null) return `p407-synthetic-receipt:${job.id}`;
  const result = await sendTransactionalEmail({
    to,
    idempotencyKey: job.id,
    ...await render(),
  });
  if (!result.id) throw new PurchaseDependencyError(502);
  return result.id;
}

async function dispatch(order: CourseOrder, job: CourseJob) {
  switch (job.kind) {
    case "grant":
    case "revoke": {
      const receipt = await deliverEntitlement(order, job);
      const access = receipt?.status === "active" ? "active" : "revoked";
      return { receipt: receipt?.grantId, access } as const;
    }
    case "tax_sale":
      return {
        receipt: order.taxCalculation === rateTableTaxReference(order.id)
          ? order.taxCalculation
          : await recordCourseTax(order.taxCalculation, job.id),
      };
    case "tax_refund": {
      if (order.taxCalculation === rateTableTaxReference(order.id)) {
        if (order.taxTransactionId !== order.taxCalculation)
          throw new PurchaseDependencyError(409);
        return {};
      }
      const refund = job.refundId
        ? await readCourseRefund(job.refundId)
        : undefined;
      if (!order.taxTransactionId || !refund || refund.orderId !== order.id)
        throw new PurchaseDependencyError(409);
      return {
        receipt: await reverseCourseTax(
          order.taxTransactionId,
          refund.amountCents,
          job.id,
        ),
      };
    }
    case "receipt":
    case "refund_receipt":
      // Resend keys expire after 24 hours. A late automatic retry requires a
      // reviewed destination check rather than risking duplicate receipt mail.
      if (Date.now() - job.createdAt.getTime() > 23 * 3600_000)
        throw new PurchaseDependencyError(409);
      return { receipt: await sendCourseDocument(order, job, async () => {
        if (job.kind === "receipt")
          return { subject: "Your Lash Her course payment receipt", html: renderCourseReceipt(order) };
        if (!job.refundId) throw new PurchaseDependencyError(409);
        const confirmation = await readCourseRefundConfirmation(order.id, job.refundId);
        if (!confirmation?.taxReceipt) throw new PurchaseDependencyError(502);
        return {
          subject: `Your Lash Her Academy refund for order ${order.id}`,
          html: renderCourseRefundReceipt(order, confirmation.refund, confirmation.taxReceipt, job.createdAt),
        };
      }) };
  }
}

/** The caller owns recovery admission. Each claimed job uses the same semantic key on every retry. */
export async function drainCourseJobs(orderId?: string, limit = 4) {
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index++) {
    const claim = await claimCourseJob(orderId);
    if (!claim) break;
    const { order, job } = claim;
    try {
      const result =
        job.kind === "grant" && job.accessGeneration > 0
          ? await withCurrentCourseRegrant(order.customerId, job, dispatch)
          : await dispatch(order, job);
      await finishCourseJob(job, result ?? {});
      completed++;
    } catch (error) {
      const status =
        error instanceof PurchaseDependencyError ? error.status : 502;
      await finishCourseJob(job, {
        failure: `dependency_${status}`,
        retry:
          status >= 500 ||
          status === 429 ||
          (job.kind === "revoke" && status === 404),
      });
      failed++;
    }
  }
  return { completed, failed };
}

export async function attemptCourseRecovery(id: string) {
  if (!courseRecoveryEnabled()) return;
  try {
    await runWriterAdmission("recovery", () => drainCourseJobs(id, 1), { p407CourseOrderId: id });
  } catch {
    // Financial state and the jobs were already committed. Manual recovery
    // owns the next try if the gate or a dependency denied this attempt.
  }
}
