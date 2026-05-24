import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("src/app/(site)/checkout/page.tsx", "utf8");

test("checkout page renders empty-cart state instead of 404 when product catalog is empty", () => {
  assert.match(source, /<CheckoutPageClient products=\{products\} \/>/);
  assert.doesNotMatch(source, /notFound\(\)/);
});
