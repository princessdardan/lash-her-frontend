import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createPrivateDataRetentionGetHandler } from "./src/app/api/admin/private-data-retention/route.ts";

  function createRequest(headers = { authorization: "Bearer cron-secret" }) {
    return new Request("https://lash.test/api/admin/private-data-retention", {
      method: "GET",
      headers: headers === null ? undefined : headers,
    });
  }

  function runScenario({ getCronSecret, runCleanup } = {}) {
    const errors = [];
    const warnings = [];
    const cleanupCalls = [];
    const handler = createPrivateDataRetentionGetHandler({
      getCronSecret: getCronSecret ?? (() => "cron-secret"),
      getNow: () => new Date("2026-05-28T12:00:00.000Z"),
      logError: (message, context) => errors.push({ context, message }),
      logWarn: (message) => warnings.push(message),
      runCleanup: async (input) => {
        cleanupCalls.push(input);
        if (runCleanup) {
          return runCleanup(input);
        }
        return {
          operations: [{
            count: 3,
            cutoff: "2025-04-28T12:00:00.000Z",
            operation: "checkoutOrdersRedacted",
            table: "checkout_orders",
          }],
          runAt: input.now.toISOString(),
          totalAffected: 3,
        };
      },
    });

    return { cleanupCalls, errors, handler, warnings };
  }
`;

test("private data retention route rejects missing bearer secret before cleanup", () => {
  runRouteScenario(`
    const { cleanupCalls, handler, warnings } = runScenario();

    const response = await handler(createRequest(null));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(cleanupCalls, []);
    assert.deepEqual(warnings, ["[private-data-retention] Unauthorized cleanup request"]);
  `);
});

test("private data retention route returns not found when cron secret is missing", () => {
  runRouteScenario(`
    const { cleanupCalls, handler, warnings } = runScenario({ getCronSecret: () => null });

    const response = await handler(createRequest());

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(cleanupCalls, []);
    assert.deepEqual(warnings, ["[private-data-retention] Cron secret is not configured"]);
  `);
});

test("private data retention route runs cleanup for an authorized cron request", () => {
  runRouteScenario(`
    const { cleanupCalls, handler } = runScenario();

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.runAt, "2026-05-28T12:00:00.000Z");
    assert.equal(body.totalAffected, 3);
    assert.equal(body.retentionWindows.some((window) => window.table === "checkout_orders"), true);
    assert.deepEqual(cleanupCalls, [{ now: new Date("2026-05-28T12:00:00.000Z") }]);
  `);
});

test("private data retention route returns retryable failure when cleanup fails", () => {
  runRouteScenario(`
    const { cleanupCalls, errors, handler } = runScenario({
      runCleanup: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Private data retention cleanup failed" });
    assert.deepEqual(cleanupCalls, [{ now: new Date("2026-05-28T12:00:00.000Z") }]);
    assert.deepEqual(errors, [{
      context: { error: "database unavailable" },
      message: "[private-data-retention] Cleanup failed",
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
