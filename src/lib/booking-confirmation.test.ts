import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getVerifiedBookingConfirmation } from "./src/lib/booking-confirmation.ts";

  const bookedAppointment = {
    bookingType: "in-person-appointment",
    bookedAt: new Date("2026-05-18T12:30:00.000Z"),
    checkoutOrderPublicId: "LH-BOOKING-123",
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "555-555-5555",
    },
    googleEventId: "calendar-event-1",
    id: "appointment-hold-1",
    offeringId: "lash-fill",
    offeringSnapshot: {
      title: "Lash Fill",
    },
    paidAt: new Date("2026-05-18T12:31:00.000Z"),
    publicReference: "hold_abc123",
    selectedEnd: new Date("2026-05-19T14:30:00.000Z"),
    selectedStart: new Date("2026-05-19T14:00:00.000Z"),
    state: "booked",
    timezone: "America/Toronto",
  };
`;

test("booking confirmation returns null when the public order id is missing", () => {
  runBookingConfirmationScenario(`
    let lookupCalled = false;

    assert.equal(
      await getVerifiedBookingConfirmation({
        findAppointmentByPublicOrderId: async () => {
          lookupCalled = true;
          return bookedAppointment;
        },
        orderId: undefined,
      }),
      null,
    );

    assert.equal(lookupCalled, false);
  `);
});

test("booking confirmation returns null when the public order id is blank", () => {
  runBookingConfirmationScenario(`
    let lookupCalled = false;

    assert.equal(
      await getVerifiedBookingConfirmation({
        findAppointmentByPublicOrderId: async () => {
          lookupCalled = true;
          return bookedAppointment;
        },
        orderId: "   ",
      }),
      null,
    );

    assert.equal(lookupCalled, false);
  `);
});

test("booking confirmation returns null when the public order id is unknown", () => {
  runBookingConfirmationScenario(`
    let lookedUpOrderId = "";

    assert.equal(
      await getVerifiedBookingConfirmation({
        findAppointmentByPublicOrderId: async ({ publicOrderId }) => {
          lookedUpOrderId = publicOrderId;
          return null;
        },
        orderId: "LH-MISSING",
      }),
      null,
    );

    assert.equal(lookedUpOrderId, "LH-MISSING");
  `);
});

test("booking confirmation returns a sanitized confirmation for booked appointments", () => {
  runBookingConfirmationScenario(`
    const found = await getVerifiedBookingConfirmation({
      findAppointmentByPublicOrderId: async ({ publicOrderId }) => {
        assert.equal(publicOrderId, "LH-BOOKING-123");
        return bookedAppointment;
      },
      orderId: "LH-BOOKING-123",
    });

    assert.deepEqual(found, {
      orderId: "LH-BOOKING-123",
      status: "booked",
    });

    assert.equal(found && "customer" in found, false);
    assert.equal(found && "email" in found, false);
    assert.equal(found && "name" in found, false);
    assert.equal(found && "phone" in found, false);
    assert.equal(found && "googleEventId" in found, false);
    assert.equal(found && "failureMetadata" in found, false);
  `);
});

test("booking confirmation accepts paid pending, manual follow-up, and booking failed appointments", () => {
  runBookingConfirmationScenario(`
    const paidPending = await getVerifiedBookingConfirmation({
      findAppointmentByPublicOrderId: async () => ({
        ...bookedAppointment,
        state: "paid_pending_booking",
      }),
      orderId: "LH-BOOKING-123",
    });

    assert.deepEqual(paidPending, {
      orderId: "LH-BOOKING-123",
      status: "paid_pending_booking",
    });

    const manualFollowup = await getVerifiedBookingConfirmation({
      findAppointmentByPublicOrderId: async () => ({
        ...bookedAppointment,
        state: "manual_followup",
      }),
      orderId: "LH-BOOKING-123",
    });

    assert.deepEqual(manualFollowup, {
      orderId: "LH-BOOKING-123",
      status: "manual_followup",
    });

    assert.equal(
      (await getVerifiedBookingConfirmation({
        findAppointmentByPublicOrderId: async () => ({
          ...bookedAppointment,
          state: "booking_failed",
        }),
        orderId: "LH-BOOKING-123",
      }))?.status,
      "booking_failed",
    );
  `);
});

function runBookingConfirmationScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync("./node_modules/.bin/tsx", ["--conditions=react-server", "--eval", scenario], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}
