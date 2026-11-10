import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import type { TrainingCheckoutOrderRow } from "@/lib/commerce/training-enrollment-store";
import type { SquareCheckoutPayment } from "@/lib/payments/square/afterpay-policy";
import type {
  SquareCreatePaymentRequest,
  SquareCreatePaymentResponse,
  SquarePayment,
  SquarePaymentsClient,
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

type TrainingPaymentObservation =
  | { state: "ready" | "retry" | "review" | "unknown" }
  | { state: "captured"; squarePaymentId: string };

export interface ChargeSquareTrainingOrderDependencies {
  observePayment: (orderReference: string) => Promise<TrainingPaymentObservation>;
  authorizePayment: (
    request: SquareCreatePaymentRequest,
  ) => Promise<SquareCreatePaymentResponse>;
  capturePayment: (
    paymentId: string,
    versionToken?: string,
  ) => Promise<SquarePayment>;
  voidPayment: (paymentId: string) => Promise<void>;
  voidPaymentByIdempotencyKey: (idempotencyKey: string) => Promise<void>;
  finalize: (
    input: FinalizeSquareTrainingCardPaymentInput,
  ) => Promise<FinalizeSquareTrainingCardPaymentResult>;
  onCaptured: (
    orderReference: string,
    squarePaymentId: string,
  ) => Promise<boolean>;
  sendNotifications: (orderReference: string) => Promise<void>;
  logError: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Charge a reserved training order. Thin wrapper over the shared
 * {@link authorizeCaptureSquarePayment} core, supplying the training card
 * finalizer and requiring verified capture before training notifications.
 */
export async function chargeSquareTrainingOrder(
  input: ChargeSquareTrainingOrderInput,
  dependencies: ChargeSquareTrainingOrderDependencies,
): Promise<ChargeSquareTrainingOrderResult> {
  const reconcilePayment = async (
    expectedPaymentId?: string,
  ): Promise<ChargeSquareTrainingOrderResult | null> => {
    const observed = await dependencies.observePayment(input.orderReference);
    switch (observed.state) {
      case "ready":
        if (!expectedPaymentId) return null;
        break;
      case "retry":
        if (!expectedPaymentId) {
          return { ok: false, reason: "payment_failed", retryWithNewReservation: true };
        }
        break;
      case "review":
        return {
          ok: false,
          reason: "training_payment_requires_review",
          retryWithNewReservation: false,
        };
      case "captured":
        if (!expectedPaymentId || observed.squarePaymentId === expectedPaymentId) {
          return publishCapture(observed.squarePaymentId, "already_applied");
        }
        break;
    }
    return unconfirmed();
  };

  const unconfirmed = (): ChargeSquareTrainingOrderResult => {
    markWriterOperationUncertain();
    return { ok: false, reason: "payment_unconfirmed", retryWithNewReservation: false };
  };

  const publishCapture = async (
    squarePaymentId: string,
    transition: SquareTrainingCardTransition,
  ): Promise<ChargeSquareTrainingOrderResult> => {
    if (!(await dependencies.onCaptured(input.orderReference, squarePaymentId))) {
      return unconfirmed();
    }
    try {
      await dependencies.sendNotifications(input.orderReference);
    } catch (error) {
      markWriterOperationUncertain();
      dependencies.logError("[square-training] notification failed", {
        orderReference: input.orderReference,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return { ok: true, squarePaymentId, transition };
  };

  const recorded = await reconcilePayment();
  if (recorded) return recorded;

  // HTTP failures and idempotency conflicts do not prove that a previous
  // request failed. Rotate the reservation only after a terminal provider
  // response or a successful cancellation (including cancellation by key).
  let retryWithNewReservation = false;
  let captureConfirmed = false;
  const coreDependencies: SquarePaymentChargeDependencies<SquareTrainingCardTransition> =
    {
      authorizePayment: async (request) => {
        const response = await dependencies.authorizePayment(request);
        if (
          response.payment.reference_id !== undefined &&
          response.payment.reference_id !== request.reference_id
        ) {
          throw new Error("Square training authorization reference mismatch");
        }
        if (["FAILED", "CANCELED"].includes(response.payment.status)) {
          retryWithNewReservation = true;
        }
        return response;
      },
      capturePayment: async (paymentId, versionToken) => {
        const captured = await dependencies.capturePayment(paymentId, versionToken);
        if (!matchesTrainingPayment(captured, input, paymentId) || captured.status !== "COMPLETED") {
          throw new Error("Square training capture is unconfirmed");
        }
        captureConfirmed = true;
      },
      voidPayment: async (paymentId) => {
        await dependencies.voidPayment(paymentId);
        retryWithNewReservation = true;
      },
      voidPaymentByIdempotencyKey: async (idempotencyKey) => {
        await dependencies.voidPaymentByIdempotencyKey(idempotencyKey);
        retryWithNewReservation = true;
      },
      finalize: dependencies.finalize,
      onSuccess: async () => {},
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
  if (result.ok && captureConfirmed) {
    return publishCapture(result.squarePaymentId, result.transition);
  }

  // A concurrent request or an ambiguous capture may have recorded this
  // payment. Read the bound payment before sending notifications or rotating.
  return (
    (await reconcilePayment(result.ok ? result.squarePaymentId : undefined)) ??
    (result.ok ? unconfirmed() : { ...result, retryWithNewReservation })
  );
}

function matchesTrainingPayment(
  payment: SquarePayment,
  input: Pick<ChargeSquareTrainingOrderInput, "orderReference" | "amountCents" | "currency">,
  paymentId: string,
): boolean {
  return (
    payment.id === paymentId &&
    payment.amount_money.amount === input.amountCents &&
    payment.amount_money.currency === input.currency &&
    (payment.reference_id === undefined || payment.reference_id === input.orderReference)
  );
}

async function observeTrainingCardCapture(
  order: TrainingCheckoutOrderRow,
  client: Pick<SquarePaymentsClient, "getPayment"> | null,
): Promise<TrainingPaymentObservation> {
  const { orderId, providerPaymentId, providerStatus } = order;
  if (order.status !== "paid" || !providerPaymentId || order.currency !== "CAD") {
    return { state: "unknown" };
  }
  if (providerStatus === "UNCOLLECTED") return { state: "review" };

  if (!client) {
    const mockPaymentId = `mock-square-payment-${squareTrainingIdempotencyKey(orderId)}`;
    return providerStatus === "COMPLETED" && providerPaymentId === mockPaymentId
      ? { state: "captured", squarePaymentId: providerPaymentId }
      : { state: "unknown" };
  }

  const { payment } = await client.getPayment(providerPaymentId);
  const expected = { orderReference: orderId, amountCents: order.amountCents, currency: "CAD" as const };
  if (matchesTrainingPayment(payment, expected, providerPaymentId)) {
    if (payment.status === "COMPLETED") {
      return { state: "captured", squarePaymentId: providerPaymentId };
    }
    if (payment.status === "FAILED" || payment.status === "CANCELED") {
      return { state: "review" };
    }
  }
  return { state: "unknown" };
}

export async function verifyTrainingCardCapture(order: TrainingCheckoutOrderRow): Promise<boolean> {
  const [{ getSquarePaymentReadEnv, isPaymentMockMode }, { createSquarePaymentsClient }] =
    await Promise.all([
      import("@/lib/env/private-checkout"),
      import("@/lib/payments/square/payments-client"),
    ]);
  try {
    if (isPaymentMockMode()) {
      return (await observeTrainingCardCapture(order, null)).state === "captured";
    }
    const client = createSquarePaymentsClient(getSquarePaymentReadEnv());
    return (await observeTrainingCardCapture(order, client)).state === "captured";
  } catch {
    return false;
  }
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
      { findCheckoutOrderByOrderId, markSquareTrainingCardOrderCaptured },
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
    const mock = isPaymentMockMode();
    const client = mock ? null : createSquarePaymentsClient(env);
    const observePayment = async (orderReference: string): Promise<TrainingPaymentObservation> => {
      const order = await findCheckoutOrderByOrderId(orderReference);
      if (
        !order ||
        order.purpose !== "training" ||
        order.paymentProvider !== "square" ||
        order.providerMetadata?.flow !== "training_square_card" ||
        order.amountCents !== input.amountCents ||
        order.currency !== input.currency
      ) {
        return { state: "unknown" };
      }
      if (!order.providerPaymentId) {
        if (order.status === "pending" && order.providerStatus === "pending") {
          return { state: "ready" };
        }
        if (order.status === "verification_failed") return { state: "retry" };
        return { state: "unknown" };
      }
      try {
        return await observeTrainingCardCapture(order, client);
      } catch {
        logError("[square-training] retained payment verification failed", { orderReference });
        return { state: "unknown" };
      }
    };

    if (!client) {
      return chargeSquareTrainingOrder(input, {
        observePayment,
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
        capturePayment: async (paymentId) => ({
          id: paymentId,
          status: "COMPLETED",
          reference_id: input.orderReference,
          amount_money: { amount: input.amountCents, currency: input.currency },
        }),
        voidPayment: async () => undefined,
        voidPaymentByIdempotencyKey: async () => undefined,
        finalize: finalizeSquareTrainingCardPayment,
        onCaptured: markSquareTrainingCardOrderCaptured,
        sendNotifications,
        logError,
      });
    }

    return chargeSquareTrainingOrder(input, {
      observePayment,
      authorizePayment: (request) => createSquareCommercePayment(env, request),
      capturePayment: async (paymentId, versionToken) =>
        (await client.completePayment(paymentId, versionToken)).payment,
      voidPayment: async (paymentId) => {
        const response = await client.cancelPayment(paymentId);
        if (response.payment.id !== paymentId || response.payment.status !== "CANCELED") {
          throw new Error("Square payment cancellation is unconfirmed");
        }
      },
      voidPaymentByIdempotencyKey: (idempotencyKey) =>
        client.cancelPaymentByIdempotencyKey(idempotencyKey),
      finalize: finalizeSquareTrainingCardPayment,
      onCaptured: markSquareTrainingCardOrderCaptured,
      sendNotifications,
      logError,
    });
  };
}
