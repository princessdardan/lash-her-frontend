import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
