import "server-only";

import {
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
} from "@/lib/commerce/training-enrollment-store";
import { sendTrainingPaymentNotificationEmailsIfNeeded } from "@/lib/commerce/training-payment-notifications";
import { buildTrainingScheduleUrl } from "@/lib/training-checkout";

/**
 * Issue the scheduling token for a paid training order and send the student +
 * staff notifications (idempotent, non-blocking). The training analogue of the
 * product order confirmation email. Used for the Square card flow; the same
 * per-order helpers back the Afterpay invoice finalizer.
 */
export async function notifyPaidTrainingOrder(
  orderReference: string,
  origin?: string,
): Promise<void> {
  const enrollment =
    await getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(
      orderReference,
    );
  if (enrollment === null) {
    return;
  }
  if (
    enrollment.studentPaymentEmailSentAt !== null &&
    enrollment.staffAlertedAt !== null
  ) {
    return;
  }

  const issued =
    await getOrIssueTrainingSchedulingTokenForPaidOrder(orderReference);
  if (issued === null) {
    throw new Error("Training scheduling token could not be issued");
  }

  const programSlug = enrollment.programSnapshot.slug;
  if (!programSlug) {
    throw new Error("Training program slug is required for scheduling");
  }

  const schedulingUrl = new URL(
    buildTrainingScheduleUrl({
      programSlug,
      schedulingToken: issued.schedulingToken,
    }),
    resolveSchedulingOrigin(origin),
  ).toString();

  await sendTrainingPaymentNotificationEmailsIfNeeded({
    enrollment,
    paymentProvider: "square",
    schedulingUrl,
  });
}

function resolveSchedulingOrigin(origin: string | undefined): string {
  const resolved =
    origin ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    toVercelOrigin(process.env.VERCEL_URL);

  if (resolved === undefined || resolved.length === 0) {
    throw new Error("Training scheduling origin is required");
  }

  return resolved;
}

function toVercelOrigin(vercelUrl: string | undefined): string | undefined {
  if (vercelUrl === undefined || vercelUrl.length === 0) {
    return undefined;
  }

  return vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`;
}
