import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
} from "@/lib/payments/square/payments-client";
import {
  authorizeCaptureSquarePayment,
  type SquarePaymentChargeDependencies,
} from "@/lib/payments/square/square-payment-charge";
import type {
  FinalizeSquareProductPaymentInput,
  FinalizeSquareProductPaymentResult,
} from "@/lib/commerce/square-product-finalizer";

const SQUARE_AUTHORIZED_STATUS = "APPROVED";

type ProductTransition = FinalizeSquareProductPaymentResult["transition"];

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
 * Charge a reserved product order. Thin wrapper over the shared
 * {@link authorizeCaptureSquarePayment} core, supplying the product
 * money-ledger finalizer and the confirmation-email side effect.
 */
export async function chargeSquareProductOrder(
  input: ChargeSquareProductOrderInput,
  dependencies: ChargeSquareProductOrderDependencies,
): Promise<ChargeSquareProductOrderResult> {
  const coreDependencies: SquarePaymentChargeDependencies<ProductTransition> = {
    authorizePayment: dependencies.authorizePayment,
    capturePayment: dependencies.capturePayment,
    voidPayment: dependencies.voidPayment,
    voidPaymentByIdempotencyKey: dependencies.voidPaymentByIdempotencyKey,
    finalize: dependencies.finalize,
    onSuccess: dependencies.sendConfirmationEmail,
    logError: dependencies.logError,
  };

  return authorizeCaptureSquarePayment<ProductTransition>(
    {
      orderReference: input.orderReference,
      amountCents: input.amountCents,
      currency: input.currency,
      sourceId: input.sourceId,
      ...(input.verificationToken
        ? { verificationToken: input.verificationToken }
        : {}),
      idempotencyKey: squareCommerceIdempotencyKey(input.orderReference),
    },
    coreDependencies,
  );
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
