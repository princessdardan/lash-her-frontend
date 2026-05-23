import assert from "node:assert/strict";
import test from "node:test";

import {
  isPaymentMockScenario,
  paymentMockScenarios,
  parsePaymentMockScenario,
  type PaymentMockScenario,
} from "./scenarios";

test("shared payment mock scenarios include the exact supported union", () => {
  const expected = [
    "success",
    "decline",
    "cancel",
    "refund",
    "refund_failed",
    "webhook",
    "duplicate_webhook",
    "temporary_error",
    "delayed_capture",
    "idempotency_mismatch",
    "idempotency_expired",
  ] as const satisfies readonly PaymentMockScenario[];

  assert.deepEqual(paymentMockScenarios, expected);
});

test("scenario parsing only accepts supported values", () => {
  for (const scenario of paymentMockScenarios) {
    assert.equal(isPaymentMockScenario(scenario), true);
    assert.equal(parsePaymentMockScenario(scenario), scenario);
  }

  assert.equal(isPaymentMockScenario("unsupported"), false);
  assert.equal(parsePaymentMockScenario("unsupported"), null);
  assert.equal(parsePaymentMockScenario(undefined), null);
  assert.equal(parsePaymentMockScenario(null), null);
});
