import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createTrainingCheckoutPostHandler } from "./src/app/api/training-checkout/route.ts";

  const program = {
    _id: "training-program-classic-lash",
    slug: "classic-lash-training",
    title: "Classic Lash Training",
    checkoutEnabled: true,
    checkoutProduct: {
      _id: "product-classic-lash-training",
      kind: "training",
      sku: "TRAINING-CLASSIC",
      title: "Classic Lash Training Full Payment",
      price: 1499,
      currency: "CAD",
      isAvailable: true,
      variants: [],
    },
  };

  function createRequest(body) {
    return new Request("http://localhost:3000/api/training-checkout", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function validBody(overrides = {}) {
    return {
      programSlug: "classic-lash-training",
      programId: "training-program-classic-lash",
      customerName: "  Nataliea Lash  ",
      customerEmail: "CLIENT@EXAMPLE.COM ",
      clientPrice: 1499,
      ...overrides,
    };
  }

  function runScenario({
    createHelcimInvoice,
    createPendingOrder,
    createTrainingEnrollment,
    getTrainingProgramBySlug,
    initializeHelcimPay,
  } = {}) {
    const fetchedSlugs = [];
    const enrollments = [];
    const invoices = [];
    const orders = [];
    const paySessions = [];
    const handler = createTrainingCheckoutPostHandler({
      getTrainingProgramBySlug: async (slug) => {
        fetchedSlugs.push(slug);
        if (getTrainingProgramBySlug) {
          return getTrainingProgramBySlug(slug);
        }
        return program;
      },
      createHelcimInvoice: async (input) => {
        invoices.push(input);
        if (createHelcimInvoice) {
          return createHelcimInvoice(input);
        }
        return { invoiceId: 5252, invoiceNumber: "INV-TRAINING-5252" };
      },
      initializeHelcimPay: async (input) => {
        paySessions.push(input);
        if (initializeHelcimPay) {
          return initializeHelcimPay(input);
        }
        return { checkoutToken: "training-checkout-token", secretToken: "training-secret-token" };
      },
      createPendingOrder: async (input) => {
        orders.push(input);
        if (createPendingOrder) {
          return createPendingOrder(input);
        }
        return { _id: "pending-training-order-5252" };
      },
      createTrainingEnrollment: async (input) => {
        enrollments.push(input);
        if (createTrainingEnrollment) {
          return createTrainingEnrollment(input);
        }
        return { _id: "training-enrollment-5252" };
      },
    });

    return { enrollments, fetchedSlugs, handler, invoices, orders, paySessions };
  }
`;

test("training checkout route rejects invalid requests before downstream calls", () => {
  runRouteScenario(`
    const { enrollments, fetchedSlugs, handler, invoices, orders, paySessions } = runScenario();

    const response = await handler(createRequest({
      programSlug: " ",
      customerName: "Nataliea Lash",
      customerEmail: "client@example.com",
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid training checkout request" });
    assert.equal(fetchedSlugs.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
    assert.equal(enrollments.length, 0);
  `);
});

test("training checkout route rejects missing programs before payment setup", () => {
  runRouteScenario(`
    const { enrollments, fetchedSlugs, handler, invoices, orders, paySessions } = runScenario({
      getTrainingProgramBySlug: async () => null,
    });

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid training checkout request" });
    assert.deepEqual(fetchedSlugs, ["classic-lash-training"]);
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
    assert.equal(enrollments.length, 0);
  `);
});

test("training checkout route creates checkout and enrollment for a valid request", () => {
  runRouteScenario(`
    const { enrollments, fetchedSlugs, handler, invoices, orders, paySessions } = runScenario();

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { checkoutToken: "training-checkout-token" });
    assert.deepEqual(fetchedSlugs, ["classic-lash-training"]);
    assert.deepEqual(invoices, [{
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Lash Her training checkout: Classic Lash Training",
      lineItems: [{
        sku: "TRAINING-CLASSIC",
        description: "Classic Lash Training Full Payment",
        quantity: 1,
        price: 1499,
        taxAmount: 194.87,
        taxName: "Ontario HST",
        taxRate: 0.13,
      }],
    }]);
    assert.deepEqual(paySessions, [{
      paymentType: "purchase",
      amount: 1693.87,
      currency: "CAD",
      invoiceNumber: "INV-TRAINING-5252",
    }]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].customerName, "Nataliea Lash");
    assert.equal(orders[0].customerEmail, "client@example.com");
    assert.equal(orders[0].cart.amount, 1693.87);
    assert.deepEqual(enrollments, [{
      checkoutEmail: "client@example.com",
      checkoutOrderId: "pending-training-order-5252",
      programSnapshot: {
        id: "training-program-classic-lash",
        slug: "classic-lash-training",
        title: "Classic Lash Training",
      },
      productSnapshot: {
        id: "product-classic-lash-training",
        title: "Classic Lash Training Full Payment",
        sku: "TRAINING-CLASSIC",
        priceCents: 149900,
        currency: "CAD",
      },
    }]);
  `);
});

test("training checkout route returns a generic failure when enrollment write fails", () => {
  runRouteScenario(`
    const { enrollments, handler, invoices, orders, paySessions } = runScenario({
      createTrainingEnrollment: async () => {
        throw new Error("Private DB unavailable");
      },
    });

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start training checkout" });
    assert.equal(invoices.length, 1);
    assert.equal(paySessions.length, 1);
    assert.equal(orders.length, 1);
    assert.equal(enrollments.length, 1);
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
