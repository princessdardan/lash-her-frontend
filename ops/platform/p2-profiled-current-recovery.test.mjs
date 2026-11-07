import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareP2ProfiledCurrentRecovery, runP2ProfiledCurrentRecovery, p2ProfiledCurrentRecoveryOperator } from "./p2-profiled-current-recovery.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

function fixture(disposition = "restore-current-runtime") {
  const target = { qualificationTargetProfile: profile, host: "db.example.com", port: 5432, database: "lash_staging", user: "migration_admin",
    runtimeRole: "frontend_runtime", serverMajor: 18, allowEmptyBootstrap: false, approvedPendingTags: [] };
  const job = service => ({ ...(service === "frontend" ? { version: 2 } : { schemaVersion: 2 }), qualificationTargetProfile: profile, service, operator: "Dardan", environment: "staging", releaseId: "owned-release",
    sourceCommit: service === "frontend" ? "a".repeat(40) : (service === "course" ? "b" : "c").repeat(40),
    target: { ...target, approvedPendingTags: disposition === "resume-approved-api-suffix" && service !== "frontend"
      ? [service === "course" ? "0012_owned" : "0009_owned"] : [] } });
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId: "owned-release",
    contractPhase: "p2", phase2ContractManifestSha256: "sha256:" + "8".repeat(64),
    sources: { frontend: { commit: "a".repeat(40) } }, frontendMigration: { qualificationTargetProfile: profile } };
  const configurationSha256 = Object.fromEntries(["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
    "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem",
    "tls/community/key.pem", "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env", "community-api.env",
    "community-worker.env", "course-media.env", "course-export-cleanup.env"].map((name, index) => [name, "abcdef"[index % 6].repeat(64)]));
  const inventory = { qualificationTargetProfile: profile, admissionMode: "existing" };
  return { version: 2, qualificationTargetProfile: profile, mode: "p2-profiled-current-recovery", environment: "staging",
    recoveryActionId: "owned-recovery", originalReleaseId: "owned-release", sourceCommit: "a".repeat(40), candidateSha256: "d".repeat(64),
    configurationSha256, targetSha256: "f".repeat(64),
    inventorySha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"), inventory,
    apiJobSha256: { course: "b".repeat(64), community: "c".repeat(64) }, owner: { name: "migration_owner", oid: "12345" }, disposition,
    originalReceiptSha256: Object.fromEntries(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome", "apiRuntimeOutcome",
      "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"]
      .slice(0, disposition === "resume-approved-api-suffix" ? 3 : 8).map((name, index) => [name, "12345678"[index].repeat(64)])),
    frontendMigration: { qualificationTargetProfile: profile, candidate, job: job("frontend"), baseline: { version: 1 }, artifact: { version: 1 } },
    courseJob: job("course"), communityJob: job("community"),
    ...(disposition === "resume-approved-api-suffix" ? { approvedApiSuffix: { course: ["0012_owned"], community: ["0009_owned"] } } : {}) };
}

test("preparation is source-profiled, immutable and does not claim SQL, history, traffic or release acceptance", () => {
  const prepared = prepareP2ProfiledCurrentRecovery(fixture());
  assert.deepEqual(prepared.plan.qualificationTargetProfile, profile);
  assert.equal(prepared.plan.status, undefined);
  for (const field of ["frontendSqlApplied", "rolePreparationAuthorized", "historicalProviderClosureClaimed", "historicalLoginsRestored",
    "oldP200Qualified", "nativeSchedulesEnabled", "trafficAuthorized", "releaseAccepted", "pendingFrontendSqlResolved"]) assert.equal(prepared.plan[field], false);
  assert.equal(Object.isFrozen(prepared.plan), true); assert.equal(Object.isFrozen(prepared.plan.originalReceiptSha256), true);
  assert.throws(() => { prepared.plan.disposition = "retry-sql"; }, TypeError);
});

test("closed recovery dispositions require exact matching carriers and only the approved API suffix has a suffix", () => {
  assert.equal(prepareP2ProfiledCurrentRecovery(fixture("resume-approved-api-suffix")).plan.approvedApiSuffix.course[0], "0012_owned");
  const earlyCurrent = fixture("restore-current-runtime");
  earlyCurrent.originalReceiptSha256 = Object.fromEntries(Object.entries(earlyCurrent.originalReceiptSha256).slice(0, 3));
  assert.equal(Object.keys(prepareP2ProfiledCurrentRecovery(earlyCurrent).plan.originalReceiptSha256).length, 3);
  const beforeApiCurrent = structuredClone(earlyCurrent); delete beforeApiCurrent.originalReceiptSha256.frontendContinuationStarted;
  assert.throws(() => prepareP2ProfiledCurrentRecovery(beforeApiCurrent));
  const promotedSuffix = fixture("resume-approved-api-suffix");
  promotedSuffix.originalReceiptSha256 = fixture().originalReceiptSha256;
  assert.equal(Object.keys(prepareP2ProfiledCurrentRecovery(promotedSuffix).plan.originalReceiptSha256).length, 8);
  const oneService = fixture("resume-approved-api-suffix"); oneService.approvedApiSuffix.community = [];
  const oneServicePlan = prepareP2ProfiledCurrentRecovery(oneService).plan;
  assert.deepEqual(oneServicePlan.approvedApiSuffix.community, []);
  assert.match(oneServicePlan.recoveryApiJobSha256.community, /^[a-f0-9]{64}$/u);
  for (const mutate of [value => { value.frontendMigration.job.version = 1; }, value => { delete value.frontendMigration.job.target.qualificationTargetProfile; },
    value => { value.communityJob.qualificationTargetProfile = { ...profile, sha256: "9".repeat(64) }; }, value => { value.disposition = "replay-frontend-sql"; },
    value => { value.frontendMigration.job.target.approvedPendingTags = ["0084_pending"]; }, value => { value.originalReceiptSha256 = {}; },
    value => { value.apiJobSha256.course = "0".repeat(64); },
    value => { value.approvedApiSuffix = { course: [], community: [] }; }]) {
    const changed = fixture(); mutate(changed); assert.throws(() => prepareP2ProfiledCurrentRecovery(changed));
  }
  const empty = fixture("resume-approved-api-suffix"); empty.approvedApiSuffix = { course: [], community: [] };
  assert.throws(() => prepareP2ProfiledCurrentRecovery(empty));
});

test("a materialized leaf plan cannot be submitted as the source operator settings packet", async () => {
  const settings = fixture("reconcile-frontend-get-first");
  await assert.rejects(p2ProfiledCurrentRecoveryOperator(settings));
  await assert.rejects(p2ProfiledCurrentRecoveryOperator(settings, { apply: true, confirmation: "staging/owned-recovery" }));
  const prepared = prepareP2ProfiledCurrentRecovery(settings);
  await assert.rejects(runP2ProfiledCurrentRecovery(prepared, { directory: "/private/tmp", getUrl() {}, assertSource() {}, getProviderContext() {} }));
});

test("the source CLI rejects unknown operations before settings or provider access", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./p2-profiled-current-recovery.mjs", import.meta.url)), "--retry", "--settings", "/not/read"],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_NO_WARNINGS: "1" } });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, "P2_PROFILED_CURRENT_RECOVERY_REFUSED\n");
});
