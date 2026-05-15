import "server-only";

import {
  findPendingTrainingEnrollmentByToken,
  type FindPendingTrainingEnrollmentByTokenInput,
  type PendingTrainingEnrollmentRecord,
} from "@/lib/commerce/training-enrollment-store";

export interface GetVerifiedTrainingConfirmationInput {
  findEnrollmentByToken?: (
    input: FindPendingTrainingEnrollmentByTokenInput,
  ) => Promise<PendingTrainingEnrollmentRecord | null>;
  orderId: string | undefined;
  programSlug: string;
  schedulingToken: string | undefined;
}

export interface VerifiedTrainingConfirmation {
  orderId: string;
  schedulingToken: string;
}

export async function getVerifiedTrainingConfirmation({
  findEnrollmentByToken = findPendingTrainingEnrollmentByToken,
  orderId,
  programSlug,
  schedulingToken,
}: GetVerifiedTrainingConfirmationInput): Promise<VerifiedTrainingConfirmation | null> {
  if (!orderId || !schedulingToken) {
    return null;
  }

  const enrollment = await findEnrollmentByToken({ schedulingToken });

  if (!enrollment) {
    return null;
  }

  if (enrollment.checkoutOrder.orderId !== orderId) {
    return null;
  }

  if (enrollment.programSnapshot.slug !== programSlug) {
    return null;
  }

  return {
    orderId,
    schedulingToken,
  };
}
