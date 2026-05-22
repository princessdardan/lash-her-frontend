import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("src/app/(site)/products/confirmation/page.tsx", "utf8");

test("product confirmation disables static caching and indexing for order-bearing links", () => {
  assert.match(source, /unstable_noStore as noStore/);
  assert.match(source, /export const dynamic = "force-dynamic";/);
  assert.match(source, /export const revalidate = 0;/);
  assert.match(source, /robots: \{ index: false, follow: false \}/);
  assert.match(source, /noStore\(\);/);
});

test("product confirmation metadata does not include order query state", () => {
  const metadataSection = source.slice(source.indexOf("export const metadata"), source.indexOf("interface ConfirmationPageProps"));

  assert.doesNotMatch(metadataSection, /orderId|params|searchParams|getVerified|checkoutOrder|token/);
});
