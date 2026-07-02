import assert from "node:assert/strict";
import test from "node:test";

import {
  getBookingPaymentSelection,
  getBookingSelectedAddOn,
} from "./payment-policy";
import type { BookingHoldRecord } from "./holds";

function createHold(
  offeringSnapshot: Record<string, unknown>,
): BookingHoldRecord {
  return {
    id: "hold-1",
    publicReference: "hold_public_1",
    paymentSessionReference: "pay_sess_1",
    bookingType: "in-person-appointment",
    customer: {
      name: "Client",
      email: "client@example.com",
      phone: "555-0100",
    },
    googleEventId: null,
    offeringId: "service-classic-fill",
    offeringSnapshot,
    payment: null,
    selectedStart: new Date("2030-06-15T16:00:00.000Z"),
    selectedEnd: new Date("2030-06-15T17:00:00.000Z"),
    timezone: "UTC",
    state: "held",
    expiresAt: new Date("2030-06-15T15:45:00.000Z"),
    createdAt: new Date("2030-06-15T15:30:00.000Z"),
    updatedAt: new Date("2030-06-15T15:30:00.000Z"),
  } satisfies BookingHoldRecord;
}

test("payment policy parses selected add-on snapshots without affecting selected payment", () => {
  const hold = createHold({
    title: "Classic Fill",
    currency: "CAD",
    selectedAddOn: {
      key: "addon-lash-bath",
      name: "Lash Bath",
      description: "A gentle cleansing add-on",
      price: 25,
      currency: "CAD",
    },
    selectedPayment: {
      amount: 175,
      description: "Classic Fill full payment with Lash Bath",
      purpose: "appointment_full",
      sku: "BOOKING-FULL",
    },
  });

  assert.deepEqual(getBookingPaymentSelection(hold), {
    amount: 175,
    description: "Classic Fill full payment with Lash Bath",
    purpose: "appointment_full",
    sku: "BOOKING-FULL",
  });
  assert.deepEqual(getBookingSelectedAddOn(hold), {
    key: "addon-lash-bath",
    name: "Lash Bath",
    description: "A gentle cleansing add-on",
    price: 25,
    currency: "CAD",
  });
});

test("payment policy tolerates missing or malformed selected add-on snapshots", () => {
  const hold = createHold({
    title: "Classic Fill",
    currency: "CAD",
    selectedAddOn: {
      key: "addon-lash-bath",
      name: "",
      description: "",
      price: -1,
      currency: "CAD",
    },
    selectedPayment: {
      amount: 50,
      description: "Classic Fill deposit",
      purpose: "appointment_deposit",
      sku: "BOOKING-DEPOSIT",
    },
  });

  assert.equal(getBookingSelectedAddOn(hold), null);
  assert.equal(getBookingPaymentSelection(hold)?.amount, 50);
});
