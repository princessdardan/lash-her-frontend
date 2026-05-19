import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBookingCheckoutPostHandler } from "./src/app/api/booking/checkout/route.ts";

  const now = new Date("2026-05-18T12:00:00.000Z");
  const selectedStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  selectedStart.setUTCHours(14, 0, 0, 0);
  const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);

  const depositProduct = {
    _id: "deposit-product-1",
    sku: "LASH-DEPOSIT",
    title: "Lash Appointment Deposit",
    price: 50,
    currency: "CAD",
    isAvailable: true,
  };

  const fullProduct = {
    _id: "full-product-1",
    sku: "LASH-FULL",
    title: "Lash Appointment Full Payment",
    price: 150,
    currency: "CAD",
    isAvailable: true,
  };

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
        paymentMode: "deposit",
        depositProductId: "deposit-product-1",
      },
      customer: {
        name: "Client Name",
        email: "client@example.com",
        phone: "555-0100",
      },
      ...overrides,
    };
  }

  function runScenario(overrides = {}) {
    const createdOrders = [];
    const fetchedProductIds = [];
    const invoices = [];
    const paySessions = [];
    const transitions = [];
    const handler = createBookingCheckoutPostHandler({
      createHelcimInvoice: async (input) => {
        invoices.push(input);
        return { invoiceId: 4242, invoiceNumber: "INV-4242" };
      },
      createPendingOrder: async (input) => {
        createdOrders.push(input);
        return {
          _id: "checkout-order-1",
          orderId: "lh-order-1",
          purpose: input.purpose,
          secretToken: input.secretToken,
          helcimInvoiceId: input.helcimInvoiceId,
          helcimInvoiceNumber: input.helcimInvoiceNumber,
          amount: input.cart.amount,
          currency: input.cart.currency,
          customerEmail: input.customerEmail,
          customerName: input.customerName,
          lineItems: [],
        };
      },
      getAppointmentHoldByPublicReference: async (reference) => {
        assert.equal(reference, "hold_public_1");
        return createHold();
      },
      getSellableProductsByIds: async (ids) => {
        fetchedProductIds.push(ids);
        return ids.map((id) => id === "full-product-1" ? fullProduct : depositProduct);
      },
      initializeHelcimPay: async (input) => {
        paySessions.push(input);
        return { checkoutToken: "checkout-token-1", secretToken: "secret-token-1" };
      },
      transitionAppointmentHold: async (input) => {
        transitions.push(input);
        return createHold({
          checkoutOrderId: input.checkoutOrderId,
          checkoutOrderPublicId: input.checkoutOrderPublicId,
          state: "payment_pending",
        });
      },
      ...overrides,
    });

    return { createdOrders, fetchedProductIds, handler, invoices, paySessions, transitions };
  }

  async function parseJson(response) {
    return response.json();
  }
`;

test("booking checkout initializes Helcim for a held deposit appointment", () => {
  runRouteScenario(`
    const { createdOrders, fetchedProductIds, handler, invoices, paySessions, transitions } = runScenario();

    const response = await handler(createRequest({ holdReference: " hold_public_1 " }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      checkoutToken: "checkout-token-1",
      holdReference: "hold_public_1",
      orderId: "lh-order-1",
    });
    assert.deepEqual(fetchedProductIds, [["deposit-product-1"]]);
    assert.deepEqual(invoices, [{
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Lash Her booking checkout: Classic Fill",
      lineItems: [{
        sku: "LASH-DEPOSIT",
        description: "Lash Appointment Deposit",
        quantity: 1,
        price: 50,
      }],
    }]);
    assert.deepEqual(paySessions, [{
      paymentType: "purchase",
      amount: 50,
      currency: "CAD",
      invoiceNumber: "INV-4242",
    }]);
    assert.equal(createdOrders.length, 1);
    assert.equal(createdOrders[0].purpose, "appointment_deposit");
    assert.equal(createdOrders[0].customerName, "Client Name");
    assert.equal(createdOrders[0].customerEmail, "client@example.com");
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].holdId, "hold-internal-1");
    assert.equal(transitions[0].checkoutOrderId, "checkout-order-1");
    assert.equal(transitions[0].checkoutOrderPublicId, "lh-order-1");
    assert.equal(transitions[0].requiredState, "held");
    assert.equal(transitions[0].status, "payment_pending");
    assert.ok(transitions[0].expiresAfter instanceof Date);
  `);
});

test("booking checkout uses full payment product for customer-choice full payment", () => {
  runRouteScenario(`
    const { createdOrders, fetchedProductIds, handler, paySessions } = runScenario({
      getAppointmentHoldByPublicReference: async () => createHold({
        offeringSnapshot: {
          title: "Classic Fill",
          paymentMode: "choice",
          depositProductId: "deposit-product-1",
          fullProductId: "full-product-1",
        },
      }),
    });

    const response = await handler(createRequest({
      holdReference: "hold_public_1",
      paymentOption: "full",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(fetchedProductIds, [["full-product-1"]]);
    assert.equal(paySessions[0].amount, 150);
    assert.equal(createdOrders[0].purpose, "appointment_full");
  `);
});

test("booking checkout rejects expired or already-used holds before payment setup", () => {
  runRouteScenario(`
    const { createdOrders, fetchedProductIds, handler, invoices, paySessions } = runScenario({
      getAppointmentHoldByPublicReference: async () => createHold({
        expiresAt: new Date(Date.now() - 1000),
      }),
    });

    const response = await handler(createRequest({ holdReference: "hold_public_1" }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, { error: "Booking hold is no longer available" });
    assert.equal(fetchedProductIds.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(createdOrders.length, 0);
  `);
});

test("booking checkout returns conflict if hold transition loses the race", () => {
  runRouteScenario(`
    const { handler, transitions } = runScenario({
      transitionAppointmentHold: async (input) => {
        transitions.push(input);
        return null;
      },
    });

    const response = await handler(createRequest({ holdReference: "hold_public_1" }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.equal(transitions.length, 1);
    assert.deepEqual(body, { error: "Booking hold is no longer available" });
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
