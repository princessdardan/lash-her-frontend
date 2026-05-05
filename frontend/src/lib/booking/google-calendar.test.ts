import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingEventPayload } from "./google-calendar-event-payload";

test("buildBookingEventPayload creates the booking event without conference data", () => {
  const event = buildBookingEventPayload({
    bookingTypeLabel: "Training sign-up call",
    customer: {
      name: "Jane Client",
      email: "jane@example.com",
      phone: "555-555-5555",
    },
    answers: [
      {
        questionLabel: "Goal",
        answer: "Training details",
      },
    ],
    start: new Date("2026-05-10T14:00:00.000Z"),
    end: new Date("2026-05-10T14:30:00.000Z"),
    timezone: "America/New_York",
  });

  assert.equal(event.summary, "Lash Her booking: Training sign-up call — Jane Client");
  assert.deepEqual(event.attendees, [
    { email: "jane@example.com", displayName: "Jane Client" },
  ]);
  assert.equal(Object.hasOwn(event, "conferenceData"), false);
  assert.match(event.description ?? "", /555-555-5555/);
  assert.match(event.description ?? "", /Goal: Training details/);
  assert.deepEqual(event.start, {
    dateTime: "2026-05-10T14:00:00.000Z",
    timeZone: "America/New_York",
  });
  assert.deepEqual(event.end, {
    dateTime: "2026-05-10T14:30:00.000Z",
    timeZone: "America/New_York",
  });
  assert.deepEqual(event.reminders, { useDefault: true });
});
