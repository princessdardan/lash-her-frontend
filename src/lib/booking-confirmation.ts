import "server-only";

import { getAppointmentHoldByCheckoutOrderPublicId } from "./booking/holds";
import type { BookingHoldRecord } from "./booking/holds";
import { buildServiceBookingConfirmationUrl } from "./training-checkout";

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

export interface GetVerifiedServiceBookingConfirmationInput extends GetVerifiedBookingConfirmationInput {
  serviceSlug?: string | null;
}

const CONFIRMABLE_BOOKING_STATUSES: readonly VerifiedBookingConfirmationStatus[] = [
  "booked",
  "paid_pending_booking",
  "manual_followup",
  "booking_failed",
];
const RESERVED_SERVICE_CONFIRMATION_SEGMENTS = new Set([
  "booking",
  "confirmation",
  "schedule",
]);
const SAFE_SERVICE_CONFIRMATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function getVerifiedBookingConfirmation(
  input: GetVerifiedBookingConfirmationInput,
): Promise<VerifiedBookingConfirmation | null> {
  const found = await getConfirmableBookingAppointment(input);

  if (found === null) {
    return null;
  }

  return toVerifiedBookingConfirmation(found.orderId, found.status);
}

export async function getVerifiedServiceBookingConfirmation(
  input: GetVerifiedServiceBookingConfirmationInput,
): Promise<VerifiedBookingConfirmation | null> {
  const serviceSlug = input.serviceSlug?.trim();

  if (!isSafeServiceConfirmationSlug(serviceSlug)) {
    return null;
  }

  const found = await getConfirmableBookingAppointment(input);

  if (found === null || getOfferingSnapshotSlug(found.appointment) !== serviceSlug) {
    return null;
  }

  return toVerifiedBookingConfirmation(found.orderId, found.status);
}

export async function getServiceBookingConfirmationRedirect(
  input: GetVerifiedBookingConfirmationInput,
): Promise<string | null> {
  const found = await getConfirmableBookingAppointment(input);

  if (found === null) {
    return null;
  }

  const serviceSlug = getOfferingSnapshotSlug(found.appointment);

  if (!isSafeServiceConfirmationSlug(serviceSlug)) {
    return null;
  }

  return buildServiceBookingConfirmationUrl({
    orderId: found.orderId,
    serviceSlug,
  });
}

export function isSafeServiceConfirmationSlug(
  slug: string | null | undefined,
): slug is string {
  if (slug === undefined || slug === null) {
    return false;
  }

  return SAFE_SERVICE_CONFIRMATION_SLUG_PATTERN.test(slug) &&
    !RESERVED_SERVICE_CONFIRMATION_SEGMENTS.has(slug);
}

async function getConfirmableBookingAppointment(
  input: GetVerifiedBookingConfirmationInput,
): Promise<{ appointment: BookingHoldRecord; orderId: string; status: VerifiedBookingConfirmationStatus } | null> {
  const orderId = input.orderId?.trim();

  if (orderId === undefined || orderId.length === 0) {
    return null;
  }

  const findAppointmentByPublicOrderId =
    input.findAppointmentByPublicOrderId ?? defaultFindAppointmentByPublicOrderId;
  const appointment = await findAppointmentByPublicOrderId({ publicOrderId: orderId });

  if (appointment === null) {
    return null;
  }

  const status = appointment.state;

  if (!isConfirmableBookingStatus(status)) {
    return null;
  }

  return { appointment, orderId, status };
}

function toVerifiedBookingConfirmation(
  orderId: string,
  status: VerifiedBookingConfirmationStatus,
): VerifiedBookingConfirmation {
  return {
    orderId,
    status,
  };
}

function getOfferingSnapshotSlug(appointment: BookingHoldRecord): string | null {
  const slug = appointment.offeringSnapshot.slug;

  return typeof slug === "string" ? slug : null;
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
