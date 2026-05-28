import "server-only";

import { sendBookingConfirmationEmailForOrder } from "@/lib/booking/email";
import { sendProductOrderConfirmationEmailForOrder } from "@/lib/commerce/product-order-email";
import { sendTrainingPaymentNotificationEmailsIfNeeded } from "@/lib/commerce/training-payment-notifications";
import {
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
} from "@/lib/commerce/training-enrollment-store";
import { buildTrainingScheduleUrl } from "@/lib/training-checkout";

export type TransactionalEmailRetryFlow = "booking" | "product" | "training";

export interface RetryTransactionalEmailInput {
  flow: TransactionalEmailRetryFlow;
  orderId: string;
  origin: string;
}

export interface RetryTransactionalEmailResult {
  flow: TransactionalEmailRetryFlow;
  orderId: string;
  status: "processed" | "skipped";
}

export interface TransactionalEmailRetryDependencies {
  getOrIssueTrainingSchedulingTokenForPaidOrder: typeof getOrIssueTrainingSchedulingTokenForPaidOrder;
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: typeof getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId;
  sendBookingConfirmationEmailForOrder: typeof sendBookingConfirmationEmailForOrder;
  sendProductOrderConfirmationEmailForOrder: typeof sendProductOrderConfirmationEmailForOrder;
  sendTrainingPaymentNotificationEmailsIfNeeded: typeof sendTrainingPaymentNotificationEmailsIfNeeded;
}

const defaultDependencies: TransactionalEmailRetryDependencies = {
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
  sendBookingConfirmationEmailForOrder,
  sendProductOrderConfirmationEmailForOrder,
  sendTrainingPaymentNotificationEmailsIfNeeded,
};

export async function retryTransactionalEmail(
  input: RetryTransactionalEmailInput,
  dependencies: TransactionalEmailRetryDependencies = defaultDependencies,
): Promise<RetryTransactionalEmailResult> {
  const orderId = normalizeOrderId(input.orderId);

  switch (input.flow) {
    case "booking":
      await dependencies.sendBookingConfirmationEmailForOrder(orderId);
      return { flow: input.flow, orderId, status: "processed" };

    case "product":
      await dependencies.sendProductOrderConfirmationEmailForOrder(orderId);
      return { flow: input.flow, orderId, status: "processed" };

    case "training":
      return retryTrainingPaymentNotificationEmail({ dependencies, orderId, origin: input.origin });
  }
}

async function retryTrainingPaymentNotificationEmail(input: {
  dependencies: TransactionalEmailRetryDependencies;
  orderId: string;
  origin: string;
}): Promise<RetryTransactionalEmailResult> {
  const enrollment = await input.dependencies.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(input.orderId);

  if (enrollment === null) {
    return { flow: "training", orderId: input.orderId, status: "skipped" };
  }

  const programSlug = enrollment.programSnapshot.slug;

  if (!programSlug) {
    throw new Error("Training program slug is missing");
  }

  const schedulingToken = await input.dependencies.getOrIssueTrainingSchedulingTokenForPaidOrder(input.orderId);

  if (schedulingToken === null) {
    throw new Error("Training scheduling token could not be issued");
  }

  await input.dependencies.sendTrainingPaymentNotificationEmailsIfNeeded({
    enrollment,
    paymentProvider: enrollment.checkoutOrder.paymentProvider,
    schedulingUrl: buildAbsoluteSchedulingUrl(input.origin, programSlug, schedulingToken.schedulingToken),
  });

  return { flow: "training", orderId: input.orderId, status: "processed" };
}

function buildAbsoluteSchedulingUrl(origin: string, programSlug: string, schedulingToken: string): string {
  return new URL(
    buildTrainingScheduleUrl({
      programSlug,
      schedulingToken,
    }),
    origin,
  ).toString();
}

function normalizeOrderId(orderId: string): string {
  const trimmed = orderId.trim();

  if (trimmed.length === 0) {
    throw new Error("Order ID is required");
  }

  return trimmed;
}
