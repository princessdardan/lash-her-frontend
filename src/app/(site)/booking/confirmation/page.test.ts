import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("src/app/(site)/booking/confirmation/page.tsx", "utf8");

test("legacy booking confirmation disables static caching and indexing", () => {
  assert.match(source, /export const dynamic = "force-dynamic";/);
  assert.match(source, /export const revalidate = 0;/);
  assert.match(source, /robots: \{ index: false, follow: false \}/);
  assert.match(source, /noStore\(\);/);
});

test("legacy booking confirmation redirects to the service confirmation resolver", () => {
  assert.match(source, /unstable_noStore as noStore/);
  assert.match(source, /buildServiceBookingConfirmationResolverUrl/);
  assert.match(source, /redirect\(buildServiceBookingConfirmationResolverUrl\(/);
  assert.doesNotMatch(source, /getVerifiedBookingConfirmation/);
});
