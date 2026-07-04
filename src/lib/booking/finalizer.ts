import { nanoid } from "nanoid";

import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";
import { isSlotAvailable } from "./availability";
import { parseBookingCalendarIds } from "./calendar-ids";
import type { BookingHoldRecord, BookingHoldState } from "./holds";
import { PAYMENT_SUCCESS_GRACE_MINUTES } from "./payment-policy";
import type {
  BookingSettings,
  BookingTypeConfig,
  CalendarEventWindow,
} from "./types";
import { buildAvailabilityWindowsFromHours } from "./schedule-windows";

export { PAYMENT_SUCCESS_GRACE_MINUTES };

const MINUTE_MS = 60_000;

export interface BookingFinalizerPaymentInput {
  amountCents: number;
  currency: string;
  source: "client_validation" | "return" | "webhook";
  transactionId: string;
}

export interface BookingFinalizerRepository {
  lockHold(holdId: string): Promise<BookingHoldRecord | null>;
  recordPaidPendingBooking(input: {
    holdId: string;
    now: Date;
    payment: BookingFinalizerPaymentInput;
  }): Promise<BookingHoldRecord>;
  recordCalendarRetryPending(input: {
    error: string;
    holdId: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markBooked(input: {
    googleEventId: string;
    holdId: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markBookingFailed(input: {
    error: string;
    holdId: string;
    now: Date;
    state: Extract<BookingHoldState, "booking_failed" | "manual_followup">;
  }): Promise<BookingHoldRecord>;
  markPaidUnbookableForRebooking(input: {
    reason: string;
    holdId: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
}

export interface BookingCalendarGateway {
  findExistingEventForHold(hold: BookingHoldRecord): Promise<string | null>;
  insertBookingEvent(hold: BookingHoldRecord): Promise<string>;
}

export class BookingManualFollowupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingManualFollowupError";
  }
}

export class BookingRebookingRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingRebookingRequiredError";
  }
}

export type FinalizePaidBookingResult =
  | { ok: true; eventId: string; status: "booked" }
  | {
      ok: false;
      error: string;
      status:
        | "booking_failed"
        | "finalization_pending"
        | "hold_not_found"
        | "manual_followup"
        | "paid_unbookable_rebooking_pending";
    };

/**
 * Returns true when a failed finalization status represents a condition that
 * requires staff intervention and an admin alert. Transient states such as
 * `finalization_pending` or `hold_not_found` can resolve on a later retry and
 * must not trigger "action required" emails.
 */
export function isBookingFinalizationStatusAlertable(
  status: FinalizePaidBookingResult["status"],
): boolean {
  return (
    status === "manual_followup" ||
    status === "paid_unbookable_rebooking_pending"
  );
}

export interface AppointmentFinalizerOrderInput {
  _id: string;
  amount: number;
  currency: string;
  orderId: string;
  purpose: CheckoutOrderPurpose;
}

export interface BookingFinalizationLock {
  acquire(input: {
    holdId: string;
    lockId: string;
    ttlSeconds: number;
  }): Promise<boolean>;
  release(input: { holdId: string; lockId: string }): Promise<void>;
}

export interface FinalizeAppointmentPaymentForOrderInput {
  now?: Date;
  order: AppointmentFinalizerOrderInput;
  source: BookingFinalizerPaymentInput["source"];
  transactionId: string;
}

export type FinalizeAppointmentPaymentForOrderResult =
  FinalizePaidBookingResult;

export async function finalizeAppointmentPaymentForOrder(
  input: FinalizeAppointmentPaymentForOrderInput,
): Promise<FinalizeAppointmentPaymentForOrderResult> {
  const [holdsModule, googleCalendarModule, loadersModule] = await Promise.all([
    import("./holds"),
    import("./google-calendar"),
    import("@/data/loaders"),
  ]);
  const hold = await holdsModule.getAppointmentHoldByCheckoutOrder({
    checkoutOrderId: input.order._id,
    checkoutOrderPublicId: input.order.orderId,
  });

  if (hold === null) {
    return {
      ok: false,
      error: "Booking hold was not found.",
      status: "hold_not_found",
    };
  }

  const operationalStoreModule = await import("./operational-store");

  return finalizeAppointmentPaymentWithLock({
    finalize: () =>
      finalizePaidBooking({
        calendar: {
          async findExistingEventForHold(existingHold) {
            if (existingHold.googleEventId !== null) {
              return existingHold.googleEventId;
            }

            const settings = await loadersModule.loaders.getBookingSettings({
              mode: "published",
              stega: false,
            });

            if (settings === null) {
              throw new BookingManualFollowupError(
                "Booking calendar is not configured.",
              );
            }

            const calendarIds = parseBookingCalendarIds(settings);

            if (calendarIds.length === 0) {
              throw new BookingManualFollowupError(
                "Booking calendar is not configured.",
              );
            }

            for (const calendarId of calendarIds) {
              const eventId =
                await googleCalendarModule.findBookingEventForHold({
                  calendarId,
                  hold: existingHold,
                });

              if (eventId !== null) {
                return eventId;
              }
            }

            return null;
          },
          async insertBookingEvent(paidHold) {
            const calendarLockId = nanoid();
            const calendarLockAcquired =
              await operationalStoreModule.acquireCalendarLock(
                calendarLockId,
                20,
              );

            if (!calendarLockAcquired) {
              throw new BookingManualFollowupError(
                "Booking calendar is busy. Staff will confirm this appointment manually.",
              );
            }

            try {
              const settings = await getBookingSettingsOrThrow(() =>
                loadersModule.loaders.getBookingSettings({
                  mode: "published",
                  stega: false,
                }),
              );
              const calendarIds = parseBookingCalendarIds(settings);

              if (calendarIds.length === 0) {
                throw new BookingManualFollowupError(
                  "Booking calendar is not configured.",
                );
              }

              const primaryCalendarId = calendarIds[0];

              const available = await isPaidHoldSlotStillAvailable({
                calendarIds,
                listCalendarEvents: (opts) =>
                  googleCalendarModule.listCalendarEvents(opts),
                hold: paidHold,
                holdsModule,
                now: input.now ?? new Date(),
                settings,
              });

              if (!available) {
                throw new BookingRebookingRequiredError(
                  "The selected appointment time became unavailable after payment.",
                );
              }

              return googleCalendarModule.insertBookingEvent({
                calendarId: primaryCalendarId,
                event: googleCalendarModule.buildBookingEventPayload({
                  answers: [],
                  bookingMetadata: {
                    checkoutOrderId: paidHold.checkoutOrderId ?? undefined,
                    checkoutOrderPublicId:
                      paidHold.checkoutOrderPublicId ?? undefined,
                    holdId: paidHold.id,
                    paymentProvider: paidHold.paymentProvider ?? "helcim",
                  },
                  bookingTypeLabel: getBookingTypeLabel(paidHold),
                  customer: paidHold.customer,
                  end: paidHold.selectedEnd,
                  hold: paidHold,
                  start: paidHold.selectedStart,
                  timezone: paidHold.timezone,
                }),
              });
            } finally {
              await operationalStoreModule.releaseCalendarLock(calendarLockId);
            }
          },
        },
        holdId: hold.id,
        now: input.now ?? new Date(),
        payment: {
          amountCents: Math.round(input.order.amount * 100),
          currency: input.order.currency,
          source: input.source,
          transactionId: input.transactionId,
        },
        repository: holdsModule.createDrizzleBookingFinalizerRepository(),
      }),
    holdId: hold.id,
    lock: {
      acquire: ({ holdId, lockId, ttlSeconds }) =>
        operationalStoreModule.acquireScopedBookingLock({
          key: `appointment-finalizer:${holdId}`,
          lockId,
          ttlSeconds,
        }),
      release: ({ holdId, lockId }) =>
        operationalStoreModule.releaseScopedBookingLock({
          key: `appointment-finalizer:${holdId}`,
          lockId,
        }),
    },
  });
}

export async function finalizeAppointmentPaymentWithLock(input: {
  finalize: () => Promise<FinalizePaidBookingResult>;
  holdId: string;
  lock: BookingFinalizationLock;
}): Promise<FinalizePaidBookingResult> {
  const lockId = nanoid();
  let lockAcquired = false;

  try {
    lockAcquired = await input.lock.acquire({
      holdId: input.holdId,
      lockId,
      ttlSeconds: 90,
    });
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      status: "manual_followup",
    };
  }

  if (!lockAcquired) {
    return {
      ok: false,
      error: "Booking finalization is already in progress.",
      status: "finalization_pending",
    };
  }

  try {
    return await input.finalize();
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      status: "manual_followup",
    };
  } finally {
    try {
      await input.lock.release({ holdId: input.holdId, lockId });
    } catch (error) {
      console.warn("[booking-finalizer] Scoped lock release failed", {
        error: getErrorMessage(error),
        holdId: input.holdId,
      });
    }
  }
}

async function getBookingSettingsOrThrow(
  getBookingSettings: () => Promise<BookingSettings | null>,
): Promise<BookingSettings> {
  const settings = await getBookingSettings();

  if (settings === null) {
    throw new BookingManualFollowupError("Booking calendar is not configured.");
  }

  return settings;
}

export async function isPaidHoldSlotStillAvailable(input: {
  calendarIds: string[];
  listCalendarEvents: (opts: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
  }) => Promise<CalendarEventWindow[]>;
  hold: BookingHoldRecord;
  holdsModule: typeof import("./holds");
  now: Date;
  settings: BookingSettings;
}): Promise<boolean> {
  const bookingTypeConfig = toPaidHoldBookingTypeConfig(
    input.settings,
    input.hold,
  );

  const [calendarEventsArrays, activeHolds] = await Promise.all([
    Promise.all(
      input.calendarIds.map((calendarId) =>
        input.listCalendarEvents({
          calendarId,
          timeMin: input.now,
          timeMax: input.hold.selectedEnd,
        }),
      ),
    ),
    input.holdsModule.listActiveAppointmentHolds({
      offeringId: input.hold.offeringId,
      timeMin: input.now,
      timeMax: input.hold.selectedEnd,
      now: input.now,
    }),
  ]);
  const availabilityWindows = buildAvailabilityWindowsFromHours({
    horizonEnd: input.hold.selectedEnd,
    now: input.now,
    settings: input.settings,
  });
  const busyEvents = calendarEventsArrays.flat();
  const activeHoldBusyEvents = input.holdsModule.getActiveHoldBusyEvents({
    holds: activeHolds.filter((hold) => hold.id !== input.hold.id),
    now: input.now,
  });

  return isSlotAvailable({
    bookingType: bookingTypeConfig,
    requestedStart: input.hold.selectedStart,
    availabilityWindows,
    busyEvents: [...busyEvents, ...activeHoldBusyEvents],
    now: input.now,
    minimumLeadTimeHours: 0,
    horizonEnd: input.hold.selectedEnd,
  });
}
function toPaidHoldBookingTypeConfig(
  settings: BookingSettings,
  hold: BookingHoldRecord,
): BookingTypeConfig {
  return {
    type: hold.bookingType,
    label: getBookingTypeLabel(hold),
    description:
      getSnapshotString(hold.offeringSnapshot.description) ??
      "Lash appointment",
    durationMinutes:
      getSnapshotNumber(hold.offeringSnapshot.durationMinutes) ??
      getHoldDurationMinutes(hold),
    slotIntervalMinutes: settings.slotIntervalMinutes,
    bufferMinutes: settings.bufferMinutes,
    questions: settings.intakeQuestions,
  };
}

function getSnapshotString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function getSnapshotNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getHoldDurationMinutes(hold: BookingHoldRecord): number {
  return Math.max(
    1,
    Math.round(
      (hold.selectedEnd.getTime() - hold.selectedStart.getTime()) / MINUTE_MS,
    ),
  );
}

export function isAppointmentCheckoutPurpose(
  purpose: CheckoutOrderPurpose,
): purpose is Extract<
  CheckoutOrderPurpose,
  "appointment_deposit" | "appointment_full" | "appointment_custom_partial"
> {
  return (
    purpose === "appointment_deposit" ||
    purpose === "appointment_full" ||
    purpose === "appointment_custom_partial"
  );
}

function getBookingTypeLabel(hold: BookingHoldRecord): string {
  const title = hold.offeringSnapshot.title;

  return typeof title === "string" && title.trim().length > 0
    ? title
    : "Lash appointment";
}

export async function finalizePaidBooking(input: {
  calendar: BookingCalendarGateway;
  holdId: string;
  now: Date;
  payment: BookingFinalizerPaymentInput;
  repository: BookingFinalizerRepository;
}): Promise<FinalizePaidBookingResult> {
  const lockedHold = await input.repository.lockHold(input.holdId);

  if (lockedHold === null) {
    return {
      ok: false,
      error: "Booking hold was not found.",
      status: "hold_not_found",
    };
  }

  if (isCalendarCorrelatedHold(lockedHold)) {
    return {
      ok: true,
      eventId: lockedHold.googleEventId,
      status: "booked",
    };
  }

  if (lockedHold.state === "paid_unbookable_rebooking_pending") {
    return {
      ok: false,
      error:
        lockedHold.manualReviewReason ??
        lockedHold.failureReason ??
        "Paid booking requires manual rebooking review.",
      status: "paid_unbookable_rebooking_pending",
    };
  }

  if (!isPaidBookingFinalizableState(lockedHold.state)) {
    return {
      ok: false,
      error: `Booking hold is not eligible for Calendar finalization from ${lockedHold.state}.`,
      status: "manual_followup",
    };
  }

  const paidHold =
    lockedHold.state === "paid_pending_booking"
      ? lockedHold
      : await input.repository.recordPaidPendingBooking({
          holdId: lockedHold.id,
          now: input.now,
          payment: input.payment,
        });

  return finalizePaidCalendarBooking({
    calendar: input.calendar,
    now: input.now,
    paidHold,
    repository: input.repository,
  });
}

async function finalizePaidCalendarBooking(input: {
  calendar: BookingCalendarGateway;
  now: Date;
  paidHold: BookingHoldRecord;
  repository: BookingFinalizerRepository;
}): Promise<FinalizePaidBookingResult> {
  try {
    const existingEventId =
      input.paidHold.googleEventId ??
      (await input.calendar.findExistingEventForHold(input.paidHold));

    if (existingEventId !== null) {
      const bookedHold = await input.repository.markBooked({
        googleEventId: existingEventId,
        holdId: input.paidHold.id,
        now: input.now,
      });

      return {
        ok: true,
        eventId: bookedHold.googleEventId ?? existingEventId,
        status: "booked",
      };
    }

    if (isPastPaymentSuccessGrace({ hold: input.paidHold, now: input.now })) {
      return markPaidUnbookableForRebooking({
        holdId: input.paidHold.id,
        now: input.now,
        reason: "Payment arrived after the booking hold grace window.",
        repository: input.repository,
      });
    }

    const eventId = await input.calendar.insertBookingEvent(input.paidHold);
    const bookedHold = await input.repository.markBooked({
      googleEventId: eventId,
      holdId: input.paidHold.id,
      now: input.now,
    });

    return {
      ok: true,
      eventId: bookedHold.googleEventId ?? eventId,
      status: "booked",
    };
  } catch (error) {
    const message = getErrorMessage(error);

    if (error instanceof BookingRebookingRequiredError) {
      return markPaidUnbookableForRebooking({
        holdId: input.paidHold.id,
        now: input.now,
        reason: message,
        repository: input.repository,
      });
    }

    if (error instanceof BookingManualFollowupError) {
      await input.repository.markBookingFailed({
        error: message,
        holdId: input.paidHold.id,
        now: input.now,
        state: "manual_followup",
      });

      return { ok: false, error: message, status: "manual_followup" };
    }

    const retryHold = await input.repository.recordCalendarRetryPending({
      error: message,
      holdId: input.paidHold.id,
      now: input.now,
    });

    if (isCalendarCorrelatedHold(retryHold)) {
      return {
        ok: true,
        eventId: retryHold.googleEventId,
        status: "booked",
      };
    }

    return { ok: false, error: message, status: "finalization_pending" };
  }
}

async function markPaidUnbookableForRebooking(input: {
  holdId: string;
  now: Date;
  reason: string;
  repository: BookingFinalizerRepository;
}): Promise<FinalizePaidBookingResult> {
  const updatedHold = await input.repository.markPaidUnbookableForRebooking({
    holdId: input.holdId,
    now: input.now,
    reason: input.reason,
  });

  if (isCalendarCorrelatedHold(updatedHold)) {
    return {
      ok: true,
      eventId: updatedHold.googleEventId,
      status: "booked",
    };
  }

  return {
    ok: false,
    error: input.reason,
    status: "paid_unbookable_rebooking_pending",
  };
}

function isCalendarCorrelatedHold(
  hold: BookingHoldRecord,
): hold is BookingHoldRecord & { googleEventId: string } {
  return (
    hold.googleEventId !== null &&
    (hold.state === "booked" || hold.state === "manual_rebooked")
  );
}

function isPaidBookingFinalizableState(state: BookingHoldState): boolean {
  return (
    state === "held" ||
    state === "payment_pending" ||
    state === "paid_pending_booking" ||
    state === "expired" ||
    state === "booking_failed" ||
    state === "manual_followup"
  );
}

function isPastPaymentSuccessGrace(input: {
  hold: BookingHoldRecord;
  now: Date;
}): boolean {
  const graceExpiresAt = new Date(
    input.hold.expiresAt.getTime() + PAYMENT_SUCCESS_GRACE_MINUTES * MINUTE_MS,
  );

  return input.now.getTime() > graceExpiresAt.getTime();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Calendar booking failed.";
}
