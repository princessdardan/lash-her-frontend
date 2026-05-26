import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPaymentMockScenario,
  isPaymentMockScenario,
  paymentMockScenarios,
  parsePaymentMockScenario,
  type PaymentMockScenario,
} from "./scenarios";
import { createPaymentMockStore } from "./in-memory-store";
import {
  createMockSquareInvoice,
  createMockSquareInvoiceLifecycle,
  createSquareInvoicePaymentMadeWebhookPayload,
  createSquareInvoicePublishedWebhookPayload,
  createSquareInvoiceUpdatedWebhookPayload,
} from "./square-invoices";

test("shared payment mock scenarios include the exact supported union", () => {
  const expected = [
    "success",
    "decline",
    "cancel",
    "refund",
    "refund_failed",
    "webhook",
    "duplicate_webhook",
    "temporary_error",
    "delayed_capture",
    "idempotency_mismatch",
    "idempotency_expired",
    "square_invoice_success",
    "square_invoice_afterpay_unavailable",
    "square_invoice_publish_failed",
    "square_invoice_unpaid",
    "square_invoice_paid_mismatch",
    "square_invoice_duplicate_paid",
    "square_invoice_finalization_retry",
  ] as const satisfies readonly PaymentMockScenario[];

  assert.deepEqual(paymentMockScenarios, expected);
});

test("scenario parsing only accepts supported values", () => {
  for (const scenario of paymentMockScenarios) {
    assert.equal(isPaymentMockScenario(scenario), true);
    assert.equal(parsePaymentMockScenario(scenario), scenario);
  }

  assert.equal(isPaymentMockScenario("unsupported"), false);
  assert.equal(parsePaymentMockScenario("unsupported"), null);
  assert.equal(parsePaymentMockScenario(undefined), null);
  assert.equal(parsePaymentMockScenario(null), null);
});

test("Square invoice scenarios produce deterministic records and Square-shaped webhooks", () => {
  const store = createPaymentMockStore({ now: new Date("2026-05-24T15:30:00.000Z") });

  const invoice = createMockSquareInvoice({
    amountCents: 12500,
    customerId: "customer-1",
    idempotencyKey: "invoice-key-1",
    orderId: "order-1",
    request: mockRequest(),
    scenario: "square_invoice_success",
    store,
  });

  assert.equal(invoice.invoice.id, "mock-square-invoice-1");
  assert.equal(invoice.invoice.order_id, "mock-square-invoice-order-1");
  assert.equal(invoice.invoice.primary_recipient.customer_id, "customer-1");
  assert.equal(invoice.invoice.public_url, "http://localhost:3000/mock-square/invoices/mock-square-invoice-1");
  assert.equal(store.getSquareInvoiceRecord("mock-square-invoice-1")?.version, 1);

  const paymentMade = createSquareInvoicePaymentMadeWebhookPayload({
    amountCents: 12500,
    invoiceId: invoice.invoice.id,
    orderId: invoice.invoice.order_id,
    paymentId: "payment-1",
    store,
  });
  const published = createSquareInvoicePublishedWebhookPayload({ invoiceId: invoice.invoice.id, store });
  const updated = createSquareInvoiceUpdatedWebhookPayload({ invoiceId: invoice.invoice.id, status: "PAID", store });

  assert.equal(paymentMade.type, "invoice.payment_made");
  assert.equal(paymentMade.data.object.invoice.id, invoice.invoice.id);
  assert.ok(paymentMade.data.object.payment);
  assert.equal(paymentMade.data.object.payment.amount_money.amount, 12500);
  assert.equal(published.type, "invoice.published");
  assert.equal(updated.type, "invoice.updated");
  assert.equal(store.squareInvoiceWebhookRecords.length, 3);
});

test("Square invoice lifecycle scenarios expose deterministic outcomes", () => {
  const scenarios = [
    ["square_invoice_success", "PAID", "invoice.payment_made", 12500, false],
    ["square_invoice_afterpay_unavailable", "PAYMENT_METHOD_UNAVAILABLE", "invoice.updated", 12500, false],
    ["square_invoice_publish_failed", "PUBLISH_FAILED", "invoice.updated", 12500, false],
    ["square_invoice_unpaid", "UNPAID", "invoice.updated", 12500, false],
    ["square_invoice_paid_mismatch", "PAID", "invoice.payment_made", 12499, false],
    ["square_invoice_duplicate_paid", "PAID", "invoice.payment_made", 12500, true],
    ["square_invoice_finalization_retry", "PAID", "invoice.payment_made", 12500, false],
  ] as const;

  for (const [scenario, status, eventType, expectedAmount, duplicatePaidWebhook] of scenarios) {
    const store = createPaymentMockStore({ now: new Date("2026-05-24T15:30:00.000Z") });
    const result = createMockSquareInvoiceLifecycle({
      amountCents: 12500,
      customerId: `customer-${scenario}`,
      idempotencyKey: `key-${scenario}`,
      orderId: `order-${scenario}`,
      request: mockRequest({ scenario }),
      scenario,
      store,
    });

    assert.equal(result.invoice.id, "mock-square-invoice-1");
    assert.equal(result.invoice.status, status);
    assert.equal(result.webhookPayload.type, eventType);
    assert.equal(result.webhookPayload.data.object.invoice.id, result.invoice.id);
    assert.equal(result.paymentAmountCents, expectedAmount);
    assert.equal(result.duplicatePaidWebhook, duplicatePaidWebhook);
    assert.equal(assertPaymentMockScenario(scenario), scenario);
  }
});

test("Square invoice helpers reuse mock-mode production guard", () => {
  const store = createPaymentMockStore();

  assert.throws(() => createMockSquareInvoice({
    amountCents: 12500,
    customerId: "customer-1",
    env: { NODE_ENV: "production", PAYMENT_GATEWAY_MODE: "mock" },
    idempotencyKey: "invoice-key-1",
    orderId: "order-1",
    request: mockRequest(),
    scenario: "square_invoice_success",
    store,
  }), /Payment mock mode is not allowed in production/);
});

function mockRequest(options: { scenario?: string } = {}): Request {
  const url = new URL("http://localhost:3000/api/mock-square/invoices");
  if (options.scenario) {
    url.searchParams.set("mockPaymentScenario", options.scenario);
  }

  return new Request(url);
}
