import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPaymentObligationInvoicePlan,
  paymentInitializationProviderEvidenceIsValid,
  paymentObligationInitializationPayloadHash,
  paymentObligationInvoiceNumber,
  verifyHelcimInvoiceAbsence,
  verifyHelcimInvoiceForObligation,
} from "./product-payment-invoice-plan";

const obligation = {
  currency: "CAD",
  disclosureSnapshot: { helcimContract: { version: "certified-v1" } },
  id: "123e4567-e89b-12d3-a456-426614174000",
  merchandiseAmountCents: 10_000,
  policyVersion: "policy-v1",
  purpose: "primary" as const,
  shippingAmountCents: 2_345,
  taxAmountCents: 0,
  taxPolicyVersion: "tax-v1",
  totalAmountCents: 12_345,
};
const order = {
  lineItems: [
    {
      productId: "product-1",
      productName: "Lash kit",
      sku: "KIT-1",
      description: "Lash kit",
      quantity: 1,
      totalCents: 10_000,
      unitPriceCents: 10_000,
      weightGrams: 100,
      countryOfOrigin: "CA",
      manufacturerName: "Lash Her",
    },
  ],
  promotionCode: null,
  promotionDiscountCents: 0,
  shippingAmountCents: 2_345,
};

test("invoice plan uses a deterministic merchant invoice number and v2 payload identity", () => {
  const plan = buildPaymentObligationInvoicePlan(obligation, order);
  assert.equal(plan.invoiceNumber, "LH-123E4567E89B12D3A456426614174000");
  assert.equal(plan.request.invoiceNumber, plan.invoiceNumber);
  assert.equal(plan.totalAmountCents, 12_345);
  assert.match(
    paymentObligationInitializationPayloadHash(obligation),
    /^v2:[0-9a-f]{64}$/,
  );
  assert.equal(
    paymentObligationInvoiceNumber(obligation.id),
    plan.invoiceNumber,
  );
});

test("provider invoice evidence requires exact identity, amount, status, notes, and lines", () => {
  const plan = buildPaymentObligationInvoicePlan(obligation, order);
  const now = new Date("2026-08-15T12:00:00.000Z");
  const providerInvoice = {
    amount: 123.45,
    currency: "CAD",
    invoiceId: 4567,
    invoiceNumber: "INV-4567",
    lineItems: plan.lineItems,
    notes: plan.notes,
    status: "DUE",
    type: "INVOICE",
  };
  const evidence = verifyHelcimInvoiceForObligation({
    expectedInvoiceId: 4567,
    invoice: providerInvoice,
    observedAt: now,
    plan,
  });
  assert.equal(evidence.invoiceNumber, "INV-4567");
  assert.equal(
    paymentInitializationProviderEvidenceIsValid(evidence, now),
    true,
  );

  for (const changed of [
    { ...providerInvoice, amount: 123.44 },
    { ...providerInvoice, currency: "USD" },
    { ...providerInvoice, status: "PAID" },
    { ...providerInvoice, notes: "another order" },
    {
      ...providerInvoice,
      lineItems: [{ ...plan.lineItems[0], price: 99 }],
    },
  ]) {
    assert.throws(
      () =>
        verifyHelcimInvoiceForObligation({
          expectedInvoiceId: 4567,
          invoice: changed,
          observedAt: now,
          plan,
        }),
      /Helcim invoice/,
    );
  }
});

test("authoritative absence accepts only an exact empty provider result", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  const evidence = verifyHelcimInvoiceAbsence({
    collection: [],
    invoiceNumber: paymentObligationInvoiceNumber(obligation.id),
    observedAt: now,
  });
  assert.equal(evidence.resultCount, 0);
  assert.equal(
    paymentInitializationProviderEvidenceIsValid(evidence, now),
    true,
  );
  assert.throws(
    () =>
      verifyHelcimInvoiceAbsence({
        collection: [{ invoiceId: 4567, invoiceNumber: "INV-4567" }],
        invoiceNumber: paymentObligationInvoiceNumber(obligation.id),
        observedAt: now,
      }),
    /existing invoice/,
  );
  assert.throws(
    () =>
      verifyHelcimInvoiceAbsence({
        collection: {},
        invoiceNumber: paymentObligationInvoiceNumber(obligation.id),
        observedAt: now,
      }),
    /malformed/,
  );
});
