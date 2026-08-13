import assert from "node:assert/strict";
import test from "node:test";
import { selectCustomerRates } from "./rates";

test("rate selection includes only allowlisted fully tracked insured rates", () => {
  const rates = selectCustomerRates(
    [
      {
        postage_type: "tracked",
        postage_description: "Tracked",
        tracking_type_description: "Full tracking included",
        is_insured: true,
        payment_amount: "12.34",
        insurance_fee: "2.00",
      },
      {
        postage_type: "uninsured",
        tracking_type_description: "Full tracking included",
        is_insured: false,
        payment_amount: "5",
      },
      {
        postage_type: "partial",
        tracking_type_description: "Delivery confirmation",
        is_insured: true,
        payment_amount: "6",
      },
    ],
    new Set(["tracked", "uninsured", "partial"]),
  );
  assert.equal(rates.length, 1);
  assert.equal(rates[0].paymentAmountCents, 1234);
  assert.equal(rates[0].insuranceFeeCents, 200);
});
