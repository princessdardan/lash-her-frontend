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
  assert.equal(
    verifyHelcimWebhookSignature(headers, rawBody, verifierToken, now),
    true,
  );
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
      {
        ...headers,
        signature: createSignature(headers.id, headers.timestamp, "{}"),
      },
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
      now + 11 * 60 * 60 * 1000,
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
    merchantReference: undefined,
    status: "APPROVED",
  });
});

test("parseVerifiedHelcimWebhook accepts sparse cardTransaction webhook payloads", () => {
  const sparseBody = JSON.stringify({
    id: "25764674",
    type: "cardTransaction",
  });

  assert.deepEqual(parseVerifiedHelcimWebhook(headers, sparseBody), {
    amount: undefined,
    currency: undefined,
    eventId: "webhook_123",
    eventType: "cardTransaction",
    helcimInvoiceId: undefined,
    helcimInvoiceNumber: undefined,
    helcimTransactionId: "25764674",
    merchantReference: undefined,
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
    invoiceId: 4242,
    invoiceNumber: "INV-4242",
    status: "APPROVED",
  });

  assert.equal(merged.helcimTransactionId, "25764674");
  assert.equal(merged.status, "APPROVED");
  assert.equal(merged.amount, "123.45");
  assert.equal(merged.currency, "CAD");
  assert.equal(merged.helcimInvoiceId, 4242);
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
    invoiceId: 4242,
    invoiceNumber: "INV-4242",
    status: "APPROVED",
    transactionId: "25764674",
  });
  assert.equal(Object.hasOwn(merged.payloadRedacted ?? {}, "cardToken"), false);
  assert.equal(
    Object.hasOwn(merged.payloadRedacted ?? {}, "cardNumber"),
    false,
  );
  assert.equal(
    Object.hasOwn(merged.payloadRedacted ?? {}, "customerCode"),
    false,
  );
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
      avsCode: undefined,
      cardLast4: "1111",
      cardType: undefined,
      currency: undefined,
      cvvCode: undefined,
      invoiceId: undefined,
      invoiceNumber: undefined,
      originalTransactionId: undefined,
      status: undefined,
      transactionId: "txn_123",
      transactionType: undefined,
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
      avsCode: undefined,
      cardLast4: "4242",
      cardType: undefined,
      currency: undefined,
      cvvCode: undefined,
      invoiceId: undefined,
      invoiceNumber: undefined,
      originalTransactionId: undefined,
      status: undefined,
      transactionId: "txn_4242",
      transactionType: undefined,
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
      avsCode: undefined,
      cardLast4: "9999",
      cardType: undefined,
      currency: undefined,
      cvvCode: undefined,
      invoiceId: undefined,
      invoiceNumber: undefined,
      originalTransactionId: undefined,
      status: undefined,
      transactionId: "txn_explicit",
      transactionType: undefined,
    },
  );
});

test("certified nested evidence and refund correlation fields are exact and case-sensitive", () => {
  const previous = process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
  process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON = JSON.stringify({
    contract: "helcim_product_payments",
    version: "captured-v1",
    evidenceReference: "sandbox-triple:captured-v1",
    effectiveFrom: "2020-01-01T00:00:00.000Z",
    effectiveUntil: "2099-01-01T00:00:00.000Z",
    purchaseTransactionTypes: ["purchase"],
    refundTransactionTypes: ["refund"],
    purchaseSuccessfulStatuses: ["approved"],
    refundSuccessfulStatuses: ["settled"],
    avs: {
      fieldNames: ["verification.avsResponse"],
      matchCodes: ["y"],
      mismatchCodes: ["n"],
    },
    cvv: {
      fieldNames: ["verification.cvvResponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    refundCorrelation: {
      providerRefundIdFields: ["refundTransactionId"],
      originalTransactionIdFields: ["originalTransactionId"],
      merchantReferenceFields: ["merchantReferenceCode"],
    },
  });
  try {
    const normalized = normalizeHelcimCardTransactionDetails({
      avsResponse: "Y",
      cvvResponse: "M",
      verification: { avsResponse: "N", cvvResponse: "N" },
      refundTransactionId: "refund-1",
      originalTransactionId: "purchase-1",
      transactionType: "refund",
    });
    assert.equal(normalized.avsCode, "N");
    assert.equal(normalized.cvvCode, "N");
    assert.equal(normalized.transactionId, "refund-1");
    assert.equal(
      normalizeHelcimCardTransactionDetails({
        avsResponse: "Y",
        cvvResponse: "M",
      }).avsCode,
      undefined,
    );
    const parsed = parseVerifiedHelcimWebhook(
      headers,
      JSON.stringify({
        eventType: "cardTransaction",
        data: {
          transactionType: "refund",
          refundTransactionId: "refund-2",
          originalTransactionId: "purchase-2",
          merchantReferenceCode: "refund/reservation-2",
          merchantReference: "uncertified-reference",
        },
      }),
    );
    assert.equal(parsed.helcimTransactionId, "refund-2");
    assert.equal(parsed.originalTransactionId, "purchase-2");
    assert.equal(parsed.merchantReference, "refund/reservation-2");
  } finally {
    if (previous === undefined)
      delete process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
    else process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON = previous;
  }
});

test("getHelcimWebhookHeaders returns null when required signature headers are missing", () => {
  const parsedHeaders = getHelcimWebhookHeaders(
    new Headers({ "webhook-id": "webhook_123" }),
  );

  assert.equal(parsedHeaders, null);
});

function createSignature(id: string, timestamp: string, body: string): string {
  return createHmac("sha256", Buffer.from(verifierToken, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
}
