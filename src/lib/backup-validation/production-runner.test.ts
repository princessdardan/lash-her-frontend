import assert from "node:assert/strict";
import test from "node:test";
import { runProductionBackupValidation } from "./production-runner";

const env = {
  BACKUP_VALIDATION_RUNNER_SECRET: "a".repeat(64),
  APP_ENV: "production",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_ID: "prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy",
};
const executionId = "schx_2AQSE2KPRAZHHMCDYYHHKG8J2Z";
const scheduledAt = "2026-01-05T06:00:00.000Z";
const headers = {
  "ce-id": executionId,
  "ce-source": "/schedule/default/backup-validation",
  "ce-vssschedulesource": "static",
  "ce-vssexpression": "0 6 * * 1",
  "ce-vssscheduledat": scheduledAt,
};
const proof = {
  validationPerformed: true,
  provider: "neon",
  executionId,
  snapshot: "snap-example",
  recoverySource: "snapshot",
  recoveryPointAt: "2026-01-05T02:00:00.000Z",
  migrationCount: 82,
  sourcePreserved: true,
  isolatedRestore: true,
  cleanupVerified: true,
  schemaMatches: true,
  migrationLineageMatches: true,
  readOnly: true,
  tlsVerified: true,
};
const request = (values = headers) => new Request("https://lash.test", { headers: values });
const unexpected = async (): Promise<never> => assert.fail("No restore or datastore call expected");

test("production restore is fail-closed on the wrong target or a non-weekly invocation", async () => {
  await assert.rejects(runProductionBackupValidation(request(), {
    ...env, VERCEL_PROJECT_ID: "prj_other",
  }, unexpected, unexpected), /runner binding/);
  await assert.rejects(runProductionBackupValidation(
    request({ ...headers, "ce-vssscheduledat": "2026-01-05T06:00:01.000Z" }),
    env, unexpected, unexpected,
  ), /Schedule event/);
});

test("a single weekly occurrence claims before invoking the pinned runner and cannot invoke it twice", async () => {
  const claimed = new Set<string>();
  let calls = 0;
  const claim = async (slot: string) => {
    assert.equal(slot, scheduledAt);
    if (claimed.has(slot)) return false;
    claimed.add(slot);
    return true;
  };
  const fakeFetch: typeof fetch = async (url, options) => {
    assert.equal(url, "https://lash-her-production-backup-runner.vercel.app/api/restore");
    assert.equal(options?.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).get("x-backup-execution-id"), executionId);
    assert.equal(claimed.has(scheduledAt), true);
    calls += 1;
    return Response.json(proof);
  };
  const first = await runProductionBackupValidation(request(), env, fakeFetch, claim);
  const duplicate = await runProductionBackupValidation(
    request({ ...headers, "ce-id": "schx_1AQSE2KPRAZHHMCDYYHHKG8J2Z" }), env, fakeFetch, claim,
  );
  assert.equal(first?.validationPerformed, true);
  assert.equal(duplicate?.validationPerformed, false);
  assert.equal(calls, 1);
});

test("a restore receipt must match the execution and verify cleanup", async () => {
  for (const response of [
    { ...proof, cleanupVerified: false },
    { ...proof, executionId: "schx_tampered" },
  ]) {
    await assert.rejects(runProductionBackupValidation(request(), env,
      async () => Response.json(response), async () => true), /incomplete proof/);
  }
});

test("a point-in-time receipt identifies the historical backup without a snapshot ID", async () => {
  const { snapshot, ...pitrProof } = proof;
  assert.equal(typeof snapshot, "string");
  const result = await runProductionBackupValidation(request(), env,
    async () => Response.json({ ...pitrProof, recoverySource: "point_in_time" }), async () => true);
  assert.equal(result?.validationPerformed, true);
  assert.equal(result?.validationPerformed && result.recoverySource, "point_in_time");
});
