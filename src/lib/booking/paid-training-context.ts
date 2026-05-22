import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type { BookingRequestInput, PaidTrainingBookingContext } from "./types";

const GENERIC_TRAINING_LINK_ERROR = "We could not verify this training scheduling link.";

export type PaidTrainingContextResolution =
  | { ok: true; input: BookingRequestInput; context: PaidTrainingBookingContext | null }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export type FindPaidTrainingIntroEligibility = (input: {
  schedulingToken: string;
}) => Promise<PendingTrainingEnrollmentRecord | null>;

export type TrainingIntroCallEligibilityResolution =
  | { ok: true; context: PaidTrainingBookingContext }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function resolvePaidTrainingBookingContext(
  input: BookingRequestInput,
  findPaidEnrollment: FindPaidTrainingIntroEligibility,
): Promise<PaidTrainingContextResolution> {
  const schedulingToken = input.paidSchedulingToken?.trim();
  const programSlug = input.paidTrainingSlug?.trim();

  if (!schedulingToken && !programSlug) {
    return { ok: true, input, context: null };
  }

  const eligibility = await resolveTrainingIntroCallEligibility(
    {
      programSlug: programSlug ?? "",
      schedulingToken: schedulingToken ?? "",
    },
    findPaidEnrollment,
  );

  if (!eligibility.ok) {
    return eligibility;
  }

  return {
    ok: true,
    input: {
      ...input,
      bookingType: "training-call",
      email: eligibility.context.checkoutEmail,
      paidSchedulingToken: schedulingToken,
      paidTrainingSlug: programSlug,
    },
    context: eligibility.context,
  };
}

export async function resolveTrainingIntroCallEligibility(
  input: {
    now?: Date;
    programSlug: string;
    schedulingToken: string;
  },
  findPaidEnrollment: FindPaidTrainingIntroEligibility,
): Promise<TrainingIntroCallEligibilityResolution> {
  const schedulingToken = input.schedulingToken.trim();
  const programSlug = input.programSlug.trim();

  if (schedulingToken.length === 0 || programSlug.length === 0) {
    return {
      ok: false,
      error: GENERIC_TRAINING_LINK_ERROR,
      fieldErrors: { schedulingToken: "Valid training scheduling link is required" },
    };
  }

  const enrollment = await findPaidEnrollment({ schedulingToken });

  if (enrollment === null || !isEnrollmentEligible(enrollment, programSlug, input.now ?? new Date())) {
    return {
      ok: false,
      error: GENERIC_TRAINING_LINK_ERROR,
    };
  }

  return {
    ok: true,
    context: {
      checkoutEmail: enrollment.checkoutEmail,
      enrollmentId: enrollment.enrollmentId,
      programTitle: enrollment.programSnapshot.title,
      publicOrderId: enrollment.checkoutOrder.orderId,
      schedulingToken,
    },
  };
}

function isEnrollmentEligible(
  enrollment: PendingTrainingEnrollmentRecord,
  programSlug: string,
  now: Date,
): boolean {
  return enrollment.programSnapshot.slug === programSlug
    && enrollment.checkoutOrder.status === "paid"
    && enrollment.tokenExpiresAt !== null
    && enrollment.tokenExpiresAt > now;
}
