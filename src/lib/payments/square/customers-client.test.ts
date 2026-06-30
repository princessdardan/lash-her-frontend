import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createSquareCustomersClient, createSquareCustomer } from "./src/lib/payments/square/customers-client.ts";

  function createCustomerRequest() {
    return {
      idempotency_key: "cust-key-1",
      email_address: "client@example.com",
      given_name: "Nataliea",
      family_name: "Client",
      phone_number: "+14165550123",
      reference_id: "booking-hold-1",
    };
  }
`;

test("Square customers client posts to /v2/customers with Square REST headers and body", () => {
  runCustomersClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        customer: {
          id: "customer_123",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareCustomersClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const response = await client.createCustomer(createCustomerRequest());

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/customers");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");
    assert.deepEqual(JSON.parse(requests[0].init.body), createCustomerRequest());
    assert.equal(response.customer.id, "customer_123");
  `);
});

test("createSquareCustomer convenience helper posts to /v2/customers", () => {
  runCustomersClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        customer: {
          id: "customer_456",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const response = await createSquareCustomer(
      { environment: "sandbox", accessToken: "square-secret-token" },
      createCustomerRequest(),
    );

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/customers");
    assert.deepEqual(JSON.parse(requests[0].init.body), createCustomerRequest());
    assert.equal(response.customer.id, "customer_456");
  `);
});

test("Square customers client uses production base URL when configured", () => {
  runCustomersClientScenario(`
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ customer: { id: "customer_123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createSquareCustomersClient({ environment: "production", accessToken: "square-secret-token" });
    await client.createCustomer(createCustomerRequest());

    assert.equal(requestedUrl, "https://connect.squareup.com/v2/customers");
  `);
});

test("Square customers client errors are sanitized for non-2xx responses", () => {
  runCustomersClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 401 });

    const client = createSquareCustomersClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCustomer(createCustomerRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 401");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square customers client errors are sanitized for network failures", () => {
  runCustomersClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquareCustomersClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCustomer(createCustomerRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square customers client throws for malformed response", () => {
  runCustomersClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const client = createSquareCustomersClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCustomer(createCustomerRequest()),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("Square customers client errors are sanitized for non-JSON 2xx responses", () => {
  runCustomersClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquareCustomersClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCustomer(createCustomerRequest()),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

function runCustomersClientScenario(assertions: string): void {
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
