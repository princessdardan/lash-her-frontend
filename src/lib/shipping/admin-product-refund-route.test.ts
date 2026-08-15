import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("admin product refund route only reserves durable refund work", () => {
  const source = readFileSync(
    new URL(
      "../../app/api/admin/orders/[orderId]/refund/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /processProductOrderRefund/);
  assert.doesNotMatch(source, /refundPayment\s*\(/);
  assert.match(source, /queueProductOrderRefundAllocations/);
  assert.match(source, /status:\s*202/);
});
