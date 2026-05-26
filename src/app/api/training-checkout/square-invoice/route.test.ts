import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createTrainingSquareInvoicePostHandler } from "./src/app/api/training-checkout/square-invoice/route.ts";

  class SquareInvoiceBNPLUnavailableError extends Error {
    constructor() {
      super("Square invoice buy now, pay later is unavailable");
      this.name = "SquareInvoiceBNPLUnavailableError";
    }
  }

  class SquareInvoicePublishError extends Error {
    constructor() {
      super("Square invoice publish failed with status 400");
      this.name = "SquareInvoicePublishError";
    }
  }

  const program = {
    _id: "training-program-classic-lash",
    slug: "classic-lash-training",
    title: "Classic Lash Training",
    checkoutEnabled: true,
    price: 1499,
    currency: "CAD",
    isAvailable: true,
  };

  function createRequest(body) {
    return new Request("http://localhost:3000/api/training-checkout/square-invoice", {
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
    createInvoice,
    getTrainingProgramBySlug,
    isEnabled = () => true,
    publishInvoice,
  } = {}) {
    const customers = [];
    const fetchedPromotionCodes = [];
    const fetchedSlugs = [];
    const invoices = [];
    const orders = [];
    const pendingOrders = [];
    const publications = [];
    const publishedInvoices = [];
    const squareOrders = [];
    const handler = createTrainingSquareInvoicePostHandler({
      createCheckoutToken: () => "checkout-token-123",
      createCorrelationId: () => "correlation-123",
      createPendingSquareInvoiceOrder: async (input) => {
        pendingOrders.push(input);
        return {
          _id: "db-order-123",
          orderId: "lh-training-123",
        };
      },
      createSecretToken: () => "secret-token-123",
      getPromotionCode: async (code) => {
        fetchedPromotionCodes.push(code);
        return null;
      },
      getTrainingProgramBySlug: async (slug) => {
        fetchedSlugs.push(slug);
        if (getTrainingProgramBySlug) {
          return getTrainingProgramBySlug(slug);
        }
        return program;
      },
      isEnabled,
      locationId: "LOC123",
      recordSquareInvoicePublication: async (...args) => {
        publications.push(args);
      },
      squareInvoiceClient: {
        createCustomer: async (email, givenName, familyName) => {
          customers.push({ email, givenName, familyName });
          return "square-customer-123";
        },
        createOrder: async (locationId, lineItems, referenceId) => {
          squareOrders.push({ locationId, lineItems, referenceId });
          return "square-order-123";
        },
        createInvoice: async (orderId, customerId, paymentRequest) => {
          invoices.push({ orderId, customerId, paymentRequest });
          if (createInvoice) {
            return createInvoice(orderId, customerId, paymentRequest);
          }
          return { id: "square-invoice-123", version: 1 };
        },
        publishInvoice: async (invoiceId, version, idempotencyKey) => {
          publishedInvoices.push({ invoiceId, version, idempotencyKey });
          if (publishInvoice) {
            return publishInvoice(invoiceId, version, idempotencyKey);
          }
          return { id: invoiceId, publicUrl: "https://square.test/invoices/123", version: 2 };
        },
        getInvoice: async () => ({ id: "square-invoice-123" }),
      },
    });

    return {
      customers,
      fetchedPromotionCodes,
      fetchedSlugs,
      handler,
      invoices,
      orders,
      pendingOrders,
      publications,
      publishedInvoices,
      squareOrders,
    };
  }
`;

test("training Square invoice route returns 404 when the feature is disabled", () => {
  runRouteScenario(`
    const { customers, fetchedSlugs, handler, invoices, pendingOrders, publications, publishedInvoices, squareOrders } = runScenario({
      isEnabled: () => false,
    });

    const response = await handler(createRequest(validBody()));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Training Square invoice checkout is unavailable" });
    assert.equal(fetchedSlugs.length, 0);
    assert.equal(customers.length, 0);
    assert.equal(squareOrders.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(pendingOrders.length, 0);
    assert.equal(publishedInvoices.length, 0);
    assert.equal(publications.length, 0);
  `);
});

test("training Square invoice route rejects unknown slugs before Square calls", () => {
  runRouteScenario(`
    const { customers, fetchedSlugs, handler, invoices, pendingOrders, publications, publishedInvoices, squareOrders } = runScenario({
      getTrainingProgramBySlug: async () => null,
    });

    const response = await handler(createRequest(validBody()));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid training checkout request" });
    assert.deepEqual(fetchedSlugs, ["classic-lash-training"]);
    assert.equal(customers.length, 0);
    assert.equal(squareOrders.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(pendingOrders.length, 0);
    assert.equal(publishedInvoices.length, 0);
    assert.equal(publications.length, 0);
  `);
});

test("training Square invoice route maps BNPL unavailable to 422", () => {
  runRouteScenario(`
    const { customers, handler, invoices, pendingOrders, publications, publishedInvoices, squareOrders } = runScenario({
      createInvoice: async () => {
        throw new SquareInvoiceBNPLUnavailableError();
      },
    });

    const response = await handler(createRequest(validBody()));

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "Buy now, pay later is unavailable for this training checkout" });
    assert.equal(customers.length, 1);
    assert.equal(squareOrders.length, 1);
    assert.equal(invoices.length, 1);
    assert.equal(pendingOrders.length, 0);
    assert.equal(publishedInvoices.length, 0);
    assert.equal(publications.length, 0);
  `);
});

test("training Square invoice route maps publish failures to 502 after storing the draft order", () => {
  runRouteScenario(`
    const { handler, invoices, pendingOrders, publications, publishedInvoices } = runScenario({
      publishInvoice: async () => {
        throw new SquareInvoicePublishError();
      },
    });

    const response = await handler(createRequest(validBody()));

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Unable to publish Square invoice" });
    assert.equal(invoices.length, 1);
    assert.equal(pendingOrders.length, 1);
    assert.equal(pendingOrders[0].squareInvoiceId, "square-invoice-123");
    assert.equal(publishedInvoices.length, 1);
    assert.equal(publications.length, 0);
  `);
});

test("training Square invoice route creates and publishes a BNPL invoice for a valid request", () => {
  runRouteScenario(`
    const {
      customers,
      fetchedPromotionCodes,
      fetchedSlugs,
      handler,
      invoices,
      pendingOrders,
      publications,
      publishedInvoices,
      squareOrders,
    } = runScenario();

    const response = await handler(createRequest(validBody({ promotionCode: " " })));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      publicUrl: "https://square.test/invoices/123",
      orderId: "lh-training-123",
    });
    assert.deepEqual(fetchedSlugs, ["classic-lash-training"]);
    assert.deepEqual(fetchedPromotionCodes, []);
    assert.deepEqual(customers, [{
      email: "client@example.com",
      givenName: "Nataliea",
      familyName: "Lash",
    }]);
    assert.deepEqual(squareOrders, [{
      locationId: "LOC123",
      referenceId: "correlation-123",
      lineItems: [{
        name: "Classic Lash Training",
        quantity: "1",
        base_price_money: { amount: 169387, currency: "CAD" },
        note: "Training enrollment with Ontario HST",
      }],
    }]);
    assert.deepEqual(invoices, [{
      orderId: "square-order-123",
      customerId: "square-customer-123",
      paymentRequest: { idempotencyKey: "correlation-123-invoice" },
    }]);
    assert.deepEqual(pendingOrders, [{
      amountCents: 169387,
      checkoutToken: "checkout-token-123",
      correlationId: "correlation-123",
      customerEmail: "client@example.com",
      customerName: "Nataliea Lash",
      programSlug: "classic-lash-training",
      secretToken: "secret-token-123",
      squareCustomerId: "square-customer-123",
      squareInvoiceId: "square-invoice-123",
      squareInvoiceVersion: 1,
      squareOrderId: "square-order-123",
    }]);
    assert.deepEqual(publishedInvoices, [{
      invoiceId: "square-invoice-123",
      version: 1,
      idempotencyKey: "correlation-123-publish",
    }]);
    assert.deepEqual(publications, [[
      "lh-training-123",
      "square-invoice-123",
      "https://square.test/invoices/123",
      2,
    ]]);
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  delete env.PAYMENT_GATEWAY_MODE;
  delete env.PAYMENT_MOCK_DEFAULT_SCENARIO;
  delete env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED;
  delete env.VERCEL_ENV;

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
