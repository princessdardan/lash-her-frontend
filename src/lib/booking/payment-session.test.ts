import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveServiceBookingPaymentSession,
  type ServiceBookingPaymentSessionDisplay,
} from "./payment-session";
import type { BookingHoldRecord } from "./holds";

const now = new Date("2030-01-01T18:00:00.000Z");

function createHold(
  overrides: Partial<BookingHoldRecord> = {},
): BookingHoldRecord {
  return {
    bookingType: "in-person-appointment",
    createdAt: now,
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "555-555-5555",
    },
    expiresAt: new Date("2030-01-01T18:10:00.000Z"),
    googleEventId: null,
    id: "hold-classic-fill",
    offeringId: "service-classic-fill",
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      payment: {
        amount: 130,
        currency: "CAD",
      },
    },
    payment: null,
    paymentSessionReference: "pay_sess_1",
    publicReference: "hold_1",
    selectedEnd: new Date("2030-01-02T20:00:00.000Z"),
    selectedStart: new Date("2030-01-02T19:00:00.000Z"),
    state: "held",
    timezone: "America/Toronto",
    updatedAt: now,
    ...overrides,
  } satisfies BookingHoldRecord;
}

function createFakeRepository(hold: BookingHoldRecord | null) {
  return {
    async getByPaymentSessionReference() {
      return hold;
    },
  };
}

test("resolves active payment sessions into safe display data", async () => {
  const hold = createHold();
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.equal(result.status, "active");

  if (result.status !== "active") {
    throw new Error("Expected active session result");
  }

  const expected: ServiceBookingPaymentSessionDisplay = {
    currency: "CAD",
    customerName: "Client Name",
    expiresAt: "2030-01-01T18:10:00.000Z",
    paymentSessionReference: "pay_sess_1",
    selectedEnd: "2030-01-02T20:00:00.000Z",
    selectedStart: "2030-01-02T19:00:00.000Z",
    serviceSlug: "classic-fill",
    serviceTitle: "Classic Fill",
    timezone: "America/Toronto",
    totalCents: 13000,
  };

  assert.deepEqual(result.session, expected);
});

test("rejects slug mismatches with not_found", async () => {
  const hold = createHold();
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "volume-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("returns confirmed for paid_pending_booking sessions inside grace window as manual follow-up", async () => {
  const hold = createHold({
    state: "paid_pending_booking",
    expiresAt: new Date("2030-01-01T17:55:00.000Z"),
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now: new Date("2030-01-01T18:00:00.000Z"),
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, {
    status: "confirmed",
    paymentStatus: "manual_followup",
  });
});

test("returns confirmed for booking_failed sessions as manual follow-up", async () => {
  const hold = createHold({
    state: "booking_failed",
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, {
    status: "confirmed",
    paymentStatus: "manual_followup",
  });
});

test("returns expired for expired sessions", async () => {
  const hold = createHold({
    state: "held",
    expiresAt: new Date("2030-01-01T17:55:00.000Z"),
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now: new Date("2030-01-01T18:00:00.000Z"),
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "expired", serviceSlug: "classic-fill" });
});

test("returns confirmed for paid_unbookable_rebooking_pending sessions as manual follow-up", async () => {
  const hold = createHold({
    state: "paid_unbookable_rebooking_pending",
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, {
    status: "confirmed",
    paymentStatus: "manual_followup",
  });
});

test("returns confirmed for already booked sessions", async () => {
  const hold = createHold({
    state: "booked",
    bookedAt: new Date("2030-01-01T17:50:00.000Z"),
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "confirmed", paymentStatus: "booked" });
});
