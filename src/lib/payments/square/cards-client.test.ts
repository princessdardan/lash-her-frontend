import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createSquareCardsClient, createSquareCard } from "./src/lib/payments/square/cards-client.ts";

  function createCardRequest() {
    return {
      idempotency_key: "card-key-1",
      source_id: "cnon:card-token",
      verification_token: "verf-token",
      card: {
        customer_id: "cust_123",
        cardholder_name: "Client Name",
        reference_id: "hold_123",
        billing_address: {
          postal_code: "M6P1A1",
          country: "CA",
        },
      },
    };
  }
`;

test("Square cards client posts to /v2/cards with Square REST headers and body", () => {
  runCardsClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        card: {
          id: "card_123",
          card_brand: "VISA",
          last_4: "1234",
          exp_month: 12,
          exp_year: 2030,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquareCardsClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const response = await client.createCard(createCardRequest());

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/cards");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");
    assert.deepEqual(JSON.parse(requests[0].init.body), createCardRequest());
    assert.equal(response.card.id, "card_123");
    assert.equal(response.card.card_brand, "VISA");
    assert.equal(response.card.last_4, "1234");
    assert.equal(response.card.exp_month, 12);
    assert.equal(response.card.exp_year, 2030);
  `);
});

test("createSquareCard convenience helper posts to /v2/cards", () => {
  runCardsClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        card: {
          id: "card_456",
          card_brand: "MASTERCARD",
          last_4: "5678",
          exp_month: 6,
          exp_year: 2028,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const response = await createSquareCard(
      { environment: "sandbox", accessToken: "square-secret-token" },
      createCardRequest(),
    );

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/cards");
    assert.deepEqual(JSON.parse(requests[0].init.body), createCardRequest());
    assert.equal(response.card.id, "card_456");
  `);
});

test("Square cards client uses production base URL when configured", () => {
  runCardsClientScenario(`
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        card: {
          id: "card_123",
          card_brand: "VISA",
          last_4: "1234",
          exp_month: 12,
          exp_year: 2030,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createSquareCardsClient({ environment: "production", accessToken: "square-secret-token" });
    await client.createCard(createCardRequest());

    assert.equal(requestedUrl, "https://connect.squareup.com/v2/cards");
  `);
});

test("Square cards client errors are sanitized for non-2xx responses", () => {
  runCardsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 401 });

    const client = createSquareCardsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCard(createCardRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 401");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square cards client errors are sanitized for network failures", () => {
  runCardsClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquareCardsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCard(createCardRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square cards client throws for malformed response", () => {
  runCardsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ card: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const client = createSquareCardsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCard(createCardRequest()),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("Square cards client errors are sanitized for non-JSON 2xx responses", () => {
  runCardsClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquareCardsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCard(createCardRequest()),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

function runCardsClientScenario(assertions: string): void {
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
