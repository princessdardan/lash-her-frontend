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
      pricing: {
        depositAmount: 50,
        fullPrice: 130,
        currency: "CAD",
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
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
    expiresAt: "2030-01-01T18:10:00.000Z",
    paymentSessionReference: "pay_sess_1",
    pricing: {
      addOnPriceCents: 2500,
      customAmountMaximumCents: 13000,
      customAmountMinimumCents: 5000,
      depositAmountCents: 5000,
      fullPriceCents: 13000,
    },
    selectedAddOn: {
      description: "Gentle removal before fill",
      key: "addon-removal",
      name: "Removal",
      priceCents: 2500,
    },
    selectedEnd: "2030-01-02T20:00:00.000Z",
    selectedStart: "2030-01-02T19:00:00.000Z",
    serviceSlug: "classic-fill",
    serviceTitle: "Classic Fill",
    timezone: "America/Toronto",
  };

  assert.deepEqual(result.session, expected);
});

test("resolves active provisional sessions with no add-on and zero addOnPrice", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 0,
      },
    },
  });

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

  assert.equal(result.session.pricing.addOnPriceCents, 0);
  assert.equal(result.session.selectedAddOn, undefined);
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

test("rejects active sessions without pricing bounds", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        addOnPrice: 25,
      },
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("rejects active sessions when pricing is missing entirely", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
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

test("rejects active sessions with positive addOnPrice but missing selectedAddOn", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("rejects active sessions when selectedAddOn price mismatches pricing.addOnPrice", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 30,
        currency: "CAD",
      },
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("rejects active sessions when selectedAddOn currency is not CAD", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "USD",
      },
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("rejects active sessions when selectedAddOn has blank key", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "   ",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "CAD",
      },
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("rejects zero addOnPrice sessions with malformed selectedAddOn", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 0,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "CAD",
      },
    },
  });
  const result = await resolveServiceBookingPaymentSession(
    {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      now,
    },
    createFakeRepository(hold),
  );

  assert.deepEqual(result, { status: "not_found" });
});

test("exposes service promotion discount in active session pricing", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "CAD",
      },
      promotionSnapshot: {
        code: "SAVE30",
        discountType: "percentage",
        discountAmount: 30,
        discountCents: 3900,
        originalBasePriceCents: 13000,
        discountedBasePriceCents: 9100,
      },
    },
  });

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

  assert.equal(result.session.pricing.fullPriceCents, 13000);
  assert.equal(result.session.pricing.discountedBasePriceCents, 9100);
  assert.equal(result.session.pricing.promotionCode, "SAVE30");
  assert.equal(result.session.pricing.promotionDiscountCents, 3900);
});

test("exposes fully discounted service base as zero in active session pricing", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "CAD",
      },
      promotionSnapshot: {
        code: "FREE",
        discountType: "percentage",
        discountAmount: 100,
        discountCents: 13000,
        originalBasePriceCents: 13000,
        discountedBasePriceCents: 0,
      },
    },
  });

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

  assert.equal(result.session.pricing.fullPriceCents, 13000);
  assert.equal(result.session.pricing.discountedBasePriceCents, 0);
  assert.equal(result.session.pricing.promotionCode, "FREE");
  assert.equal(result.session.pricing.promotionDiscountCents, 13000);
});

test("ignores malformed promotion snapshot and falls back to full price", async () => {
  const hold = createHold({
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      pricing: {
        currency: "CAD",
        depositAmount: 50,
        fullPrice: 130,
        customAmountMinimum: 50,
        customAmountMaximum: 130,
        addOnPrice: 25,
      },
      selectedAddOn: {
        key: "addon-removal",
        name: "Removal",
        description: "Gentle removal before fill",
        price: 25,
        currency: "CAD",
      },
      promotionSnapshot: {
        code: "SAVE30",
        discountType: "percentage",
        discountAmount: 30,
        discountCents: 3900,
        originalBasePriceCents: 13000,
        // discountedBasePriceCents is missing, so snapshot is invalid.
      },
    },
  });

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

  assert.equal(result.session.pricing.fullPriceCents, 13000);
  assert.equal(result.session.pricing.discountedBasePriceCents, undefined);
  assert.equal(result.session.pricing.promotionCode, undefined);
});
