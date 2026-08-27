import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  diagnoseSquareWebhookSignatureFailure,
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

test("signature-failure diagnosis flags a configured notificationUrl that does not match the request URL", () => {
  const requestUrl = "https://lashher.com/api/webhooks/square";
  const configuredNotificationUrl =
    "https://staging.lashher.com/api/webhooks/square"; // stale/wrong env
  const rawBody = JSON.stringify({
    event_id: "evt_1",
    type: "payment.updated",
  });
  const signatureKey = "correct-signing-key";
  // Square signs against the URL it actually posts to (requestUrl) — the key is
  // correct, only the configured URL is wrong.
  const signature = createHmac("sha256", signatureKey)
    .update(`${requestUrl}${rawBody}`, "utf8")
    .digest("base64");

  // Sanity: verification against the wrong configured URL fails.
  assert.equal(
    verifySquareWebhookSignature({
      notificationUrl: configuredNotificationUrl,
      rawBody,
      signature,
      signatureKey,
    }),
    false,
  );

  assert.equal(
    diagnoseSquareWebhookSignatureFailure({
      configuredNotificationUrl,
      candidateRequestUrls: [requestUrl],
      rawBody,
      signature,
      signatureKey,
    }),
    "configured_url_mismatch",
  );
});

test("signature-failure diagnosis reports a key/payload mismatch when no candidate URL verifies", () => {
  const requestUrl = "https://lashher.com/api/webhooks/square";
  const rawBody = JSON.stringify({
    event_id: "evt_2",
    type: "payment.updated",
  });
  // Signature was produced with a DIFFERENT key than the one we verify with —
  // no URL can rescue it, so it must not be misreported as a URL misconfig.
  const signature = createHmac("sha256", "an-attacker-or-old-key")
    .update(`${requestUrl}${rawBody}`, "utf8")
    .digest("base64");

  assert.equal(
    diagnoseSquareWebhookSignatureFailure({
      configuredNotificationUrl: requestUrl,
      candidateRequestUrls: [requestUrl, "https://lashher.com/other"],
      rawBody,
      signature,
      signatureKey: "correct-signing-key",
    }),
    "key_or_payload_mismatch",
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

test("verified Square webhook parsing extracts the order ID from order.updated", () => {
  const event = parseVerifiedSquareWebhook(
    JSON.stringify({
      event_id: "evt_order_updated_123",
      type: "order.updated",
      data: {
        id: "order_123",
        object: {
          order_updated: {
            order_id: "order_123",
            state: "COMPLETED",
            version: 2,
          },
        },
        type: "order_updated",
      },
    }),
  );

  assert.equal(event.eventId, "evt_order_updated_123");
  assert.equal(event.eventType, "order.updated");
  assert.equal(event.orderId, "order_123");
  assert.equal(event.paymentId, undefined);
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
