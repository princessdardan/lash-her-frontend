import { finalizeSquarePayment } from "@/lib/booking/square-payment-finalizer";
import {
  createServicePaymentAlertLogger,
  type ServicePaymentAlertLogger,
} from "@/lib/booking/payments/service-payment-alerts";
import {
  isNoShowChargeEventType,
  type NoShowChargeFinalizerResult,
} from "@/lib/booking/payments/service-no-show-charge-finalizer";
import {
  getSquareWebhookHeaders,
  parseVerifiedSquareWebhook,
  verifySquareWebhookSignature,
} from "@/lib/booking/square-webhook";
import type {
  CheckoutOrderRow,
  SquareInvoiceWebhookEventInput,
} from "@/lib/commerce/order-store";
import type { SquarePayment } from "@/lib/payments/square/payments-client";
import type {
  RecoverSquareCommercePaymentInput,
  SquareCommerceOrderKind,
  SquareCommerceRecoveryResult,
} from "@/lib/commerce/square-commerce-webhook-recovery";

export const runtime = "nodejs";

const SQUARE_INVOICE_PAID_EVENT_TYPES = ["invoice.payment_made"] as const;
const SERVICE_BOOKING_RECONCILIATION_EVENT_TYPES = [
  "order.updated",
  "payment.created",
  "payment.updated",
] as const;
type SquareInvoicePaidEventType =
  (typeof SQUARE_INVOICE_PAID_EVENT_TYPES)[number];
type VerifiedSquareWebhookEvent = ReturnType<typeof parseVerifiedSquareWebhook>;

interface TrainingSquareInvoiceFinalizerInput {
  event: VerifiedSquareWebhookEvent;
  order: CheckoutOrderRow;
  source: "webhook";
  squareInvoiceId: string;
}

interface TrainingSquareInvoiceFinalizerResult {
  duplicateEvent: boolean;
  finalized: boolean;
  notificationFailed?: boolean;
  status: string;
}

type TrainingSquareInvoiceFinalizer = (
  input: TrainingSquareInvoiceFinalizerInput,
) => Promise<TrainingSquareInvoiceFinalizerResult>;

type NoShowChargeFinalizer = (input: {
  alerts: ServicePaymentAlertLogger;
  event: VerifiedSquareWebhookEvent;
}) => Promise<NoShowChargeFinalizerResult>;

type TrainingSquareInvoiceModuleFinalizer = (input: {
  correlationId?: string;
  invoiceId: string;
  paymentId?: string;
}) => Promise<{
  duplicate: boolean;
  finalized: boolean;
  notificationFailed?: boolean;
  reason?: string;
}>;

interface SquareWebhookDependencies {
  alerts: ServicePaymentAlertLogger;
  claimSquareInvoiceWebhookEvent: (
    input: SquareInvoiceWebhookEventInput,
  ) => Promise<unknown>;
  finalizeNoShowCharge: NoShowChargeFinalizer;
  finalizeSquarePayment: typeof finalizeSquarePayment;
  finalizeTrainingSquareInvoicePayment: TrainingSquareInvoiceFinalizer;
  findCheckoutOrderByOrderId?: (
    orderId: string,
  ) => Promise<CheckoutOrderRow | null>;
  findSquareSupplementalObligationByReference?: (
    reference: string,
  ) => Promise<string | null>;
  recoverSquareCommercePayment?: (
    input: RecoverSquareCommercePaymentInput,
  ) => Promise<SquareCommerceRecoveryResult>;
  findOrderBySquareInvoiceId: (
    invoiceId: string,
  ) => Promise<CheckoutOrderRow | null>;
  getEnv: () => Promise<SquareWebhookEnv | null> | SquareWebhookEnv | null;
  isKnownNoShowChargeEvent?: (
    event: VerifiedSquareWebhookEvent,
  ) => Promise<boolean>;
  observeOperationalPayment?: (input: {
    now: Date;
    payment: SquarePayment;
  }) => Promise<{ status: "not_operational" | "observed" }>;
  recordSquareRefundEvent?: (input: {
    amountCents: number;
    currency: string;
    occurredAt: Date;
    payloadSanitized: Record<string, unknown>;
    providerEventId: string;
    squarePaymentId: string;
    squareRefundId: string;
    status: string;
  }) => Promise<{ duplicate: boolean }>;
  recordSquareInvoiceWebhookEventProcessed: (
    input: SquareInvoiceWebhookEventInput,
  ) => Promise<void>;
}

interface SquareWebhookEnv {
  notificationUrl: string;
  serviceBookingEnabled?: boolean;
  commerceEnabled?: boolean;
  webhookSignatureKey: string;
}

interface SquareWebhookRuntimeEnv {
  serviceBookingWebhookUrl: string;
  webhookSignatureKey: string;
}

interface TrainingSquareInvoiceWebhookRuntimeEnv {
  notificationUrl: string;
  webhookSignatureKey: string;
}

export const defaultDependencies: SquareWebhookDependencies = {
  alerts: createServicePaymentAlertLogger({}),
  async claimSquareInvoiceWebhookEvent(input) {
    const { claimSquareInvoiceWebhookEvent } =
      await import("@/lib/commerce/order-store");
    return claimSquareInvoiceWebhookEvent(input);
  },
  async finalizeNoShowCharge(input) {
    const [
      { createCardOnFileDrizzleRepository },
      { finalizeNoShowCharge: finalizeNoShowChargeFn },
      { createSquareInvoicesClient },
      { createSquarePaymentsClient },
      { getSquareServiceBookingRuntimeEnv },
    ] = await Promise.all([
      import("@/lib/private-db/card-on-file-repository"),
      import("@/lib/booking/payments/service-no-show-charge-finalizer"),
      import("@/lib/payments/square/invoice-client"),
      import("@/lib/payments/square/payments-client"),
      import("@/lib/booking/square-runtime"),
    ]);

    const repository = await createCardOnFileDrizzleRepository();
    const env = getSquareServiceBookingRuntimeEnv();

    if (env === null) {
      throw new Error("Square service booking is not enabled");
    }

    const squareInvoices = createSquareInvoicesClient(env);
    const squarePayments = createSquarePaymentsClient(env);

    return finalizeNoShowChargeFn(
      { event: input.event },
      {
        repository,
        alerts: input.alerts,
        providerReader: {
          getInvoice: (invoiceId) => squareInvoices.getInvoice(invoiceId),
          getPayment: (paymentId) => squarePayments.getPayment(paymentId),
        },
      },
    );
  },
  finalizeSquarePayment,
  finalizeTrainingSquareInvoicePayment,
  async findCheckoutOrderByOrderId(orderId) {
    const { findCheckoutOrderByOrderId } =
      await import("@/lib/commerce/order-store");
    return findCheckoutOrderByOrderId(orderId);
  },
  async findSquareSupplementalObligationByReference(reference) {
    const { findSquareSupplementalObligationByReference } =
      await import("@/lib/commerce/order-store");
    return findSquareSupplementalObligationByReference(reference);
  },
  async recoverSquareCommercePayment(input) {
    const [
      { recoverSquareCommercePayment },
      { finalizeSquareProductPayment },
      { sendProductOrderConfirmationEmailForOrder },
      { finalizeSquareTrainingCardPayment },
      { notifyPaidTrainingOrder },
      { finalizeSquareSupplementalObligation },
    ] = await Promise.all([
      import("@/lib/commerce/square-commerce-webhook-recovery"),
      import("@/lib/commerce/square-product-finalizer"),
      import("@/lib/commerce/product-order-email"),
      import("@/lib/commerce/square-training-card-finalizer"),
      import("@/lib/commerce/training-paid-notification"),
      import("@/lib/commerce/square-supplemental-finalizer"),
    ]);

    return recoverSquareCommercePayment(input, {
      finalizeProduct: finalizeSquareProductPayment,
      sendProductConfirmationEmail: sendProductOrderConfirmationEmailForOrder,
      finalizeTraining: finalizeSquareTrainingCardPayment,
      sendTrainingNotifications: (orderReference) =>
        notifyPaidTrainingOrder(orderReference),
      finalizeSupplemental: finalizeSquareSupplementalObligation,
      logError: (message, meta) => console.error(message, meta),
    });
  },
  async findOrderBySquareInvoiceId(invoiceId) {
    const { findOrderBySquareInvoiceId } =
      await import("@/lib/commerce/order-store");
    return findOrderBySquareInvoiceId(invoiceId);
  },
  async isKnownNoShowChargeEvent(event) {
    const [{ createCardOnFileDrizzleRepository }] = await Promise.all([
      import("@/lib/private-db/card-on-file-repository"),
    ]);
    const repository = await createCardOnFileDrizzleRepository();

    const invoiceId =
      event.eventType === "invoice.payment_made"
        ? getSquareInvoiceId(event)
        : null;
    const paymentId = event.paymentId;
    const orderId = event.orderId;

    const [recordByInvoice, recordByPayment, recordByOrder] = await Promise.all(
      [
        invoiceId !== null
          ? repository.findNoShowChargeRecordBySquareInvoiceId(invoiceId)
          : Promise.resolve(null),
        paymentId !== undefined
          ? repository.findNoShowChargeRecordBySquarePaymentId(paymentId)
          : Promise.resolve(null),
        orderId !== undefined
          ? repository.findNoShowChargeRecordBySquareOrderId(orderId)
          : Promise.resolve(null),
      ],
    );

    return (
      recordByInvoice !== null ||
      recordByPayment !== null ||
      recordByOrder !== null
    );
  },
  async observeOperationalPayment(input) {
    const { observeOperationalSquarePayment } =
      await import("@/lib/private-db/operational-square-payment-observer");
    return observeOperationalSquarePayment(input.payment, input.now);
  },
  async recordSquareRefundEvent(input) {
    const { recordSquareRefundEvent } =
      await import("@/lib/private-db/square-refund-event-repository");
    return recordSquareRefundEvent(input);
  },
  async getEnv() {
    const [
      { getSquareServiceBookingRuntimeEnv },
      {
        getTrainingAfterpaySquareInvoiceWebhookEnv,
        getSquareCommerceWebhookEnv,
      },
    ] = await Promise.all([
      import("@/lib/booking/square-runtime"),
      import("@/lib/env/private-checkout"),
    ]);

    return resolveSquareWebhookEnv({
      serviceBookingEnv: getSquareServiceBookingRuntimeEnv(),
      trainingInvoiceWebhookEnv: getTrainingAfterpaySquareInvoiceWebhookEnv(),
      commerceWebhookEnv: getSquareCommerceWebhookEnv(),
    });
  },
  async recordSquareInvoiceWebhookEventProcessed(input) {
    const { recordSquareInvoiceWebhookEventProcessed } =
      await import("@/lib/commerce/order-store");
    await recordSquareInvoiceWebhookEventProcessed(input);
  },
};

export const POST = createSquareWebhookPostHandler(defaultDependencies);

export function createSquareWebhookPostHandler(
  dependencies: SquareWebhookDependencies,
): (req: Request) => Promise<Response> {
  return async function postSquareWebhook(req) {
    const env = await dependencies.getEnv();

    if (env === null) {
      console.warn("[square-webhook] Square webhook handling is not enabled");
      return new Response(null, { status: 404 });
    }

    const headers = getSquareWebhookHeaders(req.headers);

    if (headers === null) {
      console.warn("[square-webhook] Missing signature header");
      return new Response(null, { status: 401 });
    }

    const rawBody = await req.text();
    const isValidSignature = verifySquareWebhookSignature({
      notificationUrl: env.notificationUrl,
      rawBody,
      signature: headers.signature,
      signatureKey: env.webhookSignatureKey,
    });

    if (!isValidSignature) {
      console.warn("[square-webhook] Invalid signature");
      return new Response(null, { status: 401 });
    }

    let event: ReturnType<typeof parseVerifiedSquareWebhook>;

    try {
      event = parseVerifiedSquareWebhook(rawBody);
    } catch (error) {
      console.warn("[square-webhook] Invalid payload", error);
      return new Response(null, { status: 400 });
    }

    if (event.refund !== undefined) {
      if (dependencies.recordSquareRefundEvent === undefined) {
        console.error(
          "[square-webhook] Square refund persistence is unavailable",
          {
            eventId: event.eventId,
            refundId: event.refund.refundId,
          },
        );
        return new Response(null, { status: 503 });
      }

      try {
        await dependencies.recordSquareRefundEvent({
          amountCents: event.refund.amountCents,
          currency: event.refund.currency,
          occurredAt: new Date(event.refund.occurredAt),
          payloadSanitized: event.payloadSanitized,
          providerEventId: event.eventId,
          squarePaymentId: event.refund.paymentId,
          squareRefundId: event.refund.refundId,
          status: event.refund.status,
        });
      } catch (error) {
        console.error("[square-webhook] Square refund persistence failed", {
          error:
            error instanceof Error
              ? error.message
              : "Unknown persistence error",
          eventId: event.eventId,
          refundId: event.refund.refundId,
        });
        return new Response(null, { status: 503 });
      }

      return new Response(null, { status: 200 });
    }

    if (isSquareInvoicePaidEventType(event.eventType)) {
      const invoiceId = getSquareInvoiceId(event);

      if (invoiceId !== null) {
        let order: CheckoutOrderRow | null;

        try {
          order = await dependencies.findOrderBySquareInvoiceId(invoiceId);
        } catch (error) {
          console.error("[square-webhook] Square invoice order lookup failed", {
            error:
              error instanceof Error ? error.message : "Unknown lookup error",
            eventId: event.eventId,
            invoiceId,
          });
          return new Response(null, { status: 503 });
        }

        if (order !== null && isTrainingSquareInvoiceOrder(order)) {
          const squareInvoiceEvent = toSquareInvoiceWebhookEventInput({
            event,
            invoiceId,
            order,
          });

          try {
            await dependencies.claimSquareInvoiceWebhookEvent(
              squareInvoiceEvent,
            );
          } catch (error) {
            console.error(
              "[square-webhook] Square invoice event claim failed",
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown event claim error",
                eventId: event.eventId,
                invoiceId,
                orderId: order.orderId,
              },
            );
            return new Response(null, { status: 503 });
          }

          try {
            const finalizationResult =
              await dependencies.finalizeTrainingSquareInvoicePayment({
                event,
                order,
                source: "webhook",
                squareInvoiceId: invoiceId,
              });

            if (finalizationResult.notificationFailed) {
              console.error(
                "[square-webhook] Training Square invoice notification recovery failed",
                {
                  eventId: event.eventId,
                  invoiceId,
                  orderId: order.orderId,
                  status: finalizationResult.status,
                },
              );
              return new Response(null, { status: 503 });
            }

            if (
              !finalizationResult.finalized &&
              !finalizationResult.duplicateEvent
            ) {
              console.error(
                "[square-webhook] Training Square invoice finalizer did not complete",
                {
                  eventId: event.eventId,
                  invoiceId,
                  orderId: order.orderId,
                  status: finalizationResult.status,
                },
              );
              return new Response(null, { status: 503 });
            }

            await dependencies.recordSquareInvoiceWebhookEventProcessed({
              ...squareInvoiceEvent,
              status: "processed",
            });
          } catch (error) {
            console.error(
              "[square-webhook] Training Square invoice finalization failed",
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown finalization error",
                eventId: event.eventId,
                invoiceId,
                orderId: order.orderId,
              },
            );
            return new Response(null, { status: 503 });
          }

          return new Response(null, { status: 200 });
        }

        if (env.serviceBookingEnabled !== false) {
          const noShowResponse = await tryFinalizeNoShowCharge(
            dependencies,
            event,
          );
          if (noShowResponse !== null) {
            return noShowResponse;
          }
        }

        return new Response(null, { status: 200 });
      }
    }

    if (env.commerceEnabled === true) {
      const commerceResponse = await tryRecoverSquareCommercePayment(
        dependencies,
        event,
      );
      if (commerceResponse !== null) {
        return commerceResponse;
      }
    }

    if (env.serviceBookingEnabled === false) {
      console.warn(
        "[square-webhook] Square service booking is not enabled for payment event",
        {
          eventId: event.eventId,
          eventType: event.eventType,
        },
      );
      return new Response(null, { status: 404 });
    }

    const noShowResponse = await tryFinalizeNoShowCharge(dependencies, event);
    if (noShowResponse !== null) {
      return noShowResponse;
    }

    if (!isServiceBookingReconciliationEventType(event.eventType)) {
      return new Response(null, { status: 200 });
    }

    const operationalPayment = getSquarePayment(event);
    if (
      operationalPayment !== null &&
      dependencies.observeOperationalPayment !== undefined
    ) {
      try {
        const observation = await dependencies.observeOperationalPayment({
          now: event.createdAt ? new Date(event.createdAt) : new Date(),
          payment: operationalPayment,
        });
        if (observation.status === "observed") {
          return new Response(null, { status: 200 });
        }
      } catch (error) {
        await dependencies.alerts.alert({
          category: "square_webhook_retryable_failure",
          severity: "error",
          message: "Operational Square payment observation failed",
          context: {
            error:
              error instanceof Error
                ? error.message
                : "Unknown observation error",
            eventId: event.eventId,
            eventType: event.eventType,
            paymentId: event.paymentId,
          },
        });
        return new Response(null, { status: 503 });
      }
    }

    try {
      const result = await dependencies.finalizeSquarePayment({
        event,
        source: "webhook",
      });

      if (!result.finalized && !result.duplicateEvent) {
        await dependencies.alerts.alert({
          category: "square_webhook_non_finalized",
          severity: "warning",
          message: "Square webhook did not finalize service booking",
          context: {
            eventId: event.eventId,
            eventType: event.eventType,
            orderId: result.orderId ?? event.orderId,
            reason: result.reason,
            status: result.status,
          },
        });
      }
    } catch (error) {
      await dependencies.alerts.alert({
        category: "square_webhook_retryable_failure",
        severity: "error",
        message: "Square webhook did not finalize service booking",
        context: {
          error:
            error instanceof Error
              ? error.message
              : "Unknown finalization error",
          eventId: event.eventId,
          eventType: event.eventType,
          orderId: event.orderId,
        },
      });
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  };
}

async function tryFinalizeNoShowCharge(
  dependencies: SquareWebhookDependencies,
  event: VerifiedSquareWebhookEvent,
): Promise<Response | null> {
  if (!isNoShowChargeEventType(event.eventType)) {
    return null;
  }

  const isKnownNoShowChargeEvent =
    dependencies.isKnownNoShowChargeEvent ?? (async () => true);

  try {
    if (!(await isKnownNoShowChargeEvent(event))) {
      return null;
    }
  } catch (error) {
    await dependencies.alerts.alert({
      category: "square_webhook_retryable_failure",
      severity: "error",
      message: "No-show charge event lookup failed",
      context: {
        error: error instanceof Error ? error.message : "Unknown lookup error",
        eventId: event.eventId,
        eventType: event.eventType,
        orderId: event.orderId,
      },
    });
    return new Response(null, { status: 503 });
  }

  let result: NoShowChargeFinalizerResult;

  try {
    result = await dependencies.finalizeNoShowCharge({
      event,
      alerts: dependencies.alerts,
    });
  } catch (error) {
    await dependencies.alerts.alert({
      category: "square_webhook_retryable_failure",
      severity: "error",
      message: "No-show charge finalizer failed",
      context: {
        error:
          error instanceof Error ? error.message : "Unknown finalization error",
        eventId: event.eventId,
        eventType: event.eventType,
        orderId: event.orderId,
      },
    });
    return new Response(null, { status: 503 });
  }

  if (
    result.status === "ignored" &&
    result.noShowChargeRecordId === undefined
  ) {
    return null;
  }

  return new Response(null, { status: 200 });
}

async function tryRecoverSquareCommercePayment(
  dependencies: SquareWebhookDependencies,
  event: VerifiedSquareWebhookEvent,
): Promise<Response | null> {
  if (
    !event.eventType.startsWith("payment.") ||
    dependencies.findCheckoutOrderByOrderId === undefined ||
    dependencies.recoverSquareCommercePayment === undefined
  ) {
    return null;
  }

  const payment = getSquarePayment(event);
  if (payment === null || payment.reference_id === undefined) {
    return null;
  }

  let order: CheckoutOrderRow | null;
  try {
    order = await dependencies.findCheckoutOrderByOrderId(payment.reference_id);
  } catch (error) {
    console.error("[square-webhook] commerce order lookup failed", {
      error: error instanceof Error ? error.message : "Unknown lookup error",
      eventId: event.eventId,
      reference: payment.reference_id,
    });
    return new Response(null, { status: 503 });
  }

  let kind: SquareCommerceOrderKind | null =
    order === null ? null : classifySquareCommerceCardOrder(order);
  let orderReference: string | null =
    order !== null && kind !== null ? order.orderId : null;

  // A payment whose reference is not a commerce order may be a supplemental
  // obligation top-up (the Square payment link's reference_id is the obligation
  // id). Booking / Afterpay-invoice payments match neither and fall through.
  if (
    kind === null &&
    dependencies.findSquareSupplementalObligationByReference !== undefined
  ) {
    let obligationId: string | null;
    try {
      obligationId =
        await dependencies.findSquareSupplementalObligationByReference(
          payment.reference_id,
        );
    } catch (error) {
      console.error("[square-webhook] commerce obligation lookup failed", {
        error: error instanceof Error ? error.message : "Unknown lookup error",
        eventId: event.eventId,
        reference: payment.reference_id,
      });
      return new Response(null, { status: 503 });
    }
    if (obligationId !== null) {
      kind = "supplemental_obligation";
      orderReference = obligationId;
    }
  }

  if (kind === null || orderReference === null) {
    return null;
  }

  let result: SquareCommerceRecoveryResult;
  try {
    result = await dependencies.recoverSquareCommercePayment({
      orderReference,
      kind,
      squarePaymentId: payment.id,
      status: payment.status,
      amountCents: payment.amount_money.amount,
      currency: payment.amount_money.currency,
    });
  } catch (error) {
    console.error("[square-webhook] commerce recovery failed", {
      error: error instanceof Error ? error.message : "Unknown recovery error",
      eventId: event.eventId,
      orderReference,
      kind,
    });
    return new Response(null, { status: 503 });
  }

  // Retryable side-effect failures ask Square to redeliver; everything else
  // (recovered / duplicate / ignored / terminal conflict) is acknowledged.
  return new Response(null, {
    status: result.status === "retryable" ? 503 : 200,
  });
}

function classifySquareCommerceCardOrder(
  order: CheckoutOrderRow,
): SquareCommerceOrderKind | null {
  if (order.paymentProvider !== "square") {
    return null;
  }

  if (order.purpose === "product") {
    return "product";
  }

  if (order.purpose === "training") {
    const providerMetadata = getRecord(order.providerMetadata);
    if (providerMetadata?.flow === "training_square_card") {
      return "training_card";
    }
  }

  return null;
}

export function resolveSquareWebhookEnv(input: {
  serviceBookingEnv: SquareWebhookRuntimeEnv | null;
  trainingInvoiceWebhookEnv: TrainingSquareInvoiceWebhookRuntimeEnv | null;
  commerceWebhookEnv?: {
    notificationUrl: string;
    webhookSignatureKey: string;
  } | null;
}): SquareWebhookEnv | null {
  const commerceEnabled = input.commerceWebhookEnv != null;

  if (input.serviceBookingEnv !== null) {
    return {
      notificationUrl: input.serviceBookingEnv.serviceBookingWebhookUrl,
      serviceBookingEnabled: true,
      commerceEnabled,
      webhookSignatureKey: input.serviceBookingEnv.webhookSignatureKey,
    };
  }

  if (input.trainingInvoiceWebhookEnv !== null) {
    return {
      notificationUrl: input.trainingInvoiceWebhookEnv.notificationUrl,
      serviceBookingEnabled: false,
      commerceEnabled,
      webhookSignatureKey: input.trainingInvoiceWebhookEnv.webhookSignatureKey,
    };
  }

  // Commerce-only deployment: no Square bookings and no Afterpay invoices, but
  // product/training card payments still need webhook reconciliation.
  if (input.commerceWebhookEnv != null) {
    return {
      notificationUrl: input.commerceWebhookEnv.notificationUrl,
      serviceBookingEnabled: false,
      commerceEnabled: true,
      webhookSignatureKey: input.commerceWebhookEnv.webhookSignatureKey,
    };
  }

  return null;
}

async function finalizeTrainingSquareInvoicePayment(
  input: TrainingSquareInvoiceFinalizerInput,
): Promise<TrainingSquareInvoiceFinalizerResult> {
  const finalizeTrainingSquareInvoice =
    await loadTrainingSquareInvoiceFinalizer();

  const result = await finalizeTrainingSquareInvoice({
    correlationId: getInvoiceCorrelationId(input.event),
    invoiceId: input.squareInvoiceId,
    paymentId: input.event.paymentId,
  });

  return {
    duplicateEvent: result.duplicate,
    finalized: result.finalized,
    notificationFailed: result.notificationFailed,
    status: result.reason ?? (result.finalized ? "paid" : "duplicate"),
  };
}

export async function loadTrainingSquareInvoiceFinalizer(): Promise<TrainingSquareInvoiceModuleFinalizer> {
  const finalizerModule =
    (await import("@/lib/commerce/training-square-invoice-finalizer")) as {
      finalizeTrainingSquareInvoice: TrainingSquareInvoiceModuleFinalizer;
    };

  return finalizerModule.finalizeTrainingSquareInvoice;
}

function toSquareInvoiceWebhookEventInput(input: {
  event: VerifiedSquareWebhookEvent;
  invoiceId: string;
  order: CheckoutOrderRow;
}): SquareInvoiceWebhookEventInput {
  return {
    eventId: input.event.eventId,
    eventType: input.event.eventType,
    orderDatabaseId: input.order.id,
    payloadSanitized: input.event.payloadSanitized,
    providerCheckoutId: input.invoiceId,
    providerOrderId:
      input.event.orderId ?? input.order.providerOrderId ?? undefined,
    providerPaymentId: input.event.paymentId,
    status: "received",
  };
}

function getInvoiceCorrelationId(
  event: VerifiedSquareWebhookEvent,
): string | undefined {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return (
    getText(invoice?.reference_id) ??
    getText(invoice?.order_reference_id) ??
    undefined
  );
}

function isSquareInvoicePaidEventType(
  eventType: string,
): eventType is SquareInvoicePaidEventType {
  return SQUARE_INVOICE_PAID_EVENT_TYPES.includes(
    eventType as SquareInvoicePaidEventType,
  );
}

function isServiceBookingReconciliationEventType(eventType: string): boolean {
  return SERVICE_BOOKING_RECONCILIATION_EVENT_TYPES.includes(
    eventType as (typeof SERVICE_BOOKING_RECONCILIATION_EVENT_TYPES)[number],
  );
}

function getSquareInvoiceId(event: VerifiedSquareWebhookEvent): string | null {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.id) ?? getText(data?.id);
}

function getSquarePayment(
  event: VerifiedSquareWebhookEvent,
): SquarePayment | null {
  if (!event.eventType.startsWith("payment.")) return null;
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const payment = getRecord(object?.payment) ?? object;
  const money = getRecord(payment?.amount_money);
  const id = getText(payment?.id);
  const status = getText(payment?.status);
  const currency = getText(money?.currency);
  const amount = money?.amount;
  if (
    id === null ||
    status === null ||
    currency === null ||
    typeof amount !== "number"
  ) {
    return null;
  }

  return {
    amount_money: { amount, currency },
    customer_id: getText(payment?.customer_id) ?? undefined,
    id,
    order_id: getText(payment?.order_id) ?? undefined,
    reference_id: getText(payment?.reference_id) ?? undefined,
    status,
    team_member_id: getText(payment?.team_member_id) ?? undefined,
    version_token: getText(payment?.version_token) ?? undefined,
  };
}

function isTrainingSquareInvoiceOrder(order: CheckoutOrderRow): boolean {
  const providerMetadata = getRecord(order.providerMetadata);

  return (
    order.paymentProvider === "square" &&
    order.purpose === "training" &&
    providerMetadata?.flow === "training_square_invoice"
  );
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
