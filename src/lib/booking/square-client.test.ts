import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createSquareClient } from "./src/lib/booking/square-client.ts";

  function createPaymentLinkRequest() {
    return {
      idempotency_key: "booking-square-link-hold_123",
      order: {
        location_id: "LOC123",
        line_items: [{
          name: "Classic Fill deposit",
          quantity: "1",
          base_price_money: { amount: 5000, currency: "CAD" },
        }],
      },
      checkout_options: {
        allow_tipping: true,
        redirect_url: "https://lashher.test/api/booking/square/return",
      },
      payment_note: "Lash Her booking hold hold_123 order lh-123",
    };
  }
`;

test("Square client posts CreatePaymentLink with Square REST headers and body", () => {
  runSquareClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        payment_link: {
          id: "plink_123",
          order_id: "sorder_123",
          url: "https://square.link/u/123",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const response = await client.createPaymentLink(createPaymentLinkRequest());

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");
    assert.deepEqual(JSON.parse(requests[0].init.body), createPaymentLinkRequest());
    assert.equal(response.payment_link.id, "plink_123");
    assert.equal(response.payment_link.order_id, "sorder_123");
    assert.equal(response.payment_link.url, "https://square.link/u/123");
  `);
});

test("Square client uses production base URL when configured", () => {
  runSquareClientScenario(`
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ payment_link: { id: "plink_123", url: "https://square.link/u/123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createSquareClient({ environment: "production", accessToken: "square-secret-token" });
    await client.createPaymentLink(createPaymentLinkRequest());

    assert.equal(requestedUrl, "https://connect.squareup.com/v2/online-checkout/payment-links");
  `);
});

test("Square client errors are sanitized without access token or response body", () => {
  runSquareClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 401 });

    const client = createSquareClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createPaymentLink(createPaymentLinkRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 401");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square client network errors are sanitized without thrown token text", () => {
  runSquareClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquareClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createPaymentLink(createPaymentLinkRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

function runSquareClientScenario(assertions: string): void {
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
