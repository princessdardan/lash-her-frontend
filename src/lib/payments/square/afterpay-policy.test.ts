import assert from "node:assert/strict";
import test from "node:test";
import {
  isSquareAfterpayAmountEligible,
  parseSquareCheckoutPayment,
  validateSquareAfterpayPayment,
} from "./afterpay-policy";

test("Canadian Afterpay limits apply to the final CAD amount with inclusive boundaries", () => {
  for (const amount of [100, 101, 199_999, 200_000])
    assert.equal(isSquareAfterpayAmountEligible(amount), true);
  for (const amount of [-1, 0, 99, 100.5, 200_001, 400_000, Infinity, NaN])
    assert.equal(isSquareAfterpayAmountEligible(amount), false);
  assert.equal(isSquareAfterpayAmountEligible(100, "USD"), false);
});

test("Afterpay requires the exact displayed total; card payments retain their existing contract", () => {
  assert.equal(
    validateSquareAfterpayPayment(
      { method: "afterpay", expectedAmountCents: 200_000 },
      200_000,
      "CAD",
    ),
    null,
  );
  assert.match(
    validateSquareAfterpayPayment(
      { method: "afterpay", expectedAmountCents: 199_999 },
      200_000,
      "CAD",
    )!,
    /total changed/,
  );
  assert.match(
    validateSquareAfterpayPayment(
      { method: "afterpay", expectedAmountCents: 200_001 },
      200_001,
      "CAD",
    )!,
    /C\$2,000/,
  );
  assert.equal(validateSquareAfterpayPayment({}, 400_000, "CAD"), null);
});

test("payment parser preserves legacy cards and rejects unsupported or malformed BNPL", () => {
  assert.deepEqual(parseSquareCheckoutPayment({ sourceId: " card " }), {
    sourceId: "card",
  });
  const afterpay = {
    sourceId: "afterpay-token",
    method: "afterpay",
    expectedAmountCents: 1000,
  };
  assert.deepEqual(parseSquareCheckoutPayment(afterpay), afterpay);
  for (const body of [
    null,
    {},
    { ...afterpay, method: "klarna" },
    { ...afterpay, expectedAmountCents: undefined },
    { ...afterpay, expectedAmountCents: "1000" },
    { ...afterpay, verificationToken: 42 },
  ]) {
    assert.equal(parseSquareCheckoutPayment(body), null);
  }
});
