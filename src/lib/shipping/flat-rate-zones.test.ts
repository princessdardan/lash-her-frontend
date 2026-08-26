import assert from "node:assert/strict";
import test from "node:test";

import {
  billableWeightGrams,
  dimensionalWeightGrams,
  resolveShippingZone,
  resolveSizeBucket,
  roundUpToDollarCents,
} from "./flat-rate-zones";

test("resolveShippingZone maps regions to regional buckets", () => {
  assert.equal(resolveShippingZone("CA", "ON"), "ca_on");
  assert.equal(resolveShippingZone("CA", "qc"), "ca_qc_atlantic");
  assert.equal(resolveShippingZone("CA", "BC"), "ca_bc");
  assert.equal(resolveShippingZone("CA", "NU"), "ca_north");
  assert.equal(resolveShippingZone("US", "NY"), "us_northeast");
  assert.equal(resolveShippingZone("US", "TX"), "us_south");
  assert.equal(resolveShippingZone("US", "CA"), "us_west");
});

test("resolveShippingZone falls back to the most-distant zone for unknown regions", () => {
  assert.equal(resolveShippingZone("CA", "ZZ"), "ca_north");
  assert.equal(resolveShippingZone("US", "ZZ"), "us_west");
  // A CA region string must not resolve to a US zone or vice-versa.
  assert.equal(resolveShippingZone("US", "ON"), "us_west");
  assert.equal(resolveShippingZone("CA", "NY"), "ca_north");
});

test("dimensional weight uses the volumetric divisor", () => {
  // 30×22×5 = 3300 cm³ → 3300/5000 kg = 0.66 kg → 660 g.
  assert.equal(dimensionalWeightGrams(30, 22, 5), 660);
});

test("billable weight is the greater of actual and dimensional", () => {
  // Light but bulky: actual 200 g, dim 660 g → 660 g billable.
  assert.equal(
    billableWeightGrams({
      totalWeightGrams: 200,
      lengthCm: 30,
      widthCm: 22,
      heightCm: 5,
    }),
    660,
  );
  // Dense but small: actual 900 g, dim 120 g → 900 g billable.
  assert.equal(
    billableWeightGrams({
      totalWeightGrams: 900,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 6,
    }),
    900,
  );
});

test("resolveSizeBucket buckets by billable weight", () => {
  // Small dense parcel → 'xs'.
  assert.equal(
    resolveSizeBucket({
      totalWeightGrams: 120,
      lengthCm: 10,
      widthCm: 8,
      heightCm: 2,
    }),
    "xs",
  );
  // Bulky-light parcel promoted by dimensional weight (660 g > 500) → 'm'.
  assert.equal(
    resolveSizeBucket({
      totalWeightGrams: 200,
      lengthCm: 30,
      widthCm: 22,
      heightCm: 5,
    }),
    "m",
  );
  // Heavy parcel → overflow bucket.
  assert.equal(
    resolveSizeBucket({
      totalWeightGrams: 6000,
      lengthCm: 30,
      widthCm: 22,
      heightCm: 5,
    }),
    "xxl",
  );
});

test("roundUpToDollarCents rounds up to the next whole dollar", () => {
  assert.equal(roundUpToDollarCents(1), 100);
  assert.equal(roundUpToDollarCents(100), 100);
  assert.equal(roundUpToDollarCents(101), 200);
  assert.equal(roundUpToDollarCents(1899), 1900);
  assert.equal(roundUpToDollarCents(0), 0);
});
