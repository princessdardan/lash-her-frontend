import assert from "node:assert/strict";
import test from "node:test";

import type { PromotionCode } from "@/lib/commerce/discounts";

import {
  calculateServicePromotionSnapshot,
  readServicePromotionSnapshot,
} from "./service-promotion";

function createPromotionCode(
  overrides: Partial<PromotionCode> = {},
): PromotionCode {
  return {
    _id: "promo-1",
    code: "SAVE10",
    isEnabled: true,
    discountType: "percentage",
    amount: 10,
    appliesTo: "services",
    ...overrides,
  };
}

test("calculates percentage service discount", () => {
  const snapshot = calculateServicePromotionSnapshot({
    promotionCode: createPromotionCode({ amount: 20 }),
    serviceId: "service-1",
    basePriceCents: 13000,
  });

  assert.deepEqual(snapshot, {
    code: "SAVE10",
    discountType: "percentage",
    discountAmount: 20,
    discountCents: 2600,
    originalBasePriceCents: 13000,
    discountedBasePriceCents: 10400,
  });
});

test("calculates fixed service discount", () => {
  const snapshot = calculateServicePromotionSnapshot({
    promotionCode: createPromotionCode({
      discountType: "fixed",
      amount: 25,
    }),
    serviceId: "service-1",
    basePriceCents: 13000,
  });

  assert.deepEqual(snapshot, {
    code: "SAVE10",
    discountType: "fixed",
    discountAmount: 25,
    discountCents: 2500,
    originalBasePriceCents: 13000,
    discountedBasePriceCents: 10500,
  });
});

test("returns null when promotion does not apply to service", () => {
  const snapshot = calculateServicePromotionSnapshot({
    promotionCode: createPromotionCode({
      appliesTo: "specificItems",
      services: [{ _id: "service-2" }],
    }),
    serviceId: "service-1",
    basePriceCents: 13000,
  });

  assert.equal(snapshot, null);
});

test("allows 100% discount to reduce the base to zero", () => {
  const snapshot = calculateServicePromotionSnapshot({
    promotionCode: createPromotionCode({ amount: 100 }),
    serviceId: "service-1",
    basePriceCents: 13000,
  });

  assert.equal(snapshot?.discountCents, 13000);
  assert.equal(snapshot?.discountedBasePriceCents, 0);
});

test("clamps over-base fixed discount to reduce the base to zero", () => {
  const snapshot = calculateServicePromotionSnapshot({
    promotionCode: createPromotionCode({
      discountType: "fixed",
      amount: 200,
    }),
    serviceId: "service-1",
    basePriceCents: 13000,
  });

  assert.equal(snapshot?.discountCents, 13000);
  assert.equal(snapshot?.discountedBasePriceCents, 0);
});

test("returns null for disabled promotion code", () => {
  const snapshot = calculateServicePromotionSnapshot({
    promotionCode: createPromotionCode({ isEnabled: false }),
    serviceId: "service-1",
    basePriceCents: 13000,
  });

  assert.equal(snapshot, null);
});

test("readServicePromotionSnapshot parses valid snapshot", () => {
  const snapshot = readServicePromotionSnapshot({
    promotionSnapshot: {
      code: "SAVE30",
      discountType: "percentage",
      discountAmount: 30,
      discountCents: 3900,
      originalBasePriceCents: 13000,
      discountedBasePriceCents: 9100,
    },
  });

  assert.deepEqual(snapshot, {
    code: "SAVE30",
    discountType: "percentage",
    discountAmount: 30,
    discountCents: 3900,
    originalBasePriceCents: 13000,
    discountedBasePriceCents: 9100,
  });
});

test("readServicePromotionSnapshot accepts snapshot with zero discounted base", () => {
  const snapshot = readServicePromotionSnapshot({
    promotionSnapshot: {
      code: "FREE",
      discountType: "percentage",
      discountAmount: 100,
      discountCents: 13000,
      originalBasePriceCents: 13000,
      discountedBasePriceCents: 0,
    },
  });

  assert.deepEqual(snapshot, {
    code: "FREE",
    discountType: "percentage",
    discountAmount: 100,
    discountCents: 13000,
    originalBasePriceCents: 13000,
    discountedBasePriceCents: 0,
  });
});

test("readServicePromotionSnapshot returns null when promotionSnapshot is missing", () => {
  const snapshot = readServicePromotionSnapshot({});

  assert.equal(snapshot, null);
});

test("readServicePromotionSnapshot rejects tampered discounted base above original", () => {
  const snapshot = readServicePromotionSnapshot({
    promotionSnapshot: {
      code: "SAVE30",
      discountType: "percentage",
      discountAmount: 30,
      discountCents: 3900,
      originalBasePriceCents: 13000,
      discountedBasePriceCents: 15000,
    },
  });

  assert.equal(snapshot, null);
});

test("readServicePromotionSnapshot rejects snapshots derived from a different base price", () => {
  const snapshot = readServicePromotionSnapshot(
    {
      promotionSnapshot: {
        code: "SAVE10",
        discountType: "percentage",
        discountAmount: 10,
        discountCents: 1000,
        originalBasePriceCents: 10000,
        discountedBasePriceCents: 9000,
      },
    },
    12000,
  );

  assert.equal(snapshot, null);
});

test("readServicePromotionSnapshot rejects internally inconsistent discount amounts", () => {
  const snapshot = readServicePromotionSnapshot({
    promotionSnapshot: {
      code: "SAVE10",
      discountType: "percentage",
      discountAmount: 10,
      discountCents: 500,
      originalBasePriceCents: 10000,
      discountedBasePriceCents: 9000,
    },
  });

  assert.equal(snapshot, null);
});
