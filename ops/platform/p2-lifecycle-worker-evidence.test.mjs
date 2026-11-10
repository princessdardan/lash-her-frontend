import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Client } from "pg";
import { validateP2ReceiverDenialInput, observeCourseSuspensionDenial, observeCommunitySuspensionDenial } from "./p2-lifecycle-receiver-denial.mjs";
import { createP2LifecycleWorkerPrivateResolvers, prepareP2LifecycleWorkerEvidencePlan, preflightP2DirectLifecycleWorker,
  readP2LifecycleWorkerCronSecret, readP2LifecycleWorkerRuntimeUrl, readP2DirectWorkerSourceArtifact } from "./p2-lifecycle-worker-evidence.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";

function input() { return { version: 1, mode: "course-http", environment: "staging", bindingSha256: "a".repeat(64), subject: randomUUID(), courseId: randomUUID(),
  currentKey: "OWNED-SYNTHETIC-CURRENT-KEY-NEVER-LIVE".repeat(2), gatewayCaSha256: "b".repeat(64), runtimeEnvironment: null, target: null }; }
test("private denial profile cannot select a URL, SQL, token, command or Community HTTP feature", () => {
  validateP2ReceiverDenialInput(input());
  for (const change of [row => { row.url = "https://foreign.invalid"; }, row => { row.sql = "SELECT 1"; }, row => { row.token = "arbitrary"; },
    row => { row.mode = "community-http"; }, row => { row.environment = "production"; }]) {
    const value = input(); change(value); assert.throws(() => validateP2ReceiverDenialInput(value));
  }
});
test("source private resolvers read only approved runtime inputs and foreign handles refuse", async () => {
  const original = process.env.FRONTEND_STAGING_CRON_SECRET; let reads = 0;
  const handle = createP2LifecycleWorkerPrivateResolvers(async () => { reads++; return { frontendRuntimeDatabaseUrl: "OWNED-PRIVATE-RUNTIME-URL" }; });
  assert.equal(reads, 0); assert.throws(() => readP2LifecycleWorkerCronSecret({}));
  process.env.FRONTEND_STAGING_CRON_SECRET = "OWNED-SYNTHETIC-CRON-SECRET";
  try {
    assert.equal(readP2LifecycleWorkerCronSecret(handle), "OWNED-SYNTHETIC-CRON-SECRET");
    assert.equal(await readP2LifecycleWorkerRuntimeUrl(handle), "OWNED-PRIVATE-RUNTIME-URL"); assert.equal(reads, 1);
    assert.equal(JSON.stringify(handle).includes(process.env.FRONTEND_STAGING_CRON_SECRET), false);
    assert.throws(() => readP2DirectWorkerSourceArtifact({}, { recordSha256: "a".repeat(64) }));
  } finally { if (original === undefined) delete process.env.FRONTEND_STAGING_CRON_SECRET; else process.env.FRONTEND_STAGING_CRON_SECRET = original; }
});
test("profiled direct-worker plan joins the original current native and suspension plans but has no apply authority", async () => {
  const sourceCommit = nativeSourceCommit(), candidateObjectSha256 = "a".repeat(64), targetSha256 = "b".repeat(64), configurationRecordSha256 = "c".repeat(64);
  const command = { commandId: randomUUID(), accountVersion: "1", action: "suspend" };
  const nativePlan = { version: 2, qualificationTargetProfile: current, environment: "staging", actionId: "owned-release", planSha256: "d".repeat(64),
    sourceCommit, candidateSha256: candidateObjectSha256, targetSha256, configurationRecordSha256,
    target: { qualificationTargetProfile: current, host: "localhost", port: 5432, database: "owned_frontend", user: "owned_runtime", serverMajor: 18 }, commandWitnesses: [command] };
  const suspensionPlan = { version: 2, qualificationTargetProfile: current, environment: "staging", profile: "normal-ui-suspension-pending-v1",
    releaseId: nativePlan.actionId, sourceCommit, candidateSha256: "e".repeat(64), candidateObjectSha256, targetSha256,
    configurationRecordSha256, configurationSha256: "f".repeat(64) };
  const selected = { version: 2, qualificationTargetProfile: current, actionId: "owned-certification", commandIndex: 0,
    pendingRecordSha256: "1".repeat(64), canonicalCommandSha256: "2".repeat(64), gatewayProcessSha256: "3".repeat(64),
    gatewayConfigurationSha256: "4".repeat(64), denialProgramSha256: "5".repeat(64) };
  const plan = prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, selected, current);
  assert.equal(plan.version, 2); assert.deepEqual(plan.qualificationTargetProfile, current);
  assert.equal(plan.profile, "direct-known-suspension-v1"); assert.equal(plan.candidateObjectSha256, candidateObjectSha256);
  assert.equal(Object.hasOwn(plan, "receiverNegatives"), false);
  const receiverNegatives = { profile: "suspended-head-negatives-v2" };
  const withNegatives = prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, { ...selected, receiverNegatives }, current);
  assert.equal(withNegatives.receiverNegatives.profile, receiverNegatives.profile);
  assert.match(withNegatives.receiverNegatives.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.match(withNegatives.receiverNegatives.hostSourceSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan,
    { ...selected, receiverNegatives: { ...receiverNegatives, case: "future-gap" } }, current));
  const resolvers = createP2LifecycleWorkerPrivateResolvers(async () => ({ frontendRuntimeDatabaseUrl: "owned" }));
  const client = new Client({ host: nativePlan.target.host, port: nativePlan.target.port });
  client.connection.stream = { encrypted: true, authorized: true };
  let verified = false;
  await assert.rejects(preflightP2DirectLifecycleWorker(plan, {}, resolvers, client,
    { verifyEnvironment: async () => { verified = true; throw new Error("OWNED_PROFILED_PLAN_REGISTERED"); }, verifySession: async () => {} }),
    /OWNED_PROFILED_PLAN_REGISTERED/u);
  assert.equal(verified, true);
  for (const mutate of [value => { delete value.nativePlan.target.qualificationTargetProfile; },
    value => { value.nativePlan.actionId = "different-release"; }, value => { delete value.suspensionPlan.qualificationTargetProfile; },
    value => { value.input.version = 1; }]) {
    const value = structuredClone({ nativePlan, suspensionPlan, input: selected }); mutate(value);
    assert.throws(() => prepareP2LifecycleWorkerEvidencePlan(value.nativePlan, value.suspensionPlan, value.input, current));
  }
  assert.throws(() => prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, selected));
});
test("Course403 must be the exact account restriction, never generic403/401/429/503", async () => {
  const { createHash } = await import("node:crypto"), ca = Buffer.from("OWNED-UNIT-CA");
  const selected = { ...input(), gatewayCaSha256: createHash("sha256").update(ca).digest("hex") };
  for (const [status, code, message, passes] of [[403, "FORBIDDEN", "Account access is unavailable", true], [403, "FORBIDDEN", "Other refusal", false],
    [401, "UNAUTHORIZED", "Unauthorized", false], [429, "RATE_LIMITED", "Rate limited", false], [503, "UNAVAILABLE", "Unavailable", false]]) {
    const request = (options, receive) => {
      assert.equal(options.hostname, "course-tls"); assert.equal(options.port, 8443); assert.equal(options.method, "GET"); assert.equal(options.rejectUnauthorized, true);
      const outgoing = new EventEmitter(); outgoing.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = status; response.headers = { "cache-control": "private, no-store", "x-request-id": "owned-request" };
        receive(response); response.emit("data", Buffer.from(JSON.stringify({ error: { code, message } }))); response.emit("end");
      }); return outgoing;
    };
    if (passes) { const result = await observeCourseSuspensionDenial(selected, { ca, request }); assert.equal(result.evidenceClass, "actual-protected-course-http"); assert.equal(result.httpStatus, 403); }
    else await assert.rejects(observeCourseSuspensionDenial(selected, { ca, request }));
  }
});
test("Community requires actualproduction runtime configuration before any private module load", async () => {
  const selected = { ...input(), mode: "community-private-guard", gatewayCaSha256: null, runtimeEnvironment: { DATABASE_TARGET: "staging" },
    target: { host: "localhost", port: 5432, database: "owned", runtimeRole: "owned_runtime", runtimeRoleOid: "123", serverMajor: 16 } };
  let loaded = false;
  await assert.rejects(observeCommunitySuspensionDenial(selected, { environment: { NODE_ENV: "test", DATABASE_TARGET: "staging" }, load: async () => { loaded = true; } }));
  assert.equal(loaded, false);
});
