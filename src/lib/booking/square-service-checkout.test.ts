import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildSquareServiceCheckoutIdempotencyKey,
    createSquareServiceCheckout,
  } from "./src/lib/booking/square-service-checkout.ts";

  const now = new Date("2026-05-22T14:00:00.000Z");

  function createHold(overrides = {}) {
    return {
      id: "hold-internal-1",
      publicReference: "hold_public_1",
      state: "held",
      expiresAt: new Date("2026-05-22T14:10:00.000Z"),
      selectedStart: new Date("2026-05-23T14:00:00.000Z"),
      selectedEnd: new Date("2026-05-23T15:00:00.000Z"),
      offeringId: "bookingOffering-classic-fill",
      offeringSnapshot: {
        title: "Classic Fill",
        depositAmount: 50,
        fullPrice: 150,
        currency: "CAD",
        selectedPayment: {
          amount: 50,
          description: "Classic Fill deposit",
          purpose: "appointment_deposit",
          sku: "BOOKING-DEPOSIT",
        },
      },
      customer: {
        name: "Client Name",
        email: "client@example.com",
        phone: "555-0100",
      },
      googleEventId: null,
      payment: null,
      createdAt: now,
      updatedAt: now,
      timezone: "America/Toronto",
      ...overrides,
    };
  }

  function createDependencies() {
    const clientRequests = [];
    const persisted = [];
    const pendingByHoldId = new Map();
    const dependencies = {
      getEnv: () => ({
        accessToken: "square-secret-token",
        environment: "sandbox",
        helcimLegacyCutoffAt: null,
        locationId: "LOC123",
        serviceBookingReturnUrl: "https://lashher.test/api/booking/square/return",
        serviceBookingWebhookUrl: "https://lashher.test/api/webhooks/square",
        webhookSignatureKey: "signature-key",
      }),
      repository: {
        async findPendingCheckoutForHold(holdId) {
          return pendingByHoldId.get(holdId) ?? null;
        },
        async persistPendingCheckout(input) {
          persisted.push(input);
          const record = {
            checkoutUrl: input.paymentLink.url,
            orderId: input.orderId,
            squareOrderId: input.paymentLink.order_id,
            squarePaymentLinkId: input.paymentLink.id,
          };
          pendingByHoldId.set(input.hold.id, record);
          return record;
        },
      },
      squareClientFactory: () => ({
        async createPaymentLink(request) {
          clientRequests.push(request);
          return {
            payment_link: {
              id: "plink_123",
              order_id: "sorder_123",
              url: "https://square.link/u/123",
            },
          };
        },
      }),
    };

    return { clientRequests, dependencies, pendingByHoldId, persisted };
  }
`;

test("Square service checkout creates payment link with idempotent booking body", () => {
  runSquareServiceScenario(`
    const hold = createHold();
    const { clientRequests, dependencies, persisted } = createDependencies();
    const checkout = createSquareServiceCheckout(dependencies);
    const result = await checkout({ hold, now });
    const expectedKey = buildSquareServiceCheckoutIdempotencyKey(hold, 5000);

    assert.equal(result.checkoutUrl, "https://square.link/u/123");
    assert.equal(result.holdReference, "hold_public_1");
    assert.equal(result.reused, false);
    assert.equal(result.squarePaymentLinkId, "plink_123");
    assert.equal(clientRequests.length, 1);
    assert.equal(clientRequests[0].idempotency_key, expectedKey);
    assert.equal(clientRequests[0].order.location_id, "LOC123");
    assert.equal(clientRequests[0].order.reference_id, result.orderId);
    assert.deepEqual(clientRequests[0].order.line_items, [{
      name: "Classic Fill deposit",
      quantity: "1",
      base_price_money: { amount: 5000, currency: "CAD" },
      note: "Lash Her BOOKING-DEPOSIT",
    }]);
    assert.deepEqual(clientRequests[0].order.metadata, {
      lh_hold_id: "hold-internal-1",
      lh_hold_reference: "hold_public_1",
      lh_order_id: result.orderId,
    });
    assert.deepEqual(clientRequests[0].checkout_options, {
      allow_tipping: true,
      redirect_url: "https://lashher.test/api/booking/square/return",
    });
    assert.equal(clientRequests[0].payment_note, "Lash Her booking hold hold_public_1 order " + result.orderId);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].idempotencyKey, expectedKey);
    assert.equal(persisted[0].locationId, "LOC123");
    assert.equal(persisted[0].paymentSelection.purpose, "appointment_deposit");
  `);
});

test("Square service checkout reuses local pending checkout without a second Square call", () => {
  runSquareServiceScenario(`
    const hold = createHold();
    const { clientRequests, dependencies, persisted } = createDependencies();
    const checkout = createSquareServiceCheckout(dependencies);

    const first = await checkout({ hold, now });
    const second = await checkout({ hold, now });

    assert.equal(first.checkoutUrl, "https://square.link/u/123");
    assert.equal(second.checkoutUrl, first.checkoutUrl);
    assert.equal(second.orderId, first.orderId);
    assert.equal(second.reused, true);
    assert.equal(clientRequests.length, 1);
    assert.equal(persisted.length, 1);
  `);
});

test("Square service checkout rejects expired holds before calling Square", () => {
  runSquareServiceScenario(`
    const hold = createHold({ expiresAt: new Date("2026-05-22T13:59:59.000Z") });
    const { clientRequests, dependencies, persisted } = createDependencies();
    const checkout = createSquareServiceCheckout(dependencies);

    await assert.rejects(
      () => checkout({ hold, now }),
      /Booking hold is no longer available/,
    );

    assert.equal(clientRequests.length, 0);
    assert.equal(persisted.length, 0);
  `);
});

test("Square service checkout rejects holds without configured payment policy", () => {
  runSquareServiceScenario(`
    const hold = createHold({ offeringSnapshot: { title: "Classic Fill", currency: "CAD" } });
    const { clientRequests, dependencies, persisted } = createDependencies();
    const checkout = createSquareServiceCheckout(dependencies);

    await assert.rejects(
      () => checkout({ hold, now }),
      /Booking payment is not configured/,
    );

    assert.equal(clientRequests.length, 0);
    assert.equal(persisted.length, 0);
  `);
});

function runSquareServiceScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
}
