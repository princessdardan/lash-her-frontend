import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    SquareInvoiceBNPLUnavailableError,
    SquareInvoicePublishError,
    SquareInvoiceVersionConflictError,
    createSquareInvoiceClient,
    createTrainingAfterpaySquareInvoiceClient,
  } from "./src/lib/commerce/square-invoice-client.ts";

  const env = {
    environment: "sandbox",
    accessToken: "square-secret-token",
  };
`;

test("Square invoice client creates customer, OPEN order, draft invoice, publishes, and retrieves invoice", () => {
  runSquareInvoiceScenario(`
    const requests = [];

    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });

      if (String(url).endsWith("/v2/customers")) {
        return Response.json({ customer: { id: "customer_123" } });
      }

      if (String(url).endsWith("/v2/orders")) {
        return Response.json({ order: { id: "order_123" } });
      }

      if (String(url).endsWith("/v2/invoices")) {
        return Response.json({ invoice: { id: "invoice_123", version: 1 } });
      }

      if (String(url).endsWith("/v2/invoices/invoice_123/publish")) {
        return Response.json({ invoice: { id: "invoice_123", version: 2, public_url: "https://square.test/invoice_123" } });
      }

      if (String(url).endsWith("/v2/invoices/invoice_123")) {
        return Response.json({ invoice: { id: "invoice_123", version: 2, public_url: "https://square.test/invoice_123", status: "UNPAID" } });
      }

      if (String(url).endsWith("/v2/orders/order_123")) {
        return Response.json({ order: { id: "order_123", reference_id: "training-enrollment-123" } });
      }

      return Response.json({ errors: [{ detail: "unexpected URL" }] }, { status: 404 });
    };

    const client = createSquareInvoiceClient(env);
    const customerId = await client.createCustomer("client@example.com", "Client", "Example");
    const orderId = await client.createOrder("LOC123", [{
      name: "Classic Lash Training",
      quantity: "1",
      base_price_money: { amount: 120000, currency: "CAD" },
      note: "Training enrollment",
    }], "training-enrollment-123");
    const draftInvoice = await client.createInvoice(orderId, customerId, {
      dueDate: "2026-06-01",
      idempotencyKey: "invoice-create-123",
    });
    const publishedInvoice = await client.publishInvoice(draftInvoice.id, draftInvoice.version, "invoice-publish-123");
    const invoice = await client.getInvoice(publishedInvoice.id);
    const order = await client.getOrder(orderId);

    assert.equal(customerId, "customer_123");
    assert.equal(orderId, "order_123");
    assert.deepEqual(draftInvoice, { id: "invoice_123", version: 1 });
    assert.deepEqual(publishedInvoice, {
      id: "invoice_123",
      publicUrl: "https://square.test/invoice_123",
      version: 2,
    });
    assert.equal(invoice.id, "invoice_123");
    assert.equal(invoice.public_url, "https://square.test/invoice_123");
    assert.deepEqual(order, { id: "order_123", reference_id: "training-enrollment-123" });

    const customerRequest = JSON.parse(requests[0].init.body);
    assert.deepEqual(customerRequest, {
      email_address: "client@example.com",
      given_name: "Client",
      family_name: "Example",
    });

    const orderRequest = JSON.parse(requests[1].init.body);
    assert.equal(orderRequest.idempotency_key, "training-enrollment-123-order");
    assert.equal(orderRequest.order.location_id, "LOC123");
    assert.equal(orderRequest.order.state, "OPEN");
    assert.equal(orderRequest.order.reference_id, "training-enrollment-123");
    assert.equal(orderRequest.order.line_items[0].base_price_money.currency, "CAD");

    const invoiceRequest = JSON.parse(requests[2].init.body);
    assert.equal(invoiceRequest.idempotency_key, "invoice-create-123");
    assert.equal(invoiceRequest.invoice.order_id, "order_123");
    assert.equal(invoiceRequest.invoice.primary_recipient.customer_id, "customer_123");
    assert.equal(invoiceRequest.invoice.delivery_method, "SHARE_MANUALLY");
    assert.deepEqual(invoiceRequest.invoice.accepted_payment_methods, {
      buy_now_pay_later: true,
    });
    assert.equal(invoiceRequest.invoice.payment_requests.length, 1);
    assert.equal(invoiceRequest.invoice.payment_requests[0].request_type, "BALANCE");
    assert.equal(invoiceRequest.invoice.payment_requests[0].due_date, "2026-06-01");
    assert.equal("accepted_payment_methods" in invoiceRequest.invoice.payment_requests[0], false);

    const publishRequest = JSON.parse(requests[3].init.body);
    assert.deepEqual(publishRequest, {
      version: 1,
      idempotency_key: "invoice-publish-123",
    });

    for (const request of requests) {
      assert.equal(request.init.headers.authorization, "Bearer square-secret-token");
      assert.equal(request.init.headers["square-version"], "2026-05-20");
      assert.equal(request.init.cache, "no-store");
    }
  `);
});

test("Square invoice client defaults omitted due dates to the current UTC date", () => {
  runSquareInvoiceScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ invoice: { id: "invoice_123", version: 1 } });
    };

    const client = createSquareInvoiceClient({
      ...env,
      now: () => new Date("2026-07-04T23:30:00.000Z"),
    });

    await client.createInvoice("order_123", "customer_123", { idempotencyKey: "invoice-create-123" });

    const invoiceRequest = JSON.parse(requests[0].init.body);
    assert.deepEqual(invoiceRequest.invoice.accepted_payment_methods, {
      buy_now_pay_later: true,
    });
    assert.equal(invoiceRequest.invoice.payment_requests.length, 1);
    assert.equal(invoiceRequest.invoice.payment_requests[0].request_type, "BALANCE");
    assert.equal(invoiceRequest.invoice.payment_requests[0].due_date, "2026-07-04");
    assert.equal("accepted_payment_methods" in invoiceRequest.invoice.payment_requests[0], false);
  `);
});

test("Square invoice client uses production base URL when configured", () => {
  runSquareInvoiceScenario(`
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return Response.json({ customer: { id: "customer_123" } });
    };

    const client = createSquareInvoiceClient({ environment: "production", accessToken: "square-secret-token" });
    await client.createCustomer("client@example.com", "Client", "Example");

    assert.equal(requestedUrl, "https://connect.squareup.com/v2/customers");
  `);
});

test("Square invoice client blocks API calls when explicitly disabled", () => {
  runSquareInvoiceScenario(`
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return Response.json({ customer: { id: "customer_123" } });
    };

    const client = createSquareInvoiceClient({ environment: "sandbox", accessToken: "square-secret-token", enabled: false });

    await assert.rejects(
      () => client.createCustomer("client@example.com", "Client", "Example"),
      /Square invoice checkout is not enabled/,
    );
    assert.equal(fetchCalled, false);
  `);
});

test("Square invoice client throws typed BNPL unavailable errors", () => {
  runSquareInvoiceScenario(`
    globalThis.fetch = async () => Response.json({
      errors: [{ code: "BAD_REQUEST", detail: "buy_now_pay_later is not available for this invoice" }],
    }, { status: 400 });

    const client = createSquareInvoiceClient(env);

    await assert.rejects(
      () => client.createInvoice("order_123", "customer_123", { idempotencyKey: "invoice-create-123" }),
      SquareInvoiceBNPLUnavailableError,
    );
  `);
});

test("Square invoice client throws typed publish and version conflict errors", () => {
  runSquareInvoiceScenario(`
    const responses = [
      Response.json({ errors: [{ code: "VERSION_MISMATCH", detail: "Invoice version conflict" }] }, { status: 409 }),
      Response.json({ errors: [{ code: "BAD_REQUEST", detail: "Invoice cannot be published" }] }, { status: 400 }),
    ];
    globalThis.fetch = async () => responses.shift();

    const client = createSquareInvoiceClient(env);

    await assert.rejects(
      () => client.publishInvoice("invoice_123", 1, "publish-conflict"),
      SquareInvoiceVersionConflictError,
    );
    await assert.rejects(
      () => client.publishInvoice("invoice_123", 1, "publish-failure"),
      SquareInvoicePublishError,
    );
  `);
});

test("Square invoice client rejects malformed responses", () => {
  runSquareInvoiceScenario(`
    globalThis.fetch = async () => Response.json({ invoice: { id: "invoice_123" } });

    const client = createSquareInvoiceClient(env);

    await assert.rejects(
      () => client.createInvoice("order_123", "customer_123", { idempotencyKey: "invoice-create-123" }),
      /Square API response was malformed/,
    );
  `);
});

test("Square invoice client sanitizes transport failures", () => {
  runSquareInvoiceScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failure with square-secret-token");
    };

    const client = createSquareInvoiceClient(env);

    await assert.rejects(
      () => client.createCustomer("client@example.com", "Client", "Example"),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("training Square invoice factory stays disabled without feature flag", () => {
  runSquareInvoiceScenario(`
    delete process.env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED;
    delete process.env.SERVICE_BOOKING_SQUARE_ENABLED;
    delete process.env.SQUARE_ENVIRONMENT;
    delete process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_LOCATION_ID;

    assert.throws(
      () => createTrainingAfterpaySquareInvoiceClient(),
      /Square invoice checkout is not enabled/,
    );
  `);
});

test("training Square invoice factory requires shared Square credentials when enabled", () => {
  runSquareInvoiceScenario(`
    process.env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED = "true";
    delete process.env.SERVICE_BOOKING_SQUARE_ENABLED;
    delete process.env.SQUARE_ENVIRONMENT;
    delete process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_LOCATION_ID;
    delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    delete process.env.SQUARE_SERVICE_BOOKING_RETURN_URL;
    delete process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

    assert.throws(
      () => createTrainingAfterpaySquareInvoiceClient(),
      /Missing env var: SQUARE_ENVIRONMENT/,
    );
  `);
});

test("training Square invoice factory does not require service booking Square env", () => {
  runSquareInvoiceScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ customer: { id: "customer_123" } });
    };

    process.env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED = "true";
    delete process.env.SERVICE_BOOKING_SQUARE_ENABLED;
    process.env.SQUARE_ENVIRONMENT = "sandbox";
    process.env.SQUARE_ACCESS_TOKEN = "square-secret-token";
    process.env.SQUARE_LOCATION_ID = "LOC123";
    delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    delete process.env.SQUARE_SERVICE_BOOKING_RETURN_URL;
    delete process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

    const client = createTrainingAfterpaySquareInvoiceClient();
    const customerId = await client.createCustomer("client@example.com", "Client", "Example");

    assert.equal(customerId, "customer_123");
    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/customers");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
  `);
});

function runSquareInvoiceScenario(assertions: string): void {
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
