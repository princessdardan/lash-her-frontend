import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createEmailRetryPostHandler } from "./src/app/api/admin/email-retries/route.ts";

  function createRequest(body, headers = { authorization: "Bearer retry-secret" }) {
    return new Request("https://lash.test/api/admin/email-retries", {
      method: "POST",
      headers: headers === null ? undefined : headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function runScenario({ getRetrySecret, retryTransactionalEmail } = {}) {
    const errors = [];
    const retries = [];
    const handler = createEmailRetryPostHandler({
      getRetrySecret: getRetrySecret ?? (() => "retry-secret"),
      logError: (message, context) => errors.push({ context, message }),
      retryTransactionalEmail: async (input) => {
        retries.push(input);
        if (retryTransactionalEmail) {
          return retryTransactionalEmail(input);
        }
        return { flow: input.flow, orderId: input.orderId, status: "processed" };
      },
    });

    return { errors, handler, retries };
  }
`;

test("email retry route rejects missing bearer secret before retrying", () => {
  runRouteScenario(`
    const { handler, retries } = runScenario();

    const response = await handler(createRequest({ flow: "product", orderId: "lh-product-123" }, null));

    assert.equal(response.status, 401);
    assert.deepEqual(retries, []);
  `);
});

test("email retry route rejects malformed bodies", () => {
  runRouteScenario(`
    const { handler, retries } = runScenario();

    const response = await handler(createRequest({ flow: "unknown", orderId: "lh-product-123" }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid email retry request" });
    assert.deepEqual(retries, []);
  `);
});

test("email retry route dispatches retry with request origin", () => {
  runRouteScenario(`
    const { handler, retries } = runScenario();

    const response = await handler(createRequest({ flow: "training", orderId: "  lh-training-123  " }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { flow: "training", orderId: "lh-training-123", status: "processed" });
    assert.deepEqual(retries, [{ flow: "training", orderId: "lh-training-123", origin: "https://lash.test" }]);
  `);
});

test("email retry route accepts x-lash retry secret header", () => {
  runRouteScenario(`
    const { handler, retries } = runScenario();

    const response = await handler(createRequest(
      { flow: "booking", orderId: "lh-booking-123" },
      { "x-lash-email-retry-secret": "retry-secret" },
    ));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { flow: "booking", orderId: "lh-booking-123", status: "processed" });
    assert.deepEqual(retries, [{ flow: "booking", orderId: "lh-booking-123", origin: "https://lash.test" }]);
  `);
});

test("email retry route returns not found when retry secret is missing", () => {
  runRouteScenario(`
    const { errors, handler, retries } = runScenario({
      getRetrySecret: () => null,
    });

    const response = await handler(createRequest({ flow: "product", orderId: "lh-product-123" }));

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(retries, []);
    assert.deepEqual(errors, []);
  `);
});

test("email retry route returns retryable failure when the send fails", () => {
  runRouteScenario(`
    const { errors, handler } = runScenario({
      retryTransactionalEmail: async () => {
        throw new Error("Resend unavailable");
      },
    });

    const response = await handler(createRequest({ flow: "booking", orderId: "lh-booking-123" }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Transactional email retry failed" });
    assert.deepEqual(errors, [{
      context: { error: "Resend unavailable", flow: "booking", orderId: "lh-booking-123" },
      message: "[email-retry] Manual transactional email retry failed",
    }]);
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
