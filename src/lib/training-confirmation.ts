import "server-only";

import {
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
  type PendingTrainingEnrollmentRecord,
} from "@/lib/commerce/training-enrollment-store";

export interface GetVerifiedTrainingConfirmationInput {
  findEnrollmentByPublicOrderId?: (
    orderId: string,
  ) => Promise<PendingTrainingEnrollmentRecord | null>;
  orderId: string | undefined;
  programSlug: string;
}

export interface VerifiedTrainingConfirmation {
  orderId: string;
}

export async function getVerifiedTrainingConfirmation({
  findEnrollmentByPublicOrderId = getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
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

  return {
    orderId: publicOrderId,
  };
}
