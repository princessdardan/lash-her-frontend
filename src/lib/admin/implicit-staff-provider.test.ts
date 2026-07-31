import assert from "node:assert/strict";
import test from "node:test";

import {
  getImplicitProviderKey,
  getImplicitProviderName,
  getImplicitProviderSlug,
} from "./implicit-staff-provider";

test("implicit provider identity is deterministic for a staff account", () => {
  const userId = "12345678-1234-1234-1234-123456789abc";

  assert.equal(
    getImplicitProviderKey(userId),
    "staff-12345678123412341234123456789abc",
  );
  assert.equal(
    getImplicitProviderSlug("Nataliea Smith", userId),
    "nataliea-smith-12345678",
  );
});

test("implicit provider names prefer the account name and fall back to email", () => {
  assert.equal(
    getImplicitProviderName(" Nataliea ", "owner@example.com"),
    "Nataliea",
  );
  assert.equal(getImplicitProviderName(null, "owner@example.com"), "owner");
});

test("implicit provider slugs normalize punctuation and diacritics", () => {
  assert.equal(
    getImplicitProviderSlug(
      "Lash Hér & Co.",
      "abcdef12-1234-1234-1234-123456789abc",
    ),
    "lash-her-co-abcdef12",
  );
});
