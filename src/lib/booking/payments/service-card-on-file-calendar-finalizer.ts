import { nanoid } from "nanoid";

import { resolveBookingModelVersion } from "@/lib/booking/booking-model-version";
import { parseBookingCalendarIds } from "@/lib/booking/calendar-ids";
import { isPaidHoldSlotStillAvailable } from "@/lib/booking/finalizer";
import type { BookingHoldRecord } from "@/lib/booking/holds";
import type { BookingSettings } from "@/lib/booking/types";

import type { CardOnFileCalendarFinalizer } from "./service-card-on-file";

interface GoogleCalendarGateway {
  findConnectionBookingEventForHold?(input: {
    calendarId: string;
    connectionId: string;
    hold: { id: string; selectedEnd: Date; selectedStart: Date };
  }): Promise<string | null>;
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
  insertConnectionBookingEvent?(input: {
    calendarId: string;
    connectionId: string;
    event: import("googleapis").calendar_v3.Schema$Event;
  }): Promise<string>;
  listConnectionCalendarEvents?(input: {
    calendarId: string;
    connectionId: string;
    timeMin: Date;
    timeMax: Date;
  }): Promise<import("@/lib/booking/types").CalendarEventWindow[]>;
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
  acquireScopedBookingLock?(input: {
    key: string;
    lockId: string;
    ttlSeconds: number;
  }): Promise<boolean>;
  releaseCalendarLock(lockId: string): Promise<void>;
  releaseScopedBookingLock?(input: {
    key: string;
    lockId: string;
  }): Promise<void>;
}

interface CardOnFileCalendarFinalizerDependencies {
  getBookingSettings: (options: {
    mode: "published";
    stega: false;
  }) => Promise<BookingSettings | null>;
  googleCalendar: GoogleCalendarGateway;
  holds: HoldsGateway;
  getOperationalCalendarRouting: typeof import("@/lib/private-db/operational-calendar-routing-repository").getOperationalAppointmentCalendarRouting;
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
      const operationalStore =
        dependencies.operationalStore ??
        (await import("@/lib/booking/operational-store"));

      if (resolveBookingModelVersion(hold) === 2) {
        const getOperationalCalendarRouting =
          dependencies.getOperationalCalendarRouting ??
          (
            await import("@/lib/private-db/operational-calendar-routing-repository")
          ).getOperationalAppointmentCalendarRouting;

        return finalizeOperationalCalendarBooking({
          getOperationalCalendarRouting,
          googleCalendar,
          hold,
          now,
          operationalStore,
        });
      }

      const holds = dependencies.holds ?? (await import("@/lib/booking/holds"));

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

async function finalizeOperationalCalendarBooking(input: {
  getOperationalCalendarRouting: CardOnFileCalendarFinalizerDependencies["getOperationalCalendarRouting"];
  googleCalendar: GoogleCalendarGateway;
  hold: BookingHoldRecord;
  now: Date;
  operationalStore: OperationalStoreGateway;
}): ReturnType<CardOnFileCalendarFinalizer["finalize"]> {
  const findEvent = input.googleCalendar.findConnectionBookingEventForHold;
  const listEvents = input.googleCalendar.listConnectionCalendarEvents;
  const insertEvent = input.googleCalendar.insertConnectionBookingEvent;
  const acquireLock = input.operationalStore.acquireScopedBookingLock;
  const releaseLock = input.operationalStore.releaseScopedBookingLock;

  if (
    findEvent === undefined ||
    listEvents === undefined ||
    insertEvent === undefined ||
    acquireLock === undefined ||
    releaseLock === undefined
  ) {
    return {
      ok: false,
      status: "manual_followup",
      error: "Operational Calendar finalization is not configured.",
    };
  }

  try {
    const routing = await input.getOperationalCalendarRouting(input.hold.id);
    const existingEventId = await findEvent({
      calendarId: routing.writeCalendar.calendarId,
      connectionId: routing.writeCalendar.connectionId,
      hold: input.hold,
    });
    if (existingEventId !== null) {
      return { ok: true, googleEventId: existingEventId };
    }

    const lockId = nanoid();
    const lockKey = `calendar-assignment:${routing.writeCalendar.assignmentId}`;
    const acquired = await acquireLock({
      key: lockKey,
      lockId,
      ttlSeconds: 20,
    });
    if (!acquired) {
      return {
        ok: false,
        status: "manual_followup",
        error:
          "The assigned booking calendar is busy. Staff will confirm this appointment manually.",
      };
    }

    try {
      const correlatedEventId = await findEvent({
        calendarId: routing.writeCalendar.calendarId,
        connectionId: routing.writeCalendar.connectionId,
        hold: input.hold,
      });
      if (correlatedEventId !== null) {
        return { ok: true, googleEventId: correlatedEventId };
      }

      const occupiedStart =
        input.hold.occupiedStart ?? input.hold.selectedStart;
      const occupiedEnd = input.hold.occupiedEnd ?? input.hold.selectedEnd;
      const busyWindows = (
        await Promise.all(
          routing.busyCalendars.map((calendar) =>
            listEvents({
              calendarId: calendar.calendarId,
              connectionId: calendar.connectionId,
              timeMax: occupiedEnd,
              timeMin: occupiedStart,
            }),
          ),
        )
      ).flat();
      if (
        busyWindows.some(
          (window) => window.start < occupiedEnd && window.end > occupiedStart,
        )
      ) {
        return {
          ok: false,
          status: "manual_followup",
          error:
            "The selected appointment time became unavailable on an assigned calendar.",
        };
      }

      const eventId = await insertEvent({
        calendarId: routing.writeCalendar.calendarId,
        connectionId: routing.writeCalendar.connectionId,
        event: input.googleCalendar.buildBookingEventPayload({
          answers: readCalendarAnswers(input.hold.offeringSnapshot.answers),
          bookingMetadata: {
            checkoutOrderId: input.hold.checkoutOrderId ?? undefined,
            checkoutOrderPublicId:
              input.hold.checkoutOrderPublicId ?? undefined,
            holdId: input.hold.id,
            paymentProvider: "square",
          },
          bookingTypeLabel: getBookingTypeLabel(input.hold),
          customer: input.hold.customer,
          end: input.hold.selectedEnd,
          hold: input.hold,
          start: input.hold.selectedStart,
          timezone: input.hold.timezone,
        }),
      });

      return { ok: true, googleEventId: eventId };
    } finally {
      try {
        await releaseLock({ key: lockKey, lockId });
      } catch {
        // Best-effort release; the scoped lock expires and event correlation
        // makes the retry idempotent.
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: "manual_followup",
      error: getErrorMessage(error),
    };
  }
}

function getBookingTypeLabel(hold: BookingHoldRecord): string {
  const title = hold.offeringSnapshot.title;

  return typeof title === "string" && title.trim().length > 0
    ? title
    : "Lash appointment";
}

function readCalendarAnswers(
  value: unknown,
): Array<{ answer: string; questionLabel: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((answer) => {
    if (answer === null || typeof answer !== "object") {
      return [];
    }

    const record = answer as Record<string, unknown>;
    const questionLabel =
      typeof record.questionLabel === "string"
        ? record.questionLabel.trim()
        : typeof record.questionId === "string"
          ? record.questionId.trim()
          : "";
    const answerText =
      typeof record.answer === "string" ? record.answer.trim() : "";

    return questionLabel && answerText
      ? [{ answer: answerText, questionLabel }]
      : [];
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Calendar booking failed.";
}
