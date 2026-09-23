import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTrainingSplitPayment,
  validateTrainingSplitPayment,
} from "./training-split-policy";
const payment = {
  method: "afterpay_card",
  expectedAmountCents: 395500,
  afterpayAmountCents: 200000,
  afterpay: { method: "afterpay", sourceId: "ap", expectedAmountCents: 200000 },
  card: { sourceId: "card" },
};

test("split limits apply to the Afterpay portion and exact full quote", () => {
  assert.ok(parseTrainingSplitPayment(payment));
  assert.equal(validateTrainingSplitPayment(payment, 395500), null);
  for (const afterpayAmountCents of [99, 200001, NaN, 100.5])
    assert.equal(
      parseTrainingSplitPayment({ ...payment, afterpayAmountCents }),
      null,
    );
  assert.ok(
    validateTrainingSplitPayment(
      { ...payment, expectedAmountCents: 200000 },
      200000,
    ),
  );
  assert.ok(validateTrainingSplitPayment(payment, 395501));
});
test("split requires independent valid sources and Afterpay sheet agreement", () => {
  for (const change of [
    {
      card: {
        method: "afterpay",
        sourceId: "card",
        expectedAmountCents: 195500,
      },
    },
    { card: { sourceId: "ap" } },
    { afterpay: { ...payment.afterpay, expectedAmountCents: 199999 } },
    { card: null },
  ])
    assert.equal(parseTrainingSplitPayment({ ...payment, ...change }), null);
});
