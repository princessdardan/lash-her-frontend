import assert from "node:assert/strict";
import test from "node:test";

import { findSquareSupplementalObligationByReference } from "./order-store";

// Regression: a Square `payment.*` webhook whose `reference_id` is not an
// obligation id (service-booking charges use the `hold_…` public reference,
// product/training checkout use `lh-sq-…`) must not reach the `uuid` equality
// on `order_payment_obligations.id`. Postgres throws
// `invalid input syntax for type uuid` for such a literal, which previously
// surfaced as a webhook "Failed query" and a 503 retry storm. Non-UUID
// references short-circuit to `null` before any database access, so these
// assertions need no DB connection.

test("supplemental obligation lookup returns null for a booking hold reference", async () => {
  const result =
    await findSquareSupplementalObligationByReference("hold_HvbjgQGnrbWa");

  assert.equal(result, null);
});

test("supplemental obligation lookup returns null for other non-UUID references", async () => {
  for (const reference of [
    "lh-sq-abc123def456",
    "not-a-uuid",
    "",
    // UUID-ish but not a canonical UUID (missing hyphens / wrong length).
    "3f2504e04f8941d39a0c0305e82c3301",
  ]) {
    const result = await findSquareSupplementalObligationByReference(reference);

    assert.equal(result, null, `expected null for reference "${reference}"`);
  }
});
