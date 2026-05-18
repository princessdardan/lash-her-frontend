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
  type PaymentEventRecord = CheckoutPaymentEventInsert & { id: string };

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

  class FakeCheckoutOrderRepository implements CheckoutOrderRepository {
    readonly events: PaymentEventRecord[] = [];
    readonly rows: CheckoutOrderRow[] = [];

    async createCheckoutOrder(values: CheckoutOrderInsert): Promise<{ id: string }> {
      const id = "checkout-order-" + (this.rows.length + 1);
      const now = new Date("2026-05-10T00:00:00.000Z");

      this.rows.push({
        ...values,
        createdAt: now,
        deletedAt: null,
        failedAt: null,
        helcimTransactionId: null,
        id,
        paidAt: null,
        redactedAt: null,
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

    async findOrderForWebhook(input: Parameters<CheckoutOrderRepository["findOrderForWebhook"]>[0]): Promise<CheckoutOrderRow | null> {
      if (input.helcimInvoiceId === undefined && input.helcimInvoiceNumber === undefined) {
        return null;
      }

      return this.rows.find((row) => (
        (input.helcimInvoiceId === undefined || row.helcimInvoiceId === input.helcimInvoiceId)
        && (input.helcimInvoiceNumber === undefined || row.helcimInvoiceNumber === input.helcimInvoiceNumber)
      )) ?? null;
    }

    async findPendingOrderByCheckoutTokenHash(checkoutTokenHash: string): Promise<CheckoutOrderRow | null> {
      return this.rows.find((row) => (
        row.checkoutTokenHash === checkoutTokenHash
        && row.status === "pending"
      )) ?? null;
    }

    async markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void> {
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
    assert.equal(row.status, "pending");
    assert.equal(row.amountCents, 12345);
    assert.equal(row.lineItems[0].unitPriceCents, 10000);
    assert.equal(row.lineItems[1].totalCents, 2345);
    assert.match(row.checkoutTokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(row.checkoutTokenHash, pendingOrderInput.checkoutToken);
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
      status: "approved",
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
