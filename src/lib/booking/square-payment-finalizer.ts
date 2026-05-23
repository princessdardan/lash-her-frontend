import { createHash } from "node:crypto";

import { and, eq, or } from "drizzle-orm";

import {
  appointmentHolds,
  checkoutOrders,
  checkoutPaymentEvents,
  type CheckoutOrderPurpose,
  type CheckoutPaymentEventPayload,
  type PaymentEventProcessingStatus,
} from "@/lib/private-db/schema";

import {
  finalizeAppointmentPaymentForOrder as defaultFinalizeAppointmentPaymentForOrder,
  type FinalizeAppointmentPaymentForOrderResult,
} from "./finalizer";
import type { SquareClient, SquareOrder, SquarePayment } from "./square-client";
import type { VerifiedSquareWebhookEvent } from "./square-webhook";

export type SquareFinalizerSource = "return" | "webhook";

export interface SquarePaymentFinalizerInput {
  event?: VerifiedSquareWebhookEvent;
  orderId?: string;
  paymentId?: string;
  source: SquareFinalizerSource;
}

export interface SquarePaymentFinalizerResult {
  bookingFinalizationStatus?: FinalizeAppointmentPaymentForOrderResult["status"];
  duplicateEvent: boolean;
  finalized: boolean;
  orderId?: string;
  reason?: string;
  status: "duplicate" | "ignored" | "paid_calendar_pending" | "unpaid";
}

export interface SquarePaymentFinalizerRepository {
  claimSquareEvent(input: SquareEventRecordInput): Promise<SquareEventClaimResult>;
  findSquareOrder(input: { localOrderId?: string; providerOrderId?: string; providerPaymentId?: string }): Promise<SquareCheckoutOrderRecord | null>;
  recordSquareEvent(input: SquareEventRecordInput): Promise<{ duplicate: boolean }>;
  recordSquarePaymentPendingCalendar(input: SquarePaidRecordInput): Promise<void>;
}

export type SquareEventClaimResult =
  | { duplicate: false }
  | { duplicate: true; processingStatus: PaymentEventProcessingStatus };

interface SquareCheckoutOrderRecord {
  amountCents: number;
  id: string;
  orderId: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  purpose: CheckoutOrderPurpose;
  squareLocationId: string | null;
  status: string;
}

interface SquareEventRecordInput {
  amountCents?: number;
  currency?: string;
  eventId?: string;
  eventType: string;
  orderId?: string;
  paymentId?: string;
  payloadSanitized?: CheckoutPaymentEventPayload;
  processingStatus: "duplicate" | "failed" | "ignored" | "processed" | "received";
  providerStatus?: string;
  status?: string;
}

interface SquarePaidRecordInput {
  amountCents: number;
  order: SquareCheckoutOrderRecord;
  payment: SquarePayment;
  providerOrderId?: string;
  tipAmountCents?: number;
}

interface SquarePaymentFinalizerDependencies {
  finalizeAppointmentPaymentForOrder: typeof defaultFinalizeAppointmentPaymentForOrder;
  getEnv: () => SquareServiceBookingEnv | null;
  repository: SquarePaymentFinalizerRepository;
  squareClientFactory: (env: SquareServiceBookingEnv) => SquareClient;
}

interface SquareServiceBookingEnv {
  accessToken: string;
  environment: "sandbox" | "production";
  helcimLegacyCutoffAt: string | null;
  locationId: string;
  serviceBookingReturnUrl: string;
  serviceBookingWebhookUrl: string;
  webhookSignatureKey: string;
}

export function createSquarePaymentFinalizer(
  dependencies: SquarePaymentFinalizerDependencies,
): (input: SquarePaymentFinalizerInput) => Promise<SquarePaymentFinalizerResult> {
  return async function finalizeSquarePayment(input) {
    const env = dependencies.getEnv();

    if (env === null) {
      throw new Error("Square service booking checkout is not enabled");
    }

    const initialEventResult = await recordIncomingEvent(input, dependencies.repository);

    if (initialEventResult.duplicate && initialEventResult.processingStatus === "processed") {
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    }

    const lookup = await resolveSquarePaymentLookup(input, dependencies.squareClientFactory(env));

    if (lookup.payment === null) {
      await dependencies.repository.recordSquareEvent({
        eventId: input.event?.eventId,
        eventType: input.event?.eventType ?? `square.${input.source}`,
        orderId: lookup.order?.id ?? input.orderId ?? input.event?.orderId,
        paymentId: input.paymentId ?? input.event?.paymentId,
        payloadSanitized: input.event?.payloadSanitized,
        processingStatus: "ignored",
        providerStatus: lookup.order?.state,
        status: "payment_not_found",
      });

      return {
        duplicateEvent: false,
        finalized: false,
        reason: "Square payment could not be resolved",
        status: "ignored",
      };
    }

    const providerOrderId = lookup.payment.order_id ?? lookup.order?.id ?? input.orderId ?? input.event?.orderId;
    const localOrder = await dependencies.repository.findSquareOrder({
      localOrderId: input.orderId,
      providerOrderId,
      providerPaymentId: lookup.payment.id,
    });

    if (localOrder === null) {
      await dependencies.repository.recordSquareEvent({
        amountCents: lookup.payment.amount_money?.amount,
        currency: lookup.payment.amount_money?.currency,
        eventId: input.event?.eventId,
        eventType: input.event?.eventType ?? `square.${input.source}`,
        orderId: providerOrderId,
        paymentId: lookup.payment.id,
        payloadSanitized: input.event?.payloadSanitized,
        processingStatus: "ignored",
        providerStatus: lookup.payment.status,
        status: "order_not_found",
      });

      return { duplicateEvent: false, finalized: false, reason: "Local Square order not found", status: "ignored" };
    }

    if (!isPaidSquarePayment(lookup.payment)) {
      await dependencies.repository.recordSquareEvent({
        amountCents: lookup.payment.amount_money?.amount,
        currency: lookup.payment.amount_money?.currency,
        eventId: input.event?.eventId,
        eventType: input.event?.eventType ?? `square.${input.source}`,
        orderId: providerOrderId,
        paymentId: lookup.payment.id,
        payloadSanitized: input.event?.payloadSanitized,
        processingStatus: "ignored",
        providerStatus: lookup.payment.status,
        status: "unpaid",
      });

      return { duplicateEvent: false, finalized: false, orderId: localOrder.orderId, status: "unpaid" };
    }

    const amountCents = lookup.payment.amount_money?.amount ?? lookup.payment.total_money?.amount;
    const currency = lookup.payment.amount_money?.currency ?? lookup.payment.total_money?.currency;

    if (amountCents !== localOrder.amountCents || currency !== "CAD") {
      await dependencies.repository.recordSquareEvent({
        amountCents,
        currency,
        eventId: input.event?.eventId,
        eventType: input.event?.eventType ?? `square.${input.source}`,
        orderId: providerOrderId,
        paymentId: lookup.payment.id,
        payloadSanitized: input.event?.payloadSanitized,
        processingStatus: "failed",
        providerStatus: lookup.payment.status,
        status: "amount_or_currency_mismatch",
      });

      return {
        duplicateEvent: false,
        finalized: false,
        orderId: localOrder.orderId,
        reason: "Square payment amount or currency did not match local order",
        status: "ignored",
      };
    }

    await dependencies.repository.recordSquarePaymentPendingCalendar({
      amountCents,
      order: localOrder,
      payment: lookup.payment,
      providerOrderId,
      tipAmountCents: lookup.payment.tip_money?.amount,
    });
    const bookingFinalization = await dependencies.finalizeAppointmentPaymentForOrder({
      order: {
        _id: localOrder.id,
        amount: localOrder.amountCents / 100,
        currency,
        orderId: localOrder.orderId,
        purpose: localOrder.purpose,
      },
      source: input.source,
      transactionId: lookup.payment.id,
    });

    await dependencies.repository.recordSquareEvent({
      amountCents,
      currency,
      eventId: input.event?.eventId,
      eventType: input.event?.eventType ?? `square.${input.source}`,
      orderId: providerOrderId,
      paymentId: lookup.payment.id,
      payloadSanitized: input.event?.payloadSanitized,
      processingStatus: "processed",
      providerStatus: lookup.payment.status,
      status: "paid_calendar_pending",
    });

    return {
      bookingFinalizationStatus: bookingFinalization.status,
      duplicateEvent: false,
      finalized: true,
      orderId: localOrder.orderId,
      status: "paid_calendar_pending",
    };
  };
}

export async function finalizeSquarePayment(
  input: SquarePaymentFinalizerInput,
): Promise<SquarePaymentFinalizerResult> {
  const [{ getSquareServiceBookingEnv }, { createSquareClient }] = await Promise.all([
    import("@/lib/env/private-checkout"),
    import("./square-client"),
  ]);

  return createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: defaultFinalizeAppointmentPaymentForOrder,
    getEnv: getSquareServiceBookingEnv,
    repository: createDrizzleSquarePaymentFinalizerRepository(),
    squareClientFactory: createSquareClient,
  })(input);
}

function createDrizzleSquarePaymentFinalizerRepository(): SquarePaymentFinalizerRepository {
  return {
    async claimSquareEvent(input) {
      if (input.eventId === undefined) {
        return { duplicate: false };
      }

      const db = await getSquarePaymentFinalizerDb();
      const [createdEvent] = await db
        .insert(checkoutPaymentEvents)
        .values(toSquareEventInsert(input))
        .onConflictDoNothing({ target: [checkoutPaymentEvents.paymentProvider, checkoutPaymentEvents.providerEventId] })
        .returning({ id: checkoutPaymentEvents.id });

      if (createdEvent !== undefined) {
        return { duplicate: false };
      }

      const [existingEvent] = await db
        .select({ processingStatus: checkoutPaymentEvents.processingStatus })
        .from(checkoutPaymentEvents)
        .where(
          and(
            eq(checkoutPaymentEvents.paymentProvider, "square"),
            eq(checkoutPaymentEvents.providerEventId, input.eventId),
          ),
        )
        .limit(1);

      return {
        duplicate: true,
        processingStatus: existingEvent?.processingStatus ?? "received",
      };
    },

    async findSquareOrder(input) {
      const conditions = [eq(checkoutOrders.paymentProvider, "square")];

      const identifiers = [
        input.localOrderId ? eq(checkoutOrders.orderId, input.localOrderId) : undefined,
        input.providerOrderId ? eq(checkoutOrders.providerOrderId, input.providerOrderId) : undefined,
        input.providerPaymentId ? eq(checkoutOrders.providerPaymentId, input.providerPaymentId) : undefined,
      ].filter((condition) => condition !== undefined);

      if (identifiers.length === 0) {
        return null;
      }

      const [row] = await (await getSquarePaymentFinalizerDb())
        .select()
        .from(checkoutOrders)
        .where(and(...conditions, or(...identifiers)))
        .limit(1);

      return row
        ? {
          amountCents: row.amountCents,
          id: row.id,
          orderId: row.orderId,
          providerOrderId: row.providerOrderId,
          providerPaymentId: row.providerPaymentId,
          purpose: row.purpose,
          squareLocationId: row.squareLocationId,
          status: row.status,
        }
        : null;
    },

    async recordSquareEvent(input) {
      if (input.eventId === undefined) {
        return { duplicate: false };
      }

      const [createdEvent] = await (await getSquarePaymentFinalizerDb())
        .insert(checkoutPaymentEvents)
        .values(toSquareEventInsert(input))
        .onConflictDoUpdate({
          target: [checkoutPaymentEvents.paymentProvider, checkoutPaymentEvents.providerEventId],
          set: toSquareEventUpdate(input),
        })
        .returning({ id: checkoutPaymentEvents.id });

      return { duplicate: createdEvent === undefined };
    },

    async recordSquarePaymentPendingCalendar(input) {
      const now = new Date();
      await (await getSquarePaymentFinalizerDb()).transaction(async (tx) => {
        await tx
          .update(checkoutOrders)
          .set({
            calendarFinalizationStatus: "paid_calendar_pending",
            paidAt: now,
            providerOrderId: input.providerOrderId ?? input.order.providerOrderId,
            providerPaymentId: input.payment.id,
            providerStatus: input.payment.status,
            squareTipAmountCents: input.tipAmountCents,
            status: "paid",
            updatedAt: now,
          })
          .where(eq(checkoutOrders.id, input.order.id));

        await tx
          .update(appointmentHolds)
          .set({
            finalizationStatus: "paid_calendar_pending",
            paidAt: now,
            reconciliationMetadata: {
              squarePayment: {
                amountCents: input.amountCents,
                orderId: input.providerOrderId ?? input.order.providerOrderId,
                paymentId: input.payment.id,
                status: input.payment.status,
              },
            },
            squareOrderId: input.providerOrderId ?? input.order.providerOrderId,
            squarePaymentId: input.payment.id,
            status: "paid_pending_booking",
            updatedAt: now,
          })
          .where(eq(appointmentHolds.checkoutOrderId, input.order.id));
      });
    },
  };
}

async function getSquarePaymentFinalizerDb() {
  const { getPrivateDb } = await import("@/lib/private-db/client");
  return getPrivateDb();
}

async function recordIncomingEvent(
  input: SquarePaymentFinalizerInput,
  repository: SquarePaymentFinalizerRepository,
): Promise<SquareEventClaimResult> {
  if (input.event === undefined) {
    return { duplicate: false };
  }

  return repository.claimSquareEvent({
    eventId: input.event.eventId,
    eventType: input.event.eventType,
    orderId: input.event.orderId,
    paymentId: input.event.paymentId,
    payloadSanitized: input.event.payloadSanitized,
    processingStatus: "received",
    status: "received",
  });
}

async function resolveSquarePaymentLookup(
  input: SquarePaymentFinalizerInput,
  squareClient: SquareClient,
): Promise<{ order: SquareOrder | null; payment: SquarePayment | null }> {
  const paymentId = input.paymentId ?? input.event?.paymentId;

  if (paymentId !== undefined) {
    return { order: null, payment: (await squareClient.getPayment(paymentId)).payment };
  }

  const orderId = input.orderId ?? input.event?.orderId;

  if (orderId === undefined) {
    return { order: null, payment: null };
  }

  return { order: (await squareClient.getOrder(orderId)).order, payment: null };
}

function isPaidSquarePayment(payment: SquarePayment): boolean {
  return payment.status !== undefined && ["approved", "completed", "paid"].includes(payment.status.trim().toLowerCase());
}

function hashPayload(payload: CheckoutPaymentEventPayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function toSquareEventInsert(input: SquareEventRecordInput): typeof checkoutPaymentEvents.$inferInsert {
  return {
    amountCents: input.amountCents,
    currency: input.currency,
    eventType: input.eventType,
    paymentProvider: "square",
    payloadHash: input.payloadSanitized ? hashPayload(input.payloadSanitized) : undefined,
    payloadSanitized: input.payloadSanitized,
    processedAt: input.processingStatus === "processed" ? new Date() : undefined,
    processingStatus: input.processingStatus,
    providerEventId: input.eventId,
    providerOrderId: input.orderId,
    providerPaymentId: input.paymentId,
    providerStatus: input.providerStatus,
    status: input.status,
  };
}

function toSquareEventUpdate(input: SquareEventRecordInput): Partial<typeof checkoutPaymentEvents.$inferInsert> {
  return {
    amountCents: input.amountCents,
    currency: input.currency,
    eventType: input.eventType,
    payloadHash: input.payloadSanitized ? hashPayload(input.payloadSanitized) : undefined,
    payloadSanitized: input.payloadSanitized,
    processedAt: input.processingStatus === "processed" ? new Date() : undefined,
    processingStatus: input.processingStatus,
    providerOrderId: input.orderId,
    providerPaymentId: input.paymentId,
    providerStatus: input.providerStatus,
    status: input.status,
  };
}
