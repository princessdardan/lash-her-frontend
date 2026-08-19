import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
} from "@/lib/payments/square/payments-client";
import type {
  FinalizeSquareProductPaymentInput,
  FinalizeSquareProductPaymentResult,
} from "@/lib/commerce/square-product-finalizer";

const SQUARE_AUTHORIZED_STATUS = "APPROVED";

/**
 * Deterministic Square idempotency key for a reserved product order. Stable
 * across retries of the same reservation so a replayed create-payment returns
 * the original authorization instead of charging again, and so a dangling
 * authorization can be voided by key after a post-authorize network failure.
 */
export function squareCommerceIdempotencyKey(orderReference: string): string {
  return `square-primary/${orderReference}`;
}

export interface ChargeSquareProductOrderInput {
  orderReference: string;
  /** Reserved primary obligation total, in cents — the exact amount to charge. */
  amountCents: number;
  currency: "CAD";
  /** Single-use card nonce from the Web Payments SDK `tokenize`. */
  sourceId: string;
  /** SCA verification token from `tokenize`, when present. */
  verificationToken?: string;
}

export type ChargeSquareProductOrderResult =
  | {
      ok: true;
      squarePaymentId: string;
      transition: FinalizeSquareProductPaymentResult["transition"];
    }
  | { ok: false; reason: string };

export interface ChargeSquareProductOrderDependencies {
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
  finalize: (
    input: FinalizeSquareProductPaymentInput,
  ) => Promise<FinalizeSquareProductPaymentResult>;
  sendConfirmationEmail: (orderId: string) => Promise<void>;
  logError: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Authorize → verify → record locally → capture. Money is only captured after
 * the local money-ledger commit succeeds, so a finalize failure can be undone
 * by voiding the (uncaptured) authorization — there are no orphaned captures.
 */
export async function chargeSquareProductOrder(
  input: ChargeSquareProductOrderInput,
  dependencies: ChargeSquareProductOrderDependencies,
): Promise<ChargeSquareProductOrderResult> {
  const idempotencyKey = squareCommerceIdempotencyKey(input.orderReference);

  let payment: SquareCreatePaymentResponse["payment"];
  try {
    const response = await dependencies.authorizePayment({
      idempotency_key: idempotencyKey,
      source_id: input.sourceId,
      amount_money: {
        amount: input.amountCents,
        currency: input.currency,
      },
      autocomplete: false,
      reference_id: input.orderReference,
      ...(input.verificationToken
        ? { verification_token: input.verificationToken }
        : {}),
    });
    payment = response.payment;
  } catch (error) {
    dependencies.logError("[checkout] Square commerce authorization failed", {
      orderReference: input.orderReference,
      error: getErrorMessage(error),
    });
    // A post-authorize network failure may have left a hold; void it by key.
    await voidByKeySafe(dependencies, idempotencyKey);
    return { ok: false, reason: "payment_failed" };
  }

  // Server-authoritative verification of the authorization Square granted.
  if (payment.status !== SQUARE_AUTHORIZED_STATUS) {
    dependencies.logError("[checkout] Square commerce not authorized", {
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
    dependencies.logError("[checkout] Square commerce amount mismatch", {
      orderReference: input.orderReference,
    });
    await voidSafe(dependencies, payment.id);
    return { ok: false, reason: "amount_mismatch" };
  }

  // Record the money locally BEFORE capturing, so a finalize failure leaves an
  // uncaptured authorization we can void rather than a captured orphan.
  let finalized: FinalizeSquareProductPaymentResult;
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
    dependencies.logError("[checkout] Square commerce finalization threw", {
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
    dependencies.logError("[checkout] Square commerce finalization conflict", {
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
    } catch (error) {
      // Rare: the order is recorded paid but capture did not complete. Do not
      // void (that would contradict the paid order + activated shipment) — the
      // Square webhook / reconciliation sweep must complete or flag it.
      dependencies.logError(
        "[checkout] Square commerce capture after finalize failed",
        {
          orderReference: input.orderReference,
          squarePaymentId: payment.id,
          error: getErrorMessage(error),
        },
      );
    }
  }

  // Confirmation email is a non-blocking side effect (enqueued to the outbox).
  try {
    await dependencies.sendConfirmationEmail(input.orderReference);
  } catch (error) {
    dependencies.logError(
      "[checkout] Square order confirmation email enqueue failed",
      {
        orderReference: input.orderReference,
        error: getErrorMessage(error),
      },
    );
  }

  return {
    ok: true,
    squarePaymentId: payment.id,
    transition: finalized.transition,
  };
}

/**
 * Live wiring: resolves Square commerce credentials and runs the
 * authorize→capture flow through the Payments API. In {@link isPaymentMockMode}
 * (dev only) it synthesizes an authorized payment so the local flow works
 * without live Square keys.
 */
export function createLiveSquareProductCharger(): (
  input: ChargeSquareProductOrderInput,
) => Promise<ChargeSquareProductOrderResult> {
  return async function chargeLiveSquareProductOrder(input) {
    const [
      { getSquareCommerceEnv, isPaymentMockMode },
      { createSquareCommercePayment, createSquarePaymentsClient },
      { finalizeSquareProductPayment },
      { sendProductOrderConfirmationEmailForOrder },
      { log },
    ] = await Promise.all([
      import("@/lib/env/private-checkout"),
      import("@/lib/payments/square/payments-client"),
      import("@/lib/commerce/square-product-finalizer"),
      import("@/lib/commerce/product-order-email"),
      import("@/lib/logging/logger"),
    ]);

    const env = getSquareCommerceEnv();
    if (!env) {
      return { ok: false, reason: "square_commerce_disabled" };
    }

    const logError = (message: string, meta: Record<string, unknown>) =>
      log("error", message, meta);

    if (isPaymentMockMode()) {
      return chargeSquareProductOrder(input, {
        authorizePayment: async (request) => ({
          payment: {
            id: `mock-square-payment-${request.idempotency_key}`,
            status: SQUARE_AUTHORIZED_STATUS,
            reference_id: request.reference_id,
            source_type: "CARD",
            amount_money: request.amount_money,
          },
        }),
        capturePayment: async () => undefined,
        voidPayment: async () => undefined,
        voidPaymentByIdempotencyKey: async () => undefined,
        finalize: finalizeSquareProductPayment,
        sendConfirmationEmail: sendProductOrderConfirmationEmailForOrder,
        logError,
      });
    }

    const client = createSquarePaymentsClient(env);

    return chargeSquareProductOrder(input, {
      authorizePayment: (request) => createSquareCommercePayment(env, request),
      capturePayment: async (paymentId, versionToken) => {
        await client.completePayment(paymentId, versionToken);
      },
      voidPayment: async (paymentId) => {
        await client.cancelPayment(paymentId);
      },
      voidPaymentByIdempotencyKey: (idempotencyKey) =>
        client.cancelPaymentByIdempotencyKey(idempotencyKey),
      finalize: finalizeSquareProductPayment,
      sendConfirmationEmail: sendProductOrderConfirmationEmailForOrder,
      logError,
    });
  };
}

async function voidSafe(
  dependencies: Pick<
    ChargeSquareProductOrderDependencies,
    "voidPayment" | "logError"
  >,
  paymentId: string,
): Promise<void> {
  try {
    await dependencies.voidPayment(paymentId);
  } catch (error) {
    dependencies.logError("[checkout] Square commerce void failed", {
      squarePaymentId: paymentId,
      error: getErrorMessage(error),
    });
  }
}

async function voidByKeySafe(
  dependencies: Pick<
    ChargeSquareProductOrderDependencies,
    "voidPaymentByIdempotencyKey" | "logError"
  >,
  idempotencyKey: string,
): Promise<void> {
  try {
    await dependencies.voidPaymentByIdempotencyKey(idempotencyKey);
  } catch (error) {
    dependencies.logError("[checkout] Square commerce void-by-key failed", {
      error: getErrorMessage(error),
    });
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Square charge error";
}
