import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentMockStore } from "../payment-mocks/in-memory-store";
import {
  buildMockHelcimSuccessPayload,
  buildMockHelcimWebhook,
  createMockHelcimGateway,
  signMockHelcimWebhook,
} from "./helcim-mock-gateway";
import { createHelcimResponseHash } from "./helcim-hash";
import { mergeHelcimCardTransactionDetails, parseVerifiedHelcimWebhook, verifyHelcimWebhookSignature } from "./helcim-webhook";
import { verifyHelcimPayment } from "./verified-payment";
import type { HelcimInvoiceRequest, HelcimPayInitializeRequest } from "./helcim-types";

const invoiceRequest: HelcimInvoiceRequest = {
  type: "INVOICE",
  status: "DUE",
  currency: "CAD",
  notes: "Lash Her website checkout",
  lineItems: [{ sku: "lash-kit", description: "Lash kit", quantity: 1, price: 125 }],
};

const initializeRequest = (invoiceNumber: string): HelcimPayInitializeRequest => ({
  paymentType: "purchase",
  amount: 125,
  currency: "CAD",
  invoiceNumber,
});

test("mock Helcim gateway creates deterministic invoice/session IDs without live fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("mock gateway must not call live Helcim");
  };

  try {
    const store = createPaymentMockStore({ now: new Date("2026-05-23T12:00:00.000Z") });
    const gateway = createMockHelcimGateway({ scenario: "success", store });

    const invoice = await gateway.createInvoice(invoiceRequest);
    const session = await gateway.initializePay(initializeRequest(invoice.invoiceNumber));

    assert.deepEqual(invoice, { invoiceId: 900001, invoiceNumber: "MOCK-INV-1" });
    assert.deepEqual(session, {
      checkoutToken: "mock_helcim_checkout_1",
      secretToken: "mock_helcim_secret_1",
    });
    assert.equal(store.providerOrders[0]?.provider, "helcim");
    assert.equal(store.providerOrders[0]?.status, "APPROVED");
    assert.equal(store.providerTransactions[0]?.transactionId, "mock_helcim_txn_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mock Helcim success payload validates through existing payment verification", async () => {
  const store = createPaymentMockStore({ now: new Date("2026-05-23T12:00:00.000Z") });
  const gateway = createMockHelcimGateway({ scenario: "success", store });
  const invoice = await gateway.createInvoice(invoiceRequest);
  const session = await gateway.initializePay(initializeRequest(invoice.invoiceNumber));
  const payload = buildMockHelcimSuccessPayload({ amount: 125, invoice, paySession: session });

  assert.deepEqual(payload.data, {
    amount: 125,
    approved: true,
    cardLast4: "4242",
    cardType: "Visa",
    currency: "CAD",
    invoiceId: 900001,
    invoiceNumber: "MOCK-INV-1",
    status: "APPROVED",
    transactionId: "mock_helcim_txn_1",
  });
  assert.equal(payload.hash, createHelcimResponseHash(payload.data, session.secretToken));
  assert.deepEqual(
    verifyHelcimPayment({
      data: payload.data,
      hash: payload.hash,
      order: {
        amount: 125,
        currency: "CAD",
        helcimInvoiceId: invoice.invoiceId,
        helcimInvoiceNumber: invoice.invoiceNumber,
      },
      secretToken: session.secretToken,
    }),
    { ok: true, transactionId: "mock_helcim_txn_1" },
  );
});

test("mock Helcim non-success scenarios keep provider status names and fail as unapproved", async () => {
  const expectedStatuses = {
    decline: "DECLINED",
    cancel: "CANCELLED",
    refund: "REFUNDED",
    refund_failed: "REFUND_FAILED",
  } as const;

  for (const [scenario, status] of Object.entries(expectedStatuses)) {
    const store = createPaymentMockStore({ now: new Date("2026-05-23T12:00:00.000Z") });
    const gateway = createMockHelcimGateway({ scenario: scenario as keyof typeof expectedStatuses, store });
    const invoice = await gateway.createInvoice(invoiceRequest);
    const session = await gateway.initializePay(initializeRequest(invoice.invoiceNumber));
    const payload = buildMockHelcimSuccessPayload({ amount: 125, invoice, paySession: session, scenario: scenario as keyof typeof expectedStatuses });

    assert.equal(payload.data.status, status);
    assert.equal(payload.data.approved, false);
    assert.deepEqual(
      verifyHelcimPayment({
        data: payload.data,
        hash: payload.hash,
        order: {
          amount: 125,
          currency: "CAD",
          helcimInvoiceId: invoice.invoiceId,
          helcimInvoiceNumber: invoice.invoiceNumber,
        },
        secretToken: session.secretToken,
      }),
      { ok: false, reason: "unapproved_payment" },
    );
  }
});

test("mock Helcim sparse webhook verifies signature and merges fetched transaction details", async () => {
  const now = new Date("2026-05-23T12:00:00.000Z");
  const verifierToken = Buffer.from("mock-webhook-secret").toString("base64");
  const store = createPaymentMockStore({ now });
  const gateway = createMockHelcimGateway({ scenario: "success", store });
  const invoice = await gateway.createInvoice(invoiceRequest);
  await gateway.initializePay(initializeRequest(invoice.invoiceNumber));
  const webhook = buildMockHelcimWebhook({ now, transactionId: "mock_helcim_txn_1" });
  const headers = signMockHelcimWebhook({ ...webhook, verifierToken });

  assert.equal(verifyHelcimWebhookSignature(headers, webhook.rawBody, verifierToken, now.getTime()), true);
  assert.equal(
    verifyHelcimWebhookSignature({ ...headers, signature: "invalid" }, webhook.rawBody, verifierToken, now.getTime()),
    false,
  );

  const sparseEvent = parseVerifiedHelcimWebhook(headers, webhook.rawBody);
  assert.deepEqual(sparseEvent, {
    amount: undefined,
    currency: undefined,
    eventId: "mock_helcim_event_mock_helcim_txn_1",
    eventType: "cardTransaction",
    helcimInvoiceId: undefined,
    helcimInvoiceNumber: undefined,
    helcimTransactionId: "mock_helcim_txn_1",
    status: undefined,
  });

  const merged = mergeHelcimCardTransactionDetails(
    sparseEvent,
    await gateway.getCardTransaction("mock_helcim_txn_1"),
  );

  assert.equal(merged.status, "APPROVED");
  assert.equal(merged.amount, 125);
  assert.equal(merged.currency, "CAD");
  assert.equal(merged.helcimInvoiceNumber, invoice.invoiceNumber);
  assert.equal(merged.cardLast4, "4242");
  const tokenField = ["card", "Token"].join("");
  const numberField = ["card", "Number"].join("");

  assert.equal(Object.hasOwn(merged.payloadRedacted ?? {}, tokenField), false);
  assert.equal(Object.hasOwn(merged.payloadRedacted ?? {}, numberField), false);
});

test("mock Helcim idempotency replays matching payloads inside five minutes", async () => {
  let current = new Date("2026-05-23T12:00:00.000Z");
  const store = createPaymentMockStore({ now: () => current });
  const gateway = createMockHelcimGateway({ idempotencyKey: "idem-1", scenario: "success", store });

  const first = await gateway.createInvoice(invoiceRequest);
  current = new Date("2026-05-23T12:04:59.000Z");
  const second = await gateway.createInvoice(invoiceRequest);

  assert.deepEqual(second, first);
  assert.equal(store.idempotencyRecords.length, 1);
  assert.equal(store.providerOrders.length, 1);
});

test("mock Helcim idempotency rejects changed payloads inside five minutes", async () => {
  let current = new Date("2026-05-23T12:00:00.000Z");
  const store = createPaymentMockStore({ now: () => current });
  const gateway = createMockHelcimGateway({ idempotencyKey: "idem-2", scenario: "success", store });

  const first = await gateway.createInvoice(invoiceRequest);
  current = new Date("2026-05-23T12:04:59.000Z");

  await assert.rejects(
    gateway.createInvoice({
      ...invoiceRequest,
      lineItems: [{ sku: "lash-kit", description: "Lash kit", quantity: 1, price: 130 }],
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as { status?: number }).status, 409);
      assert.equal((error as { code?: string }).code, "HELCIM_IDEMPOTENCY_MISMATCH");
      assert.match((error as Error).message, /idempotency/i);
      return true;
    },
  );

  assert.deepEqual(store.providerOrders.map((order) => order.orderId), [first.invoiceNumber]);
  assert.equal(store.idempotencyRecords.length, 1);
});

test("mock Helcim idempotency opens a new window at exactly five minutes", async () => {
  let current = new Date("2026-05-23T12:00:00.000Z");
  const store = createPaymentMockStore({ now: () => current });
  const gateway = createMockHelcimGateway({ idempotencyKey: "idem-3", scenario: "success", store });

  const first = await gateway.createInvoice(invoiceRequest);
  current = new Date("2026-05-23T12:05:00.000Z");
  const second = await gateway.createInvoice({
    ...invoiceRequest,
    lineItems: [{ sku: "lash-kit", description: "Lash kit", quantity: 1, price: 130 }],
  });

  assert.notDeepEqual(second, first);
  assert.deepEqual(second, { invoiceId: 900002, invoiceNumber: "MOCK-INV-2" });
  assert.equal(store.idempotencyRecords.length, 1);
  assert.equal(store.providerOrders.length, 2);
});


test("mock Helcim store reset clears hidden invoice, transaction, and idempotency state", async () => {
  let current = new Date("2026-05-23T12:00:00.000Z");
  const store = createPaymentMockStore({ now: () => current });
  const gateway = createMockHelcimGateway({ idempotencyKey: "idem-reset", scenario: "success", store });

  const invoice = await gateway.createInvoice(invoiceRequest);
  const session = await gateway.initializePay(initializeRequest(invoice.invoiceNumber));

  assert.deepEqual(invoice, { invoiceId: 900001, invoiceNumber: "MOCK-INV-1" });
  assert.deepEqual(session, {
    checkoutToken: "mock_helcim_checkout_1",
    secretToken: "mock_helcim_secret_1",
  });
  assert.equal((await gateway.getCardTransaction("mock_helcim_txn_1")).transactionId, "mock_helcim_txn_1");

  store.reset();
  current = new Date("2026-05-23T12:01:00.000Z");

  await assert.rejects(
    gateway.getCardTransaction("mock_helcim_txn_1"),
    /Mock Helcim card transaction not found/,
  );

  const changedRequest: HelcimInvoiceRequest = {
    ...invoiceRequest,
    lineItems: [{ sku: "lash-kit", description: "Lash kit", quantity: 1, price: 130 }],
  };
  const nextInvoice = await gateway.createInvoice(changedRequest);
  const nextSession = await gateway.initializePay(initializeRequest(nextInvoice.invoiceNumber));

  assert.deepEqual(nextInvoice, { invoiceId: 900001, invoiceNumber: "MOCK-INV-1" });
  assert.deepEqual(nextSession, {
    checkoutToken: "mock_helcim_checkout_1",
    secretToken: "mock_helcim_secret_1",
  });
  assert.equal(store.providerOrders.length, 1);
  assert.equal(store.providerTransactions.length, 1);
  assert.equal(store.idempotencyRecords.length, 1);
});
