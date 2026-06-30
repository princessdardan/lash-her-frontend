import assert from "node:assert/strict";
import test from "node:test";

import type { NoShowChargeStatus } from "@/lib/private-db/schema";
import type {
  SquareCreateInvoiceRequest,
  SquareCreateOrderRequest,
  SquareGetInvoiceResponse,
  SquareInvoicesClient,
} from "@/lib/payments/square/invoice-client";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";

import {
  chargeNoShowInvoice,
  createDraftNoShowInvoice,
  NoShowInvoiceAmountError,
  STALE_CHARGE_PENDING_MS,
  type CreateDraftNoShowInvoiceInput,
  type CreateDraftNoShowInvoiceRepository,
  type NoShowChargeRecordDetail,
  type NoShowInvoiceRepository,
} from "./service-no-show-invoice";

const input: CreateDraftNoShowInvoiceInput = {
  cardId: "card_123",
  customerEmail: "client@example.com",
  customerId: "customer_123",
  holdId: "hold-internal-1",
  idempotencyKey: "no-show-invoice-idem-1",
  maxChargeCents: 15000,
  noShowChargeRecordId: "nsr-local-1",
  serviceDescription: "Classic Fill",
};

function createFakeRepository(
  initialRecords: Array<{
    id: string;
    status: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    maxChargeCents?: number;
    currency?: string;
    chargedAt?: Date;
    updatedAt?: Date;
  }> = [
    {
      id: "nsr-local-1",
      status: "ready",
      maxChargeCents: 15000,
      currency: "CAD",
    },
  ],
): {
  repository: CreateDraftNoShowInvoiceRepository;
  records: typeof initialRecords;
  updateCalls: unknown[];
} {
  const records = initialRecords.map((r) => ({ ...r }));
  const updateCalls: unknown[] = [];

  return {
    repository: {
      async updateNoShowChargeRecord(update: {
        noShowChargeRecordId: string;
        status?: NoShowChargeStatus;
        squareInvoiceId?: string;
        squareOrderId?: string;
        squarePaymentId?: string;
        providerStatus?: string;
        providerFailureReason?: string;
        providerMetadata?: Record<string, unknown>;
        chargedAt?: Date;
        updatedAt?: Date;
      }) {
        updateCalls.push(update);
        const record = records.find(
          (r) => r.id === update.noShowChargeRecordId,
        );
        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }
        if (update.status !== undefined) record.status = update.status;
        if (update.squareInvoiceId !== undefined)
          record.squareInvoiceId = update.squareInvoiceId;
        if (update.squareOrderId !== undefined)
          record.squareOrderId = update.squareOrderId;
        if (update.squarePaymentId !== undefined)
          record.squarePaymentId = update.squarePaymentId;
        if (update.providerStatus !== undefined)
          record.providerStatus = update.providerStatus;
        if (update.providerFailureReason !== undefined)
          record.providerFailureReason = update.providerFailureReason;
        if (update.providerMetadata !== undefined)
          record.providerMetadata = update.providerMetadata;
        if (update.chargedAt !== undefined) record.chargedAt = update.chargedAt;
        if (update.updatedAt !== undefined) record.updatedAt = update.updatedAt;
        return { id: record.id, status: record.status };
      },
    },
    records,
    updateCalls,
  };
}

function createFakeSquareInvoices(
  options: {
    orderId?: string;
    invoiceId?: string;
    invoiceStatus?: string;
    failOrder?: boolean;
    failInvoice?: boolean;
    failDelete?: boolean;
  } = {},
): {
  client: SquareInvoicesClient;
  orderCalls: SquareCreateOrderRequest[];
  invoiceCalls: SquareCreateInvoiceRequest[];
  deleteCalls: Array<{ invoiceId: string; version?: number }>;
} {
  const orderCalls: SquareCreateOrderRequest[] = [];
  const invoiceCalls: SquareCreateInvoiceRequest[] = [];
  const deleteCalls: Array<{ invoiceId: string; version?: number }> = [];

  return {
    client: {
      async createOrder(request) {
        orderCalls.push(request);
        if (options.failOrder) {
          throw new Error("Square order creation failed");
        }
        return {
          order: {
            id: options.orderId ?? "order_123",
            location_id: request.order.location_id,
          },
        };
      },
      async createInvoice(request) {
        invoiceCalls.push(request);
        if (options.failInvoice) {
          throw new Error("Square invoice creation failed");
        }
        return {
          invoice: {
            id: options.invoiceId ?? "invoice_123",
            status: options.invoiceStatus ?? "DRAFT",
            order_id: request.invoice.order_id,
            version: 1,
          },
        };
      },
      async publishInvoice() {
        throw new Error("Publish not expected in draft creation");
      },
      async getInvoice() {
        throw new Error("Get invoice not expected in draft creation");
      },
      async deleteInvoice(invoiceId, version) {
        deleteCalls.push({ invoiceId, version });
        if (options.failDelete) {
          throw new Error("Square delete invoice failed");
        }
      },
    },
    orderCalls,
    invoiceCalls,
    deleteCalls,
  };
}

test("creates Square order for full authorized no-show amount", async () => {
  const { repository } = createFakeRepository();
  const { client, orderCalls } = createFakeSquareInvoices();

  await createDraftNoShowInvoice(input, {
    locationId: "LOC123",
    repository,
    squareInvoices: client,
  });

  assert.equal(orderCalls.length, 1);
  const orderRequest = orderCalls[0];
  assert.equal(orderRequest.idempotency_key, "no-show-invoice-idem-1");
  assert.equal(orderRequest.order.location_id, "LOC123");
  assert.equal(orderRequest.order.reference_id, "hold-internal-1");
  assert.equal(orderRequest.order.source?.name, "Lash Her Booking No-Show");
  assert.equal(orderRequest.order.line_items.length, 1);
  assert.equal(orderRequest.order.line_items[0].name, "Classic Fill");
  assert.equal(orderRequest.order.line_items[0].quantity, "1");
  assert.deepEqual(orderRequest.order.line_items[0].base_price_money, {
    amount: 15000,
    currency: "CAD",
  });
});

test("creates Square invoice with EMAIL delivery method", async () => {
  const { repository } = createFakeRepository();
  const { client, invoiceCalls } = createFakeSquareInvoices();

  await createDraftNoShowInvoice(input, {
    locationId: "LOC123",
    repository,
    squareInvoices: client,
  });

  assert.equal(invoiceCalls.length, 1);
  const invoiceRequest = invoiceCalls[0];
  assert.equal(invoiceRequest.idempotency_key, "no-show-invoice-idem-1");
  assert.equal(invoiceRequest.invoice.location_id, "LOC123");
  assert.equal(invoiceRequest.invoice.delivery_method, "EMAIL");
  assert.equal(invoiceRequest.invoice.order_id, "order_123");
  assert.deepEqual(invoiceRequest.invoice.accepted_payment_methods, {
    card: true,
  });
});

test("invoice payment request uses BALANCE with CARD_ON_FILE and saved card id", async () => {
  const { repository } = createFakeRepository();
  const { client, invoiceCalls } = createFakeSquareInvoices();

  await createDraftNoShowInvoice(input, {
    locationId: "LOC123",
    repository,
    squareInvoices: client,
  });

  const invoiceRequest = invoiceCalls[0];
  assert.equal(invoiceRequest.invoice.payment_requests.length, 1);
  const paymentRequest = invoiceRequest.invoice.payment_requests[0];
  assert.equal(paymentRequest.request_type, "BALANCE");
  assert.equal(paymentRequest.automatic_payment_source, "CARD_ON_FILE");
  assert.equal(paymentRequest.card_id, "card_123");
  assert.equal(typeof paymentRequest.due_date, "string");
});

test("persists squareInvoiceId, squareOrderId, and provider_draft_created on local record", async () => {
  const { repository, records, updateCalls } = createFakeRepository();
  const { client } = createFakeSquareInvoices({
    orderId: "order_456",
    invoiceId: "invoice_456",
    invoiceStatus: "DRAFT",
  });

  const result = await createDraftNoShowInvoice(input, {
    locationId: "LOC123",
    repository,
    squareInvoices: client,
  });

  assert.equal(result.status, "provider_draft_created");
  assert.equal(result.squareOrderId, "order_456");
  assert.equal(result.squareInvoiceId, "invoice_456");

  assert.equal(updateCalls.length, 1);
  const update = updateCalls[0] as {
    status: string;
    squareInvoiceId: string;
    squareOrderId: string;
    providerStatus: string;
  };
  assert.equal(update.status, "provider_draft_created");
  assert.equal(update.squareInvoiceId, "invoice_456");
  assert.equal(update.squareOrderId, "order_456");
  assert.equal(update.providerStatus, "DRAFT");

  assert.equal(records[0].status, "provider_draft_created");
  assert.equal(records[0].squareInvoiceId, "invoice_456");
  assert.equal(records[0].squareOrderId, "order_456");
  assert.equal(records[0].providerStatus, "DRAFT");
});

test("throws NoShowInvoiceSquareApiError and does not update record when Square order creation fails", async () => {
  const { repository, updateCalls } = createFakeRepository();
  const { client } = createFakeSquareInvoices({ failOrder: true });

  await assert.rejects(
    async () =>
      createDraftNoShowInvoice(input, {
        locationId: "LOC123",
        repository,
        squareInvoices: client,
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceSquareApiError");
      assert.ok(error.message.includes("Square order creation failed"));
      return true;
    },
  );

  assert.equal(updateCalls.length, 0);
});

test("throws NoShowInvoiceBlockedError and persists squareOrderId for manual_followup when Square invoice creation fails after order succeeds", async () => {
  const { repository, records, updateCalls } = createFakeRepository();
  const { client } = createFakeSquareInvoices({
    orderId: "order_789",
    failInvoice: true,
  });

  await assert.rejects(
    async () =>
      createDraftNoShowInvoice(input, {
        locationId: "LOC123",
        repository,
        squareInvoices: client,
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      assert.ok(error.message.includes("Square invoice creation failed"));
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  const update = updateCalls[0] as {
    status: string;
    squareInvoiceId?: string;
    squareOrderId?: string;
    providerStatus?: string;
  };
  assert.equal(update.status, "manual_followup");
  assert.equal(update.squareOrderId, "order_789");
  assert.equal(update.squareInvoiceId, undefined);
  assert.equal(update.providerStatus, "invoice_creation_failed");

  assert.equal(records[0].status, "manual_followup");
  assert.equal(records[0].squareOrderId, "order_789");
  assert.equal(records[0].squareInvoiceId, undefined);
});

test("throws NoShowInvoicePersistenceError and attempts to delete DRAFT invoice when repository update fails", async () => {
  const failingRepository: CreateDraftNoShowInvoiceRepository = {
    async updateNoShowChargeRecord() {
      throw new Error("Database write failed");
    },
  };
  const { client, deleteCalls } = createFakeSquareInvoices({
    invoiceStatus: "DRAFT",
  });

  await assert.rejects(
    async () =>
      createDraftNoShowInvoice(input, {
        locationId: "LOC123",
        repository: failingRepository,
        squareInvoices: client,
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoicePersistenceError");
      assert.ok(error.message.includes("Database write failed"));
      const persistenceError = error as Error & {
        context?: {
          squareInvoiceId?: string;
          squareOrderId?: string;
          deleteFailed?: boolean;
          providerStatus?: string;
        };
      };
      assert.equal(persistenceError.context?.squareInvoiceId, "invoice_123");
      assert.equal(persistenceError.context?.squareOrderId, "order_123");
      assert.equal(persistenceError.context?.providerStatus, "DRAFT");
      assert.equal(persistenceError.context?.deleteFailed, false);
      return true;
    },
  );

  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].invoiceId, "invoice_123");
  assert.equal(deleteCalls[0].version, 1);
});

test("throws NoShowInvoicePersistenceError even when delete compensation fails", async () => {
  const failingRepository: CreateDraftNoShowInvoiceRepository = {
    async updateNoShowChargeRecord() {
      throw new Error("Database write failed");
    },
  };
  const { client, deleteCalls } = createFakeSquareInvoices({
    invoiceStatus: "DRAFT",
    failDelete: true,
  });

  await assert.rejects(
    async () =>
      createDraftNoShowInvoice(input, {
        locationId: "LOC123",
        repository: failingRepository,
        squareInvoices: client,
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoicePersistenceError");
      assert.ok(error.message.includes("Database write failed"));
      const persistenceError = error as Error & {
        context?: {
          squareInvoiceId?: string;
          squareOrderId?: string;
          deleteFailed?: boolean;
          providerStatus?: string;
        };
      };
      assert.equal(persistenceError.context?.squareInvoiceId, "invoice_123");
      assert.equal(persistenceError.context?.squareOrderId, "order_123");
      assert.equal(persistenceError.context?.providerStatus, "DRAFT");
      assert.equal(persistenceError.context?.deleteFailed, true);
      return true;
    },
  );

  assert.equal(deleteCalls.length, 1);
});

test("persists manual_followup provider refs for unexpected non-DRAFT invoice status and throws blocked", async () => {
  const { repository, records, updateCalls } = createFakeRepository();
  const { client } = createFakeSquareInvoices({ invoiceStatus: "UNPAID" });

  await assert.rejects(
    async () =>
      createDraftNoShowInvoice(input, {
        locationId: "LOC123",
        repository,
        squareInvoices: client,
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      assert.ok(error.message.includes("UNPAID"));
      return true;
    },
  );

  assert.equal(updateCalls.length, 1);
  const update = updateCalls[0] as {
    status: string;
    squareInvoiceId: string;
    squareOrderId: string;
    providerStatus: string;
  };
  assert.equal(update.status, "manual_followup");
  assert.equal(update.squareInvoiceId, "invoice_123");
  assert.equal(update.squareOrderId, "order_123");
  assert.equal(update.providerStatus, "UNPAID");

  assert.equal(records[0].status, "manual_followup");
  assert.equal(records[0].squareInvoiceId, "invoice_123");
  assert.equal(records[0].squareOrderId, "order_123");
  assert.equal(records[0].providerStatus, "UNPAID");
});

test("throws NoShowInvoiceBlockedError when persistence of manual_followup refs for non-DRAFT status fails", async () => {
  const failingRepository: CreateDraftNoShowInvoiceRepository = {
    async updateNoShowChargeRecord() {
      throw new Error("Database write failed");
    },
  };
  const { client } = createFakeSquareInvoices({ invoiceStatus: "UNPAID" });

  await assert.rejects(
    async () =>
      createDraftNoShowInvoice(input, {
        locationId: "LOC123",
        repository: failingRepository,
        squareInvoices: client,
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceBlockedError");
      return true;
    },
  );
});

const chargeInputBase = {
  amountCents: 15000,
  idempotencyKey: "charge-idem-1",
  noShowChargeRecordId: "nsr-local-1",
  operatorId: "staff-nataliea",
  reason: "Client did not arrive",
};
function createChargeRepository(
  initialRecord: {
    id: string;
    status: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    squareCardId?: string;
    maxChargeCents: number;
    currency: string;
    providerStatus?: string;
    providerMetadata?: Record<string, unknown>;
    providerFailureReason?: string;
    chargedAt?: Date;
    updatedAt?: Date;
  },
  options: {
    sharedCallOrder?: Array<{
      type: "update" | "publish" | "attempt-update" | "admin-action";
      payload?: unknown;
    }>;
  } = {},
): {
  repository: NoShowInvoiceRepository;
  records: Array<{
    id: string;
    status: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    squareCardId?: string;
    maxChargeCents: number;
    currency: string;
    providerStatus?: string;
    providerMetadata?: Record<string, unknown>;
    providerFailureReason?: string;
    chargedAt?: Date;
    updatedAt?: Date;
  }>;
  adminActions: Array<{
    noShowChargeRecordId: string;
    operatorId: string;
    reason: string;
    now: Date;
  }>;
  attempts: Array<{
    id: string;
    noShowChargeRecordId: string;
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    status?: string;
    squarePaymentId?: string;
    squareInvoiceId?: string;
    failureReason?: string;
    processedAt?: Date;
    createdAt?: Date;
  }>;
  updateCalls: unknown[];
  callOrder: Array<{
    type: "update" | "publish" | "attempt-update" | "admin-action";
    payload?: unknown;
  }>;
} {
  const records = [{ ...initialRecord }];
  const adminActions: Array<{
    noShowChargeRecordId: string;
    operatorId: string;
    reason: string;
    now: Date;
  }> = [];
  const attempts: Array<{
    id: string;
    noShowChargeRecordId: string;
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    status?: string;
    squarePaymentId?: string;
    squareInvoiceId?: string;
    failureReason?: string;
    processedAt?: Date;
    createdAt?: Date;
  }> = [];
  const updateCalls: unknown[] = [];
  const callOrder = options.sharedCallOrder ?? [];

  return {
    records,
    adminActions,
    attempts,
    updateCalls,
    callOrder,
    repository: {
      async getNoShowChargeRecordById(noShowChargeRecordId: string) {
        const record = records.find((r) => r.id === noShowChargeRecordId);
        if (record === undefined) return null;
        return {
          id: record.id,
          status: record.status,
          squareInvoiceId: record.squareInvoiceId,
          squareOrderId: record.squareOrderId,
          squarePaymentId: record.squarePaymentId,
          squareCardId: record.squareCardId,
          maxChargeCents: record.maxChargeCents,
          currency: record.currency,
          providerStatus: record.providerStatus,
          providerMetadata: record.providerMetadata,
          updatedAt: record.updatedAt,
        };
      },
      async recordNoShowAdminAction(input: {
        noShowChargeRecordId: string;
        operatorId: string;
        reason: string;
        now: Date;
      }) {
        adminActions.push(input);
        callOrder.push({ type: "admin-action" });
        return { recorded: true };
      },
      async updateNoShowChargeRecord(update: {
        noShowChargeRecordId: string;
        status?: NoShowChargeStatus;
        squareInvoiceId?: string;
        squareOrderId?: string;
        squarePaymentId?: string;
        providerStatus?: string;
        providerFailureReason?: string;
        providerMetadata?: Record<string, unknown>;
        chargedAt?: Date;
        updatedAt?: Date;
      }) {
        updateCalls.push(update);
        callOrder.push({ type: "update", payload: update.status });
        const record = records.find(
          (r) => r.id === update.noShowChargeRecordId,
        );
        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }
        if (update.status !== undefined) record.status = update.status;
        if (update.squareInvoiceId !== undefined)
          record.squareInvoiceId = update.squareInvoiceId;
        if (update.squareOrderId !== undefined)
          record.squareOrderId = update.squareOrderId;
        if (update.squarePaymentId !== undefined)
          record.squarePaymentId = update.squarePaymentId;
        if (update.providerStatus !== undefined)
          record.providerStatus = update.providerStatus;
        if (update.providerFailureReason !== undefined)
          record.providerFailureReason = update.providerFailureReason;
        if (update.providerMetadata !== undefined)
          record.providerMetadata = update.providerMetadata;
        if (update.chargedAt !== undefined) record.chargedAt = update.chargedAt;
        if (update.updatedAt !== undefined) record.updatedAt = update.updatedAt;
        return { id: record.id, status: record.status };
      },
      async updateNoShowChargeRecordIfNotTerminal(update: {
        noShowChargeRecordId: string;
        status?: NoShowChargeStatus;
        squareInvoiceId?: string;
        squareOrderId?: string;
        squarePaymentId?: string;
        providerStatus?: string;
        providerFailureReason?: string;
        providerMetadata?: Record<string, unknown>;
        chargedAt?: Date;
      }) {
        updateCalls.push(update);
        callOrder.push({ type: "update", payload: update.status });
        const record = records.find(
          (r) => r.id === update.noShowChargeRecordId,
        );
        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }
        if (record.status === "charged" || record.status === "charge_failed") {
          throw new Error(
            "No-show charge record not found or is already in a terminal state",
          );
        }
        if (update.status !== undefined) record.status = update.status;
        if (update.squareInvoiceId !== undefined)
          record.squareInvoiceId = update.squareInvoiceId;
        if (update.squareOrderId !== undefined)
          record.squareOrderId = update.squareOrderId;
        if (update.squarePaymentId !== undefined)
          record.squarePaymentId = update.squarePaymentId;
        if (update.providerStatus !== undefined)
          record.providerStatus = update.providerStatus;
        if (update.providerFailureReason !== undefined)
          record.providerFailureReason = update.providerFailureReason;
        if (update.providerMetadata !== undefined)
          record.providerMetadata = update.providerMetadata;
        if (update.chargedAt !== undefined) record.chargedAt = update.chargedAt;
        return { id: record.id, status: record.status };
      },
      async updateNoShowChargeRecordIfExpectedState(update: {
        noShowChargeRecordId: string;
        expectedStatus: NoShowChargeStatus;
        expectedProviderStatus?: string;
        expectedSquareInvoiceId?: string;
        expectedUpdatedAt?: Date;
        status?: NoShowChargeStatus;
        squareInvoiceId?: string;
        squareOrderId?: string;
        squarePaymentId?: string;
        providerStatus?: string;
        providerFailureReason?: string;
        providerMetadata?: Record<string, unknown>;
        chargedAt?: Date;
      }) {
        updateCalls.push(update);
        callOrder.push({ type: "update", payload: update.status });
        const record = records.find(
          (r) => r.id === update.noShowChargeRecordId,
        );
        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }
        if (record.status !== update.expectedStatus) {
          throw new Error(
            "No-show charge record is no longer in the expected state",
          );
        }
        if (
          update.expectedProviderStatus !== undefined &&
          record.providerStatus !== update.expectedProviderStatus
        ) {
          throw new Error(
            "No-show charge record is no longer in the expected state",
          );
        }
        if (
          update.expectedSquareInvoiceId !== undefined &&
          record.squareInvoiceId !== update.expectedSquareInvoiceId
        ) {
          throw new Error(
            "No-show charge record is no longer in the expected state",
          );
        }
        if (
          update.expectedUpdatedAt !== undefined &&
          record.updatedAt?.getTime() !== update.expectedUpdatedAt.getTime()
        ) {
          throw new Error(
            "No-show charge record is no longer in the expected state",
          );
        }
        if (update.status !== undefined) record.status = update.status;
        if (update.squareInvoiceId !== undefined)
          record.squareInvoiceId = update.squareInvoiceId;
        if (update.squareOrderId !== undefined)
          record.squareOrderId = update.squareOrderId;
        if (update.squarePaymentId !== undefined)
          record.squarePaymentId = update.squarePaymentId;
        if (update.providerStatus !== undefined)
          record.providerStatus = update.providerStatus;
        if (update.providerFailureReason !== undefined)
          record.providerFailureReason = update.providerFailureReason;
        if (update.providerMetadata !== undefined)
          record.providerMetadata = update.providerMetadata;
        if (update.chargedAt !== undefined) record.chargedAt = update.chargedAt;
        record.updatedAt = new Date();
        return { id: record.id, status: record.status };
      },
      async findNoShowChargeAttempt({
        noShowChargeRecordId,
        idempotencyKey,
      }: {
        noShowChargeRecordId: string;
        idempotencyKey: string;
      }) {
        return (
          attempts.find(
            (a) =>
              a.noShowChargeRecordId === noShowChargeRecordId &&
              a.idempotencyKey === idempotencyKey,
          ) ?? null
        );
      },
      async createNoShowChargeAttempt(createInput: {
        noShowChargeRecordId: string;
        idempotencyKey: string;
        amountCents: number;
        currency: string;
        status: string;
        now: Date;
      }) {
        const attempt: (typeof attempts)[number] = {
          id: `attempt-${attempts.length + 1}`,
          noShowChargeRecordId: createInput.noShowChargeRecordId,
          idempotencyKey: createInput.idempotencyKey,
          amountCents: createInput.amountCents,
          currency: createInput.currency,
          status: createInput.status,
          createdAt: createInput.now,
        };
        attempts.push(attempt);
        return attempt;
      },
      async updateNoShowChargeAttempt(update: {
        attemptId: string;
        status?: string;
        squarePaymentId?: string;
        squareInvoiceId?: string;
        failureReason?: string;
        processedAt?: Date;
      }) {
        callOrder.push({ type: "attempt-update", payload: update.status });
        const attempt = attempts.find((a) => a.id === update.attemptId);
        if (attempt === undefined) {
          throw new Error("No-show charge attempt not found");
        }
        if (update.status !== undefined) attempt.status = update.status;
        if (update.squarePaymentId !== undefined)
          attempt.squarePaymentId = update.squarePaymentId;
        if (update.squareInvoiceId !== undefined)
          attempt.squareInvoiceId = update.squareInvoiceId;
        if (update.failureReason !== undefined)
          attempt.failureReason = update.failureReason;
        if (update.processedAt !== undefined)
          attempt.processedAt = update.processedAt;
        return attempt;
      },
      async claimNoShowChargeAttempt(input: {
        noShowChargeRecordId: string;
        idempotencyKey: string;
        amountCents: number;
        currency: string;
        now: Date;
      }) {
        const record = records.find((r) => r.id === input.noShowChargeRecordId);
        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }

        const existing = attempts.find(
          (a) =>
            a.noShowChargeRecordId === input.noShowChargeRecordId &&
            a.idempotencyKey === input.idempotencyKey,
        );

        if (existing !== undefined) {
          return { attempt: existing, isOwner: false, record };
        }

        if (input.amountCents !== record.maxChargeCents) {
          throw new NoShowInvoiceAmountError(
            `Amount ${input.amountCents} does not match max charge ${record.maxChargeCents} ${record.currency}`,
            { allowedAmountCents: record.maxChargeCents },
          );
        }

        let status: string;
        let isOwner = false;
        let squarePaymentId: string | undefined;
        let failureReason: string | undefined;

        if (record.status === "provider_draft_created") {
          status = "charge_pending";
          isOwner = true;
          record.status = "charge_pending";
          record.providerStatus = "publish_pending";
          record.updatedAt = input.now;
          updateCalls.push({
            noShowChargeRecordId: record.id,
            status: "charge_pending",
            providerStatus: "publish_pending",
          });
          callOrder.push({ type: "update", payload: "charge_pending" });
        } else if (record.status === "charge_pending") {
          status = "charge_pending";
        } else if (record.status === "charged") {
          status = "charged";
          squarePaymentId = record.squarePaymentId;
        } else if (record.status === "charge_failed") {
          status = "charge_failed";
          failureReason = record.providerFailureReason;
        } else {
          status = "manual_followup";
        }

        const attempt: (typeof attempts)[number] = {
          id: `attempt-${attempts.length + 1}`,
          noShowChargeRecordId: input.noShowChargeRecordId,
          idempotencyKey: input.idempotencyKey,
          amountCents: input.amountCents,
          currency: input.currency,
          status,
          squarePaymentId,
          failureReason,
          createdAt: input.now,
        };
        attempts.push(attempt);

        return { attempt, isOwner, record };
      },
      async recoverStaleNoShowChargePending({
        noShowChargeRecordId,
        now,
        expectedSquareInvoiceId,
        expectedUpdatedAt,
      }: {
        noShowChargeRecordId: string;
        now: Date;
        expectedSquareInvoiceId?: string;
        expectedUpdatedAt?: Date;
      }) {
        const record = records.find((r) => r.id === noShowChargeRecordId);
        if (record === undefined) return null;
        if (
          record.status !== "charge_pending" ||
          record.providerStatus !== "publish_pending"
        ) {
          return null;
        }
        if (
          record.updatedAt === undefined ||
          now.getTime() - record.updatedAt.getTime() < STALE_CHARGE_PENDING_MS
        ) {
          return null;
        }
        if (
          expectedSquareInvoiceId !== undefined &&
          record.squareInvoiceId !== expectedSquareInvoiceId
        ) {
          return null;
        }
        if (
          expectedUpdatedAt !== undefined &&
          record.updatedAt.getTime() !== expectedUpdatedAt.getTime()
        ) {
          return null;
        }

        updateCalls.push({
          noShowChargeRecordId: record.id,
          status: "provider_draft_created",
          providerStatus: "DRAFT",
        });
        record.status = "provider_draft_created";
        record.providerStatus = "DRAFT";
        record.updatedAt = now;

        return {
          id: record.id,
          status: record.status,
          squareInvoiceId: record.squareInvoiceId,
          squareOrderId: record.squareOrderId,
          squarePaymentId: record.squarePaymentId,
          squareCardId: record.squareCardId,
          maxChargeCents: record.maxChargeCents,
          currency: record.currency,
          providerStatus: record.providerStatus,
          providerMetadata: record.providerMetadata,
          updatedAt: record.updatedAt,
        };
      },
    },
  };
}
function createChargeSquareInvoices(
  options: {
    publishStatus?: string;
    paymentId?: string;
    failPublish?: boolean;
    getInvoiceResponse?: SquareGetInvoiceResponse;
    sharedCallOrder?: Array<{
      type: "update" | "publish" | "attempt-update" | "admin-action";
      payload?: unknown;
    }>;
  } = {},
): {
  client: SquareInvoicesClient;
  publishCalls: Array<{
    invoiceId: string;
    request: { idempotency_key: string; version: number };
  }>;
  getInvoiceCalls: string[];
  getInvoiceResponse: SquareGetInvoiceResponse | undefined;
} {
  const publishCalls: Array<{
    invoiceId: string;
    request: { idempotency_key: string; version: number };
  }> = [];
  const getInvoiceCalls: string[] = [];
  const callOrder = options.sharedCallOrder ?? [];
  let getInvoiceResponse: SquareGetInvoiceResponse | undefined =
    options.getInvoiceResponse;

  return {
    client: {
      async createOrder() {
        throw new Error("Order creation not expected during charge");
      },
      async createInvoice() {
        throw new Error("Invoice creation not expected during charge");
      },
      async publishInvoice(invoiceId, request) {
        callOrder.push({ type: "publish" });
        publishCalls.push({ invoiceId, request });
        if (options.failPublish) {
          throw new Error("Square invoice publish declined");
        }
        return {
          invoice: {
            id: invoiceId,
            status: options.publishStatus ?? "PAID",
            order_id: "order_123",
            version: 2,
            ...(options.paymentId !== undefined
              ? { payment_id: options.paymentId }
              : {}),
          },
        };
      },
      async getInvoice(invoiceId) {
        getInvoiceCalls.push(invoiceId);
        if (getInvoiceResponse === undefined) {
          throw new Error("Get invoice not expected during charge");
        }
        return getInvoiceResponse;
      },
      async deleteInvoice() {
        throw new Error("Delete not expected during charge");
      },
    },
    publishCalls,
    getInvoiceCalls,
    get getInvoiceResponse() {
      return getInvoiceResponse;
    },
    set getInvoiceResponse(value) {
      getInvoiceResponse = value;
    },
  };
}

function createChargeAlerts(): ServicePaymentAlertLogger & {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    alert(input) {
      calls.push(input);
    },
    get calls() {
      return calls;
    },
  };
}

function createNoShowInvoiceFixture(options: {
  recordStatus: NoShowChargeStatus;
  providerStatus?: string;
  updatedAt?: Date;
  squareInvoiceId?: string;
  squareOrderId?: string;
  providerMetadata?: Record<string, unknown>;
  maxChargeCents?: number;
  currency?: string;
}) {
  const recordBase = {
    id: "nsr-local-1",
    status: options.recordStatus,
    providerStatus: options.providerStatus,
    updatedAt: options.updatedAt,
    squareInvoiceId:
      "squareInvoiceId" in options ? options.squareInvoiceId : "invoice_123",
    squareOrderId: options.squareOrderId ?? "order_123",
    maxChargeCents: options.maxChargeCents ?? 15000,
    currency: options.currency ?? "CAD",
    providerMetadata: options.providerMetadata ?? { squareInvoiceVersion: 2 },
  };
  const { repository, records, adminActions, attempts, updateCalls } =
    createChargeRepository(recordBase);
  const squareInvoices = createChargeSquareInvoices({
    publishStatus: "UNPAID",
  });
  const alerts = createChargeAlerts();

  squareInvoices.getInvoiceResponse = {
    invoice: {
      id: recordBase.squareInvoiceId ?? "missing-invoice",
      status: "DRAFT",
      order_id: recordBase.squareOrderId,
      version: 2,
    },
  };

  return {
    record: records[0] as NoShowChargeRecordDetail,
    records,
    repository,
    adminActions,
    attempts,
    updateCalls,
    squareInvoices,
    alerts,
    dependencies: {
      repository,
      squareInvoices: squareInvoices.client,
      alerts,
      now: new Date(),
    },
  };
}

test("transitions local record from provider_draft_created to charge_pending before Square, then to charged on immediate payment success", async () => {
  const { repository, records, updateCalls } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    squareOrderId: "order_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charged");
  assert.equal(result.squarePaymentId, "pay_123");
  assert.equal(records[0].status, "charged");
  assert.equal(updateCalls.length >= 1, true);
  const firstUpdate = updateCalls[0] as { status: string };
  assert.equal(firstUpdate.status, "charge_pending");
  assert.equal(publishCalls.length, 1);
});

test("chargeNoShowInvoice rejects missing admin operator or reason before any provider action", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    squareOrderId: "order_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, operatorId: undefined, reason: undefined },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      assert.ok(error.message.includes("operator and reason are required"));
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice rejects operatorId with whitespace before any provider action", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, operatorId: "staff nataliea" },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(adminActions.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice rejects operatorId with control characters before any provider action", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, operatorId: "staff\u0001nataliea" },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(adminActions.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice rejects oversized operatorId before any provider action", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, operatorId: "a".repeat(121) },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(adminActions.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice rejects reason that is only whitespace before any provider action", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, reason: "   " },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(adminActions.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice rejects reason with control characters before any provider action", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, reason: "Client did not arrive\u0001" },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(adminActions.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice rejects oversized reason before any provider action", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, reason: "x".repeat(501) },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceChargeError");
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(adminActions.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice normalizes whitespace around valid operatorId and reason", async () => {
  const { repository, adminActions } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    squareOrderId: "order_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(
    {
      ...chargeInputBase,
      operatorId: "  staff-nataliea  ",
      reason: "  Client did not arrive  ",
    },
    { repository, squareInvoices: client, alerts },
  );

  assert.equal(result.chargeStatus, "charged");
  assert.equal(adminActions.length, 1);
  assert.equal(adminActions[0].operatorId, "staff-nataliea");
  assert.equal(adminActions[0].reason, "Client did not arrive");
});

test("chargeNoShowInvoice records admin action before Square publish", async () => {
  const now = new Date("2026-06-21T10:00:00Z");
  const callOrder: Array<{
    type: "update" | "publish" | "attempt-update" | "admin-action";
    payload?: unknown;
  }> = [];
  const { repository, records, adminActions } = createChargeRepository(
    {
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    },
    { sharedCallOrder: callOrder },
  );
  const { client } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
    sharedCallOrder: callOrder,
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(
    {
      amountCents: 15000,
      idempotencyKey: "admin-action-before-publish",
      noShowChargeRecordId: "nsr-local-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend the appointment.",
    },
    { repository, squareInvoices: client, alerts, now },
  );

  assert.equal(result.chargeStatus, "charged");
  assert.equal(result.squarePaymentId, "pay_123");
  assert.equal(adminActions.length, 1);
  assert.deepEqual(adminActions[0], {
    noShowChargeRecordId: "nsr-local-1",
    operatorId: "staff-nataliea",
    reason: "Client did not attend the appointment.",
    now,
  });
  const adminActionIndex = callOrder.findIndex(
    (c) => c.type === "admin-action",
  );
  const publishIndex = callOrder.findIndex((c) => c.type === "publish");
  assert.ok(adminActionIndex >= 0, "admin-action was recorded");
  assert.ok(
    publishIndex > adminActionIndex,
    "publish happens after admin-action",
  );
  assert.equal(records[0].status, "charged");
});

test("chargeNoShowInvoice does not publish or claim when admin action persistence fails", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    squareOrderId: "order_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  repository.recordNoShowAdminAction = async () => {
    throw new Error("Admin action persistence failed");
  };
  const originalClaim = repository.claimNoShowChargeAttempt.bind(repository);
  let claimCalled = false;
  repository.claimNoShowChargeAttempt = async (
    input: Parameters<typeof repository.claimNoShowChargeAttempt>[0],
  ) => {
    claimCalled = true;
    return originalClaim(input);
  };
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(chargeInputBase, {
        repository,
        squareInvoices: client,
        alerts,
      }),
    (error: Error) => {
      assert.ok(error.message.includes("Admin action persistence failed"));
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  // Audit is now persisted before the atomic claim, so a failed audit leaves
  // the record untouched and no attempt is created.
  assert.equal(claimCalled, false);
  assert.equal(attempts.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("chargeNoShowInvoice returns existing attempt when admin action was already recorded", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const originalAudit = {
    noShowChargeRecordId: "nsr-local-1",
    operatorId: "staff-nataliea",
    reason: "Client did not attend",
    now: new Date("2026-06-21T10:00:00Z"),
  };
  adminActions.push(originalAudit);
  attempts.push({
    id: "attempt-1",
    noShowChargeRecordId: "nsr-local-1",
    idempotencyKey: chargeInputBase.idempotencyKey,
    amountCents: 15000,
    currency: "CAD",
    status: "charge_pending",
  });
  repository.recordNoShowAdminAction = async () => {
    return { recorded: false };
  };
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(records[0].status, "provider_draft_created");
  assert.equal(adminActions.length, 1);
  assert.deepEqual(adminActions[0], originalAudit);
});

test("chargeNoShowInvoice does not claim or publish when admin action was already recorded and no attempt exists", async () => {
  const { repository, records, attempts, adminActions } =
    createChargeRepository({
      id: "nsr-local-1",
      status: "provider_draft_created",
      squareInvoiceId: "invoice_123",
      squareOrderId: "order_123",
      maxChargeCents: 15000,
      currency: "CAD",
      providerMetadata: { squareInvoiceVersion: 2 },
    });
  const originalAudit = {
    noShowChargeRecordId: "nsr-local-1",
    operatorId: "staff-nataliea",
    reason: "Client did not attend",
    now: new Date("2026-06-21T10:00:00Z"),
  };
  adminActions.push(originalAudit);
  repository.recordNoShowAdminAction = async () => {
    return { recorded: false };
  };
  const originalClaim = repository.claimNoShowChargeAttempt.bind(repository);
  let claimCalled = false;
  repository.claimNoShowChargeAttempt = async (
    input: Parameters<typeof repository.claimNoShowChargeAttempt>[0],
  ) => {
    claimCalled = true;
    return originalClaim(input);
  };
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(chargeInputBase, {
        repository,
        squareInvoices: client,
        alerts,
      }),
    (error: Error) => {
      assert.ok(
        error.message.includes("No-show admin action already recorded"),
      );
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(claimCalled, false);
  assert.equal(attempts.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
  assert.equal(adminActions.length, 1);
  assert.deepEqual(adminActions[0], originalAudit);
});

test("publishes invoice with idempotency key", async () => {
  const { repository } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].invoiceId, "invoice_123");
  assert.equal(publishCalls[0].request.idempotency_key, "charge-idem-1");
  assert.equal(publishCalls[0].request.version, 2);
});

test("records charged when Square returns immediate payment success data", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charged");
  assert.equal(result.squarePaymentId, "pay_123");
  assert.equal(records[0].status, "charged");
  assert.equal(records[0].squarePaymentId, "pay_123");
  assert.equal(records[0].providerStatus, "PAID");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charged");
  assert.equal(attempts[0].squarePaymentId, "pay_123");
});

test("fresh publish PAID without payment id persists manual_followup and alerts", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client } = createChargeSquareInvoices({ publishStatus: "PAID" });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(records[0].status, "manual_followup");
  assert.equal(records[0].providerStatus, "PAID");
  assert.ok(
    typeof records[0].providerFailureReason === "string" &&
      records[0].providerFailureReason.includes("payment id"),
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_paid_without_payment_id");
  assert.equal(alert.severity, "warning");
});

test("fresh publish does not overwrite terminal record finalized by webhook during publish", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const squareInvoices = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const originalPublish = squareInvoices.client.publishInvoice;
  squareInvoices.client.publishInvoice = async (invoiceId, request) => {
    // Simulate a webhook finalizer marking the record charged while the
    // Square publish network call is still in flight.
    records[0].status = "charged";
    records[0].squarePaymentId = "webhook-pay";
    records[0].providerStatus = "PAID";
    records[0].updatedAt = new Date();
    return originalPublish(invoiceId, request);
  };
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: squareInvoices.client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.ok(
    typeof result.failureReason === "string" &&
      result.failureReason.includes("expected state"),
  );
  assert.equal(records[0].status, "charged");
  assert.equal(records[0].squarePaymentId, "webhook-pay");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charged");
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_finalize_failed");
  assert.equal(alert.severity, "error");
});

test("fresh missing provider reference fallback does not overwrite terminal charged record when CAS fails", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    // Missing squareInvoiceId and invoice version triggers the missing-provider-reference fallback.
    maxChargeCents: 15000,
    currency: "CAD",
  });
  const originalClaim = repository.claimNoShowChargeAttempt.bind(repository);
  repository.claimNoShowChargeAttempt = async (
    input: Parameters<typeof repository.claimNoShowChargeAttempt>[0],
  ) => {
    const result = await originalClaim(input);
    if (result.isOwner) {
      // Simulate a webhook finalizer marking the record charged after the
      // atomic claim but before the missing-provider-reference fallback write.
      records[0].status = "charged";
      records[0].squarePaymentId = "webhook-pay";
      records[0].providerStatus = "PAID";
      records[0].updatedAt = new Date();
    }
    return result;
  };
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(records[0].status, "charged");
  assert.equal(records[0].squarePaymentId, "webhook-pay");
  assert.ok(
    typeof result.failureReason === "string" &&
      result.failureReason.includes("expected state"),
  );
  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "manual_followup");
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
});

test("fresh missing provider reference fallback persists manual_followup when CAS succeeds", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    // Missing squareInvoiceId and invoice version triggers the missing-provider-reference fallback.
    maxChargeCents: 15000,
    currency: "CAD",
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(
    result.failureReason,
    "No Square draft invoice reference available for publish",
  );
  assert.equal(records[0].status, "manual_followup");
  assert.equal(
    records[0].providerFailureReason,
    "No Square draft invoice reference available for publish",
  );
  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "manual_followup");
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_failed");
  assert.equal(alert.severity, "warning");
});

test("records charge_failed with failure reason and alert when Square returns terminal failure status", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client } = createChargeSquareInvoices({ publishStatus: "CANCELED" });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charge_failed");
  assert.ok(result.failureReason?.includes("CANCELED"));
  assert.equal(records[0].status, "charge_failed");
  assert.ok(records[0].providerFailureReason?.includes("CANCELED"));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_failed");
  assert.ok(attempts[0].failureReason?.includes("CANCELED"));
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_failed");
  assert.equal(alert.severity, "warning");
});

test("keeps charge_pending for ambiguous UNPAID publish status without marking failed", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client } = createChargeSquareInvoices({ publishStatus: "UNPAID" });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(records[0].status, "charge_pending");
  assert.equal(records[0].providerStatus, "UNPAID");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(attempts[0].squareInvoiceId, "invoice_123");
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_pending_reconciliation");
  assert.equal(alert.severity, "warning");
});

test("repeated idempotency key returns existing attempt and does not publish twice or overwrite audit", async () => {
  const { repository, adminActions } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  // Simulate the real repository's no-overwrite semantics for replays.
  const originalRecordNoShowAdminAction =
    repository.recordNoShowAdminAction.bind(repository);
  let auditRecorded = false;
  repository.recordNoShowAdminAction = async (
    input: Parameters<typeof repository.recordNoShowAdminAction>[0],
  ) => {
    if (auditRecorded) {
      return { recorded: false };
    }
    auditRecorded = true;
    return originalRecordNoShowAdminAction(input);
  };
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();
  const deps = { repository, squareInvoices: client, alerts };

  const first = await chargeNoShowInvoice(chargeInputBase, deps);
  assert.equal(first.chargeStatus, "charged");
  assert.equal(first.squarePaymentId, "pay_123");
  assert.equal(adminActions.length, 1);

  const second = await chargeNoShowInvoice(chargeInputBase, deps);
  assert.equal(second.chargeStatus, "charged");
  assert.equal(second.squarePaymentId, "pay_123");

  assert.equal(publishCalls.length, 1);
  assert.equal(adminActions.length, 1);
});

test("rejects lower amount with no Square call and no attempt; exposes allowed amount", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, amountCents: 14000 },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceAmountError");
      const amountError = error as NoShowInvoiceAmountError;
      assert.equal(amountError.context?.allowedAmountCents, 15000);
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("rejects higher amount with no Square call and no attempt; exposes allowed amount", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  await assert.rejects(
    async () =>
      chargeNoShowInvoice(
        { ...chargeInputBase, amountCents: 20000 },
        { repository, squareInvoices: client, alerts },
      ),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceAmountError");
      const amountError = error as NoShowInvoiceAmountError;
      assert.equal(amountError.context?.allowedAmountCents, 15000);
      return true;
    },
  );

  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
});

test("repository atomic claim rejects amount mismatch against locked record", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });

  await assert.rejects(
    async () =>
      repository.claimNoShowChargeAttempt({
        noShowChargeRecordId: "nsr-local-1",
        idempotencyKey: "claim-mismatch-1",
        amountCents: 14000,
        currency: "CAD",
        now: new Date(),
      }),
    (error: Error) => {
      assert.equal(error.name, "NoShowInvoiceAmountError");
      const amountError = error as NoShowInvoiceAmountError;
      assert.equal(amountError.context?.allowedAmountCents, 15000);
      return true;
    },
  );

  assert.equal(attempts.length, 0);
  assert.equal(records[0].status, "provider_draft_created");
  assert.equal(records[0].providerStatus, undefined);
});

test("does not publish when record already charge_pending with different idempotency key", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "charge_pending",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(
    { ...chargeInputBase, idempotencyKey: "charge-idem-different" },
    { repository, squareInvoices: client, alerts },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(publishCalls.length, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(records[0].status, "charge_pending");
});

test("publish throw returns charge_pending and alert", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  const { client, publishCalls } = createChargeSquareInvoices({
    failPublish: true,
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(records[0].status, "charge_pending");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(publishCalls.length, 1);
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_publish_unknown");
  assert.equal(alert.severity, "warning");
});

test("PAID + payment id + finalize failure returns manual_followup and alert", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });

  // Force local persistence to fail once the Square publish succeeds.
  const originalUpdateNoShowChargeRecordIfExpectedState =
    repository.updateNoShowChargeRecordIfExpectedState.bind(repository);
  repository.updateNoShowChargeRecordIfExpectedState = async (update: {
    noShowChargeRecordId: string;
    expectedStatus: NoShowChargeStatus;
    expectedProviderStatus?: string;
    expectedSquareInvoiceId?: string;
    expectedUpdatedAt?: Date;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    chargedAt?: Date;
  }) => {
    if (update.status === "charged") {
      throw new Error("Database write failed after Square charge");
    }
    return originalUpdateNoShowChargeRecordIfExpectedState(update);
  };

  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
    paymentId: "pay_123",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(publishCalls.length, 1);
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as { category: string; severity: string };
  assert.equal(alert.category, "no_show_charge_finalize_failed");
  assert.equal(alert.severity, "error");
  assert.equal(records[0].status, "charge_pending");
  assert.equal(attempts.length, 1);
});

test("terminal failure status + record persistence failure returns manual_followup and emits alert", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });

  const originalUpdateNoShowChargeRecordIfExpectedState =
    repository.updateNoShowChargeRecordIfExpectedState.bind(repository);
  repository.updateNoShowChargeRecordIfExpectedState = async (update: {
    noShowChargeRecordId: string;
    expectedStatus: NoShowChargeStatus;
    expectedProviderStatus?: string;
    expectedSquareInvoiceId?: string;
    expectedUpdatedAt?: Date;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    chargedAt?: Date;
  }) => {
    if (update.status === "charge_failed") {
      throw new Error("Database write failed after terminal Square status");
    }
    return originalUpdateNoShowChargeRecordIfExpectedState(update);
  };

  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "CANCELED",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.ok(result.failureReason?.includes("Database write failed"));
  assert.equal(publishCalls.length, 1);
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as {
    category: string;
    severity: string;
    context?: Record<string, unknown>;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
  assert.equal(alert.context?.noShowChargeRecordId, "nsr-local-1");
  assert.equal(alert.context?.squareInvoiceId, "invoice_123");
  assert.equal(alert.context?.providerStatus, "CANCELED");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_failed");
  assert.equal(records[0].status, "charge_pending");
});

test("ambiguous UNPAID status + record persistence failure returns charge_pending and emits alert", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });

  const originalUpdateNoShowChargeRecordIfExpectedState =
    repository.updateNoShowChargeRecordIfExpectedState.bind(repository);
  repository.updateNoShowChargeRecordIfExpectedState = async (update: {
    noShowChargeRecordId: string;
    expectedStatus: NoShowChargeStatus;
    expectedProviderStatus?: string;
    expectedSquareInvoiceId?: string;
    expectedUpdatedAt?: Date;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    chargedAt?: Date;
  }) => {
    if (update.providerStatus === "UNPAID") {
      throw new Error("Database write failed after UNPAID Square status");
    }
    return originalUpdateNoShowChargeRecordIfExpectedState(update);
  };

  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "UNPAID",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "charge_pending");
  assert.ok(result.failureReason?.includes("Database write failed"));
  assert.equal(publishCalls.length, 1);
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as {
    category: string;
    severity: string;
    context?: Record<string, unknown>;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
  assert.equal(alert.context?.noShowChargeRecordId, "nsr-local-1");
  assert.equal(alert.context?.squareInvoiceId, "invoice_123");
  assert.equal(alert.context?.providerStatus, "UNPAID");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(records[0].status, "charge_pending");
});

test("PAID without payment id + record persistence failure returns manual_followup and emits alert", async () => {
  const { repository, records, attempts } = createChargeRepository({
    id: "nsr-local-1",
    status: "provider_draft_created",
    squareInvoiceId: "invoice_123",
    maxChargeCents: 15000,
    currency: "CAD",
    providerMetadata: { squareInvoiceVersion: 2 },
  });

  const originalUpdateNoShowChargeRecordIfExpectedState =
    repository.updateNoShowChargeRecordIfExpectedState.bind(repository);
  repository.updateNoShowChargeRecordIfExpectedState = async (update: {
    noShowChargeRecordId: string;
    expectedStatus: NoShowChargeStatus;
    expectedProviderStatus?: string;
    expectedSquareInvoiceId?: string;
    expectedUpdatedAt?: Date;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    chargedAt?: Date;
  }) => {
    if (
      update.status === "manual_followup" &&
      update.providerStatus === "PAID"
    ) {
      throw new Error(
        "Database write failed after PAID-without-payment-id Square status",
      );
    }
    return originalUpdateNoShowChargeRecordIfExpectedState(update);
  };

  const { client, publishCalls } = createChargeSquareInvoices({
    publishStatus: "PAID",
  });
  const alerts = createChargeAlerts();

  const result = await chargeNoShowInvoice(chargeInputBase, {
    repository,
    squareInvoices: client,
    alerts,
  });

  assert.equal(result.chargeStatus, "manual_followup");
  assert.ok(result.failureReason?.includes("Database write failed"));
  assert.equal(publishCalls.length, 1);
  assert.equal(alerts.calls.length, 1);
  const alert = alerts.calls[0] as {
    category: string;
    severity: string;
    context?: Record<string, unknown>;
  };
  assert.equal(alert.category, "no_show_charge_finalize_failed");
  assert.equal(alert.severity, "error");
  assert.equal(alert.context?.noShowChargeRecordId, "nsr-local-1");
  assert.equal(alert.context?.squareInvoiceId, "invoice_123");
  assert.equal(alert.context?.providerStatus, "PAID");
  assert.equal(alert.context?.squarePaymentId, undefined);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "charge_pending");
  assert.equal(records[0].status, "charge_pending");
});

test("stale charge_pending with DRAFT invoice can be reclaimed for retry", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-stale-pending",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.publishCalls.length, 1);
});

test("stale charge_pending recovery refuses when squareInvoiceId changed since read", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  const originalSquareInvoiceId = fixture.record.squareInvoiceId;
  fixture.records[0].squareInvoiceId = "invoice_changed";
  fixture.repository.getNoShowChargeRecordById = async () => ({
    ...fixture.records[0],
    squareInvoiceId: originalSquareInvoiceId,
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-stale-invoice-changed",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.records[0].status, "charge_pending");
  assert.equal(fixture.records[0].squareInvoiceId, "invoice_changed");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
});

test("stale charge_pending recovery refuses when updatedAt changed since read", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  const originalUpdatedAt = fixture.record.updatedAt;
  fixture.records[0].updatedAt = new Date("2026-06-20T11:30:00Z");
  fixture.repository.getNoShowChargeRecordById = async () => ({
    ...fixture.records[0],
    updatedAt: originalUpdatedAt,
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-stale-updated-at-changed",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.records[0].status, "charge_pending");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
});

test("stale charge_pending with PAID invoice persists manual_followup instead of unsafe auto-finalization", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: {
      id: "inv-1",
      status: "PAID",
      order_id: "order-1",
      version: 2,
      payment_id: "pay-recovered-1",
    },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-paid-finalize",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.record.status, "manual_followup");
  assert.equal(fixture.record.providerStatus, "PAID");
  assert.ok(
    typeof fixture.record.providerFailureReason === "string" &&
      fixture.record.providerFailureReason.includes("payment validation"),
  );
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(
    alert.category,
    "no_show_charge_paid_requires_manual_validation",
  );
  assert.equal(alert.severity, "warning");
});

test("stale charge_pending with PAID invoice without payment id persists manual_followup and alerts", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "PAID", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-paid-no-payment-id",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.record.status, "manual_followup");
  assert.equal(fixture.record.providerStatus, "PAID");
  assert.ok(
    typeof fixture.record.providerFailureReason === "string" &&
      fixture.record.providerFailureReason.includes("payment validation"),
  );
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(
    alert.category,
    "no_show_charge_paid_requires_manual_validation",
  );
  assert.equal(alert.severity, "warning");
});

test("stale charge_pending missing provider reference does not overwrite terminal charged record", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: undefined,
  });
  // Return a stale charge_pending snapshot while the actual record has been
  // finalized to charged by a concurrent webhook.
  fixture.repository.getNoShowChargeRecordById = async () => ({
    id: fixture.record.id,
    status: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: undefined,
    squareOrderId: fixture.record.squareOrderId,
    maxChargeCents: fixture.record.maxChargeCents,
    currency: fixture.record.currency,
    providerMetadata: fixture.record.providerMetadata,
  });
  fixture.records[0].status = "charged";
  fixture.records[0].squarePaymentId = "webhook-pay";

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-missing-ref-race",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.records[0].status, "charged");
  assert.equal(fixture.records[0].squarePaymentId, "webhook-pay");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 0);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
});

test("stale charge_pending Square lookup failure does not overwrite terminal charged record", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.repository.getNoShowChargeRecordById = async () => ({
    id: fixture.record.id,
    status: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: fixture.record.squareInvoiceId,
    squareOrderId: fixture.record.squareOrderId,
    maxChargeCents: fixture.record.maxChargeCents,
    currency: fixture.record.currency,
    providerMetadata: fixture.record.providerMetadata,
  });
  fixture.records[0].status = "charged";
  fixture.records[0].squarePaymentId = "webhook-pay";
  fixture.squareInvoices.getInvoiceResponse = undefined;

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-lookup-fail-race",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.records[0].status, "charged");
  assert.equal(fixture.records[0].squarePaymentId, "webhook-pay");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
});

test("stale charge_pending with terminal CANCELED invoice does not overwrite terminal charged record", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.repository.getNoShowChargeRecordById = async () => ({
    id: fixture.record.id,
    status: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: fixture.record.squareInvoiceId,
    squareOrderId: fixture.record.squareOrderId,
    maxChargeCents: fixture.record.maxChargeCents,
    currency: fixture.record.currency,
    providerMetadata: fixture.record.providerMetadata,
  });
  fixture.records[0].status = "charged";
  fixture.records[0].squarePaymentId = "webhook-pay";
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: {
      id: "inv-1",
      status: "CANCELED",
      order_id: "order-1",
      version: 2,
    },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-terminal-race",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.records[0].status, "charged");
  assert.equal(fixture.records[0].squarePaymentId, "webhook-pay");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
});

test("stale charge_pending with PAID invoice and payment id does not overwrite terminal charged record", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.repository.getNoShowChargeRecordById = async () => ({
    id: fixture.record.id,
    status: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: fixture.record.squareInvoiceId,
    squareOrderId: fixture.record.squareOrderId,
    maxChargeCents: fixture.record.maxChargeCents,
    currency: fixture.record.currency,
    providerMetadata: fixture.record.providerMetadata,
  });
  fixture.records[0].status = "charged";
  fixture.records[0].squarePaymentId = "webhook-pay";
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: {
      id: "inv-1",
      status: "PAID",
      order_id: "order-1",
      version: 2,
      payment_id: "pay-recovered-race",
    },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-paid-race",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.records[0].status, "charged");
  assert.equal(fixture.records[0].squarePaymentId, "webhook-pay");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
});

test("stale charge_pending with CANCELED invoice marks charge_failed", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: {
      id: "inv-1",
      status: "CANCELED",
      order_id: "order-1",
      version: 2,
    },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-canceled-pending",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_failed");
  assert.equal(fixture.record.status, "charge_failed");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_failed");
});

test("stale charge_pending with non-terminal invoice returns pending without retry", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "UNPAID", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-unpaid-pending",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.record.status, "charge_pending");
});

test("stale charge_pending without invoice reference persists manual_followup and alerts", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: undefined,
  });

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-missing-ref",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 0);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_missing_provider_reference");
  assert.equal(fixture.updateCalls.length >= 1, true);
  const manualUpdate = fixture.updateCalls.find(
    (u) => (u as { status?: string }).status === "manual_followup",
  ) as { status: string; providerFailureReason?: string } | undefined;
  assert.ok(manualUpdate, "expected a manual_followup update");
  assert.equal(
    manualUpdate?.providerFailureReason,
    "Cannot recover stale no-show charge: missing Square invoice reference",
  );
  assert.equal(fixture.record.status, "manual_followup");
});

test("stale charge_pending Square lookup failure persists manual_followup and alerts", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = undefined;

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-lookup-fail",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_recovery_lookup_failed");
  assert.equal(fixture.updateCalls.length >= 1, true);
  const manualUpdate = fixture.updateCalls.find(
    (u) => (u as { status?: string }).status === "manual_followup",
  ) as { status: string; providerFailureReason?: string } | undefined;
  assert.ok(manualUpdate, "expected a manual_followup update");
  assert.equal(
    manualUpdate?.providerFailureReason,
    "Get invoice not expected during charge",
  );
  assert.equal(fixture.record.status, "manual_followup");
});

test("non-stale charge_pending returns pending without Square lookup", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:50:00Z"),
  });

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-fresh-pending",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 0);
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
});

test("stale charge_pending not in publish_pending returns pending without lookup", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "UNPAID",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-not-publish-pending",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 0);
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
});

test("stale charge_pending recovery allows retry when prior admin action was recorded", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.adminActions.push({
    noShowChargeRecordId: fixture.record.id,
    operatorId: "staff-nataliea",
    reason: "Original no-show charge attempt.",
    now: new Date("2026-06-20T11:01:00Z"),
  });
  fixture.repository.recordNoShowAdminAction = async () => {
    return { recorded: false };
  };
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-stale-after-admin",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.publishCalls.length, 1);
  assert.equal(fixture.adminActions.length, 1);
});

test("stale charge_pending DRAFT recovery captures fetched invoice version and publishes with it", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    providerMetadata: { squareInvoiceVersion: 2 },
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 5 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-draft-version",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.publishCalls.length, 1);
  assert.equal(fixture.squareInvoices.publishCalls[0].request.version, 5);
  assert.equal(fixture.record.providerMetadata?.squareInvoiceVersion, 5);
});

test("stale PAID recovery refuses CAS update when row left expected stale state", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.repository.getNoShowChargeRecordById = async () => ({
    id: fixture.record.id,
    status: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
    squareInvoiceId: fixture.record.squareInvoiceId,
    squareOrderId: fixture.record.squareOrderId,
    maxChargeCents: fixture.record.maxChargeCents,
    currency: fixture.record.currency,
    providerMetadata: fixture.record.providerMetadata,
  });
  // Row moved on to a non-terminal state before the stale fallback write.
  fixture.records[0].status = "provider_draft_created";
  fixture.records[0].providerStatus = "DRAFT";
  fixture.records[0].updatedAt = new Date("2026-06-20T11:30:00Z");
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: {
      id: "inv-1",
      status: "PAID",
      order_id: "order-1",
      version: 2,
      payment_id: "pay-concurrent",
    },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-paid-cas-fail",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.records[0].status, "provider_draft_created");
  assert.equal(fixture.records[0].providerStatus, "DRAFT");
  assert.equal(fixture.squareInvoices.publishCalls.length, 0);
  assert.equal(fixture.squareInvoices.getInvoiceCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_persistence_failed");
  assert.equal(alert.severity, "error");
});

test("stale DRAFT retry post-publish result does not overwrite concurrent state change", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 2 },
  };

  fixture.squareInvoices.client.publishInvoice = async (invoiceId, request) => {
    // Simulate a concurrent webhook or recovery finalizing the record while
    // this stale retry publish is in flight.
    fixture.records[0].status = "charged";
    fixture.records[0].providerStatus = "PAID";
    fixture.records[0].squarePaymentId = "webhook-pay";
    fixture.records[0].updatedAt = new Date("2026-06-20T12:00:01Z");
    fixture.squareInvoices.publishCalls.push({ invoiceId, request });
    return {
      invoice: {
        id: invoiceId,
        status: "PAID",
        order_id: "order-1",
        version: 2,
        payment_id: "publish-pay",
      },
    };
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-draft-concurrent",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "manual_followup");
  assert.equal(fixture.records[0].status, "charged");
  assert.equal(fixture.records[0].squarePaymentId, "webhook-pay");
  assert.equal(fixture.records[0].providerStatus, "PAID");
  assert.equal(fixture.squareInvoices.publishCalls.length, 1);
  assert.equal(fixture.alerts.calls.length, 1);
  const alert = fixture.alerts.calls[0] as {
    category: string;
    severity: string;
  };
  assert.equal(alert.category, "no_show_charge_finalize_failed");
  assert.equal(alert.severity, "error");
});
