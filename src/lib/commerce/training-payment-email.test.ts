import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync("src/lib/commerce/training-payment-email.ts", "utf8");

test("customer training payment email copy does not ask for checkout email", () => {
  assert.equal(source.includes("email address used at checkout"), false);
  assert.equal(source.includes("same email address from checkout"), false);
  assert.match(source, /secure booking link below/);
});
