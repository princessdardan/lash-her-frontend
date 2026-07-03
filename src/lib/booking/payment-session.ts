import {
  getAppointmentHoldByPaymentSessionReference,
  isActiveHold,
  type BookingHoldRecord,
  type BookingHoldState,
} from "./holds";
import { readServicePromotionSnapshot } from "./payments/service-promotion";

export interface PaymentSessionRepository {
  getByPaymentSessionReference(
    paymentSessionReference: string,
  ): Promise<BookingHoldRecord | null>;
}

export interface ServiceBookingPaymentSessionDisplay {
  currency: "CAD";
  expiresAt: string;
  paymentSessionReference: string;
  pricing: {
    addOnPriceCents: number;
    customAmountMaximumCents: number;
    customAmountMinimumCents: number;
    depositAmountCents: number;
    // When a service promotion is active, this is the discounted pretax base
    // price. If absent, fullPriceCents is used for backward compatibility.
    discountedBasePriceCents?: number;
    fullPriceCents: number;
    // Optional promotion metadata for display on the payment page.
    promotionCode?: string;
    promotionDiscountCents?: number;
  };
  selectedAddOn?: {
    description: string;
    key: string;
    name: string;
    priceCents: number;
  };
  selectedEnd: string;
  selectedStart: string;
  serviceSlug: string;
  serviceTitle: string;
  timezone: string;
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
      expiresAt: hold.expiresAt.toISOString(),
      paymentSessionReference: hold.paymentSessionReference,
      pricing: service.pricing,
      selectedAddOn: service.selectedAddOn,
      selectedEnd: hold.selectedEnd.toISOString(),
      selectedStart: hold.selectedStart.toISOString(),
      serviceSlug: service.serviceSlug,
      serviceTitle: service.serviceTitle,
      timezone: hold.timezone,
    },
  };
}

interface ServiceBookingPaymentSnapshot {
  serviceSlug: string;
  serviceTitle: string;
  pricing: ServiceBookingPaymentSessionDisplay["pricing"];
  selectedAddOn?: ServiceBookingPaymentSessionDisplay["selectedAddOn"];
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
  const pricing = readPricing(snapshot);

  if (serviceSlug === null || pricing === null) {
    return null;
  }

  const selectedAddOn = readSelectedAddOn(snapshot, pricing.addOnPriceCents);

  // A malformed add-on is always rejected; a positive add-on price requires a
  // matching, valid add-on.
  if (
    selectedAddOn === null ||
    (pricing.addOnPriceCents > 0 && selectedAddOn === undefined)
  ) {
    return null;
  }

  return {
    serviceSlug,
    serviceTitle,
    pricing,
    selectedAddOn,
  };
}

function readPricing(
  snapshot: Record<string, unknown>,
): ServiceBookingPaymentSessionDisplay["pricing"] | null {
  const pricing = isRecord(snapshot.pricing) ? snapshot.pricing : null;
  if (pricing === null || pricing.currency !== "CAD") {
    return null;
  }

  const depositAmount = toPositiveAmount(pricing.depositAmount);
  const fullPrice = toPositiveAmount(pricing.fullPrice);
  const customAmountMinimum = toPositiveAmount(pricing.customAmountMinimum);
  const customAmountMaximum = toPositiveAmount(pricing.customAmountMaximum);
  const addOnPrice = toNonNegativeAmount(pricing.addOnPrice);

  if (
    depositAmount === null ||
    fullPrice === null ||
    customAmountMinimum === null ||
    customAmountMaximum === null ||
    addOnPrice === null
  ) {
    return null;
  }

  const fullPriceCents = Math.round(fullPrice * 100);
  const promotionSnapshot = readServicePromotionSnapshot(
    snapshot,
    fullPriceCents,
  );
  const discountedBasePriceCents =
    promotionSnapshot?.discountedBasePriceCents ?? fullPriceCents;

  return {
    addOnPriceCents: Math.round(addOnPrice * 100),
    customAmountMaximumCents: Math.round(customAmountMaximum * 100),
    customAmountMinimumCents: Math.round(customAmountMinimum * 100),
    depositAmountCents: Math.round(depositAmount * 100),
    ...(discountedBasePriceCents !== fullPriceCents
      ? { discountedBasePriceCents }
      : {}),
    fullPriceCents,
    ...(promotionSnapshot !== null
      ? {
          promotionCode: promotionSnapshot.code,
          promotionDiscountCents: promotionSnapshot.discountCents,
        }
      : {}),
  };
}

function readSelectedAddOn(
  snapshot: Record<string, unknown>,
  expectedPriceCents: number,
): ServiceBookingPaymentSessionDisplay["selectedAddOn"] | null {
  const addOn = isRecord(snapshot.selectedAddOn)
    ? snapshot.selectedAddOn
    : null;
  if (addOn === null) return undefined;

  const price = toPositiveAmount(addOn.price);
  const priceCents = price === null ? null : Math.round(price * 100);
  const key = typeof addOn.key === "string" ? addOn.key.trim() : "";
  const name = typeof addOn.name === "string" ? addOn.name.trim() : "";
  const description =
    typeof addOn.description === "string" ? addOn.description.trim() : "";

  if (
    key.length === 0 ||
    name.length === 0 ||
    description.length === 0 ||
    priceCents !== expectedPriceCents ||
    addOn.currency !== "CAD"
  ) {
    return null;
  }

  return {
    description,
    key,
    name,
    priceCents,
  };
}

function toPositiveAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function toNonNegativeAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
