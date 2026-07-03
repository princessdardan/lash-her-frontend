import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveServicePaymentSelection,
  type ServicePaymentPricingSnapshot,
} from "./service-payment-selection";

const pricing: ServicePaymentPricingSnapshot = {
  addOnPriceCents: 2500,
  currency: "CAD",
  customAmountMaximumCents: 13000,
  customAmountMinimumCents: 5000,
  depositAmountCents: 5000,
  fullPriceCents: 13000,
  serviceTitle: "Classic Fill",
  selectedAddOnName: "Removal",
};

test("resolves deposit amount without add-on charge", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "deposit" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 5000,
        currency: "CAD",
        description: "Classic Fill deposit; Removal add-on balance due later",
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
    },
  );
});

test("resolves full amount including add-on", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({ pricing, selection: { option: "full" } }),
    {
      ok: true,
      payment: {
        amountCents: 15500,
        currency: "CAD",
        description: "Classic Fill full payment with Removal",
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    },
  );
});

test("resolves custom partial between deposit and full service price", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "customPartial", customAmountCents: 9000 },
    }),
    {
      ok: true,
      payment: {
        amountCents: 9000,
        currency: "CAD",
        description:
          "Classic Fill custom partial payment; Removal add-on balance due later",
        option: "customPartial",
        purpose: "appointment_custom_partial",
        sku: "BOOKING-CUSTOM-PARTIAL",
      },
    },
  );
});

test("rejects custom partial at or below deposit", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "customPartial", customAmountCents: 5000 },
    }),
    { ok: false, error: "Custom amount must be greater than the deposit." },
  );
});

test("rejects custom partial at or above full service price", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "customPartial", customAmountCents: 13000 },
    }),
    {
      ok: false,
      error: "Custom amount must be less than the full service price.",
    },
  );
});

test("rejects custom partial equal to deposit when snapshot minimum is misconfigured lower", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    customAmountMinimumCents: 4000,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "customPartial", customAmountCents: 5000 },
    }),
    { ok: false, error: "Custom amount must be greater than the deposit." },
  );
});

test("rejects custom partial equal to full price when snapshot maximum is misconfigured higher", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    customAmountMaximumCents: 15000,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "customPartial", customAmountCents: 13000 },
    }),
    {
      ok: false,
      error: "Custom amount must be less than the full service price.",
    },
  );
});

test("rejects fractional custom amount", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "customPartial", customAmountCents: 9000.5 },
    }),
    { ok: false, error: "Custom amount is required." },
  );
});

test("rejects misconfigured deposit amount", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    depositAmountCents: 0,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "deposit" },
    }),
    { ok: false, error: "Booking pricing is not configured." },
  );
});

test("rejects misconfigured full price", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    fullPriceCents: -100,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "full" },
    }),
    { ok: false, error: "Booking pricing is not configured." },
  );
});

test("rejects misconfigured add-on price", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    addOnPriceCents: -100,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "full" },
    }),
    { ok: false, error: "Booking pricing is not configured." },
  );
});

test("rejects misconfigured custom amount minimum", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    customAmountMinimumCents: 0,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "customPartial", customAmountCents: 9000 },
    }),
    { ok: false, error: "Booking pricing is not configured." },
  );
});

test("rejects misconfigured custom amount maximum", () => {
  const misconfigured: ServicePaymentPricingSnapshot = {
    ...pricing,
    customAmountMaximumCents: NaN,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: misconfigured,
      selection: { option: "customPartial", customAmountCents: 9000 },
    }),
    { ok: false, error: "Booking pricing is not configured." },
  );
});

test("allows zero add-on price for full payment", () => {
  const noAddOn: ServicePaymentPricingSnapshot = {
    ...pricing,
    addOnPriceCents: 0,
    selectedAddOnName: undefined,
  };
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: noAddOn,
      selection: { option: "full" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 13000,
        currency: "CAD",
        description: "Classic Fill full payment",
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    },
  );
});

test("full payment uses discounted base and still charges add-on", () => {
  const discounted: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 10000,
    promotionCode: "SAVE30",
    promotionDiscountCents: 3000,
  };

  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: discounted,
      selection: { option: "full" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 12500,
        currency: "CAD",
        description: "Classic Fill full payment with Removal",
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    },
  );
});

test("deposit is capped at discounted base price", () => {
  const discounted: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 4000,
    promotionCode: "SAVE90",
    promotionDiscountCents: 9000,
  };

  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: discounted,
      selection: { option: "deposit" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 4000,
        currency: "CAD",
        description: "Classic Fill deposit; Removal add-on balance due later",
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
    },
  );
});

test("custom partial uses discounted base as upper bound", () => {
  const discounted: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 10000,
    promotionCode: "SAVE30",
    promotionDiscountCents: 3000,
  };

  // Below the discounted base should still work.
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: discounted,
      selection: { option: "customPartial", customAmountCents: 9000 },
    }),
    {
      ok: true,
      payment: {
        amountCents: 9000,
        currency: "CAD",
        description:
          "Classic Fill custom partial payment; Removal add-on balance due later",
        option: "customPartial",
        purpose: "appointment_custom_partial",
        sku: "BOOKING-CUSTOM-PARTIAL",
      },
    },
  );

  // At the discounted base is rejected, same as at full price without discount.
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: discounted,
      selection: { option: "customPartial", customAmountCents: 10000 },
    }),
    {
      ok: false,
      error: "Custom amount must be less than the full service price.",
    },
  );
});

test("malicious discounted base above full price is clamped to full price", () => {
  const tampered: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 20000,
  };

  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: tampered,
      selection: { option: "full" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 15500,
        currency: "CAD",
        description: "Classic Fill full payment with Removal",
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    },
  );
});

test("zero discounted base is accepted and full payment still charges add-ons", () => {
  const zeroBase: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 0,
    promotionCode: "FREE",
    promotionDiscountCents: 13000,
  };

  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: zeroBase,
      selection: { option: "full" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 2500,
        currency: "CAD",
        description: "Classic Fill full payment with Removal",
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    },
  );
});

test("deposit becomes zero when the service base is fully discounted", () => {
  const zeroBase: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 0,
    promotionCode: "FREE",
    promotionDiscountCents: 13000,
  };

  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: zeroBase,
      selection: { option: "deposit" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 0,
        currency: "CAD",
        description: "Classic Fill deposit; Removal add-on balance due later",
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
    },
  );
});

test("custom partial is invalid when the discounted base is zero", () => {
  const zeroBase: ServicePaymentPricingSnapshot = {
    ...pricing,
    discountedBasePriceCents: 0,
    promotionCode: "FREE",
    promotionDiscountCents: 13000,
  };

  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing: zeroBase,
      selection: { option: "customPartial", customAmountCents: 1000 },
    }),
    {
      ok: false,
      error:
        "Custom partial payment is not available when the service is fully discounted.",
    },
  );
});
