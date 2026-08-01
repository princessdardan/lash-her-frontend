import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  parseVerifiedSquareWebhook,
  verifySquareWebhookSignature,
} from "./square-webhook";

test("Square webhook signature validates the exact notification URL and raw body", () => {
  const notificationUrl = "https://example.com/api/webhooks/square";
  const rawBody = JSON.stringify({
    event_id: "evt_123",
    type: "payment.updated",
  });
  const signatureKey = "sandbox-signature-key";
  const signature = createHmac("sha256", signatureKey)
    .update(`${notificationUrl}${rawBody}`, "utf8")
    .digest("base64");

  assert.equal(
    verifySquareWebhookSignature({
      notificationUrl,
      rawBody,
      signature,
      signatureKey,
    }),
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
  const event = parseVerifiedSquareWebhook(
    JSON.stringify({
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
    }),
  );

  assert.equal(event.eventId, "evt_123");
  assert.equal(event.eventType, "payment.updated");
  assert.equal(event.paymentId, "pay_123");
  assert.equal(event.orderId, "order_123");
});

test("verified Square webhook parsing extracts immutable refund evidence", () => {
  const event = parseVerifiedSquareWebhook(
    JSON.stringify({
      created_at: "2026-07-20T15:00:00.000Z",
      event_id: "evt_refund_123",
      type: "refund.updated",
      data: {
        object: {
          refund: {
            amount_money: { amount: 2_500, currency: "cad" },
            created_at: "2026-07-20T14:55:00.000Z",
            id: "refund_123",
            payment_id: "pay_123",
            status: "completed",
            updated_at: "2026-07-20T14:59:00.000Z",
          },
        },
      },
    }),
  );

  assert.equal(event.paymentId, "pay_123");
  assert.deepEqual(event.refund, {
    amountCents: 2_500,
    currency: "CAD",
    occurredAt: "2026-07-20T14:59:00.000Z",
    paymentId: "pay_123",
    refundId: "refund_123",
    status: "COMPLETED",
  });
});

test("verified Square webhook parsing rejects malformed refund evidence", () => {
  assert.throws(
    () =>
      parseVerifiedSquareWebhook(
        JSON.stringify({
          event_id: "evt_refund_bad",
          type: "refund.created",
          data: {
            object: {
              refund: {
                id: "refund_bad",
                payment_id: "pay_123",
                status: "PENDING",
              },
            },
          },
        }),
      ),
    /refund webhook is malformed/,
  );
});
