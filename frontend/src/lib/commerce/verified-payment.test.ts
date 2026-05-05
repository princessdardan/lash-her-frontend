import assert from "node:assert/strict";
import test from "node:test";

import { persistVerifiedPayment } from "./verified-payment";

test("persistVerifiedPayment returns true when paid status is recorded", async () => {
  const calls: Array<{ orderId: string; transactionId: string }> = [];

  const result = await persistVerifiedPayment({
    markPaid: async (orderId, transactionId) => {
      calls.push({ orderId, transactionId });
    },
    orderId: "lh-order",
    transactionId: "txn_123",
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [{ orderId: "lh-order", transactionId: "txn_123" }]);
});

test("persistVerifiedPayment logs reconciliation details when persistence fails", async () => {
  const logs: Array<{ message: string; orderId: string; transactionId: string; error: string }> = [];

  const result = await persistVerifiedPayment({
    logError: (message, context) => {
      logs.push({ message, ...context });
    },
    markPaid: async () => {
      throw new Error("Sanity write failed");
    },
    orderId: "lh-order",
    transactionId: "txn_123",
  });

  assert.equal(result, false);
  assert.deepEqual(logs, [
    {
      error: "Sanity write failed",
      message: "[checkout] Verified payment could not be persisted",
      orderId: "lh-order",
      transactionId: "txn_123",
    },
  ]);
});
