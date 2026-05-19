import {
  and,
  eq,
  gt,
  inArray,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  appointmentHolds,
  type AppointmentHoldMetadata,
} from "@/lib/private-db/schema";
import type { BookingFinalizerRepository } from "./finalizer";

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
  source: "client_validation" | "webhook";
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
  googleEventId: string | null;
  helcimInvoiceId?: number | null;
  helcimInvoiceNumber?: string | null;
  helcimTransactionId?: string | null;
  id: string;
  manualFollowupAt?: Date | null;
  offeringId: string;
  offeringSnapshot: Record<string, unknown>;
  paidAt?: Date | null;
  payment: BookingHoldPaymentSnapshot | null;
  paymentFailedAt?: Date | null;
  publicReference: string;
  reconciliationMetadata?: AppointmentHoldMetadata | null;
  releasedAt?: Date | null;
  selectedEnd: Date;
  selectedStart: Date;
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
  googleEventId?: string;
  helcimInvoiceId?: number;
  helcimInvoiceNumber?: string;
  helcimTransactionId?: string;
  holdId: string;
  now: Date;
  reconciliationMetadata?: AppointmentHoldMetadata;
  requiredState?: BookingHoldState;
  expiresAfter?: Date;
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
const ACTIVE_HOLD_STATES_FOR_QUERY = [...ACTIVE_HOLD_STATES];
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
        gt(appointmentHolds.expiresAt, now),
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

export interface AppointmentHoldFinalizerRepositoryDependencies {
  getHoldById(holdId: string): Promise<BookingHoldRecord | null>;
  transitionHold(input: Omit<TransitionAppointmentHoldInput, "now"> & { now?: Date }): Promise<BookingHoldRecord | null>;
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

      return updated;
    },

    async markBooked(input) {
      const updated = await dependencies.transitionHold({
        googleEventId: input.googleEventId,
        holdId: input.holdId,
        now: input.now,
        status: "booked",
      });

      if (updated === null) {
        throw new Error("Booking hold could not be marked booked.");
      }

      return updated;
    },

    async markBookingFailed(input) {
      const updated = await dependencies.transitionHold({
        failureMetadata: { error: input.error },
        failureReason: input.error,
        holdId: input.holdId,
        now: input.now,
        status: input.state,
      });

      if (updated === null) {
        throw new Error("Booking hold could not be marked for follow-up.");
      }

      return updated;
    },
  };
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
  return ACTIVE_HOLD_STATES.includes(hold.state) && hold.expiresAt > now;
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
              lte(appointmentHolds.expiresAt, input.now),
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
              gt(appointmentHolds.expiresAt, input.now),
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

async function getAppointmentHoldDb() {
  const { getPrivateDb } = await import("@/lib/private-db/client");
  return getPrivateDb();
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
    googleEventId: row.googleEventId,
    helcimInvoiceId: row.helcimInvoiceId,
    helcimInvoiceNumber: row.helcimInvoiceNumber,
    helcimTransactionId: row.helcimTransactionId,
    id: row.id,
    manualFollowupAt: row.manualFollowupAt,
    offeringId: row.offeringId,
    offeringSnapshot: row.offeringSnapshot,
    paidAt: row.paidAt,
    payment: null,
    paymentFailedAt: row.paymentFailedAt,
    publicReference: row.publicReference,
    reconciliationMetadata: row.reconciliationMetadata,
    releasedAt: row.releasedAt,
    selectedEnd: row.selectedEnd,
    selectedStart: row.selectedStart,
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

  if (status === "booked") {
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

  if (status === "manual_followup") {
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
