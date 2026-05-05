import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingSlots, isSlotAvailable } from "./availability";
import type { BookingTypeConfig, CalendarEventWindow } from "./types";

const bookingType: BookingTypeConfig = {
  type: "training-call",
  label: "Training Call",
  description: "A consultation for training applicants.",
  durationMinutes: 30,
  slotIntervalMinutes: 15,
  bufferBeforeMinutes: 15,
  bufferAfterMinutes: 15,
  questions: [],
};

const availabilityWindow: CalendarEventWindow = {
  id: "availability-1",
  title: "Available",
  start: new Date("2026-05-10T14:00:00.000Z"),
  end: new Date("2026-05-10T16:00:00.000Z"),
};

const now = new Date("2026-05-09T13:00:00.000Z");
const horizonEnd = new Date("2026-05-17T00:00:00.000Z");

test("buildBookingSlots returns interval starts inside the availability window", () => {
  const slots = buildBookingSlots({
    bookingType,
    availabilityWindows: [availabilityWindow],
    busyEvents: [],
    now,
    minimumLeadTimeHours: 24,
    horizonEnd,
  });

  assert.deepEqual(slots, [
    {
      start: "2026-05-10T14:00:00.000Z",
      end: "2026-05-10T14:30:00.000Z",
    },
    {
      start: "2026-05-10T14:15:00.000Z",
      end: "2026-05-10T14:45:00.000Z",
    },
    {
      start: "2026-05-10T14:30:00.000Z",
      end: "2026-05-10T15:00:00.000Z",
    },
    {
      start: "2026-05-10T14:45:00.000Z",
      end: "2026-05-10T15:15:00.000Z",
    },
    {
      start: "2026-05-10T15:00:00.000Z",
      end: "2026-05-10T15:30:00.000Z",
    },
    {
      start: "2026-05-10T15:15:00.000Z",
      end: "2026-05-10T15:45:00.000Z",
    },
    {
      start: "2026-05-10T15:30:00.000Z",
      end: "2026-05-10T16:00:00.000Z",
    },
  ]);
});

test("buildBookingSlots subtracts busy events with before and after buffers", () => {
  const busyEvent: CalendarEventWindow = {
    id: "busy-1",
    title: "Booked",
    start: new Date("2026-05-10T14:30:00.000Z"),
    end: new Date("2026-05-10T15:00:00.000Z"),
  };

  const slots = buildBookingSlots({
    bookingType,
    availabilityWindows: [availabilityWindow],
    busyEvents: [busyEvent],
    now,
    minimumLeadTimeHours: 24,
    horizonEnd,
  });

  assert.equal(
    slots.some((slot) => slot.start === "2026-05-10T14:00:00.000Z"),
    false,
  );
  assert.equal(
    slots.some((slot) => slot.start === "2026-05-10T15:15:00.000Z"),
    true,
  );
});

test("isSlotAvailable returns true for an open slot with no busy events", () => {
  assert.equal(
    isSlotAvailable({
      bookingType,
      start: new Date("2026-05-10T15:15:00.000Z"),
      availabilityWindows: [availabilityWindow],
      busyEvents: [],
      now,
      minimumLeadTimeHours: 24,
      horizonEnd,
    }),
    true,
  );
});
