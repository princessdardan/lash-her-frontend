import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  parseVerifiedSquareWebhook,
  verifySquareWebhookSignature,
} from "./square-webhook";

test("Square webhook signature validates the exact notification URL and raw body", () => {
  const notificationUrl = "https://example.com/api/webhooks/square";
  const rawBody = JSON.stringify({ event_id: "evt_123", type: "payment.updated" });
  const signatureKey = "sandbox-signature-key";
  const signature = createHmac("sha256", signatureKey)
    .update(`${notificationUrl}${rawBody}`, "utf8")
    .digest("base64");

  assert.equal(
    verifySquareWebhookSignature({ notificationUrl, rawBody, signature, signatureKey }),
    true,
  );
  assert.equal(
    verifySquareWebhookSignature({
      notificationUrl: `${notificationUrl}/wrong`,
      rawBody,
      signature,
      signatureKey,
    }),
    false,
  );
});

test("verified Square webhook parsing extracts event and payment identifiers", () => {
  const event = parseVerifiedSquareWebhook(JSON.stringify({
    event_id: "evt_123",
    type: "payment.updated",
    data: {
      object: {
        payment: {
          id: "pay_123",
          order_id: "order_123",
          status: "COMPLETED",
        },
      },
    },
  }));

  assert.equal(event.eventId, "evt_123");
  assert.equal(event.eventType, "payment.updated");
  assert.equal(event.paymentId, "pay_123");
  assert.equal(event.orderId, "order_123");
});
