import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const isolatedUrl = "postgresql://fixture:synthetic-password@127.0.0.1/lash_her_test?sslmode=disable";

for (const [label, url, releaseEnv] of [
  ["missing test URL", undefined, {}],
  ["external target", isolatedUrl.replace("127.0.0.1", "database.example.invalid"), {}],
  ["non-PostgreSQL scheme", isolatedUrl.replace("postgresql:", "https:"), {}],
  ["driver host override", isolatedUrl + "&host=database.example.invalid", {}],
  ["driver port override", isolatedUrl + "&port=35432", {}],
  ["driver database override", isolatedUrl + "&dbname=other", {}],
  ["missing database name", isolatedUrl.replace("/lash_her_test", "/"), {}],
  ["system database", isolatedUrl.replace("/lash_her_test", "/postgres"), {}],
  ["unqualified database", isolatedUrl.replace("/lash_her_test", "/neondb"), {}],
  ["release-named database", isolatedUrl.replace("/lash_her_test", "/lash_her_production_test"), {}],
  ["duplicate query setting", isolatedUrl + "&sslmode=require", {}],
  ["staging environment", isolatedUrl, { APP_ENV: "staging" }],
  ["production environment", isolatedUrl, { VERCEL_TARGET_ENV: "production" }],
]) {
  test(`DB test entrypoint refuses ${label} before starting tests`, () => {
    const result = spawnSync(process.execPath, [
      "scripts/run-source-unit-tests.mjs",
      "--db-only",
    ], {
      encoding: "utf8",
      env: {
        ...(url === undefined ? {} : { TEST_DATABASE_URL: url }),
        ...releaseEnv,
      },
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DB unit tests require TEST_DATABASE_URL to name a disposable loopback PostgreSQL database/u);
    assert.doesNotMatch(result.stderr, /synthetic-password|database\.example\.invalid/u);
    assert.equal(result.stdout, "");
  });
}
