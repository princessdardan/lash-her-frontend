import type { ValidatedCart } from "@/lib/commerce/cart";
import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";

import type { BookingHoldRecord } from "./holds";

export const PAYMENT_SUCCESS_GRACE_MINUTES = 5;

export interface BookingPaymentSelection {
  amount: number;
  description: string;
  purpose: Extract<CheckoutOrderPurpose, "appointment_deposit" | "appointment_full" | "appointment_custom_partial">;
  sku: "BOOKING-DEPOSIT" | "BOOKING-FULL" | "BOOKING-CUSTOM-PARTIAL";
}

export interface BookingSelectedAddOnSnapshot {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: "CAD";
}

interface BookingOfferingPaymentSnapshot {
  currency: "CAD";
  selectedAddOn: BookingSelectedAddOnSnapshot | null;
  selectedPayment: BookingPaymentSelection;
  title: string;
}

export function getBookingPaymentSelection(hold: BookingHoldRecord): BookingPaymentSelection | null {
  return toBookingOfferingPaymentSnapshot(hold.offeringSnapshot)?.selectedPayment ?? null;
}

export function getBookingPaymentOfferingTitle(hold: BookingHoldRecord): string {
  return toBookingOfferingPaymentSnapshot(hold.offeringSnapshot)?.title ?? hold.offeringId;
}

export function getBookingSelectedAddOn(hold: BookingHoldRecord): BookingSelectedAddOnSnapshot | null {
  return toBookingOfferingPaymentSnapshot(hold.offeringSnapshot)?.selectedAddOn ?? null;
}

export function buildBookingPaymentCart(
  hold: BookingHoldRecord,
  paymentSelection: BookingPaymentSelection,
): ValidatedCart {
  return {
    amount: paymentSelection.amount,
    currency: "CAD",
    lineItems: [
      {
        productId: `booking:${hold.id}`,
        sku: paymentSelection.sku,
        description: paymentSelection.description,
        quantity: 1,
        price: paymentSelection.amount,
        total: paymentSelection.amount,
      },
    ],
  };
}

export function toBookingPaymentAmountCents(paymentSelection: BookingPaymentSelection): number {
  return Math.round(paymentSelection.amount * 100);
}

function toBookingOfferingPaymentSnapshot(value: Record<string, unknown>): BookingOfferingPaymentSnapshot | null {
  const currency = value.currency;
  const selectedAddOn = toBookingSelectedAddOn(value.selectedAddOn);
  const selectedPayment = toBookingPaymentSelection(value.selectedPayment);
  const title = typeof value.title === "string" && value.title.trim().length > 0
    ? value.title.trim()
    : null;

  if (currency !== "CAD" || title === null || selectedPayment === null) {
    return null;
  }

  return {
    currency,
    selectedAddOn,
    selectedPayment,
    title,
  };
}

function toBookingPaymentSelection(value: unknown): BookingPaymentSelection | null {
  if (!isRecord(value)) {
    return null;
  }

  const amount = toPositiveAmount(value.amount);
  const description = typeof value.description === "string" && value.description.trim().length > 0
    ? value.description.trim()
    : null;

  if (amount === null || description === null) {
    return null;
  }

  if (
    value.purpose !== "appointment_deposit" &&
    value.purpose !== "appointment_full" &&
    value.purpose !== "appointment_custom_partial"
  ) {
    return null;
  }

  if (
    value.sku !== "BOOKING-DEPOSIT" &&
    value.sku !== "BOOKING-FULL" &&
    value.sku !== "BOOKING-CUSTOM-PARTIAL"
  ) {
    return null;
  }

  return {
    amount,
    description,
    purpose: value.purpose,
    sku: value.sku,
  };
}

function toBookingSelectedAddOn(value: unknown): BookingSelectedAddOnSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = typeof value.key === "string" && value.key.trim().length > 0 ? value.key.trim() : null;
  const name = typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : null;
  const description = typeof value.description === "string" && value.description.trim().length > 0 ? value.description.trim() : null;
  const price = toPositiveAmount(value.price);

  if (key === null || name === null || description === null || price === null || value.currency !== "CAD") {
    return null;
  }

  return { key, name, description, price, currency: "CAD" };
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
