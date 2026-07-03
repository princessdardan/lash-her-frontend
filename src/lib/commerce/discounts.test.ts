import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPromotionCode,
  isPromotionApplicable,
  type PromotionCode,
} from "./discounts";

function createPromotionCode(
  overrides: Partial<PromotionCode> = {},
): PromotionCode {
  return {
    _id: "promo-1",
    code: "SAVE10",
    isEnabled: true,
    discountType: "percentage",
    amount: 10,
    appliesTo: "all",
    ...overrides,
  };
}

test("legacy 'all' applies to products", () => {
  assert.equal(
    isPromotionApplicable(createPromotionCode(), "product", ["product-1"]),
    true,
  );
});

test("legacy 'all' applies to training programs", () => {
  assert.equal(
    isPromotionApplicable(createPromotionCode(), "trainingProgram", [
      "training-1",
    ]),
    true,
  );
});

test("legacy 'all' does not apply to services", () => {
  // Existing codes with appliesTo: 'all' must not accidentally discount
  // service bookings.
  assert.equal(
    isPromotionApplicable(createPromotionCode(), "service", ["service-1"]),
    false,
  );
});

test("'services' applies to service targets", () => {
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({ appliesTo: "services" }),
      "service",
      ["service-1"],
    ),
    true,
  );
});

test("'services' does not apply to products", () => {
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({ appliesTo: "services" }),
      "product",
      ["product-1"],
    ),
    false,
  );
});

test("'products' still applies only to products", () => {
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({ appliesTo: "products" }),
      "product",
      ["product-1"],
    ),
    true,
  );
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({ appliesTo: "products" }),
      "service",
      ["service-1"],
    ),
    false,
  );
});

test("'trainingPrograms' still applies only to training programs", () => {
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({ appliesTo: "trainingPrograms" }),
      "trainingProgram",
      ["training-1"],
    ),
    true,
  );
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({ appliesTo: "trainingPrograms" }),
      "service",
      ["service-1"],
    ),
    false,
  );
});

test("'specificItems' applies to a specific service", () => {
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({
        appliesTo: "specificItems",
        services: [{ _id: "service-1" }],
      }),
      "service",
      ["service-1"],
    ),
    true,
  );
});

test("'specificItems' does not apply to a non-matching service", () => {
  assert.equal(
    isPromotionApplicable(
      createPromotionCode({
        appliesTo: "specificItems",
        services: [{ _id: "service-1" }],
      }),
      "service",
      ["service-2"],
    ),
    false,
  );
});

test("applyPromotionCode returns service discount for services appliesTo", () => {
  const result = applyPromotionCode({
    promotionCode: createPromotionCode({
      appliesTo: "services",
      discountType: "fixed",
      amount: 25,
    }),
    targetType: "service",
    targetIds: ["service-1"],
    amount: 130,
  });

  assert.deepEqual(result, { code: "SAVE10", amount: 25 });
});

test("applyPromotionCode clamps percentage discount to amount", () => {
  const result = applyPromotionCode({
    promotionCode: createPromotionCode({
      amount: 100,
      appliesTo: "services",
    }),
    targetType: "service",
    targetIds: ["service-1"],
    amount: 130,
  });

  assert.deepEqual(result, { code: "SAVE10", amount: 130 });
});

test("applyPromotionCode returns null for disabled code", () => {
  const result = applyPromotionCode({
    promotionCode: createPromotionCode({ isEnabled: false }),
    targetType: "product",
    targetIds: ["product-1"],
    amount: 100,
  });

  assert.equal(result, null);
});

test("applyPromotionCode returns null when service code used on product", () => {
  const result = applyPromotionCode({
    promotionCode: createPromotionCode({ appliesTo: "services" }),
    targetType: "product",
    targetIds: ["product-1"],
    amount: 100,
  });

  assert.equal(result, null);
});

test("applyPromotionCode returns null when legacy all code used on service", () => {
  const result = applyPromotionCode({
    promotionCode: createPromotionCode({ appliesTo: "all" }),
    targetType: "service",
    targetIds: ["service-1"],
    amount: 100,
  });

  assert.equal(result, null);
});

test("applyPromotionCode preserves product behavior for legacy all code", () => {
  const result = applyPromotionCode({
    promotionCode: createPromotionCode({ appliesTo: "all", amount: 20 }),
    targetType: "product",
    targetIds: ["product-1"],
    amount: 100,
  });

  assert.deepEqual(result, { code: "SAVE10", amount: 20 });
});
