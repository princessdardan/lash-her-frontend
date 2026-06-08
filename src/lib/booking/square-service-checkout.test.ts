import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildSquareServiceCheckoutIdempotencyKey,
    createSquareServiceCheckout,
  } from "./src/lib/booking/square-service-checkout.ts";
  import {
    createSquareServiceBookingClient,
    getSquareServiceBookingRuntimeEnv,
  } from "./src/lib/booking/square-runtime.ts";

  const now = new Date("2026-05-22T14:00:00.000Z");

  function createHold(overrides = {}) {
    return {
      id: "hold-internal-1",
      publicReference: "hold_public_1",
      state: "held",
      expiresAt: new Date("2026-05-22T14:10:00.000Z"),
      selectedStart: new Date("2026-05-23T14:00:00.000Z"),
      selectedEnd: new Date("2026-05-23T15:00:00.000Z"),
      offeringId: "service-classic-fill",
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
    const expectedKey = buildSquareServiceCheckoutIdempotencyKey(hold, 5000, 5650);

    assert.equal(result.checkoutUrl, "https://square.link/u/123");
    assert.equal(result.holdReference, "hold_public_1");
    assert.equal(result.reused, false);
    assert.equal(result.squarePaymentLinkId, "plink_123");
    assert.equal(clientRequests.length, 1);
    assert.equal(clientRequests[0].idempotency_key, expectedKey);
    assert.equal(clientRequests[0].order.location_id, "LOC123");
    assert.equal(clientRequests[0].order.reference_id, result.orderId);
    assert.deepEqual(clientRequests[0].order.line_items, [{
      applied_taxes: [{ tax_uid: "ontario-hst" }],
      name: "Classic Fill deposit",
      quantity: "1",
      base_price_money: { amount: 5000, currency: "CAD" },
      note: "Lash Her BOOKING-DEPOSIT",
    }]);
    assert.deepEqual(clientRequests[0].order.taxes, [{
      name: "Ontario HST",
      percentage: "13",
      scope: "LINE_ITEM",
      type: "ADDITIVE",
      uid: "ontario-hst",
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
    assert.equal(persisted[0].amountCents, 5650);
    assert.deepEqual(persisted[0].taxQuote, {
      expectedAmountCents: 5650,
      policyVersion: "service-booking-hst-on-paid-today-v1",
      taxAmountCents: 650,
      taxableAmountCents: 5000,
      taxName: "Ontario HST",
      taxRate: 0.13,
    });
    assert.equal(persisted[0].paymentSelection.purpose, "appointment_deposit");
  `);
});

test("Square service checkout charges selected full payment amount when an add-on is selected", () => {
  runSquareServiceScenario(`
    const hold = createHold({
      offeringSnapshot: {
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
      },
    });
    const { clientRequests, dependencies } = createDependencies();
    const checkout = createSquareServiceCheckout(dependencies);
    await checkout({ hold, now });

    const request = clientRequests[0];
    assert.equal(request.order.line_items[0].base_price_money.amount, 17500);
    assert.deepEqual(request.order.line_items[0].applied_taxes, [{ tax_uid: "ontario-hst" }]);
    assert.deepEqual(request.order.taxes, [{
      name: "Ontario HST",
      percentage: "13",
      scope: "LINE_ITEM",
      type: "ADDITIVE",
      uid: "ontario-hst",
    }]);
    assert.equal(request.order.line_items[0].name, "Classic Fill full payment with Lash Bath");
  `);
});

test("Square service checkout charges only selected deposit when add-on is due later", () => {
  runSquareServiceScenario(`
    const hold = createHold({
      offeringSnapshot: {
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
          amount: 50,
          description: "Classic Fill deposit; Lash Bath due at appointment",
          purpose: "appointment_deposit",
          sku: "BOOKING-DEPOSIT",
        },
      },
    });
    const { clientRequests, dependencies } = createDependencies();
    const checkout = createSquareServiceCheckout(dependencies);
    await checkout({ hold, now });

    const request = clientRequests[0];
    assert.equal(request.order.line_items[0].base_price_money.amount, 5000);
    assert.notEqual(request.order.line_items[0].base_price_money.amount, 7500);
    assert.equal(request.order.line_items[0].name, "Classic Fill deposit; Lash Bath due at appointment");
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

test("Square service booking checkout mock mode creates a local payment link without Square credentials", () => {
  runSquareServiceScenario(`
    process.env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
    process.env.PAYMENT_GATEWAY_MODE = "mock";
    process.env.PAYMENT_MOCK_DEFAULT_SCENARIO = "success";
    delete process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_LOCATION_ID;
    delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    delete process.env.SQUARE_SERVICE_BOOKING_RETURN_URL;
    delete process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

    const hold = createHold();
    const persisted = [];
    const pendingByHoldId = new Map();
    const checkout = createSquareServiceCheckout({
      getEnv: getSquareServiceBookingRuntimeEnv,
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
      squareClientFactory: (env) => createSquareServiceBookingClient({
        env,
        now,
        request: new Request("http://localhost:3000/api/booking/checkout"),
      }),
    });
    const result = await checkout({ hold, now });

    assert.ok(result.checkoutUrl.startsWith("http://localhost:3000/api/booking/square/return?"));
    assert.match(result.checkoutUrl, /orderId=lh-sq-/);
    assert.match(result.checkoutUrl, /paymentId=mock-square-payment-1/);
    assert.equal(result.squarePaymentLinkId, "mock-square-payment-link-1");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].locationId, "mock-square-location");
  `);
});

test("Square service booking checkout rejects mock request controls unless mock mode is enabled", () => {
  runSquareServiceScenario(`
    process.env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
    process.env.PAYMENT_GATEWAY_MODE = "live";
    process.env.SQUARE_ENVIRONMENT = "sandbox";
    process.env.SQUARE_ACCESS_TOKEN = "square-token";
    process.env.SQUARE_LOCATION_ID = "LOC123";
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "signature-key";
    process.env.SQUARE_SERVICE_BOOKING_RETURN_URL = "https://lashher.test/api/booking/square/return";
    process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL = "https://lashher.test/api/webhooks/square";
    const request = new Request("http://localhost:3000/api/booking/checkout?mockPaymentScenario=success");
    const checkout = createSquareServiceCheckout({
      getEnv: getSquareServiceBookingRuntimeEnv,
      repository: createDependencies().dependencies.repository,
      squareClientFactory: (env) => createSquareServiceBookingClient({ env, now, request }),
    });

    await assert.rejects(
      () => checkout({ hold: createHold(), now }),
      /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/,
    );
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
