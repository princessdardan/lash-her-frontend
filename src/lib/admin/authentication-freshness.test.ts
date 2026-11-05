import assert from "node:assert/strict";
import test from "node:test";
import { assertFreshAdminAuthenticationTimestamp } from "./authentication-freshness";
import { AdminAuthenticationFreshnessError } from "./types";

test("admin freshness accepts the exact five-minute boundary and expires older proof", () => {
  assert.equal(assertFreshAdminAuthenticationTimestamp(1_000, 1_300_000, 300_000).getTime(), 1_000_000);
  assert.throws(() => assertFreshAdminAuthenticationTimestamp(1_000, 1_300_001, 300_000), error =>
    error instanceof AdminAuthenticationFreshnessError && error.code === "expired");
});
test("admin freshness rejects absent, malformed, nonfinite and future timestamps as known denials", () => {
  for (const value of [undefined, 0, -1, NaN, Infinity, "1000", 1_000.5, 1_301, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => assertFreshAdminAuthenticationTimestamp(value, 1_300_000, 300_000), error =>
      error instanceof AdminAuthenticationFreshnessError && error.code === "required");
  }
});
