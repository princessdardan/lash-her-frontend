import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createSquarePaymentsClient,
    createSquareCardOnFilePayment,
  } from "./src/lib/payments/square/payments-client.ts";

  function createPaymentRequest() {
    return {
      idempotency_key: "payment-key-1",
      source_id: "card_123",
      customer_id: "customer_123",
      amount_money: { amount: 5000, currency: "CAD" },
      autocomplete: true,
      reference_id: "no-show-1",
      note: "No-show charge",
    };
  }
`;

test("createSquareCardOnFilePayment posts to /v2/payments with card-on-file source and customer", () => {
  runPaymentsClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        payment: {
          id: "payment_123",
          status: "COMPLETED",
          order_id: "order_123",
          amount_money: { amount: 5000, currency: "CAD" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const request = createPaymentRequest();
    const response = await client.createCardOnFilePayment(request);

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/payments");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.authorization, "Bearer square-secret-token");
    assert.equal(requests[0].init.headers["square-version"], "2026-05-20");

    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.source_id, "card_123");
    assert.equal(body.customer_id, "customer_123");
    assert.equal(body.amount_money.amount, 5000);
    assert.equal(body.amount_money.currency, "CAD");
    assert.deepEqual(body, request);

    assert.equal(response.payment.id, "payment_123");
    assert.equal(response.payment.status, "COMPLETED");
    assert.equal(response.payment.order_id, "order_123");
    assert.equal(response.payment.amount_money.amount, 5000);
    assert.equal(response.payment.amount_money.currency, "CAD");
  `);
});

test("createSquareCardOnFilePayment convenience helper posts to /v2/payments", () => {
  runPaymentsClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        payment: {
          id: "payment_456",
          status: "COMPLETED",
          amount_money: { amount: 7500, currency: "CAD" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const request = createPaymentRequest();
    request.amount_money = { amount: 7500, currency: "CAD" };
    const response = await createSquareCardOnFilePayment(
      { environment: "sandbox", accessToken: "square-secret-token" },
      request,
    );

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/payments");
    assert.deepEqual(JSON.parse(requests[0].init.body), request);
    assert.equal(response.payment.id, "payment_456");
    assert.equal(response.payment.amount_money.amount, 7500);
  `);
});

test("Square payments client uses production base URL when configured", () => {
  runPaymentsClientScenario(`
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        payment: { id: "payment_123", status: "COMPLETED", amount_money: { amount: 5000, currency: "CAD" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquarePaymentsClient({ environment: "production", accessToken: "square-secret-token" });
    await client.createCardOnFilePayment(createPaymentRequest());

    assert.equal(requestedUrl, "https://connect.squareup.com/v2/payments");
  `);
});

test("Square payments client errors are sanitized for non-2xx responses", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 401 });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCardOnFilePayment(createPaymentRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 401");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square payments client errors are sanitized for network failures", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCardOnFilePayment(createPaymentRequest()),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("Square payments client throws for malformed response", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ payment: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCardOnFilePayment(createPaymentRequest()),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("Square payments client errors are sanitized for non-JSON 2xx responses", () => {
  runPaymentsClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.createCardOnFilePayment(createPaymentRequest()),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment returns amount, currency, customer, card, and order fields", () => {
  runPaymentsClientScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        payment: {
          id: "pay-1",
          status: "COMPLETED",
          order_id: "order-1",
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          amount_money: { amount: 12500, currency: "CAD" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });
    const result = await client.getPayment("pay-1");

    assert.equal(requests[0].url, "https://connect.squareupsandbox.com/v2/payments/pay-1");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(result.payment.customer_id, "cust-1");
    assert.equal(result.payment.card_details?.card?.id, "ccof-1");
    assert.equal(result.payment.amount_money?.amount, 12500);
    assert.equal(result.payment.amount_money?.currency, "CAD");
  `);
});

test("getSquarePayment errors are sanitized for non-2xx responses", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ detail: "square-secret-token leaked" }] }), { status: 404 });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API request failed with status 404");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("getSquarePayment errors are sanitized for network failures", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => {
      throw new Error("network failed with square-secret-token");
    };

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API request failed before receiving a response");
        assert.equal(error.message.includes("square-secret-token"), false);
        return true;
      },
    );
  `);
});

test("getSquarePayment throws for malformed response", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({ payment: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment errors are sanitized for non-JSON 2xx responses", () => {
  runPaymentsClientScenario(`
    const sensitiveBody = "fake-access-token-secret: this is not json {{";
    globalThis.fetch = async () => new Response(sensitiveBody, { status: 200 });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message.includes("fake-access-token-secret"), false);
        assert.equal(error.message.includes(sensitiveBody), false);
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when amount_money is missing", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: { id: "pay-1", status: "COMPLETED" },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when amount_money.amount is not a number", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: { id: "pay-1", status: "COMPLETED", amount_money: { amount: "12500", currency: "CAD" } },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when amount_money.currency is not a string", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: { id: "pay-1", status: "COMPLETED", amount_money: { amount: 12500, currency: 124 } },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when customer_id is present but not a string", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: { id: "pay-1", status: "COMPLETED", amount_money: { amount: 12500, currency: "CAD" }, customer_id: 123 },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when order_id is present but not a string", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: { id: "pay-1", status: "COMPLETED", amount_money: { amount: 12500, currency: "CAD" }, order_id: true },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when source_type is present but not a string", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: { id: "pay-1", status: "COMPLETED", amount_money: { amount: 12500, currency: "CAD" }, source_type: ["CARD"] },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

test("getSquarePayment throws when card_details.card.id is present but not a string", () => {
  runPaymentsClientScenario(`
    globalThis.fetch = async () => new Response(JSON.stringify({
      payment: {
        id: "pay-1",
        status: "COMPLETED",
        amount_money: { amount: 12500, currency: "CAD" },
        card_details: { card: { id: 999 } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const client = createSquarePaymentsClient({ environment: "sandbox", accessToken: "square-secret-token" });

    await assert.rejects(
      () => client.getPayment("pay-1"),
      (error) => {
        assert.equal(error.message, "Square API response was malformed");
        return true;
      },
    );
  `);
});

function runPaymentsClientScenario(assertions: string): void {
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
