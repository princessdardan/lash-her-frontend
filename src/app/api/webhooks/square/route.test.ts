import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createSquareWebhookPostHandler,
  defaultDependencies,
  loadTrainingSquareInvoiceFinalizer,
  resolveSquareWebhookEnv,
} from "./route";
import { createServicePaymentAlertLogger } from "@/lib/booking/payments/service-payment-alerts";
import type { CheckoutOrderRow } from "@/lib/commerce/order-store";

const webhookUrl = "https://example.com/api/webhooks/square";
const signatureKey = "square-signature-key";
type SquareWebhookDependencies = Parameters<
  typeof createSquareWebhookPostHandler
>[0];

function createSignedRequest(
  rawBody: string,
  signatureOverride?: string,
): Request {
  const signature =
    signatureOverride ??
    createHmac("sha256", signatureKey)
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
  const alertCalls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    finalizeSquarePayment: async (input) => {
      finalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        status: "paid_calendar_pending",
      };
    },
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    findOrderBySquareInvoiceId: async () => null,
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
    isKnownNoShowChargeEvent: async () => true,
    alerts: createServicePaymentAlertLogger({
      logWarn: (...args: unknown[]) => alertCalls.push(args),
      logError: (...args: unknown[]) => alertCalls.push(args),
    }),
    ...overrides,
  });

  return Object.assign(handler, { alertCalls });
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

function createTrainingSquareInvoiceOrder(
  overrides: Partial<CheckoutOrderRow> = {},
): CheckoutOrderRow {
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
  const response = await handler(
    createSignedRequest("not json", "invalid-signature"),
  );

  assert.equal(response.status, 401);
  assert.equal(finalizerCalls.length, 0);
});

test("Square webhook accepts valid signature and calls shared finalizer", async () => {
  const finalizerCalls: unknown[] = [];
  const handler = createHandler(finalizerCalls);
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_123",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      }),
    ),
  );

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
    getEnv: () => ({
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async (input) => {
      calls.push(input);
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    },
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
    alerts: createServicePaymentAlertLogger({
      logWarn: () => undefined,
      logError: () => undefined,
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_duplicate",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("Square webhook asks Square to retry after temporary finalization errors", async () => {
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async () => {
      throw new Error("TEMPORARY_ERROR");
    },
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    alerts: createServicePaymentAlertLogger({
      logWarn: () => undefined,
      logError: () => undefined,
    }),
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_retry",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      }),
    ),
  );

  assert.equal(response.status, 503);
});

test("Square webhook alerts and accepts events when service finalizer returns pending verification", async () => {
  const alertCalls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async () => ({
      duplicateEvent: false,
      finalized: false,
      status: "pending_verification",
    }),
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
    alerts: createServicePaymentAlertLogger({
      logWarn: (...args: unknown[]) => alertCalls.push(args),
      logError: (...args: unknown[]) => alertCalls.push(args),
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_pending",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(alertCalls.length, 1);
  assert.equal(
    (alertCalls[0] as unknown[])[0],
    "[service-payment-alert] Square webhook did not finalize service booking",
  );
  const payload = (alertCalls[0] as unknown[])[1] as {
    category: string;
    severity: string;
  };
  assert.equal(payload.category, "square_webhook_non_finalized");
  assert.equal(payload.severity, "warning");
});

test("Square webhook alerts and accepts events when service finalizer returns ignored", async () => {
  const alertCalls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async () => ({
      duplicateEvent: false,
      finalized: false,
      reason: "Square payment could not be resolved",
      status: "ignored",
    }),
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
    alerts: createServicePaymentAlertLogger({
      logWarn: (...args: unknown[]) => alertCalls.push(args),
      logError: (...args: unknown[]) => alertCalls.push(args),
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_ignored",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(alertCalls.length, 1);
  assert.equal(
    (alertCalls[0] as unknown[])[0],
    "[service-payment-alert] Square webhook did not finalize service booking",
  );
  const payload = (alertCalls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "square_webhook_non_finalized");
  assert.equal(payload.severity, "warning");
  assert.equal(payload.context.reason, "Square payment could not be resolved");
});

test("Square webhook alerts and retries when service finalizer throws", async () => {
  const alertCalls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async () => {
      throw new Error("FINALIZER_THROWN");
    },
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
    alerts: createServicePaymentAlertLogger({
      logWarn: (...args: unknown[]) => alertCalls.push(args),
      logError: (...args: unknown[]) => alertCalls.push(args),
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_throw",
        type: "payment.updated",
        data: { object: { payment: { id: "pay_123", order_id: "order_123" } } },
      }),
    ),
  );

  assert.equal(response.status, 503);
  assert.equal(alertCalls.length, 1);
  assert.equal(
    (alertCalls[0] as unknown[])[0],
    "[service-payment-alert] Square webhook did not finalize service booking",
  );
  const payload = (alertCalls[0] as unknown[])[1] as {
    category: string;
    severity: string;
  };
  assert.equal(payload.category, "square_webhook_retryable_failure");
  assert.equal(payload.severity, "error");
});

test("Square webhook accepts generated mock signatures in mock env and rejects invalid signatures", async () => {
  const rawBody = JSON.stringify({
    event_id: "evt_mock",
    type: "payment.updated",
    data: {
      object: {
        payment: {
          id: "mock-square-payment-1",
          order_id: "mock-square-order-1",
        },
      },
    },
  });
  const calls: unknown[] = [];
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({
      notificationUrl: "http://localhost:3000/api/webhooks/square",
      webhookSignatureKey: "mock-square-webhook-signature-key",
    }),
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeSquarePayment: async (input) => {
      calls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        status: "paid_calendar_pending",
      };
    },
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: true,
      status: "paid",
    }),
    findOrderBySquareInvoiceId: async () => null,
    recordSquareInvoiceWebhookEventProcessed: async () => undefined,
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
    alerts: createServicePaymentAlertLogger({
      logWarn: () => undefined,
      logError: () => undefined,
    }),
  });
  const signature = createHmac("sha256", "mock-square-webhook-signature-key")
    .update(`http://localhost:3000/api/webhooks/square${rawBody}`, "utf8")
    .digest("base64");

  const accepted = await handler(
    new Request("http://localhost:3000/api/webhooks/square", {
      method: "POST",
      body: rawBody,
      headers: { "x-square-hmacsha256-signature": signature },
    }),
  );
  const rejected = await handler(
    new Request("http://localhost:3000/api/webhooks/square", {
      method: "POST",
      body: rawBody,
      headers: { "x-square-hmacsha256-signature": "invalid" },
    }),
  );

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
  assert.deepEqual(claimedEvents, [
    {
      eventId: "evt_training_paid",
      eventType: "invoice.payment_made",
      orderDatabaseId: "checkout-row-123",
      payloadSanitized: payload,
      providerCheckoutId: "square-invoice-123",
      providerOrderId: "square-order-123",
      providerPaymentId: "square-payment-123",
      status: "received",
    },
  ]);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(trainingFinalizerCalls.length, 1);
  assert.deepEqual(processedEvents, [
    {
      eventId: "evt_training_paid",
      eventType: "invoice.payment_made",
      orderDatabaseId: "checkout-row-123",
      payloadSanitized: payload,
      providerCheckoutId: "square-invoice-123",
      providerOrderId: "square-order-123",
      providerPaymentId: "square-payment-123",
      status: "processed",
    },
  ]);
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

test("Square webhook recovers processed duplicate paid training invoice events", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const trainingFinalizerCalls: unknown[] = [];
  const processedEvents: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => createTrainingSquareInvoiceOrder(),
    claimSquareInvoiceWebhookEvent: async () => ({
      duplicate: true,
      processingStatus: "processed",
    }),
    finalizeTrainingSquareInvoicePayment: async (input) => {
      trainingFinalizerCalls.push(input);
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    },
    recordSquareInvoiceWebhookEventProcessed: async (input) => {
      processedEvents.push(input);
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_training_processed_duplicate",
          eventType: "invoice.payment_made",
          invoiceId: "square-invoice-123",
          orderId: "square-order-123",
          paymentId: "square-payment-123",
        }),
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(trainingFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(processedEvents.length, 1);
});

test("Square webhook asks Square to retry processed duplicate training invoice notification failures", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const processedEvents: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => createTrainingSquareInvoiceOrder(),
    claimSquareInvoiceWebhookEvent: async () => ({
      duplicate: true,
      processingStatus: "processed",
    }),
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: true,
      finalized: false,
      notificationFailed: true,
      status: "customer: Customer training email failed",
    }),
    recordSquareInvoiceWebhookEventProcessed: async (input) => {
      processedEvents.push(input);
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_training_processed_duplicate_email_retry",
          eventType: "invoice.payment_made",
          invoiceId: "square-invoice-123",
          orderId: "square-order-123",
          paymentId: "square-payment-123",
        }),
      ),
    ),
  );

  assert.equal(response.status, 503);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(processedEvents.length, 0);
});

test("Square webhook acknowledges unknown paid invoice events without service-booking fallback", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const claimedEvents: unknown[] = [];
  const trainingFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => null,
    claimSquareInvoiceWebhookEvent: async (input) => {
      claimedEvents.push(input);
      return { duplicate: false };
    },
    finalizeTrainingSquareInvoicePayment: async (input) => {
      trainingFinalizerCalls.push(input);
      return { duplicateEvent: false, finalized: true, status: "paid" };
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_training_unknown_invoice",
          eventType: "invoice.payment_made",
          invoiceId: "unknown-square-invoice",
          orderId: "unknown-square-order",
          paymentId: "unknown-square-payment",
        }),
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(trainingFinalizerCalls.length, 0);
  assert.equal(claimedEvents.length, 0);
});

test("Square webhook env resolver accepts training invoice webhooks without service booking enabled", () => {
  const env = resolveSquareWebhookEnv({
    serviceBookingEnv: null,
    trainingInvoiceWebhookEnv: {
      notificationUrl: webhookUrl,
      webhookSignatureKey: signatureKey,
    },
  });

  assert.deepEqual(env, {
    notificationUrl: webhookUrl,
    serviceBookingEnabled: false,
    webhookSignatureKey: signatureKey,
  });
});

test("Square webhook default dependencies load the training invoice finalizer export dynamically", async () => {
  const dynamicFinalizer = await loadTrainingSquareInvoiceFinalizer();

  assert.equal(
    typeof defaultDependencies.finalizeTrainingSquareInvoicePayment,
    "function",
  );
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
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_training_duplicate_paid",
          eventType: "invoice.payment_made",
          invoiceId: "square-invoice-123",
          orderId: "square-order-123",
          paymentId: "square-payment-123",
        }),
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(trainingFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook asks Square to retry non-finalized paid training invoice results", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const processedEvents: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => createTrainingSquareInvoiceOrder(),
    finalizeTrainingSquareInvoicePayment: async () => ({
      duplicateEvent: false,
      finalized: false,
      status: "Training scheduling token could not be issued",
    }),
    recordSquareInvoiceWebhookEventProcessed: async (input) => {
      processedEvents.push(input);
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_training_not_finalized_retry",
          eventType: "invoice.payment_made",
          invoiceId: "square-invoice-123",
          orderId: "square-order-123",
          paymentId: "square-payment-123",
        }),
      ),
    ),
  );

  assert.equal(response.status, 503);
  assert.equal(processedEvents.length, 0);
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
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_training_retry",
          eventType: "invoice.payment_made",
          invoiceId: "square-invoice-123",
          orderId: "square-order-123",
          paymentId: "square-payment-123",
        }),
      ),
    ),
  );

  assert.equal(response.status, 503);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook dispatches paid invoice events to no-show finalizer when invoice is linked to a no-show charge record", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const noShowFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    findOrderBySquareInvoiceId: async () => null,
    finalizeNoShowCharge: async (input) => {
      noShowFinalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        noShowChargeRecordId: "noshow-record-1",
        retryable: false,
        status: "charged",
      };
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_noshow_invoice_paid",
          eventType: "invoice.payment_made",
          invoiceId: "square-invoice-noshow",
          orderId: "square-order-noshow",
          paymentId: "square-payment-noshow",
        }),
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(noShowFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook dispatches payment events to no-show finalizer before legacy service finalizer", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const noShowFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async (input) => {
      noShowFinalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        noShowChargeRecordId: "noshow-record-1",
        retryable: false,
        status: "charged",
      };
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_noshow_payment",
        type: "payment.updated",
        data: {
          object: {
            payment: { id: "sq-payment-noshow", order_id: "sq-order-noshow" },
          },
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(noShowFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook returns success when no-show finalizer reports a failed charge", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const noShowFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async (input) => {
      noShowFinalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        noShowChargeRecordId: "noshow-record-1",
        retryable: false,
        status: "charge_failed",
      };
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_noshow_payment_failed",
        type: "payment.updated",
        data: {
          object: {
            payment: { id: "sq-payment-noshow", order_id: "sq-order-noshow" },
          },
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(noShowFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook retries when no-show finalizer throws", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const alertCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async () => {
      throw new Error("NOSHOW_LOOKUP_FAILED");
    },
    alerts: createServicePaymentAlertLogger({
      logWarn: (...args: unknown[]) => alertCalls.push(args),
      logError: (...args: unknown[]) => alertCalls.push(args),
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_noshow_retry",
        type: "payment.updated",
        data: {
          object: {
            payment: { id: "sq-payment-noshow", order_id: "sq-order-noshow" },
          },
        },
      }),
    ),
  );

  assert.equal(response.status, 503);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(alertCalls.length, 1);
  const payload = (alertCalls[0] as unknown[])[1] as {
    category: string;
    severity: string;
  };
  assert.equal(payload.category, "square_webhook_retryable_failure");
  assert.equal(payload.severity, "error");
});

test("Square webhook skips no-show finalizer for unrelated payment events without alerting", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const noShowFinalizerCalls: unknown[] = [];
  const isKnownCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async (input) => {
      noShowFinalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: false,
        retryable: false,
        status: "ignored",
      };
    },
    isKnownNoShowChargeEvent: async (event) => {
      isKnownCalls.push(event);
      return false;
    },
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_unrelated_payment",
        type: "payment.updated",
        data: {
          object: {
            payment: {
              id: "sq-payment-unrelated",
              order_id: "sq-order-unrelated",
            },
          },
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(isKnownCalls.length, 1);
  assert.equal(noShowFinalizerCalls.length, 0);
  assert.equal(bookingFinalizerCalls.length, 1);
  assert.equal(handler.alertCalls.length, 0);
});

test("Square webhook skips no-show finalizer for unknown invoice payment events without alerting", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const noShowFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async (input) => {
      noShowFinalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        noShowChargeRecordId: "nsr-1",
        retryable: false,
        status: "charged",
      };
    },
    isKnownNoShowChargeEvent: async () => false,
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify(
        createSquareInvoiceWebhookPayload({
          eventId: "evt_unknown_invoice",
          eventType: "invoice.payment_made",
          invoiceId: "unrelated-invoice",
          orderId: "unrelated-order",
          paymentId: "unrelated-payment",
        }),
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(noShowFinalizerCalls.length, 0);
  assert.equal(bookingFinalizerCalls.length, 0);
  assert.equal(handler.alertCalls.length, 0);
});

test("Square webhook dispatches known no-show payment events to no-show finalizer", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const noShowFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async (input) => {
      noShowFinalizerCalls.push(input);
      return {
        duplicateEvent: false,
        finalized: true,
        noShowChargeRecordId: "nsr-known",
        retryable: false,
        status: "charged",
      };
    },
    isKnownNoShowChargeEvent: async () => true,
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_known_payment",
        type: "payment.updated",
        data: {
          object: {
            payment: { id: "sq-payment-known", order_id: "sq-order-known" },
          },
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(noShowFinalizerCalls.length, 1);
  assert.equal(bookingFinalizerCalls.length, 0);
});

test("Square webhook falls back to legacy service finalizer when no-show finalizer returns ignored", async () => {
  const bookingFinalizerCalls: unknown[] = [];
  const handler = createHandler(bookingFinalizerCalls, {
    finalizeNoShowCharge: async () => ({
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    }),
  });
  const response = await handler(
    createSignedRequest(
      JSON.stringify({
        event_id: "evt_noshow_ignored",
        type: "payment.updated",
        data: {
          object: {
            payment: { id: "sq-payment-unknown", order_id: "sq-order-unknown" },
          },
        },
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(bookingFinalizerCalls.length, 1);
});
