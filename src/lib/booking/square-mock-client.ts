import { createHash } from "node:crypto";

import type { PaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import type { PaymentMockScenario } from "@/lib/payment-mocks/scenarios";

import type {
  SquareClient,
  SquareCreatePaymentLinkRequest,
  SquareCreatePaymentLinkResponse,
  SquareGetPaymentResponse,
} from "./square-client";

export interface MockSquareClientOptions {
  amountCents?: number;
  currency?: string;
  now?: Date | (() => Date);
  scenario: PaymentMockScenario;
  store?: PaymentMockStore;
}

export interface MockSquareRefundRequest {
  amountCents?: number;
  idempotencyKey?: string;
  paymentId: string;
}

export interface MockSquareRefundResponse {
  refund: {
    amount_money?: {
      amount?: number;
      currency?: string;
    };
    error_code?: "PAYMENT_NOT_REFUNDABLE" | "REFUND_AMOUNT_INVALID" | "REFUND_ERROR_PAYMENT_NEEDS_COMPLETION";
    message?: string;
    id: string;
    payment_id: string;
    status: "COMPLETED" | "FAILED" | "REJECTED";
  };
}

export interface MockSquareWebhookRecordResult {
  duplicate: boolean;
  event_id: string;
}

export type MockSquareClient = SquareClient & {
  recordWebhookEvent(eventId: string, payload: unknown): MockSquareWebhookRecordResult;
  refundPayment(request: MockSquareRefundRequest): Promise<MockSquareRefundResponse>;
};

interface MockPaymentLinkState {
  amountCents: number;
  currency: string;
  localOrderId: string;
  paymentId: string;
  response: SquareCreatePaymentLinkResponse;
  squareOrderId: string;
}

interface SharedMockSquareState {
  paymentLinksByIdempotencyKey: Map<string, MockPaymentLinkState>;
  paymentLinksByPaymentId: Map<string, MockPaymentLinkState>;
  paymentLinksByOrderId: Map<string, MockPaymentLinkState>;
}

const sharedStateByStore = new WeakMap<PaymentMockStore, SharedMockSquareState>();

export function createMockSquareClient(options: MockSquareClientOptions): MockSquareClient {
  const store = options.store ?? createPaymentMockStore({ now: options.now });
  const sharedState = getSharedState(store);

  return {
    async createPaymentLink(request) {
      const payloadHash = hashJson(request);
      const existingIdempotencyRecord = store.getIdempotencyRecord(request.idempotency_key);

      if (existingIdempotencyRecord !== null) {
        if (existingIdempotencyRecord.payloadHash !== payloadHash) {
          throw new Error(`Square idempotency key ${request.idempotency_key} was reused with a different payload`);
        }

        const existingPaymentLink = sharedState.paymentLinksByIdempotencyKey.get(request.idempotency_key);
        if (existingPaymentLink !== undefined) {
          return existingPaymentLink.response;
        }
      }

      const sequence = store.nextSequence();
      const squareOrderId = `mock-square-order-${sequence}`;
      const paymentId = `mock-square-payment-${sequence}`;
      const localOrderId = getLocalOrderId(request);
      const amountCents = options.amountCents ?? request.order?.line_items[0]?.base_price_money.amount ?? 0;
      const currency = options.currency ?? request.order?.line_items[0]?.base_price_money.currency ?? "CAD";
      const response = {
        payment_link: {
          id: `mock-square-payment-link-${sequence}`,
          order_id: squareOrderId,
          url: `http://localhost:3000/api/booking/square/return?orderId=${encodeURIComponent(localOrderId)}&paymentId=${encodeURIComponent(paymentId)}`,
        },
      } satisfies SquareCreatePaymentLinkResponse;
      const state: MockPaymentLinkState = {
        amountCents,
        currency,
        localOrderId,
        paymentId,
        response,
        squareOrderId,
      };

      store.recordIdempotencyRecord({
        createdAt: store.now(),
        idempotencyKey: request.idempotency_key,
        payloadHash,
        provider: "square",
        scenario: options.scenario,
      });
      store.recordProviderOrder({
        createdAt: store.now(),
        orderId: squareOrderId,
        provider: "square",
        scenario: options.scenario,
        status: toOrderStatus(options.scenario),
      });
      store.recordProviderTransaction({
        createdAt: store.now(),
        orderId: squareOrderId,
        provider: "square",
        scenario: options.scenario,
        status: options.scenario === "temporary_error" ? "TEMPORARY_ERROR_PENDING" : toPaymentStatus(options.scenario),
        transactionId: paymentId,
      });

      sharedState.paymentLinksByIdempotencyKey.set(request.idempotency_key, state);
      sharedState.paymentLinksByPaymentId.set(paymentId, state);
      sharedState.paymentLinksByOrderId.set(squareOrderId, state);

      return response;
    },

    async getOrder(orderId) {
      const state = sharedState.paymentLinksByOrderId.get(orderId);
      const orderRecord = store.getProviderOrder(orderId);

      if (state === undefined || orderRecord === null) {
        throw new Error(`Mock Square order ${orderId} was not found`);
      }

      return {
        order: {
          id: state.squareOrderId,
          reference_id: state.localOrderId,
          state: orderRecord.status,
          total_money: {
            amount: state.amountCents,
            currency: state.currency,
          },
        },
      };
    },

    async getPayment(paymentId) {
      const state = sharedState.paymentLinksByPaymentId.get(paymentId);
      const transactionRecord = store.getProviderTransaction(paymentId);

      if (state === undefined || transactionRecord === null) {
        throw new Error(`Mock Square payment ${paymentId} was not found`);
      }

      if (transactionRecord.status === "TEMPORARY_ERROR_PENDING") {
        store.recordProviderTransaction({
          ...transactionRecord,
          status: "COMPLETED",
        });

        const error = new Error("TEMPORARY_ERROR");
        Object.assign(error, { retryable: true });
        throw error;
      }

      return toPaymentResponse(state, transactionRecord.status);
    },

    recordWebhookEvent(eventId, payload) {
      const existing = store.getWebhookEvent(eventId);

      if (existing !== null) {
        return { duplicate: true, event_id: eventId };
      }

      store.recordWebhookEvent({
        createdAt: store.now(),
        eventId,
        payloadHash: hashJson(payload),
        provider: "square",
        scenario: options.scenario,
      });

      return { duplicate: false, event_id: eventId };
    },

    async refundPayment(request) {
      const state = sharedState.paymentLinksByPaymentId.get(request.paymentId);
      const transactionRecord = store.getProviderTransaction(request.paymentId);

      if (state === undefined || transactionRecord === null) {
        throw new Error(`Mock Square payment ${request.paymentId} was not found`);
      }

      if (request.amountCents !== undefined && (request.amountCents <= 0 || request.amountCents > state.amountCents)) {
        return {
          refund: {
            amount_money: {
              amount: request.amountCents,
              currency: state.currency,
            },
            error_code: "REFUND_AMOUNT_INVALID",
            message: "Refund amount is invalid",
            id: `mock-square-refund-${store.nextSequence()}`,
            payment_id: request.paymentId,
            status: "FAILED",
          },
        };
      }

      if (options.scenario === "refund_failed") {
        return {
          refund: {
            amount_money: {
              amount: request.amountCents ?? state.amountCents,
              currency: state.currency,
            },
            error_code: "PAYMENT_NOT_REFUNDABLE",
            message: "Payment is not refundable",
            id: `mock-square-refund-${store.nextSequence()}`,
            payment_id: request.paymentId,
            status: "FAILED",
          },
        };
      }

      if (transactionRecord.status !== "COMPLETED") {
        return {
          refund: {
            amount_money: {
              amount: request.amountCents ?? state.amountCents,
              currency: state.currency,
            },
            error_code: "REFUND_ERROR_PAYMENT_NEEDS_COMPLETION",
            message: "Payment must be completed before it can be refunded",
            id: `mock-square-refund-${store.nextSequence()}`,
            payment_id: request.paymentId,
            status: "REJECTED",
          },
        };
      }

      return {
        refund: {
          amount_money: {
            amount: request.amountCents ?? state.amountCents,
            currency: state.currency,
          },
          id: `mock-square-refund-${store.nextSequence()}`,
          payment_id: request.paymentId,
          status: toRefundStatus(options.scenario),
        },
      };
    },
  };
}

function getSharedState(store: PaymentMockStore): SharedMockSquareState {
  const existingState = sharedStateByStore.get(store);

  if (existingState !== undefined) {
    return existingState;
  }

  const state = {
    paymentLinksByIdempotencyKey: new Map<string, MockPaymentLinkState>(),
    paymentLinksByPaymentId: new Map<string, MockPaymentLinkState>(),
    paymentLinksByOrderId: new Map<string, MockPaymentLinkState>(),
  };

  sharedStateByStore.set(store, state);
  return state;
}

function getLocalOrderId(request: SquareCreatePaymentLinkRequest): string {
  return request.order?.reference_id ?? request.order?.metadata?.lh_order_id ?? request.idempotency_key;
}

function toPaymentResponse(state: MockPaymentLinkState, status: string): SquareGetPaymentResponse {
  return {
    payment: {
      amount_money: {
        amount: state.amountCents,
        currency: state.currency,
      },
      id: state.paymentId,
      order_id: state.squareOrderId,
      status,
      total_money: {
        amount: state.amountCents,
        currency: state.currency,
      },
    },
  };
}

function toOrderStatus(scenario: PaymentMockScenario): string {
  switch (scenario) {
    case "cancel":
    case "decline":
      return "CANCELED";
    default:
      return "OPEN";
  }
}

function toPaymentStatus(scenario: PaymentMockScenario): string {
  switch (scenario) {
    case "cancel":
      return "CANCELED";
    case "decline":
      return "FAILED";
    case "delayed_capture":
      return "APPROVED";
    default:
      return "COMPLETED";
  }
}

function toRefundStatus(scenario: PaymentMockScenario): MockSquareRefundResponse["refund"]["status"] {
  switch (scenario) {
    case "refund_failed":
      return "FAILED";
    case "decline":
    case "cancel":
      return "REJECTED";
    default:
      return "COMPLETED";
  }
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
