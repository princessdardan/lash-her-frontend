import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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
test("only the locked managed Neon target receives a password literal for server-side SCRAM", async t => {
  const raw = readFileSync(new URL("./managed-neon-replacement-catalog.json", import.meta.url));
  const catalog = JSON.parse(raw);
  const reference = { id: catalog.id, sha256: createHash("sha256").update(raw).digest("hex") };
  const makeProfiled = target => {
    const f = roleFixture(target);
    f.candidate.version = 3; f.job.version = 2; f.specification.version = 2;
    for (const value of [f.candidate, f.candidate.frontendMigration, f.job, f.job.target, f.specification]) {
      value.qualificationTargetProfile = current;
    }
    return prepareFrontendRolesPlan(f.candidate, f.job, f.specification, current);
  };
  for (const mode of ["managed", "stock", "foreign-oid", "foreign-provider", "unverified-tls"]) await t.test(mode, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "frontend-role-password-fixture-")));
    const directory = join(root, "roles"), privateDirectory = join(root, "credentials");
    mkdirSync(directory, { mode: 0o700 }); mkdirSync(privateDirectory, { mode: 0o700 });
    try {
      const plan = makeProfiled(mode === "stock" ? undefined : catalog.target);
      const operations = [];
      let passwordSql;
      const client = {
        connection: { stream: { encrypted: true, authorized: true } },
        connectionParameters: { host: plan.target.host, port: plan.target.port,
          ssl: { rejectUnauthorized: mode !== "unverified-tls" } },
        async query(statement) {
          if (typeof statement === "object") {
            const text = statement.text;
            if (text.includes("FROM pg_catalog.pg_roles")) return { rows: catalog.roles };
            if (text.includes("FROM pg_catalog.pg_auth_members")) return { rows: catalog.memberships };
            if (text.includes("FROM pg_catalog.pg_default_acl")) return { rows: catalog.defaultAcl };
            if (text.includes("FROM pg_catalog.pg_depend d")) return { rows: catalog.dependencies };
            if (text.includes("FROM pg_catalog.pg_shdepend d")) return { rows: catalog.sharedDependencies };
            if (text.includes("aclexplode(d.datacl)")) return { rows: catalog.databaseAclAfter };
            throw new Error("unexpected fixture catalog query");
          }
          if (statement.includes("pg_backend_pid() AS pid")) return { rows: [{ pid: 91, username: plan.target.user,
            session_username: plan.target.user, database: plan.target.database, major: plan.target.serverMajor, read_only: "off" }] };
          if (statement.includes("AS held")) return { rows: [{ held: true }] };
          if (statement.includes('AS "databaseOid"')) return { rows: [{ databaseOid: mode === "foreign-oid" ? "1" : catalog.databaseOid,
            migrationRoleOid: catalog.migrationRoleOid }] };
          if (statement.includes("rolname=ANY")) return { rows: [] };
          if (statement.includes(" PASSWORD ")) {
            passwordSql = statement;
            operations.push("password-role");
            throw Object.assign(new Error(statement), { code: "XX000" });
          }
          operations.push(statement);
          return { rows: [] };
        },
      };
      await assert.rejects(applyPreparedFrontendRoles(plan, client, {
        confirmation: "staging/owned-role-preparation", directory, privateDirectory,
        verifyEnvironment: async () => {}, verifySession: async () => {},
        ...(mode === "stock" ? {} : { managedNeon: { reference,
          administrativeLogins: catalog.administrativeLogins,
          provider: mode === "foreign-provider" ? { ...catalog.provider, branchId: "br-foreign" } : catalog.provider } }),
      }, current), { message: "FRONTEND_ROLE_PREPARATION_FAILED_REVIEW_REQUIRED" });
      const credential = JSON.parse(readFileSync(join(privateDirectory, "frontend-role-credentials.json"), "utf8"));
      const outcome = readFileSync(join(directory, "roles-preparation-outcome.json"), "utf8");
      assert.equal(outcome.includes(credential.password), false);
      assert.equal(JSON.parse(outcome).sqlOutcome, "rolled-back");
      assert.ok(operations.includes("ROLLBACK"));
      if (mode === "managed") {
        const encryption = operations.indexOf("SET LOCAL password_encryption = 'scram-sha-256'");
        assert.ok(encryption >= 0 && encryption < operations.indexOf("password-role"));
        assert.equal(passwordSql.endsWith(`PASSWORD '${credential.password}'`), true);
        assert.equal(JSON.parse(outcome).passwordAssignment, "managed-neon-server-scram");
      } else if (mode === "stock") {
        assert.equal(passwordSql.includes("PASSWORD 'SCRAM-SHA-256$"), true);
        assert.equal(passwordSql.includes(credential.password), false);
      } else {
        assert.equal(passwordSql, undefined);
        assert.ok(!operations.some(text => text.startsWith("CREATE ROLE")));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
