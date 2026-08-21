import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
} from "@/lib/payments/square/payments-client";

const SQUARE_AUTHORIZED_STATUS = "APPROVED";

/**
 * Shared, provider-neutral core for a one-time Square commerce sale
 * (product and primary-training checkout).
 *
 * Contract: **authorize → verify → record locally → capture**. Money is only
 * captured after the caller's local money-ledger commit (`finalize`) succeeds,
 * so any pre-capture failure voids the (uncaptured) authorization — there are
 * no orphaned captures and no double charges. This is the single audited
 * implementation of that compensation logic; product and training checkout are
 * thin wrappers that supply their own `finalize` and `onSuccess`.
 */
export interface SquarePaymentChargeInput {
  orderReference: string;
  /** Server-authoritative amount to charge, in cents. */
  amountCents: number;
  currency: string;
  /** Single-use card nonce from the Web Payments SDK `tokenize`. */
  sourceId: string;
  verificationToken?: string;
  /** Deterministic Square idempotency key derived from the reserved order. */
  idempotencyKey: string;
}

export interface SquareFinalizeInput {
  orderReference: string;
  squarePaymentId: string;
  amountCents: number;
  currency: string;
  providerType: string;
  providerStatus: string;
}

export interface SquarePaymentChargeDependencies<T extends string> {
  /** Authorize (hold) the card — `autocomplete: false`. Does not capture. */
  authorizePayment: (
    request: SquareCreatePaymentRequest,
  ) => Promise<SquareCreatePaymentResponse>;
  /** Capture a previously authorized payment. */
  capturePayment: (paymentId: string, versionToken?: string) => Promise<void>;
  /** Void an authorized-but-uncaptured payment. */
  voidPayment: (paymentId: string) => Promise<void>;
  /** Void any authorization created under an idempotency key. */
  voidPaymentByIdempotencyKey: (idempotencyKey: string) => Promise<void>;
  /** Record the payment in the local ledger. Runs before capture. */
  finalize: (input: SquareFinalizeInput) => Promise<{ transition: T }>;
  /**
   * Record that the funds were actually captured (e.g. flip the order's provider
   * status to COMPLETED), so the capture-reconciliation sweep can distinguish a
   * captured order from a paid-but-uncaptured one. Runs only after a successful
   * capture; failures here are non-fatal (the sweep still recovers).
   */
  onCaptured?: (
    orderReference: string,
    squarePaymentId: string,
  ) => Promise<void>;
  /** Non-blocking side effect after a successful record (email/notifications). */
  onSuccess: (orderReference: string) => Promise<void>;
  logError: (message: string, meta: Record<string, unknown>) => void;
}

export type SquarePaymentChargeResult<T extends string> =
  | { ok: true; squarePaymentId: string; transition: T }
  | { ok: false; reason: string };

export async function authorizeCaptureSquarePayment<T extends string>(
  input: SquarePaymentChargeInput,
  dependencies: SquarePaymentChargeDependencies<T>,
): Promise<SquarePaymentChargeResult<T>> {
  let payment: SquareCreatePaymentResponse["payment"];
  try {
    const response = await dependencies.authorizePayment({
      idempotency_key: input.idempotencyKey,
      source_id: input.sourceId,
      amount_money: { amount: input.amountCents, currency: input.currency },
      autocomplete: false,
      reference_id: input.orderReference,
      ...(input.verificationToken
        ? { verification_token: input.verificationToken }
        : {}),
    });
    payment = response.payment;
  } catch (error) {
    dependencies.logError("[square-charge] authorization failed", {
      orderReference: input.orderReference,
      error: getErrorMessage(error),
    });
    // A post-authorize network failure may have left a hold; void it by key.
    await voidByKeySafe(dependencies, input.idempotencyKey);
    return { ok: false, reason: "payment_failed" };
  }

  // Server-authoritative verification of the authorization Square granted.
  if (payment.status !== SQUARE_AUTHORIZED_STATUS) {
    dependencies.logError("[square-charge] not authorized", {
      orderReference: input.orderReference,
      status: payment.status,
    });
    await voidSafe(dependencies, payment.id);
    return { ok: false, reason: "payment_not_authorized" };
  }
  if (
    payment.amount_money.amount !== input.amountCents ||
    payment.amount_money.currency.toUpperCase() !== input.currency.toUpperCase()
  ) {
    dependencies.logError("[square-charge] amount mismatch", {
      orderReference: input.orderReference,
    });
    await voidSafe(dependencies, payment.id);
    return { ok: false, reason: "amount_mismatch" };
  }

  // Record the money locally BEFORE capturing, so a finalize failure leaves an
  // uncaptured authorization we can void rather than a captured orphan.
  let finalized: { transition: T };
  try {
    finalized = await dependencies.finalize({
      orderReference: input.orderReference,
      squarePaymentId: payment.id,
      amountCents: payment.amount_money.amount,
      currency: payment.amount_money.currency,
      providerType: payment.source_type ?? "CARD",
      providerStatus: payment.status,
    });
  } catch (error) {
    dependencies.logError("[square-charge] finalization threw", {
      orderReference: input.orderReference,
      squarePaymentId: payment.id,
      error: getErrorMessage(error),
    });
    await voidSafe(dependencies, payment.id);
    return { ok: false, reason: "finalize_failed" };
  }

  if (
    finalized.transition !== "applied" &&
    finalized.transition !== "already_applied"
  ) {
    dependencies.logError("[square-charge] finalization conflict", {
      orderReference: input.orderReference,
      transition: finalized.transition,
      squarePaymentId: payment.id,
    });
    await voidSafe(dependencies, payment.id);
    return { ok: false, reason: finalized.transition };
  }

  // Ledger committed. Capture the held funds. `already_applied` means a prior
  // run already recorded (and captured) this payment, so do not re-capture.
  if (finalized.transition === "applied") {
    try {
      await dependencies.capturePayment(payment.id, payment.version_token);
      if (dependencies.onCaptured) {
        try {
          await dependencies.onCaptured(input.orderReference, payment.id);
        } catch (error) {
          // Non-fatal: the order is captured; only the COMPLETED marker is
          // missing, so the reconciliation sweep will re-confirm and mark it.
          dependencies.logError("[square-charge] mark-captured failed", {
            orderReference: input.orderReference,
            squarePaymentId: payment.id,
            error: getErrorMessage(error),
          });
        }
      }
    } catch (error) {
      // Rare: the order is recorded paid but capture did not complete. Do not
      // void (that would contradict the paid order) — the Square webhook /
      // reconciliation sweep must complete or flag it.
      dependencies.logError("[square-charge] capture after finalize failed", {
        orderReference: input.orderReference,
        squarePaymentId: payment.id,
        error: getErrorMessage(error),
      });
    }
  }

  // Success side effect (email/notifications) is best-effort and non-blocking.
  try {
    await dependencies.onSuccess(input.orderReference);
  } catch (error) {
    dependencies.logError("[square-charge] success side effect failed", {
      orderReference: input.orderReference,
      error: getErrorMessage(error),
    });
  }

  return {
    ok: true,
    squarePaymentId: payment.id,
    transition: finalized.transition,
  };
}

async function voidSafe<T extends string>(
  dependencies: Pick<
    SquarePaymentChargeDependencies<T>,
    "voidPayment" | "logError"
  >,
  paymentId: string,
): Promise<void> {
  try {
    await dependencies.voidPayment(paymentId);
  } catch (error) {
    dependencies.logError("[square-charge] void failed", {
      squarePaymentId: paymentId,
      error: getErrorMessage(error),
    });
  }
}

async function voidByKeySafe<T extends string>(
  dependencies: Pick<
    SquarePaymentChargeDependencies<T>,
    "voidPaymentByIdempotencyKey" | "logError"
  >,
  idempotencyKey: string,
): Promise<void> {
  try {
    await dependencies.voidPaymentByIdempotencyKey(idempotencyKey);
  } catch (error) {
    dependencies.logError("[square-charge] void-by-key failed", {
      error: getErrorMessage(error),
    });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Square charge error";
}
