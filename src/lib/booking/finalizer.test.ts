import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingManualFollowupError,
  BookingRebookingRequiredError,
  PAYMENT_SUCCESS_GRACE_MINUTES,
  finalizeAppointmentPaymentWithLock,
  finalizePaidBooking,
  type BookingCalendarGateway,
  type BookingFinalizerRepository,
} from "./finalizer";
import type { BookingHoldRecord } from "./holds";

const now = new Date("2026-05-18T12:15:00.000Z");

test("finalizePaidBooking is idempotent for browser return and webhook duplicates", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({
    onInsert(insertedHold) {
      assert.equal(insertedHold.state, "paid_pending_booking");
      assert.equal(insertedHold.finalizationStatus, "paid_calendar_pending");
      assert.equal(insertedHold.payment?.transactionId, "txn-123");
    },
  });

  const first = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "return", transactionId: "txn-123" },
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
  assert.equal(repository.recordPaidCallCount, 1);
  assert.equal(repository.hold.googleEventId, "calendar-event-1");
  assert.equal(repository.hold.finalizationStatus, "booked");
  assert.equal(repository.hold.state, "booked");
});


test("finalizePaidBooking continues paid calendar-pending holds through one Calendar insert", async () => {
  const hold = createHold({
    finalizationStatus: "paid_calendar_pending",
    paymentProvider: "square",
    state: "paid_pending_booking",
  });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway();

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.deepEqual(result, { ok: true, eventId: "calendar-event-1", status: "booked" });
  assert.equal(calendar.insertedEventCount, 1);
  assert.equal(repository.recordPaidCallCount, 0);
  assert.equal(repository.markBookingFailedCallCount, 0);
  assert.equal(repository.hold.state, "booked");
  assert.equal(repository.hold.finalizationStatus, "booked");
  assert.equal(repository.hold.googleEventId, "calendar-event-1");
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

test("finalizePaidBooking does not auto-book explicit refund states", async () => {
  const hold = createHold({ state: "refund_required" });
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
    assert.match(result.error, /not eligible for Calendar finalization/i);
  }

  assert.equal(repository.recordPaidCallCount, 0);
  assert.equal(calendar.insertedEventCount, 0);
  assert.equal(repository.hold.state, "refund_required");
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
    assert.equal(first.status, "finalization_pending");
    assert.match(first.error, /mark booked unavailable/i);
  }

  assert.equal(calendar.insertedEventCount, 1);
  assert.equal(repository.hold.state, "paid_pending_booking");
  assert.equal(repository.hold.finalizationStatus, "paid_calendar_pending");

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
  assert.equal(repository.recordCalendarRetryCallCount, 1);
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
  assert.equal(repository.hold.finalizationStatus, "manual_review");
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

test("finalizePaidBooking sends unavailable paid slots to rebooking review before refund", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({ failInsertRebooking: true });

  const result = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "client_validation", transactionId: "txn-123" },
    repository,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.status, "paid_unbookable_rebooking_pending");
    assert.match(result.error, /became unavailable/i);
  }

  assert.equal(repository.recordPaidCallCount, 1);
  assert.equal(repository.markBookingFailedCallCount, 0);
  assert.equal(repository.markPaidUnbookableCallCount, 1);
  assert.equal(repository.hold.finalizationStatus, "paid_unbookable_rebooking_pending");
  assert.equal(repository.hold.manualReviewStatus, "rebooking_pending");
  assert.equal(repository.hold.state, "paid_unbookable_rebooking_pending");
  assert.equal(calendar.insertedEventCount, 0);
});


test("finalizePaidBooking sends late payments beyond grace to rebooking review", async () => {
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
    assert.equal(result.status, "paid_unbookable_rebooking_pending");
    assert.match(result.error, /after the booking hold grace window/i);
  }

  assert.equal(repository.recordPaidCallCount, 1);
  assert.equal(repository.markBookingFailedCallCount, 0);
  assert.equal(repository.markPaidUnbookableCallCount, 1);
  assert.equal(repository.hold.finalizationStatus, "paid_unbookable_rebooking_pending");
  assert.equal(repository.hold.state, "paid_unbookable_rebooking_pending");
  assert.deepEqual(repository.hold.payment, {
    amountCents: 7500,
    currency: "CAD",
    recordedAt: lateNow,
    source: "webhook",
    transactionId: "txn-late",
  });
  assert.equal(calendar.findExistingEventCallCount, 1);
  assert.equal(calendar.insertedEventCount, 0);
});

test("finalizePaidBooking leaves Calendar insert failures retryable after paid persistence", async () => {
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
    assert.equal(result.status, "finalization_pending");
    assert.match(result.error, /calendar unavailable/i);
  }

  assert.equal(repository.hold.state, "paid_pending_booking");
  assert.equal(repository.hold.finalizationStatus, "paid_calendar_pending");
  assert.equal(repository.markBookingFailedCallCount, 0);
  assert.equal(repository.recordCalendarRetryCallCount, 1);
  assert.deepEqual(repository.hold.payment, {
    amountCents: 7500,
    currency: "CAD",
    recordedAt: now,
    source: "webhook",
    transactionId: "txn-123",
  });
  assert.equal(repository.hold.googleEventId, null);
});

test("finalizePaidBooking retries a Calendar insert that succeeded before correlation was persisted", async () => {
  const hold = createHold({ state: "payment_pending" });
  const repository = new FakeFinalizerRepository(hold);
  const calendar = new FakeCalendarGateway({ failInsertAfterCreate: true, findInsertedEvent: true });

  const first = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now,
    payment: { amountCents: 7500, currency: "CAD", source: "webhook", transactionId: "txn-123" },
    repository,
  });

  assert.equal(first.ok, false);

  if (!first.ok) {
    assert.equal(first.status, "finalization_pending");
  }

  const retry = await finalizePaidBooking({
    calendar,
    holdId: hold.id,
    now: new Date("2026-05-18T12:16:00.000Z"),
    payment: { amountCents: 7500, currency: "CAD", source: "return", transactionId: "txn-123" },
    repository,
  });

  assert.deepEqual(retry, { ok: true, eventId: "calendar-event-1", status: "booked" });
  assert.equal(calendar.insertedEventCount, 1);
  assert.equal(calendar.findExistingEventCallCount, 2);
  assert.equal(repository.hold.googleEventId, "calendar-event-1");
});

class FakeFinalizerRepository implements BookingFinalizerRepository {
  markBookingFailedCallCount = 0;
  markPaidUnbookableCallCount = 0;
  recordCalendarRetryCallCount = 0;
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
    this.hold.finalizationStatus = "paid_calendar_pending";
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

  async recordCalendarRetryPending(
    input: Parameters<BookingFinalizerRepository["recordCalendarRetryPending"]>[0],
  ): Promise<BookingHoldRecord> {
    this.recordCalendarRetryCallCount += 1;
    this.hold.failureReason = input.error;
    this.hold.finalizationReason = input.error;
    this.hold.finalizationStatus = "paid_calendar_pending";
    this.hold.state = "paid_pending_booking";
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
    this.hold.finalizationStatus = "booked";
    this.hold.state = "booked";
    this.hold.updatedAt = input.now;
    return this.hold;
  }

  async markBookingFailed(
    input: Parameters<BookingFinalizerRepository["markBookingFailed"]>[0],
  ): Promise<BookingHoldRecord> {
    this.markBookingFailedCallCount += 1;
    this.hold.failureReason = input.error;
    this.hold.finalizationReason = input.error;
    this.hold.finalizationStatus = input.state === "manual_followup" ? "manual_review" : "failed";
    this.hold.state = input.state;
    this.hold.updatedAt = input.now;
    return this.hold;
  }

  async markPaidUnbookableForRebooking(
    input: Parameters<BookingFinalizerRepository["markPaidUnbookableForRebooking"]>[0],
  ): Promise<BookingHoldRecord> {
    this.markPaidUnbookableCallCount += 1;
    this.hold.failureReason = input.reason;
    this.hold.finalizationReason = input.reason;
    this.hold.finalizationStatus = "paid_unbookable_rebooking_pending";
    this.hold.manualReviewReason = input.reason;
    this.hold.manualReviewStatus = "rebooking_pending";
    this.hold.state = "paid_unbookable_rebooking_pending";
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
    failInsertAfterCreate?: boolean;
    failInsertRebooking?: boolean;
    findInsertedEvent?: boolean;
    onInsert?: (hold: BookingHoldRecord) => void;
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

  async insertBookingEvent(hold: BookingHoldRecord): Promise<string> {
    if (this.options.failInsertRebooking === true) {
      throw new BookingRebookingRequiredError("The selected appointment time became unavailable after payment.");
    }

    if (this.options.failInsert === true) {
      throw new Error("Calendar unavailable");
    }

    this.options.onInsert?.(hold);
    this.insertedEventCount += 1;

    if (this.options.failInsertAfterCreate === true) {
      this.options.failInsertAfterCreate = false;
      throw new Error("Calendar response lost after insert");
    }

    return `calendar-event-${this.insertedEventCount}`;
  }
}

function createHold(overrides: Partial<BookingHoldRecord> = {}): BookingHoldRecord {
  return {
    bookingType: "in-person-appointment",
    createdAt: new Date("2026-05-18T12:00:00.000Z"),
    customer: { email: "client@example.com", name: "Client Name", phone: "555-555-5555" },
    expiresAt: new Date("2026-05-18T12:10:00.000Z"),
    finalizationStatus: "pending",
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
