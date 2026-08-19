import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAddressRefreshVariance,
  calculateSettledAddressShippingRefund,
  buildAddressReplacementPublicReference,
  buildAddressApprovalEvidence,
  canonicalizeReplacementAddress,
  isSameCountryAddressChange,
} from "./address-changes";

test("dual high-risk approvals use action-scoped immutable evidence", () => {
  const common = {
    addressRequestId: "request-1",
    proposedAddressHash: "address-hash",
    paymentTransactions: [{ id: "payment-1", riskStatus: "cleared" }],
  };
  const reviewIncident = {
    providerEvidence: { avs: "M", cvv: "M" },
    reasonCodes: ["ADDRESS_LINE1_CHANGED"],
    status: "review_required" as const,
  };
  const addressProposal = buildAddressApprovalEvidence(
    "address_approval",
    common,
    reviewIncident,
  );
  const fraudProposal = buildAddressApprovalEvidence(
    "fraud_clearance",
    common,
    reviewIncident,
  );
  assert.deepEqual(
    buildAddressApprovalEvidence("address_approval", common, {
      ...reviewIncident,
      providerEvidence: fraudProposal,
      status: "cleared",
    }),
    addressProposal,
    "fraud-first execution cannot invalidate the separate address proposal",
  );
  assert.deepEqual(
    buildAddressApprovalEvidence("fraud_clearance", common, reviewIncident),
    fraudProposal,
    "address-first execution leaves the fraud-review snapshot valid",
  );
  assert.notDeepEqual(
    buildAddressApprovalEvidence("fraud_clearance", common, {
      ...reviewIncident,
      providerEvidence: { avs: "N", cvv: "M" },
    }),
    fraudProposal,
    "changed authoritative provider evidence requires a new fraud proposal",
  );
});

test("canonicalizes Canadian province and postal code", () => {
  const address = canonicalizeReplacementAddress({
    line1: " 10 King Street ",
    city: " Toronto ",
    province: "on",
    postalCode: "m5v2t6",
    country: "Canada",
  });
  assert.equal(address.countryCode, "CA");
  assert.equal(address.province, "ON");
  assert.equal(address.postalCode, "M5V 2T6");
  assert.equal(address.line1, "10 King Street");
});

test("canonicalizes US state and ZIP", () => {
  const address = canonicalizeReplacementAddress({
    line1: "1 Main St",
    city: "Buffalo",
    province: "ny",
    postalCode: "14201-1234",
    country: "United States",
  });
  assert.equal(address.countryCode, "US");
  assert.equal(address.province, "NY");
  assert.equal(address.postalCode, "14201-1234");
});

test("address replacement reference is stable across lease retries", () => {
  const input = {
    requestId: "12345678-1234-1234-1234-123456789012",
    attemptIdentity: "address-replace/request/stable-attempt",
  };
  assert.equal(
    buildAddressReplacementPublicReference(input),
    buildAddressReplacementPublicReference(input),
  );
});

test("automated address changes cannot cross the original country boundary", () => {
  const canada = canonicalizeReplacementAddress({
    line1: "10 King Street",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 2T6",
    country: "Canada",
  });
  assert.equal(
    isSameCountryAddressChange(canada, { ...canada, line1: "20 King Street" }),
    true,
  );
  assert.equal(
    isSameCountryAddressChange(canada, {
      ...canada,
      country: "United States",
      countryCode: "US",
      province: "NY",
      postalCode: "14201",
    }),
    false,
  );
});

test("rejects non-canonical region/postal combinations", () => {
  assert.throws(
    () =>
      canonicalizeReplacementAddress({
        line1: "1 Main St",
        city: "Toronto",
        province: "NY",
        postalCode: "M5V 2T6",
        country: "Canada",
      }),
    /combination is invalid/,
  );
});

test("absorbs post-payment address quote increases without a second charge", () => {
  assert.deepEqual(
    calculateAddressRefreshVariance({
      newDifferenceCents: 1_700,
      settledSupplementCents: 1_200,
    }),
    { absorbedIncreaseCents: 500, supplementRefundCents: 0 },
  );
});

test("refunds the paid supplement when the refreshed address quote decreases", () => {
  assert.deepEqual(
    calculateAddressRefreshVariance({
      newDifferenceCents: 800,
      settledSupplementCents: 1_200,
    }),
    { absorbedIncreaseCents: 0, supplementRefundCents: 400 },
  );
  assert.deepEqual(
    calculateAddressRefreshVariance({
      newDifferenceCents: -200,
      settledSupplementCents: 1_200,
    }),
    { absorbedIncreaseCents: 0, supplementRefundCents: 1_200 },
  );
});

test("address decrease refunds use only authoritative settled purchase cost", () => {
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: 1_500,
      settledPurchaseCents: 1_100,
    }),
    400,
  );
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: 1_250,
      settledPurchaseCents: 1_100,
    }),
    150,
    "reserved or successful prior shipping refunds reduce the remaining remedy",
  );
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: 1_500,
      settledPurchaseCents: 1_450,
    }),
    0,
    "sub-dollar decreases are absorbed",
  );
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: 1_500,
      settledPurchaseCents: 1_700,
    }),
    0,
    "post-settlement increases are absorbed",
  );
});

test("sequential address decreases use the complete net shipping ledger", () => {
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: 1_700,
      settledPurchaseCents: 1_300,
    }),
    400,
  );
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: 1_300,
      settledPurchaseCents: 1_200,
    }),
    100,
  );
});

test("a manual-review shipping refund remains reserved in the net balance", () => {
  const capturedShippingCents = 1_700;
  const manualReviewRefundCents = 400;
  assert.equal(
    calculateSettledAddressShippingRefund({
      netCustomerShippingCents: capturedShippingCents - manualReviewRefundCents,
      settledPurchaseCents: 1_200,
    }),
    100,
  );
});
