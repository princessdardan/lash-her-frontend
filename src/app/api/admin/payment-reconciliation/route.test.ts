import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createPaymentReconciliationGetHandler } from "./src/app/api/admin/payment-reconciliation/route.ts";
  import { getPaymentReconciliationCronSecrets } from "./src/lib/env/private-checkout.ts";

  function getConfiguredPaymentReconciliationCronSecrets() {
    try {
      return getPaymentReconciliationCronSecrets();
    } catch {
      return [];
    }
  }

  function createRequest(headers = { authorization: "Bearer cron-secret" }) {
    return new Request("https://lash.test/api/admin/payment-reconciliation", {
      method: "GET",
      headers: headers === null ? undefined : headers,
    });
  }

  function runScenario({ getCronSecrets, runMonitor } = {}) {
    const errors = [];
    const warnings = [];
    const monitorCalls = [];
    const handler = createPaymentReconciliationGetHandler({
      getCronSecrets: getCronSecrets ?? (() => ["cron-secret"]),
      getNow: () => new Date("2026-06-19T12:00:00.000Z"),
      logError: (message, context) => errors.push({ context, message }),
      logWarn: (message) => warnings.push(message),
      runMonitor: async (input) => {
        monitorCalls.push(input);
        if (runMonitor) {
          return runMonitor(input);
        }
        return {
          findings: [],
          ok: true,
          checkedAt: "2026-06-19T12:00:00.000Z",
        };
      },
    });

    return { errors, handler, monitorCalls, warnings };
  }
`;

test("payment reconciliation route returns not found when only CRON_SECRET is configured", () => {
  runRouteScenario(
    `
    const { handler, monitorCalls, warnings } = runScenario({ getCronSecrets: getConfiguredPaymentReconciliationCronSecrets });

    const response = await handler(createRequest({ authorization: "Bearer cron-secret" }));

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(monitorCalls, []);
    assert.deepEqual(warnings, ["[payment-reconciliation] Cron secret is not configured"]);
  `,
    {
      CRON_SECRET: "cron-secret",
      PAYMENT_RECONCILIATION_CRON_SECRET: undefined,
    },
  );
});

test("payment reconciliation route accepts CRON_SECRET when route-specific secret is also configured", () => {
  runRouteScenario(
    `
    const { handler, monitorCalls } = runScenario({ getCronSecrets: getConfiguredPaymentReconciliationCronSecrets });

    const response = await handler(createRequest({ authorization: "Bearer cron-secret" }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `,
    {
      CRON_SECRET: "cron-secret",
      PAYMENT_RECONCILIATION_CRON_SECRET: "route-secret",
    },
  );
});

test("payment reconciliation route rejects wrong CRON_SECRET when route-specific secret is configured", () => {
  runRouteScenario(
    `
    const { handler, monitorCalls, warnings } = runScenario({ getCronSecrets: getConfiguredPaymentReconciliationCronSecrets });

    const response = await handler(createRequest({ authorization: "Bearer wrong-cron-secret" }));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(monitorCalls, []);
    assert.deepEqual(warnings, ["[payment-reconciliation] Unauthorized reconciliation request"]);
  `,
    {
      CRON_SECRET: "cron-secret",
      PAYMENT_RECONCILIATION_CRON_SECRET: "route-secret",
    },
  );
});

test("payment reconciliation route rejects missing bearer secret before monitor run", () => {
  runRouteScenario(`
    const { handler, monitorCalls, warnings } = runScenario();

    const response = await handler(createRequest(null));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(monitorCalls, []);
    assert.deepEqual(warnings, ["[payment-reconciliation] Unauthorized reconciliation request"]);
  `);
});

test("payment reconciliation route returns not found when cron secret is missing", () => {
  runRouteScenario(`
    const { handler, monitorCalls, warnings } = runScenario({ getCronSecrets: () => [] });

    const response = await handler(createRequest());

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(monitorCalls, []);
    assert.deepEqual(warnings, ["[payment-reconciliation] Cron secret is not configured"]);
  `);
});

test("payment reconciliation route runs monitor for an authorized cron request", () => {
  runRouteScenario(`
    const { handler, monitorCalls } = runScenario();

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.checkedAt, "2026-06-19T12:00:00.000Z");
    assert.deepEqual(body.findings, []);
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `);
});

test("payment reconciliation route returns finding categories with internal IDs only", () => {
  runRouteScenario(`
    const findings = [
      { category: "booked_without_saved_payment_method", holdId: "hold-6", severity: "warning" },
      {
        category: "no_show_charge_failed_not_alerted",
        holdId: "hold-9",
        noShowChargeRecordId: "nsr-1",
        severity: "error",
        status: "charge_failed",
      },
      {
        category: "payment_amount_currency_customer_mismatch",
        holdId: "hold-10",
        mismatchType: "customer",
        noShowChargeRecordId: "nsr-3",
        policyAcceptanceId: "pa-1",
        savedPaymentMethodId: "spm-1",
        severity: "error",
      },
    ];
    const { handler, monitorCalls } = runScenario({
      runMonitor: async () => ({
        findings,
        ok: false,
        checkedAt: "2026-06-19T12:00:00.000Z",
      }),
    });

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.findings.length, 3);
    assert.equal(body.findings[0].category, "booked_without_saved_payment_method");
    assert.equal(body.findings[1].noShowChargeRecordId, "nsr-1");
    assert.equal(body.findings[2].mismatchType, "customer");
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `);
});

test("payment reconciliation route returns hold_record_link mismatch findings with internal IDs only", () => {
  runRouteScenario(`
    const findings = [
      {
        category: "payment_amount_currency_customer_mismatch",
        holdId: "hold-11",
        mismatchType: "hold_record_link",
        noShowChargeRecordId: "nsr-4",
        savedPaymentMethodId: "spm-2",
        policyAcceptanceId: "pa-2",
        severity: "error",
      },
    ];
    const { handler, monitorCalls } = runScenario({
      runMonitor: async () => ({
        findings,
        ok: false,
        checkedAt: "2026-06-19T12:00:00.000Z",
      }),
    });

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.findings.length, 1);
    assert.equal(body.findings[0].category, "payment_amount_currency_customer_mismatch");
    assert.equal(body.findings[0].mismatchType, "hold_record_link");
    assert.equal(body.findings[0].holdId, "hold-11");
    assert.equal(body.findings[0].noShowChargeRecordId, "nsr-4");
    assert.equal(body.findings[0].savedPaymentMethodId, "spm-2");
    assert.equal(body.findings[0].policyAcceptanceId, "pa-2");
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `);
});

test("payment reconciliation route returns retryable failure when monitor fails", () => {
  runRouteScenario(`
    const { errors, handler, monitorCalls } = runScenario({
      runMonitor: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await handler(createRequest());

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Payment reconciliation failed" });
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
    assert.deepEqual(errors, [{
      context: { error: "database unavailable" },
      message: "[payment-reconciliation] Monitor failed",
    }]);
  `);
});

test("payment reconciliation route accepts configured route-specific secret", () => {
  runRouteScenario(`
    const { handler, monitorCalls } = runScenario({ getCronSecrets: () => ["route-secret", "cron-secret"] });

    const response = await handler(createRequest({ authorization: "Bearer route-secret" }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `);
});

test("payment reconciliation route accepts any configured secret", () => {
  runRouteScenario(`
    const { handler, monitorCalls } = runScenario({ getCronSecrets: () => ["route-secret", "cron-secret"] });

    const response = await handler(createRequest({ authorization: "Bearer cron-secret" }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(monitorCalls, [{ now: new Date("2026-06-19T12:00:00.000Z") }]);
  `);
});

test("payment reconciliation route rejects wrong bearer when multiple secrets are configured", () => {
  runRouteScenario(`
    const { handler, monitorCalls, warnings } = runScenario({ getCronSecrets: () => ["route-secret", "cron-secret"] });

    const response = await handler(createRequest({ authorization: "Bearer wrong-secret" }));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(monitorCalls, []);
    assert.deepEqual(warnings, ["[payment-reconciliation] Unauthorized reconciliation request"]);
  `);
});

test("payment reconciliation cron auth rejects same-length wrong bearer token", () => {
  runRouteScenario(`
    const { handler, monitorCalls, warnings } = runScenario({ getCronSecrets: () => ["correct-secret"] });

    const response = await handler(new Request("https://example.com/api/admin/payment-reconciliation", {
      headers: { authorization: "Bearer wronggg-secret" },
    }));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(monitorCalls, []);
    assert.deepEqual(warnings, ["[payment-reconciliation] Unauthorized reconciliation request"]);
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
