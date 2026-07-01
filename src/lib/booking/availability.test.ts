import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingSlots, isSlotAvailable } from "./availability";
import { getActiveHoldBusyEvents, type BookingHoldRecord } from "./holds";
import type { BookingTypeConfig, CalendarEventWindow } from "./types";

const bookingType: BookingTypeConfig = {
  type: "in-person-appointment",
  label: "Lash appointment",
  description: "Lash service appointment.",
  durationMinutes: 30,
  slotIntervalMinutes: 15,
  bufferMinutes: 0,
  questions: [],
};

const availabilityWindow: CalendarEventWindow = {
  id: "availability-1",
  title: "Available for booking",
  start: new Date("2026-05-10T14:00:00.000Z"),
  end: new Date("2026-05-10T16:00:00.000Z"),
};

const now = new Date("2026-05-09T12:00:00.000Z");
const horizonEnd = new Date("2026-05-20T12:00:00.000Z");

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
    bookingType: {
      ...bookingType,
      bufferMinutes: 15,
    },
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

test("buildBookingSlots deduplicates slots from overlapping availability windows", () => {
  const overlappingAvailabilityWindow: CalendarEventWindow = {
    id: "availability-2",
    title: "Available for booking",
    start: new Date("2026-05-10T14:30:00.000Z"),
    end: new Date("2026-05-10T15:30:00.000Z"),
  };

  const slots = buildBookingSlots({
    bookingType,
    availabilityWindows: [
      {
        ...availabilityWindow,
        end: new Date("2026-05-10T15:00:00.000Z"),
      },
      overlappingAvailabilityWindow,
    ],
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
  ]);
});

test("isSlotAvailable returns true for an open slot with no busy events", () => {
  assert.equal(
    isSlotAvailable({
      bookingType,
      requestedStart: new Date("2026-05-10T15:15:00.000Z"),
      availabilityWindows: [availabilityWindow],
      busyEvents: [],
      now,
      minimumLeadTimeHours: 24,
      horizonEnd,
    }),
    true,
  );
});

test("buildBookingSlots treats active private holds as busy intervals", () => {
  const activeHold: BookingHoldRecord = {
    bookingType: "in-person-appointment",
    createdAt: now,
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "555-555-5555",
    },
    expiresAt: new Date("2026-05-09T12:10:00.000Z"),
    googleEventId: null,
    id: "hold-1",
    offeringId: "service-classic-fill",
    offeringSnapshot: { title: "Classic Fill" },
    payment: null,
    paymentSessionReference: "pay_sess_1",
    publicReference: "hold_1",
    selectedEnd: new Date("2026-05-10T14:45:00.000Z"),
    selectedStart: new Date("2026-05-10T14:15:00.000Z"),
    state: "held",
    timezone: "America/Toronto",
    updatedAt: now,
  };
  const busyEvents = getActiveHoldBusyEvents({ holds: [activeHold], now });

  const slots = buildBookingSlots({
    bookingType,
    availabilityWindows: [availabilityWindow],
    busyEvents,
    now,
    minimumLeadTimeHours: 24,
    horizonEnd,
  });

  assert.equal(
    slots.some((slot) => slot.start === "2026-05-10T14:15:00.000Z"),
    false,
  );
  assert.equal(
    slots.some((slot) => slot.start === "2026-05-10T14:45:00.000Z"),
    true,
  );
});
