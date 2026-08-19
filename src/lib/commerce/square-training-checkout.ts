import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
} from "@/lib/payments/square/payments-client";
import {
  authorizeCaptureSquarePayment,
  type SquarePaymentChargeDependencies,
} from "@/lib/payments/square/square-payment-charge";
import type {
  FinalizeSquareTrainingCardPaymentInput,
  FinalizeSquareTrainingCardPaymentResult,
  SquareTrainingCardTransition,
} from "@/lib/commerce/square-training-card-finalizer";

const SQUARE_AUTHORIZED_STATUS = "APPROVED";

/**
 * Deterministic Square idempotency key for a reserved training order. Namespaced
 * apart from the product key so the two flows never collide.
 */
export function squareTrainingIdempotencyKey(orderReference: string): string {
  return `square-training/${orderReference}`;
}

export interface ChargeSquareTrainingOrderInput {
  orderReference: string;
  amountCents: number;
  currency: "CAD";
  sourceId: string;
  verificationToken?: string;
  /** Absolute origin used to build the scheduling URL in notifications. */
  origin?: string;
}

export type ChargeSquareTrainingOrderResult =
  | {
      ok: true;
      squarePaymentId: string;
      transition: SquareTrainingCardTransition;
    }
  | { ok: false; reason: string };

export interface ChargeSquareTrainingOrderDependencies {
  authorizePayment: (
    request: SquareCreatePaymentRequest,
  ) => Promise<SquareCreatePaymentResponse>;
  capturePayment: (paymentId: string, versionToken?: string) => Promise<void>;
  voidPayment: (paymentId: string) => Promise<void>;
  voidPaymentByIdempotencyKey: (idempotencyKey: string) => Promise<void>;
  finalize: (
    input: FinalizeSquareTrainingCardPaymentInput,
  ) => Promise<FinalizeSquareTrainingCardPaymentResult>;
  sendNotifications: (orderReference: string) => Promise<void>;
  logError: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Charge a reserved training order. Thin wrapper over the shared
 * {@link authorizeCaptureSquarePayment} core, supplying the training card
 * finalizer and the scheduling-token + notification side effect.
 */
export async function chargeSquareTrainingOrder(
  input: ChargeSquareTrainingOrderInput,
  dependencies: ChargeSquareTrainingOrderDependencies,
): Promise<ChargeSquareTrainingOrderResult> {
  const coreDependencies: SquarePaymentChargeDependencies<SquareTrainingCardTransition> =
    {
      authorizePayment: dependencies.authorizePayment,
      capturePayment: dependencies.capturePayment,
      voidPayment: dependencies.voidPayment,
      voidPaymentByIdempotencyKey: dependencies.voidPaymentByIdempotencyKey,
      finalize: dependencies.finalize,
      onSuccess: dependencies.sendNotifications,
      logError: dependencies.logError,
    };

  return authorizeCaptureSquarePayment<SquareTrainingCardTransition>(
    {
      orderReference: input.orderReference,
      amountCents: input.amountCents,
      currency: input.currency,
      sourceId: input.sourceId,
      ...(input.verificationToken
        ? { verificationToken: input.verificationToken }
        : {}),
      idempotencyKey: squareTrainingIdempotencyKey(input.orderReference),
    },
    coreDependencies,
  );
}

/**
 * Live wiring: resolves Square commerce credentials and runs the training
 * authorize→capture flow. In mock mode (dev only) it synthesizes an authorized
 * payment so the local flow works without live Square keys.
 */
export function createLiveSquareTrainingCharger(): (
  input: ChargeSquareTrainingOrderInput,
) => Promise<ChargeSquareTrainingOrderResult> {
  return async function chargeLiveSquareTrainingOrder(input) {
    const [
      { getSquareCommerceEnv, isPaymentMockMode },
      { createSquareCommercePayment, createSquarePaymentsClient },
      { finalizeSquareTrainingCardPayment },
      { notifyPaidTrainingOrder },
      { log },
    ] = await Promise.all([
      import("@/lib/env/private-checkout"),
      import("@/lib/payments/square/payments-client"),
      import("@/lib/commerce/square-training-card-finalizer"),
      import("@/lib/commerce/training-paid-notification"),
      import("@/lib/logging/logger"),
    ]);

    const env = getSquareCommerceEnv();
    if (!env) {
      return { ok: false, reason: "square_commerce_disabled" };
    }

    const logError = (message: string, meta: Record<string, unknown>) =>
      log("error", message, meta);
    const sendNotifications = (orderReference: string) =>
      notifyPaidTrainingOrder(orderReference, input.origin);

    if (isPaymentMockMode()) {
      return chargeSquareTrainingOrder(input, {
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
        finalize: finalizeSquareTrainingCardPayment,
        sendNotifications,
        logError,
      });
    }

    const client = createSquarePaymentsClient(env);

    return chargeSquareTrainingOrder(input, {
      authorizePayment: (request) => createSquareCommercePayment(env, request),
      capturePayment: async (paymentId, versionToken) => {
        await client.completePayment(paymentId, versionToken);
      },
      voidPayment: async (paymentId) => {
        await client.cancelPayment(paymentId);
      },
      voidPaymentByIdempotencyKey: (idempotencyKey) =>
        client.cancelPaymentByIdempotencyKey(idempotencyKey),
      finalize: finalizeSquareTrainingCardPayment,
      sendNotifications,
      logError,
    });
  };
}
