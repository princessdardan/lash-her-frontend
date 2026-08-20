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
  isAppointmentCheckoutPurpose,
  isBookingFinalizationStatusAlertable,
  type FinalizeAppointmentPaymentForOrderResult,
} from "./finalizer";
import { classifySquareReturnOrderId } from "./payments/service-square-id-resolution";
import type { SquareClient, SquareOrder, SquarePayment } from "./square-client";
import type { VerifiedSquareWebhookEvent } from "./square-webhook";
import type { SendBookingSchedulingFailureAdminEmailInput } from "./email";
import { resolveBookingModelVersion } from "./booking-model-version";

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
  status:
    | "booked"
    | "duplicate"
    | "ignored"
    | "paid_calendar_pending"
    | "pending_verification"
    | "unpaid";
}

export interface SquarePaymentFinalizerRepository {
  claimSquareEvent(
    input: SquareEventRecordInput,
  ): Promise<SquareEventClaimResult>;
  findSquareOrder(input: {
    localOrderId?: string;
    providerOrderId?: string;
    providerPaymentId?: string;
  }): Promise<SquareCheckoutOrderRecord | null>;
  recordSquareEvent(
    input: SquareEventRecordInput,
  ): Promise<{ duplicate: boolean }>;
  recordSquarePaymentFailed?(input: SquareFailedRecordInput): Promise<void>;
  recordSquarePaymentPendingCalendar(
    input: SquarePaidRecordInput,
  ): Promise<void>;
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

export interface SquareEventRecordInput {
  amountCents?: number;
  currency?: string;
  eventId?: string;
  eventType: string;
  idempotencyKey?: string;
  orderId?: string;
  paymentId?: string;
  payloadSanitized?: CheckoutPaymentEventPayload;
  processingStatus:
    | "duplicate"
    | "failed"
    | "ignored"
    | "processed"
    | "received";
  providerStatus?: string;
  status?: string;
}

interface SquarePaidRecordInput {
  amountCents: number;
  order: SquareCheckoutOrderRecord;
  paidAt: Date;
  payment: SquarePayment;
  providerOrderId?: string;
  tipAmountCents?: number;
}

interface SquareFailedRecordInput {
  order: SquareCheckoutOrderRecord;
  payment: SquarePayment;
  providerOrderId?: string;
}

interface SquarePaymentFinalizerDependencies {
  finalizeAppointmentPaymentForOrder: typeof defaultFinalizeAppointmentPaymentForOrder;
  getAppointmentHoldByCheckoutOrderPublicId?: typeof import("./holds").getAppointmentHoldByCheckoutOrderPublicId;
  getEnv: () => SquareServiceBookingEnv | null;
  repository: SquarePaymentFinalizerRepository;
  sendBookingConfirmationEmailForOrder: (orderId: string) => Promise<void>;
  sendBookingSchedulingFailureAdminEmail?: (
    input: SendBookingSchedulingFailureAdminEmailInput,
  ) => Promise<void>;
  squareClientFactory: (env: SquareServiceBookingEnv) => SquareClient;
}

interface SquareServiceBookingEnv {
  accessToken: string;
  environment: "sandbox" | "production";
  locationId: string;
  serviceBookingReturnUrl: string;
  serviceBookingWebhookUrl: string;
  webhookSignatureKey: string;
}

export function createSquarePaymentFinalizer(
  dependencies: SquarePaymentFinalizerDependencies,
): (
  input: SquarePaymentFinalizerInput,
) => Promise<SquarePaymentFinalizerResult> {
  return async function finalizeSquarePayment(input) {
    const env = dependencies.getEnv();

    if (env === null) {
      throw new Error("Square service booking checkout is not enabled");
    }

    const initialEventResult = await recordIncomingEvent(
      input,
      dependencies.repository,
    );

    if (
      initialEventResult.duplicate &&
      initialEventResult.processingStatus === "processed"
    ) {
      await recoverProcessedDuplicateBookingConfirmation(input, dependencies);
      return { duplicateEvent: true, finalized: false, status: "duplicate" };
    }

    const lookup = await resolveSquarePaymentLookup(
      input,
      dependencies.repository,
      dependencies.squareClientFactory(env),
    );

    if (lookup.pendingVerification) {
      const eventRecordInput: SquareEventRecordInput = {
        eventId: input.event?.eventId,
        eventType: input.event?.eventType ?? `square.${input.source}`,
        idempotencyKey: buildReturnEventIdempotencyKey({
          orderId: input.orderId ?? input.event?.orderId,
          paymentId: input.paymentId ?? input.event?.paymentId,
          status: "pending_verification",
        }),
        orderId: input.orderId ?? input.event?.orderId,
        paymentId: input.paymentId ?? input.event?.paymentId,
        payloadSanitized: input.event?.payloadSanitized,
        processingStatus: "ignored",
        status: "pending_verification",
      };

      await dependencies.repository.recordSquareEvent(eventRecordInput);

      console.warn(
        "[square-finalizer] Square return could not be fully resolved",
        {
          hasLocalOrderId: input.orderId?.startsWith("lh-sq-") === true,
          hasPaymentId: input.paymentId !== undefined,
          source: input.source,
          status: "pending_verification",
        },
      );

      return {
        duplicateEvent: false,
        finalized: false,
        status: "pending_verification",
      };
    }

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

    const providerOrderId =
      lookup.payment.order_id ?? lookup.order?.id ?? input.event?.orderId;
    const localOrder = await dependencies.repository.findSquareOrder({
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

      return {
        duplicateEvent: false,
        finalized: false,
        reason: "Local Square order not found",
        status: "ignored",
      };
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

      if (isTerminalUnpaidSquarePayment(lookup.payment)) {
        await dependencies.repository.recordSquarePaymentFailed?.({
          order: localOrder,
          payment: lookup.payment,
          providerOrderId: providerOrderId ?? undefined,
        });
      }

      return {
        duplicateEvent: false,
        finalized: false,
        orderId: localOrder.orderId,
        status: "unpaid",
      };
    }

    const amountCents = lookup.payment.amount_money?.amount;
    const currency = lookup.payment.amount_money?.currency;

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
      paidAt:
        getSquarePaymentProviderDate(lookup.payment) ??
        getSquareProviderEventDate(input.event) ??
        new Date(),
      payment: lookup.payment,
      providerOrderId,
      tipAmountCents: lookup.payment.tip_money?.amount,
    });
    let bookingFinalization:
      | FinalizeAppointmentPaymentForOrderResult
      | undefined;
    if (isAppointmentCheckoutPurpose(localOrder.purpose)) {
      bookingFinalization =
        await dependencies.finalizeAppointmentPaymentForOrder({
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

      if (
        bookingFinalization.ok ||
        bookingFinalization.status === "manual_followup" ||
        bookingFinalization.status === "paid_unbookable_rebooking_pending"
      ) {
        await dependencies.sendBookingConfirmationEmailForOrder(
          localOrder.orderId,
        );
      }

      if (
        !bookingFinalization.ok &&
        isBookingFinalizationStatusAlertable(bookingFinalization.status) &&
        dependencies.sendBookingSchedulingFailureAdminEmail !== undefined
      ) {
        try {
          await dependencies.sendBookingSchedulingFailureAdminEmail({
            amountCents,
            currency,
            currentBookingStatus: bookingFinalization.status,
            failureReason: bookingFinalization.error,
            orderId: localOrder.orderId,
            paymentProvider: "square",
            paymentReference: lookup.payment.id,
            paymentStatus: lookup.payment.status ?? "unknown",
          });
        } catch (emailError) {
          console.error(
            "[square-finalizer] Failed to send admin scheduling failure alert",
            {
              error: getErrorMessage(emailError),
              orderId: localOrder.orderId,
              paymentId: lookup.payment.id,
            },
          );
        }
      }
    }

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
    const returnStatus =
      bookingFinalization?.status === "booked"
        ? "booked"
        : "paid_calendar_pending";

    return {
      bookingFinalizationStatus: bookingFinalization?.status,
      duplicateEvent: false,
      finalized: true,
      orderId: localOrder.orderId,
      status: returnStatus,
    };
  };
}

async function recoverProcessedDuplicateBookingConfirmation(
  input: SquarePaymentFinalizerInput,
  dependencies: SquarePaymentFinalizerDependencies,
): Promise<void> {
  const localOrder = await dependencies.repository.findSquareOrder({
    localOrderId: input.orderId,
    providerOrderId: input.event?.orderId,
    providerPaymentId: input.event?.paymentId ?? input.paymentId,
  });

  if (
    localOrder === null ||
    localOrder.status !== "paid" ||
    !isAppointmentCheckoutPurpose(localOrder.purpose)
  ) {
    return;
  }

  if (dependencies.getAppointmentHoldByCheckoutOrderPublicId !== undefined) {
    const hold = await dependencies.getAppointmentHoldByCheckoutOrderPublicId(
      localOrder.orderId,
    );

    if (hold === null) {
      return;
    }

    if (resolveBookingModelVersion(hold) === 2) {
      if (
        hold.state !== "booked" &&
        hold.state !== "manual_followup" &&
        hold.state !== "paid_unbookable_rebooking_pending" &&
        hold.state !== "manual_rebooked"
      ) {
        return;
      }
    } else if (
      (hold.state !== "booked" && hold.state !== "manual_rebooked") ||
      hold.googleEventId === null
    ) {
      return;
    }
  }

  await dependencies.sendBookingConfirmationEmailForOrder(localOrder.orderId);
}

export async function finalizeSquarePayment(
  input: SquarePaymentFinalizerInput,
): Promise<SquarePaymentFinalizerResult> {
  const [squareRuntime, email, holds] = await Promise.all([
    import("./square-runtime"),
    import("./email"),
    import("./holds"),
  ]);

  return createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder:
      defaultFinalizeAppointmentPaymentForOrder,
    getAppointmentHoldByCheckoutOrderPublicId:
      holds.getAppointmentHoldByCheckoutOrderPublicId,
    getEnv: squareRuntime.getSquareServiceBookingRuntimeEnv,
    repository: createDrizzleSquarePaymentFinalizerRepository(),
    sendBookingConfirmationEmailForOrder:
      email.sendBookingConfirmationEmailForOrder,
    sendBookingSchedulingFailureAdminEmail:
      email.sendBookingSchedulingFailureAdminEmail,
    squareClientFactory: (env) =>
      squareRuntime.createSquareServiceBookingClient({ env }),
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
        .onConflictDoNothing({
          target: [
            checkoutPaymentEvents.paymentProvider,
            checkoutPaymentEvents.providerEventId,
          ],
        })
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
      const identifier = input.providerOrderId
        ? eq(checkoutOrders.providerOrderId, input.providerOrderId)
        : input.providerPaymentId
          ? eq(checkoutOrders.providerPaymentId, input.providerPaymentId)
          : input.localOrderId
            ? eq(checkoutOrders.orderId, input.localOrderId)
            : undefined;

      if (identifier === undefined) {
        return null;
      }

      const [row] = await (
        await getSquarePaymentFinalizerDb()
      )
        .select()
        .from(checkoutOrders)
        .where(and(eq(checkoutOrders.paymentProvider, "square"), identifier))
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
      if (input.eventId === undefined && input.idempotencyKey === undefined) {
        return { duplicate: false };
      }

      const insertValues = toSquareEventInsert(input);

      if (input.eventId !== undefined) {
        const [createdEvent] = await (
          await getSquarePaymentFinalizerDb()
        )
          .insert(checkoutPaymentEvents)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [
              checkoutPaymentEvents.paymentProvider,
              checkoutPaymentEvents.providerEventId,
            ],
            set: toSquareEventUpdate(input),
          })
          .returning({ id: checkoutPaymentEvents.id });

        return { duplicate: createdEvent === undefined };
      }

      const [createdEvent] = await (
        await getSquarePaymentFinalizerDb()
      )
        .insert(checkoutPaymentEvents)
        .values(insertValues)
        .onConflictDoNothing({ target: [checkoutPaymentEvents.idempotencyKey] })
        .returning({ id: checkoutPaymentEvents.id });

      return { duplicate: createdEvent === undefined };
    },

    async recordSquarePaymentFailed(input) {
      const now = new Date();
      const providerOrderId =
        input.providerOrderId ?? input.order.providerOrderId;
      const providerStatus = input.payment.status ?? "unpaid";
      const db = await getSquarePaymentFinalizerDb();

      await db.transaction(async (tx) => {
        await tx
          .update(checkoutOrders)
          .set({
            failedAt: now,
            providerOrderId,
            providerPaymentId: input.payment.id,
            providerStatus,
            status: getFailedCheckoutOrderStatus(input.payment),
            updatedAt: now,
          })
          .where(
            and(
              eq(checkoutOrders.id, input.order.id),
              eq(checkoutOrders.status, "pending"),
            ),
          );

        await tx
          .update(appointmentHolds)
          .set({
            failureMetadata: {
              squarePayment: {
                orderId: providerOrderId,
                paymentId: input.payment.id,
                status: providerStatus,
              },
            },
            failureReason: `Square payment ended with status ${providerStatus}`,
            finalizationReason: `Square payment ended with status ${providerStatus}`,
            finalizationStatus: "failed",
            paymentFailedAt: now,
            squareOrderId: providerOrderId,
            squarePaymentId: input.payment.id,
            status: "payment_failed",
            updatedAt: now,
          })
          .where(
            and(
              eq(appointmentHolds.checkoutOrderId, input.order.id),
              or(
                eq(appointmentHolds.status, "held"),
                eq(appointmentHolds.status, "payment_pending"),
              ),
            ),
          );
      });

      const amountCents = input.payment.amount_money?.amount;
      const [hold] = await db
        .select({ id: appointmentHolds.id })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.checkoutOrderId, input.order.id))
        .limit(1);
      if (
        hold !== undefined &&
        typeof amountCents === "number" &&
        Number.isInteger(amountCents) &&
        amountCents >= 0
      ) {
        const { createAppointmentFinalizationRepository } =
          await import("@/lib/private-db/appointment-finalization-repository");
        await createAppointmentFinalizationRepository(db).recordPaymentAttempt({
          amountCents,
          currency: input.payment.amount_money?.currency ?? "CAD",
          failedAt: now,
          failureCode: providerStatus,
          holdId: hold.id,
          idempotencyKey: buildHostedPaymentAttemptIdempotencyKey(
            input.payment.id,
          ),
          now,
          operation: "square_hosted_checkout",
          paymentProvider: "square",
          providerOrderId: providerOrderId ?? undefined,
          providerPaymentId: input.payment.id,
          status: isCancelledSquarePayment(input.payment)
            ? "cancelled"
            : "failed",
        });
      }
    },

    async recordSquarePaymentPendingCalendar(input) {
      const now = new Date();
      const db = await getSquarePaymentFinalizerDb();
      await db.transaction(async (tx) => {
        await tx
          .update(checkoutOrders)
          .set({
            calendarFinalizationStatus: "paid_calendar_pending",
            paidAt: input.paidAt,
            providerOrderId:
              input.providerOrderId ?? input.order.providerOrderId,
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
            paidAt: input.paidAt,
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

      const [hold] = await db
        .select({ id: appointmentHolds.id })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.checkoutOrderId, input.order.id))
        .limit(1);
      if (hold === undefined) {
        throw new Error("Booking hold was not found after Square payment");
      }

      const { createAppointmentFinalizationRepository } =
        await import("@/lib/private-db/appointment-finalization-repository");
      await createAppointmentFinalizationRepository(
        db,
      ).confirmOperationalAppointment({
        calendar: { status: "pending" },
        holdId: hold.id,
        holdOutcome: "paid_pending_booking",
        now,
        payment: {
          amountCents: input.amountCents,
          capturedAt: input.paidAt,
          checkoutOrderId: input.order.id,
          currency: input.payment.amount_money?.currency ?? "CAD",
          idempotencyKey: buildHostedPaymentAttemptIdempotencyKey(
            input.payment.id,
          ),
          operation: "square_hosted_checkout",
          paymentProvider: "square",
          providerOrderId:
            input.providerOrderId ?? input.order.providerOrderId ?? undefined,
          providerPaymentId: input.payment.id,
        },
        source: "square_hosted_checkout",
      });
    },
  };
}

function getSquareProviderEventDate(
  event: VerifiedSquareWebhookEvent | undefined,
): Date | null {
  if (event?.createdAt === undefined) {
    return null;
  }

  const date = new Date(event.createdAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getSquarePaymentProviderDate(payment: SquarePayment): Date | null {
  for (const value of [payment.updated_at, payment.created_at]) {
    if (value === undefined) {
      continue;
    }
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
  }

  return null;
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

interface SquarePaymentLookupResult {
  order: SquareOrder | null;
  payment: SquarePayment | null;
  pendingVerification?: boolean;
}

async function resolveSquarePaymentLookup(
  input: SquarePaymentFinalizerInput,
  repository: SquarePaymentFinalizerRepository,
  squareClient: SquareClient,
): Promise<SquarePaymentLookupResult> {
  const paymentId = input.paymentId ?? input.event?.paymentId;

  if (paymentId !== undefined) {
    return {
      order: null,
      payment: (await squareClient.getPayment(paymentId)).payment,
    };
  }

  const orderId = input.orderId ?? input.event?.orderId;

  if (orderId === undefined) {
    return { order: null, payment: null };
  }

  const classified = classifySquareReturnOrderId(orderId);

  if (classified.localOrderId !== undefined) {
    const localOrder = await repository.findSquareOrder({
      localOrderId: classified.localOrderId,
    });

    if (localOrder === null) {
      return { order: null, payment: null };
    }

    if (
      localOrder.providerPaymentId !== undefined &&
      localOrder.providerPaymentId !== null
    ) {
      return {
        order: null,
        payment: (await squareClient.getPayment(localOrder.providerPaymentId))
          .payment,
      };
    }

    return { order: null, payment: null, pendingVerification: true };
  }

  const order = (await squareClient.getOrder(orderId)).order;
  const orderPaymentId = getSquareOrderPaymentId(order);

  if (orderPaymentId === undefined) {
    return { order, payment: null };
  }

  return {
    order,
    payment: (await squareClient.getPayment(orderPaymentId)).payment,
  };
}

function getSquareOrderPaymentId(order: SquareOrder): string | undefined {
  const paymentIds = new Set(
    (order.tenders ?? [])
      .map((tender) => tender.payment_id ?? tender.id)
      .filter(
        (paymentId): paymentId is string =>
          typeof paymentId === "string" && paymentId.trim().length > 0,
      )
      .map((paymentId) => paymentId.trim()),
  );

  if (paymentIds.size !== 1) {
    return undefined;
  }

  return paymentIds.values().next().value;
}

function isPaidSquarePayment(payment: SquarePayment): boolean {
  return (
    payment.status !== undefined &&
    ["approved", "completed", "paid"].includes(
      payment.status.trim().toLowerCase(),
    )
  );
}

function buildReturnEventIdempotencyKey(input: {
  orderId?: string;
  paymentId?: string;
  status: string;
}): string {
  const orderPart = input.orderId ?? "";
  const paymentPart = input.paymentId ?? "";
  const normalized = `${input.status}:${orderPart}:${paymentPart}`;
  const hash = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, 32);

  return `square:return:${input.status}:${hash}`;
}

function isTerminalUnpaidSquarePayment(payment: SquarePayment): boolean {
  if (payment.status === undefined) {
    return false;
  }

  return ["canceled", "cancelled", "failed"].includes(
    payment.status.trim().toLowerCase(),
  );
}

function getFailedCheckoutOrderStatus(
  payment: SquarePayment,
): typeof checkoutOrders.$inferInsert.status {
  return payment.status?.trim().toLowerCase() === "canceled" ||
    payment.status?.trim().toLowerCase() === "cancelled"
    ? "cancelled"
    : "verification_failed";
}

function isCancelledSquarePayment(payment: SquarePayment): boolean {
  const status = payment.status?.trim().toLowerCase();
  return status === "canceled" || status === "cancelled";
}

function buildHostedPaymentAttemptIdempotencyKey(paymentId: string): string {
  return `square:hosted:${paymentId}`;
}

function hashPayload(payload: CheckoutPaymentEventPayload): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function toSquareEventInsert(
  input: SquareEventRecordInput,
): typeof checkoutPaymentEvents.$inferInsert {
  return {
    amountCents: input.amountCents,
    currency: input.currency,
    eventType: input.eventType,
    idempotencyKey: input.idempotencyKey,
    paymentProvider: "square",
    payloadHash: input.payloadSanitized
      ? hashPayload(input.payloadSanitized)
      : undefined,
    payloadSanitized: input.payloadSanitized,
    processedAt:
      input.processingStatus === "processed" ? new Date() : undefined,
    processingStatus: input.processingStatus,
    providerEventId: input.eventId,
    providerOrderId: input.orderId,
    providerPaymentId: input.paymentId,
    providerStatus: input.providerStatus,
    status: input.status,
  };
}

function toSquareEventUpdate(
  input: SquareEventRecordInput,
): Partial<typeof checkoutPaymentEvents.$inferInsert> {
  return {
    amountCents: input.amountCents,
    currency: input.currency,
    eventType: input.eventType,
    payloadHash: input.payloadSanitized
      ? hashPayload(input.payloadSanitized)
      : undefined,
    payloadSanitized: input.payloadSanitized,
    processedAt:
      input.processingStatus === "processed" ? new Date() : undefined,
    processingStatus: input.processingStatus,
    providerOrderId: input.orderId,
    providerPaymentId: input.paymentId,
    providerStatus: input.providerStatus,
    status: input.status,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
