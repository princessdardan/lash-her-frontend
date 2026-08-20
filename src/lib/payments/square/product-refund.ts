import type {
  SquareApiError,
  SquareRefundPaymentRequest,
  SquareRefundPaymentResponse,
} from "@/lib/payments/square/payments-client";

/**
 * Minimal client port for issuing a Square refund. `createSquarePaymentsClient`
 * satisfies this structurally; tests inject a fake. Kept as a narrow port so
 * this module stays free of the `server-only` payments client and remains unit
 * testable.
 */
export interface SquareRefundClient {
  refundPayment(
    request: SquareRefundPaymentRequest,
  ): Promise<SquareRefundPaymentResponse>;
}

export interface SquareProductRefundInput {
  /** Square payment id of the original capture (`orderPaymentTransactions.providerTransactionId`). */
  paymentId: string;
  amountCents: number;
  currency: string;
  /** Deterministic idempotency key (the refund row's stored key) — prevents double refunds on retry. */
  idempotencyKey: string;
  reason?: string;
}

/**
 * Discriminated outcome of a Square product refund attempt.
 *
 * `settled` is true only when Square reports the refund COMPLETED
 * synchronously. A PENDING refund returns `ok:true, settled:false`; the money
 * movement is accepted but final settlement is confirmed later by the
 * `refund.updated` webhook reconciliation, so the caller must NOT mark it
 * succeeded yet. `deterministic` on a failure means a client-side rejection
 * (safe to route to manual review); a non-deterministic failure is a
 * transient/unknown outcome that must not be treated as "no refund happened".
 */
export type SquareProductRefundOutcome =
  | {
      ok: true;
      refundId: string;
      paymentId: string;
      amountCents: number;
      currency: string;
      settled: boolean;
    }
  | { ok: false; deterministic: boolean; code: string };

export interface SquareProductRefunder {
  refundPayment(
    input: SquareProductRefundInput,
  ): Promise<SquareProductRefundOutcome>;
}

const SETTLED_REFUND_STATUS = "COMPLETED";
const PENDING_REFUND_STATUS = "PENDING";

/**
 * Wraps a Square payments client as a normalized product refunder. Translates
 * the raw Square refund response into a {@link SquareProductRefundOutcome} and
 * classifies API/network failures into deterministic vs transient. Correlation
 * of the returned fields against the reserved refund (payment id, amount,
 * currency) is the caller's responsibility.
 */
export function createSquareProductRefunder(
  client: SquareRefundClient,
): SquareProductRefunder {
  return {
    async refundPayment(input) {
      let response: SquareRefundPaymentResponse;
      try {
        response = await client.refundPayment({
          idempotency_key: input.idempotencyKey,
          payment_id: input.paymentId,
          amount_money: {
            amount: input.amountCents,
            currency: input.currency,
          },
          ...(input.reason ? { reason: input.reason } : {}),
        });
      } catch (error) {
        return classifySquareRefundError(error);
      }

      const refund = response.refund;
      const status = refund.status.toUpperCase();

      // Square accepts a refund as either COMPLETED (settled now) or PENDING
      // (settled asynchronously, confirmed by the refund.updated webhook). Any
      // other status (REJECTED / FAILED) is a deterministic refusal.
      if (
        status !== SETTLED_REFUND_STATUS &&
        status !== PENDING_REFUND_STATUS
      ) {
        return {
          ok: false,
          deterministic: true,
          code: `SQUARE_REFUND_${status}`,
        };
      }

      return {
        ok: true,
        refundId: refund.id,
        paymentId: refund.payment_id ?? input.paymentId,
        amountCents: refund.amount_money.amount,
        currency: refund.amount_money.currency,
        settled: status === SETTLED_REFUND_STATUS,
      };
    },
  };
}

function classifySquareRefundError(error: unknown): SquareProductRefundOutcome {
  if (isSquareApiError(error)) {
    // 4xx (except 409 conflict) is a deterministic client rejection; 409 and
    // 5xx are transient/unknown and safe to retry without double-refunding.
    const deterministic =
      error.status >= 400 && error.status < 500 && error.status !== 409;
    return {
      ok: false,
      deterministic,
      code: error.code ? `SQUARE_${error.code}` : `SQUARE_${error.status}`,
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { ok: false, deterministic: false, code: "TIMEOUT" };
  }
  return { ok: false, deterministic: false, code: "OUTCOME_UNKNOWN" };
}

function isSquareApiError(error: unknown): error is SquareApiError {
  return (
    error instanceof Error &&
    error.name === "SquareApiError" &&
    typeof (error as { status?: unknown }).status === "number"
  );
}
