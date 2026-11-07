import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { observeFrontendBootstrapSchema, prepareFrontendBootstrapCompatibility } from "./frontend-bootstrap-compatibility.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const emptyCatalog = Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers",
  "functions", "enums", "sequences", "policies"].map(key => [key, []]));
const compatibility = version => ({ version, schemaCatalogSha256: hash(emptyCatalog), appliedLineageSha256: hash([]), appliedCount: 0,
  validationEvidenceSha256: "a".repeat(64), runtimeProducerSha256: "b".repeat(64), recoveryAfterCompatibleBuild: false });
const withProfile = value => Object.assign(value, { qualificationTargetProfile: STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE });

function inputs(profiled = false) {
  const selected = compatibility(profiled ? 2 : 1);
  const plan = { version: profiled ? 2 : 1, environment: "staging", actionId: "owned-bootstrap-observation",
    sourceCommit: "c".repeat(40), targetSha256: "d".repeat(64), bootstrapCompatibility: selected };
  const candidate = { version: profiled ? 3 : 2, frontendMigration: {} };
  const job = { version: profiled ? 2 : 1, target: {} };
  const migration = { candidate, job, baseline: { version: 1 }, artifact: { expected: [] } };
  if (profiled) for (const value of [plan, selected, migration, candidate, candidate.frontendMigration, job, job.target]) withProfile(value);
  return { plan, migration };
}

function fixture(profiled = false) {
  const { plan, migration } = inputs(profiled), calls = []; let verifies = 0;
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes("to_regclass")) return { rows: [{ present: false }] };
    return { rows: [] };
  } };
  const verifySession = async () => { verifies++; };
  return { plan, migration, calls, client, verifySession, verifies: () => verifies,
    run: expected => observeFrontendBootstrapSchema(client, plan, migration, verifySession, expected) };
}

test("legacy preparation and observation remain version 1 and profile-free", async () => {
  const f = fixture();
  const prepared = prepareFrontendBootstrapCompatibility(f.plan.bootstrapCompatibility);
  assert.equal(prepared.version, 1); assert.equal("qualificationTargetProfile" in prepared, false);
  const result = await f.run(undefined);
  assert.equal(result.version, 1); assert.equal("qualificationTargetProfile" in result, false);
  assert.equal(f.verifies(), 2); assert.equal(f.calls[0], "BEGIN READ ONLY"); assert.equal(f.calls.at(-1), "ROLLBACK");
});

test("profiled observation joins wrapper, candidate projection, job target and compatibility before I/O", async () => {
  const f = fixture(true);
  const prepared = prepareFrontendBootstrapCompatibility(f.plan.bootstrapCompatibility, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.equal(prepared.version, 2); assert.deepEqual(prepared.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  const result = await f.run(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.equal(result.version, 2); assert.deepEqual(result.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.equal(result.applicationSqlApplied, false); assert.equal(result.migrationAuthorized, false); assert.equal(result.trafficAuthorized, false);
  assert.equal(f.verifies(), 2); assert.equal(f.calls[0], "BEGIN READ ONLY"); assert.equal(f.calls.at(-1), "ROLLBACK");
  assert.equal("qualificationTargetProfile" in f.migration.artifact, false);
  assert.equal("qualificationTargetProfile" in f.migration.baseline, false);
});

test("profile mismatch, carrier omission, downgrade and null context refuse before hook or query", async () => {
  const changes = [
    f => { f.plan.version = 1; },
    f => { delete f.plan.bootstrapCompatibility.qualificationTargetProfile; },
    f => { delete f.migration.qualificationTargetProfile; },
    f => { delete f.migration.candidate.frontendMigration.qualificationTargetProfile; },
    f => { delete f.migration.job.target.qualificationTargetProfile; },
    f => { withProfile(f.migration.artifact); },
    f => { withProfile(f.migration.baseline); },
  ];
  for (const change of changes) {
    const f = fixture(true); change(f);
    await assert.rejects(f.run(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE));
    assert.equal(f.verifies(), 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture(true);
  await assert.rejects(f.run(null));
  assert.equal(f.verifies(), 0); assert.equal(f.calls.length, 0);
});

test("legacy mode rejects profile contamination in every consumed mutable carrier before I/O", async () => {
  for (const select of [
    f => f.plan,
    f => f.plan.bootstrapCompatibility,
    f => f.migration,
    f => f.migration.candidate,
    f => f.migration.candidate.frontendMigration,
    f => f.migration.job,
    f => f.migration.job.target,
  ]) {
    const f = fixture(); withProfile(select(f));
    await assert.rejects(f.run(undefined));
    assert.equal(f.verifies(), 0); assert.equal(f.calls.length, 0);
  }
});
