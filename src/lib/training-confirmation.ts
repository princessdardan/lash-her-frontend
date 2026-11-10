import "server-only";

import { verifyTrainingCardCapture } from "@/lib/commerce/square-training-checkout";

import {
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
  type PendingTrainingEnrollmentRecord,
} from "@/lib/commerce/training-enrollment-store";

export interface GetVerifiedTrainingConfirmationInput {
  findEnrollmentByPublicOrderId?: (
    orderId: string,
  ) => Promise<PendingTrainingEnrollmentRecord | null>;
  verifyCardCapture?: typeof verifyTrainingCardCapture;
  orderId: string | undefined;
  programSlug: string;
}

export interface VerifiedTrainingConfirmation {
  orderId: string;
  capturedCardPaymentId?: string;
}

export async function getVerifiedTrainingConfirmation({
  findEnrollmentByPublicOrderId = getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
  verifyCardCapture = verifyTrainingCardCapture,
  orderId,
  programSlug,
}: GetVerifiedTrainingConfirmationInput): Promise<VerifiedTrainingConfirmation | null> {
  const publicOrderId = orderId?.trim();

  if (!publicOrderId) {
    return null;
  }

  const enrollment = await findEnrollmentByPublicOrderId(publicOrderId);

  if (!enrollment) {
    return null;
  }

  if (enrollment.checkoutOrder.orderId !== publicOrderId) {
    return null;
  }

  if (enrollment.programSnapshot.slug !== programSlug) {
    return null;
  }

  const order = enrollment.checkoutOrder;
  if (
    order.paymentProvider === "square" &&
    order.providerMetadata?.flow === "training_square_card"
  ) {
    if (!order.providerPaymentId || !(await verifyCardCapture(order))) return null;
    return { orderId: publicOrderId, capturedCardPaymentId: order.providerPaymentId };
  }

  return { orderId: publicOrderId };
}
