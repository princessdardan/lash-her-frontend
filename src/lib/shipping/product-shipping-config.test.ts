import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRODUCT_SHIPPING_SETTINGS,
  PRODUCT_SHIPPING_SERVICE_POLICIES,
  getProductShippingClosureDates,
  getProductShippingServicePolicyMap,
  productShippingServiceKey,
} from "./product-shipping-config";

test("settings match the established operational defaults", () => {
  assert.equal(PRODUCT_SHIPPING_SETTINGS.timezone, "America/Toronto");
  assert.equal(PRODUCT_SHIPPING_SETTINGS.orderCutoff, "14:00:00");
  assert.equal(PRODUCT_SHIPPING_SETTINGS.beforeCutoffHandoffBusinessDays, 1);
  assert.equal(PRODUCT_SHIPPING_SETTINGS.afterCutoffHandoffBusinessDays, 2);
  assert.equal(PRODUCT_SHIPPING_SETTINGS.autoRefundBusinessDays, 2);
  assert.equal(PRODUCT_SHIPPING_SETTINGS.signatureThresholdCents, 50_000);
});

test("service policy map is keyed postageType:COUNTRY and carries a reviewedAt", () => {
  const now = new Date("2026-08-17T00:00:00Z");
  const map = getProductShippingServicePolicyMap(now);
  const key = productShippingServiceKey("chit_chats_canada_tracked", "ca");
  assert.equal(key, "chit_chats_canada_tracked:CA");
  const policy = map.get(key);
  assert.ok(policy, "CA tracked service policy should exist");
  assert.equal(policy?.destinationCountryCode, "CA");
  assert.equal(policy?.reviewedAt.getTime(), now.getTime());
  assert.ok((policy?.insuranceLimitCents ?? 0) > 0);
  // Every configured service maps 1:1.
  assert.equal(map.size, PRODUCT_SHIPPING_SERVICE_POLICIES.length);
});

test("closure dates compute Ontario holidays within the coverage window, deduped and sorted", () => {
  const now = new Date("2026-08-17T00:00:00Z");
  const closures = getProductShippingClosureDates(now, 21);
  assert.ok(closures.length > 0);
  // sorted ascending
  for (let i = 1; i < closures.length; i += 1) {
    assert.ok(
      closures[i - 1].date <= closures[i].date,
      "closures must be sorted",
    );
  }
  // no duplicate dates
  assert.equal(new Set(closures.map((c) => c.date)).size, closures.length);
  // all within [today, today+21mo]
  const startsOn = now.toISOString().slice(0, 10);
  const endsOn = new Date(Date.UTC(2028, 4, 17)).toISOString().slice(0, 10);
  for (const c of closures) {
    assert.ok(c.date >= startsOn && c.date <= endsOn, `${c.date} in range`);
    assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  // includes a well-known fixed holiday (Canada Day 2027-07-01)
  assert.ok(
    closures.some((c) => c.date === "2027-07-01"),
    "expected Canada Day 2027 in the window",
  );
});
