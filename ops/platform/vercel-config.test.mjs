import assert from "node:assert/strict";
import test from "node:test";
import { createVercelConfiguration } from "./vercel-config.mjs";
import { VERCEL_PROJECT_BINDINGS as ids } from "../../src/lib/env/application-environment.mjs";

const now = 1_794_000_000_000;
const qualification = () => ({ LASH_RELEASE_SCHEDULER_QUALIFICATION: "true", APP_ENV: "staging",
  VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", VERCEL_PROJECT_ID: ids.stagingProjectId,
  APP_VERCEL_TEAM_ID: ids.teamId, VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  LASH_RELEASE_PROBE_EXPIRES_AT: String(now + 60_000) });

test("ordinary builds preserve all nine business schedules and publication branch deployment suppression", () => {
  const config = createVercelConfiguration({});
  assert.deepEqual(config.crons, [
    { path: "/api/admin/private-data-retention", schedule: "17 8 * * *" },
    { path: "/api/cron/backup-validation", schedule: "0 6 * * 1" },
    { path: "/api/admin/payment-reconciliation", schedule: "*/30 * * * *" },
    { path: "/api/cron/chitchats-shipping", schedule: "* * * * *" },
    { path: "/api/cron/customer-email-outbox", schedule: "*/5 * * * *" },
    { path: "/api/cron/product-stock-reservations", schedule: "*/15 * * * *" },
    { path: "/api/admin/marketing-contact-sync", schedule: "*/5 * * * *" },
    { path: "/api/cron/shipping-rate-cache-refresh", schedule: "30 7 * * 1" },
    { path: "/api/cron/highlevel-sync", schedule: "* * * * *" },
  ]);
  assert.deepEqual(config.git, { deploymentEnabled: { "codex/p1-platform-foundation-20261101": false } });
  assert.deepEqual(createVercelConfiguration({ LASH_RELEASE_SCHEDULER_QUALIFICATION: "false" }), config);
  config.crons.pop();
  assert.equal(createVercelConfiguration({}).crons.length, 9);
});

test("qualification selects only the bounded staging smoke job and never serializes credentials", () => {
  const input = { ...qualification(), CRON_SECRET: "private-cron", LASH_RELEASE_PROBE_SECRET: "private-probe" };
  const selected = createVercelConfiguration(input, now);
  assert.deepEqual(selected.crons, [{ path: "/api/internal/release-scheduler-probe", schedule: "* * * * *" }]);
  assert.ok(!JSON.stringify(selected).includes("private"));
  assert.equal(selected.crons.some((item) => item.path.includes("highlevel")), false);
});

test("wrong target, source, expiry or malformed mode stops qualification configuration", () => {
  for (const changed of [
    { APP_ENV: "production", VERCEL_PROJECT_ID: ids.productionProjectId },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { APP_VERCEL_TEAM_ID: "team_other" }, { VERCEL_PROJECT_ID: "prj_other" },
    { VERCEL_GIT_COMMIT_SHA: "0".repeat(40) }, { VERCEL_GIT_COMMIT_SHA: undefined },
    { LASH_RELEASE_PROBE_EXPIRES_AT: String(now) }, { LASH_RELEASE_PROBE_EXPIRES_AT: String(now + 3_600_001) },
    { LASH_RELEASE_PROBE_EXPIRES_AT: undefined }, { LASH_RELEASE_SCHEDULER_QUALIFICATION: "yes" },
  ]) assert.throws(() => createVercelConfiguration({ ...qualification(), ...changed }, now));
});
