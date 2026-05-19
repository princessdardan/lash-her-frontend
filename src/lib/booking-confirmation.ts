import "server-only";

import { getAppointmentHoldByCheckoutOrderPublicId } from "./booking/holds";
import type { BookingHoldRecord } from "./booking/holds";

export type VerifiedBookingConfirmationStatus =
  | "booked"
  | "paid_pending_booking"
  | "manual_followup"
  | "booking_failed";

export interface VerifiedBookingConfirmation {
  orderId: string;
  status: VerifiedBookingConfirmationStatus;
}

export interface GetVerifiedBookingConfirmationInput {
  findAppointmentByPublicOrderId?: (input: { publicOrderId: string }) => Promise<BookingHoldRecord | null>;
  orderId?: string | null;
}

const CONFIRMABLE_BOOKING_STATUSES: readonly VerifiedBookingConfirmationStatus[] = [
  "booked",
  "paid_pending_booking",
  "manual_followup",
  "booking_failed",
];

export async function getVerifiedBookingConfirmation(
  input: GetVerifiedBookingConfirmationInput,
): Promise<VerifiedBookingConfirmation | null> {
  const orderId = input.orderId?.trim();

  if (orderId === undefined || orderId.length === 0) {
    return null;
  }

  const findAppointmentByPublicOrderId =
    input.findAppointmentByPublicOrderId ?? defaultFindAppointmentByPublicOrderId;
  const appointment = await findAppointmentByPublicOrderId({ publicOrderId: orderId });

  if (appointment === null || !isConfirmableBookingStatus(appointment.state)) {
    return null;
  }

  return {
    orderId,
    status: appointment.state,
  };
}

async function defaultFindAppointmentByPublicOrderId(input: {
  publicOrderId: string;
}): Promise<BookingHoldRecord | null> {
  return getAppointmentHoldByCheckoutOrderPublicId(input.publicOrderId);
}

function isConfirmableBookingStatus(
  status: BookingHoldRecord["state"],
): status is VerifiedBookingConfirmationStatus {
  return CONFIRMABLE_BOOKING_STATUSES.includes(status as VerifiedBookingConfirmationStatus);
}
