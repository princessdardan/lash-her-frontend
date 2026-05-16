import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createCheckoutPostHandler } from "./src/app/api/checkout/route.ts";

  const product = {
    _id: "product-lash-cleanser",
    sku: "LASH-CLEANSER",
    title: "Lash Cleanser",
    price: 24,
    currency: "CAD",
    isAvailable: true,
  };

  function createRequest(body) {
    return new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function runScenario({
    createHelcimInvoice,
    createPendingOrder,
    getSellableProductsByIds,
    initializeHelcimPay,
  } = {}) {
    const fetchedProductIds = [];
    const invoices = [];
    const orders = [];
    const paySessions = [];
    const handler = createCheckoutPostHandler({
      getSellableProductsByIds: async (ids) => {
        fetchedProductIds.push(ids);
        if (getSellableProductsByIds) {
          return getSellableProductsByIds(ids);
        }
        return [product];
      },
      createHelcimInvoice: async (input) => {
        invoices.push(input);
        if (createHelcimInvoice) {
          return createHelcimInvoice(input);
        }
        return { invoiceId: 4242, invoiceNumber: "INV-4242" };
      },
      initializeHelcimPay: async (input) => {
        paySessions.push(input);
        if (initializeHelcimPay) {
          return initializeHelcimPay(input);
        }
        return { checkoutToken: "checkout-token-4242", secretToken: "secret-token-4242" };
      },
      createPendingOrder: async (input) => {
        orders.push(input);
        if (createPendingOrder) {
          return createPendingOrder(input);
        }
        return { _id: "pending-order-4242" };
      },
    });

    return { fetchedProductIds, handler, invoices, orders, paySessions };
  }
`;

test("checkout route rejects invalid requests before downstream calls", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, invoices, orders, paySessions } = runScenario();

    const response = await handler(createRequest({ customer: { name: "Nataliea" }, items: [] }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid checkout request" });
    assert.equal(fetchedProductIds.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route creates Helcim checkout for a valid cart", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, invoices, orders, paySessions } = runScenario();

    const response = await handler(createRequest({
      customer: { name: "  Nataliea Lash  ", email: "client@example.com" },
      items: [{ productId: "product-lash-cleanser", quantity: 2 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { checkoutToken: "checkout-token-4242" });
    assert.deepEqual(fetchedProductIds, [["product-lash-cleanser"]]);
    assert.deepEqual(invoices, [{
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Lash Her website checkout",
      lineItems: [{
        sku: "LASH-CLEANSER",
        description: "Lash Cleanser",
        quantity: 2,
        price: 24,
      }],
    }]);
    assert.deepEqual(paySessions, [{
      paymentType: "purchase",
      amount: 48,
      currency: "CAD",
      invoiceNumber: "INV-4242",
    }]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].customerName, "Nataliea Lash");
    assert.equal(orders[0].customerEmail, "client@example.com");
    assert.equal(orders[0].checkoutToken, "checkout-token-4242");
    assert.equal(orders[0].secretToken, "secret-token-4242");
    assert.equal(orders[0].helcimInvoiceId, 4242);
    assert.equal(orders[0].helcimInvoiceNumber, "INV-4242");
    assert.equal(orders[0].cart.amount, 48);
  `);
});

test("checkout route returns a generic failure when downstream checkout setup fails", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      initializeHelcimPay: async () => {
        throw new Error("Helcim unavailable");
      },
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 1);
    assert.equal(paySessions.length, 1);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route returns a generic failure when pending order persistence fails", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      createPendingOrder: async () => {
        throw new Error("Database unavailable");
      },
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 1);
    assert.equal(paySessions.length, 1);
    assert.equal(orders.length, 1);
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
