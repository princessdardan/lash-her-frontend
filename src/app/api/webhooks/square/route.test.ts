import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createSquareWebhookPostHandler } from "./route";

const webhookUrl = "https://example.com/api/webhooks/square";
const signatureKey = "square-signature-key";

function createSignedRequest(rawBody: string, signatureOverride?: string): Request {
  const signature = signatureOverride ?? createHmac("sha256", signatureKey)
    .update(`${webhookUrl}${rawBody}`, "utf8")
    .digest("base64");

  return new Request(webhookUrl, {
    method: "POST",
    body: rawBody,
    headers: {
      "x-square-hmacsha256-signature": signature,
    },
  });
}

function createHandler(finalizerCalls: unknown[]) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({
      serviceBookingWebhookUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    finalizeSquarePayment: async (input) => {
      finalizerCalls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid_calendar_pending" };
    },
  });
}

test("Square webhook rejects invalid signatures before parsing or finalization", async () => {
  const finalizerCalls: unknown[] = [];
  const handler = createHandler(finalizerCalls);
  const response = await handler(createSignedRequest("not json", "invalid-signature"));

  assert.equal(response.status, 401);
  assert.equal(finalizerCalls.length, 0);
});

test("Square webhook accepts valid signature and calls shared finalizer", async () => {
  const finalizerCalls: unknown[] = [];
  const handler = createHandler(finalizerCalls);
  const response = await handler(createSignedRequest(JSON.stringify({
    event_id: "evt_123",
    type: "payment.updated",
    data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
  })));

  assert.equal(response.status, 200);
  assert.equal(finalizerCalls.length, 1);
  assert.deepEqual(finalizerCalls[0], {
    event: {
      eventId: "evt_123",
      eventType: "payment.updated",
      orderId: "order_123",
      paymentId: "pay_123",
      payloadSanitized: {
        event_id: "evt_123",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      },
    },
    source: "webhook",
  });
});

test("Square webhook returns success for duplicate webhook finalizer results", async () => {
  const calls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({ serviceBookingWebhookUrl: webhookUrl, webhookSignatureKey: signatureKey }),
    finalizeSquarePayment: async (input) => {
      calls.push(input);
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    },
  });
  const response = await handler(createSignedRequest(JSON.stringify({
    event_id: "evt_duplicate",
    type: "payment.updated",
    data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
  })));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("Square webhook asks Square to retry after temporary finalization errors", async () => {
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({ serviceBookingWebhookUrl: webhookUrl, webhookSignatureKey: signatureKey }),
    finalizeSquarePayment: async () => {
      throw new Error("TEMPORARY_ERROR");
    },
  });
  const response = await handler(createSignedRequest(JSON.stringify({
    event_id: "evt_retry",
    type: "payment.updated",
    data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
  })));

  assert.equal(response.status, 503);
});

test("Square webhook accepts generated mock signatures in mock env and rejects invalid signatures", async () => {
  const rawBody = JSON.stringify({
    event_id: "evt_mock",
    type: "payment.updated",
    data: { object: { payment: { id: "mock-square-payment-1", order_id: "mock-square-order-1" } } },
  });
  const calls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      serviceBookingWebhookUrl: "http://localhost:3000/api/webhooks/square",
      webhookSignatureKey: "mock-square-webhook-signature-key",
    }),
    finalizeSquarePayment: async (input) => {
      calls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid_calendar_pending" };
    },
  });
  const signature = createHmac("sha256", "mock-square-webhook-signature-key")
    .update(`http://localhost:3000/api/webhooks/square${rawBody}`, "utf8")
    .digest("base64");

  const accepted = await handler(new Request("http://localhost:3000/api/webhooks/square", {
    method: "POST",
    body: rawBody,
    headers: { "x-square-hmacsha256-signature": signature },
  }));
  const rejected = await handler(new Request("http://localhost:3000/api/webhooks/square", {
    method: "POST",
    body: rawBody,
    headers: { "x-square-hmacsha256-signature": "invalid" },
  }));

  assert.equal(accepted.status, 200);
  assert.equal(rejected.status, 401);
  assert.equal(calls.length, 1);
});
