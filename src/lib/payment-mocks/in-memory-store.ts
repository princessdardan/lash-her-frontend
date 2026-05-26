import type { PaymentMockScenario } from "./scenarios";

export type PaymentMockProvider = "helcim" | "square";

export interface PaymentMockIdempotencyRecord {
  createdAt: Date;
  idempotencyKey: string;
  payloadHash: string;
  provider: PaymentMockProvider;
  scenario: PaymentMockScenario;
}

export interface PaymentMockWebhookEventRecord {
  createdAt: Date;
  eventId: string;
  payloadHash: string;
  provider: PaymentMockProvider;
  scenario: PaymentMockScenario;
}

export interface PaymentMockProviderTransactionRecord {
  createdAt: Date;
  orderId: string;
  provider: PaymentMockProvider;
  scenario: PaymentMockScenario;
  status: string;
  transactionId: string;
}

export interface PaymentMockProviderOrderRecord {
  createdAt: Date;
  orderId: string;
  provider: PaymentMockProvider;
  scenario: PaymentMockScenario;
  status: string;
}

export interface PaymentMockSquareInvoiceRecord {
  createdAt: Date;
  customerId: string;
  invoiceId: string;
  orderId: string;
  provider: "square";
  publicUrl: string;
  scenario: PaymentMockScenario;
  status: string;
  version: number;
}

export interface PaymentMockSquareInvoiceWebhookRecord {
  createdAt: Date;
  eventId: string;
  eventType: "invoice.payment_made" | "invoice.published" | "invoice.updated";
  invoiceId: string;
  payload: Record<string, unknown>;
  provider: "square";
  scenario: PaymentMockScenario;
}

export interface PaymentMockStore {
  readonly idempotencyRecords: PaymentMockIdempotencyRecord[];
  readonly webhookEventRecords: PaymentMockWebhookEventRecord[];
  readonly providerTransactions: PaymentMockProviderTransactionRecord[];
  readonly providerOrders: PaymentMockProviderOrderRecord[];
  readonly squareInvoiceRecords: PaymentMockSquareInvoiceRecord[];
  readonly squareInvoiceWebhookRecords: PaymentMockSquareInvoiceWebhookRecord[];
  now(): Date;
  nextSequence(): number;
  reset(): void;
  recordIdempotencyRecord(record: PaymentMockIdempotencyRecord): PaymentMockIdempotencyRecord;
  getIdempotencyRecord(idempotencyKey: string): PaymentMockIdempotencyRecord | null;
  recordWebhookEvent(record: PaymentMockWebhookEventRecord): PaymentMockWebhookEventRecord;
  hasWebhookEvent(eventId: string): boolean;
  getWebhookEvent(eventId: string): PaymentMockWebhookEventRecord | null;
  recordProviderTransaction(record: PaymentMockProviderTransactionRecord): PaymentMockProviderTransactionRecord;
  getProviderTransaction(transactionId: string): PaymentMockProviderTransactionRecord | null;
  recordProviderOrder(record: PaymentMockProviderOrderRecord): PaymentMockProviderOrderRecord;
  getProviderOrder(orderId: string): PaymentMockProviderOrderRecord | null;
  recordSquareInvoiceRecord(record: PaymentMockSquareInvoiceRecord): PaymentMockSquareInvoiceRecord;
  getSquareInvoiceRecord(invoiceId: string): PaymentMockSquareInvoiceRecord | null;
  recordSquareInvoiceWebhookRecord(record: PaymentMockSquareInvoiceWebhookRecord): PaymentMockSquareInvoiceWebhookRecord;
  getSquareInvoiceWebhookRecord(eventId: string): PaymentMockSquareInvoiceWebhookRecord | null;
}

export interface PaymentMockStoreOptions {
  now?: Date | (() => Date);
}

export function createPaymentMockStore(options: PaymentMockStoreOptions = {}): PaymentMockStore {
  const clock = normalizeClock(options.now);
  const idempotencyRecords: PaymentMockIdempotencyRecord[] = [];
  const webhookEventRecords: PaymentMockWebhookEventRecord[] = [];
  const providerTransactions: PaymentMockProviderTransactionRecord[] = [];
  const providerOrders: PaymentMockProviderOrderRecord[] = [];
  const squareInvoiceRecords: PaymentMockSquareInvoiceRecord[] = [];
  const squareInvoiceWebhookRecords: PaymentMockSquareInvoiceWebhookRecord[] = [];
  let sequence = 0;

  function reset(): void {
    idempotencyRecords.length = 0;
    webhookEventRecords.length = 0;
    providerTransactions.length = 0;
    providerOrders.length = 0;
    squareInvoiceRecords.length = 0;
    squareInvoiceWebhookRecords.length = 0;
    sequence = 0;
  }

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  function recordIdempotencyRecord(record: PaymentMockIdempotencyRecord): PaymentMockIdempotencyRecord {
    const existingIndex = idempotencyRecords.findIndex((candidate) => candidate.idempotencyKey === record.idempotencyKey);
    if (existingIndex >= 0) {
      idempotencyRecords[existingIndex] = record;
      return record;
    }

    idempotencyRecords.push(record);
    return record;
  }

  function getIdempotencyRecord(idempotencyKey: string): PaymentMockIdempotencyRecord | null {
    return idempotencyRecords.find((record) => record.idempotencyKey === idempotencyKey) ?? null;
  }

  function recordWebhookEvent(record: PaymentMockWebhookEventRecord): PaymentMockWebhookEventRecord {
    const existing = getWebhookEvent(record.eventId);
    if (existing) {
      return existing;
    }

    webhookEventRecords.push(record);
    return record;
  }

  function hasWebhookEvent(eventId: string): boolean {
    return getWebhookEvent(eventId) !== null;
  }

  function getWebhookEvent(eventId: string): PaymentMockWebhookEventRecord | null {
    return webhookEventRecords.find((record) => record.eventId === eventId) ?? null;
  }

  function recordProviderTransaction(record: PaymentMockProviderTransactionRecord): PaymentMockProviderTransactionRecord {
    const existingIndex = providerTransactions.findIndex((candidate) => candidate.transactionId === record.transactionId);
    if (existingIndex >= 0) {
      providerTransactions[existingIndex] = record;
      return record;
    }

    providerTransactions.push(record);
    return record;
  }

  function getProviderTransaction(transactionId: string): PaymentMockProviderTransactionRecord | null {
    return providerTransactions.find((record) => record.transactionId === transactionId) ?? null;
  }

  function recordProviderOrder(record: PaymentMockProviderOrderRecord): PaymentMockProviderOrderRecord {
    const existingIndex = providerOrders.findIndex((candidate) => candidate.orderId === record.orderId);
    if (existingIndex >= 0) {
      providerOrders[existingIndex] = record;
      return record;
    }

    providerOrders.push(record);
    return record;
  }

  function getProviderOrder(orderId: string): PaymentMockProviderOrderRecord | null {
    return providerOrders.find((record) => record.orderId === orderId) ?? null;
  }

  function recordSquareInvoiceRecord(record: PaymentMockSquareInvoiceRecord): PaymentMockSquareInvoiceRecord {
    const existingIndex = squareInvoiceRecords.findIndex((candidate) => candidate.invoiceId === record.invoiceId);
    if (existingIndex >= 0) {
      squareInvoiceRecords[existingIndex] = record;
      return record;
    }

    squareInvoiceRecords.push(record);
    return record;
  }

  function getSquareInvoiceRecord(invoiceId: string): PaymentMockSquareInvoiceRecord | null {
    return squareInvoiceRecords.find((record) => record.invoiceId === invoiceId) ?? null;
  }

  function recordSquareInvoiceWebhookRecord(
    record: PaymentMockSquareInvoiceWebhookRecord,
  ): PaymentMockSquareInvoiceWebhookRecord {
    const existing = getSquareInvoiceWebhookRecord(record.eventId);
    if (existing) {
      return existing;
    }

    squareInvoiceWebhookRecords.push(record);
    return record;
  }

  function getSquareInvoiceWebhookRecord(eventId: string): PaymentMockSquareInvoiceWebhookRecord | null {
    return squareInvoiceWebhookRecords.find((record) => record.eventId === eventId) ?? null;
  }

  return {
    get idempotencyRecords() {
      return idempotencyRecords;
    },
    get webhookEventRecords() {
      return webhookEventRecords;
    },
    get providerTransactions() {
      return providerTransactions;
    },
    get providerOrders() {
      return providerOrders;
    },
    get squareInvoiceRecords() {
      return squareInvoiceRecords;
    },
    get squareInvoiceWebhookRecords() {
      return squareInvoiceWebhookRecords;
    },
    now: clock,
    nextSequence,
    reset,
    recordIdempotencyRecord,
    getIdempotencyRecord,
    recordWebhookEvent,
    hasWebhookEvent,
    getWebhookEvent,
    recordProviderTransaction,
    getProviderTransaction,
    recordProviderOrder,
    getProviderOrder,
    recordSquareInvoiceRecord,
    getSquareInvoiceRecord,
    recordSquareInvoiceWebhookRecord,
    getSquareInvoiceWebhookRecord,
  };
}

function normalizeClock(now: Date | (() => Date) | undefined): () => Date {
  if (typeof now === "function") {
    return () => cloneDate(now());
  }

  if (now instanceof Date) {
    return () => cloneDate(now);
  }

  return () => new Date();
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}
