import assert from "node:assert/strict";
import test from "node:test";

import { createServiceIdentifier } from "./service-identifier";

test("creates a booking-safe identifier from a service title", () => {
  assert.equal(createServiceIdentifier("Classic Fill"), "classic-fill");
  assert.equal(createServiceIdentifier("  Lash'd & Lifted  "), "lashd-lifted");
  assert.equal(createServiceIdentifier("Volume — Refill"), "volume-refill");
});

test("removes accents and caps identifiers at the accepted length", () => {
  assert.equal(createServiceIdentifier("Élite Touch-Up"), "elite-touch-up");
  assert.equal(createServiceIdentifier("A".repeat(110)).length, 100);
  assert.equal(
    createServiceIdentifier(`${"a".repeat(99)} long suffix`),
    "a".repeat(99),
  );
});
