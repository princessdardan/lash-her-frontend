import { execFileSync } from "node:child_process";
import test from "node:test";

const invoiceRequest = {
  type: "INVOICE",
  status: "DUE",
  currency: "CAD",
  notes: "Lash Her website checkout",
  lineItems: [{ sku: "lash-kit", description: "Lash kit", quantity: 1, price: 125 }],
};

test("live Helcim gateway delegates to the existing client behavior", () => {
  const helperScript = String.raw`
    import assert from "node:assert/strict";
    import { createLiveHelcimGateway } from "./src/lib/commerce/helcim-gateway.ts";

    const calls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith("/invoices/")) {
        return Response.json({ invoiceId: 12345, invoiceNumber: "INV-12345" });
      }
      if (String(input).endsWith("/helcim-pay/initialize")) {
        return Response.json({ checkoutToken: "checkout-token", secretToken: "secret-token" });
      }
      return Response.json({ id: "txn-live", status: "APPROVED" });
    };

    void (async () => {
    try {
      const gateway = createLiveHelcimGateway();
      const invoice = await gateway.createInvoice(${JSON.stringify(invoiceRequest)});
      const session = await gateway.initializePay({ paymentType: "purchase", amount: 125, currency: "CAD", invoiceNumber: invoice.invoiceNumber });
      const transaction = await gateway.getCardTransaction("txn-live");

      assert.deepEqual(invoice, { invoiceId: 12345, invoiceNumber: "INV-12345" });
      assert.deepEqual(session, { checkoutToken: "checkout-token", secretToken: "secret-token" });
      assert.deepEqual(transaction, { id: "txn-live", status: "APPROVED" });
      assert.equal(String(calls[0].input), "https://api.helcim.com/v2/invoices/");
      assert.equal(String(calls[1].input), "https://api.helcim.com/v2/helcim-pay/initialize");
      assert.equal(String(calls[2].input), "https://api.helcim.com/v2/card-transactions/txn-live");
    } finally {
      globalThis.fetch = originalFetch;
    }
    })();
  `;

  const env = { ...process.env };
  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.HELCIM_GENERAL_API_TOKEN = "test-general-token";
  env.HELCIM_TRANSACTION_API_TOKEN = "test-transaction-token";

  execFileSync("./node_modules/.bin/tsx", ["--conditions=react-server", "--eval", helperScript], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
});
