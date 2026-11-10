import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { assertManualWriterTarget, runManualWriterAdmission } from "./manual";

test("retired DDL and package approval commands cannot open SQL or provider connections", () => {
  for (const script of ["create-payment-reconciliation-indexes", "provision-shipping-package-profiles"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import {createRequire} from "node:module";
      const require = createRequire(import.meta.url);
      require("pg").Pool = class { constructor() { throw new Error("OWNED_SQL_REACHED"); } };
      globalThis.fetch = async () => { throw new Error("OWNED_PROVIDER_REACHED"); };
      await import("./scripts/${script}.ts");
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: {
      ...process.env, DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/lash_her_browser_ci",
      PRIVATE_DB_MIGRATION_TARGET: "production", PRIVATE_DB_MIGRATION_HOST: "127.0.0.1", PRIVATE_DB_MIGRATION_CONFIRM: "production",
      PROVISION_PACKAGE_PROFILES: "1",
    } });
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /retired/);
    assert.doesNotMatch(result.stderr, /OWNED_(SQL|PROVIDER)_REACHED/);
  }
});

test("stock write-mode admission precedes the actual Sanity inventory read", () => {
  const result = spawnSync(process.execPath, ["--import", "./scripts/register-server-only-test.mjs", "--import", "tsx", "--input-type=module", "--eval", `
    globalThis.fetch = async () => { throw new Error("OWNED_PROVIDER_REACHED"); };
    process.argv.push("--execute");
    await import("./scripts/backfill-product-stock.ts");
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: {
    ...process.env, FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
    NEXT_PUBLIC_SANITY_PROJECT_ID: "owned", NEXT_PUBLIC_SANITY_DATASET: "owned",
    APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
  } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /inspect the retained admission outcome/);
  assert.doesNotMatch(result.stderr, /OWNED_PROVIDER_REACHED/);
  assert.equal(result.stdout.includes("products found"), false);
});

test("manual write mode permits existing local loopback URLs and leaves enforced writes to the exact runner", () => {
  const local = "postgresql://owned@localhost/owned_manual";
  for (const DATABASE_URL of [
    local,
    "postgresql://owned@LOCALHOST/owned_manual",
    "postgresql://owned@127.0.0.1:5433/owned_manual?sslmode=disable&application_name=manual",
    "postgresql://owned@[::1]/owned_manual",
  ]) {
    assert.doesNotThrow(() => assertManualWriterTarget({ DATABASE_URL }));
    assert.doesNotThrow(() => assertManualWriterTarget({
      DATABASE_URL,
      FRONTEND_WRITER_ADMISSION_MODE: "off",
      APP_ENV: "local",
      PRIVATE_DB_MIGRATION_TARGET: "local",
    }));
  }
  assert.doesNotThrow(() => assertManualWriterTarget({
    FRONTEND_WRITER_ADMISSION_MODE: "enforce",
  }));
  for (const env of [
    {},
    { DATABASE_URL: "postgres://owned@staging.invalid/owned_manual" },
    { DATABASE_URL: "postgres://owned@localhost/" },
    { DATABASE_URL: local + "?host=staging.invalid" },
    { DATABASE_URL: local + "?%68ost=staging.invalid" },
    { DATABASE_URL: local + "?hostaddr=192.0.2.1" },
    { DATABASE_URL: local + "?port=6432" },
    { DATABASE_URL: local + "?user=foreign" },
    { DATABASE_URL: local + "?dbname=foreign" },
    { DATABASE_URL: local + "?options=owned" },
    { DATABASE_URL: local, APP_ENV: "staging" },
    { DATABASE_URL: local, PRIVATE_DB_MIGRATION_TARGET: "production" },
    { DATABASE_URL: local, FRONTEND_WRITER_ADMISSION_MODE: "invalid" },
  ]) {
    assert.throws(() => assertManualWriterTarget(env), /Writer admission configuration/);
  }
});

test("manual dry-run callback bypasses target and admission checks", async () => {
  let callbacks = 0;
  const result = await runManualWriterAdmission(false, "new-work", async () => {
    callbacks += 1;
    return "owned-read-only";
  }, async () => assert.fail("dry run must not acquire admission"));
  assert.equal(result, "owned-read-only");
  assert.equal(callbacks, 1);
});

const manualWriters = [
  ["backfill-product-stock", "--execute", /inspect the retained admission outcome/],
  ["bootstrap-booking-operations", "--execute", /Writer admission configuration/],
  ["import-booking-operational-cutover", "--execute", /Writer admission configuration/],
  ["backfill-marketing-contact-submissions", "--execute", /Writer admission configuration/],
  ["backfill-marketing-sync-jobs", "--execute", /Writer admission configuration/],
  ["requeue-marketing-sync-failures", "--execute", /Writer admission configuration/],
  ["highlevel-backfill", "--apply", /highlevel_backfill_failed/],
  ["highlevel-config-check", null, /highlevel_configuration_check_failed/],
] as const;

test("actual manual writer entrypoints refuse remote URLs without enforced admission before SQL or provider calls", () => {
  for (const mode of [undefined, "off"]) {
    for (const [script, writeFlag, failure] of manualWriters) {
      const result = spawnSync(process.execPath, ["--import", "./scripts/register-server-only-test.mjs",
        "--import", "tsx", "--input-type=module", "--eval", `
          import {createRequire} from "node:module";
          const require = createRequire(import.meta.url);
          const failEffect = (effect) => {
            process.stderr.write("OWNED_" + effect + "_REACHED");
            process.exit(91);
          };
          for (const name of ["Pool", "Client"]) require("pg")[name] = class {
            constructor() { failEffect("SQL"); }
          };
          require("node:net").Socket.prototype.connect = () => failEffect("NETWORK");
          globalThis.fetch = () => failEffect("PROVIDER");
          process.argv.push("owned-manual-guard-fixture");
          if (${JSON.stringify(writeFlag)} !== null) process.argv.push(${JSON.stringify(writeFlag)});
          await import("./scripts/${script}.ts");
        `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: {
          NODE_ENV: "test",
          DOTENV_CONFIG_PATH: "./scripts/owned-manual-test-dotenv-must-not-exist",
          DATABASE_URL: "postgresql://owned@staging.invalid/owned_manual?sslmode=verify-full",
          ...(mode === undefined ? {} : { FRONTEND_WRITER_ADMISSION_MODE: mode,
            PRIVATE_DB_MIGRATION_TARGET: "staging", PRIVATE_DB_MIGRATION_HOST: "staging.invalid" }),
          NEXT_PUBLIC_SANITY_PROJECT_ID: "owned",
          NEXT_PUBLIC_SANITY_DATASET: "owned",
          SERVICE_BOOKING_MODEL_MODE: "dual",
        } });
      const context = `${script} mode=${mode}: ${result.stderr}`;
      assert.equal(result.status, 1, context);
      assert.match(result.stderr, failure, context);
      assert.doesNotMatch(result.stderr, /OWNED_(SQL|NETWORK|PROVIDER)_REACHED/, context);
      assert.equal(result.stdout, "", context);
    }
  }
});
