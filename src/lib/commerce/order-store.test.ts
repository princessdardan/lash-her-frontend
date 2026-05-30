import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createCheckoutOrderStore,
    type CheckoutOrderRepository,
    type CheckoutOrderRow,
  } from "./src/lib/commerce/order-store.ts";
  import { decryptCheckoutSecret } from "./src/lib/commerce/checkout-secret.ts";

  import type { ValidatedCart } from "./src/lib/commerce/cart.ts";

  type CheckoutOrderInsert = Parameters<CheckoutOrderRepository["createCheckoutOrder"]>[0];
  type CheckoutPaymentEventInsert = Parameters<CheckoutOrderRepository["createWebhookEvent"]>[0];
  type SquareInvoiceWebhookEventInsert = Parameters<CheckoutOrderRepository["createSquareInvoiceWebhookEvent"]>[0];
  type PaymentEventRecord = (CheckoutPaymentEventInsert | SquareInvoiceWebhookEventInsert) & {
    id: string;
    processingStatus?: "duplicate" | "failed" | "ignored" | "processed" | "received";
  };

  const cart: ValidatedCart = {
    amount: 123.45,
    currency: "CAD",
    lineItems: [
      {
        description: "Signature Lash Set",
        price: 100,
        productId: "signature-lash-set",
        quantity: 1,
        sku: "LASH-SIGNATURE",
        total: 100,
        variantId: "classic",
      },
      {
        description: "Aftercare Kit",
        price: 23.45,
        productId: "aftercare-kit",
        quantity: 1,
        sku: "CARE-KIT",
        total: 23.45,
      },
    ],
  };

  const pendingOrderInput = {
    cart,
    checkoutToken: "checkout-token-123",
    customerEmail: "client@example.com",
    customerName: "Client Name",
    helcimInvoiceId: 4242,
    helcimInvoiceNumber: "INV-4242",
    secretToken: "secret-token-123",
  };

  const pendingSquareInvoiceOrderInput = {
    amountCents: 249900,
    checkoutToken: "square-checkout-token-123",
    correlationId: "training-correlation-123",
    customerEmail: "student@example.com",
    customerName: "Student Name",
    programSlug: "classic-lash-training",
    secretToken: "square-secret-token-123",
    squareCustomerId: "square-customer-123",
    squareInvoiceId: "square-invoice-123",
    squareInvoiceVersion: 1,
    squareOrderId: "square-order-123",
  };

  class FakeCheckoutOrderRepository implements CheckoutOrderRepository {
    failNextMarkPaid = false;
    readonly events: PaymentEventRecord[] = [];
    readonly rows: CheckoutOrderRow[] = [];

    async createCheckoutOrder(values: CheckoutOrderInsert): Promise<{ id: string }> {
      const id = "checkout-order-" + (this.rows.length + 1);
      const now = new Date("2026-05-10T00:00:00.000Z");

      this.rows.push({
        calendarEventId: null,
        calendarFinalizationStatus: "not_required",
        ...values,
        createdAt: now,
        deletedAt: null,
        failedAt: null,
        finalizedAt: null,
        helcimInvoiceId: values.helcimInvoiceId ?? null,
        helcimInvoiceNumber: values.helcimInvoiceNumber ?? null,
        helcimTransactionId: null,
        id,
        paidAt: null,
        providerCheckoutId: values.providerCheckoutId ?? null,
        providerMetadata: values.providerMetadata,
        providerOrderId: values.providerOrderId ?? null,
        providerPaymentId: values.providerPaymentId ?? null,
        providerStatus: values.providerStatus ?? null,
        redactedAt: null,
        shippingAddress: values.shippingAddress,
        squareLocationId: null,
        squarePaymentLinkId: null,
        squarePaymentLinkUrl: null,
        squareTipAmountCents: null,
        updatedAt: now,
      });

      return { id };
    }

    async createWebhookEvent(values: CheckoutPaymentEventInsert): Promise<{ id: string } | null> {
      if (this.events.some((event) => event.idempotencyKey === values.idempotencyKey)) {
        return null;
      }

      const id = "payment-event-" + (this.events.length + 1);
      this.events.push({ ...values, id });
      return { id };
    }

    async createSquareInvoiceWebhookEvent(values: SquareInvoiceWebhookEventInsert): Promise<{ id: string } | null> {
      if (this.events.some((event) => event.paymentProvider === "square" && event.providerEventId === values.eventId)) {
        return null;
      }

      const id = "payment-event-" + (this.events.length + 1);
      this.events.push({ ...values, id, paymentProvider: "square", processingStatus: "received", providerEventId: values.eventId });
      return { id };
    }

    async findSquareInvoiceWebhookEventClaim(eventId: string): Promise<Awaited<ReturnType<CheckoutOrderRepository["findSquareInvoiceWebhookEventClaim"]>>> {
      const event = this.events.find((candidate) => candidate.paymentProvider === "square" && candidate.providerEventId === eventId);
      return { duplicate: true, processingStatus: event?.processingStatus ?? "received" };
    }

    async findOrderForWebhook(input: Parameters<CheckoutOrderRepository["findOrderForWebhook"]>[0]): Promise<CheckoutOrderRow | null> {
      if (input.helcimInvoiceId === undefined && input.helcimInvoiceNumber === undefined) {
        return null;
      }

      return this.rows.find((row) => (
        row.paymentProvider === "helcim"
        &&
        (input.helcimInvoiceId === undefined || row.helcimInvoiceId === input.helcimInvoiceId)
        && (input.helcimInvoiceNumber === undefined || row.helcimInvoiceNumber === input.helcimInvoiceNumber)
      )) ?? null;
    }

    async findCheckoutOrderByCheckoutTokenHash(checkoutTokenHash: string): Promise<CheckoutOrderRow | null> {
      return this.rows.find((row) => (
        row.checkoutTokenHash === checkoutTokenHash
        && (row.status === "pending" || row.status === "paid")
      )) ?? null;
    }

    async markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void> {
      if (this.failNextMarkPaid) {
        this.failNextMarkPaid = false;
        throw new Error("Paid transition failed");
      }

      const row = this.findOrderByOrderId(orderId);
      row.status = "paid";
      row.helcimTransactionId = helcimTransactionId;
      row.paidAt = new Date("2026-05-10T01:00:00.000Z");
      row.updatedAt = new Date("2026-05-10T01:00:00.000Z");
    }

    async markOrderVerificationFailed(orderId: string): Promise<void> {
      const row = this.findOrderByOrderId(orderId);
      row.status = "verification_failed";
      row.failedAt = new Date("2026-05-10T02:00:00.000Z");
      row.updatedAt = new Date("2026-05-10T02:00:00.000Z");
    }

    async recordSquareInvoicePublication(orderId: string, invoiceId: string, publicUrl: string, version: number): Promise<void> {
      const row = this.findOrderByOrderId(orderId);
      row.providerCheckoutId = invoiceId;
      row.providerStatus = "published";
      row.providerMetadata = {
        ...(row.providerMetadata ?? {}),
        squareInvoicePublicUrl: publicUrl,
        squareInvoiceVersion: version,
      };
      row.updatedAt = new Date("2026-05-10T03:00:00.000Z");
    }

    async markSquareInvoicePaid(orderId: string, paymentId: string): Promise<void> {
      const row = this.findOrderByOrderId(orderId);
      row.status = "paid";
      row.providerPaymentId = paymentId;
      row.providerStatus = "paid";
      row.providerMetadata = {
        ...(row.providerMetadata ?? {}),
        finalizationStatus: "paid",
      };
      row.paidAt ??= new Date("2026-05-10T04:00:00.000Z");
      row.updatedAt = new Date("2026-05-10T04:00:00.000Z");
    }

    async markSquareInvoiceFinalizationFailed(orderId: string, error: string, retryable: boolean): Promise<void> {
      const row = this.findOrderByOrderId(orderId);
      row.providerStatus = "finalization_failed";
      row.providerMetadata = {
        ...(row.providerMetadata ?? {}),
        finalizationError: error,
        finalizationRetryable: retryable,
        finalizationStatus: "failed",
      };
      row.failedAt ??= new Date("2026-05-10T05:00:00.000Z");
      row.updatedAt = new Date("2026-05-10T05:00:00.000Z");
    }

    async updateSquareInvoiceWebhookEvent(
      values: SquareInvoiceWebhookEventInsert,
      processingStatus: "duplicate" | "failed" | "ignored" | "processed" | "received",
    ): Promise<void> {
      const event = this.events.find((candidate) => candidate.paymentProvider === "square" && candidate.providerEventId === values.eventId);
      assert.ok(event, "Expected Square invoice webhook event " + values.eventId + " to exist");
      event.processingStatus = processingStatus;
      event.status = values.status;
    }

    async findOrderBySquareInvoiceId(invoiceId: string): Promise<CheckoutOrderRow | null> {
      return this.rows.find((row) => (
        row.paymentProvider === "square"
        && row.providerCheckoutId === invoiceId
      )) ?? null;
    }

    async findOrderByCorrelationId(correlationId: string): Promise<CheckoutOrderRow | null> {
      return this.rows.find((row) => (
        row.paymentProvider === "square"
        && row.providerMetadata?.correlationId === correlationId
      )) ?? null;
    }

    private findOrderByOrderId(orderId: string): CheckoutOrderRow {
      const row = this.rows.find((candidate) => candidate.orderId === orderId);
      assert.ok(row, "Expected order " + orderId + " to exist");
      return row;
    }
  }

  function createFakeStore(): {
    repository: FakeCheckoutOrderRepository;
    store: ReturnType<typeof createCheckoutOrderStore>;
  } {
    const repository = new FakeCheckoutOrderRepository();
    return {
      repository,
      store: createCheckoutOrderStore(repository),
    };
  }
`;

test("private checkout store creates pending orders with hashed tokens and cent amounts", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingOrder(pendingOrderInput);
    const row = repository.rows[0];

    assert.equal(created._id, "checkout-order-1");
    assert.match(created.orderId, /^lh-/);
    assert.equal(created.secretToken, pendingOrderInput.secretToken);
    assert.equal(created.amount, 123.45);
    assert.equal(created.currency, "CAD");
    assert.equal(created.purpose, "product");
    assert.equal(row.status, "pending");
    assert.equal(row.paymentProvider, "helcim");
    assert.equal(row.purpose, "product");
    assert.equal(row.amountCents, 12345);
    assert.equal(row.lineItems[0].unitPriceCents, 10000);
    assert.equal(row.lineItems[1].totalCents, 2345);
    assert.match(row.checkoutTokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(row.checkoutTokenHash, pendingOrderInput.checkoutToken);
  `);
});

test("private checkout store creates pending Square invoice training orders idempotently", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);
    const duplicate = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);
    const row = repository.rows[0];

    assert.equal(repository.rows.length, 1);
    assert.equal(duplicate._id, created._id);
    assert.equal(created._id, "checkout-order-1");
    assert.match(created.orderId, /^lh-/);
    assert.equal(created.secretToken, pendingSquareInvoiceOrderInput.secretToken);
    assert.equal(created.amount, 2499);
    assert.equal(created.currency, "CAD");
    assert.equal(created.paymentProvider, "square");
    assert.equal(created.purpose, "training");
    assert.equal(row.status, "pending");
    assert.equal(row.paymentProvider, "square");
    assert.equal(row.purpose, "training");
    assert.equal(row.amountCents, 249900);
    assert.equal(row.currency, "CAD");
    assert.equal(row.providerCheckoutId, "square-invoice-123");
    assert.equal(row.providerOrderId, "square-order-123");
    assert.equal(row.providerStatus, "draft");
    assert.equal(row.helcimInvoiceId, null);
    assert.equal(row.helcimInvoiceNumber, null);
    assert.match(row.checkoutTokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(row.checkoutTokenHash, pendingSquareInvoiceOrderInput.checkoutToken);
    assert.deepEqual(row.providerMetadata, {
      amountCents: 249900,
      correlationId: "training-correlation-123",
      currency: "CAD",
      finalizationStatus: "pending",
      flow: "training_square_invoice",
      programSlug: "classic-lash-training",
      squareCustomerId: "square-customer-123",
      squareInvoicePublicUrl: null,
      squareInvoiceVersion: 1,
    });
  `);
});

test("private checkout store records Square invoice publication idempotently", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);

    await store.recordSquareInvoicePublication(created.orderId, "square-invoice-123", "https://square.test/invoice/123", 2);
    await store.recordSquareInvoicePublication(created.orderId, "square-invoice-123", "https://square.test/invoice/123", 2);
    const row = repository.rows[0];

    assert.equal(row.status, "pending");
    assert.equal(row.providerCheckoutId, "square-invoice-123");
    assert.equal(row.providerStatus, "published");
    assert.equal(row.providerMetadata?.finalizationStatus, "pending");
    assert.equal(row.providerMetadata?.squareInvoicePublicUrl, "https://square.test/invoice/123");
    assert.equal(row.providerMetadata?.squareInvoiceVersion, 2);
  `);
});

test("private checkout store marks Square invoice orders paid idempotently", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);

    await store.markSquareInvoicePaid(created.orderId, "square-payment-123");
    const firstPaidAt = repository.rows[0].paidAt;
    await store.markSquareInvoicePaid(created.orderId, "square-payment-123");
    const row = repository.rows[0];

    assert.equal(row.status, "paid");
    assert.equal(row.providerPaymentId, "square-payment-123");
    assert.equal(row.providerStatus, "paid");
    assert.equal(row.providerMetadata?.finalizationStatus, "paid");
    assert.equal(row.paidAt, firstPaidAt);
    assert.equal(row.failedAt, null);
  `);
});

test("private checkout store marks Square invoice finalization failures idempotently", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);

    await store.markSquareInvoiceFinalizationFailed(created.orderId, "Square invoice publish failed", true);
    const firstFailedAt = repository.rows[0].failedAt;
    await store.markSquareInvoiceFinalizationFailed(created.orderId, "Square invoice publish failed", true);
    const row = repository.rows[0];

    assert.equal(row.status, "pending");
    assert.equal(row.providerStatus, "finalization_failed");
    assert.equal(row.providerMetadata?.finalizationStatus, "failed");
    assert.equal(row.providerMetadata?.finalizationError, "Square invoice publish failed");
    assert.equal(row.providerMetadata?.finalizationRetryable, true);
    assert.equal(row.failedAt, firstFailedAt);
  `);
});

test("private checkout store looks up Square invoice orders by invoice and correlation identifiers", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);

    const byInvoice = await store.findOrderBySquareInvoiceId("square-invoice-123");
    const byCorrelation = await store.findOrderByCorrelationId("training-correlation-123");

    assert.ok(byInvoice);
    assert.equal(byInvoice.id, created._id);
    assert.equal(byInvoice.paymentProvider, "square");
    assert.ok(byCorrelation);
    assert.equal(byCorrelation.id, created._id);
    assert.equal(await store.findOrderBySquareInvoiceId("missing-invoice"), null);
    assert.equal(await store.findOrderByCorrelationId("missing-correlation"), null);
  `);
});

test("private checkout store claims Square invoice webhook events idempotently", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);
    const input = {
      eventId: "square-invoice-event-duplicate",
      eventType: "invoice.payment_made",
      orderDatabaseId: created._id,
      providerCheckoutId: "square-invoice-123",
      providerOrderId: "square-order-123",
      status: "PAID",
    };

    const first = await store.claimSquareInvoiceWebhookEvent(input);
    const second = await store.claimSquareInvoiceWebhookEvent(input);

    assert.deepEqual(first, { duplicate: false });
    assert.deepEqual(second, { duplicate: true, processingStatus: "received" });
    assert.equal(repository.events.length, 1);
    assert.equal(repository.events[0].paymentProvider, "square");
    assert.equal(repository.events[0].providerEventId, "square-invoice-event-duplicate");
    assert.equal(repository.events[0].processingStatus, "received");
  `);
});

test("private checkout store records Square invoice webhook events processed", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingSquareInvoiceOrder(pendingSquareInvoiceOrderInput);
    const input = {
      eventId: "square-invoice-event-processed",
      eventType: "invoice.payment_made",
      orderDatabaseId: created._id,
      providerCheckoutId: "square-invoice-123",
      providerOrderId: "square-order-123",
      providerPaymentId: "square-payment-123",
      status: "PAID",
    };

    await store.claimSquareInvoiceWebhookEvent(input);
    await store.recordSquareInvoiceWebhookEventProcessed(input);

    assert.equal(repository.events.length, 1);
    assert.equal(repository.events[0].providerEventId, "square-invoice-event-processed");
    assert.equal(repository.events[0].processingStatus, "processed");
  `);
});

test("private checkout store records appointment order purposes", () => {
  runOrderStoreScenario(`
    for (const purpose of ["appointment_deposit", "appointment_full", "appointment_custom_partial"]) {
      const { repository, store } = createFakeStore();
      const created = await store.createPendingOrder({
        ...pendingOrderInput,
        purpose,
      });
      const row = repository.rows[0];

      assert.equal(created.purpose, purpose);
      assert.equal(row.purpose, purpose);
    }
  `);
});

test("private checkout store looks up pending orders by token hash only", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);
    const row = repository.rows[0];

    assert.equal(await store.getPendingOrderByCheckoutToken("wrong-token"), null);
    assert.equal(repository.rows.some((candidate) => candidate.checkoutTokenHash === pendingOrderInput.checkoutToken), false);

    const found = await store.getPendingOrderByCheckoutToken(pendingOrderInput.checkoutToken);
    assert.ok(found);
    assert.equal(found._id, row.id);
    assert.equal(found.orderId, row.orderId);
    assert.equal(found.amount, 123.45);
    assert.equal(found.customerEmail, "client@example.com");
    assert.equal(found.customerName, "Client Name");
    assert.deepEqual(found.lineItems, row.lineItems);

    row.status = "paid";
    assert.equal(await store.getPendingOrderByCheckoutToken(pendingOrderInput.checkoutToken), null);
  `);
});


test("private checkout store can recover paid appointment orders by checkout token", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const appointment = await store.createPendingOrder({
      ...pendingOrderInput,
      purpose: "appointment_custom_partial",
    });
    const product = await store.createPendingOrder({
      ...pendingOrderInput,
      checkoutToken: "product-token",
      helcimInvoiceId: 5252,
      helcimInvoiceNumber: "INV-5252",
    });

    await store.markOrderPaid(appointment.orderId, "txn-appointment-paid");
    await store.markOrderPaid(product.orderId, "txn-product-paid");

    const foundAppointment = await store.getPendingOrderByCheckoutToken(pendingOrderInput.checkoutToken);
    const foundProduct = await store.getPendingOrderByCheckoutToken("product-token");

    assert.ok(foundAppointment);
    assert.equal(foundAppointment.orderId, appointment.orderId);
    assert.equal(foundAppointment.purpose, "appointment_custom_partial");
    assert.equal(foundProduct, null);
  `);
});

test("private checkout store decrypts secret tokens only at the read boundary", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);
    const row = repository.rows[0];

    assert.match(row.secretTokenCiphertext, /^v1:/);
    assert.notEqual(row.secretTokenCiphertext, pendingOrderInput.secretToken);
    assert.equal(decryptCheckoutSecret(row.secretTokenCiphertext), pendingOrderInput.secretToken);

    const found = await store.getPendingOrderByCheckoutToken(pendingOrderInput.checkoutToken);
    assert.ok(found);
    assert.equal(found.secretToken, pendingOrderInput.secretToken);
  `);
});

test("private checkout store marks orders paid", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingOrder(pendingOrderInput);

    await store.markOrderPaid(created.orderId, "txn-paid-123");
    const row = repository.rows[0];

    assert.equal(row.status, "paid");
    assert.equal(row.helcimTransactionId, "txn-paid-123");
    assert.ok(row.paidAt instanceof Date);
    assert.equal(row.failedAt, null);
  `);
});

test("private checkout store marks verification failures", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingOrder(pendingOrderInput);

    await store.markOrderVerificationFailed(created.orderId);
    const row = repository.rows[0];

    assert.equal(row.status, "verification_failed");
    assert.ok(row.failedAt instanceof Date);
    assert.equal(row.paidAt, null);
  `);
});

test("private checkout store records idempotent webhook events once", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();

    const first = await store.recordHelcimWebhookEvent({
      amount: "123.45",
      currency: "cad",
      eventId: "event-duplicate",
      eventType: "payment.updated",
      helcimInvoiceId: 9999,
      helcimTransactionId: "txn-webhook-123",
      status: "APPROVAL",
    });
    const second = await store.recordHelcimWebhookEvent({
      amount: "123.45",
      currency: "cad",
      eventId: "event-duplicate",
      eventType: "payment.updated",
      helcimInvoiceId: 9999,
      helcimTransactionId: "txn-webhook-123",
      status: "approved",
    });

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(repository.events.length, 1);
    assert.equal(repository.events[0].amountCents, 12345);
    assert.equal(repository.events[0].currency, "CAD");
    assert.equal(repository.events[0].orderId, null);
  `);
});

test("private checkout store reconciles approved webhooks into paid orders", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);

    const recorded = await store.recordHelcimWebhookEvent({
      amount: "123.45",
      currency: "cad",
      eventId: "event-approved",
      eventType: "payment.updated",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-paid",
      status: "approved",
    });
    const row = repository.rows[0];

    assert.equal(recorded, true);
    assert.equal(repository.events.length, 1);
    assert.equal(repository.events[0].orderId, row.id);
    assert.equal(repository.events[0].amountCents, 12345);
    assert.equal(repository.events[0].currency, "CAD");
    assert.equal(row.status, "paid");
    assert.equal(row.helcimTransactionId, "txn-webhook-paid");
    assert.ok(row.paidAt instanceof Date);
  `);
});


test("private checkout store exposes matched order details for webhook branching", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    const created = await store.createPendingOrder({
      ...pendingOrderInput,
      purpose: "appointment_full",
    });

    const result = await store.recordHelcimWebhookEventWithOrder({
      amount: "123.45",
      currency: "cad",
      eventId: "event-appointment-approved",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-appointment",
      status: "approved",
    });
    const duplicate = await store.recordHelcimWebhookEventWithOrder({
      amount: "123.45",
      currency: "cad",
      eventId: "event-appointment-approved",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-appointment",
      status: "approved",
    });

    assert.deepEqual(result, {
      matchedOrder: {
        _id: created._id,
        amount: 123.45,
        currency: "CAD",
        helcimInvoiceId: 4242,
        helcimInvoiceNumber: "INV-4242",
        orderId: created.orderId,
        paymentProvider: "helcim",
        purpose: "appointment_full",
      },
      paid: true,
      recorded: true,
    });
    assert.equal(duplicate.recorded, false);
    assert.equal(duplicate.paid, true);
    assert.equal(duplicate.matchedOrder?.purpose, "appointment_full");
    assert.equal(await store.recordHelcimWebhookEvent({
      amount: "123.45",
      currency: "cad",
      eventId: "event-boolean-contract",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-boolean",
      status: "approved",
    }), true);
  `);
});

test("private checkout store ignores Square provider rows during Helcim webhook reconciliation", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);
    repository.rows[0].paymentProvider = "square";
    repository.rows[0].purpose = "appointment_deposit";

    const result = await store.recordHelcimWebhookEventWithOrder({
      amount: "123.45",
      currency: "CAD",
      eventId: "event-square-provider-ignored",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-square-must-not-finalize",
      status: "approved",
    });

    assert.equal(result.recorded, true);
    assert.equal(result.paid, false);
    assert.equal(result.matchedOrder, null);
    assert.equal(repository.events[0].orderId, null);
    assert.equal(repository.rows[0].status, "pending");
    assert.equal(repository.rows[0].helcimTransactionId, null);
  `);
});


test("private checkout store reports duplicate paid appointment webhooks as finalization eligible", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder({
      ...pendingOrderInput,
      purpose: "appointment_full",
    });

    const first = await store.recordHelcimWebhookEventWithOrder({
      amount: "123.45",
      currency: "CAD",
      eventId: "event-paid-duplicate",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-paid",
      status: "approved",
    });
    const duplicate = await store.recordHelcimWebhookEventWithOrder({
      amount: "123.45",
      currency: "CAD",
      eventId: "event-paid-duplicate",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-paid",
      status: "approved",
    });

    assert.equal(first.recorded, true);
    assert.equal(first.paid, true);
    assert.equal(duplicate.recorded, false);
    assert.equal(duplicate.paid, true);
    assert.equal(duplicate.matchedOrder?.purpose, "appointment_full");
  `);
});

test("private checkout store can retry paid transition after duplicate webhook event", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder({
      ...pendingOrderInput,
      purpose: "appointment_deposit",
    });
    repository.failNextMarkPaid = true;

    await assert.rejects(
      () => store.recordHelcimWebhookEventWithOrder({
        amount: "123.45",
        currency: "CAD",
        eventId: "event-transition-retry",
        eventType: "cardTransaction",
        helcimInvoiceNumber: "INV-4242",
        helcimTransactionId: "txn-webhook-retry",
        status: "approved",
      }),
      /Paid transition failed/,
    );
    assert.equal(repository.events.length, 1);
    assert.equal(repository.rows[0].status, "pending");

    const duplicate = await store.recordHelcimWebhookEventWithOrder({
      amount: "123.45",
      currency: "CAD",
      eventId: "event-transition-retry",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-retry",
      status: "approved",
    });

    assert.equal(duplicate.recorded, false);
    assert.equal(duplicate.paid, true);
    assert.equal(repository.rows[0].status, "paid");
    assert.equal(repository.rows[0].helcimTransactionId, "txn-webhook-retry");
  `);
});

test("private checkout store does not mark paid when webhook amount is missing", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);

    const recorded = await store.recordHelcimWebhookEvent({
      currency: "CAD",
      eventId: "event-missing-amount",
      eventType: "payment.updated",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-incomplete",
      status: "approved",
    });
    const row = repository.rows[0];

    assert.equal(recorded, true);
    assert.equal(row.status, "pending");
    assert.equal(row.helcimTransactionId, null);
  `);
});

test("private checkout store does not mark paid when webhook currency is missing", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);

    const recorded = await store.recordHelcimWebhookEvent({
      amount: "123.45",
      eventId: "event-missing-currency",
      eventType: "payment.updated",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-incomplete",
      status: "approved",
    });
    const row = repository.rows[0];

    assert.equal(recorded, true);
    assert.equal(row.status, "pending");
    assert.equal(row.helcimTransactionId, null);
  `);
});

test("private checkout store does not match conflicting webhook invoice identifiers", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);

    const recorded = await store.recordHelcimWebhookEvent({
      amount: "123.45",
      currency: "CAD",
      eventId: "event-conflicting-invoice",
      eventType: "payment.updated",
      helcimInvoiceId: 9999,
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-conflict",
      status: "approved",
    });
    const row = repository.rows[0];

    assert.equal(recorded, true);
    assert.equal(repository.events[0].orderId, null);
    assert.equal(row.status, "pending");
    assert.equal(row.helcimTransactionId, null);
  `);
});

test("private checkout store persists redacted webhook payload details only", () => {
  runOrderStoreScenario(`
    const { repository, store } = createFakeStore();
    await store.createPendingOrder(pendingOrderInput);

    await store.recordHelcimWebhookEvent({
      amount: "123.45",
      currency: "CAD",
      eventId: "event-redacted-payload",
      eventType: "cardTransaction",
      helcimInvoiceNumber: "INV-4242",
      helcimTransactionId: "txn-webhook-paid",
      payloadRedacted: {
        amount: "123.45",
        approvalCode: "APPROVAL-123",
        cardLast4: "1111",
        cardType: "Visa",
        currency: "CAD",
        invoiceNumber: "INV-4242",
        status: "APPROVED",
        transactionId: "txn-webhook-paid",
      },
      status: "approved",
    });

    assert.deepEqual(repository.events[0].payloadRedacted, {
      amount: "123.45",
      approvalCode: "APPROVAL-123",
      cardLast4: "1111",
      cardType: "Visa",
      currency: "CAD",
      invoiceNumber: "INV-4242",
      status: "APPROVED",
      transactionId: "txn-webhook-paid",
    });
    assert.equal(Object.hasOwn(repository.events[0].payloadRedacted ?? {}, "cardToken"), false);
    assert.equal(Object.hasOwn(repository.events[0].payloadRedacted ?? {}, "cardNumber"), false);
    assert.equal(Object.hasOwn(repository.events[0].payloadRedacted ?? {}, "customerCode"), false);
  `);
});

function runOrderStoreScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.CHECKOUT_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
