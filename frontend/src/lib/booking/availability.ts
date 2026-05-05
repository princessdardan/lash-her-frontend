import type { BookingSlot, BookingTypeConfig, CalendarEventWindow } from "./types";

export interface BuildBookingSlotsInput {
  bookingType: BookingTypeConfig;
  availabilityWindows: CalendarEventWindow[];
  busyEvents: CalendarEventWindow[];
  now: Date;
  minimumLeadTimeHours: number;
  horizonEnd: Date;
}

export interface IsSlotAvailableInput extends BuildBookingSlotsInput {
  requestedStart: Date;
}

interface TimeWindow {
  startMs: number;
  endMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function buildBookingSlots(input: BuildBookingSlotsInput): BookingSlot[] {
  const { bookingType, availabilityWindows } = input;
  const intervalMs = bookingType.slotIntervalMinutes * MINUTE_MS;
  const durationMs = bookingType.durationMinutes * MINUTE_MS;
  const slots: BookingSlot[] = [];

  for (const window of availabilityWindows) {
    const windowStartMs = window.start.getTime();
    const windowEndMs = window.end.getTime();

    for (
      let slotStartMs = windowStartMs;
      slotStartMs + durationMs <= windowEndMs;
      slotStartMs += intervalMs
    ) {
      const start = new Date(slotStartMs);

      if (
        isSlotAvailable({
          bookingType,
          requestedStart: start,
          availabilityWindows: [window],
          busyEvents: input.busyEvents,
          now: input.now,
          minimumLeadTimeHours: input.minimumLeadTimeHours,
          horizonEnd: input.horizonEnd,
        })
      ) {
        slots.push({
          start: start.toISOString(),
          end: new Date(slotStartMs + durationMs).toISOString(),
        });
      }
    }
  }

  return slots.sort((first, second) => first.start.localeCompare(second.start));
}

export function isSlotAvailable(input: IsSlotAvailableInput): boolean {
  const slotWindow = getSlotWindow(input.bookingType, input.requestedStart);
  const leadTimeMs = input.minimumLeadTimeHours * HOUR_MS;
  const earliestStartMs = input.now.getTime() + leadTimeMs;

  if (slotWindow.startMs < earliestStartMs) {
    return false;
  }

  if (slotWindow.endMs > input.horizonEnd.getTime()) {
    return false;
  }

  if (!fitsInsideAvailabilityWindow(slotWindow, input.availabilityWindows)) {
    return false;
  }

  return !input.busyEvents.some((event) =>
    windowsOverlap(slotWindow, getBufferedBusyWindow(input.bookingType, event)),
  );
}

function getSlotWindow(bookingType: BookingTypeConfig, start: Date): TimeWindow {
  const startMs = start.getTime();

  return {
    startMs,
    endMs: startMs + bookingType.durationMinutes * MINUTE_MS,
  };
}

function getBufferedBusyWindow(
  bookingType: BookingTypeConfig,
  event: CalendarEventWindow,
): TimeWindow {
  return {
    startMs: event.start.getTime() - bookingType.bufferBeforeMinutes * MINUTE_MS,
    endMs: event.end.getTime() + bookingType.bufferAfterMinutes * MINUTE_MS,
  };
}

function fitsInsideAvailabilityWindow(
  slotWindow: TimeWindow,
  availabilityWindows: CalendarEventWindow[],
): boolean {
  return availabilityWindows.some((window) => {
    const availabilityWindow = {
      startMs: window.start.getTime(),
      endMs: window.end.getTime(),
    };

    return (
      slotWindow.startMs >= availabilityWindow.startMs &&
      slotWindow.endMs <= availabilityWindow.endMs
    );
  });
}

function windowsOverlap(first: TimeWindow, second: TimeWindow): boolean {
  return first.startMs < second.endMs && second.startMs < first.endMs;
}
