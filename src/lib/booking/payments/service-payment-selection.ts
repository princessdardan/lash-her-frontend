import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";

export type ServicePaymentOption = "deposit" | "full" | "customPartial";

export interface ServicePaymentPricingSnapshot {
  addOnPriceCents: number;
  currency: "CAD";
  customAmountMaximumCents: number;
  customAmountMinimumCents: number;
  depositAmountCents: number;
  // When a service promotion is applied, this is the discounted pretax base
  // service price. If undefined, fullPriceCents is used for backward
  // compatibility with holds created before service discounts.
  discountedBasePriceCents?: number;
  fullPriceCents: number;
  // Optional promotion metadata so the payment form can display the applied
  // code and discount amount. These are authoritative only in the private hold
  // snapshot; the selection logic uses discountedBasePriceCents.
  promotionCode?: string;
  promotionDiscountCents?: number;
  selectedAddOnName?: string;
  serviceTitle: string;
}

export interface ServicePaymentSelectionInput {
  option: ServicePaymentOption;
  customAmountCents?: number;
}

export interface ResolvedServicePaymentSelection {
  amountCents: number;
  currency: "CAD";
  description: string;
  option: ServicePaymentOption;
  purpose: CheckoutOrderPurpose;
  sku: "BOOKING-DEPOSIT" | "BOOKING-FULL" | "BOOKING-CUSTOM-PARTIAL";
}

export function resolveServicePaymentSelection(input: {
  pricing: ServicePaymentPricingSnapshot;
  selection: ServicePaymentSelectionInput;
}):
  | { ok: true; payment: ResolvedServicePaymentSelection }
  | { ok: false; error: string } {
  const { pricing, selection } = input;

  // Reject untrustworthy snapshots immediately so every downstream path uses
  // validated integers only.
  if (
    !isPositiveInteger(pricing.depositAmountCents) ||
    !isPositiveInteger(pricing.fullPriceCents) ||
    !isPositiveInteger(pricing.customAmountMinimumCents) ||
    !isPositiveInteger(pricing.customAmountMaximumCents) ||
    !isNonNegativeInteger(pricing.addOnPriceCents)
  ) {
    return { ok: false, error: "Booking pricing is not configured." };
  }

  // The discounted base price is the authority for service-level discounts.
  // Add-ons are never discounted and are added on top of this base. Invalid
  // values (non-integers, negative, or above the original full price) are
  // ignored so a tampered or malformed snapshot cannot reduce the price. A
  // zero discounted base is valid for 100% (or over-base fixed) promotions.
  const rawDiscountedBase = pricing.discountedBasePriceCents;
  const discountedBasePriceCents =
    typeof rawDiscountedBase === "number" &&
    Number.isInteger(rawDiscountedBase) &&
    rawDiscountedBase >= 0 &&
    rawDiscountedBase <= pricing.fullPriceCents
      ? rawDiscountedBase
      : pricing.fullPriceCents;

  if (selection.option === "deposit") {
    // Deposit cannot exceed the discounted base price; this also prevents a
    // deposit larger than the amount owed for the service.
    const amountCents = Math.min(
      pricing.depositAmountCents,
      discountedBasePriceCents,
    );

    return {
      ok: true,
      payment: {
        amountCents,
        currency: "CAD",
        description: pricing.selectedAddOnName
          ? `${pricing.serviceTitle} deposit; ${pricing.selectedAddOnName} add-on balance due later`
          : `${pricing.serviceTitle} deposit`,
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
    };
  }

  if (selection.option === "full") {
    // addOnPriceCents was validated as a non-negative integer above.
    const amountCents = discountedBasePriceCents + pricing.addOnPriceCents;
    return {
      ok: true,
      payment: {
        amountCents,
        currency: "CAD",
        description: pricing.selectedAddOnName
          ? `${pricing.serviceTitle} full payment with ${pricing.selectedAddOnName}`
          : `${pricing.serviceTitle} full payment`,
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    };
  }

  const customAmountCents = selection.customAmountCents;
  if (!isPositiveInteger(customAmountCents)) {
    return { ok: false, error: "Custom amount is required." };
  }

  // There is no payable range when the service base has been discounted to
  // zero; a custom partial would either be zero or exceed the discounted base.
  if (discountedBasePriceCents === 0) {
    return {
      ok: false,
      error:
        "Custom partial payment is not available when the service is fully discounted.",
    };
  }

  // Enforce against the real deposit and discounted base price from the
  // snapshot, not the configurable min/max bounds, so a misconfigured snapshot
  // cannot widen the acceptable custom range.
  if (customAmountCents <= pricing.depositAmountCents) {
    return {
      ok: false,
      error: "Custom amount must be greater than the deposit.",
    };
  }
  if (customAmountCents >= discountedBasePriceCents) {
    return {
      ok: false,
      error: "Custom amount must be less than the full service price.",
    };
  }

  return {
    ok: true,
    payment: {
      amountCents: customAmountCents,
      currency: "CAD",
      description: pricing.selectedAddOnName
        ? `${pricing.serviceTitle} custom partial payment; ${pricing.selectedAddOnName} add-on balance due later`
        : `${pricing.serviceTitle} custom partial payment`,
      option: "customPartial",
      purpose: "appointment_custom_partial",
      sku: "BOOKING-CUSTOM-PARTIAL",
    },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
