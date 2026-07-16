import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildBookingConfirmationFallbackHtml,
    buildBookingSchedulingFailureAdminHtml,
    getBookingConfirmationEmailIdempotencyKey,
    retryOperationalBookingOutcomeEmails,
    sendBookingConfirmationEmailForHold,
    sendBookingConfirmationEmailForOrder,
  } from "./src/lib/booking/email.ts";
`;

test("booked email idempotency remains rollout-compatible while manual uses a distinct key", () => {
  runBookingEmailScenario(`
    assert.equal(
      getBookingConfirmationEmailIdempotencyKey("hold-1", "booked"),
      "booking-confirmation:hold-1",
    );
    assert.equal(
      getBookingConfirmationEmailIdempotencyKey("hold-1", "manual_followup"),
      "booking-confirmation:hold-1:manual_followup",
    );
  `);
});

test("scheduled booking outcome retries isolate individual provider failures", () => {
  runBookingEmailScenario(`
    const sent = [];
    const logged = [];
    const summary = await retryOperationalBookingOutcomeEmails(
      { limit: 10, now: new Date("2032-01-01T12:00:00.000Z") },
      {
        listHoldIds: async () => ["hold-1", "hold-2"],
        logError: (...args) => logged.push(args),
        sendForHold: async (holdId) => {
          sent.push(holdId);
          if (holdId === "hold-2") throw new Error("provider unavailable");
        },
      },
    );

    assert.deepEqual(sent, ["hold-1", "hold-2"]);
    assert.deepEqual(summary, { attempted: 2, failed: 1, processed: 1 });
    assert.equal(logged.length, 1);
  `);
});

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

test("manual Calendar follow-up email acknowledges payment without claiming the appointment is confirmed", () => {
  runBookingEmailScenario(`
    let renderedHtml = "";
    let markedSent = 0;
    const hold = createHold({
      bookingConfirmationStatus: "manual_followup",
      state: "manual_followup",
    });

    await sendBookingConfirmationEmailForHold(hold.id, {
      claimBookingConfirmationEmailByHoldId: async () => hold,
      logError: () => {},
      markBookingConfirmationEmailSent: async () => { markedSent += 1; },
      recordBookingConfirmationEmailFailure: async () => {},
      sendBookingConfirmationEmail: async (input) => {
        renderedHtml = buildBookingConfirmationFallbackHtml(input);
      },
    });

    assert.match(renderedHtml, /We received your booking/i);
    assert.match(renderedHtml, /received your payment/i);
    assert.match(renderedHtml, /team will contact you/i);
    assert.doesNotMatch(renderedHtml, /is reserved for/i);
    assert.equal(markedSent, 1);
  `);
});

test("a booked upgrade sends a corrective outcome after a concurrent manual email", () => {
  runBookingEmailScenario(`
    const manual = createHold({
      bookingConfirmationStatus: "manual_followup",
      state: "manual_followup",
    });
    const booked = createHold({
      bookingConfirmationStatus: "booked",
      state: "booked",
    });
    const claims = [manual, booked];
    const sentStatuses = [];
    const markedStatuses = [];

    await sendBookingConfirmationEmailForHold(manual.id, {
      claimBookingConfirmationEmailByHoldId: async () => claims.shift() ?? null,
      logError: () => {},
      markBookingConfirmationEmailSent: async (input) => {
        markedStatuses.push(input.bookingStatus);
        return { correctionRequired: input.bookingStatus === "manual_followup" };
      },
      recordBookingConfirmationEmailFailure: async () => {},
      sendBookingConfirmationEmail: async (input) => {
        sentStatuses.push(input.bookingStatus);
      },
    });

    assert.deepEqual(sentStatuses, ["manual_followup", "booked"]);
    assert.deepEqual(markedStatuses, ["manual_followup", "booked"]);
  `);
});

test("booking scheduling failure admin email includes customer, appointment, payment and failure details", () => {
  runBookingEmailScenario(`
    const hold = createHold({
      state: "manual_followup",
      customer: { name: "Nataliea Client", email: "client@example.com", phone: "+14165550123" },
    });

    const html = buildBookingSchedulingFailureAdminHtml({
      amountCents: 5650,
      currency: "CAD",
      currentBookingStatus: "manual_followup",
      failureReason: "Calendar booking failed.",
      hold,
      orderId: "LH-BOOKING-1",
      paymentProvider: "square",
      paymentReference: "pay_123",
      paymentStatus: "COMPLETED",
    });

    assert.match(html, /Nataliea Client/);
    assert.match(html, /client@example.com/);
    assert.match(html, /\\+14165550123/);
    assert.match(html, /Lash Fill/);
    assert.match(html, /LH-BOOKING-1/);
    assert.match(html, /pay_123/);
    assert.match(html, /COMPLETED/);
    assert.match(html, /Calendar booking failed\\./);
    assert.match(html, /manual_followup/);
    assert.match(html, /Action required/);
    assert.ok(html.includes("$56.50 CAD"));
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
