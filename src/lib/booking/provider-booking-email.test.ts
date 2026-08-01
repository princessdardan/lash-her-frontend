import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildProviderBookingFallbackHtml,
    getProviderBookingEmailIdempotencyKey,
    sendProviderBookingEmail,
    sendProviderBookingEmailForOrder,
    toProviderBookingEmailInput,
  } from "./src/lib/booking/provider-booking-email.ts";

  function createClaim(overrides = {}) {
    return {
      bookingType: "in-person-appointment",
      capturedAmountCents: 5650,
      currency: "CAD",
      customer: {
        email: "client@example.com",
        name: "Client <Name>",
        phone: "+1 416 555 0100",
      },
      end: new Date("2026-08-15T16:30:00.000Z"),
      holdId: "hold-1",
      offeringSnapshot: {
        currency: "CAD",
        pricing: {
          addOnPrice: 25,
          currency: "CAD",
          fullPrice: 100,
        },
        selectedAddOn: {
          currency: "CAD",
          description: "A gentle cleanse.",
          key: "lash-bath",
          name: "Lash Bath",
          price: 25,
        },
        selectedPayment: {
          amount: 125,
          description: "Volume fill full payment",
          purpose: "appointment_full",
          sku: "BOOKING-FULL",
        },
        title: "Volume Lash Fill",
      },
      orderId: "LH-BOOKING-1",
      paymentProvider: "square",
      paymentPurpose: "appointment_full",
      providerName: "Nataliea",
      recipientEmails: ["provider@example.com"],
      start: new Date("2026-08-15T15:00:00.000Z"),
      timezone: "America/Toronto",
      tipAmountCents: 1500,
      ...overrides,
    };
  }
`;

test("provider booking email reports service, schedule, payment kind, tip, and total", () => {
  runProviderBookingEmailScenario(`
    const input = toProviderBookingEmailInput(createClaim());
    const html = buildProviderBookingFallbackHtml(input);

    assert.equal(input.paymentKindLabel, "Full payment");
    assert.equal(input.bookedSubtotalCents, 12500);
    assert.equal(input.bookedTotalAfterTaxCents, 14125);
    assert.equal(input.remainingBalanceCents, 0);
    assert.equal(input.remainingBalanceAfterTaxCents, 0);
    assert.equal(input.bookingPaymentAmountCents, 5650);
    assert.equal(input.tipAmountCents, 1500);
    assert.equal(input.totalPaidCents, 7150);
    assert.match(input.addOnPaymentCopy, /included in the booked totals/i);
    assert.match(html, /Volume Lash Fill/);
    assert.match(html, /Full payment/);
    assert.equal(html.includes("$56.50"), true);
    assert.equal(html.includes("$15.00"), true);
    assert.equal(html.includes("$71.50"), true);
    assert.match(html, /Saturday, August 15, 2026/);
    assert.match(html, /Client &lt;Name&gt;/);
    assert.doesNotMatch(html, /Client <Name>/);
  `);
});

test("custom partial provider email reports the actual balance after paying into an add-on", () => {
  runProviderBookingEmailScenario(`
    const claim = createClaim({
      capturedAmountCents: 16949,
      paymentPurpose: "appointment_custom_partial",
      tipAmountCents: 0,
    });
    claim.offeringSnapshot.pricing.fullPrice = 100;
    claim.offeringSnapshot.selectedAddOn.price = 50;
    claim.offeringSnapshot.pricing.addOnPrice = 50;
    delete claim.offeringSnapshot.selectedPayment.amount;
    claim.offeringSnapshot.selectedPayment.amountCents = 14999;
    claim.offeringSnapshot.selectedPayment.purpose = "appointment_custom_partial";
    claim.offeringSnapshot.selectedPayment.sku = "BOOKING-CUSTOM-PARTIAL";

    const input = toProviderBookingEmailInput(claim);
    const html = buildProviderBookingFallbackHtml(input);

    assert.equal(input.paymentKindLabel, "Custom partial payment");
    assert.equal(input.bookedSubtotalCents, 15000);
    assert.equal(input.bookedTotalAfterTaxCents, 16950);
    assert.equal(input.bookingPaymentAmountCents, 16949);
    assert.equal(input.remainingBalanceCents, 1);
    assert.equal(input.remainingBalanceAfterTaxCents, 1);
    assert.doesNotMatch(input.addOnPaymentCopy, /balance due later/i);
    assert.match(input.addOnPaymentCopy, /included in the booked totals/i);
    assert.equal(html.includes("Booked subtotal (service + add-on)"), true);
    assert.match(html, /Booked total after HST/);
    assert.match(html, /Remaining balance before HST/);
    assert.match(html, /Remaining balance after HST/);
    assert.equal(html.includes("$150.00"), true);
    assert.equal(html.includes("$169.50"), true);
    assert.equal(html.includes("$0.01"), true);
  `);
});

test("provider booking totals use the discounted service price and full add-on price", () => {
  runProviderBookingEmailScenario(`
    const claim = createClaim({
      paymentPurpose: "appointment_custom_partial",
      tipAmountCents: 0,
    });
    claim.offeringSnapshot.selectedAddOn.price = 50;
    claim.offeringSnapshot.pricing.addOnPrice = 50;
    claim.offeringSnapshot.promotionSnapshot = {
      code: "SAVE20",
      discountType: "percentage",
      discountAmount: 20,
      discountCents: 2000,
      originalBasePriceCents: 10000,
      discountedBasePriceCents: 8000,
    };
    delete claim.offeringSnapshot.selectedPayment.amount;
    claim.offeringSnapshot.selectedPayment.amountCents = 10000;
    claim.offeringSnapshot.selectedPayment.purpose = "appointment_custom_partial";
    claim.offeringSnapshot.selectedPayment.sku = "BOOKING-CUSTOM-PARTIAL";

    const input = toProviderBookingEmailInput(claim);

    assert.equal(input.bookedSubtotalCents, 13000);
    assert.equal(input.bookedTotalAfterTaxCents, 14690);
    assert.equal(input.remainingBalanceCents, 3000);
    assert.equal(input.remainingBalanceAfterTaxCents, 3390);
  `);
});

test("provider booking delivery falls back to ADMIN_EMAIL and uses a recipient-safe idempotency key", () => {
  runProviderBookingEmailScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ body: JSON.parse(init.body), headers: init.headers, url: String(url) });
      return new Response(JSON.stringify({ id: "email-provider-1" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };
    process.env.ADMIN_EMAIL = "admin@lashher.test";
    process.env.FROM_EMAIL = "Lash Her <hello@lashher.test>";
    process.env.RESEND_API_KEY = "re_test";

    const input = toProviderBookingEmailInput(createClaim({ recipientEmails: [] }));
    await sendProviderBookingEmail(input);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.to, "admin@lashher.test");
    assert.match(requests[0].body.html, /Total paid at booking/);
    assert.equal(
      getProviderBookingEmailIdempotencyKey("hold-1", "admin@lashher.test").includes("admin@lashher.test"),
      false,
    );
  `);
});

test("provider booking delivery records success independently from the customer email", () => {
  runProviderBookingEmailScenario(`
    const sent = [];
    const marked = [];
    const failed = [];

    await sendProviderBookingEmailForOrder("LH-BOOKING-1", {
      claimProviderBookingEmail: async (input) => {
        assert.deepEqual(input.lookup, { orderId: "LH-BOOKING-1" });
        return createClaim();
      },
      logError: () => {},
      markProviderBookingEmailSent: async (input) => marked.push(input.holdId),
      recordProviderBookingEmailFailure: async (input) => failed.push(input),
      sendProviderBookingEmail: async (input) => sent.push(input),
    });

    assert.equal(sent.length, 1);
    assert.deepEqual(marked, ["hold-1"]);
    assert.deepEqual(failed, []);
  `);
});

test("provider booking delivery releases the claim and records a safe failure", () => {
  runProviderBookingEmailScenario(`
    const failures = [];
    const logs = [];

    await assert.rejects(
      sendProviderBookingEmailForOrder("LH-BOOKING-1", {
        claimProviderBookingEmail: async () => createClaim(),
        logError: (...args) => logs.push(args),
        markProviderBookingEmailSent: async () => assert.fail("must not mark sent"),
        recordProviderBookingEmailFailure: async (input) => failures.push(input),
        sendProviderBookingEmail: async () => { throw new Error("Resend unavailable"); },
      }),
      /Resend unavailable/,
    );

    assert.deepEqual(failures, [{ error: "Resend unavailable", holdId: "hold-1" }]);
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs).includes("client@example.com"), false);
    assert.equal(JSON.stringify(logs).includes("provider@example.com"), false);
  `);
});

function runProviderBookingEmailScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.TZ = "America/Toronto";
  delete env.EMAIL_PROFILE_IMAGE_URL;
  delete env.RESEND_TEMPLATE_PROVIDER_BOOKING_CONFIRMATION_ID;

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
