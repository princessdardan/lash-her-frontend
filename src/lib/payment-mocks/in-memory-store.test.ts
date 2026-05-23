import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentMockStore } from "./in-memory-store";

test("payment mock store records and resets idempotency, webhook, and provider state", () => {
  const now = new Date("2026-05-23T12:00:00.000Z");
  const store = createPaymentMockStore({ now: () => now });

  assert.equal(store.idempotencyRecords.length, 0);
  assert.equal(store.webhookEventRecords.length, 0);
  assert.equal(store.providerTransactions.length, 0);
  assert.equal(store.providerOrders.length, 0);

  store.recordIdempotencyRecord({
    createdAt: now,
    idempotencyKey: "idempotency-key-1",
    payloadHash: "payload-hash-1",
    scenario: "success",
    provider: "helcim",
  });
  store.recordWebhookEvent({
    createdAt: now,
    eventId: "event-1",
    payloadHash: "webhook-payload-1",
    provider: "square",
    scenario: "webhook",
  });
  store.recordProviderTransaction({
    createdAt: now,
    orderId: "order-1",
    provider: "helcim",
    scenario: "success",
    status: "APPROVED",
    transactionId: "transaction-1",
  });
  store.recordProviderOrder({
    createdAt: now,
    orderId: "order-1",
    provider: "square",
    scenario: "success",
    status: "COMPLETED",
  });

  assert.equal(store.getIdempotencyRecord("idempotency-key-1")?.payloadHash, "payload-hash-1");
  assert.equal(store.hasWebhookEvent("event-1"), true);
  assert.equal(store.getProviderTransaction("transaction-1")?.orderId, "order-1");
  assert.equal(store.getProviderOrder("order-1")?.status, "COMPLETED");

  store.reset();

  assert.equal(store.idempotencyRecords.length, 0);
  assert.equal(store.webhookEventRecords.length, 0);
  assert.equal(store.providerTransactions.length, 0);
  assert.equal(store.providerOrders.length, 0);
  assert.equal(store.getIdempotencyRecord("idempotency-key-1"), null);
  assert.equal(store.hasWebhookEvent("event-1"), false);
  assert.equal(store.getProviderTransaction("transaction-1"), null);
  assert.equal(store.getProviderOrder("order-1"), null);
});
