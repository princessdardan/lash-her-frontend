import "server-only";

import { markWriterOperationUncertain } from "@/lib/writer-admission/context";

import {
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
} from "@/lib/commerce/training-enrollment-store";
import { sendTrainingPaymentNotificationEmailsIfNeeded } from "@/lib/commerce/training-payment-notifications";
import { buildTrainingScheduleUrl } from "@/lib/training-checkout";

export interface NotifyPaidTrainingOrderDependencies {
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: typeof getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId;
  getOrIssueTrainingSchedulingTokenForPaidOrder: typeof getOrIssueTrainingSchedulingTokenForPaidOrder;
  sendTrainingPaymentNotificationEmailsIfNeeded: typeof sendTrainingPaymentNotificationEmailsIfNeeded;
}

const defaultDependencies: NotifyPaidTrainingOrderDependencies = {
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  sendTrainingPaymentNotificationEmailsIfNeeded,
};

/**
 * Issue the scheduling token for a paid training order and send the student +
 * staff notifications (idempotent and awaited). The training analogue of the
 * product order confirmation email. Used for the Square card flow; the same
 * per-order helpers back the Afterpay invoice finalizer.
 */
export async function notifyPaidTrainingOrder(
  orderReference: string,
  origin?: string,
  dependencies: NotifyPaidTrainingOrderDependencies = defaultDependencies,
): Promise<void> {
  const enrollment =
    await dependencies.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(
      orderReference,
    );
  if (enrollment === null) {
    // A pending-only lookup also excludes scheduled/consumed enrollments. It
    // cannot prove interrupted enrollment or notification work is complete.
    markWriterOperationUncertain();
    return;
  }
  if (
    enrollment.studentPaymentEmailSentAt !== null &&
    enrollment.staffAlertedAt !== null
  ) {
    return;
  }

  const order = enrollment.checkoutOrder;
  const capturedCardPaymentId = order?.providerMetadata?.flow === "training_square_card"
    ? order.providerPaymentId ?? undefined
    : undefined;
  const issued = await dependencies.getOrIssueTrainingSchedulingTokenForPaidOrder(
    orderReference,
    undefined,
    capturedCardPaymentId,
  );
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

  await dependencies.sendTrainingPaymentNotificationEmailsIfNeeded({
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
