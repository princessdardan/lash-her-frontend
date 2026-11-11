import assert from "node:assert/strict";
import test from "node:test";
import { writerFirstOwnerDiscoveryWindowSha256 } from "@/lib/writer-admission/context";
import { assertFirstOwnerDiscoveryGoogleAuthentication, assertFreshAdminAuthenticationTimestamp } from "./authentication-freshness";
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

test("first-owner discovery freshness binds the selected window and rejects stale callback reuse", () => {
  const selection = { nonce: "8".repeat(32), emailDigest: "6".repeat(62), epoch: "12", startedAt: 1_794_009_600 };
  const observedAt = selection.startedAt * 1000 + 10;
  const window = writerFirstOwnerDiscoveryWindowSha256(selection);
  assert.doesNotThrow(() => assertFirstOwnerDiscoveryGoogleAuthentication(selection, selection.startedAt, window, observedAt));
  assert.throws(() => assertFirstOwnerDiscoveryGoogleAuthentication(selection, selection.startedAt - 1, window, observedAt));
  assert.throws(() => assertFirstOwnerDiscoveryGoogleAuthentication(selection, selection.startedAt,
    writerFirstOwnerDiscoveryWindowSha256({ ...selection, nonce: "7".repeat(32) }), observedAt));
});
