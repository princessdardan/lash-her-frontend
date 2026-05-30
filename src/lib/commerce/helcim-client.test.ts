import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createHelcimInvoice,
    getHelcimCardTransaction,
    initializeHelcimPay,
  } from "./src/lib/commerce/helcim-client.ts";

  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    if (String(input).endsWith("/invoices/")) {
      return Response.json({ invoiceId: 12345, invoiceNumber: "INV-12345" });
    }

    if (String(input).endsWith("/helcim-pay/initialize")) {
      return Response.json({ checkoutToken: "checkout-token", secretToken: "secret-token" });
    }

    return Response.json({ id: 25764674, status: "APPROVED" });
  };

  void (async () => {
  try {
    const invoice = await createHelcimInvoice({
      type: "INVOICE",
      status: "DUE",
      currency: "CAD",
      notes: "Lash Her website checkout",
      lineItems: [{ sku: "lash-kit", description: "Lash kit", quantity: 1, price: 125 }],
    });
    const checkout = await initializeHelcimPay({
      paymentType: "purchase",
      amount: 125,
      currency: "CAD",
      invoiceNumber: invoice.invoiceNumber,
    });
    const response = await getHelcimCardTransaction("25764674");
    const invoiceCall = calls[0];
    const checkoutCall = calls[1];

    assert.deepEqual(invoice, { invoiceId: 12345, invoiceNumber: "INV-12345" });
    assert.deepEqual(checkout, { checkoutToken: "checkout-token", secretToken: "secret-token" });
    assert.deepEqual(response, { id: 25764674, status: "APPROVED" });
    assert.ok(invoiceCall);
    assert.equal(String(invoiceCall.input), "https://api.helcim.com/v2/invoices/");
    assert.equal(invoiceCall.init?.method, "POST");
    assert.equal(new Headers(invoiceCall.init?.headers).get("api-token"), "test-general-token-with-safe-length");

    assert.ok(checkoutCall);
    assert.equal(String(checkoutCall.input), "https://api.helcim.com/v2/helcim-pay/initialize");
    assert.equal(checkoutCall.init?.method, "POST");
    assert.equal(new Headers(checkoutCall.init?.headers).get("api-token"), "test-transaction-token-with-safe-length");

    const call = calls[2];
    assert.ok(call);
    assert.equal(String(call.input), "https://api.helcim.com/v2/card-transactions/25764674");
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.cache, "no-store");
    assert.ok(call.init?.signal instanceof AbortSignal);

    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("api-token"), "test-general-token-with-safe-length");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("content-type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  })();
`;

test("Helcim client uses split API tokens for general and transaction endpoints", () => {
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.HELCIM_GENERAL_API_TOKEN = "test-general-token-with-safe-length";
  env.HELCIM_TRANSACTION_API_TOKEN = "test-transaction-token-with-safe-length";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", helperScript],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
});

const errorScript = String.raw`
  import assert from "node:assert/strict";

  import {
    HelcimApiError,
    initializeHelcimPay,
  } from "./src/lib/commerce/helcim-client.ts";

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (): Promise<Response> => Response.json(
    { errors: "Unauthorized" },
    { status: 401 },
  );

  void (async () => {
  try {
    await assert.rejects(
      initializeHelcimPay({
        paymentType: "purchase",
        amount: 125,
        currency: "CAD",
        invoiceNumber: "INV-12345",
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelcimApiError);
        assert.equal(error.status, 401);
        assert.equal(error.path, "/helcim-pay/initialize");
        assert.equal(error.responseError, "Unauthorized");
        assert.match(error.message, /Helcim API request failed with status 401 for \/helcim-pay\/initialize: Unauthorized/);
        assert.doesNotMatch(error.message, /test-transaction-token-with-safe-length/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  })();
`;

test("Helcim client includes endpoint and sanitized provider error on failures", () => {
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.HELCIM_TRANSACTION_API_TOKEN = "test-transaction-token-with-safe-length";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", errorScript],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
});
