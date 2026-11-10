import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { currentWriterOperationIdentity, withWriterOperationContext } from "@/lib/writer-admission/context";
import { traceLifecycleCronAdmission } from "./native-trace";

const identity = { operationId: "11111111-1111-4111-8111-111111111111", producerSha256: "b".repeat(64),
  sourceCommit: "c".repeat(40), epoch: "7", kind: "recovery" as const, targetSha256: "a".repeat(64) };
function environment(): Record<string, string | undefined> {
  return { VERCEL: "1", APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_GIT_COMMIT_SHA: identity.sourceCommit, LASH_P2_CERTIFICATION_SCHEDULES: "account-lifecycle",
    CRON_SECRET: "private-value", DATABASE_URL: "private-database-value" };
}
test("native correlation emits only opaque internally scoped fields after admission", async () => {
  const lines: string[] = [];
  traceLifecycleCronAdmission(environment(), line => lines.push(line)); assert.equal(lines.length, 0);
  await withWriterOperationContext(async () => traceLifecycleCronAdmission(environment(), line => lines.push(line)), identity);
  assert.deepEqual(JSON.parse(lines[0]), { version: 1, status: "P2_LIFECYCLE_CRON_ADMITTED", environment: "staging",
    projectId: VERCEL_PROJECT_BINDINGS.stagingProjectId, ...identity });
  assert.equal(lines.join("").includes("private-"), false); assert.equal(currentWriterOperationIdentity(), undefined);
});
test("production, previews, disabled qualification, different source and ordinary new work emit no trace", async () => {
  const lines: string[] = [];
  for (const change of [{ APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { VERCEL_ENV: "preview" }, { LASH_P2_CERTIFICATION_SCHEDULES: "off" }, { VERCEL_GIT_COMMIT_SHA: "d".repeat(40) },
    { VERCEL_PROJECT_ID: "foreign-project" }, { APP_VERCEL_TEAM_ID: "foreign-team" }]) {
    await withWriterOperationContext(async () => traceLifecycleCronAdmission({ ...environment(), ...change }, line => lines.push(line)), identity);
  }
  await withWriterOperationContext(async () => traceLifecycleCronAdmission(environment(), line => lines.push(line)), { ...identity, kind: "new-work" });
  assert.deepEqual(lines, []);
});
test("concurrent contexts do not share operation IDs and unavailable logging cannot authorize qualification", async () => {
  const lines: string[] = [];
  await Promise.all([identity.operationId, "22222222-2222-4222-8222-222222222222"].map(operationId => withWriterOperationContext(async () => {
    await Promise.resolve(); traceLifecycleCronAdmission(environment(), line => lines.push(line));
    assert.doesNotThrow(() => traceLifecycleCronAdmission(environment(), () => { throw new Error("private-log-error"); }));
  }, { ...identity, operationId })));
  assert.deepEqual(lines.map(line => JSON.parse(line).operationId).sort(), [identity.operationId, "22222222-2222-4222-8222-222222222222"]);
  assert.equal(currentWriterOperationIdentity(), undefined);
});
