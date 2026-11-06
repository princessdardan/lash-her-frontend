import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareFrontendRolesPlan, applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES, frontendRolesHash, readFrontendRolesMigrationCredential } from "./frontend-role-preparation.mjs";
import { frontendRolesCli } from "./prepare-frontend-roles.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";

export function roleFixture(target = {}) {
  const image = `sha256:${"d".repeat(64)}`, sourceCommit = "a".repeat(40), sqlArtifactSha256 = "b".repeat(64), phase2ContractManifestSha256 = `sha256:${"c".repeat(64)}`;
  const candidate = { version: 2, releaseId: "owned-role-preparation", environment: "staging", integration: { state: "passed" },
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    contractPhase: "p2", phase2ContractManifestSha256, contractManifestSha256: `sha256:${"e".repeat(64)}`,
    frontendMigration: { sourceCommit, sqlArtifactSha256, contractPhase: "p2", phase2ContractManifestSha256, contractManifestSha256: `sha256:${"e".repeat(64)}` }, artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${image}` } } };
  const job = { version: 1, operator: "Dardan", releaseId: candidate.releaseId, environment: "staging", sourceCommit, contractPhase: "p2", phase2ContractManifestSha256,
    contractManifestSha256: candidate.contractManifestSha256, migrationImageDigest: image, sqlArtifactSha256, recoveryRef: "owned/recovery-1",
    target: { host: "owned.invalid", port: 5432, database: "frontend_role_owned", user: "frontend_operator", runtimeRole: FRONTEND_PREPARATION_ROLES.runtime, serverMajor: 16, ...target } };
  return { candidate, job, specification: { version: 1, producerSha256: ["f".repeat(64)] } };
}

test("offline plan binds qualified P2 candidate/job/target/recovery and fixed NOINHERIT replacement names without inventing OIDs", () => {
  const fixture = roleFixture(), plan = prepareFrontendRolesPlan(fixture.candidate, fixture.job, fixture.specification);
  assert.equal(plan.candidateSha256, frontendRolesHash(fixture.candidate)); assert.equal(plan.jobSha256, frontendRolesHash(fixture.job));
  assert.deepEqual(plan.desiredRoles, FRONTEND_PREPARATION_ROLES); assert.equal(plan.migrationAuthorized, false);
  assert.ok(!JSON.stringify(plan).includes('"oid"')); assert.equal(plan.recoveryRef, fixture.job.recoveryRef); assert.ok(Object.isFrozen(plan.target));
});
test("profiled role plans require the separately selected candidate, target and specification context without inferring OIDs", async () => {
  const f = roleFixture(); f.candidate.version = 3; f.job.version = 2; f.specification.version = 2;
  for (const value of [f.candidate, f.candidate.frontendMigration, f.job, f.job.target, f.specification]) value.qualificationTargetProfile = current;
  const plan = prepareFrontendRolesPlan(f.candidate, f.job, f.specification, current);
  assert.equal(plan.version, 2); assert.deepEqual(plan.qualificationTargetProfile, current); assert.deepEqual(plan.target.qualificationTargetProfile, current);
  assert.ok(!JSON.stringify(plan).includes('"oid"')); assert.equal(plan.migrationAuthorized, false);
  assert.equal(plan.candidateSha256, frontendRolesHash(f.candidate));
  assert.throws(() => prepareFrontendRolesPlan(f.candidate, f.job, f.specification), /QUALIFICATION_TARGET_PROFILE_REFUSED/u);
  let queries = 0; const client = { query() { queries++; throw new Error("query-before-profile"); } };
  await assert.rejects(applyPreparedFrontendRoles(plan, client, {}), /QUALIFICATION_TARGET_PROFILE_REFUSED/u);
  await assert.rejects(applyPreparedFrontendRoles(plan, client, {}, null), /QUALIFICATION_TARGET_PROFILE_REFUSED/u);
  await assert.rejects(applyPreparedFrontendRoles(structuredClone(plan), client, {}, current));
  assert.equal(queries, 0);
  delete f.job.target.qualificationTargetProfile;
  assert.throws(() => prepareFrontendRolesPlan(f.candidate, f.job, f.specification, current), /QUALIFICATION_TARGET_PROFILE_REQUIRED/u);
  for (const expected of [null, {}, { ...current, id: "p2q-20261106" }]) {
    assert.throws(() => prepareFrontendRolesPlan({ get frontendMigration() { throw new Error("carrier-before-context"); } }, undefined, undefined, expected), /QUALIFICATION_TARGET_PROFILE_/u);
    assert.throws(() => readFrontendRolesMigrationCredential("/must-not-read", expected), /QUALIFICATION_TARGET_PROFILE_/u);
  }
});
test("role plan refuses wrong candidate/source/target/environment/name/producer and accidental credential material", () => {
  for (const mutate of [f => { f.candidate.environment = "production"; }, f => { f.job.sourceCommit = "0".repeat(40); },
    f => { f.job.target.runtimeRole = "lash_her_frontend_staging_runtime"; }, f => { f.job.target.host = "ep-owned-pooler.invalid"; },
    f => { f.job.target.user = FRONTEND_PREPARATION_ROLES.owner; }, f => { f.specification.producerSha256 = []; },
    f => { f.specification.producerSha256.push(f.specification.producerSha256[0]); }, f => { f.job.recoveryRef = ""; },
    f => { f.job.phase2ContractManifestSha256 = `sha256:${"0".repeat(64)}`; }, f => { f.candidate.password = "synthetic-secret"; }]) {
    const fixture = roleFixture(); mutate(fixture); assert.throws(() => prepareFrontendRolesPlan(fixture.candidate, fixture.job, fixture.specification));
  }
});
test("reuse requires actual explicitly reviewed distinct OIDs and retained proof reference", () => {
  for (const reuse of [{}, { ownerOid: "10", runtimeOid: "10", proofSha256: "f".repeat(64) }, { ownerOid: "10", runtimeOid: "11", proofSha256: "" }]) {
    const f = roleFixture(); assert.throws(() => prepareFrontendRolesPlan(f.candidate, f.job, { ...f.specification, reuse }));
  }
});
test("serialized plans and missing parent lock/session hooks cannot reach SQL", async () => {
  const f = roleFixture(), plan = prepareFrontendRolesPlan(f.candidate, f.job, f.specification); let queries = 0;
  const client = { query: async () => { queries++; } };
  await assert.rejects(applyPreparedFrontendRoles(structuredClone(plan), client, {}));
  await assert.rejects(applyPreparedFrontendRoles(plan, client, { confirmation: "staging/owned-role-preparation" })); assert.equal(queries, 0);
});
test("standalone defaults to offline planning and never reads configured migration credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frontend-roles-plan-"));
  try {
    const f = roleFixture(), files = ["candidate", "job", "specification"].map(key => { const file = join(directory, `${key}.json`); writeFileSync(file, JSON.stringify(f[key])); return file; });
    const result = await frontendRolesCli(files, { FRONTEND_ROLES_MIGRATION_PRIVATE_DIRECTORY: "/must-not-read" });
    assert.equal(result.actionId, "owned-role-preparation"); assert.equal(result.migrationAuthorized, false);
    await assert.rejects(frontendRolesCli(["--apply", ...files], {}));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
