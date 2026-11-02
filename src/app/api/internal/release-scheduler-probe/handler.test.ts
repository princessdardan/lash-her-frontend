import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS as ids } from "@/lib/env/application-environment.mjs";
import { createSchedulerProbeHandler, readSchedulerProbeConfiguration } from "./handler";

const now = 1_794_000_000_000;
const cronSecret = "fixture-cron-secret-12345";
function environment() {
  return { LASH_RELEASE_SCHEDULER_QUALIFICATION: "true", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    APP_ENV: "staging", APP_VERCEL_TEAM_ID: ids.teamId, VERCEL_PROJECT_ID: ids.stagingProjectId,
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40), LASH_RELEASE_PROBE_SECRET: "b".repeat(64),
    LASH_RELEASE_PROBE_EXPIRES_AT: String(now + 60_000), CRON_SECRET: cronSecret,
    API_GATEWAY_STAGING_ORIGIN: "https://gateway.example.invalid" };
}
const request = (headers: Record<string, string> = {}) => new Request("https://fixture.vercel.app/api/internal/release-scheduler-probe", {
  headers: { authorization: `Bearer ${cronSecret}`, "user-agent": "vercel-cron/1.0", "x-vercel-cron-schedule": "* * * * *", ...headers },
});

test("scheduler probe requires opt-in, bounded staging identity and a usable existing cron binding", () => {
  assert.ok(readSchedulerProbeConfiguration(environment(), now));
  for (const changed of [
    { LASH_RELEASE_SCHEDULER_QUALIFICATION: undefined }, { LASH_RELEASE_SCHEDULER_QUALIFICATION: "false" },
    { APP_ENV: "production", VERCEL_PROJECT_ID: ids.productionProjectId, API_GATEWAY_PRODUCTION_ORIGIN: "https://gateway.example.invalid" },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" }, { LASH_RELEASE_PROBE_EXPIRES_AT: String(now) },
    { CRON_SECRET: "" }, { CRON_SECRET: "short" }, { CRON_SECRET: " leading-spaces-refused" }, { CRON_SECRET: "x".repeat(8193) },
  ]) assert.equal(readSchedulerProbeConfiguration({ ...environment(), ...changed }, now), null);
});

test("disabled, unauthenticated and wrong-job requests do no upstream work or logging", async () => {
  let calls = 0, records = 0;
  const deps = { configuration: () => readSchedulerProbeConfiguration(environment(), now), now: () => now,
    run: async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; }, record: () => { records++; } };
  assert.equal((await createSchedulerProbeHandler({ ...deps, configuration: () => null })(request())).status, 404);
  const handler = createSchedulerProbeHandler(deps);
  for (const authorization of ["", "Bearer wrong", `Bearer ${"b".repeat(64)}`]) {
    assert.equal((await handler(request({ authorization }))).status, 401);
  }
  const wrongJobs: Record<string, string>[] = [{ "user-agent": "curl" }, { "x-vercel-cron-schedule": "*/5 * * * *" }];
  for (const headers of wrongJobs) {
    assert.equal((await handler(request(headers))).status, 400);
  }
  assert.equal((await createSchedulerProbeHandler({ ...deps, now: () => now + 60_000 })(request())).status, 404);
  assert.equal(calls, 0); assert.equal(records, 0);
});

test("successful scheduled work uses the selected origin and records only a source-bound sanitized receipt", async () => {
  const records: Record<string, string | number>[] = [];
  const handler = createSchedulerProbeHandler({ configuration: () => readSchedulerProbeConfiguration(environment(), now), now: () => now,
    run: async (...args) => { assert.deepEqual(args, ["https://gateway.example.invalid"]); return { ok: true, service: "course", durationMs: 2 }; },
    record: (value) => records.push(value) });
  const response = await handler(request({ cookie: "private-cookie", "x-lash-workload-token": "untrusted-token" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const receipt = await response.json();
  assert.deepEqual(records, [receipt]);
  assert.equal(receipt.status, "FRONTEND_SCHEDULED_WORKLOAD_PROBE_PASS");
  assert.equal(receipt.projectId, ids.stagingProjectId); assert.equal(receipt.sourceCommit, "a".repeat(40));
  assert.match(receipt.invocationId, /^[0-9a-f-]{36}$/u);
  for (const value of [cronSecret, "b".repeat(64), "private-cookie", "untrusted-token"]) assert.ok(!JSON.stringify(receipt).includes(value));
});

test("upstream failure, late completion and evidence failure never produce a success response", async () => {
  for (const mode of ["upstream", "expired", "record"]) {
    let clock = now, records = 0;
    const handler = createSchedulerProbeHandler({ configuration: () => readSchedulerProbeConfiguration(environment(), now), now: () => clock,
      run: async () => { if (mode === "upstream") throw new Error(cronSecret); if (mode === "expired") clock += 60_000;
        return { ok: true, service: "course", durationMs: 1 }; },
      record: () => { if (mode === "record") throw new Error(cronSecret); records++; } });
    const response = await handler(request());
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(cronSecret));
    assert.equal(records, 0);
  }
});
