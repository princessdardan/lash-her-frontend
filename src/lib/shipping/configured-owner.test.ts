import assert from "node:assert/strict";
import test from "node:test";

import { isConfiguredOwnerEmail } from "./configured-owner";

test("owner email match is case- and whitespace-insensitive", () => {
  const configured = ["nataliea@example.invalid"];
  assert.equal(
    isConfiguredOwnerEmail("nataliea@example.invalid", configured),
    true,
  );
  assert.equal(
    isConfiguredOwnerEmail("  Nataliea@Example.Invalid  ", configured),
    true,
  );
});

test("non-configured or empty emails are rejected", () => {
  const configured = ["nataliea@example.invalid"];
  assert.equal(
    isConfiguredOwnerEmail("other@example.invalid", configured),
    false,
  );
  assert.equal(isConfiguredOwnerEmail("", configured), false);
  assert.equal(isConfiguredOwnerEmail(null, configured), false);
  assert.equal(isConfiguredOwnerEmail("nataliea@example.invalid", []), false);
});

test("any configured owner email is accepted (no single-owner restriction)", () => {
  const configured = ["a@example.invalid", "b@example.invalid"];
  assert.equal(isConfiguredOwnerEmail("b@example.invalid", configured), true);
});
