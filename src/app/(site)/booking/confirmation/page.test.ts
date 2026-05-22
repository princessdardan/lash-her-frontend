import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("src/app/(site)/booking/confirmation/page.tsx", "utf8");

test("legacy booking confirmation redirects to the service confirmation resolver", () => {
  assert.match(source, /unstable_noStore as noStore/);
  assert.match(source, /buildServiceBookingConfirmationResolverUrl/);
  assert.match(source, /redirect\(buildServiceBookingConfirmationResolverUrl\(/);
  assert.doesNotMatch(source, /getVerifiedBookingConfirmation/);
});
