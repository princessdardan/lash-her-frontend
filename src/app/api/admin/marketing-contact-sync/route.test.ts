import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createMarketingContactSyncGetHandler } from "./src/app/api/admin/marketing-contact-sync/route.ts";
  import { getResendMarketingSyncCronSecrets } from "./src/lib/env/private-checkout.ts";

  function getConfiguredResendMarketingSyncCronSecrets() {
    try {
      return getResendMarketingSyncCronSecrets();
    } catch {
      return [];
    }
  }

  function createRequest(headers = { authorization: "Bearer cron-secret" }) {
    return new Request("https://lash.test/api/admin/marketing-contact-sync", {
      method: "GET",
      headers: headers === null ? undefined : headers,
    });
  }

  function runScenario({ getCronSecrets, runWorker } = {}) {
    const errors = [];
    const warnings = [];
    const workerCalls = [];
    const handler = createMarketingContactSyncGetHandler({
      getCronSecrets: getCronSecrets ?? (() => ["cron-secret"]),
      getNow: () => new Date("2026-06-19T12:00:00.000Z"),
      logError: (message, context) => errors.push({ context, message }),
      logWarn: (message) => warnings.push(message),
      runWorker: async (input) => {
        workerCalls.push(input);
        if (runWorker) {
          return runWorker(input);
        }
        return {
          processed: 0,
          succeeded: 0,
          retryableFailed: 0,
          deadLettered: 0,
          skippedUnconfigured: 0,
          failedToClaim: 0,
          runAt: "2026-06-19T12:00:00.000Z",
        };
      },
    });

    return { errors, handler, warnings, workerCalls };
  }
`;

test("marketing contact sync route returns not found when only CRON_SECRET is configured", () => {
  runRouteScenario(
    `
    const { handler, warnings, workerCalls } = runScenario({ getCronSecrets: getConfiguredResendMarketingSyncCronSecrets });

    const response = await handler(createRequest({ authorization: "Bearer cron-secret" }));

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(workerCalls, []);
    assert.deepEqual(warnings, ["[marketing-contact-sync] Cron secret is not configured"]);
  `,
    {
      CRON_SECRET: "cron-secret",
      RESEND_MARKETING_SYNC_CRON_SECRET: undefined,
    },
  );
});

test("marketing contact sync route accepts CRON_SECRET when route-specific secret is also configured", () => {
  runRouteScenario(
    `
    const { handler, workerCalls } = runScenario({ getCronSecrets: getConfiguredResendMarketingSyncCronSecrets });

    const response = await handler(createRequest({ authorization: "Bearer cron-secret" }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.processed, 0);
    assert.deepEqual(workerCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `,
    {
      CRON_SECRET: "cron-secret",
      RESEND_MARKETING_SYNC_CRON_SECRET: "route-secret",
    },
  );
});

test("marketing contact sync route rejects missing bearer secret before worker run", () => {
  runRouteScenario(`
    const { handler, warnings, workerCalls } = runScenario();

    const response = await handler(createRequest(null));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(workerCalls, []);
    assert.deepEqual(warnings, ["[marketing-contact-sync] Unauthorized sync request"]);
  `);
});

test("marketing contact sync route runs worker for an authorized cron request", () => {
  runRouteScenario(`
    const { handler, workerCalls } = runScenario();

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.processed, 0);
    assert.equal(body.runAt, "2026-06-19T12:00:00.000Z");
    assert.deepEqual(workerCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `);
});

test("marketing contact sync route returns retryable failure when worker fails", () => {
  runRouteScenario(`
    const { errors, handler, workerCalls } = runScenario({
      runWorker: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Marketing contact sync failed" });
    assert.deepEqual(workerCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
    assert.deepEqual(errors, [{
      context: { error: "database unavailable" },
      message: "[marketing-contact-sync] Worker failed",
    }]);
  `);
});

test("marketing contact sync route returns non-PII summary", () => {
  runRouteScenario(`
    const { handler } = runScenario({
      runWorker: async () => ({
        processed: 3,
        succeeded: 2,
        retryableFailed: 1,
        deadLettered: 0,
        skippedUnconfigured: 0,
        failedToClaim: 0,
        runAt: "2026-06-19T12:00:00.000Z",
      }),
    });

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.processed, 3);
    assert.equal(body.succeeded, 2);
    assert.equal(body.retryableFailed, 1);
    assert.equal(body.runAt, "2026-06-19T12:00:00.000Z");
    assert.equal("email" in body, false);
  `);
});

function runRouteScenario(
  assertions: string,
  envOverrides?: Partial<NodeJS.ProcessEnv>,
): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env: NodeJS.ProcessEnv = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }

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
