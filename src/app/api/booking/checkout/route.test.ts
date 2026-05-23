import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBookingCheckoutPostHandler } from "./src/app/api/booking/checkout/route.ts";

  const selectedStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  selectedStart.setUTCHours(14, 0, 0, 0);
  const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);

  function createRequest(body) {
    return new Request("http://localhost:3000/api/booking/checkout", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function createHold(overrides = {}) {
    return {
      id: "hold-internal-1",
      publicReference: "hold_public_1",
      state: "held",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      selectedStart,
      selectedEnd,
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
      createdAt: new Date(),
      updatedAt: new Date(),
      timezone: "America/Toronto",
      ...overrides,
    };
  }

  function runScenario(overrides = {}) {
    const squareCheckouts = [];
    const fetchedReferences = [];
    const handler = createBookingCheckoutPostHandler({
      createSquareServiceBookingCheckout: async (input) => {
        squareCheckouts.push(input);
        return {
          checkoutUrl: "https://square.link/u/service-checkout",
          holdReference: input.hold.publicReference,
          orderId: "lh-sq-order-1",
          reused: false,
          squareOrderId: "square-order-1",
          squarePaymentLinkId: "square-payment-link-1",
        };
      },
      getAppointmentHoldByPublicReference: async (reference) => {
        fetchedReferences.push(reference);
        return createHold();
      },
      ...overrides,
    });

    return { fetchedReferences, handler, squareCheckouts };
  }

  async function parseJson(response) {
    return response.json();
  }
`;

test("booking checkout returns a Square hosted checkout URL for a held deposit appointment", () => {
  runRouteScenario(`
    const { fetchedReferences, handler, squareCheckouts } = runScenario();

    const response = await handler(createRequest({ holdReference: " hold_public_1 " }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      checkoutUrl: "https://square.link/u/service-checkout",
      holdReference: "hold_public_1",
      orderId: "lh-sq-order-1",
      paymentProvider: "square",
      reused: false,
      squareOrderId: "square-order-1",
      squarePaymentLinkId: "square-payment-link-1",
    });
    assert.deepEqual(fetchedReferences, ["hold_public_1"]);
    assert.equal(squareCheckouts.length, 1);
    assert.equal(squareCheckouts[0].hold.id, "hold-internal-1");
    assert.equal(squareCheckouts[0].hold.publicReference, "hold_public_1");
    assert.ok(squareCheckouts[0].now instanceof Date);
  `);
});

test("booking checkout uses the immutable full-payment hold snapshot for Square checkout", () => {
  runRouteScenario(`
    const { handler, squareCheckouts } = runScenario({
      getAppointmentHoldByPublicReference: async () => createHold({
        offeringSnapshot: {
          title: "Classic Fill",
          fullPrice: 150,
          currency: "CAD",
          selectedPayment: {
            amount: 150,
            description: "Classic Fill full payment",
            purpose: "appointment_full",
            sku: "BOOKING-FULL",
          },
        },
      }),
    });

    const response = await handler(createRequest({
      holdReference: "hold_public_1",
      paymentOption: "deposit",
    }));

    assert.equal(response.status, 200);
    assert.equal(squareCheckouts.length, 1);
    assert.equal(squareCheckouts[0].hold.offeringSnapshot.selectedPayment.amount, 150);
    assert.equal(squareCheckouts[0].hold.offeringSnapshot.selectedPayment.purpose, "appointment_full");
  `);
});

test("booking checkout supports custom partial hold snapshots for Square checkout", () => {
  runRouteScenario(`
    const { handler, squareCheckouts } = runScenario({
      getAppointmentHoldByPublicReference: async () => createHold({
        offeringSnapshot: {
          title: "Classic Fill",
          fullPrice: 150,
          currency: "CAD",
          selectedPayment: {
            amount: 100,
            description: "Classic Fill custom partial payment",
            purpose: "appointment_custom_partial",
            sku: "BOOKING-CUSTOM-PARTIAL",
          },
        },
      }),
    });

    const response = await handler(createRequest({
      holdReference: "hold_public_1",
      paymentOption: "full",
      customAmount: 1,
    }));

    assert.equal(response.status, 200);
    assert.equal(squareCheckouts.length, 1);
    assert.equal(squareCheckouts[0].hold.offeringSnapshot.selectedPayment.amount, 100);
    assert.equal(squareCheckouts[0].hold.offeringSnapshot.selectedPayment.purpose, "appointment_custom_partial");
  `);
});

test("booking checkout rejects holds without an immutable payment selection before Square checkout", () => {
  runRouteScenario(`
    const { handler, squareCheckouts } = runScenario({
      getAppointmentHoldByPublicReference: async () => createHold({
        offeringSnapshot: {
          title: "Classic Fill",
          fullPrice: 150,
          currency: "CAD",
        },
      }),
    });

    const response = await handler(createRequest({ holdReference: "hold_public_1" }));
    const responseBody = await parseJson(response);

    assert.equal(response.status, 400);
    assert.deepEqual(responseBody, { error: "Booking payment is not configured" });
    assert.equal(squareCheckouts.length, 0);
  `);
});

test("booking checkout rejects expired or already-used holds before Square checkout", () => {
  runRouteScenario(`
    const { handler, squareCheckouts } = runScenario({
      getAppointmentHoldByPublicReference: async () => createHold({
        expiresAt: new Date(Date.now() - 1000),
      }),
    });

    const response = await handler(createRequest({ holdReference: "hold_public_1" }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, { error: "Booking hold is no longer available" });
    assert.equal(squareCheckouts.length, 0);
  `);
});

test("booking checkout returns conflict if Square persistence loses the hold race", () => {
  runRouteScenario(`
    const { handler, squareCheckouts } = runScenario({
      createSquareServiceBookingCheckout: async (input) => {
        squareCheckouts.push(input);
        throw new Error("Booking hold is no longer available");
      },
    });

    const response = await handler(createRequest({ holdReference: "hold_public_1" }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.equal(squareCheckouts.length, 1);
    assert.deepEqual(body, { error: "Booking hold is no longer available" });
  `);
});

test("booking checkout returns generic failure when Square checkout setup fails", () => {
  runRouteScenario(`
    const { handler, squareCheckouts } = runScenario({
      createSquareServiceBookingCheckout: async (input) => {
        squareCheckouts.push(input);
        throw new Error("Square unavailable");
      },
    });

    const response = await handler(createRequest({ holdReference: "hold_public_1" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(squareCheckouts.length, 1);
    assert.deepEqual(body, { error: "Unable to start booking checkout" });
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
