import assert from "node:assert/strict";
import test from "node:test";

import { persistVerifiedPayment, verifyHelcimPayment } from "./verified-payment";

const order = {
  amount: 50,
  currency: "CAD",
  helcimInvoiceId: 12345,
  helcimInvoiceNumber: "INV-12345",
};

const validData = {
  approved: true,
  amount: 50,
  currency: "CAD",
  invoiceId: 12345,
  invoiceNumber: "INV-12345",
  transactionId: "txn_123",
};

test("verifyHelcimPayment accepts an authenticated approved payment for the pending order", () => {
  const result = verifyHelcimPayment({
    data: validData,
    hash: "valid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => true,
  });

  assert.deepEqual(result, { ok: true, transactionId: "txn_123" });
});

test("verifyHelcimPayment rejects a valid hash with an unapproved payment", () => {
  const result = verifyHelcimPayment({
    data: { ...validData, approved: false },
    hash: "valid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => true,
  });

  assert.deepEqual(result, { ok: false, reason: "unapproved_payment" });
});

test("verifyHelcimPayment rejects a valid hash with the wrong amount", () => {
  const result = verifyHelcimPayment({
    data: { ...validData, amount: 49.99 },
    hash: "valid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => true,
  });

  assert.deepEqual(result, { ok: false, reason: "wrong_amount" });
});

test("verifyHelcimPayment rejects a valid hash with the wrong currency", () => {
  const result = verifyHelcimPayment({
    data: { ...validData, currency: "USD" },
    hash: "valid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => true,
  });

  assert.deepEqual(result, { ok: false, reason: "wrong_currency" });
});

test("verifyHelcimPayment rejects a valid hash with the wrong invoice", () => {
  const result = verifyHelcimPayment({
    data: { ...validData, invoiceNumber: "INV-99999" },
    hash: "valid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => true,
  });

  assert.deepEqual(result, { ok: false, reason: "wrong_invoice" });
});

test("verifyHelcimPayment rejects a valid hash with a missing transaction id", () => {
  const result = verifyHelcimPayment({
    data: {
      approved: true,
      amount: 50,
      currency: "CAD",
      invoiceId: 12345,
      invoiceNumber: "INV-12345",
    },
    hash: "valid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => true,
  });

  assert.deepEqual(result, { ok: false, reason: "missing_transaction_id" });
});

test("verifyHelcimPayment rejects an invalid hash before semantic payment checks", () => {
  const result = verifyHelcimPayment({
    data: validData,
    hash: "invalid-hash",
    order,
    secretToken: "secret-token",
    validateHash: () => false,
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_hash" });
});

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
