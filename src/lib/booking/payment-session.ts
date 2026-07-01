import {
  getAppointmentHoldByPaymentSessionReference,
  isActiveHold,
  type BookingHoldRecord,
  type BookingHoldState,
} from "./holds";

export interface PaymentSessionRepository {
  getByPaymentSessionReference(
    paymentSessionReference: string,
  ): Promise<BookingHoldRecord | null>;
}

export interface ServiceBookingPaymentSessionDisplay {
  currency: "CAD";
  customerName: string;
  expiresAt: string;
  paymentSessionReference: string;
  selectedEnd: string;
  selectedStart: string;
  serviceSlug: string;
  serviceTitle: string;
  timezone: string;
  totalCents: number;
}

export type ServiceBookingPaymentSessionResult =
  | { status: "active"; session: ServiceBookingPaymentSessionDisplay }
  | { status: "expired"; serviceSlug: string }
  | { status: "confirmed"; paymentStatus: "booked" | "manual_followup" }
  | { status: "not_found" };

export interface ResolveServiceBookingPaymentSessionInput {
  now: Date;
  paymentSessionReference: string;
  serviceSlug: string;
}

const MANUAL_FOLLOWUP_STATES: readonly BookingHoldState[] = [
  "manual_followup",
  "paid_pending_booking",
  "paid_unbookable_rebooking_pending",
  "booking_failed",
  "manual_rebooked",
  "refund_required",
  "refunded",
];

export async function resolveServiceBookingPaymentSession(
  input: ResolveServiceBookingPaymentSessionInput,
  repository?: PaymentSessionRepository,
): Promise<ServiceBookingPaymentSessionResult> {
  const hold =
    repository !== undefined
      ? await repository.getByPaymentSessionReference(
          input.paymentSessionReference,
        )
      : await getAppointmentHoldByPaymentSessionReference(
          input.paymentSessionReference,
        );

  if (hold === null) {
    return { status: "not_found" };
  }

  const service = readServiceSnapshot(hold);

  if (service === null || service.serviceSlug !== input.serviceSlug) {
    return { status: "not_found" };
  }

  if (hold.state === "booked") {
    return { status: "confirmed", paymentStatus: "booked" };
  }

  if (MANUAL_FOLLOWUP_STATES.includes(hold.state)) {
    return { status: "confirmed", paymentStatus: "manual_followup" };
  }

  if (!isActiveHold(hold, input.now)) {
    return { status: "expired", serviceSlug: service.serviceSlug };
  }

  return {
    status: "active",
    session: {
      currency: "CAD",
      customerName: hold.customer.name,
      expiresAt: hold.expiresAt.toISOString(),
      paymentSessionReference: hold.paymentSessionReference,
      selectedEnd: hold.selectedEnd.toISOString(),
      selectedStart: hold.selectedStart.toISOString(),
      serviceSlug: service.serviceSlug,
      serviceTitle: service.serviceTitle,
      timezone: hold.timezone,
      totalCents: service.totalCents,
    },
  };
}

interface ServiceBookingPaymentSnapshot {
  serviceSlug: string;
  serviceTitle: string;
  totalCents: number;
}

function readServiceSnapshot(
  hold: BookingHoldRecord,
): ServiceBookingPaymentSnapshot | null {
  const snapshot = hold.offeringSnapshot;
  const serviceSlug =
    typeof snapshot.serviceSlug === "string" &&
    snapshot.serviceSlug.trim().length > 0
      ? snapshot.serviceSlug.trim()
      : null;
  const serviceTitle =
    typeof snapshot.title === "string" && snapshot.title.trim().length > 0
      ? snapshot.title.trim()
      : "Service";
  const payment = isRecord(snapshot.payment) ? snapshot.payment : null;
  const paymentAmount =
    payment !== null && payment.currency === "CAD"
      ? toPositiveAmount(payment.amount)
      : null;

  if (serviceSlug === null || paymentAmount === null) {
    return null;
  }

  return {
    serviceSlug,
    serviceTitle,
    totalCents: Math.round(paymentAmount * 100),
  };
}

function toPositiveAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
