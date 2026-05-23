import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";

import { createMockSquareClient } from "./square-mock-client";
import type { SquareCreatePaymentLinkRequest } from "./square-client";

const now = new Date("2026-05-23T12:00:00.000Z");

function createPaymentLinkRequest(overrides: Partial<SquareCreatePaymentLinkRequest> = {}): SquareCreatePaymentLinkRequest {
  return {
    checkout_options: {
      allow_tipping: true,
      redirect_url: "https://lashher.test/api/booking/square/return",
    },
    idempotency_key: "sq-idempotency-1",
    order: {
      location_id: "LOC123",
      line_items: [
        {
          name: "Classic Fill deposit",
          quantity: "1",
          base_price_money: { amount: 5000, currency: "CAD" },
          note: "Lash Her BOOKING-DEPOSIT",
        },
      ],
      metadata: {
        lh_hold_id: "hold-internal-1",
        lh_hold_reference: "hold_public_1",
        lh_order_id: "lh-sq-local-1",
      },
      reference_id: "lh-sq-local-1",
    },
    payment_note: "Lash Her booking hold hold_public_1 order lh-sq-local-1",
    ...overrides,
  };
}

test("mock Square client creates provider-shaped local payment links", async () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "success", store });

  const response = await client.createPaymentLink(createPaymentLinkRequest());

  assert.deepEqual(response.payment_link, {
    id: "mock-square-payment-link-1",
    order_id: "mock-square-order-1",
    url: "http://localhost:3000/api/booking/square/return?orderId=lh-sq-local-1&paymentId=mock-square-payment-1",
  });
  assert.equal(store.providerOrders[0]?.orderId, "mock-square-order-1");
  assert.equal(store.providerTransactions[0]?.transactionId, "mock-square-payment-1");
});

test("mock Square clients sharing a store resolve checkout payments across route lifecycles", async () => {
  const store = createPaymentMockStore({ now });
  const checkoutClient = createMockSquareClient({ scenario: "success", store });
  const finalizerClient = createMockSquareClient({ scenario: "success", store });

  await checkoutClient.createPaymentLink(createPaymentLinkRequest());
  const payment = await finalizerClient.getPayment("mock-square-payment-1");

  assert.equal(payment.payment.id, "mock-square-payment-1");
  assert.equal(payment.payment.order_id, "mock-square-order-1");
  assert.equal(payment.payment.status, "COMPLETED");
  assert.equal(payment.payment.amount_money?.amount, 5000);
});

test("mock Square client reuses the same idempotency key for the same payload", async () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "success", store });
  const request = createPaymentLinkRequest();

  const first = await client.createPaymentLink(request);
  const second = await client.createPaymentLink(request);

  assert.deepEqual(second, first);
  assert.equal(store.idempotencyRecords.length, 1);
  assert.equal(store.providerOrders.length, 1);
  assert.equal(store.providerTransactions.length, 1);
});

test("mock Square client deduplicates concurrent idempotency key reuse across clients", async () => {
  const store = createPaymentMockStore({ now });
  const firstClient = createMockSquareClient({ scenario: "success", store });
  const secondClient = createMockSquareClient({ scenario: "success", store });
  const request = createPaymentLinkRequest();

  const [first, second] = await Promise.all([
    firstClient.createPaymentLink(request),
    secondClient.createPaymentLink(request),
  ]);

  assert.deepEqual(second, first);
  assert.equal(store.idempotencyRecords.length, 1);
  assert.equal(store.providerOrders.length, 1);
  assert.equal(store.providerTransactions.length, 1);
});

test("mock Square client rejects changed payloads for a reused idempotency key", async () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "success", store });

  await client.createPaymentLink(createPaymentLinkRequest());

  await assert.rejects(
    () => client.createPaymentLink(createPaymentLinkRequest({ payment_note: "changed note" })),
    /Square idempotency key sq-idempotency-1 was reused with a different payload/,
  );
});

test("mock Square temporary error fails the first payment lookup and succeeds on retry", async () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "temporary_error", store });

  await client.createPaymentLink(createPaymentLinkRequest());

  await assert.rejects(
    () => client.getPayment("mock-square-payment-1"),
    (error) => error instanceof Error && error.message === "TEMPORARY_ERROR" && Reflect.get(error, "retryable") === true,
  );
  const payment = await client.getPayment("mock-square-payment-1");

  assert.equal(payment.payment.status, "COMPLETED");
});

test("mock Square delayed capture returns Square APPROVED provider status", async () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "delayed_capture", store });

  await client.createPaymentLink(createPaymentLinkRequest());
  const payment = await client.getPayment("mock-square-payment-1");

  assert.equal(payment.payment.status, "APPROVED");
  assert.equal(payment.payment.amount_money?.amount, 5000);
  assert.equal(payment.payment.amount_money?.currency, "CAD");
});

test("mock Square paid scenarios return completed payments", async () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "webhook", store });

  await client.createPaymentLink(createPaymentLinkRequest());
  const payment = await client.getPayment("mock-square-payment-1");

  assert.equal(payment.payment.status, "COMPLETED");
});

test("mock Square decline and cancel scenarios return unpaid provider states", async () => {
  const declineStore = createPaymentMockStore({ now });
  const cancelStore = createPaymentMockStore({ now });
  const declineClient = createMockSquareClient({ scenario: "decline", store: declineStore });
  const cancelClient = createMockSquareClient({ scenario: "cancel", store: cancelStore });

  await declineClient.createPaymentLink(createPaymentLinkRequest());
  await cancelClient.createPaymentLink(createPaymentLinkRequest());

  assert.equal((await declineClient.getPayment("mock-square-payment-1")).payment.status, "FAILED");
  assert.equal((await cancelClient.getPayment("mock-square-payment-1")).payment.status, "CANCELED");
});

test("mock Square refund helper returns provider-shaped success and raw failure codes", async () => {
  const successStore = createPaymentMockStore({ now });
  const failedStore = createPaymentMockStore({ now });
  const incompleteStore = createPaymentMockStore({ now });
  const declineStore = createPaymentMockStore({ now });
  const amountStore = createPaymentMockStore({ now });
  const successClient = createMockSquareClient({ scenario: "refund", store: successStore });
  const failedClient = createMockSquareClient({ scenario: "refund_failed", store: failedStore });
  const declineClient = createMockSquareClient({ scenario: "decline", store: declineStore });
  const incompleteClient = createMockSquareClient({ scenario: "cancel", store: incompleteStore });
  const amountClient = createMockSquareClient({ amountCents: 5000, scenario: "success", store: amountStore });

  await successClient.createPaymentLink(createPaymentLinkRequest());
  await failedClient.createPaymentLink(createPaymentLinkRequest());
  await declineClient.createPaymentLink(createPaymentLinkRequest());
  await incompleteClient.createPaymentLink(createPaymentLinkRequest());
  await amountClient.createPaymentLink(createPaymentLinkRequest());

  assert.deepEqual(await successClient.refundPayment({ paymentId: "mock-square-payment-1" }), {
    refund: {
      amount_money: { amount: 5000, currency: "CAD" },
      id: "mock-square-refund-2",
      payment_id: "mock-square-payment-1",
      status: "COMPLETED",
    },
  });

  assert.deepEqual(await failedClient.refundPayment({ paymentId: "mock-square-payment-1" }), {
    refund: {
      amount_money: { amount: 5000, currency: "CAD" },
      error_code: "PAYMENT_NOT_REFUNDABLE",
      message: "Payment is not refundable",
      id: "mock-square-refund-2",
      payment_id: "mock-square-payment-1",
      status: "FAILED",
    },
  });

  assert.deepEqual(await declineClient.refundPayment({ paymentId: "mock-square-payment-1" }), {
    refund: {
      amount_money: { amount: 5000, currency: "CAD" },
      error_code: "REFUND_ERROR_PAYMENT_NEEDS_COMPLETION",
      message: "Payment must be completed before it can be refunded",
      id: "mock-square-refund-2",
      payment_id: "mock-square-payment-1",
      status: "REJECTED",
    },
  });

  assert.deepEqual(await incompleteClient.refundPayment({ paymentId: "mock-square-payment-1" }), {
    refund: {
      amount_money: { amount: 5000, currency: "CAD" },
      error_code: "REFUND_ERROR_PAYMENT_NEEDS_COMPLETION",
      message: "Payment must be completed before it can be refunded",
      id: "mock-square-refund-2",
      payment_id: "mock-square-payment-1",
      status: "REJECTED",
    },
  });

  assert.deepEqual(await amountClient.refundPayment({ amountCents: 6000, paymentId: "mock-square-payment-1" }), {
    refund: {
      amount_money: { amount: 6000, currency: "CAD" },
      error_code: "REFUND_AMOUNT_INVALID",
      message: "Refund amount is invalid",
      id: "mock-square-refund-2",
      payment_id: "mock-square-payment-1",
      status: "FAILED",
    },
  });
});

test("mock Square duplicate webhook helper records only the first event id", () => {
  const store = createPaymentMockStore({ now });
  const client = createMockSquareClient({ scenario: "duplicate_webhook", store });
  const payload = { event_id: "evt_square_1", type: "payment.updated" };

  const first = client.recordWebhookEvent("evt_square_1", payload);
  const second = client.recordWebhookEvent("evt_square_1", payload);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.webhookEventRecords.length, 1);
});

test("mock Square client can model amount and currency mismatches", async () => {
  const amountStore = createPaymentMockStore({ now });
  const currencyStore = createPaymentMockStore({ now });
  const amountClient = createMockSquareClient({ scenario: "success", store: amountStore, amountCents: 4900 });
  const currencyClient = createMockSquareClient({ scenario: "success", store: currencyStore, currency: "USD" });

  await amountClient.createPaymentLink(createPaymentLinkRequest());
  await currencyClient.createPaymentLink(createPaymentLinkRequest());

  assert.equal((await amountClient.getPayment("mock-square-payment-1")).payment.amount_money?.amount, 4900);
  assert.equal((await currencyClient.getPayment("mock-square-payment-1")).payment.amount_money?.currency, "USD");
});
