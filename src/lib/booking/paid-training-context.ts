import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type { BookingRequestInput, PaidTrainingBookingContext } from "./types";

export type FindPendingTrainingEnrollment = (input: {
  schedulingToken: string;
}) => Promise<PendingTrainingEnrollmentRecord | null>;

export type PaidTrainingContextResolution =
  | { ok: true; input: BookingRequestInput; context: PaidTrainingBookingContext | null }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function resolvePaidTrainingBookingContext(
  input: BookingRequestInput,
  findPendingEnrollment: FindPendingTrainingEnrollment,
): Promise<PaidTrainingContextResolution> {
  const schedulingToken = input.paidSchedulingToken?.trim();

  if (!schedulingToken) {
    return { ok: true, input, context: null };
  }

  const enrollment = await findPendingEnrollment({ schedulingToken });

  if (enrollment === null) {
    return {
      ok: false,
      error: "This training scheduling link is invalid or has expired.",
    };
  }

  if (!emailsMatch(input.email, enrollment.checkoutEmail)) {
    return {
      ok: false,
      error: "Please use the same email address used at checkout.",
      fieldErrors: {
        email: "Use the same email address used at checkout",
      },
    };
  }

  return {
    ok: true,
    input: {
      ...input,
      bookingType: "training-call",
      paidSchedulingToken: schedulingToken,
    },
    context: {
      enrollmentId: enrollment.enrollmentId,
      programTitle: enrollment.programSnapshot.title,
      publicOrderId: enrollment.checkoutOrder.orderId,
    },
  };
}

export function emailsMatch(inputEmail: string, checkoutEmail: string): boolean {
  return normalizeEmail(inputEmail) === normalizeEmail(checkoutEmail);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
