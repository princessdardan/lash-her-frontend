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

export const runtime = "nodejs";

const SQUARE_INVOICE_PAID_EVENT_TYPES = ["invoice.payment_made"] as const;
const TRAINING_SQUARE_INVOICE_FINALIZER_MODULE =
  "@/lib/commerce/training-square-invoice-finalizer";

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
  findOrderBySquareInvoiceId: (
    invoiceId: string,
  ) => Promise<CheckoutOrderRow | null>;
  getEnv: () => Promise<SquareWebhookEnv | null> | SquareWebhookEnv | null;
  isKnownNoShowChargeEvent?: (
    event: VerifiedSquareWebhookEvent,
  ) => Promise<boolean>;
  recordSquareInvoiceWebhookEventProcessed: (
    input: SquareInvoiceWebhookEventInput,
  ) => Promise<void>;
}

interface SquareWebhookEnv {
  notificationUrl: string;
  serviceBookingEnabled?: boolean;
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
  async getEnv() {
    const [
      { getSquareServiceBookingRuntimeEnv },
      { getTrainingAfterpaySquareInvoiceWebhookEnv },
    ] = await Promise.all([
      import("@/lib/booking/square-runtime"),
      import("@/lib/env/private-checkout"),
    ]);

    return resolveSquareWebhookEnv({
      serviceBookingEnv: getSquareServiceBookingRuntimeEnv(),
      trainingInvoiceWebhookEnv: getTrainingAfterpaySquareInvoiceWebhookEnv(),
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

export function resolveSquareWebhookEnv(input: {
  serviceBookingEnv: SquareWebhookRuntimeEnv | null;
  trainingInvoiceWebhookEnv: TrainingSquareInvoiceWebhookRuntimeEnv | null;
}): SquareWebhookEnv | null {
  if (input.serviceBookingEnv !== null) {
    return {
      notificationUrl: input.serviceBookingEnv.serviceBookingWebhookUrl,
      serviceBookingEnabled: true,
      webhookSignatureKey: input.serviceBookingEnv.webhookSignatureKey,
    };
  }

  if (input.trainingInvoiceWebhookEnv !== null) {
    return {
      notificationUrl: input.trainingInvoiceWebhookEnv.notificationUrl,
      serviceBookingEnabled: false,
      webhookSignatureKey: input.trainingInvoiceWebhookEnv.webhookSignatureKey,
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
  const finalizerModule = (await import(
    TRAINING_SQUARE_INVOICE_FINALIZER_MODULE
  )) as {
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

function getSquareInvoiceId(event: VerifiedSquareWebhookEvent): string | null {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.id) ?? getText(data?.id);
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
