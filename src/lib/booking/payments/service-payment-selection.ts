import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";

export type ServicePaymentOption = "deposit" | "full" | "customPartial";

export interface ServicePaymentPricingSnapshot {
  addOnPriceCents: number;
  currency: "CAD";
  customAmountMaximumCents: number;
  customAmountMinimumCents: number;
  depositAmountCents: number;
  fullPriceCents: number;
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

  if (selection.option === "deposit") {
    return {
      ok: true,
      payment: {
        amountCents: pricing.depositAmountCents,
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
    const amountCents = pricing.fullPriceCents + pricing.addOnPriceCents;
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
  // Enforce against the real deposit and full price from the snapshot, not the
  // configurable min/max bounds, so a misconfigured snapshot cannot widen the
  // acceptable custom range.
  if (customAmountCents <= pricing.depositAmountCents) {
    return {
      ok: false,
      error: "Custom amount must be greater than the deposit.",
    };
  }
  if (customAmountCents >= pricing.fullPriceCents) {
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
