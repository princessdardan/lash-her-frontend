import { createHash, createHmac } from "node:crypto";

import type { PaymentMockScenario } from "../payment-mocks/scenarios";
import type { PaymentMockStore } from "../payment-mocks/in-memory-store";
import { createHelcimResponseHash } from "./helcim-hash";
import type { HelcimGateway } from "./helcim-gateway";
import type {
  HelcimCardTransactionResponse,
  HelcimInvoiceResponse,
  HelcimPayInitializeResponse,
  HelcimPaySuccessPayload,
} from "./helcim-types";
import type { HelcimWebhookHeaders } from "./helcim-webhook";

interface CreateMockHelcimGatewayInput {
  idempotencyKey?: string;
  now?: Date | (() => Date);
  scenario: PaymentMockScenario;
  store: PaymentMockStore;
}

interface BuildMockHelcimSuccessPayloadInput {
  amount: number;
  currency?: "CAD";
  invoice: HelcimInvoiceResponse;
  paySession: HelcimPayInitializeResponse;
  scenario?: PaymentMockScenario;
  transactionId?: string;
}

interface BuildMockHelcimWebhookInput {
  eventId?: string;
  eventType?: string;
  now?: Date;
  transactionId: string;
}

interface MockHelcimWebhookDraft {
  headers: Omit<HelcimWebhookHeaders, "signature">;
  rawBody: string;
}

interface SignMockHelcimWebhookInput extends MockHelcimWebhookDraft {
  verifierToken: string;
}

interface StoredMockHelcimInvoiceRecord {
  response: HelcimInvoiceResponse;
}

interface StoredMockHelcimTransactionRecord {
  amount: number;
  currency: "CAD";
  invoiceId: number;
  invoiceNumber: string;
  scenario: PaymentMockScenario;
  sequence: number;
  status: string;
  transactionId: string;
}

interface StoredMockHelcimIdempotencyRecord {
  response: HelcimInvoiceResponse;
}

interface MockHelcimStoreState {
  idempotency: Map<string, StoredMockHelcimIdempotencyRecord>;
  invoices: Map<string, StoredMockHelcimInvoiceRecord>;
  transactions: Map<string, StoredMockHelcimTransactionRecord>;
}

export class MockHelcimIdempotencyMismatchError extends Error {
  readonly code = "HELCIM_IDEMPOTENCY_MISMATCH";
  readonly status = 409;

  constructor(idempotencyKey: string) {
    super(`Helcim idempotency mismatch for key ${idempotencyKey}`);
    this.name = "MockHelcimIdempotencyMismatchError";
  }
}

const HELCIM_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
const storeState = new WeakMap<PaymentMockStore, MockHelcimStoreState>();

export function createMockHelcimGateway({
  idempotencyKey,
  now,
  scenario,
  store,
}: CreateMockHelcimGatewayInput): HelcimGateway {
  const clock = normalizeClock(now, store);
  const state = getStoreState(store);

  return {
    async createInvoice(request) {
      clearHiddenStateAfterStoreReset(store, state);
      const createdAt = clock();
      const payloadHash = hashPayload(request);

      if (idempotencyKey) {
        const idempotency = resolveIdempotency({
          createdAt,
          idempotencyKey,
          payloadHash,
          scenario,
          state,
          store,
        });

        if (idempotency) {
          return idempotency.response;
        }
      }

      const sequence = store.nextSequence();
      const response = {
        invoiceId: 900000 + sequence,
        invoiceNumber: `MOCK-INV-${sequence}`,
      };

      state.invoices.set(response.invoiceNumber, { response });
      store.recordProviderOrder({
        createdAt,
        orderId: response.invoiceNumber,
        provider: "helcim",
        scenario,
        status: statusForScenario(scenario),
      });

      if (idempotencyKey) {
        store.recordIdempotencyRecord({
          createdAt,
          idempotencyKey,
          payloadHash,
          provider: "helcim",
          scenario,
        });
        state.idempotency.set(idempotencyKey, { response });
      }

      return response;
    },

    async initializePay(request) {
      clearHiddenStateAfterStoreReset(store, state);
      const createdAt = clock();
      const sequence = getSequenceFromInvoiceNumber(request.invoiceNumber) ?? store.nextSequence();
      const invoice = state.invoices.get(request.invoiceNumber)?.response;
      const transactionId = `mock_helcim_txn_${sequence}`;
      const status = statusForScenario(scenario);

      state.transactions.set(transactionId, {
        amount: request.amount,
        currency: request.currency,
        invoiceId: invoice?.invoiceId ?? 900000 + sequence,
        invoiceNumber: request.invoiceNumber,
        scenario,
        sequence,
        status,
        transactionId,
      });
      store.recordProviderTransaction({
        createdAt,
        orderId: request.invoiceNumber,
        provider: "helcim",
        scenario,
        status,
        transactionId,
      });

      return {
        checkoutToken: `mock_helcim_checkout_${sequence}`,
        secretToken: `mock_helcim_secret_${sequence}`,
      };
    },

    async getCardTransaction(cardTransactionId) {
      clearHiddenStateAfterStoreReset(store, state);
      const transaction = state.transactions.get(cardTransactionId);

      if (!transaction) {
        throw new Error(`Mock Helcim card transaction not found: ${cardTransactionId}`);
      }

      return {
        amount: transaction.amount,
        approvalCode: approvalCodeForScenario(transaction.scenario, transaction.sequence),
        card: {
          brand: "Visa",
          last4: "4242",
        },
        currency: transaction.currency,
        invoiceId: transaction.invoiceId,
        invoiceNumber: transaction.invoiceNumber,
        status: transaction.status,
        transactionId: transaction.transactionId,
      } satisfies HelcimCardTransactionResponse;
    },
  };
}

export function buildMockHelcimSuccessPayload({
  amount,
  currency = "CAD",
  invoice,
  paySession,
  scenario = "success",
  transactionId,
}: BuildMockHelcimSuccessPayloadInput): HelcimPaySuccessPayload {
  const sequence = getSequenceFromSecretToken(paySession.secretToken)
    ?? getSequenceFromInvoiceNumber(invoice.invoiceNumber)
    ?? 1;
  const status = statusForScenario(scenario);
  const data = {
    amount,
    approved: status === "APPROVED",
    cardLast4: "4242",
    cardType: "Visa",
    currency,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    status,
    transactionId: transactionId ?? `mock_helcim_txn_${sequence}`,
  };

  return {
    data,
    hash: createHelcimResponseHash(data, paySession.secretToken),
  };
}

export function buildMockHelcimWebhook({
  eventId,
  eventType = "cardTransaction",
  now = new Date(),
  transactionId,
}: BuildMockHelcimWebhookInput): MockHelcimWebhookDraft {
  return {
    headers: {
      id: eventId ?? `mock_helcim_event_${transactionId}`,
      timestamp: String(Math.floor(now.getTime() / 1000)),
    },
    rawBody: JSON.stringify({ id: transactionId, type: eventType }),
  };
}

export function signMockHelcimWebhook({
  headers,
  rawBody,
  verifierToken,
}: SignMockHelcimWebhookInput): HelcimWebhookHeaders {
  const verifierKey = Buffer.from(verifierToken, "base64");
  const signature = createHmac("sha256", verifierKey)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`, "utf8")
    .digest("base64");

  return { ...headers, signature };
}

function resolveIdempotency(input: {
  createdAt: Date;
  idempotencyKey: string;
  payloadHash: string;
  scenario: PaymentMockScenario;
  state: MockHelcimStoreState;
  store: PaymentMockStore;
}): StoredMockHelcimIdempotencyRecord | null {
  const existing = input.store.getIdempotencyRecord(input.idempotencyKey);

  if (!existing) {
    input.state.idempotency.delete(input.idempotencyKey);
    return null;
  }

  const ageMs = input.createdAt.getTime() - existing.createdAt.getTime();

  if (ageMs >= HELCIM_IDEMPOTENCY_WINDOW_MS) {
    input.state.idempotency.delete(input.idempotencyKey);
    return null;
  }

  if (existing.payloadHash !== input.payloadHash) {
    throw new MockHelcimIdempotencyMismatchError(input.idempotencyKey);
  }

  return input.state.idempotency.get(input.idempotencyKey) ?? null;
}

function getStoreState(store: PaymentMockStore): MockHelcimStoreState {
  const existing = storeState.get(store);

  if (existing) {
    return existing;
  }

  const created = {
    idempotency: new Map<string, StoredMockHelcimIdempotencyRecord>(),
    invoices: new Map<string, StoredMockHelcimInvoiceRecord>(),
    transactions: new Map<string, StoredMockHelcimTransactionRecord>(),
  };
  storeState.set(store, created);

  return created;
}

function clearHiddenStateAfterStoreReset(store: PaymentMockStore, state: MockHelcimStoreState): void {
  if (!isPublicStoreEmpty(store) || isHiddenStateEmpty(state)) {
    return;
  }

  state.idempotency.clear();
  state.invoices.clear();
  state.transactions.clear();
}

function isPublicStoreEmpty(store: PaymentMockStore): boolean {
  return store.idempotencyRecords.length === 0
    && store.providerOrders.length === 0
    && store.providerTransactions.length === 0
    && store.webhookEventRecords.length === 0;
}

function isHiddenStateEmpty(state: MockHelcimStoreState): boolean {
  return state.idempotency.size === 0
    && state.invoices.size === 0
    && state.transactions.size === 0;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeClock(now: Date | (() => Date) | undefined, store: PaymentMockStore): () => Date {
  if (typeof now === "function") {
    return () => new Date(now().getTime());
  }

  if (now instanceof Date) {
    return () => new Date(now.getTime());
  }

  return () => store.now();
}

function statusForScenario(scenario: PaymentMockScenario): string {
  switch (scenario) {
    case "decline":
      return "DECLINED";
    case "cancel":
      return "CANCELLED";
    case "refund":
      return "REFUNDED";
    case "refund_failed":
      return "REFUND_FAILED";
    default:
      return "APPROVED";
  }
}

function approvalCodeForScenario(scenario: PaymentMockScenario, sequence: number): string | undefined {
  return statusForScenario(scenario) === "APPROVED" ? `MOCK-APPROVAL-${sequence}` : undefined;
}

function getSequenceFromInvoiceNumber(invoiceNumber: string): number | null {
  const match = /^MOCK-INV-(\d+)$/.exec(invoiceNumber);

  return match ? Number.parseInt(match[1], 10) : null;
}

function getSequenceFromSecretToken(secretToken: string): number | null {
  const match = /^mock_helcim_secret_(\d+)$/.exec(secretToken);

  return match ? Number.parseInt(match[1], 10) : null;
}
