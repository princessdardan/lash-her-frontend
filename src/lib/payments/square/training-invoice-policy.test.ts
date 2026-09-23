import assert from "node:assert/strict";
import test from "node:test";
import { isSquareAfterpayAmountEligible } from "./afterpay-policy";
import { isTrainingInvoiceAfterpayAmountEligible } from "./training-invoice-policy";

test("training invoices allow C$1–C$2,000 inclusive without raising embedded Afterpay limits", () => {
  for (const amount of [100, 199_999, 200_000]) {
    assert.equal(isTrainingInvoiceAfterpayAmountEligible(amount), true);
    if (amount > 200_000)
      assert.equal(isSquareAfterpayAmountEligible(amount), false);
  }
  for (const amount of [
    -1,
    0,
    99,
    100.5,
    200_001,
    282_500,
    395_500,
    Infinity,
    NaN,
  ]) {
    assert.equal(isTrainingInvoiceAfterpayAmountEligible(amount), false);
  }
  assert.equal(isTrainingInvoiceAfterpayAmountEligible(250_000, "USD"), false);
});
