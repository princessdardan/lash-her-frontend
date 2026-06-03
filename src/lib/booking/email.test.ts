import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildBookingConfirmationFallbackHtml,
    sendBookingConfirmationEmailForOrder,
  } from "./src/lib/booking/email.ts";
`;

test("booking confirmation email includes selected add-on balance copy for partial payments", () => {
  runBookingEmailScenario(`
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
    });

    assert.match(renderedHtml, /Lash Bath/);
    assert.match(renderedHtml, /\\$25\\.00|25 CAD|CAD 25/);
    assert.match(renderedHtml, /add-on balance is due later/i);
  `);
});

test("booking confirmation email includes selected add-on included copy for full payments", () => {
  runBookingEmailScenario(`
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
    });

    assert.match(renderedHtml, /Lash Bath/);
    assert.match(renderedHtml, /add-on included in payment/i);
  `);
});

function runBookingEmailScenario(assertions: string): void {
  const scenario = `${helperScript}
    function createOfferingSnapshot(input) {
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

    function createHold(overrides = {}) {
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

    void (async () => {
      ${assertions}
    })();
  `;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.TZ = "America/Toronto";
  delete env.EMAIL_PROFILE_IMAGE_URL;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
