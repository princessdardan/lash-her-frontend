import "server-only";

import { escapeHtml, sendTransactionalEmail } from "@/lib/transactional-email";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { deliverEntitlement, PurchaseDependencyError } from "./course-api";
import {
  claimCourseJob,
  finishCourseJob,
  readCourseRefund,
  type CourseJob,
  type CourseOrder,
} from "./store";
import { courseRecoveryEnabled } from "./policy";
import { recordCourseTax, reverseCourseTax } from "./tax";

async function sendReceipt(order: CourseOrder, job: CourseJob) {
  const dollars = (amount: number) =>
    Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      currencyDisplay: "code",
    }).format(amount / 100);
  // The receipt always describes the original payment, even when it is delivered after a refund.
  const result = await sendTransactionalEmail({
    to: order.email,
    subject: "Your Lash Her course payment receipt",
    idempotencyKey: job.id,
    html: `<h1>Course payment receipt</h1><p>${escapeHtml(order.courseTitle)}</p><p>Order ${order.id}</p><p>Paid ${dollars(order.totalCents)} including tax of ${dollars(order.taxCents)}.</p><p>${escapeHtml(order.disclosure)}</p>`,
  });
  if (!result.id) throw new PurchaseDependencyError(502);
  return result.id;
}

async function dispatch(order: CourseOrder, job: CourseJob) {
  switch (job.kind) {
    case "grant":
    case "revoke": {
      const receipt = await deliverEntitlement(order, job);
      const access = receipt.status === "active" ? "active" : "revoked";
      return { receipt: receipt.grantId, access } as const;
    }
    case "tax_sale":
      return { receipt: await recordCourseTax(order.taxCalculation, job.id) };
    case "tax_refund": {
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
      // Resend keys expire after 24 hours. A late automatic retry requires a
      // reviewed destination check rather than risking duplicate receipt mail.
      if (Date.now() - job.createdAt.getTime() > 23 * 3600_000)
        throw new PurchaseDependencyError(409);
      return { receipt: await sendReceipt(order, job) };
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
      await finishCourseJob(job, await dispatch(order, job));
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
    await runWriterAdmission("recovery", () => drainCourseJobs(id, 1));
  } catch {
    // Financial state and the jobs were already committed. Manual recovery
    // owns the next try if the gate or a dependency denied this attempt.
  }
}
