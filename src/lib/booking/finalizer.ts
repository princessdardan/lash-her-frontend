import { nanoid } from "nanoid";

import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";
import type { BookingHoldRecord, BookingHoldState } from "./holds";

export const PAYMENT_SUCCESS_GRACE_MINUTES = 5;

const MINUTE_MS = 60_000;

export interface BookingFinalizerPaymentInput {
  amountCents: number;
  currency: string;
  source: "client_validation" | "webhook";
  transactionId: string;
}

export interface BookingFinalizerRepository {
  lockHold(holdId: string): Promise<BookingHoldRecord | null>;
  recordPaidPendingBooking(input: {
    holdId: string;
    now: Date;
    payment: BookingFinalizerPaymentInput;
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

export type FinalizePaidBookingResult =
  | { ok: true; eventId: string; status: "booked" }
  | {
      ok: false;
      error: string;
      status: "booking_failed" | "hold_not_found" | "manual_followup";
    };

export interface AppointmentFinalizerOrderInput {
  _id: string;
  amount: number;
  currency: string;
  orderId: string;
  purpose: CheckoutOrderPurpose;
}

export interface BookingFinalizationLock {
  acquire(input: { holdId: string; lockId: string; ttlSeconds: number }): Promise<boolean>;
  release(input: { holdId: string; lockId: string }): Promise<void>;
}

export interface FinalizeAppointmentPaymentForOrderInput {
  now?: Date;
  order: AppointmentFinalizerOrderInput;
  source: BookingFinalizerPaymentInput["source"];
  transactionId: string;
}

export type FinalizeAppointmentPaymentForOrderResult = FinalizePaidBookingResult;

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

  async function getCalendarId(): Promise<string> {
    const settings = await loadersModule.loaders.getBookingSettings();

    if (settings === null || settings.calendarId.trim().length === 0) {
      throw new BookingManualFollowupError("Booking calendar is not configured.");
    }

    return settings.calendarId;
  }

  return finalizeAppointmentPaymentWithLock({
    finalize: () => finalizePaidBooking({
      calendar: {
        async findExistingEventForHold(existingHold) {
          if (existingHold.googleEventId !== null) {
            return existingHold.googleEventId;
          }

          return googleCalendarModule.findBookingEventForHold({
            calendarId: await getCalendarId(),
            hold: existingHold,
          });
        },
        async insertBookingEvent(paidHold) {
          return googleCalendarModule.insertBookingEvent({
            calendarId: await getCalendarId(),
            event: googleCalendarModule.buildBookingEventPayload({
              answers: [],
              bookingMetadata: { holdId: paidHold.id },
              bookingTypeLabel: getBookingTypeLabel(paidHold),
              customer: paidHold.customer,
              end: paidHold.selectedEnd,
              start: paidHold.selectedStart,
              timezone: paidHold.timezone,
            }),
          });
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
      acquire: ({ holdId, lockId, ttlSeconds }) => operationalStoreModule.acquireScopedBookingLock({
        key: `appointment-finalizer:${holdId}`,
        lockId,
        ttlSeconds,
      }),
      release: ({ holdId, lockId }) => operationalStoreModule.releaseScopedBookingLock({
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
      status: "manual_followup",
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

export function isAppointmentCheckoutPurpose(
  purpose: CheckoutOrderPurpose,
): purpose is Extract<CheckoutOrderPurpose, "appointment_deposit" | "appointment_full"> {
  return purpose === "appointment_deposit" || purpose === "appointment_full";
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

  if (lockedHold.state === "booked" && lockedHold.googleEventId !== null) {
    return {
      ok: true,
      eventId: lockedHold.googleEventId,
      status: "booked",
    };
  }

  if (lockedHold.state === "paid_pending_booking" && lockedHold.googleEventId === null) {
    try {
      const existingEventId = await input.calendar.findExistingEventForHold(lockedHold);

      if (existingEventId !== null) {
        await input.repository.markBooked({
          googleEventId: existingEventId,
          holdId: lockedHold.id,
          now: input.now,
        });

        return { ok: true, eventId: existingEventId, status: "booked" };
      }

      const message = "Paid booking requires manual follow-up because finalization did not complete.";
      await input.repository.markBookingFailed({
        error: message,
        holdId: lockedHold.id,
        now: input.now,
        state: "manual_followup",
      });

      return {
        ok: false,
        error: message,
        status: "manual_followup",
      };
    } catch (error) {
      const message = getErrorMessage(error);
      const state = error instanceof BookingManualFollowupError
        ? "manual_followup"
        : "booking_failed";

      await input.repository.markBookingFailed({
        error: message,
        holdId: lockedHold.id,
        now: input.now,
        state,
      });

      return { ok: false, error: message, status: state };
    }
  }

  const paidHold = await input.repository.recordPaidPendingBooking({
    holdId: lockedHold.id,
    now: input.now,
    payment: input.payment,
  });

  if (isPastPaymentSuccessGrace({ hold: paidHold, now: input.now })) {
    const message = "Payment arrived after the booking hold grace window.";
    await input.repository.markBookingFailed({
      error: message,
      holdId: paidHold.id,
      now: input.now,
      state: "manual_followup",
    });

    return { ok: false, error: message, status: "manual_followup" };
  }

  try {
    const existingEventId = paidHold.googleEventId ??
      await input.calendar.findExistingEventForHold(paidHold);

    if (existingEventId !== null) {
      await input.repository.markBooked({
        googleEventId: existingEventId,
        holdId: paidHold.id,
        now: input.now,
      });

      return { ok: true, eventId: existingEventId, status: "booked" };
    }

    const eventId = await input.calendar.insertBookingEvent(paidHold);
    await input.repository.markBooked({
      googleEventId: eventId,
      holdId: paidHold.id,
      now: input.now,
    });

    return { ok: true, eventId, status: "booked" };
  } catch (error) {
    const message = getErrorMessage(error);
    const state = error instanceof BookingManualFollowupError
      ? "manual_followup"
      : "booking_failed";

    await input.repository.markBookingFailed({
      error: message,
      holdId: paidHold.id,
      now: input.now,
      state,
    });

    return { ok: false, error: message, status: state };
  }
}

function isPastPaymentSuccessGrace(input: { hold: BookingHoldRecord; now: Date }): boolean {
  const graceExpiresAt = new Date(
    input.hold.expiresAt.getTime() + PAYMENT_SUCCESS_GRACE_MINUTES * MINUTE_MS,
  );

  return input.now.getTime() > graceExpiresAt.getTime();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Calendar booking failed.";
}
