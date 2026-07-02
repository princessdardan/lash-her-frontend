import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createCheckoutPostHandler, resolveCheckoutHelcimGatewayForRequest } from "./src/app/api/checkout/route.ts";
  import {
    CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
    CHECKOUT_EMAIL_MAX_LENGTH,
    CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  } from "./src/lib/commerce/checkout-validation.ts";

  const product = {
    _id: "product-lash-cleanser",
    title: "Lash Cleanser",
    price: 24,
    currency: "CAD",
    isAvailable: true,
  };

  const shippingAddress = {
    line1: "646 Oakwood Avenue",
    city: "Toronto",
    province: "Ontario",
    postalCode: "M6E 2Y4",
    country: "Canada",
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
    getProductsByIds,
    getPromotionCode,
    initializeHelcimPay,
  } = {}) {
    const fetchedProductIds = [];
    const invoices = [];
    const orders = [];
    const paySessions = [];
    const handler = createCheckoutPostHandler({
      getProductsByIds: async (ids) => {
        fetchedProductIds.push(ids);
        if (getProductsByIds) {
          return getProductsByIds(ids);
        }
        return [product];
      },
      getPromotionCode: async (code) => {
        if (getPromotionCode) {
          return getPromotionCode(code);
        }
        return null;
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

test("checkout route rejects malformed customer and shipping fields before downstream calls", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, invoices, orders, paySessions } = runScenario();

    const invalidBodies = [
      {
        customer: { name: "Nataliea Lash", email: "client.example.com" },
        shippingAddress,
      },
      {
        customer: { name: "Nataliea Lash", email: "client@" },
        shippingAddress,
      },
      {
        customer: { name: "Nataliea Lash", email: "x".repeat(CHECKOUT_EMAIL_MAX_LENGTH + 1) + "@example.com" },
        shippingAddress,
      },
      {
        customer: { name: "x".repeat(CHECKOUT_CUSTOMER_NAME_MAX_LENGTH + 1), email: "client@example.com" },
        shippingAddress,
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, line1: "x".repeat(CHECKOUT_SHIPPING_LINE_MAX_LENGTH + 1) },
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, line2: "x".repeat(CHECKOUT_SHIPPING_LINE_MAX_LENGTH + 1) },
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, city: "Tor" + String.fromCharCode(10) + "onto" },
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, country: "x".repeat(CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH + 1) },
      },
    ];

    for (const body of invalidBodies) {
      const response = await handler(createRequest({
        ...body,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid checkout request" });
    }

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
      shippingAddress: { ...shippingAddress, line1: " 646 Oakwood Avenue ", line2: " Suite 2 " },
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
        sku: "product-lash-cleanser",
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
    assert.deepEqual(orders[0].shippingAddress, { ...shippingAddress, line2: "Suite 2" });
    assert.equal(orders[0].cart.amount, 48);
  `);
});

test("checkout route keeps promotion invoice totals aligned with Helcim Pay amount", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      getPromotionCode: async (code) => ({
        _id: "promo-save10",
        code,
        isEnabled: true,
        discountType: "percentage",
        amount: 10,
        appliesTo: "products",
      }),
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 2 }],
      promotionCode: "SAVE10",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checkoutToken: "checkout-token-4242" });
    assert.deepEqual(invoices, [{
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Lash Her website checkout",
      lineItems: [
        {
          sku: "product-lash-cleanser",
          description: "Lash Cleanser",
          quantity: 2,
          price: 24,
        },
        {
          sku: "SAVE10",
          description: "Promotion code SAVE10",
          quantity: 1,
          price: -4.8,
        },
      ],
    }]);
    assert.deepEqual(paySessions, [{
      paymentType: "purchase",
      amount: 43.2,
      currency: "CAD",
      invoiceNumber: "INV-4242",
    }]);
    const invoiceTotal = invoices[0].lineItems.reduce((total, item) => total + item.price * item.quantity, 0);
    assert.equal(invoiceTotal, paySessions[0].amount);
    assert.equal(orders[0].cart.amount, paySessions[0].amount);
    assert.equal(orders[0].cart.promotionCode, "SAVE10");
  `);
});

test("checkout route creates Helcim checkout without Square secrets", () => {
  runRouteScenario(`
    assert.equal(process.env.SERVICE_BOOKING_SQUARE_ENABLED, "true");
    assert.equal(process.env.SQUARE_ACCESS_TOKEN, undefined);

    const { handler, invoices, orders, paySessions } = runScenario();

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checkoutToken: "checkout-token-4242" });
    assert.equal(invoices.length, 1);
    assert.equal(paySessions.length, 1);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].helcimInvoiceId, 4242);
    assert.equal(orders[0].helcimInvoiceNumber, "INV-4242");
  `);
});

test("checkout route selects mock Helcim gateway when mock mode is allowed", () => {
  runRouteScenario(`
    process.env.PAYMENT_GATEWAY_MODE = "mock";
    process.env.PAYMENT_MOCK_DEFAULT_SCENARIO = "success";
    delete process.env.VERCEL_ENV;

    const gateway = await resolveCheckoutHelcimGatewayForRequest(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));

    const invoice = await gateway.createInvoice({
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Lash Her website checkout",
      lineItems: [{ sku: "product-lash-cleanser", description: "Lash Cleanser", quantity: 1, price: 24 }],
    });
    const paySession = await gateway.initializePay({
      paymentType: "purchase",
      amount: 24,
      currency: "CAD",
      invoiceNumber: invoice.invoiceNumber,
    });

    assert.equal(invoice.invoiceNumber, "MOCK-INV-1");
    assert.equal(paySession.checkoutToken, "mock_helcim_checkout_1");
    assert.equal(paySession.secretToken, "mock_helcim_secret_1");
  `);
});

test("checkout route rejects request mock controls unless mock mode is enabled", () => {
  runRouteScenario(`
    await assert.rejects(
      resolveCheckoutHelcimGatewayForRequest(new Request("http://localhost:3000/api/checkout", {
        method: "POST",
        headers: { "x-lash-payment-mock-scenario": "success" },
      })),
      /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/,
    );

    process.env.PAYMENT_GATEWAY_MODE = "live";

    await assert.rejects(
      resolveCheckoutHelcimGatewayForRequest(new Request("http://localhost:3000/api/checkout?mockPaymentScenario=success", {
        method: "POST",
      })),
      /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/,
    );
  `);
});

test("checkout route rejects request mock controls in production", () => {
  runRouteScenario(`
    process.env.VERCEL_ENV = "production";

    await assert.rejects(
      resolveCheckoutHelcimGatewayForRequest(new Request("http://localhost:3000/api/checkout", {
        method: "POST",
        headers: { "x-lash-payment-mock-scenario": "success" },
      })),
      /Payment mock mode is not allowed in production/,
    );
  `);
});

test("checkout route rejects mock Helcim gateway mode in production", () => {
  runRouteScenario(`
    process.env.PAYMENT_GATEWAY_MODE = "mock";
    process.env.VERCEL_ENV = "production";

    await assert.rejects(
      resolveCheckoutHelcimGatewayForRequest(createRequest({
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      })),
      /Payment mock mode is not allowed in production/,
    );
  `);
});

test("checkout route rejects unavailable Sanity products before Helcim setup", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      getProductsByIds: async () => [{ ...product, isAvailable: false }],
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects unavailable selected variants before Helcim setup", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      getProductsByIds: async () => [{
        ...product,
        variants: [{
          _key: "volume",
          availabilityLabel: "Sold Out",
          isAvailable: false,
          price: 32,
          title: "Volume",
        }],
      }],
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", variantId: "volume", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects missing canonical products before Helcim setup", () => {
  runRouteScenario(`
    const { handler, invoices } = runScenario({
      getProductsByIds: async () => [],
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));

    assert.equal(response.status, 400);
    assert.equal(invoices.length, 0);
  `);
});

test("checkout route returns a server failure when checkout input loading fails", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler, invoices, orders, paySessions } = runScenario({
        getProductsByIds: async () => {
          throw new Error("Sanity unavailable for client@example.com");
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(invoices.length, 0);
      assert.equal(paySessions.length, 0);
      assert.equal(orders.length, 0);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "load_checkout_inputs");
      assert.equal(logEntry.error, "Checkout initialization failed");
      assert.equal(logEntry.errorName, "Error");

      assert.equal(JSON.stringify(consoleCalls).includes("client@example.com"), false);
      assert.equal(JSON.stringify(consoleCalls).includes("Sanity unavailable"), false);
    } finally {
      console.log = originalConsoleLog;
    }
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
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 1);
    assert.equal(paySessions.length, 1);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects malformed Helcim invoice success responses before payment initialization", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler, invoices, orders, paySessions } = runScenario({
        createHelcimInvoice: async () => null,
      });

      const response = await handler(createRequest({
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(invoices.length, 1);
      assert.equal(paySessions.length, 0);
      assert.equal(orders.length, 0);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "create_helcim_invoice");
      assert.equal(logEntry.error, "Checkout provider response invalid");
      assert.equal(logEntry.errorName, "CheckoutProviderResponseError");
      assert.equal(logEntry.missingFields, "invoiceId,invoiceNumber");
      assert.equal(logEntry.provider, "helcim");
      assert.equal(logEntry.providerEndpoint, "invoice");
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route rejects malformed Helcim Pay success responses before persistence", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler, invoices, orders, paySessions } = runScenario({
        initializeHelcimPay: async () => null,
      });

      const response = await handler(createRequest({
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(invoices.length, 1);
      assert.equal(paySessions.length, 1);
      assert.equal(orders.length, 0);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "initialize_helcim_pay");
      assert.equal(logEntry.error, "Checkout provider response invalid");
      assert.equal(logEntry.errorName, "CheckoutProviderResponseError");
      assert.equal(logEntry.missingFields, "checkoutToken,secretToken");
      assert.equal(logEntry.provider, "helcim");
      assert.equal(logEntry.providerEndpoint, "helcim_pay");
    } finally {
      console.log = originalConsoleLog;
    }
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
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 1);
    assert.equal(paySessions.length, 1);
    assert.equal(orders.length, 1);
  `);
});

test("checkout route logs database causes without leaking query params", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const databaseError = new Error(
        'Failed query: insert into "checkout_orders" values ($1)\\nparams: dardemiri@gmail.com,secret-token-4242',
      );
      databaseError.name = "DrizzleQueryError";
      databaseError.cause = Object.assign(
        new Error('invalid input syntax for type uuid: "secret-token-4242" for dardemiri@gmail.com'),
        {
          code: "23505",
          constraint: "checkout_orders_order_id_unique",
          detail: "Key (customer_email)=(dardemiri@gmail.com) already exists.",
          table: "checkout_orders",
        },
      );

      const { handler } = runScenario({
        createPendingOrder: async () => {
          throw databaseError;
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Dardan Demiri", email: "dardemiri@gmail.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(consoleCalls.length, 1);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "persist_order");
      assert.equal(logEntry.error, "Database query failed");
      assert.equal(logEntry.errorName, "DrizzleQueryError");
      assert.deepEqual(logEntry.cause, {
        code: "23505",
        table: "checkout_orders",
        constraint: "checkout_orders_order_id_unique",
      });

      const serializedLog = JSON.stringify(consoleCalls);
      assert.equal(serializedLog.includes("dardemiri@gmail.com"), false);
      assert.equal(serializedLog.includes("secret-token-4242"), false);
      assert.equal(serializedLog.includes("params:"), false);
      assert.equal(serializedLog.includes("detail"), false);
      assert.equal(serializedLog.includes("invalid input syntax"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route logs undefined checkout order columns without raw database messages", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const databaseError = new Error(
        'Failed query: insert into "checkout_orders" values ($1)\\nparams: dardemiri@gmail.com,secret-token-4242',
      );
      databaseError.name = "DrizzleQueryError";
      databaseError.cause = Object.assign(
        new Error('column "product_confirmation_email_sent_at" does not exist'),
        {
          code: "42703",
          detail: "Query params included dardemiri@gmail.com and secret-token-4242.",
          severity: "ERROR",
        },
      );

      const { handler } = runScenario({
        createPendingOrder: async () => {
          throw databaseError;
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Dardan Demiri", email: "dardemiri@gmail.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(consoleCalls.length, 1);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "persist_order");
      assert.equal(logEntry.error, "Database query failed");
      assert.equal(logEntry.errorName, "DrizzleQueryError");
      assert.deepEqual(logEntry.cause, {
        code: "42703",
        severity: "ERROR",
        column: "product_confirmation_email_sent_at",
      });

      const serializedLog = JSON.stringify(consoleCalls);
      assert.equal(serializedLog.includes("dardemiri@gmail.com"), false);
      assert.equal(serializedLog.includes("secret-token-4242"), false);
      assert.equal(serializedLog.includes("params:"), false);
      assert.equal(serializedLog.includes("detail"), false);
      assert.equal(serializedLog.includes("does not exist"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route logs generic failure messages without leaking sensitive values", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler } = runScenario({
        initializeHelcimPay: async () => {
          throw new Error("Helcim unavailable for dardemiri@gmail.com with secret-token-4242");
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Dardan Demiri", email: "dardemiri@gmail.com" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(consoleCalls.length, 1);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "initialize_helcim_pay");
      assert.equal(logEntry.error, "Checkout initialization failed");
      assert.equal(logEntry.errorName, "Error");

      const serializedLog = JSON.stringify(consoleCalls);
      assert.equal(serializedLog.includes("dardemiri@gmail.com"), false);
      assert.equal(serializedLog.includes("secret-token-4242"), false);
      assert.equal(serializedLog.includes("Helcim unavailable"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("product checkout route remains Helcim-only and does not import Square modules", () => {
  const routeSource = readFileSync("src/app/api/checkout/route.ts", "utf8");

  assertNoSquareImports(routeSource);
});

function assertNoSquareImports(routeSource: string): void {
  if (/square|Square|SQUARE/.test(routeSource)) {
    throw new Error(
      "Helcim-only checkout route must not import or reference Square",
    );
  }
}

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  delete env.PAYMENT_GATEWAY_MODE;
  delete env.PAYMENT_MOCK_DEFAULT_SCENARIO;
  delete env.VERCEL_ENV;
  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete env.SQUARE_SERVICE_BOOKING_RETURN_URL;
  delete env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

  execFileSync("./node_modules/.bin/tsx", ["--eval", scenario], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}
