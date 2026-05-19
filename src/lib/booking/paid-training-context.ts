import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type { BookingRequestInput, PaidTrainingBookingContext } from "./types";

export type PaidTrainingContextResolution =
  | { ok: true; input: BookingRequestInput; context: PaidTrainingBookingContext | null }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export type FindPaidTrainingIntroEligibility = (input: {
  publicOrderId: string;
}) => Promise<PendingTrainingEnrollmentRecord | null>;

export type TrainingIntroCallEligibilityResolution =
  | { ok: true; context: PaidTrainingBookingContext }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function resolvePaidTrainingBookingContext(
  input: BookingRequestInput,
  findPaidEnrollment: FindPaidTrainingIntroEligibility,
): Promise<PaidTrainingContextResolution> {
  const publicOrderId = input.paidTrainingOrderId?.trim();

  if (!publicOrderId) {
    return { ok: true, input, context: null };
  }

  const eligibility = await resolveTrainingIntroCallEligibility(
    {
      checkoutEmail: input.email,
      publicOrderId,
      sourcePath: input.sourcePath,
    },
    findPaidEnrollment,
  );

  if (!eligibility.ok) {
    return {
      ok: false,
      error: eligibility.error,
      fieldErrors: toBookingFieldErrors(eligibility.fieldErrors),
    };
  }

  return {
    ok: true,
    input: {
      ...input,
      bookingType: "training-call",
      paidTrainingOrderId: publicOrderId,
    },
    context: eligibility.context,
  };
}

export function emailsMatch(inputEmail: string, checkoutEmail: string): boolean {
  return normalizeEmail(inputEmail) === normalizeEmail(checkoutEmail);
}

export async function resolveTrainingIntroCallEligibility(
  input: {
    checkoutEmail: string;
    publicOrderId: string;
    sourcePath?: string;
  },
  findPaidEnrollment: FindPaidTrainingIntroEligibility,
): Promise<TrainingIntroCallEligibilityResolution> {
  const publicOrderId = input.publicOrderId.trim();

  if (publicOrderId.length === 0) {
    return {
      ok: false,
      error: "Training purchase confirmation is required before booking.",
      fieldErrors: { publicOrderId: "Training purchase confirmation is required" },
    };
  }

  const enrollment = await findPaidEnrollment({ publicOrderId });

  if (enrollment === null) {
    return {
      ok: false,
      error: "We could not find a paid training enrollment for this order.",
    };
  }

  if (!emailsMatch(input.checkoutEmail, enrollment.checkoutEmail)) {
    return {
      ok: false,
      error: "Please use the same email address used at checkout.",
      fieldErrors: {
        checkoutEmail: "Use the same email address used at checkout",
      },
    };
  }

  return {
    ok: true,
    context: {
      enrollmentId: enrollment.enrollmentId,
      programTitle: enrollment.programSnapshot.title,
      publicOrderId: enrollment.checkoutOrder.orderId,
    },
  };
}

function toBookingFieldErrors(fieldErrors: Record<string, string> | undefined): Record<string, string> | undefined {
  if (fieldErrors === undefined) {
    return undefined;
  }

  const mapped = { ...fieldErrors };

  if (mapped.checkoutEmail !== undefined) {
    mapped.email = mapped.checkoutEmail;
    delete mapped.checkoutEmail;
  }

  return mapped;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
