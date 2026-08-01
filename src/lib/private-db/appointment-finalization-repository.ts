import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import { resolveBookingModelVersion } from "@/lib/booking/booking-model-version";
import type { ChargeAndStoreBookingResult } from "@/lib/booking/payments/service-charge-and-store";

import { getPrivateDb } from "./client";
import {
  appointmentCalendarEvents,
  appointmentEvents,
  appointmentHolds,
  appointments,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  bookingPolicyAcceptances,
  bookingResourceReservations,
  type AppointmentCalendarSyncStatus,
  type AppointmentHoldMetadata,
  type BookingPaymentAttemptMetadata,
  type BookingPaymentAttemptStatus,
  type PaymentProvider,
} from "./schema";

type PrivateDb = ReturnType<typeof getPrivateDb>;
type PrivateDbTransaction = Parameters<
  Parameters<PrivateDb["transaction"]>[0]
>[0];

export interface RecordBookingPaymentAttemptInput {
  amountCents: number;
  appointmentId?: string;
  authorizedAt?: Date;
  capturedAt?: Date;
  checkoutOrderId?: string;
  currency: string;
  failedAt?: Date;
  failureCode?: string;
  holdId: string;
  idempotencyKey: string;
  now: Date;
  operation: string;
  paymentProvider: PaymentProvider;
  providerMetadata?: BookingPaymentAttemptMetadata;
  providerOrderId?: string;
  providerPaymentId?: string;
  squareTeamMemberId?: string;
  status: BookingPaymentAttemptStatus;
  authorizationEligibility?: "square_charge_and_store_pre_capture";
}

export interface CapturedBookingPaymentInput {
  amountCents: number;
  capturedAt?: Date;
  checkoutOrderId?: string;
  currency: string;
  idempotencyKey: string;
  operation: string;
  paymentProvider: PaymentProvider;
  providerMetadata?: BookingPaymentAttemptMetadata;
  providerOrderId?: string;
  providerPaymentId: string;
}

export type AppointmentCalendarProjection =
  | { status: "pending" }
  | {
      providerEventEtag?: string;
      providerEventId: string;
      status: "synced";
    }
  | {
      errorCode: string;
      reason?: string;
      status: "manual_followup";
    };

export type AppointmentHoldFinalizationOutcome =
  | "paid_pending_booking"
  | "booked"
  | "manual_followup"
  | "paid_unbookable_rebooking_pending";

export interface ConfirmOperationalAppointmentInput {
  calendar: AppointmentCalendarProjection;
  holdId: string;
  holdOutcome: AppointmentHoldFinalizationOutcome;
  now: Date;
  payment?: CapturedBookingPaymentInput;
  source?: string;
  terminal?: {
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    kind: "charge_and_store";
  };
}

export type RecordBookingPaymentAttemptResult =
  | { bookingModelVersion: 1; status: "legacy" }
  | {
      attempt: typeof bookingPaymentAttempts.$inferSelect;
      bookingModelVersion: 2;
      created: boolean;
      status: "recorded";
      statusChanged: boolean;
    };

export type ConfirmOperationalAppointmentResult =
  | { bookingModelVersion: 1; status: "legacy" }
  | {
      appointment: typeof appointments.$inferSelect;
      bookingModelVersion: 2;
      created: boolean;
      hold: typeof appointmentHolds.$inferSelect;
      paymentAttempt: typeof bookingPaymentAttempts.$inferSelect | null;
      status: "confirmed";
      terminal?: {
        confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
        disposition: "applied" | "preserved";
      };
    };

export interface AppointmentFinalizationRepository {
  confirmOperationalAppointment(
    input: ConfirmOperationalAppointmentInput,
  ): Promise<ConfirmOperationalAppointmentResult>;
  recordPaymentAttempt(
    input: RecordBookingPaymentAttemptInput,
  ): Promise<RecordBookingPaymentAttemptResult>;
}

export class BookingPaymentAttemptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingPaymentAttemptConflictError";
  }
}

export class AppointmentFinalizationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppointmentFinalizationConflictError";
  }
}

export function createAppointmentFinalizationRepository(
  db: PrivateDb = getPrivateDb(),
): AppointmentFinalizationRepository {
  return {
    async recordPaymentAttempt(input) {
      validatePaymentAttemptInput(input);

      return db.transaction(async (tx) => {
        const [hold] = await tx
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (hold === undefined) {
          throw new AppointmentFinalizationConflictError(
            "Booking hold not found while recording a payment attempt",
          );
        }

        if (resolveBookingModelVersion(hold) === 1) {
          return { bookingModelVersion: 1, status: "legacy" } as const;
        }

        if (
          input.authorizationEligibility ===
          "square_charge_and_store_pre_capture"
        ) {
          assertSquareAuthorizationEligibility(hold, input.now);
        }

        const persisted = await upsertPaymentAttempt(tx, {
          ...input,
          squareTeamMemberId: hold.squareTeamMemberId ?? undefined,
        });

        return {
          attempt: persisted.attempt,
          bookingModelVersion: 2,
          created: persisted.created,
          status: "recorded",
          statusChanged: persisted.statusChanged,
        } as const;
      });
    },

    async confirmOperationalAppointment(input) {
      validateConfirmationInput(input);

      return db.transaction(async (tx) => {
        const [hold] = await tx
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (hold === undefined) {
          throw new AppointmentFinalizationConflictError(
            "Booking hold not found while confirming an appointment",
          );
        }

        if (resolveBookingModelVersion(hold) === 1) {
          return { bookingModelVersion: 1, status: "legacy" } as const;
        }

        assertOperationalHoldIsComplete(hold);

        let [appointment] = await tx
          .select()
          .from(appointments)
          .where(eq(appointments.sourceHoldId, hold.id))
          .limit(1)
          .for("update");
        const appointmentCreated = appointment === undefined;

        if (
          hold.status === "refund_required" ||
          hold.status === "refunded" ||
          hold.finalizationStatus === "refund_required" ||
          (hold.reconciliationMetadata as Record<string, unknown> | null)
            ?.chargeAndStoreRefundRequired !== undefined
        ) {
          throw new AppointmentFinalizationConflictError(
            "A refund-terminal hold cannot be finalized as an appointment",
          );
        }

        if (appointment !== undefined && input.terminal !== undefined) {
          const preserved = await preserveExistingTerminalOutcome(tx, {
            appointment,
            hold,
            input,
          });
          if (preserved !== null) {
            return preserved;
          }
        }

        if (appointment === undefined && input.payment === undefined) {
          throw new AppointmentFinalizationConflictError(
            "An online operational appointment must be created with captured payment evidence",
          );
        }

        if (appointment === undefined) {
          const reservationIds = await lockAndValidateHoldReservations(
            tx,
            hold,
          );
          const initialAppointmentStatus =
            input.holdOutcome === "paid_unbookable_rebooking_pending"
              ? "rebooking_pending"
              : "confirmed";

          [appointment] = await tx
            .insert(appointments)
            .values({
              calendarSyncLastErrorCode:
                input.calendar.status === "manual_followup"
                  ? input.calendar.errorCode
                  : null,
              calendarSyncStatus: calendarProjectionStatus(input.calendar),
              checkoutOrderId:
                input.payment?.checkoutOrderId ?? hold.checkoutOrderId,
              confirmedAt: input.now,
              createdAt: input.now,
              customerEmail: hold.customerSnapshot.email,
              customerEmailNormalized: normalizeEmail(
                hold.customerSnapshot.email,
              ),
              customerName: hold.customerSnapshot.name,
              customerPhone: emptyStringToNull(hold.customerSnapshot.phone),
              intakeSnapshot: extractIntakeSnapshot(hold.offeringSnapshot),
              occupiedEnd: hold.occupiedEnd!,
              occupiedStart: hold.occupiedStart!,
              offeringSnapshot: { ...hold.offeringSnapshot },
              origin: "online",
              paymentStatus: "pending",
              primaryResourceId: hold.primaryResourceId!,
              providerId: hold.providerId!,
              providerSnapshot: { ...hold.providerSnapshot! },
              publicReference: generateAppointmentReference(),
              selectedEnd: hold.selectedEnd,
              selectedStart: hold.selectedStart,
              serviceOfferingId: hold.serviceOfferingId!,
              sourceHoldId: hold.id,
              sourceHoldPublicReference: hold.publicReference,
              squareTeamMemberId: hold.squareTeamMemberId,
              status: initialAppointmentStatus,
              timezone: hold.timezone,
              updatedAt: input.now,
            })
            .returning();

          if (appointment === undefined) {
            throw new AppointmentFinalizationConflictError(
              "Appointment insert did not return a row",
            );
          }

          const convertedReservations = await tx
            .update(bookingResourceReservations)
            .set({
              appointmentId: appointment.id,
              expiresAt: null,
              holdId: null,
              kind: "appointment",
              updatedAt: input.now,
            })
            .where(
              and(
                inArray(bookingResourceReservations.id, reservationIds),
                eq(bookingResourceReservations.holdId, hold.id),
              ),
            )
            .returning({ id: bookingResourceReservations.id });

          if (convertedReservations.length !== reservationIds.length) {
            throw new AppointmentFinalizationConflictError(
              "Operational booking hold reservations changed during appointment conversion",
            );
          }

          await Promise.all([
            tx
              .update(bookingPolicyAcceptances)
              .set({ appointmentId: appointment.id })
              .where(eq(bookingPolicyAcceptances.holdId, hold.id)),
            tx
              .update(bookingNoShowChargeRecords)
              .set({ appointmentId: appointment.id, updatedAt: input.now })
              .where(eq(bookingNoShowChargeRecords.holdId, hold.id)),
          ]);

          await tx.insert(appointmentEvents).values({
            appointmentId: appointment.id,
            createdAt: input.now,
            eventType:
              initialAppointmentStatus === "confirmed"
                ? "appointment_confirmed"
                : "appointment_created",
            metadata: {
              bookingModelVersion: 2,
              holdPublicReference: hold.publicReference,
              holdOutcome: input.holdOutcome,
            },
            nextStatus: initialAppointmentStatus,
            source: input.source ?? "booking_finalizer",
          });
        }

        let paymentAttempt: typeof bookingPaymentAttempts.$inferSelect | null =
          null;
        let capturedPaymentStatus = appointment.paymentStatus;
        if (input.payment !== undefined) {
          const persisted = await upsertPaymentAttempt(tx, {
            ...input.payment,
            appointmentId: appointment.id,
            capturedAt: input.payment.capturedAt ?? input.now,
            holdId: hold.id,
            now: input.now,
            squareTeamMemberId: hold.squareTeamMemberId ?? undefined,
            status: "captured",
          });
          paymentAttempt = persisted.attempt;
          capturedPaymentStatus = resolveCapturedAppointmentPaymentStatus(
            hold.offeringSnapshot,
          );

          if (persisted.created || persisted.statusChanged) {
            await tx.insert(appointmentEvents).values({
              appointmentId: appointment.id,
              createdAt: input.now,
              eventType: "payment_captured",
              metadata: {
                amountCents: input.payment.amountCents,
                currency: input.payment.currency,
                paymentAttemptId: persisted.attempt.id,
                paymentProvider: input.payment.paymentProvider,
                paymentStatus: capturedPaymentStatus,
                providerPaymentId: input.payment.providerPaymentId,
              },
              source: input.source ?? "booking_finalizer",
            });
          }
        }

        const previousCalendarSyncStatus = appointment.calendarSyncStatus;
        const previousAppointmentStatus = appointment.status;
        const desiredCalendarSyncStatus = calendarProjectionStatus(
          input.calendar,
        );
        const nextCalendarSyncStatus = preserveSyncedCalendarState(
          previousCalendarSyncStatus,
          desiredCalendarSyncStatus,
        );

        if (input.calendar.status === "synced") {
          await projectCalendarEvent(tx, {
            appointmentId: appointment.id,
            calendarAssignmentId: hold.calendarAssignmentId!,
            now: input.now,
            providerCalendarId: hold.googleCalendarId!,
            providerEventEtag: input.calendar.providerEventEtag,
            providerEventId: input.calendar.providerEventId,
          });
        }

        const nextAppointmentStatus =
          input.holdOutcome === "paid_unbookable_rebooking_pending"
            ? "rebooking_pending"
            : appointment.status;
        const nextCalendarErrorCode =
          nextCalendarSyncStatus === "synced"
            ? null
            : input.calendar.status === "manual_followup"
              ? input.calendar.errorCode
              : appointment.calendarSyncLastErrorCode;
        const nextCheckoutOrderId =
          appointment.checkoutOrderId ??
          input.payment?.checkoutOrderId ??
          hold.checkoutOrderId;
        const nextPaymentStatus =
          appointment.paymentStatus === "paid" ? "paid" : capturedPaymentStatus;
        const appointmentChanged =
          appointment.calendarSyncLastErrorCode !== nextCalendarErrorCode ||
          appointment.calendarSyncStatus !== nextCalendarSyncStatus ||
          appointment.checkoutOrderId !== nextCheckoutOrderId ||
          appointment.paymentStatus !== nextPaymentStatus ||
          appointment.status !== nextAppointmentStatus;

        if (appointmentChanged) {
          const [updatedAppointment] = await tx
            .update(appointments)
            .set({
              calendarSyncLastErrorCode: nextCalendarErrorCode,
              calendarSyncStatus: nextCalendarSyncStatus,
              checkoutOrderId: nextCheckoutOrderId,
              paymentStatus: nextPaymentStatus,
              status: nextAppointmentStatus,
              updatedAt: input.now,
              version: appointment.version + 1,
            })
            .where(eq(appointments.id, appointment.id))
            .returning();

          if (updatedAppointment === undefined) {
            throw new AppointmentFinalizationConflictError(
              "Appointment disappeared during finalization",
            );
          }
          appointment = updatedAppointment;
        }

        if (
          input.calendar.status === "synced" &&
          previousCalendarSyncStatus !== "synced"
        ) {
          await tx.insert(appointmentEvents).values({
            appointmentId: appointment.id,
            createdAt: input.now,
            eventType: "calendar_synced",
            metadata: {
              calendarAssignmentId: hold.calendarAssignmentId,
              providerCalendarId: hold.googleCalendarId,
              providerEventId: input.calendar.providerEventId,
            },
            source: input.source ?? "booking_finalizer",
          });
        } else if (
          input.calendar.status === "manual_followup" &&
          previousCalendarSyncStatus !== "manual_followup" &&
          previousCalendarSyncStatus !== "synced"
        ) {
          await tx.insert(appointmentEvents).values({
            appointmentId: appointment.id,
            createdAt: input.now,
            eventType: "calendar_manual_followup",
            metadata: { errorCode: input.calendar.errorCode },
            reason: input.calendar.reason,
            source: input.source ?? "booking_finalizer",
          });
        }

        if (
          input.holdOutcome === "paid_unbookable_rebooking_pending" &&
          previousAppointmentStatus !== "rebooking_pending"
        ) {
          await tx.insert(appointmentEvents).values({
            appointmentId: appointment.id,
            createdAt: input.now,
            eventType: "rebooking_required",
            metadata:
              input.calendar.status === "manual_followup"
                ? { errorCode: input.calendar.errorCode }
                : undefined,
            nextStatus: "rebooking_pending",
            previousStatus: previousAppointmentStatus,
            reason:
              input.calendar.status === "manual_followup"
                ? input.calendar.reason
                : undefined,
            source: input.source ?? "booking_finalizer",
          });
        }

        const holdPatch = createHoldFinalizationPatch({
          appointmentId: appointment.id,
          existingMetadata: hold.reconciliationMetadata,
          input,
        });

        const [updatedHold] = await tx
          .update(appointmentHolds)
          .set(holdPatch)
          .where(eq(appointmentHolds.id, hold.id))
          .returning();

        if (updatedHold === undefined) {
          throw new AppointmentFinalizationConflictError(
            "Booking hold disappeared during finalization",
          );
        }

        return {
          appointment,
          bookingModelVersion: 2,
          created: appointmentCreated,
          hold: updatedHold,
          paymentAttempt,
          status: "confirmed",
          ...(input.terminal === undefined
            ? {}
            : {
                terminal: {
                  confirmation: input.terminal.confirmation,
                  disposition: "applied" as const,
                },
              }),
        } as const;
      });
    },
  };
}

async function preserveExistingTerminalOutcome(
  tx: PrivateDbTransaction,
  input: {
    appointment: typeof appointments.$inferSelect;
    hold: typeof appointmentHolds.$inferSelect;
    input: ConfirmOperationalAppointmentInput;
  },
): Promise<
  | Extract<
      ConfirmOperationalAppointmentResult,
      { bookingModelVersion: 2 }
    >
  | null
> {
  const metadata = (input.hold.reconciliationMetadata ?? {}) as Record<
    string,
    unknown
  >;
  const existingConfirmation = readChargeAndStoreConfirmation(
    metadata.chargeAndStoreConfirmation,
  );
  const existingRank = Math.max(
    terminalRankForBookingStatus(existingConfirmation?.bookingStatus),
    input.hold.status === "booked"
      ? 2
      : input.hold.status === "manual_followup"
        ? 1
        : 0,
    input.hold.finalizationStatus === "booked"
      ? 2
      : input.hold.finalizationStatus === "manual_review"
        ? 1
        : 0,
    input.appointment.calendarSyncStatus === "synced"
      ? 2
      : input.appointment.calendarSyncStatus === "manual_followup"
        ? 1
        : 0,
  );
  const incomingRank =
    input.input.holdOutcome === "booked"
      ? 2
      : input.input.holdOutcome === "manual_followup"
        ? 1
        : 0;

  if (existingRank === 0 || incomingRank > existingRank) {
    return null;
  }

  const baseConfirmation =
    existingConfirmation ?? input.input.terminal?.confirmation;
  const effectiveConfirmation =
    baseConfirmation === undefined
      ? undefined
      : {
          ...baseConfirmation,
          bookingStatus:
            existingRank === 2
              ? ("booked" as const)
              : ("manual_followup" as const),
        };
  const reconciliationMetadata = {
    ...metadata,
    ...(effectiveConfirmation === undefined
      ? {}
      : { chargeAndStoreConfirmation: effectiveConfirmation }),
    chargeAndStoreInProgress: undefined,
  };
  const terminalPatch: Partial<typeof appointmentHolds.$inferInsert> =
    existingRank === 2
      ? {
          bookedAt: input.hold.bookedAt ?? input.input.now,
          finalizationReason: null,
          finalizationStatus: "booked",
          reconciliationMetadata,
          status: "booked",
          updatedAt: input.input.now,
        }
      : {
          finalizationStatus: "manual_review",
          manualFollowupAt:
            input.hold.manualFollowupAt ?? input.input.now,
          reconciliationMetadata,
          status: "manual_followup",
          updatedAt: input.input.now,
        };
  const [updatedHold] = await tx
    .update(appointmentHolds)
    .set(terminalPatch)
    .where(eq(appointmentHolds.id, input.hold.id))
    .returning();

  if (updatedHold === undefined) {
    throw new AppointmentFinalizationConflictError(
      "Booking hold disappeared while preserving its terminal outcome",
    );
  }

  return {
    appointment: input.appointment,
    bookingModelVersion: 2,
    created: false,
    hold: updatedHold,
    paymentAttempt: null,
    status: "confirmed",
    ...(effectiveConfirmation === undefined
      ? {}
      : {
          terminal: {
            confirmation: effectiveConfirmation,
            disposition: "preserved" as const,
          },
        }),
  };
}

function readChargeAndStoreConfirmation(
  value: unknown,
): Extract<ChargeAndStoreBookingResult, { ok: true }> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const confirmation = value as Partial<
    Extract<ChargeAndStoreBookingResult, { ok: true }>
  >;
  if (
    confirmation.ok !== true ||
    (confirmation.bookingStatus !== "booked" &&
      confirmation.bookingStatus !== "manual_followup") ||
    confirmation.paymentStatus !== "captured" ||
    typeof confirmation.holdReference !== "string" ||
    confirmation.card === null ||
    typeof confirmation.card !== "object"
  ) {
    return undefined;
  }

  return confirmation as Extract<ChargeAndStoreBookingResult, { ok: true }>;
}

function terminalRankForBookingStatus(
  status: "booked" | "manual_followup" | undefined,
): number {
  return status === "booked" ? 2 : status === "manual_followup" ? 1 : 0;
}

async function upsertPaymentAttempt(
  tx: PrivateDbTransaction,
  input: RecordBookingPaymentAttemptInput,
): Promise<{
  attempt: typeof bookingPaymentAttempts.$inferSelect;
  created: boolean;
  statusChanged: boolean;
}> {
  validatePaymentAttemptInput(input);

  let [attempt] = await tx
    .insert(bookingPaymentAttempts)
    .values({
      amountCents: input.amountCents,
      appointmentId: input.appointmentId,
      authorizedAt:
        input.authorizedAt ??
        (input.status === "authorized" ? input.now : undefined),
      capturedAt:
        input.capturedAt ??
        (input.status === "captured" || input.status === "refunded"
          ? input.now
          : undefined),
      checkoutOrderId: input.checkoutOrderId,
      createdAt: input.now,
      currency: normalizeCurrency(input.currency),
      failedAt:
        input.failedAt ?? (input.status === "failed" ? input.now : undefined),
      failureCode: input.failureCode,
      holdId: input.holdId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      paymentProvider: input.paymentProvider,
      providerMetadata: input.providerMetadata,
      providerOrderId: input.providerOrderId,
      providerPaymentId: input.providerPaymentId,
      squareTeamMemberId: input.squareTeamMemberId,
      status: input.status,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: bookingPaymentAttempts.idempotencyKey })
    .returning();

  if (attempt !== undefined) {
    return { attempt, created: true, statusChanged: true };
  }

  [attempt] = await tx
    .select()
    .from(bookingPaymentAttempts)
    .where(eq(bookingPaymentAttempts.idempotencyKey, input.idempotencyKey))
    .limit(1)
    .for("update");

  if (attempt === undefined) {
    throw new BookingPaymentAttemptConflictError(
      "Payment attempt conflict did not resolve to an existing row",
    );
  }

  assertPaymentAttemptIdentity(attempt, input);

  const statusChanged = attempt.status !== input.status;
  if (
    statusChanged &&
    !canAdvancePaymentAttempt(attempt.status, input.status)
  ) {
    throw new BookingPaymentAttemptConflictError(
      `Payment attempt cannot transition from ${attempt.status} to ${input.status}`,
    );
  }

  const [updated] = await tx
    .update(bookingPaymentAttempts)
    .set({
      appointmentId: attempt.appointmentId ?? input.appointmentId,
      authorizedAt:
        attempt.authorizedAt ??
        input.authorizedAt ??
        (input.status === "authorized" ? input.now : undefined),
      capturedAt:
        attempt.capturedAt ??
        input.capturedAt ??
        (input.status === "captured" || input.status === "refunded"
          ? input.now
          : undefined),
      checkoutOrderId: attempt.checkoutOrderId ?? input.checkoutOrderId,
      failedAt:
        attempt.failedAt ??
        input.failedAt ??
        (input.status === "failed" ? input.now : undefined),
      failureCode: input.failureCode ?? attempt.failureCode,
      providerMetadata: {
        ...(attempt.providerMetadata ?? {}),
        ...(input.providerMetadata ?? {}),
      },
      providerOrderId: attempt.providerOrderId ?? input.providerOrderId,
      providerPaymentId: attempt.providerPaymentId ?? input.providerPaymentId,
      squareTeamMemberId:
        attempt.squareTeamMemberId ?? input.squareTeamMemberId,
      status: input.status,
      updatedAt: input.now,
    })
    .where(eq(bookingPaymentAttempts.id, attempt.id))
    .returning();

  if (updated === undefined) {
    throw new BookingPaymentAttemptConflictError(
      "Payment attempt disappeared while it was being updated",
    );
  }

  return { attempt: updated, created: false, statusChanged };
}

async function projectCalendarEvent(
  tx: PrivateDbTransaction,
  input: {
    appointmentId: string;
    calendarAssignmentId: string;
    now: Date;
    providerCalendarId: string;
    providerEventEtag?: string;
    providerEventId: string;
  },
): Promise<void> {
  const [activeProjection] = await tx
    .select()
    .from(appointmentCalendarEvents)
    .where(
      and(
        eq(appointmentCalendarEvents.appointmentId, input.appointmentId),
        eq(
          appointmentCalendarEvents.calendarAssignmentId,
          input.calendarAssignmentId,
        ),
        isNull(appointmentCalendarEvents.deletedAt),
      ),
    )
    .limit(1)
    .for("update");

  if (
    activeProjection !== undefined &&
    activeProjection.providerEventId !== input.providerEventId
  ) {
    throw new AppointmentFinalizationConflictError(
      "Appointment already has a different active calendar event projection",
    );
  }

  if (activeProjection === undefined) {
    await tx.insert(appointmentCalendarEvents).values({
      appointmentId: input.appointmentId,
      calendarAssignmentId: input.calendarAssignmentId,
      createdAt: input.now,
      lastAttemptedAt: input.now,
      lastSyncedAt: input.now,
      providerCalendarId: input.providerCalendarId,
      providerEventEtag: input.providerEventEtag,
      providerEventId: input.providerEventId,
      syncStatus: "synced",
      updatedAt: input.now,
    });
    return;
  }

  await tx
    .update(appointmentCalendarEvents)
    .set({
      lastAttemptedAt: input.now,
      lastErrorCode: null,
      lastSyncedAt: input.now,
      providerCalendarId: input.providerCalendarId,
      providerEventEtag:
        input.providerEventEtag ?? activeProjection.providerEventEtag,
      syncStatus: "synced",
      updatedAt: input.now,
    })
    .where(eq(appointmentCalendarEvents.id, activeProjection.id));
}

async function lockAndValidateHoldReservations(
  tx: PrivateDbTransaction,
  hold: typeof appointmentHolds.$inferSelect,
): Promise<string[]> {
  const expectedResourceIds = readExpectedReservedResourceIds(
    hold.offeringSnapshot,
  );
  const reservations = await tx
    .select()
    .from(bookingResourceReservations)
    .where(eq(bookingResourceReservations.holdId, hold.id))
    .for("update");
  const actualResourceIds = reservations
    .map((reservation) => reservation.resourceId)
    .sort((first, second) => first.localeCompare(second));
  const holdStart = hold.occupiedStart?.getTime();
  const holdEnd = hold.occupiedEnd?.getTime();
  const allReservationsAreConvertible = reservations.every(
    (reservation) =>
      reservation.kind === "hold" &&
      reservation.state === "active" &&
      reservation.appointmentId === null &&
      reservation.scheduleExceptionId === null &&
      reservation.expiresAt !== null &&
      reservation.occupiedStart.getTime() === holdStart &&
      reservation.occupiedEnd.getTime() === holdEnd,
  );

  if (
    !allReservationsAreConvertible ||
    actualResourceIds.length !== expectedResourceIds.length ||
    actualResourceIds.some(
      (resourceId, index) => resourceId !== expectedResourceIds[index],
    )
  ) {
    throw new AppointmentFinalizationConflictError(
      "Operational booking hold does not own every expected active resource reservation",
    );
  }

  return reservations.map((reservation) => reservation.id);
}

function readExpectedReservedResourceIds(
  offeringSnapshot: Record<string, unknown>,
): string[] {
  const value = offeringSnapshot.reservedResourceIds;
  const expectedCount = offeringSnapshot.reservedResourceCount;

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (resourceId): resourceId is string =>
        typeof resourceId === "string" && resourceId.trim().length > 0,
    ) ||
    !Number.isInteger(expectedCount) ||
    expectedCount !== value.length
  ) {
    throw new AppointmentFinalizationConflictError(
      "Operational booking hold is missing its immutable reserved-resource set",
    );
  }

  const sorted = [...value].sort((first, second) =>
    first.localeCompare(second),
  );
  if (new Set(sorted).size !== sorted.length) {
    throw new AppointmentFinalizationConflictError(
      "Operational booking hold has an invalid reserved-resource set",
    );
  }

  return sorted;
}

function resolveCapturedAppointmentPaymentStatus(
  offeringSnapshot: Record<string, unknown>,
): "paid" | "partially_paid" {
  const selectedPayment = offeringSnapshot.selectedPayment;

  if (selectedPayment === null || typeof selectedPayment !== "object") {
    throw new AppointmentFinalizationConflictError(
      "Operational booking hold is missing its validated payment selection",
    );
  }

  const purpose = (selectedPayment as { purpose?: unknown }).purpose;
  if (purpose === "appointment_full") {
    return "paid";
  }

  if (
    purpose === "appointment_deposit" ||
    purpose === "appointment_custom_partial"
  ) {
    return "partially_paid";
  }

  throw new AppointmentFinalizationConflictError(
    "Operational booking hold has an unsupported payment selection",
  );
}

function createHoldFinalizationPatch(input: {
  appointmentId: string;
  existingMetadata: AppointmentHoldMetadata | null;
  input: ConfirmOperationalAppointmentInput;
}): Partial<typeof appointmentHolds.$inferInsert> {
  const now = input.input.now;
  const payment = input.input.payment;
  const calendar = input.input.calendar;
  const existingMetadata = input.existingMetadata ?? {};
  const authoritativeAppointment = {
    appointmentId: input.appointmentId,
    bookingModelVersion: 2,
    holdOutcome: input.input.holdOutcome,
    updatedAt: now.toISOString(),
  };
  const common: Partial<typeof appointmentHolds.$inferInsert> = {
    captureLeaseExpiresAt: null,
    captureLeaseId: null,
    ...(payment?.paymentProvider === "helcim"
      ? { helcimTransactionId: payment.providerPaymentId }
      : {}),
    ...(payment?.paymentProvider === "square"
      ? {
          squareOrderId: payment.providerOrderId,
          squarePaymentId: payment.providerPaymentId,
        }
      : {}),
    paidAt: payment === undefined ? undefined : (payment.capturedAt ?? now),
    paymentProvider: payment?.paymentProvider,
    reconciliationMetadata: {
      ...existingMetadata,
      authoritativeAppointment,
      ...(input.input.terminal === undefined
        ? {}
        : {
            chargeAndStoreConfirmation:
              input.input.terminal.confirmation,
            chargeAndStoreInProgress: undefined,
          }),
    },
    updatedAt: now,
  };

  if (input.input.holdOutcome === "paid_pending_booking") {
    return {
      ...common,
      finalizationReason: null,
      finalizationStatus: "paid_calendar_pending",
      status: "paid_pending_booking",
    };
  }

  if (input.input.holdOutcome === "booked") {
    return {
      ...common,
      bookedAt: now,
      finalizationReason: null,
      finalizationStatus: "booked",
      googleEventId:
        calendar.status === "synced" ? calendar.providerEventId : undefined,
      status: "booked",
    };
  }

  if (input.input.holdOutcome === "paid_unbookable_rebooking_pending") {
    return {
      ...common,
      failureReason:
        calendar.status === "manual_followup" ? calendar.reason : undefined,
      finalizationReason:
        calendar.status === "manual_followup" ? calendar.reason : undefined,
      finalizationStatus: "paid_unbookable_rebooking_pending",
      manualFollowupAt: now,
      manualReviewReason:
        calendar.status === "manual_followup" ? calendar.reason : undefined,
      manualReviewStatus: "rebooking_pending",
      status: "paid_unbookable_rebooking_pending",
    };
  }

  return {
    ...common,
    failureReason:
      calendar.status === "manual_followup" ? calendar.reason : undefined,
    finalizationReason:
      calendar.status === "manual_followup" ? calendar.reason : undefined,
    finalizationStatus: "manual_review",
    manualFollowupAt: now,
    status: "manual_followup",
  };
}

function assertOperationalHoldIsComplete(
  hold: typeof appointmentHolds.$inferSelect,
): void {
  if (
    hold.serviceOfferingId === null ||
    hold.providerId === null ||
    hold.primaryResourceId === null ||
    hold.providerSnapshot === null ||
    hold.occupiedStart === null ||
    hold.occupiedEnd === null ||
    hold.calendarAssignmentId === null ||
    hold.googleCalendarId === null
  ) {
    throw new AppointmentFinalizationConflictError(
      "Operational booking hold is missing authoritative routing data",
    );
  }
}

function assertSquareAuthorizationEligibility(
  hold: typeof appointmentHolds.$inferSelect,
  now: Date,
): void {
  const metadata = (hold.reconciliationMetadata ?? {}) as Record<
    string,
    unknown
  >;
  if (
    hold.status !== "held" ||
    hold.finalizationStatus !== "pending" ||
    hold.captureLeaseId === null ||
    hold.captureLeaseExpiresAt === null ||
    hold.captureLeaseExpiresAt <= now ||
    metadata.chargeAndStoreConfirmation !== undefined ||
    metadata.chargeAndStoreRefundRequired !== undefined ||
    metadata.authoritativeAppointment !== undefined
  ) {
    throw new AppointmentFinalizationConflictError(
      "Booking hold is no longer eligible for Square authorization",
    );
  }
}

function assertPaymentAttemptIdentity(
  attempt: typeof bookingPaymentAttempts.$inferSelect,
  input: RecordBookingPaymentAttemptInput,
): void {
  const mismatches = [
    attempt.holdId !== input.holdId ? "hold" : null,
    attempt.operation !== input.operation ? "operation" : null,
    attempt.paymentProvider !== input.paymentProvider ? "provider" : null,
    attempt.amountCents !== input.amountCents ? "amount" : null,
    attempt.currency !== normalizeCurrency(input.currency) ? "currency" : null,
    hasConflictingValue(attempt.appointmentId, input.appointmentId)
      ? "appointment"
      : null,
    hasConflictingValue(attempt.checkoutOrderId, input.checkoutOrderId)
      ? "checkout order"
      : null,
    hasConflictingValue(attempt.providerOrderId, input.providerOrderId)
      ? "provider order"
      : null,
    hasConflictingValue(attempt.providerPaymentId, input.providerPaymentId)
      ? "provider payment"
      : null,
    hasConflictingValue(attempt.squareTeamMemberId, input.squareTeamMemberId)
      ? "Square team member"
      : null,
  ].filter((value): value is string => value !== null);

  if (mismatches.length > 0) {
    throw new BookingPaymentAttemptConflictError(
      `Idempotency key was already used for a different ${mismatches.join(
        ", ",
      )}`,
    );
  }
}

function hasConflictingValue(
  existing: string | null,
  incoming: string | undefined,
): boolean {
  return existing !== null && incoming !== undefined && existing !== incoming;
}

function canAdvancePaymentAttempt(
  current: BookingPaymentAttemptStatus,
  next: BookingPaymentAttemptStatus,
): boolean {
  if (current === next) {
    return true;
  }

  const transitions: Record<
    BookingPaymentAttemptStatus,
    readonly BookingPaymentAttemptStatus[]
  > = {
    authorized: ["captured", "failed", "cancelled"],
    cancelled: [],
    captured: ["refunded"],
    failed: [],
    pending: ["authorized", "captured", "failed", "cancelled"],
    refunded: [],
  };

  return transitions[current].includes(next);
}

function validatePaymentAttemptInput(
  input: RecordBookingPaymentAttemptInput,
): void {
  if (
    input.holdId.trim().length === 0 ||
    input.operation.trim().length === 0 ||
    input.idempotencyKey.trim().length === 0 ||
    !Number.isInteger(input.amountCents) ||
    input.amountCents < 0 ||
    normalizeCurrency(input.currency).length !== 3 ||
    Number.isNaN(input.now.getTime()) ||
    (input.status === "captured" &&
      (input.providerPaymentId === undefined ||
        input.providerPaymentId.trim().length === 0))
  ) {
    throw new TypeError("Invalid booking payment attempt input");
  }
}

function validateConfirmationInput(
  input: ConfirmOperationalAppointmentInput,
): void {
  const matrixIsValid =
    (input.holdOutcome === "paid_pending_booking" &&
      input.calendar.status === "pending") ||
    (input.holdOutcome === "booked" && input.calendar.status === "synced") ||
    (input.holdOutcome === "manual_followup" &&
      input.calendar.status === "manual_followup") ||
    (input.holdOutcome === "paid_unbookable_rebooking_pending" &&
      input.calendar.status === "manual_followup");

  if (
    input.holdId.trim().length === 0 ||
    Number.isNaN(input.now.getTime()) ||
    !matrixIsValid ||
    (input.calendar.status === "synced" &&
      input.calendar.providerEventId.trim().length === 0) ||
    (input.calendar.status === "manual_followup" &&
      input.calendar.errorCode.trim().length === 0)
  ) {
    throw new TypeError("Invalid operational appointment confirmation input");
  }

  if (
    input.terminal !== undefined &&
    ((input.holdOutcome === "booked" &&
      input.terminal.confirmation.bookingStatus !== "booked") ||
      (input.holdOutcome === "manual_followup" &&
        input.terminal.confirmation.bookingStatus !== "manual_followup") ||
      (input.holdOutcome !== "booked" &&
        input.holdOutcome !== "manual_followup"))
  ) {
    throw new TypeError(
      "Terminal booking confirmation does not match the hold outcome",
    );
  }

  if (input.payment !== undefined) {
    validatePaymentAttemptInput({
      ...input.payment,
      holdId: input.holdId,
      now: input.now,
      status: "captured",
    });
  }
}

function calendarProjectionStatus(
  projection: AppointmentCalendarProjection,
): AppointmentCalendarSyncStatus {
  if (projection.status === "synced") {
    return "synced";
  }

  if (projection.status === "manual_followup") {
    return "manual_followup";
  }

  return "pending";
}

function preserveSyncedCalendarState(
  current: AppointmentCalendarSyncStatus,
  desired: AppointmentCalendarSyncStatus,
): AppointmentCalendarSyncStatus {
  return current === "synced" ? "synced" : desired;
}

function extractIntakeSnapshot(
  offeringSnapshot: Record<string, unknown>,
): Record<string, unknown> | null {
  return "answers" in offeringSnapshot
    ? { answers: offeringSnapshot.answers }
    : null;
}

function emptyStringToNull(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function generateAppointmentReference(): string {
  return `appt_${nanoid(12)}`;
}
