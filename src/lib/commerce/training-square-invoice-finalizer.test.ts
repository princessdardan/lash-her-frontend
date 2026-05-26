import assert from "node:assert/strict";
import test from "node:test";

import type { CheckoutOrderRow } from "@/lib/commerce/order-store";
import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import { createMockSquareInvoiceLifecycle } from "@/lib/payment-mocks/square-invoices";

import {
  createTrainingSquareInvoiceFinalizer,
  type TrainingSquareInvoiceFinalizerDependencies,
} from "./training-square-invoice-finalizer";

type EnrollmentRecord = Awaited<ReturnType<TrainingSquareInvoiceFinalizerDependencies["getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId"]>>;
type SchedulingTokenRecord = Awaited<ReturnType<TrainingSquareInvoiceFinalizerDependencies["getOrIssueTrainingSchedulingTokenForPaidOrder"]>>;

const now = new Date("2026-05-25T12:00:00.000Z");
const request = new Request("http://localhost:3000/api/training-checkout/square-invoice");

function createSquareInvoiceOrder(overrides: Partial<CheckoutOrderRow> = {}): CheckoutOrderRow {
  return {
    amountCents: 249900,
    calendarEventId: null,
    calendarFinalizationStatus: "not_required",
    checkoutTokenHash: "checkout-token-hash",
    createdAt: now,
    currency: "CAD",
    customerEmail: "student@example.com",
    customerName: "Student Name",
    deletedAt: null,
    failedAt: null,
    finalizedAt: null,
    helcimInvoiceId: null,
    helcimInvoiceNumber: null,
    helcimTransactionId: null,
    id: "checkout-order-db-id",
    lineItems: [
      {
        description: "Classic Lash Training",
        productId: "classic-lash-training",
        quantity: 1,
        sku: "TRAINING-CLASSIC-LASH-TRAINING",
        totalCents: 249900,
        unitPriceCents: 249900,
      },
    ],
    orderId: "lh-training-123",
    paidAt: null,
    paymentProvider: "square",
    providerCheckoutId: "mock-square-invoice-1",
    providerMetadata: {
      amountCents: 249900,
      correlationId: "training-correlation-123",
      currency: "CAD",
      finalizationStatus: "pending",
      flow: "training_square_invoice",
      programSlug: "classic-lash-training",
      squareCustomerId: "square-customer-123",
      squareInvoicePublicUrl: "https://square.test/invoice/1",
      squareInvoiceVersion: 2,
    },
    providerOrderId: "mock-square-invoice-order-1",
    providerPaymentId: null,
    providerStatus: "published",
    purpose: "training",
    redactedAt: null,
    secretTokenCiphertext: "v1:ciphertext",
    shippingAddress: null,
    squareLocationId: null,
    squarePaymentLinkId: null,
    squarePaymentLinkUrl: null,
    squareTipAmountCents: null,
    status: "pending",
    updatedAt: now,
    ...overrides,
  };
}

function createPaidInvoiceDetails(input: {
  amountCents?: number;
  correlationId?: string;
  currency?: "CAD";
  customerId?: string;
  invoiceId?: string;
  orderId?: string;
  paymentId?: string;
  status?: string;
} = {}) {
  const store = createPaymentMockStore({ now });
  const lifecycle = createMockSquareInvoiceLifecycle({
    amountCents: input.amountCents ?? 249900,
    currency: input.currency ?? "CAD",
    customerId: "square-customer-123",
    idempotencyKey: "invoice-idempotency-key",
    orderId: input.orderId ?? "mock-square-invoice-order-1",
    request,
    scenario: "square_invoice_success",
    store,
  });

  return {
    ...lifecycle.invoice,
    id: input.invoiceId ?? lifecycle.invoice.id,
    order_id: input.orderId ?? lifecycle.invoice.order_id,
    payment: {
      id: input.paymentId ?? lifecycle.webhookPayload.data.object.payment?.id ?? "square-payment-123",
    },
    primary_recipient: {
      customer_id: input.customerId ?? "square-customer-123",
    },
    reference_id: input.correlationId ?? "training-correlation-123",
    status: input.status ?? lifecycle.invoice.status,
  };
}

function createHarness(input: {
  getInvoice?: TrainingSquareInvoiceFinalizerDependencies["getInvoice"];
  getOrder?: TrainingSquareInvoiceFinalizerDependencies["getOrder"];
  order?: CheckoutOrderRow | null;
  tokenFailureCount?: number;
} = {}) {
  let order = input.order === undefined ? createSquareInvoiceOrder() : input.order;
  let enrollment: EnrollmentRecord = null;
  let tokenFailureCount = input.tokenFailureCount ?? 0;
  const calls = {
    createEnrollment: 0,
    emails: 0,
    getInvoice: 0,
    getOrder: 0,
    markFailed: [] as Array<{ error: string; retryable: boolean }>,
    markPaid: 0,
    markStaffAlerted: 0,
    tokens: 0,
  };
  const dependencies: TrainingSquareInvoiceFinalizerDependencies = {
    async createTrainingEnrollment(createInput) {
      calls.createEnrollment += 1;
      assert.equal(createInput.checkoutOrderId, "checkout-order-db-id");
      assert.equal(createInput.checkoutEmail, "student@example.com");
      assert.deepEqual(createInput.programSnapshot, {
        id: "classic-lash-training",
        slug: "classic-lash-training",
        title: "Classic Lash Training",
      });
      assert.deepEqual(createInput.productSnapshot, {
        id: "classic-lash-training",
        title: "Classic Lash Training",
        sku: "TRAINING-CLASSIC-LASH-TRAINING",
        priceCents: 249900,
        currency: "CAD",
      });

      enrollment = createEnrollmentRecord(order);
      return {
        checkoutEmail: "student@example.com",
        checkoutOrderId: "checkout-order-db-id",
        createdAt: now,
        id: "training-enrollment-id",
        productSnapshot: createInput.productSnapshot,
        programSnapshot: createInput.programSnapshot,
        purchaseKind: "full",
        scheduledAt: null,
        schedulingStatus: "pending",
        schedulingTokenHash: null,
        staffAlertedAt: null,
        tokenExpiresAt: null,
        tokenUsedAt: null,
        updatedAt: now,
      };
    },
    async findOrderBySquareInvoiceId(invoiceId) {
      return order?.providerCheckoutId === invoiceId ? order : null;
    },
    async getInvoice(invoiceId) {
      calls.getInvoice += 1;
      if (input.getInvoice) {
        return input.getInvoice(invoiceId);
      }

      return createPaidInvoiceDetails({ invoiceId, paymentId: "square-payment-123" });
    },
    async getOrder(orderId) {
      calls.getOrder += 1;
      if (input.getOrder) {
        return input.getOrder(orderId);
      }

      return { id: orderId, reference_id: "training-correlation-123" };
    },
    async getOrIssueTrainingSchedulingTokenForPaidOrder(orderId) {
      calls.tokens += 1;
      assert.equal(orderId, "lh-training-123");

      if (tokenFailureCount > 0) {
        tokenFailureCount -= 1;
        throw new Error("Scheduling token issuance failed");
      }

      return {
        ...createEnrollmentRecord(order),
        schedulingToken: "tr_scheduling_token",
      } satisfies SchedulingTokenRecord;
    },
    async getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(orderId) {
      assert.equal(orderId, "lh-training-123");
      return enrollment;
    },
    async markSquareInvoiceFinalizationFailed(orderId, error, retryable) {
      assert.equal(orderId, "lh-training-123");
      calls.markFailed.push({ error, retryable });
      if (order) {
        order = {
          ...order,
          failedAt: order.failedAt ?? now,
          providerMetadata: {
            ...(order.providerMetadata ?? {}),
            finalizationError: error,
            finalizationRetryable: retryable,
            finalizationStatus: "failed",
          },
          providerStatus: "finalization_failed",
        };
      }
    },
    async markSquareInvoicePaid(orderId, paymentId) {
      assert.equal(orderId, "lh-training-123");
      assert.equal(paymentId, "square-payment-123");
      calls.markPaid += 1;
      if (order) {
        order = {
          ...order,
          paidAt: order.paidAt ?? now,
          providerMetadata: {
            ...(order.providerMetadata ?? {}),
            finalizationStatus: "paid",
          },
          providerPaymentId: paymentId,
          providerStatus: "paid",
          status: "paid",
        };
      }
    },
    async markTrainingEnrollmentStaffAlerted(input) {
      assert.equal(input.enrollmentId, "training-enrollment-id");
      calls.markStaffAlerted += 1;
      if (enrollment) {
        enrollment = {
          ...enrollment,
          staffAlertedAt: now,
        };
      }
      return true;
    },
    async sendTrainingPaymentNotificationEmails(emailInput) {
      calls.emails += 1;
      assert.deepEqual(emailInput, {
        customerEmail: "student@example.com",
        customerName: "Student Name",
        orderId: "lh-training-123",
        programTitle: "Classic Lash Training",
        schedulingUrl: "https://lashher.test/training-programs/classic-lash-training/schedule?token=tr_scheduling_token",
      });
    },
  };

  return {
    calls,
    finalizer: createTrainingSquareInvoiceFinalizer(dependencies),
    get enrollment() {
      return enrollment;
    },
    get order() {
      return order;
    },
    set enrollment(value: EnrollmentRecord) {
      enrollment = value;
    },
  };
}

test("finalizeTrainingSquareInvoice verifies a paid Square invoice before enrollment, token, and emails", async () => {
  const harness = createHarness();

  const result = await harness.finalizer({
    correlationId: "training-correlation-123",
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.deepEqual(result, { duplicate: false, finalized: true });
  assert.equal(harness.calls.getInvoice, 1);
  assert.equal(harness.calls.markPaid, 1);
  assert.equal(harness.calls.createEnrollment, 1);
  assert.equal(harness.calls.tokens, 1);
  assert.equal(harness.calls.markStaffAlerted, 1);
  assert.equal(harness.calls.emails, 1);
});

test("finalizeTrainingSquareInvoice rejects paid invoices with amount mismatches", async () => {
  const harness = createHarness({
    getInvoice: async (invoiceId) => createPaidInvoiceDetails({ amountCents: 249899, invoiceId, paymentId: "square-payment-123" }),
  });

  const result = await harness.finalizer({
    correlationId: "training-correlation-123",
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.equal(result.finalized, false);
  assert.equal(result.duplicate, false);
  assert.equal(result.reason, "Square invoice amount did not match local order");
  assert.equal(harness.calls.markPaid, 0);
  assert.deepEqual(harness.calls.markFailed, [
    { error: "Square invoice amount did not match local order", retryable: false },
  ]);
  assert.equal(harness.calls.createEnrollment, 0);
  assert.equal(harness.calls.tokens, 0);
  assert.equal(harness.calls.emails, 0);
});

test("finalizeTrainingSquareInvoice rejects paid invoices with customer mismatches", async () => {
  const harness = createHarness({
    getInvoice: async (invoiceId) => createPaidInvoiceDetails({
      customerId: "square-customer-other",
      invoiceId,
      paymentId: "square-payment-123",
    }),
  });

  const result = await harness.finalizer({
    correlationId: "training-correlation-123",
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.equal(result.finalized, false);
  assert.equal(result.duplicate, false);
  assert.equal(result.reason, "Square invoice customer did not match local order");
  assert.equal(harness.calls.markPaid, 0);
  assert.deepEqual(harness.calls.markFailed, [
    { error: "Square invoice customer did not match local order", retryable: false },
  ]);
  assert.equal(harness.calls.createEnrollment, 0);
  assert.equal(harness.calls.tokens, 0);
  assert.equal(harness.calls.emails, 0);
});

test("finalizeTrainingSquareInvoice rejects paid invoices without a matching Square order correlation", async () => {
  const harness = createHarness({
    getInvoice: async (invoiceId) => {
      const invoice = createPaidInvoiceDetails({ invoiceId, paymentId: "square-payment-123" });

      return {
        id: invoice.id,
        order_id: invoice.order_id,
        payment: invoice.payment,
        payment_requests: invoice.payment_requests,
        primary_recipient: invoice.primary_recipient,
        status: invoice.status,
      };
    },
    getOrder: async (orderId) => ({ id: orderId }),
  });

  const result = await harness.finalizer({
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.equal(result.finalized, false);
  assert.equal(result.duplicate, false);
  assert.equal(result.reason, "Square invoice correlation did not match local order");
  assert.equal(harness.calls.getOrder, 1);
  assert.equal(harness.calls.markPaid, 0);
  assert.deepEqual(harness.calls.markFailed, [
    { error: "Square invoice correlation did not match local order", retryable: false },
  ]);
  assert.equal(harness.calls.createEnrollment, 0);
  assert.equal(harness.calls.tokens, 0);
  assert.equal(harness.calls.emails, 0);
});

test("finalizeTrainingSquareInvoice ignores unknown invoices without fetching Square", async () => {
  const harness = createHarness({ order: null });

  const result = await harness.finalizer({
    invoiceId: "missing-invoice",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.deepEqual(result, {
    duplicate: false,
    finalized: false,
    reason: "Local Square invoice order not found",
  });
  assert.equal(harness.calls.getInvoice, 0);
  assert.equal(harness.calls.markPaid, 0);
});

test("finalizeTrainingSquareInvoice returns duplicate for already finalized paid orders", async () => {
  const paidOrder = createSquareInvoiceOrder({
    paidAt: now,
    providerMetadata: {
      amountCents: 249900,
      correlationId: "training-correlation-123",
      currency: "CAD",
      finalizationStatus: "paid",
      flow: "training_square_invoice",
      programSlug: "classic-lash-training",
      squareCustomerId: "square-customer-123",
      squareInvoicePublicUrl: "https://square.test/invoice/1",
      squareInvoiceVersion: 2,
    },
    providerPaymentId: "square-payment-123",
    providerStatus: "paid",
    status: "paid",
  });
  const harness = createHarness({ order: paidOrder });

  const result = await harness.finalizer({
    correlationId: "training-correlation-123",
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.deepEqual(result, { duplicate: true, finalized: false });
  assert.equal(harness.calls.getInvoice, 1);
  assert.equal(harness.calls.markPaid, 0);
  assert.equal(harness.calls.createEnrollment, 0);
  assert.equal(harness.calls.tokens, 0);
  assert.equal(harness.calls.emails, 0);
});

test("finalizeTrainingSquareInvoice retries after partial finalization failure without duplicating enrollment", async () => {
  const harness = createHarness({ tokenFailureCount: 1 });

  const failed = await harness.finalizer({
    correlationId: "training-correlation-123",
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });
  const retried = await harness.finalizer({
    correlationId: "training-correlation-123",
    invoiceId: "mock-square-invoice-1",
    origin: "https://lashher.test",
    paymentId: "square-payment-123",
  });

  assert.equal(failed.finalized, false);
  assert.equal(failed.duplicate, false);
  assert.equal(failed.reason, "Scheduling token issuance failed");
  assert.deepEqual(harness.calls.markFailed, [
    { error: "Scheduling token issuance failed", retryable: true },
  ]);
  assert.deepEqual(retried, { duplicate: false, finalized: true });
  assert.equal(harness.calls.markPaid, 2);
  assert.equal(harness.calls.createEnrollment, 1);
  assert.equal(harness.calls.tokens, 2);
  assert.equal(harness.calls.markStaffAlerted, 1);
  assert.equal(harness.calls.emails, 1);
});

function createEnrollmentRecord(order: CheckoutOrderRow | null): NonNullable<EnrollmentRecord> {
  assert.ok(order);

  return {
    checkoutEmail: "student@example.com",
    checkoutOrder: order,
    enrollmentId: "training-enrollment-id",
    productSnapshot: {
      currency: "CAD",
      id: "classic-lash-training",
      priceCents: 249900,
      sku: "TRAINING-CLASSIC-LASH-TRAINING",
      title: "Classic Lash Training",
    },
    programSnapshot: {
      id: "classic-lash-training",
      slug: "classic-lash-training",
      title: "Classic Lash Training",
    },
    staffAlertedAt: null,
    tokenExpiresAt: null,
  };
}
