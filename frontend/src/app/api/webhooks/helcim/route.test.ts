import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";
  import { createHmac } from "node:crypto";

  import { createHelcimWebhookPostHandler } from "./src/app/api/webhooks/helcim/route.ts";

  const verifierToken = Buffer.from("webhook-secret-key").toString("base64");

  function createSignature(id, timestamp, body) {
    return createHmac("sha256", Buffer.from(verifierToken, "base64"))
      .update(id + "." + timestamp + "." + body, "utf8")
      .digest("base64");
  }

  function createRequest(body, signature) {
    const id = "webhook-route-test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedSignature = signature ?? "v1," + createSignature(id, timestamp, body);

    return new Request("http://localhost:3000/api/webhooks/helcim", {
      method: "POST",
      headers: {
        "webhook-id": id,
        "webhook-signature": signedSignature,
        "webhook-timestamp": timestamp,
      },
      body,
    });
  }

  async function runScenario({ getCardTransaction, recordEvent }) {
    const recorded = [];
    const handler = createHelcimWebhookPostHandler({
      getCardTransaction,
      getVerifierToken: () => verifierToken,
      recordEvent: async (event) => {
        recorded.push(event);
        if (recordEvent) {
          await recordEvent(event);
        }
        return true;
      },
    });

    return { handler, recorded };
  }
`;

test("Helcim webhook route rejects invalid signatures before persistence", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, recorded } = await runScenario({
      getCardTransaction: async () => ({ status: "APPROVED" }),
    });

    const response = await handler(createRequest(body, "v1,bad-signature"));

    assert.equal(response.status, 401);
    assert.equal(recorded.length, 0);
  `);
});

test("Helcim webhook route returns retryable status when transaction detail fetch fails", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, recorded } = await runScenario({
      getCardTransaction: async () => {
        throw new Error("Helcim unavailable");
      },
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 503);
    assert.equal(recorded.length, 0);
  `);
});

test("Helcim webhook route returns retryable status when private persistence fails", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, recorded } = await runScenario({
      getCardTransaction: async () => ({
        amount: "123.45",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => {
        throw new Error("Private DB unavailable");
      },
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 503);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].payloadRedacted, {
      amount: "123.45",
      currency: "CAD",
      invoiceNumber: "INV-4242",
      status: "APPROVED",
      transactionId: "25764674",
    });
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
