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
