import { createHash } from "node:crypto";

import type { PaymentMockStore } from "./in-memory-store";
import { createPaymentMockStore } from "./in-memory-store";
import type { PaymentMockRuntimeEnvironment } from "./runtime-controls";
import { assertPaymentMockAllowed } from "./runtime-controls";
import type { PaymentMockScenario } from "./scenarios";

type SquareInvoiceScenario = Extract<PaymentMockScenario, `square_invoice_${string}`>;
type SquareInvoiceWebhookEventType = "invoice.payment_made" | "invoice.published" | "invoice.updated";
type SquareInvoiceStatus = "DRAFT" | "PAID" | "PAYMENT_METHOD_UNAVAILABLE" | "PUBLISH_FAILED" | "PUBLISHED" | "UNPAID";

export interface MockSquareInvoiceInput {
  amountCents: number;
  currency?: "CAD";
  customerId: string;
  env?: PaymentMockRuntimeEnvironment;
  idempotencyKey: string;
  orderId: string;
  request: Request;
  scenario: SquareInvoiceScenario;
  store?: PaymentMockStore;
}

export interface MockSquareInvoice {
  id: string;
  order_id: string;
  payment_requests: Array<{
    computed_amount_money: SquareMoney;
    request_type: "BALANCE";
    tipping_enabled: boolean;
  }>;
  primary_recipient: {
    customer_id: string;
  };
  public_url: string;
  status: SquareInvoiceStatus;
  version: number;
}

export interface MockSquareInvoiceResponse {
  invoice: MockSquareInvoice;
}

export interface MockSquareInvoiceWebhookPayload {
  created_at: string;
  data: {
    id: string;
    object: {
      invoice: MockSquareInvoice;
      payment?: {
        amount_money: SquareMoney;
        id: string;
        order_id: string;
        status: "COMPLETED";
        total_money: SquareMoney;
      };
    };
    type: "invoice";
  };
  event_id: string;
  merchant_id: string;
  type: SquareInvoiceWebhookEventType;
}

export interface MockSquareInvoiceLifecycleResult {
  duplicatePaidWebhook: boolean;
  invoice: MockSquareInvoice;
  paymentAmountCents: number;
  webhookPayload: MockSquareInvoiceWebhookPayload;
}

interface SquareMoney {
  amount: number;
  currency: "CAD";
}

interface SquareInvoiceWebhookInput {
  eventId?: string;
  invoiceId: string;
  store: PaymentMockStore;
}

interface SquareInvoicePaymentMadeWebhookInput extends SquareInvoiceWebhookInput {
  amountCents: number;
  orderId: string;
  paymentId: string;
}

interface SquareInvoiceUpdatedWebhookInput extends SquareInvoiceWebhookInput {
  status: SquareInvoiceStatus;
}

const defaultEnv = { PAYMENT_GATEWAY_MODE: "mock" } satisfies PaymentMockRuntimeEnvironment;
const merchantId = "mock-square-merchant";

export function createMockSquareInvoice(input: MockSquareInvoiceInput): MockSquareInvoiceResponse {
  assertPaymentMockAllowed({
    env: input.env ?? defaultEnv,
    injectedScenario: input.scenario,
    request: input.request,
  });

  const store = input.store ?? createPaymentMockStore();
  const payloadHash = hashJson({
    amountCents: input.amountCents,
    currency: input.currency ?? "CAD",
    customerId: input.customerId,
    orderId: input.orderId,
  });
  const existingIdempotencyRecord = store.getIdempotencyRecord(input.idempotencyKey);

  if (existingIdempotencyRecord !== null && existingIdempotencyRecord.payloadHash !== payloadHash) {
    throw new Error(`Square invoice idempotency key ${input.idempotencyKey} was reused with a different payload`);
  }

  const existingInvoice = existingIdempotencyRecord === null
    ? null
    : store.squareInvoiceRecords.find((record) => record.orderId === input.orderId && record.customerId === input.customerId) ?? null;

  if (existingInvoice !== null) {
    return { invoice: toSquareInvoice(existingInvoice, input.amountCents, input.currency ?? "CAD") };
  }

  const sequence = store.nextSequence();
  const invoiceId = `mock-square-invoice-${sequence}`;
  const orderId = `mock-square-invoice-order-${sequence}`;
  const publicUrl = `http://localhost:3000/mock-square/invoices/${invoiceId}`;

  store.recordIdempotencyRecord({
    createdAt: store.now(),
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    provider: "square",
    scenario: input.scenario,
  });

  const invoiceRecord = store.recordSquareInvoiceRecord({
    createdAt: store.now(),
    customerId: input.customerId,
    invoiceId,
    orderId,
    provider: "square",
    publicUrl,
    scenario: input.scenario,
    status: "DRAFT",
    version: 1,
  });

  return { invoice: toSquareInvoice(invoiceRecord, input.amountCents, input.currency ?? "CAD") };
}

export function createMockSquareInvoiceLifecycle(input: MockSquareInvoiceInput): MockSquareInvoiceLifecycleResult {
  const store = input.store ?? createPaymentMockStore();
  const created = createMockSquareInvoice({ ...input, store });
  const baseAmountCents = input.amountCents;

  switch (input.scenario) {
    case "square_invoice_afterpay_unavailable":
      return updatedLifecycleResult(store, created.invoice, "PAYMENT_METHOD_UNAVAILABLE", baseAmountCents);
    case "square_invoice_publish_failed":
      return updatedLifecycleResult(store, created.invoice, "PUBLISH_FAILED", baseAmountCents);
    case "square_invoice_unpaid":
      return updatedLifecycleResult(store, created.invoice, "UNPAID", baseAmountCents);
    case "square_invoice_paid_mismatch":
      return paidLifecycleResult(store, created.invoice, baseAmountCents - 1, false);
    case "square_invoice_duplicate_paid":
      return paidLifecycleResult(store, created.invoice, baseAmountCents, true);
    case "square_invoice_finalization_retry":
    case "square_invoice_success":
      return paidLifecycleResult(store, created.invoice, baseAmountCents, false);
  }
}

export function createSquareInvoicePaymentMadeWebhookPayload(
  input: SquareInvoicePaymentMadeWebhookInput,
): MockSquareInvoiceWebhookPayload {
  const eventId = input.eventId ?? `mock-square-invoice-payment-made-${input.invoiceId}`;
  const existing = getExistingWebhookPayload(input.store, eventId);
  if (existing !== null) {
    return existing;
  }

  const invoice = requireStoredInvoice(input.store, input.invoiceId, "PAID", input.amountCents);
  const payment = {
    amount_money: money(input.amountCents),
    id: input.paymentId,
    order_id: input.orderId,
    status: "COMPLETED",
    total_money: money(input.amountCents),
  } as const;

  return recordWebhookPayload(input.store, {
    eventId,
    eventType: "invoice.payment_made",
    invoice,
    payment,
  });
}

export function createSquareInvoicePublishedWebhookPayload(
  input: SquareInvoiceWebhookInput,
): MockSquareInvoiceWebhookPayload {
  const eventId = input.eventId ?? `mock-square-invoice-published-${input.invoiceId}`;
  const existing = getExistingWebhookPayload(input.store, eventId);
  if (existing !== null) {
    return existing;
  }

  return recordWebhookPayload(input.store, {
    eventId,
    eventType: "invoice.published",
    invoice: requireStoredInvoice(input.store, input.invoiceId, "PUBLISHED"),
  });
}

export function createSquareInvoiceUpdatedWebhookPayload(
  input: SquareInvoiceUpdatedWebhookInput,
): MockSquareInvoiceWebhookPayload {
  const eventId = input.eventId ?? `mock-square-invoice-updated-${input.status.toLowerCase()}-${input.invoiceId}`;
  const existing = getExistingWebhookPayload(input.store, eventId);
  if (existing !== null) {
    return existing;
  }

  return recordWebhookPayload(input.store, {
    eventId,
    eventType: "invoice.updated",
    invoice: requireStoredInvoice(input.store, input.invoiceId, input.status),
  });
}

function paidLifecycleResult(
  store: PaymentMockStore,
  invoice: MockSquareInvoice,
  paymentAmountCents: number,
  duplicatePaidWebhook: boolean,
): MockSquareInvoiceLifecycleResult {
  const eventId = duplicatePaidWebhook
    ? `mock-square-invoice-duplicate-paid-${invoice.id}`
    : `mock-square-invoice-payment-made-${invoice.id}`;
  const webhookPayload = createSquareInvoicePaymentMadeWebhookPayload({
    amountCents: paymentAmountCents,
    eventId,
    invoiceId: invoice.id,
    orderId: invoice.order_id,
    paymentId: `mock-square-invoice-payment-${invoice.id}`,
    store,
  });

  if (duplicatePaidWebhook) {
    createSquareInvoicePaymentMadeWebhookPayload({
      amountCents: paymentAmountCents,
      eventId,
      invoiceId: invoice.id,
      orderId: invoice.order_id,
      paymentId: `mock-square-invoice-payment-${invoice.id}`,
      store,
    });
  }

  return {
    duplicatePaidWebhook,
    invoice: webhookPayload.data.object.invoice,
    paymentAmountCents,
    webhookPayload,
  };
}

function updatedLifecycleResult(
  store: PaymentMockStore,
  invoice: MockSquareInvoice,
  status: SquareInvoiceStatus,
  paymentAmountCents: number,
): MockSquareInvoiceLifecycleResult {
  const webhookPayload = createSquareInvoiceUpdatedWebhookPayload({ invoiceId: invoice.id, status, store });

  return {
    duplicatePaidWebhook: false,
    invoice: webhookPayload.data.object.invoice,
    paymentAmountCents,
    webhookPayload,
  };
}

function requireStoredInvoice(
  store: PaymentMockStore,
  invoiceId: string,
  status: SquareInvoiceStatus,
  amountCents = 0,
): MockSquareInvoice {
  const invoiceRecord = store.getSquareInvoiceRecord(invoiceId);
  if (invoiceRecord === null) {
    throw new Error(`Mock Square invoice ${invoiceId} was not found`);
  }

  const nextRecord = store.recordSquareInvoiceRecord({
    ...invoiceRecord,
    status,
    version: invoiceRecord.version + 1,
  });

  return toSquareInvoice(nextRecord, amountCents);
}

function recordWebhookPayload(
  store: PaymentMockStore,
  input: {
    eventId: string;
    eventType: SquareInvoiceWebhookEventType;
    invoice: MockSquareInvoice;
    payment?: MockSquareInvoiceWebhookPayload["data"]["object"]["payment"];
  },
): MockSquareInvoiceWebhookPayload {
  const payload = {
    created_at: store.now().toISOString(),
    data: {
      id: input.invoice.id,
      object: {
        invoice: input.invoice,
        ...(input.payment ? { payment: input.payment } : {}),
      },
      type: "invoice",
    },
    event_id: input.eventId,
    merchant_id: merchantId,
    type: input.eventType,
  } satisfies MockSquareInvoiceWebhookPayload;

  store.recordSquareInvoiceWebhookRecord({
    createdAt: store.now(),
    eventId: input.eventId,
    eventType: input.eventType,
    invoiceId: input.invoice.id,
    payload: payload as unknown as Record<string, unknown>,
    provider: "square",
    scenario: getInvoiceRecordScenario(store, input.invoice.id),
  });

  return payload;
}

function getExistingWebhookPayload(store: PaymentMockStore, eventId: string): MockSquareInvoiceWebhookPayload | null {
  return (store.getSquareInvoiceWebhookRecord(eventId)?.payload as MockSquareInvoiceWebhookPayload | undefined) ?? null;
}

function toSquareInvoice(
  record: ReturnType<PaymentMockStore["recordSquareInvoiceRecord"]>,
  amountCents: number,
  currency: "CAD" = "CAD",
): MockSquareInvoice {
  return {
    id: record.invoiceId,
    order_id: record.orderId,
    payment_requests: [{
      computed_amount_money: money(amountCents, currency),
      request_type: "BALANCE",
      tipping_enabled: false,
    }],
    primary_recipient: {
      customer_id: record.customerId,
    },
    public_url: record.publicUrl,
    status: record.status as SquareInvoiceStatus,
    version: record.version,
  };
}

function money(amount: number, currency: "CAD" = "CAD"): SquareMoney {
  return { amount, currency };
}

function getInvoiceRecordScenario(store: PaymentMockStore, invoiceId: string): SquareInvoiceScenario {
  const scenario = store.getSquareInvoiceRecord(invoiceId)?.scenario;
  if (scenario?.startsWith("square_invoice_")) {
    return scenario as SquareInvoiceScenario;
  }

  return "square_invoice_success";
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value)), "utf8").digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
