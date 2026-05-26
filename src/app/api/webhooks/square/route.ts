import { finalizeSquarePayment } from "@/lib/booking/square-payment-finalizer";
import {
  getSquareWebhookHeaders,
  parseVerifiedSquareWebhook,
  verifySquareWebhookSignature,
} from "@/lib/booking/square-webhook";
import type {
  CheckoutOrderRow,
  SquareInvoiceWebhookEventClaimResult,
  SquareInvoiceWebhookEventInput,
} from "@/lib/commerce/order-store";

export const runtime = "nodejs";

const SQUARE_INVOICE_PAID_EVENT_TYPES = ["invoice.payment_made"] as const;
const TRAINING_SQUARE_INVOICE_FINALIZER_MODULE = "@/lib/commerce/training-square-invoice-finalizer";

type SquareInvoicePaidEventType = typeof SQUARE_INVOICE_PAID_EVENT_TYPES[number];
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
  status: string;
}

type TrainingSquareInvoiceFinalizer = (
  input: TrainingSquareInvoiceFinalizerInput,
) => Promise<TrainingSquareInvoiceFinalizerResult>;

type TrainingSquareInvoiceModuleFinalizer = (input: {
  correlationId?: string;
  invoiceId: string;
  paymentId?: string;
}) => Promise<{ duplicate: boolean; finalized: boolean; reason?: string }>;

interface SquareWebhookDependencies {
  claimSquareInvoiceWebhookEvent: (
    input: SquareInvoiceWebhookEventInput,
  ) => Promise<SquareInvoiceWebhookEventClaimResult>;
  finalizeSquarePayment: typeof finalizeSquarePayment;
  finalizeTrainingSquareInvoicePayment: TrainingSquareInvoiceFinalizer;
  findOrderBySquareInvoiceId: (invoiceId: string) => Promise<CheckoutOrderRow | null>;
  getEnv: () => Promise<SquareWebhookEnv | null> | SquareWebhookEnv | null;
  recordSquareInvoiceWebhookEventProcessed: (input: SquareInvoiceWebhookEventInput) => Promise<void>;
}

interface SquareWebhookEnv {
  serviceBookingWebhookUrl: string;
  webhookSignatureKey: string;
}

export const defaultDependencies: SquareWebhookDependencies = {
  async claimSquareInvoiceWebhookEvent(input) {
    const { claimSquareInvoiceWebhookEvent } = await import("@/lib/commerce/order-store");
    return claimSquareInvoiceWebhookEvent(input);
  },
  finalizeSquarePayment,
  finalizeTrainingSquareInvoicePayment,
  async findOrderBySquareInvoiceId(invoiceId) {
    const { findOrderBySquareInvoiceId } = await import("@/lib/commerce/order-store");
    return findOrderBySquareInvoiceId(invoiceId);
  },
  async getEnv() {
    const { getSquareServiceBookingRuntimeEnv } = await import("@/lib/booking/square-runtime");
    return getSquareServiceBookingRuntimeEnv();
  },
  async recordSquareInvoiceWebhookEventProcessed(input) {
    const { recordSquareInvoiceWebhookEventProcessed } = await import("@/lib/commerce/order-store");
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
      console.warn("[square-webhook] Square service booking is not enabled");
      return new Response(null, { status: 404 });
    }

    const headers = getSquareWebhookHeaders(req.headers);

    if (headers === null) {
      console.warn("[square-webhook] Missing signature header");
      return new Response(null, { status: 401 });
    }

    const rawBody = await req.text();
    const isValidSignature = verifySquareWebhookSignature({
      notificationUrl: env.serviceBookingWebhookUrl,
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
            error: error instanceof Error ? error.message : "Unknown lookup error",
            eventId: event.eventId,
            invoiceId,
          });
          return new Response(null, { status: 503 });
        }

        if (order !== null && isTrainingSquareInvoiceOrder(order)) {
          const squareInvoiceEvent = toSquareInvoiceWebhookEventInput({ event, invoiceId, order });
          let eventClaim: SquareInvoiceWebhookEventClaimResult;

          try {
            eventClaim = await dependencies.claimSquareInvoiceWebhookEvent(squareInvoiceEvent);
          } catch (error) {
            console.error("[square-webhook] Square invoice event claim failed", {
              error: error instanceof Error ? error.message : "Unknown event claim error",
              eventId: event.eventId,
              invoiceId,
              orderId: order.orderId,
            });
            return new Response(null, { status: 503 });
          }

          if (eventClaim.duplicate && eventClaim.processingStatus === "processed") {
            return new Response(null, { status: 200 });
          }

          try {
            await dependencies.finalizeTrainingSquareInvoicePayment({
              event,
              order,
              source: "webhook",
              squareInvoiceId: invoiceId,
            });
            await dependencies.recordSquareInvoiceWebhookEventProcessed({
              ...squareInvoiceEvent,
              status: "processed",
            });
          } catch (error) {
            console.error("[square-webhook] Training Square invoice finalization failed", {
              error: error instanceof Error ? error.message : "Unknown finalization error",
              eventId: event.eventId,
              invoiceId,
              orderId: order.orderId,
            });
            return new Response(null, { status: 503 });
          }

          return new Response(null, { status: 200 });
        }
      }
    }

    try {
      await dependencies.finalizeSquarePayment({
        event,
        source: "webhook",
      });
    } catch (error) {
      console.error("[square-webhook] Square payment finalization failed", {
        error: error instanceof Error ? error.message : "Unknown finalization error",
        eventId: event.eventId,
      });
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  };
}

async function finalizeTrainingSquareInvoicePayment(
  input: TrainingSquareInvoiceFinalizerInput,
): Promise<TrainingSquareInvoiceFinalizerResult> {
  const finalizeTrainingSquareInvoice = await loadTrainingSquareInvoiceFinalizer();

  const result = await finalizeTrainingSquareInvoice({
    correlationId: getInvoiceCorrelationId(input.event),
    invoiceId: input.squareInvoiceId,
    paymentId: input.event.paymentId,
  });

  return {
    duplicateEvent: result.duplicate,
    finalized: result.finalized,
    status: result.reason ?? (result.finalized ? "paid" : "duplicate"),
  };
}

export async function loadTrainingSquareInvoiceFinalizer(): Promise<TrainingSquareInvoiceModuleFinalizer> {
  const finalizerModule = await import(TRAINING_SQUARE_INVOICE_FINALIZER_MODULE) as {
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
    providerOrderId: input.event.orderId ?? input.order.providerOrderId ?? undefined,
    providerPaymentId: input.event.paymentId,
    status: "received",
  };
}

function getInvoiceCorrelationId(event: VerifiedSquareWebhookEvent): string | undefined {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.reference_id) ?? getText(invoice?.order_reference_id) ?? undefined;
}

function isSquareInvoicePaidEventType(eventType: string): eventType is SquareInvoicePaidEventType {
  return SQUARE_INVOICE_PAID_EVENT_TYPES.includes(eventType as SquareInvoicePaidEventType);
}

function getSquareInvoiceId(event: VerifiedSquareWebhookEvent): string | null {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.id) ?? getText(data?.id);
}

function isTrainingSquareInvoiceOrder(order: CheckoutOrderRow): boolean {
  const providerMetadata = getRecord(order.providerMetadata);

  return order.paymentProvider === "square"
    && order.purpose === "training"
    && providerMetadata?.flow === "training_square_invoice";
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
