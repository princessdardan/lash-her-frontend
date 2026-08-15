import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProviderMoneyCents,
  parseProviderSettlement,
} from "./provider-money";

test("provider money is parsed exactly into cents", () => {
  assert.equal(parseProviderMoneyCents("0"), 0);
  assert.equal(parseProviderMoneyCents("12.3"), 1230);
  assert.equal(parseProviderMoneyCents("12.34"), 1234);
  assert.equal(parseProviderMoneyCents(12.34), 1234);
  assert.equal(parseProviderMoneyCents(null), null);
});

test("provider settlement uses purchase_amount as the authoritative settled debit", () => {
  const result = parseProviderSettlement({
    purchaseAmount: "12.34",
    postageFee: "8.00",
    insuranceFee: "1.00",
    deliveryFee: "0.50",
    tariffFee: "0.25",
    fdaPriorNotificationFee: "0.00",
    federalTax: "1.00",
    provincialTax: "1.59",
  });
  assert.equal(result.settledPurchaseCents, 1234);
  assert.equal(result.componentTotalCents, 1234);
  assert.equal(result.componentVarianceCents, 0);
  assert.equal(result.hasCompleteComponentEvidenceWithoutSettlement, false);
});

test("provider settlement components never substitute for purchase_amount", () => {
  assert.equal(
    parseProviderSettlement({ postageFee: "8.00", insuranceFee: "1.00" })
      .settledPurchaseCents,
    null,
  );
  const completeComponents = parseProviderSettlement({
    postageFee: "8.00",
    insuranceFee: "1.00",
    deliveryFee: "0.50",
    tariffFee: "0.25",
    fdaPriorNotificationFee: "0.00",
    federalTax: "1.00",
    provincialTax: "1.59",
  });
  assert.equal(completeComponents.settledPurchaseCents, null);
  assert.equal(completeComponents.componentTotalCents, 1234);
  assert.equal(
    completeComponents.hasCompleteComponentEvidenceWithoutSettlement,
    true,
  );
});

test("provider money rejects ambiguous or invalid accounting values", () => {
  for (const value of ["-1", "1.234", "NaN", "Infinity", "1e3", " 1.00x"]) {
    assert.throws(() => parseProviderMoneyCents(value));
  }
});
