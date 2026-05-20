import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingManualFollowupError,
  PAYMENT_SUCCESS_GRACE_MINUTES,
  finalizeAppointmentPaymentWithLock,
  finalizePaidBooking,
  type BookingCalendarGateway,
  type BookingFinalizerRepository,
} from "./finalizer";
import type { BookingHoldRecord } from "./holds";

const now = new Date("2026-05-18T12:15:00.000Z");

test("finalizePaidBooking is idempotent for client validation and webhook duplicates", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway();

  const first = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "client_validation", transactionId: "txn-123" },
    repository,
  });
  const duplicate = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now: new Date("2026-05-18T12:16:00.000Z"),
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.deepEqual(first, { ok: true, eventId: "calendar-event-1", status: "booked" });
  assert.deepEqual(duplicate, { ok: true, eventId: "calendar-event-1", status: "booked" });
  assert.equal(calendar.insertedEventCount, 1);
  assert.equal(repository.hold.googleEventId, "calendar-event-1");
  assert.equal(repository.hold.state, "booked");
});


test("finalizePaidBooking marks stale paid in-progress holds for manual follow-up without inserting", async () => {
  const hold = createHold({ state: "paid_pending_booking" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway();

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "manual_followup");
    assert.match(result.error, /requires manual follow-up/i);
  }

  assert.equal(calendar.insertedEventCount, 0);
  assert.equal(repository.recordPaidCallCount, 0);
  assert.equal(repository.markBookingFailedCallCount, 1);
  assert.equal(repository.hold.state, "manual_followup");
  assert.equal(repository.hold.googleEventId, null);
});

test("finalizePaidBooking recovers paid in-progress holds with existing Calendar metadata", async () => {
  const hold = createHold({ state: "paid_pending_booking" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({ existingEventId: "calendar-event-existing" });

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.deepEqual(result, { ok: true, eventId: "calendar-event-existing", status: "booked" });
  assert.equal(calendar.findExistingEventCallCount, 1);
  assert.equal(calendar.insertedEventCount, 0);
  assert.equal(repository.recordPaidCallCount, 0);
  assert.equal(repository.hold.state, "booked");
  assert.equal(repository.hold.googleEventId, "calendar-event-existing");
});

test("finalizeAppointmentPaymentWithLock returns pending when duplicate signal is in progress", async () => {
  const lock = new FakeFinalizationLock({ acquire: false });
  let finalized = false;

  const result = await finalizeAppointmentPaymentWithLock({
    finalize: async () => {
      finalized = true;
      return { ok: true, eventId: "calendar-event-1", status: "booked" };
    },
    holdId: "hold-1",
    lock,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "finalization_pending");
    assert.match(result.error, /already in progress/i);
  }

  assert.equal(finalized, false);
  assert.equal(lock.releaseCount, 0);
});

test("finalizeAppointmentPaymentWithLock releases ownership after finalization", async () => {
  const lock = new FakeFinalizationLock({ acquire: true });

  const result = await finalizeAppointmentPaymentWithLock({
    finalize: async () => ({ ok: true, eventId: "calendar-event-1", status: "booked" }),
    holdId: "hold-1",
    lock,
  });

  assert.deepEqual(result, { ok: true, eventId: "calendar-event-1", status: "booked" });
  assert.equal(lock.releaseCount, 1);
});



test("finalizePaidBooking recovers Calendar insert when markBooked failed after event creation", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold, { failNextMarkBooked: true });
  const calendar = new FakeCalendarGateway({ findInsertedEvent: true });

  const first = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "client_validation", transactionId: "txn-123" },
    repository,
  });

  assert.equal(first.ok, false);

  if (!first.ok) {
    assert.equal(first.status, "booking_failed");
    assert.match(first.error, /mark booked unavailable/i);
  }

  assert.equal(calendar.insertedEventCount, 1);
  assert.equal(repository.hold.state, "booking_failed");

  const retry = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.deepEqual(retry, { ok: true, eventId: "calendar-event-1", status: "booked" });
  assert.equal(calendar.insertedEventCount, 1);
  assert.equal(calendar.findExistingEventCallCount, 2);
  assert.equal(repository.hold.googleEventId, "calendar-event-1");
});

test("finalizePaidBooking marks manual follow-up when calendar configuration is missing after payment", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({ failFindManualFollowup: true });

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "client_validation", transactionId: "txn-123" },
    repository,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "manual_followup");
    assert.match(result.error, /calendar is not configured/i);
  }

  assert.equal(repository.recordPaidCallCount, 1);
  assert.equal(repository.markBookingFailedCallCount, 1);
  assert.equal(repository.hold.state, "manual_followup");
  assert.deepEqual(repository.hold.payment, {
    amountCents: 7500,
    currency: "CAD",
    recordedAt: now,
    source: "client_validation",
    transactionId: "txn-123",
  });
  assert.equal(calendar.insertedEventCount, 0);
});

test("finalizePaidBooking marks manual follow-up when the slot becomes unavailable after payment", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({ failInsertManualFollowup: true });

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "client_validation", transactionId: "txn-123" },
    repository,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "manual_followup");
    assert.match(result.error, /became unavailable/i);
  }

  assert.equal(repository.recordPaidCallCount, 1);
  assert.equal(repository.markBookingFailedCallCount, 1);
  assert.equal(repository.hold.state, "manual_followup");
  assert.equal(calendar.insertedEventCount, 0);
});


test("finalizePaidBooking sends late payments beyond grace to manual follow-up", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway();
  const lateNow = new Date(
    hold.expiresAt.getTime() + PAYMENT_SUCCESS_GRACE_MINUTES * 60_000 + 1,
  );

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now: lateNow,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-late" },
    repository,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "manual_followup");
    assert.match(result.error, /after the booking hold grace window/i);
  }

  assert.equal(repository.recordPaidCallCount, 1);
  assert.equal(repository.markBookingFailedCallCount, 1);
  assert.equal(repository.hold.state, "manual_followup");
  assert.deepEqual(repository.hold.payment, {
    amountCents: 7500,
    currency: "CAD",
    recordedAt: lateNow,
    source: "webhook",
    transactionId: "txn-late",
  });
  assert.equal(calendar.findExistingEventCallCount, 0);
  assert.equal(calendar.insertedEventCount, 0);
});

test("finalizePaidBooking preserves payment state when Calendar insert fails", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({ failInsert: true });

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "booking_failed");
    assert.match(result.error, /calendar unavailable/i);
  }

  assert.equal(repository.hold.state, "booking_failed");
  assert.deepEqual(repository.hold.payment, {
    amountCents: 7500,
    currency: "CAD",
    recordedAt: now,
    source: "webhook",
    transactionId: "txn-123",
  });
  assert.equal(repository.hold.googleEventId, null);
});

class FakeFinalizerRepository implements BookingFinalizerRepository {
  markBookingFailedCallCount = 0;
  recordPaidCallCount = 0;

  constructor(
    readonly hold: BookingHoldRecord,
    private readonly options: { failNextMarkBooked?: boolean } = {},
  ) {}

  async lockHold(holdId: string): Promise<BookingHoldRecord | null> {
    return this.hold.id === holdId ? this.hold : null;
  }

  async recordPaidPendingBooking(
    input: Parameters<BookingFinalizerRepository["recordPaidPendingBooking"]>[0],
  ): Promise<BookingHoldRecord> {
    this.recordPaidCallCount += 1;
    this.hold.state = "paid_pending_booking";
    this.hold.payment = {
      amountCents: input.payment.amountCents,
      currency: input.payment.currency,
      recordedAt: input.now,
      source: input.payment.source,
      transactionId: input.payment.transactionId,
    };
    this.hold.updatedAt = input.now;
    return this.hold;
  }

  async markBooked(
    input: Parameters<BookingFinalizerRepository["markBooked"]>[0],
  ): Promise<BookingHoldRecord> {
    if (this.options.failNextMarkBooked === true) {
      this.options.failNextMarkBooked = false;
      throw new Error("Mark booked unavailable");
    }

    this.hold.googleEventId = input.googleEventId;
    this.hold.state = "booked";
    this.hold.updatedAt = input.now;
    return this.hold;
  }

  async markBookingFailed(
    input: Parameters<BookingFinalizerRepository["markBookingFailed"]>[0],
  ): Promise<BookingHoldRecord> {
    this.markBookingFailedCallCount += 1;
    this.hold.failureReason = input.error;
    this.hold.state = input.state;
    this.hold.updatedAt = input.now;
    return this.hold;
  }
}


class FakeFinalizationLock {
  releaseCount = 0;

  constructor(private readonly options: { acquire: boolean }) {}

  async acquire(): Promise<boolean> {
    return this.options.acquire;
  }

  async release(): Promise<void> {
    this.releaseCount += 1;
  }
}

class FakeCalendarGateway implements BookingCalendarGateway {
  findExistingEventCallCount = 0;
  insertedEventCount = 0;

  constructor(private readonly options: {
    existingEventId?: string;
    failFindManualFollowup?: boolean;
    failInsert?: boolean;
    failInsertManualFollowup?: boolean;
    findInsertedEvent?: boolean;
  } = {}) {}

  async findExistingEventForHold(): Promise<string | null> {
    this.findExistingEventCallCount += 1;

    if (this.options.failFindManualFollowup === true) {
      throw new BookingManualFollowupError("Booking calendar is not configured.");
    }

    return this.options.existingEventId ?? (this.options.findInsertedEvent === true && this.insertedEventCount > 0
      ? "calendar-event-1"
      : null);
  }

  async insertBookingEvent(): Promise<string> {
    if (this.options.failInsertManualFollowup === true) {
      throw new BookingManualFollowupError("The selected appointment time became unavailable after payment.");
    }

    if (this.options.failInsert === true) {
      throw new Error("Calendar unavailable");
    }

    this.insertedEventCount += 1;
    return `calendar-event-${this.insertedEventCount}`;
  }
}

function createHold(overrides: Partial<BookingHoldRecord> = {}): BookingHoldRecord {
  return {
    bookingType: "in-person-appointment",
    createdAt: new Date("2026-05-18T12:00:00.000Z"),
    customer: { email: "client@example.com", name: "Client Name", phone: "555-555-5555" },
    expiresAt: new Date("2026-05-18T12:10:00.000Z"),
    googleEventId: null,
    id: "hold-1",
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    payment: null,
    publicReference: "hold_1",
    selectedEnd: new Date("2026-05-19T14:30:00.000Z"),
    selectedStart: new Date("2026-05-19T14:00:00.000Z"),
    state: "held",
    timezone: "America/Toronto",
    updatedAt: new Date("2026-05-18T12:00:00.000Z"),
    ...overrides,
  };
}
