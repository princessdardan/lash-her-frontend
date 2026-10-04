import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBookingCheckoutPostHandler } from "./src/app/api/booking/checkout/handler.ts";

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
      createdAt: new Date(),
      updatedAt: new Date(),
      timezone: "America/Toronto",
      ...overrides,
    };
  }

  function runScenario(hold = createHold()) {
    const reads = [];
    const handler = createBookingCheckoutPostHandler({
      getAppointmentHoldByPaymentSessionReference: async (reference) => { reads.push(reference); return hold; },
      getAppointmentHoldByPublicReference: async (reference) => { reads.push(reference); return hold; },
    });
    return { handler, reads };
  }

  async function parseJson(response) {
    return response.json();
  }
`;

test("legacy checkout refuses new payment links without modifying the hold", () => {
  runRouteScenario(`
    const hold = createHold();
    const before = structuredClone(hold);
    const { handler } = runScenario(hold);
    const response = await handler(createRequest({ paymentSessionReference: "existing-session" }));
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "SERVICE_BOOKING_MOVED");
    assert.deepEqual(hold, before);
  `);
});

test("legacy checkout retrieves an existing eligible link without provider calls or writes", () => {
  runRouteScenario(`
    const hold = createHold({ state: "payment_pending", paymentProvider: "square", squarePaymentLinkUrl: "https://square.link/u/existing", squarePaymentLinkId: "link-1", checkoutOrderPublicId: "order-1", squareOrderId: "square-1" });
    const before = structuredClone(hold);
    globalThis.fetch = async () => { throw new Error("Provider calls forbidden"); };
    const { handler, reads } = runScenario(hold);
    for (const body of [{ holdReference: "public-reference" }, { paymentSessionReference: "private-session" }]) {
      const response = await handler(createRequest(body));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { checkoutUrl: "https://square.link/u/existing", holdReference: hold.publicReference, orderId: "order-1", paymentProvider: "square", reused: true, squareOrderId: "square-1", squarePaymentLinkId: "link-1" });
    }
    assert.deepEqual(reads, ["public-reference", "private-session"]);
    assert.deepEqual(hold, before);
  `);
});

test("legacy checkout rejects missing, expired, and terminal holds", () => {
  runRouteScenario(`
    for (const hold of [null, createHold({ expiresAt: new Date(0) }), createHold({ state: "payment_pending", expiresAt: new Date(0) }), createHold({ state: "booked" }), createHold({ state: "released" })]) {
      const { handler } = runScenario(hold);
      assert.equal((await handler(createRequest({ holdReference: "old" }))).status, 409);
    }
    for (const hold of [createHold({ state: "payment_pending" }), createHold({ offeringSnapshot: {} })]) {
      const { handler } = runScenario(hold);
      const before = structuredClone(hold);
      assert.equal((await handler(createRequest({ holdReference: "old" }))).status, 410);
      assert.deepEqual(hold, before);
    }
  `);
});

test("legacy checkout validates reference shape before reading the database", () => {
  runRouteScenario(`
    const { handler, reads } = runScenario();
    for (const body of ["{", {}, { holdReference: "one", paymentSessionReference: "two" }]) {
      assert.equal((await handler(createRequest(body))).status, 400);
    }
    assert.deepEqual(reads, []);
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync("./node_modules/.bin/tsx", ["--eval", scenario], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}
