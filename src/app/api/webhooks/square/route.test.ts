import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createSquareWebhookPostHandler,
  defaultDependencies,
  loadTrainingSquareInvoiceFinalizer,
} from "./route";
import type { CheckoutOrderRow } from "@/lib/commerce/order-store";

const webhookUrl = "https://example.com/api/webhooks/square";
const signatureKey = "square-signature-key";
type SquareWebhookDependencies = Parameters<typeof createSquareWebhookPostHandler>[0];

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

function createHandler(
  finalizerCalls: unknown[],
  overrides: Partial<SquareWebhookDependencies> = {},
) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({
      serviceBookingWebhookUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    finalizeSquarePayment: async (input) => {
      finalizerCalls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid_calendar_pending" };
    },
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    findOrderBySquareInvoiceId: async () => null,
    ...overrides,
  });
}

function createSquareInvoiceWebhookPayload(input: {
  eventId: string;
  eventType: string;
  invoiceId: string;
  orderId?: string;
  paymentId?: string;
}) {
  return {
    event_id: input.eventId,
    type: input.eventType,
    data: {
      id: input.invoiceId,
      object: {
        invoice: { id: input.invoiceId },
        ...(input.paymentId || input.orderId
          ? {
              payment: {
                ...(input.paymentId ? { id: input.paymentId } : {}),
                ...(input.orderId ? { order_id: input.orderId } : {}),
              },
            }
          : {}),
      },
      type: "invoice",
    },
  };
}

function createTrainingSquareInvoiceOrder(overrides: Partial<CheckoutOrderRow> = {}): CheckoutOrderRow {
  return {
    id: "checkout-row-123",
    orderId: "lh-training-123",
    paymentProvider: "square",
    providerCheckoutId: "square-invoice-123",
    providerMetadata: { flow: "training_square_invoice" },
    purpose: "training",
    ...overrides,
  } as CheckoutOrderRow;
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
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async (input) => {
      calls.push(input);
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    },
    finalizeTrainingSquareInvoicePayment: async () => ({ duplicateEvent: false, finalized: true, status: "paid" }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
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
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async () => {
      throw new Error("TEMPORARY_ERROR");
    },
    finalizeTrainingSquareInvoicePayment: async () => ({ duplicateEvent: false, finalized: true, status: "paid" }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
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
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async (input) => {
      calls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid_calendar_pending" };
    },
    finalizeTrainingSquareInvoicePayment: async () => ({ duplicateEvent: false, finalized: true, status: "paid" }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
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

test("Square webhook dispatches signed paid training invoice events to the training finalizer", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const trainingFinalizerCalls: unknown[] = [];
  const invoiceLookups: string[] = [];
  const claimedEvents: unknown[] = [];
  const processedEvents: unknown[] = [];
  const trainingOrder = createTrainingSquareInvoiceOrder();
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async (invoiceId) => {
      invoiceLookups.push(invoiceId);
      return trainingOrder;
    },
    claimSquareInvoiceWebhookEvent: async (input) => {
      claimedEvents.push(input);
      return { duplicate: false };
    },
    finalizeTrainingSquareInvoicePayment: async (input) => {
      trainingFinalizerCalls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid" };
    },
    recordSquareInvoiceWebhookEventProcessed: async (input) => {
      processedEvents.push(input);
    },
  });
  const payload = createSquareInvoiceWebhookPayload({
    eventId: "evt_training_paid",
    eventType: "invoice.payment_made",
    invoiceId: "square-invoice-123",
    orderId: "square-order-123",
    paymentId: "square-payment-123",
  });
  const response = await handler(createSignedRequest(JSON.stringify(payload)));

  assert.equal(response.status, 200);
  assert.deepEqual(invoiceLookups, ["square-invoice-123"]);
  assert.deepEqual(claimedEvents, [{
    eventId: "evt_training_paid",
    eventType: "invoice.payment_made",
    orderDatabaseId: "checkout-row-123",
    payloadSanitized: payload,
    providerCheckoutId: "square-invoice-123",
    providerOrderId: "square-order-123",
    providerPaymentId: "square-payment-123",
    status: "received",
  }]);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(trainingFinalizerCalls.length, 1);
  assert.deepEqual(processedEvents, [{
    eventId: "evt_training_paid",
    eventType: "invoice.payment_made",
    orderDatabaseId: "checkout-row-123",
    payloadSanitized: payload,
    providerCheckoutId: "square-invoice-123",
    providerOrderId: "square-order-123",
    providerPaymentId: "square-payment-123",
    status: "processed",
  }]);
  assert.deepEqual(trainingFinalizerCalls[0], {
    event: {
      eventId: "evt_training_paid",
      eventType: "invoice.payment_made",
      orderId: "square-order-123",
      paymentId: "square-payment-123",
      payloadSanitized: payload,
    },
    order: trainingOrder,
    source: "webhook",
    squareInvoiceId: "square-invoice-123",
  });
});

test("Square webhook skips processed duplicate paid training invoice events", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const trainingFinalizerCalls: unknown[] = [];
  const processedEvents: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => createTrainingSquareInvoiceOrder(),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: true, processingStatus: "processed" }),
    finalizeTrainingSquareInvoicePayment: async (input) => {
      trainingFinalizerCalls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid" };
    },
    recordSquareInvoiceWebhookEventProcessed: async (input) => {
      processedEvents.push(input);
    },
  });
  const response = await handler(createSignedRequest(JSON.stringify(createSquareInvoiceWebhookPayload({
    eventId: "evt_training_processed_duplicate",
    eventType: "invoice.payment_made",
    invoiceId: "square-invoice-123",
    orderId: "square-order-123",
    paymentId: "square-payment-123",
  }))));

  assert.equal(response.status, 200);
  assert.equal(trainingFinalizerCalls.length, 0);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(processedEvents.length, 0);
});

test("Square webhook default dependencies load the training invoice finalizer export dynamically", async () => {
  const dynamicFinalizer = await loadTrainingSquareInvoiceFinalizer();

  assert.equal(typeof defaultDependencies.finalizeTrainingSquareInvoicePayment, "function");
  assert.equal(typeof dynamicFinalizer, "function");
});

test("Square webhook does not dispatch published invoice events to training enrollment", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const trainingFinalizerCalls: unknown[] = [];
  const invoiceLookups: string[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async (invoiceId) => {
      invoiceLookups.push(invoiceId);
      return createTrainingSquareInvoiceOrder();
    },
    finalizeTrainingSquareInvoicePayment: async (input) => {
      trainingFinalizerCalls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid" };
    },
  });
  const payload = createSquareInvoiceWebhookPayload({
    eventId: "evt_training_published",
    eventType: "invoice.published",
    invoiceId: "square-invoice-123",
  });
  const response = await handler(createSignedRequest(JSON.stringify(payload)));

  assert.equal(response.status, 200);
  assert.equal(trainingFinalizerCalls.length, 0);
  assert.equal(invoiceLookups.length, 0);
  assert.equal(bookingFinalizerCalls.length, 1);
});

test("Square webhook returns success for duplicate paid training invoice finalizer results", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const trainingFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => createTrainingSquareInvoiceOrder(),
    finalizeTrainingSquareInvoicePayment: async (input) => {
      trainingFinalizerCalls.push(input);
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    },
  });
  const response = await handler(createSignedRequest(JSON.stringify(createSquareInvoiceWebhookPayload({
    eventId: "evt_training_duplicate_paid",
    eventType: "invoice.payment_made",
    invoiceId: "square-invoice-123",
    orderId: "square-order-123",
    paymentId: "square-payment-123",
  }))));

  assert.equal(response.status, 200);
  assert.equal(trainingFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook asks Square to retry after training invoice finalizer errors", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => createTrainingSquareInvoiceOrder(),
    finalizeTrainingSquareInvoicePayment: async () => {
      throw new Error("TRAINING_FINALIZATION_RETRY");
    },
  });
  const response = await handler(createSignedRequest(JSON.stringify(createSquareInvoiceWebhookPayload({
    eventId: "evt_training_retry",
    eventType: "invoice.payment_made",
    invoiceId: "square-invoice-123",
    orderId: "square-order-123",
    paymentId: "square-payment-123",
  }))));

  assert.equal(response.status, 503);
  assert.equal(bookingFinalizerCalls.length, 0);
});
