import assert from "node:assert/strict";
import test from "node:test";

import { buildFlatRateRate } from "./flat-rate-quote";

test("flat rate uses the cache entry, rounded up to the next dollar", () => {
  const rate = buildFlatRateRate({
    zoneId: "ca_on",
    sizeBucketId: "s",
    merchandiseValueCents: 4000,
    cacheEntry: {
      postageType: "chit_chats_canada_tracked",
      title: "Canada Tracked",
      amountCents: 1234,
      deliveryMaxBusinessDays: 5,
    },
  });
  assert.equal(rate.paymentAmountCents, 1300); // 1234 → up to 1300
  assert.equal(rate.postageType, "chit_chats_canada_tracked");
  assert.equal(rate.insured, true);
  assert.equal(rate.tracked, true);
  assert.equal(rate.signatureRequired, false); // below $500 threshold
  assert.equal(rate.id, "flat:ca_on:s");
});

test("flat rate falls back to the conservative default on a cache miss", () => {
  const rate = buildFlatRateRate({
    zoneId: "ca_on",
    sizeBucketId: "s",
    merchandiseValueCents: 4000,
    cacheEntry: null,
  });
  // ca_on default is 1500 → already a whole dollar.
  assert.equal(rate.paymentAmountCents, 1500);
  assert.equal(rate.postageType, "flat_rate_standard");
  assert.equal(rate.raw.source, "default");
});

test("flat rate requires signature for high-value orders", () => {
  const rate = buildFlatRateRate({
    zoneId: "us_northeast",
    sizeBucketId: "s",
    merchandiseValueCents: 60000, // > $500 threshold
    cacheEntry: null,
  });
  assert.equal(rate.signatureRequired, true);
  assert.equal(rate.id, "flat:us_northeast:s");
});
