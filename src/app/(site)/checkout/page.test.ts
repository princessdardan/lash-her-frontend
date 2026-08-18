import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("src/app/(site)/checkout/page.tsx", "utf8");

test("checkout page renders empty-cart state instead of 404 when product catalog is empty", () => {
  assert.match(source, /<CheckoutPageClient/);
  assert.match(source, /products=\{products\}/);
  assert.match(source, /shippingEnabled=\{isChitChatsCheckoutEnabled\(\)\}/);
  assert.match(source, /manualCheckoutPolicy=\{manualCheckoutPolicy\}/);
  assert.match(source, /pickupTax=\{/);
  assert.doesNotMatch(source, /notFound\(\)/);
});
