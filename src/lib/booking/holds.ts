import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  appointmentHolds,
  checkoutOrders,
  type CalendarFinalizationStatus,
  type AppointmentHoldMetadata,
  type PaymentProvider,
} from "@/lib/private-db/schema";
import type { BookingFinalizerRepository } from "./finalizer";
import { PAYMENT_SUCCESS_GRACE_MINUTES } from "./payment-policy";

import type { BookingType, CalendarEventWindow } from "./types";

export type BookingHoldState =
  | "held"
  | "payment_pending"
  | "paid_pending_booking"
  | "booked"
  | "expired"
  | "payment_failed"
  | "booking_failed"
  | "manual_followup"
  | "paid_unbookable_rebooking_pending"
  | "manual_rebooked"
  | "refund_required"
  | "refunded"
  | "released";

export interface BookingHoldCustomerSnapshot {
  email: string;
  name: string;
  phone: string;
}

export interface BookingHoldPaymentSnapshot {
  amountCents: number;
  currency: string;
  recordedAt: Date;
  source: "client_validation" | "return" | "webhook";
  transactionId: string;
}

export interface BookingHoldRecord {
  bookingType: BookingType;
  bookedAt?: Date | null;
  bookingFailedAt?: Date | null;
  checkoutOrderId?: string | null;
  checkoutOrderPublicId?: string | null;
  createdAt: Date;
  customer: BookingHoldCustomerSnapshot;
  expiresAt: Date;
  expiredAt?: Date | null;
  failureMetadata?: AppointmentHoldMetadata | null;
  failureReason?: string | null;
  finalizationReason?: string | null;
  finalizationStatus?: CalendarFinalizationStatus | null;
  googleEventId: string | null;
  helcimInvoiceId?: number | null;
  helcimInvoiceNumber?: string | null;
  helcimTransactionId?: string | null;
  id: string;
  manualFollowupAt?: Date | null;
  manualReviewReason?: string | null;
  manualReviewStatus?: string | null;
  offeringId: string;
  offeringSnapshot: Record<string, unknown>;
  paidAt?: Date | null;
  payment: BookingHoldPaymentSnapshot | null;
  paymentProvider?: PaymentProvider | null;
  paymentFailedAt?: Date | null;
  publicReference: string;
  reconciliationMetadata?: AppointmentHoldMetadata | null;
  releasedAt?: Date | null;
  selectedEnd: Date;
  selectedStart: Date;
  squareCheckoutId?: string | null;
  squareOrderId?: string | null;
  squarePaymentId?: string | null;
  squarePaymentLinkId?: string | null;
  squarePaymentLinkUrl?: string | null;
  state: BookingHoldState;
  timezone: string;
  updatedAt: Date;
}

export interface CreateBookingHoldRecordInput {
  bookingType: BookingType;
  customer: BookingHoldCustomerSnapshot;
  expiresAt: Date;
  offeringId: string;
  offeringSnapshot: Record<string, unknown>;
  selectedEnd: Date;
  selectedStart: Date;
  timezone: string;
  now: Date;
}

export interface BookingHoldRepository {
  createConflictSafeHold(input: CreateBookingHoldRecordInput): Promise<CreateBookingHoldResult>;
}

export interface TransitionAppointmentHoldInput {
  checkoutOrderId?: string;
  checkoutOrderPublicId?: string;
  failureMetadata?: AppointmentHoldMetadata;
  failureReason?: string;
  finalizationReason?: string;
  finalizationStatus?: CalendarFinalizationStatus;
  googleEventId?: string;
  helcimInvoiceId?: number;
  helcimInvoiceNumber?: string;
  helcimTransactionId?: string;
  holdId: string;
  now: Date;
  paymentProvider?: PaymentProvider;
  reconciliationMetadata?: AppointmentHoldMetadata;
  requiredState?: BookingHoldState;
  expiresAfter?: Date;
  squareCheckoutId?: string;
  squareOrderId?: string;
  squarePaymentId?: string;
  squarePaymentLinkId?: string;
  squarePaymentLinkUrl?: string;
  manualReviewReason?: string;
  manualReviewStatus?: string;
  status: BookingHoldState;
}

export interface AppointmentHoldLifecycleRepository extends BookingHoldRepository {
  transitionHold(input: TransitionAppointmentHoldInput): Promise<BookingHoldRecord | null>;
}

export type CreateAppointmentHoldInput = Omit<Parameters<typeof createBookingHold>[0], "repository">;

export interface AppointmentHoldStore {
  createHold(input: CreateAppointmentHoldInput): Promise<CreateBookingHoldResult>;
  releaseHold(input: { holdId: string; now?: Date }): Promise<BookingHoldRecord | null>;
  transitionHold(
    input: Omit<TransitionAppointmentHoldInput, "now"> & { now?: Date },
  ): Promise<BookingHoldRecord | null>;
}

export type BookingConfirmationEmailClaimRecord = BookingHoldRecord;

export interface ClaimBookingConfirmationEmailByOrderIdInput {
  claimForMs?: number;
  now?: Date;
  orderId: string;
}

export interface BookingConfirmationEmailMutationInput {
  holdId: string;
  now?: Date;
}

export interface BookingConfirmationEmailFailureInput extends BookingConfirmationEmailMutationInput {
  error: string;
}

export type CreateBookingHoldResult =
  | { ok: true; hold: BookingHoldRecord }
  | { ok: false; reason: "slot_conflict"; conflictingHoldId: string };

export const HOLD_DURATION_MINUTES = 10;
export const ACTIVE_HOLD_STATES: readonly BookingHoldState[] = [
  "held",
  "payment_pending",
  "paid_pending_booking",
];

const MINUTE_MS = 60_000;
const PAYMENT_SUCCESS_GRACE_MS = PAYMENT_SUCCESS_GRACE_MINUTES * MINUTE_MS;
const EMAIL_CLAIM_DURATION_MS = 5 * MINUTE_MS;
const ACTIVE_HOLD_STATES_FOR_QUERY = [...ACTIVE_HOLD_STATES];
const GRACE_PROTECTED_HOLD_STATES: readonly BookingHoldState[] = [
  "payment_pending",
  "paid_pending_booking",
];
const GRACE_PROTECTED_HOLD_STATES_FOR_QUERY = [...GRACE_PROTECTED_HOLD_STATES];
const SENSITIVE_METADATA_KEY_PATTERN = /card|checkouttoken|checkout_token|cvc|cvv|pan|rawwebhook|raw_webhook|secret|token/i;

export function createAppointmentHoldStore(
  repository: AppointmentHoldLifecycleRepository,
): AppointmentHoldStore {
  return {
    async createHold(input) {
      return createBookingHold({ ...input, repository });
    },

    async releaseHold(input) {
      return transitionHoldWithRepository(repository, {
        holdId: input.holdId,
        now: input.now,
        status: "released",
      });
    },

    async transitionHold(input) {
      return transitionHoldWithRepository(repository, input);
    },
  };
}

function transitionHoldWithRepository(
  repository: AppointmentHoldLifecycleRepository,
  input: Omit<TransitionAppointmentHoldInput, "now"> & { now?: Date },
): Promise<BookingHoldRecord | null> {
  const now = input.now ?? new Date();

  return repository.transitionHold({
    ...input,
    failureMetadata: redactHoldMetadata(input.failureMetadata),
    now,
    reconciliationMetadata: redactHoldMetadata(input.reconciliationMetadata),
  });
}

const defaultAppointmentHoldStore = createAppointmentHoldStore(
  createDrizzleAppointmentHoldRepository(),
);

export async function createAppointmentHold(
  input: CreateAppointmentHoldInput,
): Promise<CreateBookingHoldResult> {
  return defaultAppointmentHoldStore.createHold(input);
}

export async function releaseAppointmentHold(input: {
  holdId: string;
  now?: Date;
}): Promise<BookingHoldRecord | null> {
  return defaultAppointmentHoldStore.releaseHold(input);
}

export async function transitionAppointmentHold(
  input: Omit<TransitionAppointmentHoldInput, "now"> & { now?: Date },
): Promise<BookingHoldRecord | null> {
  return defaultAppointmentHoldStore.transitionHold(input);
}

export async function markAppointmentHoldManualRebooked(input: {
  availabilityValidatedAt: Date;
  googleEventId: string;
  holdId: string;
  manualReviewReason?: string;
  now?: Date;
  store?: AppointmentHoldStore;
}): Promise<BookingHoldRecord | null> {
  const now = input.now ?? new Date();
  assertManualRebookingAvailabilityValidated({
    availabilityValidatedAt: input.availabilityValidatedAt,
    googleEventId: input.googleEventId,
    now,
  });

  return (input.store ?? defaultAppointmentHoldStore).transitionHold({
    finalizationStatus: "manual_rebooked",
    googleEventId: input.googleEventId,
    holdId: input.holdId,
    manualReviewReason: input.manualReviewReason ?? "Manual rebooking availability validated before Calendar correlation.",
    manualReviewStatus: "availability_validated",
    now,
    reconciliationMetadata: {
      manualRebooking: {
        availabilityValidatedAt: input.availabilityValidatedAt.toISOString(),
      },
    },
    requiredState: "paid_unbookable_rebooking_pending",
    status: "manual_rebooked",
  });
}

function assertManualRebookingAvailabilityValidated(input: {
  availabilityValidatedAt: Date;
  googleEventId: string;
  now: Date;
}): void {
  if (input.googleEventId.trim().length === 0) {
    throw new Error("Manual rebooking requires a Google Calendar event ID.");
  }

  if (Number.isNaN(input.availabilityValidatedAt.getTime())) {
    throw new Error("Manual rebooking requires a valid availability validation timestamp.");
  }

  if (input.availabilityValidatedAt.getTime() > input.now.getTime()) {
    throw new Error("Manual rebooking availability validation cannot be in the future.");
  }
}

export async function listActiveAppointmentHolds(input: {
  offeringId: string;
  timeMin: Date;
  timeMax: Date;
  now?: Date;
}): Promise<BookingHoldRecord[]> {
  const now = input.now ?? new Date();
  const rows = await (await getAppointmentHoldDb())
    .select()
    .from(appointmentHolds)
    .where(
      and(
        eq(appointmentHolds.offeringId, input.offeringId),
        inArray(appointmentHolds.status, ACTIVE_HOLD_STATES_FOR_QUERY),
        isDrizzleActiveHold(now),
        lt(appointmentHolds.selectedStart, input.timeMax),
        gt(appointmentHolds.selectedEnd, input.timeMin),
      ),
    );

  return rows.map(toBookingHoldRecord);
}

export async function getAppointmentHoldByPublicReference(
  publicReference: string,
): Promise<BookingHoldRecord | null> {
  const [row] = await (await getAppointmentHoldDb())
    .select()
    .from(appointmentHolds)
    .where(eq(appointmentHolds.publicReference, publicReference))
    .limit(1);

  return row ? toBookingHoldRecord(row) : null;
}

export async function getAppointmentHoldByCheckoutOrder(input: {
  checkoutOrderId: string;
  checkoutOrderPublicId: string;
}): Promise<BookingHoldRecord | null> {
  const [row] = await (await getAppointmentHoldDb())
    .select()
    .from(appointmentHolds)
    .where(
      or(
        eq(appointmentHolds.checkoutOrderId, input.checkoutOrderId),
        eq(appointmentHolds.checkoutOrderPublicId, input.checkoutOrderPublicId),
      ),
    )
    .limit(1);

  return row ? toBookingHoldRecord(row) : null;
}

export async function getAppointmentHoldByCheckoutOrderPublicId(
  checkoutOrderPublicId: string,
): Promise<BookingHoldRecord | null> {
  if (checkoutOrderPublicId.trim().length === 0) {
    return null;
  }

  const [row] = await (await getAppointmentHoldDb())
    .select()
    .from(appointmentHolds)
    .where(eq(appointmentHolds.checkoutOrderPublicId, checkoutOrderPublicId))
    .limit(1);

  return row ? toBookingHoldRecord(row) : null;
}

export async function claimBookingConfirmationEmailByOrderId(
  input: ClaimBookingConfirmationEmailByOrderIdInput,
): Promise<BookingConfirmationEmailClaimRecord | null> {
  const now = input.now ?? new Date();
  const claimUntil = new Date(now.getTime() + (input.claimForMs ?? EMAIL_CLAIM_DURATION_MS));
  const [row] = await (await getAppointmentHoldDb())
    .update(appointmentHolds)
    .set({
      bookingConfirmationEmailClaimedUntil: claimUntil,
      bookingConfirmationEmailLastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(appointmentHolds.checkoutOrderPublicId, input.orderId),
        eq(appointmentHolds.status, "booked"),
        isNotNull(appointmentHolds.googleEventId),
        isNull(appointmentHolds.bookingConfirmationEmailSentAt),
        or(
          isNull(appointmentHolds.bookingConfirmationEmailClaimedUntil),
          lte(appointmentHolds.bookingConfirmationEmailClaimedUntil, now),
        ),
      ),
    )
    .returning();

  return row ? toBookingHoldRecord(row) : null;
}

export async function markBookingConfirmationEmailSent(
  input: BookingConfirmationEmailMutationInput,
): Promise<void> {
  const now = input.now ?? new Date();
  await (await getAppointmentHoldDb())
    .update(appointmentHolds)
    .set({
      bookingConfirmationEmailClaimedUntil: null,
      bookingConfirmationEmailLastError: null,
      bookingConfirmationEmailSentAt: now,
      updatedAt: now,
    })
    .where(eq(appointmentHolds.id, input.holdId));
}

export async function recordBookingConfirmationEmailFailure(
  input: BookingConfirmationEmailFailureInput,
): Promise<void> {
  const now = input.now ?? new Date();
  await (await getAppointmentHoldDb())
    .update(appointmentHolds)
    .set({
      bookingConfirmationEmailClaimedUntil: null,
      bookingConfirmationEmailLastError: input.error,
      updatedAt: now,
    })
    .where(eq(appointmentHolds.id, input.holdId));
}

export interface AppointmentHoldFinalizerRepositoryDependencies {
  getHoldById(holdId: string): Promise<BookingHoldRecord | null>;
  transitionHold(input: Omit<TransitionAppointmentHoldInput, "now"> & { now?: Date }): Promise<BookingHoldRecord | null>;
  updateCheckoutOrderCalendarFinalization?(input: {
    calendarEventId?: string;
    checkoutOrderId: string;
    now: Date;
    status: CalendarFinalizationStatus;
  }): Promise<void>;
}

export function createAppointmentHoldFinalizerRepository(
  dependencies: AppointmentHoldFinalizerRepositoryDependencies,
): BookingFinalizerRepository {
  return {
    async lockHold(holdId) {
      return dependencies.getHoldById(holdId);
    },

    async recordPaidPendingBooking(input) {
      const updated = await dependencies.transitionHold({
        finalizationStatus: "paid_calendar_pending",
        helcimTransactionId: input.payment.transactionId,
        holdId: input.holdId,
        now: input.now,
        reconciliationMetadata: {
          payment: {
            amountCents: input.payment.amountCents,
            currency: input.payment.currency,
            source: input.payment.source,
            transactionId: input.payment.transactionId,
          },
        },
        status: "paid_pending_booking",
      });

      if (updated === null) {
        throw new Error("Booking hold could not be marked paid.");
      }

      await syncCheckoutOrderCalendarFinalization(dependencies, {
        hold: updated,
        now: input.now,
        status: "paid_calendar_pending",
      });

      return updated;
    },

    async recordCalendarRetryPending(input) {
      const updated = await dependencies.transitionHold({
        failureMetadata: { error: input.error },
        failureReason: input.error,
        finalizationReason: input.error,
        finalizationStatus: "paid_calendar_pending",
        holdId: input.holdId,
        now: input.now,
        requiredState: "paid_pending_booking",
        status: "paid_pending_booking",
      });

      const hold = updated ?? await dependencies.getHoldById(input.holdId);

      if (hold === null) {
        throw new Error("Booking hold could not be left pending Calendar retry.");
      }

      if (updated !== null) {
        await syncCheckoutOrderCalendarFinalization(dependencies, {
          hold: updated,
          now: input.now,
          status: "paid_calendar_pending",
        });
      }

      return hold;
    },

    async markBooked(input) {
      const updated = await dependencies.transitionHold({
        finalizationStatus: "booked",
        googleEventId: input.googleEventId,
        holdId: input.holdId,
        now: input.now,
        requiredState: "paid_pending_booking",
        status: "booked",
      });

      if (updated === null) {
        const current = await dependencies.getHoldById(input.holdId);

        if (current !== null && current.googleEventId !== null) {
          return current;
        }

        throw new Error("Booking hold could not be marked booked.");
      }

      await syncCheckoutOrderCalendarFinalization(dependencies, {
        calendarEventId: input.googleEventId,
        hold: updated,
        now: input.now,
        status: "booked",
      });

      return updated;
    },

    async markBookingFailed(input) {
      const updated = await dependencies.transitionHold({
        failureMetadata: { error: input.error },
        failureReason: input.error,
        finalizationReason: input.error,
        finalizationStatus: input.state === "manual_followup" ? "manual_review" : "failed",
        holdId: input.holdId,
        now: input.now,
        status: input.state,
      });

      if (updated === null) {
        throw new Error("Booking hold could not be marked for follow-up.");
      }

      await syncCheckoutOrderCalendarFinalization(dependencies, {
        hold: updated,
        now: input.now,
        status: input.state === "manual_followup" ? "manual_review" : "failed",
      });

      return updated;
    },

    async markPaidUnbookableForRebooking(input) {
      const updated = await dependencies.transitionHold({
        failureMetadata: { error: input.reason, manualReview: "rebooking_first" },
        failureReason: input.reason,
        finalizationReason: input.reason,
        finalizationStatus: "paid_unbookable_rebooking_pending",
        holdId: input.holdId,
        manualReviewReason: input.reason,
        manualReviewStatus: "rebooking_pending",
        now: input.now,
        requiredState: "paid_pending_booking",
        status: "paid_unbookable_rebooking_pending",
      });

      const hold = updated ?? await dependencies.getHoldById(input.holdId);

      if (hold === null) {
        throw new Error("Booking hold could not be marked for manual rebooking.");
      }

      if (updated !== null) {
        await syncCheckoutOrderCalendarFinalization(dependencies, {
          hold: updated,
          now: input.now,
          status: "paid_unbookable_rebooking_pending",
        });
      }

      return hold;
    },
  };
}

async function syncCheckoutOrderCalendarFinalization(
  dependencies: AppointmentHoldFinalizerRepositoryDependencies,
  input: {
    calendarEventId?: string;
    hold: BookingHoldRecord;
    now: Date;
    status: CalendarFinalizationStatus;
  },
): Promise<void> {
  if (
    dependencies.updateCheckoutOrderCalendarFinalization === undefined ||
    input.hold.checkoutOrderId === null ||
    input.hold.checkoutOrderId === undefined
  ) {
    return;
  }

  await dependencies.updateCheckoutOrderCalendarFinalization({
    calendarEventId: input.calendarEventId,
    checkoutOrderId: input.hold.checkoutOrderId,
    now: input.now,
    status: input.status,
  });
}

export function createDrizzleBookingFinalizerRepository(): BookingFinalizerRepository {
  return createAppointmentHoldFinalizerRepository({
    async getHoldById(holdId) {
      const [row] = await (await getAppointmentHoldDb())
        .select()
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, holdId))
        .limit(1);

      return row ? toBookingHoldRecord(row) : null;
    },
    transitionHold: transitionAppointmentHold,
    async updateCheckoutOrderCalendarFinalization(input) {
      await updateCheckoutOrderCalendarFinalization(input);
    },
  });
}

export async function createBookingHold(input: {
  bookingType: BookingType;
  customer: BookingHoldCustomerSnapshot;
  offeringId: string;
  offeringSnapshot: Record<string, unknown>;
  repository: BookingHoldRepository;
  selectedEnd: Date;
  selectedStart: Date;
  timezone: string;
  now: Date;
}): Promise<CreateBookingHoldResult> {
  return input.repository.createConflictSafeHold({
    bookingType: input.bookingType,
    customer: input.customer,
    expiresAt: new Date(
      input.now.getTime() + HOLD_DURATION_MINUTES * MINUTE_MS,
    ),
    offeringId: input.offeringId,
    offeringSnapshot: input.offeringSnapshot,
    selectedEnd: input.selectedEnd,
    selectedStart: input.selectedStart,
    timezone: input.timezone,
    now: input.now,
  });
}

export function getActiveHoldBusyEvents(input: {
  holds: BookingHoldRecord[];
  now: Date;
}): CalendarEventWindow[] {
  return input.holds
    .filter((hold) => isActiveHold(hold, input.now))
    .map((hold) => ({
      id: `hold:${hold.id}`,
      title: "Private booking hold",
      start: hold.selectedStart,
      end: hold.selectedEnd,
    }));
}

export function isActiveHold(
  hold: Pick<BookingHoldRecord, "expiresAt" | "state">,
  now: Date,
): boolean {
  return ACTIVE_HOLD_STATES.includes(hold.state) && getActiveHoldExpiresAt(hold) > now;
}

function getActiveHoldExpiresAt(hold: Pick<BookingHoldRecord, "expiresAt" | "state">): Date {
  if (GRACE_PROTECTED_HOLD_STATES.includes(hold.state)) {
    return new Date(hold.expiresAt.getTime() + PAYMENT_SUCCESS_GRACE_MS);
  }

  return hold.expiresAt;
}

export function createDrizzleAppointmentHoldRepository(): AppointmentHoldLifecycleRepository {
  return {
    async createConflictSafeHold(input) {
      return (await getAppointmentHoldDb()).transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.offeringId}))`);

        await tx
          .update(appointmentHolds)
          .set({
            expiredAt: input.now,
            status: "expired",
            updatedAt: input.now,
          })
          .where(
            and(
              eq(appointmentHolds.offeringId, input.offeringId),
              inArray(appointmentHolds.status, ACTIVE_HOLD_STATES_FOR_QUERY),
              isDrizzleExpiredActiveHold(input.now),
              lt(appointmentHolds.selectedStart, input.selectedEnd),
              gt(appointmentHolds.selectedEnd, input.selectedStart),
            ),
          );

        const [activeHold] = await tx
          .select()
          .from(appointmentHolds)
          .where(
            and(
              eq(appointmentHolds.offeringId, input.offeringId),
              inArray(appointmentHolds.status, ACTIVE_HOLD_STATES_FOR_QUERY),
              isDrizzleActiveHold(input.now),
              lt(appointmentHolds.selectedStart, input.selectedEnd),
              gt(appointmentHolds.selectedEnd, input.selectedStart),
            ),
          )
          .limit(1);

        if (activeHold) {
          return {
            ok: false,
            conflictingHoldId: activeHold.id,
            reason: "slot_conflict",
          };
        }

        const [createdHold] = await tx
          .insert(appointmentHolds)
          .values({
            bookingType: input.bookingType,
            createdAt: input.now,
            customerSnapshot: input.customer,
            expiresAt: input.expiresAt,
            offeringId: input.offeringId,
            offeringSnapshot: input.offeringSnapshot,
            publicReference: generateAppointmentHoldReference(),
            selectedEnd: input.selectedEnd,
            selectedStart: input.selectedStart,
            status: "held",
            timezone: input.timezone,
            updatedAt: input.now,
          })
          .returning();

        return { ok: true, hold: toBookingHoldRecord(createdHold) };
      });
    },

    async transitionHold(input) {
      const conditions = [eq(appointmentHolds.id, input.holdId)];

      if (input.requiredState !== undefined) {
        conditions.push(eq(appointmentHolds.status, input.requiredState));
      }

      if (input.expiresAfter !== undefined) {
        conditions.push(gt(appointmentHolds.expiresAt, input.expiresAfter));
      }

      const [updatedHold] = await (await getAppointmentHoldDb())
        .update(appointmentHolds)
        .set(toAppointmentHoldUpdate(input))
        .where(and(...conditions))
        .returning();

      return updatedHold ? toBookingHoldRecord(updatedHold) : null;
    },
  };
}

function isDrizzleActiveHold(now: Date) {
  return or(
    gt(appointmentHolds.expiresAt, now),
    and(
      inArray(appointmentHolds.status, GRACE_PROTECTED_HOLD_STATES_FOR_QUERY),
      gt(sql`${appointmentHolds.expiresAt} + interval '${sql.raw(String(PAYMENT_SUCCESS_GRACE_MINUTES))} minutes'`, now),
    ),
  );
}

function isDrizzleExpiredActiveHold(now: Date) {
  return or(
    and(
      inArray(appointmentHolds.status, GRACE_PROTECTED_HOLD_STATES_FOR_QUERY),
      lte(sql`${appointmentHolds.expiresAt} + interval '${sql.raw(String(PAYMENT_SUCCESS_GRACE_MINUTES))} minutes'`, now),
    ),
    and(
      sql`${appointmentHolds.status} not in ('payment_pending', 'paid_pending_booking')`,
      lte(appointmentHolds.expiresAt, now),
    ),
  );
}

async function getAppointmentHoldDb() {
  const { getPrivateDb } = await import("@/lib/private-db/client");
  return getPrivateDb();
}

async function updateCheckoutOrderCalendarFinalization(input: {
  calendarEventId?: string;
  checkoutOrderId: string;
  now: Date;
  status: CalendarFinalizationStatus;
}): Promise<void> {
  const update: Partial<typeof checkoutOrders.$inferInsert> = {
    calendarFinalizationStatus: input.status,
    updatedAt: input.now,
  };

  if (input.calendarEventId !== undefined) {
    update.calendarEventId = input.calendarEventId;
    update.finalizedAt = input.now;
  }

  await (await getAppointmentHoldDb())
    .update(checkoutOrders)
    .set(update)
    .where(eq(checkoutOrders.id, input.checkoutOrderId));
}

type AppointmentHoldRow = typeof appointmentHolds.$inferSelect;
type AppointmentHoldUpdate = Partial<typeof appointmentHolds.$inferInsert>;

function toBookingHoldRecord(row: AppointmentHoldRow): BookingHoldRecord {
  return {
    bookedAt: row.bookedAt,
    bookingFailedAt: row.bookingFailedAt,
    bookingType: row.bookingType as BookingType,
    checkoutOrderId: row.checkoutOrderId,
    checkoutOrderPublicId: row.checkoutOrderPublicId,
    createdAt: row.createdAt,
    customer: row.customerSnapshot,
    expiresAt: row.expiresAt,
    expiredAt: row.expiredAt,
    failureMetadata: row.failureMetadata,
    failureReason: row.failureReason,
    finalizationReason: row.finalizationReason,
    finalizationStatus: row.finalizationStatus,
    googleEventId: row.googleEventId,
    helcimInvoiceId: row.helcimInvoiceId,
    helcimInvoiceNumber: row.helcimInvoiceNumber,
    helcimTransactionId: row.helcimTransactionId,
    id: row.id,
    manualFollowupAt: row.manualFollowupAt,
    manualReviewReason: row.manualReviewReason,
    manualReviewStatus: row.manualReviewStatus,
    offeringId: row.offeringId,
    offeringSnapshot: row.offeringSnapshot,
    paidAt: row.paidAt,
    payment: null,
    paymentProvider: row.paymentProvider,
    paymentFailedAt: row.paymentFailedAt,
    publicReference: row.publicReference,
    reconciliationMetadata: row.reconciliationMetadata,
    releasedAt: row.releasedAt,
    selectedEnd: row.selectedEnd,
    selectedStart: row.selectedStart,
    squareCheckoutId: row.squareCheckoutId,
    squareOrderId: row.squareOrderId,
    squarePaymentId: row.squarePaymentId,
    squarePaymentLinkId: row.squarePaymentLinkId,
    squarePaymentLinkUrl: row.squarePaymentLinkUrl,
    state: row.status,
    timezone: row.timezone,
    updatedAt: row.updatedAt,
  };
}

function toAppointmentHoldUpdate(input: TransitionAppointmentHoldInput): AppointmentHoldUpdate {
  const update: AppointmentHoldUpdate = {
    status: input.status,
    updatedAt: input.now,
  };

  if (input.checkoutOrderId !== undefined) {
    update.checkoutOrderId = input.checkoutOrderId;
  }

  if (input.checkoutOrderPublicId !== undefined) {
    update.checkoutOrderPublicId = input.checkoutOrderPublicId;
  }

  if (input.helcimInvoiceId !== undefined) {
    update.helcimInvoiceId = input.helcimInvoiceId;
  }

  if (input.helcimInvoiceNumber !== undefined) {
    update.helcimInvoiceNumber = input.helcimInvoiceNumber;
  }

  if (input.helcimTransactionId !== undefined) {
    update.helcimTransactionId = input.helcimTransactionId;
  }

  if (input.googleEventId !== undefined) {
    update.googleEventId = input.googleEventId;
  }

  if (input.paymentProvider !== undefined) {
    update.paymentProvider = input.paymentProvider;
  }

  if (input.squarePaymentLinkId !== undefined) {
    update.squarePaymentLinkId = input.squarePaymentLinkId;
  }

  if (input.squarePaymentLinkUrl !== undefined) {
    update.squarePaymentLinkUrl = input.squarePaymentLinkUrl;
  }

  if (input.squareCheckoutId !== undefined) {
    update.squareCheckoutId = input.squareCheckoutId;
  }

  if (input.squarePaymentId !== undefined) {
    update.squarePaymentId = input.squarePaymentId;
  }

  if (input.squareOrderId !== undefined) {
    update.squareOrderId = input.squareOrderId;
  }

  if (input.finalizationStatus !== undefined) {
    update.finalizationStatus = input.finalizationStatus;
  }

  if (input.finalizationReason !== undefined) {
    update.finalizationReason = input.finalizationReason;
  }

  if (input.manualReviewStatus !== undefined) {
    update.manualReviewStatus = input.manualReviewStatus;
  }

  if (input.manualReviewReason !== undefined) {
    update.manualReviewReason = input.manualReviewReason;
  }

  if (input.failureReason !== undefined) {
    update.failureReason = input.failureReason;
  }

  if (input.failureMetadata !== undefined) {
    update.failureMetadata = input.failureMetadata;
  }

  if (input.reconciliationMetadata !== undefined) {
    update.reconciliationMetadata = input.reconciliationMetadata;
  }

  applyStatusTimestamp(update, input.status, input.now);

  return update;
}

function applyStatusTimestamp(
  update: AppointmentHoldUpdate,
  status: BookingHoldState,
  timestamp: Date,
): void {
  if (status === "released") {
    update.releasedAt = timestamp;
  }

  if (status === "paid_pending_booking") {
    update.paidAt = timestamp;
  }

  if (status === "booked" || status === "manual_rebooked") {
    update.bookedAt = timestamp;
  }

  if (status === "expired") {
    update.expiredAt = timestamp;
  }

  if (status === "payment_failed") {
    update.paymentFailedAt = timestamp;
  }

  if (status === "booking_failed") {
    update.bookingFailedAt = timestamp;
  }

  if (status === "manual_followup" || status === "paid_unbookable_rebooking_pending") {
    update.manualFollowupAt = timestamp;
  }
}

function generateAppointmentHoldReference(): string {
  return `hold_${nanoid(12)}`;
}

function redactHoldMetadata(
  metadata: AppointmentHoldMetadata | undefined,
): AppointmentHoldMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  return redactMetadataValue(metadata) as AppointmentHoldMetadata;
}

function redactMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactMetadataValue);
  }

  if (value !== null && typeof value === "object") {
    const redactedEntries = Object.entries(value as Record<string, unknown>).map(
      ([key, nestedValue]) => [
        key,
        isSensitiveMetadataKey(key) ? "[redacted]" : redactMetadataValue(nestedValue),
      ],
    );

    return Object.fromEntries(redactedEntries);
  }

  return value;
}

function isSensitiveMetadataKey(key: string): boolean {
  return SENSITIVE_METADATA_KEY_PATTERN.test(key);
}
