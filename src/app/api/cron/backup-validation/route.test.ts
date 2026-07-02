import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBackupValidationGetHandler } from "./src/app/api/cron/backup-validation/route.ts";

  function createRequest(headers = { authorization: "Bearer cron-secret" }) {
    return new Request("https://lash.test/api/cron/backup-validation", {
      method: "GET",
      headers: headers === null ? undefined : headers,
    });
  }

  function runScenario({ getCronSecret, readConfig, validateConfig } = {}) {
    const logs = [];
    const handler = createBackupValidationGetHandler({
      getCronSecret: getCronSecret ?? (() => "cron-secret"),
      log: (level, message, meta) => logs.push({ level, message, meta }),
      readConfig: readConfig ?? (() => ({ enabled: false })),
      validateConfig: validateConfig ?? (() => ({ valid: true, errors: [] })),
    });

    return { handler, logs };
  }
`;

test("backup validation route returns not found when cron secret is not configured", () => {
  runRouteScenario(`
    const { handler, logs } = runScenario({ getCronSecret: () => null });

    const response = await handler(createRequest());

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(logs, []);
  `);
});

test("backup validation route returns unauthorized for missing bearer token", () => {
  runRouteScenario(`
    const { handler, logs } = runScenario();

    const response = await handler(createRequest(null));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(logs, []);
  `);
});

test("backup validation route returns unauthorized for invalid bearer token", () => {
  runRouteScenario(`
    const { handler, logs } = runScenario();

    const response = await handler(createRequest({ authorization: "Bearer wrong-secret" }));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(logs, []);
  `);
});

test("backup validation route returns manual action required when disabled", () => {
  runRouteScenario(`
    const { handler, logs } = runScenario();

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.validationPerformed, false);
    assert.equal(body.manualActionRequired, true);
    assert.equal(body.checkoutOrders, "future_health_check_table");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "info");
    assert.equal(logs[0].message, "Backup validation cron started");
    assert.equal(logs[0].meta.validationPerformed, false);
  `);
});

test("backup validation route returns service unavailable when enabled but config is invalid", () => {
  runRouteScenario(`
    const { handler, logs } = runScenario({
      readConfig: () => ({
        enabled: true,
        gcsBucketUri: "s3://bad-bucket",
        restoreDatabaseUrl: "postgres://host/production",
        expectedRestoreDbName: "production",
      }),
      validateConfig: () => ({
        valid: false,
        errors: [
          { code: "INVALID_BUCKET_URI", message: "GCS bucket URI must start with gs://" },
          { code: "RESTORE_URL_MATCHES_PRODUCTION", message: "Restore database URL must not match DATABASE_URL" },
          { code: "DB_NAME_MISMATCH", message: "Expected restore database name does not match the database name in the restore URL" },
          { code: "UNSAFE_DB_NAME", message: "Expected restore database name must include 'restore' or 'backup_validation'" },
        ],
      }),
    });

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error, "Backup validation configuration is invalid");
    assert.deepEqual(body.codes, ["INVALID_BUCKET_URI", "RESTORE_URL_MATCHES_PRODUCTION", "DB_NAME_MISMATCH", "UNSAFE_DB_NAME"]);
    assert.equal(body.manualActionRequired, true);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].level, "info");
    assert.equal(logs[0].message, "Backup validation cron started");
    assert.equal(logs[1].level, "error");
    assert.equal(logs[1].message, "Backup validation config invalid");
    assert.deepEqual(logs[1].meta.codes, ["INVALID_BUCKET_URI", "RESTORE_URL_MATCHES_PRODUCTION", "DB_NAME_MISMATCH", "UNSAFE_DB_NAME"]);
  `);
});

test("backup validation route returns scaffold response when enabled and config is safe", () => {
  runRouteScenario(`
    const { handler, logs } = runScenario({
      readConfig: () => ({
        enabled: true,
        gcsBucketUri: "gs://my-bucket/backups",
        restoreDatabaseUrl: "postgres://host/lash_her_restore",
        expectedRestoreDbName: "lash_her_restore",
      }),
      validateConfig: () => ({
        valid: true,
        errors: [],
      }),
    });

    const response = await handler(createRequest());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.validationPerformed, false);
    assert.equal(body.manualActionRequired, true);
    assert.equal(body.checkoutOrders, "future_health_check_table");
    assert.equal(body.scaffoldStatus, "external_restore_runner_required");
    assert.equal(logs.length, 2);
    assert.equal(logs[0].level, "info");
    assert.equal(logs[0].message, "Backup validation cron started");
    assert.equal(logs[1].level, "info");
    assert.equal(logs[1].message, "Backup validation config safe; scaffold only");
    assert.equal(logs[1].meta.scaffoldStatus, "external_restore_runner_required");
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
