import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_HOLD_STATES,
  createAppointmentHoldFinalizerRepository,
  createAppointmentHoldStore,
  createBookingHold,
  getActiveHoldBusyEvents,
  isActiveHold,
  type AppointmentHoldLifecycleRepository,
  type BookingHoldRecord,
  type BookingHoldRepository,
  type BookingHoldState,
  type CreateBookingHoldRecordInput,
  type TransitionAppointmentHoldInput,
} from "./holds";

const now = new Date("2026-05-18T12:00:00.000Z");
const slotStart = new Date("2026-05-19T14:00:00.000Z");
const slotEnd = new Date("2026-05-19T14:30:00.000Z");

test("createBookingHold creates a held lifecycle record that expires in 10 minutes", async () => {
  const repository = new FakeHoldRepository();

  const result = await createBookingHold({
    bookingType: "in-person-appointment",
    customer: { email: "client@example.com", name: "Client Name", phone: "555-555-5555" },
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    repository,
    selectedEnd: slotEnd,
    selectedStart: slotStart,
    timezone: "America/Toronto",
    now,
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.hold.state, "held");
    assert.equal(result.hold.expiresAt.toISOString(), "2026-05-18T12:10:00.000Z");
    assert.equal(result.hold.offeringId, "lash-fill");
    assert.match(result.hold.publicReference, /^hold_/);
  }
});

test("createBookingHold expires stale conflicting holds before creating a replacement", async () => {
  const repository = new FakeHoldRepository([
    createHoldRecord({
      id: "stale-hold",
      state: "held",
      expiresAt: new Date("2026-05-18T11:59:59.000Z"),
    }),
  ]);

  const result = await createBookingHold({
    bookingType: "in-person-appointment",
    customer: { email: "client@example.com", name: "Client Name", phone: "555-555-5555" },
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    repository,
    selectedEnd: slotEnd,
    selectedStart: slotStart,
    timezone: "America/Toronto",
    now,
  });

  assert.equal(result.ok, true);
  assert.equal(repository.findHold("stale-hold")?.state, "expired");
  assert.equal(repository.records.filter((record) => record.state === "held").length, 1);
});

test("createBookingHold rejects a second active hold for the same offering and time", async () => {
  const repository = new FakeHoldRepository([
    createHoldRecord({ id: "active-hold", state: "payment_pending" }),
  ]);

  const result = await createBookingHold({
    bookingType: "in-person-appointment",
    customer: { email: "second@example.com", name: "Second Client", phone: "555-555-5556" },
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    repository,
    selectedEnd: slotEnd,
    selectedStart: slotStart,
    timezone: "America/Toronto",
    now,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "slot_conflict");
    assert.equal(result.conflictingHoldId, "active-hold");
  }
});

test("getActiveHoldBusyEvents exposes active holds as busy intervals and ignores inactive states", () => {
  const activeStates = new Set(ACTIVE_HOLD_STATES);
  const records: BookingHoldRecord[] = [
    createHoldRecord({ id: "held-hold", state: "held" }),
    createHoldRecord({ id: "booked-hold", state: "booked" }),
    createHoldRecord({ id: "expired-hold", state: "expired" }),
    createHoldRecord({ id: "released-hold", state: "released" }),
  ];

  const busyEvents = getActiveHoldBusyEvents({ holds: records, now });

  assert.deepEqual(
    busyEvents.map((event) => event.id),
    ["hold:held-hold"],
  );
  assert.equal(activeStates.has("held"), true);
  assert.equal(activeStates.has("booked"), false);
});

test("payment-progress holds remain active through the payment success grace window", () => {
  const expiredHeld = createHoldRecord({
    id: "expired-held",
    state: "held",
    expiresAt: new Date("2026-05-18T11:59:00.000Z"),
  });
  const gracePending = createHoldRecord({
    id: "pending-in-grace",
    state: "payment_pending",
    expiresAt: new Date("2026-05-18T11:59:00.000Z"),
  });
  const stalePending = createHoldRecord({
    id: "pending-after-grace",
    state: "payment_pending",
    expiresAt: new Date("2026-05-18T11:54:59.000Z"),
  });
  const paidPendingInGrace = createHoldRecord({
    id: "paid-pending-in-grace",
    state: "paid_pending_booking",
    expiresAt: new Date("2026-05-18T11:59:00.000Z"),
  });
  const paidPendingAfterGrace = createHoldRecord({
    id: "paid-pending-after-grace",
    state: "paid_pending_booking",
    expiresAt: new Date("2026-05-18T11:54:59.000Z"),
  });

  assert.equal(isActiveHold(expiredHeld, now), false);
  assert.equal(isActiveHold(gracePending, now), true);
  assert.equal(isActiveHold(stalePending, now), false);
  assert.equal(isActiveHold(paidPendingInGrace, now), true);
  assert.equal(isActiveHold(paidPendingAfterGrace, now), false);
  assert.deepEqual(
    getActiveHoldBusyEvents({
      holds: [expiredHeld, gracePending, stalePending, paidPendingInGrace, paidPendingAfterGrace],
      now,
    }).map((event) => event.id),
    ["hold:pending-in-grace", "hold:paid-pending-in-grace"],
  );
});

test("createBookingHold rejects paid in-progress conflicts during payment grace", async () => {
  const repository = new FakeHoldRepository([
    createHoldRecord({
      id: "paid-pending-hold",
      state: "paid_pending_booking",
      expiresAt: new Date("2026-05-18T11:59:00.000Z"),
    }),
  ]);

  const result = await createBookingHold({
    bookingType: "in-person-appointment",
    customer: { email: "second@example.com", name: "Second Client", phone: "555-555-5556" },
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    repository,
    selectedEnd: slotEnd,
    selectedStart: slotStart,
    timezone: "America/Toronto",
    now,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.conflictingHoldId, "paid-pending-hold");
  }
});

test("appointment hold store creates holds through the conflict-safe contract", async () => {
  const repository = new FakeLifecycleHoldRepository();
  const store = createAppointmentHoldStore(repository);

  const result = await store.createHold({
    bookingType: "in-person-appointment",
    customer: { email: "client@example.com", name: "Client Name", phone: "555-555-5555" },
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    selectedEnd: slotEnd,
    selectedStart: slotStart,
    timezone: "America/Toronto",
    now,
  });

  assert.equal(result.ok, true);
  assert.equal(repository.records.length, 1);

  if (result.ok) {
    assert.equal(result.hold.state, "held");
    assert.match(result.hold.publicReference, /^hold_/);
  }
});

test("appointment hold store releases holds with a reconciliation timestamp", async () => {
  const repository = new FakeLifecycleHoldRepository([
    createHoldRecord({ id: "hold-to-release", state: "held" }),
  ]);
  const store = createAppointmentHoldStore(repository);

  const released = await store.releaseHold({ holdId: "hold-to-release", now });

  assert.ok(released);
  assert.equal(released.state, "released");
  assert.equal(released.releasedAt?.toISOString(), now.toISOString());
});

test("appointment hold transitions can require active held state", async () => {
  const repository = new FakeLifecycleHoldRepository([
    createHoldRecord({ id: "paid-hold", state: "payment_pending" }),
    createHoldRecord({
      id: "expired-hold",
      state: "held",
      expiresAt: new Date("2026-05-18T11:59:59.000Z"),
    }),
  ]);
  const store = createAppointmentHoldStore(repository);

  const alreadyPending = await store.transitionHold({
    holdId: "paid-hold",
    now,
    requiredState: "held",
    status: "payment_pending",
  });
  const expired = await store.transitionHold({
    expiresAfter: now,
    holdId: "expired-hold",
    now,
    requiredState: "held",
    status: "payment_pending",
  });

  assert.equal(alreadyPending, null);
  assert.equal(expired, null);
  assert.equal(repository.findHold("paid-hold")?.state, "payment_pending");
  assert.equal(repository.findHold("expired-hold")?.state, "held");
});

test("appointment hold transitions redact token and card metadata before persistence", async () => {
  const repository = new FakeLifecycleHoldRepository([
    createHoldRecord({ id: "failed-hold", state: "payment_pending" }),
  ]);
  const store = createAppointmentHoldStore(repository);

  await store.transitionHold({
    failureMetadata: {
      checkoutToken: "raw-checkout-token",
      nested: {
        cardNumber: "4111111111111111",
        safeMessage: "amount mismatch",
      },
      attempts: [
        {
          cvv: "123",
          safeCode: "declined",
        },
      ],
    },
    failureReason: "payment_verification_failed",
    holdId: "failed-hold",
    now,
    reconciliationMetadata: {
      rawWebhookBody: "raw-body",
      helcimTransactionId: "txn_123",
    },
    status: "payment_failed",
  });

  const transition = repository.transitions[0];
  assert.deepEqual(transition.failureMetadata, {
    checkoutToken: "[redacted]",
    nested: {
      cardNumber: "[redacted]",
      safeMessage: "amount mismatch",
    },
    attempts: [
      {
        cvv: "[redacted]",
        safeCode: "declined",
      },
    ],
  });
  assert.deepEqual(transition.reconciliationMetadata, {
    rawWebhookBody: "[redacted]",
    helcimTransactionId: "txn_123",
  });
  assert.equal(repository.findHold("failed-hold")?.paymentFailedAt?.toISOString(), now.toISOString());
});


test("appointment hold finalizer repository maps payment and booking transitions", async () => {
  const hold = createHoldRecord({ id: "finalizer-hold", state: "payment_pending" });
  const lifecycleRepository = new FakeLifecycleHoldRepository([hold]);
  const repository = createAppointmentHoldFinalizerRepository({
    getHoldById: async (holdId) => lifecycleRepository.findHold(holdId) ?? null,
    transitionHold: async (input) => lifecycleRepository.transitionHold({
      ...input,
      now: input.now ?? now,
    }),
  });

  assert.equal((await repository.lockHold("finalizer-hold"))?.id, "finalizer-hold");

  await repository.recordPaidPendingBooking({
    holdId: "finalizer-hold",
    now,
    payment: {
      amountCents: 7500,
      currency: "CAD",
      source: "webhook",
      transactionId: "txn-finalizer",
    },
  });
  await repository.markBooked({
    googleEventId: "calendar-event-finalizer",
    holdId: "finalizer-hold",
    now,
  });

  assert.equal(hold.state, "booked");
  assert.equal(hold.helcimTransactionId, "txn-finalizer");
  assert.equal(hold.googleEventId, "calendar-event-finalizer");
  assert.deepEqual(hold.reconciliationMetadata, {
    payment: {
      amountCents: 7500,
      currency: "CAD",
      source: "webhook",
      transactionId: "txn-finalizer",
    },
  });
});

test("appointment hold finalizer repository preserves payment when booking fails", async () => {
  const hold = createHoldRecord({ id: "failed-finalizer-hold", state: "payment_pending" });
  const lifecycleRepository = new FakeLifecycleHoldRepository([hold]);
  const repository = createAppointmentHoldFinalizerRepository({
    getHoldById: async (holdId) => lifecycleRepository.findHold(holdId) ?? null,
    transitionHold: async (input) => lifecycleRepository.transitionHold({
      ...input,
      now: input.now ?? now,
    }),
  });

  await repository.recordPaidPendingBooking({
    holdId: "failed-finalizer-hold",
    now,
    payment: {
      amountCents: 7500,
      currency: "CAD",
      source: "client_validation",
      transactionId: "txn-finalizer",
    },
  });
  await repository.markBookingFailed({
    error: "Calendar unavailable",
    holdId: "failed-finalizer-hold",
    now,
    state: "booking_failed",
  });

  assert.equal(hold.state, "booking_failed");
  assert.equal(hold.helcimTransactionId, "txn-finalizer");
  assert.equal(hold.failureReason, "Calendar unavailable");
  assert.deepEqual(hold.failureMetadata, { error: "Calendar unavailable" });
});

class FakeHoldRepository implements BookingHoldRepository {
  readonly records: BookingHoldRecord[];

  constructor(records: BookingHoldRecord[] = []) {
    this.records = [...records];
  }

  async createConflictSafeHold(input: CreateBookingHoldRecordInput): Promise<
    | { ok: true; hold: BookingHoldRecord }
    | { ok: false; reason: "slot_conflict"; conflictingHoldId: string }
  > {
    for (const record of this.records) {
      if (
        record.offeringId === input.offeringId &&
        !isActiveHold(record, input.now) &&
        record.selectedStart < input.selectedEnd &&
        input.selectedStart < record.selectedEnd &&
        ACTIVE_HOLD_STATES.includes(record.state)
      ) {
        record.state = "expired";
        record.updatedAt = input.now;
      }
    }

    const conflict = this.records.find((record) => (
      record.offeringId === input.offeringId &&
      isActiveHold(record, input.now) &&
      record.selectedStart < input.selectedEnd &&
      input.selectedStart < record.selectedEnd &&
      ACTIVE_HOLD_STATES.includes(record.state)
    ));

    if (conflict !== undefined) {
      return { ok: false, reason: "slot_conflict", conflictingHoldId: conflict.id };
    }

    const record = createHoldRecord({
      id: `hold-${this.records.length + 1}`,
      publicReference: `hold_${this.records.length + 1}`,
      state: "held",
      ...input,
    });

    this.records.push(record);
    return { ok: true, hold: record };
  }

  findHold(id: string): BookingHoldRecord | undefined {
    return this.records.find((record) => record.id === id);
  }
}

class FakeLifecycleHoldRepository extends FakeHoldRepository implements AppointmentHoldLifecycleRepository {
  readonly transitions: TransitionAppointmentHoldInput[] = [];

  async transitionHold(input: TransitionAppointmentHoldInput): Promise<BookingHoldRecord | null> {
    this.transitions.push(input);

    const record = this.findHold(input.holdId);

    if (!record) {
      return null;
    }

    if (input.requiredState !== undefined && record.state !== input.requiredState) {
      return null;
    }

    if (input.expiresAfter !== undefined && record.expiresAt <= input.expiresAfter) {
      return null;
    }

    record.state = input.status;
    record.updatedAt = input.now;
    record.checkoutOrderId = input.checkoutOrderId ?? record.checkoutOrderId;
    record.checkoutOrderPublicId = input.checkoutOrderPublicId ?? record.checkoutOrderPublicId;
    record.helcimInvoiceId = input.helcimInvoiceId ?? record.helcimInvoiceId;
    record.helcimInvoiceNumber = input.helcimInvoiceNumber ?? record.helcimInvoiceNumber;
    record.helcimTransactionId = input.helcimTransactionId ?? record.helcimTransactionId;
    record.googleEventId = input.googleEventId ?? record.googleEventId;
    record.failureReason = input.failureReason ?? record.failureReason;
    record.failureMetadata = input.failureMetadata ?? record.failureMetadata;
    record.reconciliationMetadata = input.reconciliationMetadata ?? record.reconciliationMetadata;
    applyTransitionTimestamp(record, input.status, input.now);

    return record;
  }
}

function applyTransitionTimestamp(
  record: BookingHoldRecord,
  status: BookingHoldState,
  timestamp: Date,
): void {
  if (status === "released") {
    record.releasedAt = timestamp;
  }

  if (status === "paid_pending_booking") {
    record.paidAt = timestamp;
  }

  if (status === "booked") {
    record.bookedAt = timestamp;
  }

  if (status === "expired") {
    record.expiredAt = timestamp;
  }

  if (status === "payment_failed") {
    record.paymentFailedAt = timestamp;
  }

  if (status === "booking_failed") {
    record.bookingFailedAt = timestamp;
  }

  if (status === "manual_followup") {
    record.manualFollowupAt = timestamp;
  }
}

function createHoldRecord(
  overrides: Partial<BookingHoldRecord> = {},
): BookingHoldRecord {
  return {
    bookingType: "in-person-appointment",
    createdAt: now,
    customer: { email: "client@example.com", name: "Client Name", phone: "555-555-5555" },
    expiresAt: new Date("2026-05-18T12:10:00.000Z"),
    googleEventId: null,
    id: "hold-1",
    offeringId: "lash-fill",
    offeringSnapshot: { title: "Lash Fill" },
    payment: null,
    publicReference: "hold_1",
    selectedEnd: slotEnd,
    selectedStart: slotStart,
    state: "held",
    timezone: "America/Toronto",
    updatedAt: now,
    ...overrides,
  };
}
