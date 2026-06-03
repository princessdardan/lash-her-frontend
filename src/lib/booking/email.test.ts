import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBookingConfirmationFallbackHtml,
  sendBookingConfirmationEmailForOrder,
  type SendBookingConfirmationEmailForOrderDependencies,
} from "./email";
import type { BookingHoldRecord } from "./holds";

test("booking confirmation email includes selected add-on balance copy for partial payments", async () => {
  let renderedHtml = "";
  const hold = createHold({
    offeringSnapshot: createOfferingSnapshot({ purpose: "appointment_custom_partial" }),
  });

  await sendBookingConfirmationEmailForOrder("LH-BOOKING-1", {
    claimBookingConfirmationEmailByOrderId: async () => hold,
    logError: () => {},
    markBookingConfirmationEmailSent: async () => {},
    recordBookingConfirmationEmailFailure: async () => {},
    sendBookingConfirmationEmail: async (input) => {
      renderedHtml = buildBookingConfirmationFallbackHtml(input);
    },
  } satisfies SendBookingConfirmationEmailForOrderDependencies);

  assert.match(renderedHtml, /Lash Bath/);
  assert.match(renderedHtml, /\$25\.00|25 CAD|CAD 25/);
  assert.match(renderedHtml, /add-on balance is due later/i);
});

test("booking confirmation email includes selected add-on included copy for full payments", async () => {
  let renderedHtml = "";
  const hold = createHold({
    offeringSnapshot: createOfferingSnapshot({ purpose: "appointment_full" }),
  });

  await sendBookingConfirmationEmailForOrder("LH-BOOKING-1", {
    claimBookingConfirmationEmailByOrderId: async () => hold,
    logError: () => {},
    markBookingConfirmationEmailSent: async () => {},
    recordBookingConfirmationEmailFailure: async () => {},
    sendBookingConfirmationEmail: async (input) => {
      renderedHtml = buildBookingConfirmationFallbackHtml(input);
    },
  } satisfies SendBookingConfirmationEmailForOrderDependencies);

  assert.match(renderedHtml, /Lash Bath/);
  assert.match(renderedHtml, /add-on included in payment/i);
});

function createOfferingSnapshot(input: { purpose: "appointment_custom_partial" | "appointment_full" }): Record<string, unknown> {
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
      description: input.purpose === "appointment_full" ? "Lash Fill full payment" : "Lash Fill partial payment",
      purpose: input.purpose,
      sku: input.purpose === "appointment_full" ? "BOOKING-FULL" : "BOOKING-CUSTOM-PARTIAL",
    },
    title: "Lash Fill",
  };
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
    offeringSnapshot: createOfferingSnapshot({ purpose: "appointment_custom_partial" }),
    payment: null,
    paymentProvider: "square",
    publicReference: "hold_1",
    selectedEnd: new Date("2026-05-19T14:30:00.000Z"),
    selectedStart: new Date("2026-05-19T14:00:00.000Z"),
    state: "booked",
    timezone: "America/Toronto",
    updatedAt: new Date("2026-05-18T12:00:00.000Z"),
    ...overrides,
  };
}
