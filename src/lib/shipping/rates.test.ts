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
        signature_confirmation_description: "Signature available",
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
    {
      atRiskValueCents: 2400,
      destinationCountryCode: "CA",
      servicePolicies: new Map([
        [
          "tracked:CA",
          {
            postageType: "tracked",
            destinationCountryCode: "CA",
            trackingRequired: true,
            insuranceLimitCents: 50000,
            signatureCapable: true,
            claimWaitingDays: 15,
            claimDeadlineDays: 90,
            reviewedAt: new Date(),
          },
        ],
      ]),
      signatureThresholdCents: 50000,
    },
  );
  assert.equal(rates.length, 1);
  assert.equal(rates[0].paymentAmountCents, 1234);
  assert.equal(rates[0].insuranceFeeCents, 200);
});

test("high-value rates require reviewed insurance and confirmed signature support", () => {
  const baseRate = {
    postage_type: "tracked",
    postage_description: "Tracked",
    tracking_type_description: "Full tracking included",
    delivery_time_description: "2-4 business days",
    is_insured: true,
    payment_amount: "12.34",
  };
  const policy = {
    postageType: "tracked",
    destinationCountryCode: "CA",
    trackingRequired: true,
    insuranceLimitCents: 75000,
    signatureCapable: true,
    claimWaitingDays: 15,
    claimDeadlineDays: 90,
    reviewedAt: new Date(),
  };
  const options = {
    atRiskValueCents: 50000,
    destinationCountryCode: "CA",
    servicePolicies: new Map([["tracked:CA", policy]]),
    signatureThresholdCents: 50000,
  };
  assert.equal(
    selectCustomerRates([baseRate], new Set(["tracked"]), options).length,
    0,
  );
  const accepted = selectCustomerRates(
    [
      {
        ...baseRate,
        signature_confirmation_description: "Signature available",
      },
    ],
    new Set(["tracked"]),
    options,
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].signatureRequired, true);
  assert.equal(accepted[0].deliveryMaxBusinessDays, 4);
});

test("rates fail closed when service policy is absent or insurance is insufficient", () => {
  const rate = {
    postage_type: "tracked",
    tracking_type_description: "Full tracking included",
    is_insured: true,
    payment_amount: "10",
  };
  const base = {
    atRiskValueCents: 20000,
    destinationCountryCode: "CA",
    signatureThresholdCents: 50000,
  };
  assert.equal(
    selectCustomerRates([rate], new Set(["tracked"]), {
      ...base,
      servicePolicies: new Map(),
    }).length,
    0,
  );
  assert.equal(
    selectCustomerRates([rate], new Set(["tracked"]), {
      ...base,
      servicePolicies: new Map([
        [
          "tracked:CA",
          {
            postageType: "tracked",
            destinationCountryCode: "CA",
            trackingRequired: true,
            insuranceLimitCents: 10000,
            signatureCapable: false,
            claimWaitingDays: 15,
            claimDeadlineDays: 90,
            reviewedAt: new Date(),
          },
        ],
      ]),
    }).length,
    0,
  );
});
