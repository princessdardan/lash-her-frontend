import { nanoid } from "nanoid";

import { parseBookingCalendarIds } from "@/lib/booking/calendar-ids";
import { isPaidHoldSlotStillAvailable } from "@/lib/booking/finalizer";
import type { BookingHoldRecord } from "@/lib/booking/holds";
import type { BookingSettings } from "@/lib/booking/types";

import type { CardOnFileCalendarFinalizer } from "./service-card-on-file";

interface GoogleCalendarGateway {
  findBookingEventForHold(input: {
    calendarId: string;
    hold: { id: string; selectedEnd: Date; selectedStart: Date };
  }): Promise<string | null>;
  listCalendarEvents(input: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
  }): Promise<import("@/lib/booking/types").CalendarEventWindow[]>;
  insertBookingEvent(input: {
    calendarId: string;
    event: import("googleapis").calendar_v3.Schema$Event;
  }): Promise<string>;
  buildBookingEventPayload: typeof import("@/lib/booking/google-calendar").buildBookingEventPayload;
}

interface HoldsGateway {
  listActiveAppointmentHolds(input: {
    offeringId: string;
    timeMin: Date;
    timeMax: Date;
    now?: Date;
  }): Promise<BookingHoldRecord[]>;
  getActiveHoldBusyEvents(input: {
    holds: BookingHoldRecord[];
    now: Date;
  }): import("@/lib/booking/types").CalendarEventWindow[];
}

interface OperationalStoreGateway {
  acquireCalendarLock(lockId: string, ttlSeconds: number): Promise<boolean>;
  releaseCalendarLock(lockId: string): Promise<void>;
}

interface CardOnFileCalendarFinalizerDependencies {
  getBookingSettings: (options: {
    mode: "published";
    stega: false;
  }) => Promise<BookingSettings | null>;
  googleCalendar: GoogleCalendarGateway;
  holds: HoldsGateway;
  operationalStore: OperationalStoreGateway;
}

export function createCardOnFileCalendarFinalizer(
  dependencies: Partial<CardOnFileCalendarFinalizerDependencies> = {},
): CardOnFileCalendarFinalizer {
  return {
    async finalize({ hold, now }) {
      // Idempotency: if the hold is already correlated with a calendar event,
      // return it without touching the calendar again.
      if (hold.googleEventId !== null && hold.googleEventId.length > 0) {
        return { ok: true, googleEventId: hold.googleEventId };
      }

      const getBookingSettings =
        dependencies.getBookingSettings ??
        (await import("@/data/loaders")).loaders.getBookingSettings;
      const googleCalendar =
        dependencies.googleCalendar ??
        (await import("@/lib/booking/google-calendar"));
      const holds = dependencies.holds ?? (await import("@/lib/booking/holds"));
      const operationalStore =
        dependencies.operationalStore ??
        (await import("@/lib/booking/operational-store"));

      const settings = await getBookingSettings({
        mode: "published",
        stega: false,
      });

      if (settings === null) {
        return {
          ok: false,
          status: "manual_followup",
          error: "Booking calendar is not configured.",
        };
      }

      const calendarIds = parseBookingCalendarIds(settings);

      if (calendarIds.length === 0) {
        return {
          ok: false,
          status: "manual_followup",
          error: "Booking calendar is not configured.",
        };
      }

      // Best-effort recovery: if a previous run created the event but failed
      // before correlating it, locate the event by the hold extended property.
      try {
        for (const calendarId of calendarIds) {
          const eventId = await googleCalendar.findBookingEventForHold({
            calendarId,
            hold,
          });

          if (eventId !== null) {
            return { ok: true, googleEventId: eventId };
          }
        }
      } catch (error) {
        return {
          ok: false,
          status: "manual_followup",
          error: getErrorMessage(error),
        };
      }

      const calendarLockId = nanoid();
      let lockAcquired = false;

      try {
        lockAcquired = await operationalStore.acquireCalendarLock(
          calendarLockId,
          20,
        );

        if (!lockAcquired) {
          return {
            ok: false,
            status: "manual_followup",
            error:
              "Booking calendar is busy. Staff will confirm this appointment manually.",
          };
        }

        // Re-check event correlation under the lock: a concurrent finalizer may
        // have created the event after our pre-lock best-effort search. Reuse it
        // instead of inserting a duplicate.
        for (const calendarId of calendarIds) {
          const eventId = await googleCalendar.findBookingEventForHold({
            calendarId,
            hold,
          });

          if (eventId !== null) {
            return { ok: true, googleEventId: eventId };
          }
        }

        const primaryCalendarId = calendarIds[0];

        const available = await isPaidHoldSlotStillAvailable({
          calendarIds,
          hold,
          holdsModule: holds as typeof import("@/lib/booking/holds"),
          listCalendarEvents: (opts) => googleCalendar.listCalendarEvents(opts),
          now,
          settings,
        });

        if (!available) {
          return {
            ok: false,
            status: "manual_followup",
            error: "The selected appointment time became unavailable.",
          };
        }

        const eventId = await googleCalendar.insertBookingEvent({
          calendarId: primaryCalendarId,
          event: googleCalendar.buildBookingEventPayload({
            answers: [],
            bookingMetadata: {
              holdId: hold.id,
              paymentProvider: "square",
            },
            bookingTypeLabel: getBookingTypeLabel(hold),
            customer: hold.customer,
            end: hold.selectedEnd,
            hold,
            start: hold.selectedStart,
            timezone: hold.timezone,
          }),
        });

        return { ok: true, googleEventId: eventId };
      } catch (error) {
        return {
          ok: false,
          status: "manual_followup",
          error: getErrorMessage(error),
        };
      } finally {
        if (lockAcquired) {
          try {
            await operationalStore.releaseCalendarLock(calendarLockId);
          } catch {
            // Best-effort release; the lock will expire on its own.
          }
        }
      }
    },
  };
}

function getBookingTypeLabel(hold: BookingHoldRecord): string {
  const title = hold.offeringSnapshot.title;

  return typeof title === "string" && title.trim().length > 0
    ? title
    : "Lash appointment";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Calendar booking failed.";
}
