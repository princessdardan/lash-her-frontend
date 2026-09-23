import type { SquareCheckoutPayment } from "@/lib/payments/square/afterpay-policy";
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
  method?: SquareCheckoutPayment["method"];
  expectedAmountCents?: number;
  /** Absolute origin used to build the scheduling URL in notifications. */
  origin?: string;
}

export type ChargeSquareTrainingOrderResult =
  | {
      ok: true;
      squarePaymentId: string;
      transition: SquareTrainingCardTransition;
    }
  | { ok: false; reason: string; retryWithNewReservation: boolean };

export interface ChargeSquareTrainingOrderDependencies {
  /** Recover a locally committed payment before re-authorizing a retry. */
  findRecordedPayment?: (
    orderReference: string,
  ) => Promise<{ squarePaymentId: string } | null>;
  authorizePayment: (
    request: SquareCreatePaymentRequest,
  ) => Promise<SquareCreatePaymentResponse>;
  capturePayment: (paymentId: string, versionToken?: string) => Promise<void>;
  voidPayment: (paymentId: string) => Promise<void>;
  voidPaymentByIdempotencyKey: (idempotencyKey: string) => Promise<void>;
  finalize: (
    input: FinalizeSquareTrainingCardPaymentInput,
  ) => Promise<FinalizeSquareTrainingCardPaymentResult>;
  onCaptured?: (
    orderReference: string,
    squarePaymentId: string,
  ) => Promise<void>;
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
  const recoverRecordedPayment = async (): Promise<Extract<
    ChargeSquareTrainingOrderResult,
    { ok: true }
  > | null> => {
    const recorded = await dependencies.findRecordedPayment?.(
      input.orderReference,
    );
    if (!recorded) return null;
    try {
      await dependencies.sendNotifications(input.orderReference);
    } catch (error) {
      dependencies.logError("[square-training] retry notification failed", {
        orderReference: input.orderReference,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return { ok: true, ...recorded, transition: "already_applied" };
  };

  const recorded = await recoverRecordedPayment();
  if (recorded) return recorded;

  // HTTP failures and idempotency conflicts do not prove that a previous
  // request failed. Rotate the reservation only after a terminal provider
  // response or a successful cancellation (including cancellation by key).
  let retryWithNewReservation = false;
  const coreDependencies: SquarePaymentChargeDependencies<SquareTrainingCardTransition> =
    {
      authorizePayment: async (request) => {
        const response = await dependencies.authorizePayment(request);
        if (["FAILED", "CANCELED"].includes(response.payment.status)) {
          retryWithNewReservation = true;
        }
        return response;
      },
      capturePayment: dependencies.capturePayment,
      voidPayment: async (paymentId) => {
        await dependencies.voidPayment(paymentId);
        retryWithNewReservation = true;
      },
      voidPaymentByIdempotencyKey: async (idempotencyKey) => {
        await dependencies.voidPaymentByIdempotencyKey(idempotencyKey);
        retryWithNewReservation = true;
      },
      finalize: dependencies.finalize,
      onCaptured: dependencies.onCaptured,
      onSuccess: dependencies.sendNotifications,
      logError: dependencies.logError,
    };

  const result =
    await authorizeCaptureSquarePayment<SquareTrainingCardTransition>(
      {
        orderReference: input.orderReference,
        amountCents: input.amountCents,
        currency: input.currency,
        sourceId: input.sourceId,
        method: input.method,
        expectedAmountCents: input.expectedAmountCents,
        ...(input.verificationToken
          ? { verificationToken: input.verificationToken }
          : {}),
        idempotencyKey: squareTrainingIdempotencyKey(input.orderReference),
      },
      coreDependencies,
    );
  if (result.ok) return result;

  // Another request or webhook may have committed the payment while this
  // request was awaiting Square. Its paid order takes precedence over retry.
  return (
    (await recoverRecordedPayment()) ?? { ...result, retryWithNewReservation }
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
      { findCheckoutOrderByOrderId, markSquareCommerceOrderCaptured },
      { log },
    ] = await Promise.all([
      import("@/lib/env/private-checkout"),
      import("@/lib/payments/square/payments-client"),
      import("@/lib/commerce/square-training-card-finalizer"),
      import("@/lib/commerce/training-paid-notification"),
      import("@/lib/commerce/order-store"),
      import("@/lib/logging/logger"),
    ]);

    const env = getSquareCommerceEnv();
    if (!env) {
      return {
        ok: false,
        reason: "square_commerce_disabled",
        retryWithNewReservation: false,
      };
    }

    const logError = (message: string, meta: Record<string, unknown>) =>
      log("error", message, meta);
    const sendNotifications = (orderReference: string) =>
      notifyPaidTrainingOrder(orderReference, input.origin);
    const findRecordedPayment = async (orderReference: string) => {
      const order = await findCheckoutOrderByOrderId(orderReference);
      if (!order || order.status !== "paid") return null;
      if (
        order.purpose !== "training" ||
        order.paymentProvider !== "square" ||
        order.amountCents !== input.amountCents ||
        order.currency !== input.currency ||
        !order.providerPaymentId
      ) {
        throw new Error("Recorded training payment does not match checkout");
      }
      return { squarePaymentId: order.providerPaymentId };
    };

    if (isPaymentMockMode()) {
      return chargeSquareTrainingOrder(input, {
        findRecordedPayment,
        authorizePayment: async (request) => ({
          payment: {
            id: `mock-square-payment-${request.idempotency_key}`,
            status: SQUARE_AUTHORIZED_STATUS,
            reference_id: request.reference_id,
            source_type:
              input.method === "afterpay" ? "BUY_NOW_PAY_LATER" : "CARD",
            amount_money: request.amount_money,
          },
        }),
        capturePayment: async () => undefined,
        voidPayment: async () => undefined,
        voidPaymentByIdempotencyKey: async () => undefined,
        finalize: finalizeSquareTrainingCardPayment,
        onCaptured: markSquareCommerceOrderCaptured,
        sendNotifications,
        logError,
      });
    }

    const client = createSquarePaymentsClient(env);

    return chargeSquareTrainingOrder(input, {
      findRecordedPayment,
      authorizePayment: (request) => createSquareCommercePayment(env, request),
      capturePayment: async (paymentId, versionToken) => {
        await client.completePayment(paymentId, versionToken);
      },
      voidPayment: async (paymentId) => {
        const response = await client.cancelPayment(paymentId);
        if (response.payment.status !== "CANCELED") {
          throw new Error("Square payment cancellation is unconfirmed");
        }
      },
      voidPaymentByIdempotencyKey: (idempotencyKey) =>
        client.cancelPaymentByIdempotencyKey(idempotencyKey),
      finalize: finalizeSquareTrainingCardPayment,
      onCaptured: markSquareCommerceOrderCaptured,
      sendNotifications,
      logError,
    });
  };
}
