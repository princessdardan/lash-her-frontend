import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRODUCT_TAX_POLICY_VERSION,
  assertProductTaxPolicyVersionImplemented,
  calculateProductTax,
  normalizeCanadianProvinceCode,
} from "./product-tax-policy";

test("applies 13% HST for Ontario destinations", () => {
  const quote = calculateProductTax({
    destinationCountry: "CA",
    destinationRegionCode: "ON",
    taxableAmountCents: 10_000,
  });
  assert.equal(quote.taxAmountCents, 1_300);
  assert.equal(quote.taxRate, 0.13);
  assert.equal(quote.taxName, "HST");
  assert.equal(quote.jurisdiction, "CA-ON");
  assert.equal(quote.collected, true);
  assert.equal(quote.policyVersion, PRODUCT_TAX_POLICY_VERSION);
});

test("applies 15% HST for Atlantic HST provinces and 14% for Nova Scotia", () => {
  assert.equal(
    calculateProductTax({
      destinationCountry: "CA",
      destinationRegionCode: "NB",
      taxableAmountCents: 10_000,
    }).taxAmountCents,
    1_500,
  );
  assert.equal(
    calculateProductTax({
      destinationCountry: "CA",
      destinationRegionCode: "NS",
      taxableAmountCents: 10_000,
    }).taxAmountCents,
    1_400,
  );
});

test("applies 5% GST (no PST/QST) for non-HST provinces and territories", () => {
  for (const region of ["AB", "BC", "MB", "SK", "QC", "NT", "NU", "YT"]) {
    const quote = calculateProductTax({
      destinationCountry: "CA",
      destinationRegionCode: region,
      taxableAmountCents: 10_000,
    });
    assert.equal(quote.taxAmountCents, 500, `${region} should be 5% GST`);
    assert.equal(quote.taxName, "GST");
  }
});

test("collects no tax for US destinations", () => {
  const quote = calculateProductTax({
    destinationCountry: "US",
    destinationRegionCode: "NY",
    taxableAmountCents: 10_000,
  });
  assert.equal(quote.taxAmountCents, 0);
  assert.equal(quote.collected, false);
  assert.equal(quote.taxName, "None");
  assert.equal(quote.jurisdiction, "US");
});

test("rounds tax to the nearest cent", () => {
  // 4999 * 0.13 = 649.87 -> 650
  assert.equal(
    calculateProductTax({
      destinationCountry: "CA",
      destinationRegionCode: "ON",
      taxableAmountCents: 4_999,
    }).taxAmountCents,
    650,
  );
});

test("accepts full province names and is case-insensitive", () => {
  assert.equal(normalizeCanadianProvinceCode("Ontario"), "ON");
  assert.equal(normalizeCanadianProvinceCode("british columbia"), "BC");
  assert.equal(normalizeCanadianProvinceCode(" qc "), "QC");
  assert.equal(normalizeCanadianProvinceCode("Nunavut"), "NU");
  assert.equal(normalizeCanadianProvinceCode("XX"), null);
  assert.equal(normalizeCanadianProvinceCode(null), null);
});

test("fails closed for an unknown Canadian province", () => {
  assert.throws(
    () =>
      calculateProductTax({
        destinationCountry: "CA",
        destinationRegionCode: "ZZ",
        taxableAmountCents: 10_000,
      }),
    /Unsupported Canadian tax jurisdiction/,
  );
  assert.throws(
    () =>
      calculateProductTax({
        destinationCountry: "CA",
        destinationRegionCode: null,
        taxableAmountCents: 10_000,
      }),
    /Unsupported Canadian tax jurisdiction/,
  );
});

test("rejects invalid taxable amounts", () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      calculateProductTax({
        destinationCountry: "CA",
        destinationRegionCode: "ON",
        taxableAmountCents: bad,
      }),
    );
  }
});

test("returns zero tax for a zero taxable base without throwing", () => {
  const quote = calculateProductTax({
    destinationCountry: "CA",
    destinationRegionCode: "ON",
    taxableAmountCents: 0,
  });
  assert.equal(quote.taxAmountCents, 0);
  assert.equal(quote.collected, true);
});

test("version guard passes for the implemented version and fails otherwise", () => {
  assert.doesNotThrow(() =>
    assertProductTaxPolicyVersionImplemented(PRODUCT_TAX_POLICY_VERSION),
  );
  assert.throws(
    () => assertProductTaxPolicyVersionImplemented("some-other-version"),
    /does not match the implemented version/,
  );
});
