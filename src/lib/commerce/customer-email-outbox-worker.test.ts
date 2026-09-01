import assert from "node:assert/strict";
import test from "node:test";

import { parseContactPopupOfferEmailPayload } from "./customer-email-outbox-worker";

const validPayload = {
  submissionId: "00000000-0000-4000-8000-000000000001",
  recipientEmail: " Customer@Example.com ",
  customerName: " Customer ",
  variant: "fullContact",
  promotionId: "promotion-1",
  promotionRevision: "revision-1",
  promotionCode: "WELCOME20",
  discountType: "percentage",
  discountAmount: 20,
  appliesTo: "all",
  offerLabel: "Welcome offer",
  offerTerms: "Valid on eligible purchases.",
  ctaLabel: "Shop now",
  ctaUrl: "https://lashher.com/products",
  resolvedAt: "2026-08-31T12:00:00.000Z",
} as const;

test("contact popup offer payload parser normalizes a complete payload", () => {
  assert.deepEqual(parseContactPopupOfferEmailPayload(validPayload), {
    ...validPayload,
    customerName: "Customer",
    recipientEmail: "customer@example.com",
  });
});

test("contact popup offer payload parser rejects unsafe or ineligible data", () => {
  for (const payload of [
    { ...validPayload, appliesTo: "products" },
    { ...validPayload, ctaUrl: "http://lashher.com/products" },
    { ...validPayload, discountAmount: 101 },
    { ...validPayload, recipientEmail: "not-an-email" },
    { ...validPayload, resolvedAt: "not-a-date" },
    { ...validPayload, submissionId: "not-a-uuid" },
  ]) {
    assert.throws(
      () => parseContactPopupOfferEmailPayload(payload),
      /Malformed contact popup offer outbox payload/,
    );
  }
});
