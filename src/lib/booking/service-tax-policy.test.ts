import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateServiceBookingHstQuote,
  SERVICE_BOOKING_HST_POLICY_VERSION,
  SERVICE_BOOKING_HST_RATE,
} from "./service-tax-policy";

test("service booking HST policy taxes amount paid today at 13%", () => {
  const quote = calculateServiceBookingHstQuote(5000);

  assert.deepEqual(quote, {
    expectedAmountCents: 5650,
    policyVersion: SERVICE_BOOKING_HST_POLICY_VERSION,
    taxAmountCents: 650,
    taxableAmountCents: 5000,
    taxName: "Ontario HST",
    taxRate: SERVICE_BOOKING_HST_RATE,
  });
});

test("service booking HST policy rounds to the nearest cent", () => {
  const quote = calculateServiceBookingHstQuote(999);

  assert.equal(quote.taxAmountCents, 130);
  assert.equal(quote.expectedAmountCents, 1129);
});

test("service booking HST policy rejects non-positive and unsafe cents", () => {
  assert.throws(() => calculateServiceBookingHstQuote(0), /positive integer cents/);
  assert.throws(() => calculateServiceBookingHstQuote(-1), /positive integer cents/);
  assert.throws(() => calculateServiceBookingHstQuote(10.5), /positive integer cents/);
  assert.throws(() => calculateServiceBookingHstQuote(Number.MAX_SAFE_INTEGER + 1), /safe integer cents/);
});
