import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  getHelcimWebhookHeaders,
  mergeHelcimCardTransactionDetails,
  parseVerifiedHelcimWebhook,
  normalizeHelcimCardTransactionDetails,
  verifyHelcimWebhookSignature,
} from "./helcim-webhook";

const verifierToken = Buffer.from("webhook-secret-key").toString("base64");
const rawBody = JSON.stringify({
  eventType: "cardTransaction",
  data: {
    amount: "50.00",
    currency: "CAD",
    invoiceId: 12345,
    invoiceNumber: "INV-12345",
    status: "APPROVED",
    transactionId: "txn_123",
  },
});
const headers = {
  id: "webhook_123",
  timestamp: "1778450000",
  signature: createSignature("webhook_123", "1778450000", rawBody),
};
const now = Number.parseInt(headers.timestamp, 10) * 1000;

test("verifyHelcimWebhookSignature accepts a matching Helcim signature", () => {
  assert.equal(verifyHelcimWebhookSignature(headers, rawBody, verifierToken, now), true);
});

test("verifyHelcimWebhookSignature accepts version-prefixed Helcim signatures", () => {
  assert.equal(
    verifyHelcimWebhookSignature(
      { ...headers, signature: `v1,${headers.signature}` },
      rawBody,
      verifierToken,
      now,
    ),
    true,
  );
});

test("verifyHelcimWebhookSignature accepts one valid signature among multiple candidates", () => {
  assert.equal(
    verifyHelcimWebhookSignature(
      { ...headers, signature: `v1,bad-signature v2,${headers.signature}` },
      rawBody,
      verifierToken,
      now,
    ),
    true,
  );
});

test("verifyHelcimWebhookSignature rejects mismatched signatures", () => {
  assert.equal(
    verifyHelcimWebhookSignature(
      { ...headers, signature: createSignature(headers.id, headers.timestamp, "{}") },
      rawBody,
      verifierToken,
      now,
    ),
    false,
  );
});

test("verifyHelcimWebhookSignature rejects stale signed payloads", () => {
  assert.equal(
    verifyHelcimWebhookSignature(
      headers,
      rawBody,
      verifierToken,
      now + (11 * 60 * 60 * 1000),
    ),
    false,
  );
});

test("parseVerifiedHelcimWebhook extracts only reconciliation fields", () => {
  assert.deepEqual(parseVerifiedHelcimWebhook(headers, rawBody), {
    amount: "50.00",
    currency: "CAD",
    eventId: "webhook_123",
    eventType: "cardTransaction",
    helcimInvoiceId: 12345,
    helcimInvoiceNumber: "INV-12345",
    helcimTransactionId: "txn_123",
    status: "APPROVED",
  });
});

test("parseVerifiedHelcimWebhook accepts sparse cardTransaction webhook payloads", () => {
  const sparseBody = JSON.stringify({ id: "25764674", type: "cardTransaction" });

  assert.deepEqual(parseVerifiedHelcimWebhook(headers, sparseBody), {
    amount: undefined,
    currency: undefined,
    eventId: "webhook_123",
    eventType: "cardTransaction",
    helcimInvoiceId: undefined,
    helcimInvoiceNumber: undefined,
    helcimTransactionId: "25764674",
    status: undefined,
  });
});

test("mergeHelcimCardTransactionDetails stores only minimal redacted reconciliation fields", () => {
  const event = parseVerifiedHelcimWebhook(
    headers,
    JSON.stringify({ id: "25764674", type: "cardTransaction" }),
  );
  const merged = mergeHelcimCardTransactionDetails(event, {
    amount: "123.45",
    approvalCode: "APPROVAL-123",
    card: {
      brand: "Visa",
      cardNumber: "4111111111111111",
      last4: "1111",
      token: "card-token-secret",
    },
    cardToken: "card-token-secret",
    currency: "CAD",
    customerCode: "customer-secret",
    id: 25764674,
    invoiceNumber: "INV-4242",
    status: "APPROVED",
  });

  assert.equal(merged.helcimTransactionId, "25764674");
  assert.equal(merged.status, "APPROVED");
  assert.equal(merged.amount, "123.45");
  assert.equal(merged.currency, "CAD");
  assert.equal(merged.helcimInvoiceNumber, "INV-4242");
  assert.equal(merged.approvalCode, "APPROVAL-123");
  assert.equal(merged.cardType, "Visa");
  assert.equal(merged.cardLast4, "1111");
  assert.deepEqual(merged.payloadRedacted, {
    amount: "123.45",
    approvalCode: "APPROVAL-123",
    cardLast4: "1111",
    cardType: "Visa",
    currency: "CAD",
    invoiceNumber: "INV-4242",
    status: "APPROVED",
    transactionId: "25764674",
  });
  assert.equal(Object.hasOwn(merged.payloadRedacted ?? {}, "cardToken"), false);
  assert.equal(Object.hasOwn(merged.payloadRedacted ?? {}, "cardNumber"), false);
  assert.equal(Object.hasOwn(merged.payloadRedacted ?? {}, "customerCode"), false);
});

test("normalizeHelcimCardTransactionDetails derives last4 from top-level masked cardNumber when explicit last4 is absent", () => {
  assert.deepEqual(
    normalizeHelcimCardTransactionDetails({
      cardNumber: "411111******1111",
      transactionId: "txn_123",
    }),
    {
      amount: undefined,
      approvalCode: undefined,
      cardLast4: "1111",
      cardType: undefined,
      currency: undefined,
      invoiceNumber: undefined,
      status: undefined,
      transactionId: "txn_123",
    },
  );
});

test("normalizeHelcimCardTransactionDetails derives last4 from nested card.cardNumber when explicit last4 is absent", () => {
  assert.deepEqual(
    normalizeHelcimCardTransactionDetails({
      card: {
        cardNumber: "411111******4242",
      },
      transactionId: "txn_4242",
    }),
    {
      amount: undefined,
      approvalCode: undefined,
      cardLast4: "4242",
      cardType: undefined,
      currency: undefined,
      invoiceNumber: undefined,
      status: undefined,
      transactionId: "txn_4242",
    },
  );
});

test("normalizeHelcimCardTransactionDetails keeps explicit last4 over cardNumber", () => {
  assert.deepEqual(
    normalizeHelcimCardTransactionDetails({
      card: {
        cardLast4: "1234",
        cardNumber: "411111******1111",
      },
      cardLast4: "9999",
      transactionId: "txn_explicit",
    }),
    {
      amount: undefined,
      approvalCode: undefined,
      cardLast4: "9999",
      cardType: undefined,
      currency: undefined,
      invoiceNumber: undefined,
      status: undefined,
      transactionId: "txn_explicit",
    },
  );
});

test("getHelcimWebhookHeaders returns null when required signature headers are missing", () => {
  const parsedHeaders = getHelcimWebhookHeaders(new Headers({ "webhook-id": "webhook_123" }));

  assert.equal(parsedHeaders, null);
});

function createSignature(id: string, timestamp: string, body: string): string {
  return createHmac("sha256", Buffer.from(verifierToken, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
}
