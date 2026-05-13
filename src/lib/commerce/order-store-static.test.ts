import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("checkout order persistence does not write private data to Sanity", () => {
  const orderStore = readFileSync(join(process.cwd(), "src/lib/commerce/order-store.ts"), "utf8");

  assert.equal(orderStore.includes("@/sanity/lib/write-client"), false);
  assert.equal(orderStore.includes("writeClient.create"), false);
  assert.equal(orderStore.includes("writeClient.patch"), false);
  assert.equal(orderStore.includes('_type: "checkoutOrder"'), false);
});

test("Sanity Studio no longer registers or exposes checkout orders", () => {
  const schemaIndex = readFileSync(join(process.cwd(), "src/sanity/schemas/index.ts"), "utf8");
  const structure = readFileSync(join(process.cwd(), "src/sanity/structure/index.ts"), "utf8");

  assert.equal(schemaIndex.includes("checkoutOrder"), false);
  assert.equal(structure.includes("checkoutOrder"), false);
  assert.equal(
    existsSync(join(process.cwd(), "src/sanity/schemas/documents/checkout-order.ts")),
    false,
  );
});
