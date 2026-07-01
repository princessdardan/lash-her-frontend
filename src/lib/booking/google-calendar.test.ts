import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingEventPayload } from "./google-calendar-event-payload";
import type { BookingHoldRecord } from "./holds";

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

  assert.equal(
    event.summary,
    "Lash Her booking: Training sign-up call — Jane Client",
  );
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

test("buildBookingEventPayload includes deterministic private booking metadata", () => {
  const event = buildBookingEventPayload({
    bookingMetadata: {
      checkoutOrderId: "order-row-123",
      checkoutOrderPublicId: "lh-square-123",
      holdId: "hold-123",
      paymentProvider: "square" as const,
    },
    bookingTypeLabel: "Lash fill",
    customer: {
      name: "Jane Client",
      email: "jane@example.com",
      phone: "555-555-5555",
    },
    answers: [],
    start: new Date("2026-05-10T14:00:00.000Z"),
    end: new Date("2026-05-10T14:30:00.000Z"),
    timezone: "America/New_York",
  });

  assert.deepEqual(event.extendedProperties, {
    private: {
      lashHerBookingHoldId: "hold-123",
      lashHerCheckoutOrderId: "order-row-123",
      lashHerCheckoutOrderPublicId: "lh-square-123",
      lashHerPaymentProvider: "square",
    },
  });
});

test("buildBookingEventPayload includes selected add-on balance copy for staff on partial payments", () => {
  const eventInput = {
    bookingMetadata: {
      checkoutOrderId: "order-row-123",
      checkoutOrderPublicId: "lh-square-123",
      holdId: "hold-123",
      paymentProvider: "square" as const,
    },
    bookingTypeLabel: "Lash fill",
    customer: {
      name: "Jane Client",
      email: "jane@example.com",
      phone: "555-555-5555",
    },
    answers: [],
    hold: createHold({
      offeringSnapshot: createOfferingSnapshot({
        purpose: "appointment_deposit",
      }),
    }),
    start: new Date("2026-05-10T14:00:00.000Z"),
    end: new Date("2026-05-10T14:30:00.000Z"),
    timezone: "America/New_York",
  };

  const event = buildBookingEventPayload(eventInput);

  assert.match(event.description ?? "", /Lash Bath/);
  assert.match(event.description ?? "", /\$25\.00|25 CAD|CAD 25/);
  assert.match(event.description ?? "", /add-on balance is due later/i);
});

test("buildBookingEventPayload includes selected add-on included copy for staff on full payments", () => {
  const eventInput = {
    bookingTypeLabel: "Lash fill",
    customer: {
      name: "Jane Client",
      email: "jane@example.com",
      phone: "555-555-5555",
    },
    answers: [],
    hold: createHold({
      offeringSnapshot: createOfferingSnapshot({ purpose: "appointment_full" }),
    }),
    start: new Date("2026-05-10T14:00:00.000Z"),
    end: new Date("2026-05-10T14:30:00.000Z"),
    timezone: "America/New_York",
  };

  const event = buildBookingEventPayload(eventInput);

  assert.match(event.description ?? "", /Lash Bath/);
  assert.match(event.description ?? "", /add-on included in payment/i);
});

function createOfferingSnapshot(input: {
  purpose: "appointment_deposit" | "appointment_full";
}): Record<string, unknown> {
  return {
    currency: "CAD",
    selectedAddOn: {
      key: "lash-bath",
      name: "Lash Bath",
      description: "A gentle lash cleanse before service.",
      price: 25,
      currency: "CAD",
    },
    selectedPayment: {
      amount: input.purpose === "appointment_full" ? 125 : 50,
      description:
        input.purpose === "appointment_full"
          ? "Lash Fill full payment"
          : "Lash Fill deposit",
      purpose: input.purpose,
      sku:
        input.purpose === "appointment_full"
          ? "BOOKING-FULL"
          : "BOOKING-DEPOSIT",
    },
    title: "Lash Fill",
  };
}

function createHold(
  overrides: Partial<BookingHoldRecord> = {},
): BookingHoldRecord {
  return {
    bookingType: "in-person-appointment",
    createdAt: new Date("2026-05-18T12:00:00.000Z"),
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "555-555-5555",
    },
    expiresAt: new Date("2026-05-18T12:10:00.000Z"),
    finalizationStatus: "pending",
    googleEventId: null,
    id: "hold-1",
    offeringId: "lash-fill",
    offeringSnapshot: createOfferingSnapshot({
      purpose: "appointment_deposit",
    }),
    payment: null,
    paymentProvider: "square",
    paymentSessionReference: "pay_sess_1",
    publicReference: "hold_1",
    selectedEnd: new Date("2026-05-19T14:30:00.000Z"),
    selectedStart: new Date("2026-05-19T14:00:00.000Z"),
    state: "booked",
    timezone: "America/Toronto",
    updatedAt: new Date("2026-05-18T12:00:00.000Z"),
    ...overrides,
  };
}
