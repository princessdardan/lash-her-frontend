import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const resolverPath = "src/app/(site)/services/booking/confirmation/page.tsx";
const serviceSlugPath = "src/app/(site)/services/[slug]/page.tsx";
const resolverSource = readFileSync(resolverPath, "utf8");
const serviceSlugSource = readFileSync(serviceSlugPath, "utf8");

test("service confirmation resolver is a reserved static segment before service slug pages", () => {
  assert.equal(existsSync(resolverPath), true);
  assert.match(resolverSource, /getServiceBookingConfirmationRedirect/);
  assert.match(resolverSource, /redirect\(redirectUrl\)/);
  assert.doesNotMatch(serviceSlugSource, /getServiceBookingConfirmationRedirect/);
});

test("service confirmation resolver disables static caching and indexing", () => {
  assert.match(resolverSource, /export const dynamic = "force-dynamic";/);
  assert.match(resolverSource, /export const revalidate = 0;/);
  assert.match(resolverSource, /robots: \{ index: false, follow: false \}/);
  assert.match(resolverSource, /noStore\(\);/);
});
