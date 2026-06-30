import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createSquareInvoicesClient,
    createSquareOrder,
    createSquareInvoice,
    publishSquareInvoice,
    deleteSquareInvoice,
  } from "./src/lib/payments/square/invoice-client.ts";

  function createOrderRequest() {
    return {
      idempotency_key: "order-key-1",
      order: {
        location_id: "L1A2B3C4D5E6F",
        reference_id: "no-show-1",
        source: { name: "Lash Her Booking No-Show" },
        metadata: { booking_id: "booking-1", reason: "no-show" },
        line_items: [
          {
            name: "No-show fee",
            quantity: "1",
            base_price_money: { amount: 5000, currency: "CAD" },
          },
        ],
      },
    };
  }

  function createInvoiceRequest(orderId: string) {
    return {
      idempotency_key: "invoice-key-1",
      invoice: {
        order_id: orderId,
        location_id: "L1A2B3C4D5E6F",
        primary_recipient: { customer_id: "customer_123" },
        accepted_payment_methods: { card: true },
        payment_requests: [
          {
            request_type: "BALANCE",
            due_date: "2026-06-20",
            automatic_payment_source: "CARD_ON_FILE",
            card_id: "card_123",
          },
        ],
        delivery_method: "EMAIL",
      },
    };
  }
`;

test("createSquareOrder posts to /v2/orders with Square REST headers and no-show line item", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        order: {
          id: "order_123",
          location_id: "L1A2B3C4D5E6F",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const request = createOrderRequest();
    const response = await client.createOrder(request);

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/orders");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");
    assert.deepEqual(JSON.parse(requests[0].init.body), request);
    assert.equal(response.order.id, "order_123");
    assert.equal(response.order.location_id, "L1A2B3C4D5E6F");
  `);
});

test("createSquareInvoice posts to /v2/invoices with card-on-file automatic payment", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        invoice: {
          id: "invoice_123",
          status: "DRAFT",
          order_id: "order_123",
          version: 1,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const request = createInvoiceRequest("order_123");
    const response = await client.createInvoice(request);

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");

    const body = JSON.parse(requests[0].init.body);
    assert.deepEqual(body.invoice.accepted_payment_methods, { card: true });
    assert.equal(body.invoice.delivery_method, "EMAIL");
    assert.equal(body.invoice.payment_requests[0].request_type, "BALANCE");
    assert.equal(body.invoice.payment_requests[0].due_date, "2026-06-20");
    assert.equal(body.invoice.payment_requests[0].automatic_payment_source, "CARD_ON_FILE");
    assert.equal(body.invoice.payment_requests[0].card_id, "card_123");
    assert.equal(response.invoice.id, "invoice_123");
    assert.equal(response.invoice.status, "DRAFT");
    assert.equal(response.invoice.order_id, "order_123");
    assert.equal(response.invoice.version, 1);
  `);
});

test("publishSquareInvoice URL-encodes invoice IDs with reserved characters", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        invoice: { id: "inv:abc/123", status: "UNPAID", order_id: "order_123", version: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const response = await client.publishInvoice("inv:abc/123", { idempotency_key: "publish-key-3", version: 1 });

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/inv%3Aabc%2F123/publish");
    assert.equal(response.invoice.status, "UNPAID");
  `);
});

test("publishSquareInvoice posts to /v2/invoices/{invoiceId}/publish with idempotency key", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        invoice: {
          id: "invoice_123",
          status: "UNPAID",
          order_id: "order_123",
          version: 2,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const response = await client.publishInvoice("invoice_123", { idempotency_key: "publish-key-1", version: 1 });

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/invoice_123/publish");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].init.body), { idempotency_key: "publish-key-1", version: 1 });
    assert.equal(response.invoice.id, "invoice_123");
    assert.equal(response.invoice.status, "UNPAID");
    assert.equal(response.invoice.version, 2);
  `);
});

test("deleteSquareInvoice sends DELETE to /v2/invoices/{invoiceId} with optional version", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 200 });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    await client.deleteInvoice("invoice_123", 2);

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/invoice_123?version=2");
    assert.equal(requests[0].init.method, "DELETE");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");
  `);
});

test("deleteSquareInvoice omits version query when version not provided", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 200 });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    await client.deleteInvoice("invoice_123");

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/invoice_123");
    assert.equal(requests[0].init.method, "DELETE");
  `);
});

test("deleteSquareInvoice URL-encodes invoice IDs with reserved characters", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 200 });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    await client.deleteInvoice("inv:abc/123", 1);

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/inv%3Aabc%2F123?version=1");
  `);
});

test("createSquareOrder convenience helper posts to /v2/orders", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        order: { id: "order_456", location_id: "L1A2B3C4D5E6F" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const request = createOrderRequest();
    const response = await createSquareOrder(
      { environment: "sandbox", accessToken: "square-secret-token" },
      request,
    );

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/orders");
    assert.deepEqual(JSON.parse(requests[0].init.body), request);
    assert.equal(response.order.id, "order_456");
  `);
});

test("createSquareInvoice convenience helper posts to /v2/invoices", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        invoice: { id: "invoice_456", status: "DRAFT", order_id: "order_789", version: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const request = createInvoiceRequest("order_789");
    const response = await createSquareInvoice(
      { environment: "sandbox", accessToken: "square-secret-token" },
      request,
    );

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices");
    assert.deepEqual(JSON.parse(requests[0].init.body), request);
    assert.equal(response.invoice.id, "invoice_456");
  `);
});

test("publishSquareInvoice convenience helper posts to /v2/invoices/{invoiceId}/publish", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        invoice: { id: "invoice_789", status: "UNPAID", order_id: "order_123", version: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const response = await publishSquareInvoice(
      { environment: "sandbox", accessToken: "square-secret-token" },
      "invoice_789",
      { idempotency_key: "publish-key-2", version: 1 },
    );

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/invoice_789/publish");
    assert.equal(response.invoice.status, "UNPAID");
  `);
});

test("Square invoices client uses production base URL when configured", () => {
  runInvoicesClientScenario(`
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        order: { id: "order_123", location_id: "L1A2B3C4D5E6F" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareInvoicesClient({ environment: "production", accessToken: "square-secret-token" });
    await client.createOrder(createOrderRequest());

    assert.equal(requestedUrl, "https://connect.squareup.com/v2/orders");
  `);
});

test("Square invoices client errors are sanitized for non-2xx responses", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 401 });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createOrder(createOrderRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 401");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square invoices client errors are sanitized for network failures", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createInvoice(createInvoiceRequest("order_123")),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square invoices client throws for malformed response", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ invoice: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createInvoice(createInvoiceRequest("order_123")),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("Square invoices client errors are sanitized for non-JSON 2xx responses on createOrder", () => {
  runInvoicesClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createOrder(createOrderRequest()),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("Square invoices client errors are sanitized for non-JSON 2xx responses on createInvoice", () => {
  runInvoicesClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createInvoice(createInvoiceRequest("order_123")),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("Square invoices client errors are sanitized for non-JSON 2xx responses on publishInvoice", () => {
  runInvoicesClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.publishInvoice("invoice_123", { idempotency_key: "publish-key-4", version: 1 }),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquareInvoice URL-encodes invoice IDs", () => {
  runInvoicesClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        invoice: { id: "inv/1", status: "PAID", order_id: "order-1", version: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    await client.getInvoice("inv/1");

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/invoices/inv%2F1");
    assert.equal(requests[0].init.method, "GET");
  `);
});

test("getSquareInvoice returns invoice status, order_id, and version", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      invoice: { id: "invoice_123", status: "PAID", order_id: "order_123", version: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const response = await client.getInvoice("invoice_123");

    assert.equal(response.invoice.id, "invoice_123");
    assert.equal(response.invoice.status, "PAID");
    assert.equal(response.invoice.order_id, "order_123");
    assert.equal(response.invoice.version, 2);
  `);
});

test("getSquareInvoice errors are sanitized for non-2xx responses", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 404 });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getInvoice("invoice_123"),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 404");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("getSquareInvoice errors are sanitized for network failures", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getInvoice("invoice_123"),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("getSquareInvoice throws for malformed response", () => {
  runInvoicesClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ invoice: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getInvoice("invoice_123"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquareInvoice errors are sanitized for non-JSON 2xx responses", () => {
  runInvoicesClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquareInvoicesClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getInvoice("invoice_123"),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

function runInvoicesClientScenario(assertions: string): void {
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
