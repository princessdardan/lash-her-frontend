import "server-only";

import type { VerifiedSquareWebhookEvent } from "@/lib/booking/square-webhook";
import {
  getSquareCoursePayment,
  getSquareCourseRefund,
} from "@/lib/payments/square/payments-client";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { requireCourseSquare } from "./checkout";
import { courseRecoveryEnabled } from "./policy";
import { drainCourseJobs } from "./recovery";
import {
  findCoursePayment,
  lookupReference,
  observeCoursePayment,
  unresolvedCoursePaymentExists,
} from "./store";

/** Called only after the existing Square handler verifies the raw signature. */
export async function handleCourseSquareEvent(
  event: VerifiedSquareWebhookEvent,
) {
  if (
    !event.paymentId ||
    (!event.refund &&
      !["payment.created", "payment.updated"].includes(event.eventType))
  )
    return false;
  const signedReference = lookupReference(event.referenceId);
  if (!courseRecoveryEnabled()) {
    if (signedReference) throw new Error("Course reconciliation is disabled");
    return false;
  }
  const binding = signedReference
    ? undefined
    : await findCoursePayment(event.paymentId);
  if (
    !signedReference &&
    !binding &&
    (!event.refund || !(await unresolvedCoursePaymentExists()))
  )
    return false;
  const square = requireCourseSquare();
  const { payment } = await getSquareCoursePayment(square, event.paymentId);
  const id = lookupReference(payment.reference_id);
  if (!id && !signedReference && !binding) return false;
  if (
    !id ||
    (signedReference && id !== signedReference) ||
    (binding && binding.id !== id) ||
    payment.id !== event.paymentId
  )
    throw new Error("Square observation does not match the Course order");
  const refund = event.refund
    ? (await getSquareCourseRefund(square, event.refund.refundId)).refund
    : undefined;
  if (
    refund &&
    (refund.id !== event.refund?.refundId || refund.payment_id !== payment.id)
  )
    throw new Error("Square observation does not match the Course refund");
  await runWriterAdmission("recovery", async () => {
    await observeCoursePayment(
      id,
      payment,
      refund?.status === "COMPLETED" ? refund : undefined,
    );
    await drainCourseJobs(id, 1);
  });
  return true;
}
