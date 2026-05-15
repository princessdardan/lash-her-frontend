import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";
  import { createHmac } from "node:crypto";

  import { createHelcimWebhookPostHandler } from "./src/app/api/webhooks/card-transactions/route.ts";

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

    return new Request("http://localhost:3000/api/webhooks/card-transactions", {
      method: "POST",
      headers: {
        "webhook-id": id,
        "webhook-signature": signedSignature,
        "webhook-timestamp": timestamp,
      },
      body,
    });
  }

  async function runScenario({
    getCardTransaction,
    issueSchedulingTokenForPaidHelcimInvoiceIfMissing,
    markTrainingEnrollmentStaffAlerted,
    recordEvent,
    sendTrainingPaymentNotificationEmails,
  }) {
    const recorded = [];
    const issuedTokens = [];
    const markedStaffAlerts = [];
    const sentEmails = [];
    const handler = createHelcimWebhookPostHandler({
      getCardTransaction,
      getVerifierToken: () => verifierToken,
      issueSchedulingTokenForPaidHelcimInvoiceIfMissing: async (input) => {
        if (!issueSchedulingTokenForPaidHelcimInvoiceIfMissing) {
          return null;
        }

        const issued = await issueSchedulingTokenForPaidHelcimInvoiceIfMissing(input);
        if (issued) {
          issuedTokens.push(issued);
        }
        return issued;
      },
      markTrainingEnrollmentStaffAlerted: async (input) => {
        markedStaffAlerts.push(input);
        if (markTrainingEnrollmentStaffAlerted) {
          await markTrainingEnrollmentStaffAlerted(input);
        }
      },
      recordEvent: async (event) => {
        recorded.push(event);
        if (recordEvent) {
          await recordEvent(event);
        }
        return true;
      },
      sendTrainingPaymentNotificationEmails: async (input) => {
        sentEmails.push(input);
        if (sendTrainingPaymentNotificationEmails) {
          await sendTrainingPaymentNotificationEmails(input);
        }
      },
    });

    return { handler, issuedTokens, markedStaffAlerts, recorded, sentEmails };
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

test("Helcim webhook route recovers missing training scheduling token and sends payment emails", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, issuedTokens, markedStaffAlerts, sentEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      issueSchedulingTokenForPaidHelcimInvoiceIfMissing: async (input) => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: {
          customerEmail: "client@example.com",
          customerName: "Client Name",
          orderId: "lh-training-123",
        },
        enrollmentId: "training-enrollment-1",
        productSnapshot: {
          currency: "CAD",
          id: "product-training-full",
          priceCents: 149900,
          sku: "TRAINING-FULL",
          title: "Lash Training Full Payment",
        },
        programSnapshot: {
          id: "program-lash-training",
          slug: "lash-training",
          title: "Lash Training Program",
        },
        schedulingToken: "fresh-webhook-token",
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
      recordEvent: async () => true,
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 200);
    assert.equal(issuedTokens.length, 1);
    assert.deepEqual(sentEmails, [
      {
        customerEmail: "client@example.com",
        customerName: "Client Name",
        orderId: "lh-training-123",
        programTitle: "Lash Training Program",
        schedulingUrl: "http://localhost:3000/booking?type=training-call&token=fresh-webhook-token",
      },
    ]);
    assert.deepEqual(markedStaffAlerts, [{ enrollmentId: "training-enrollment-1" }]);
  `);
});

test("Helcim webhook route does not send duplicate training emails when token already exists", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, issuedTokens, markedStaffAlerts, sentEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      issueSchedulingTokenForPaidHelcimInvoiceIfMissing: async () => null,
      recordEvent: async () => true,
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 200);
    assert.equal(issuedTokens.length, 0);
    assert.equal(sentEmails.length, 0);
    assert.equal(markedStaffAlerts.length, 0);
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
