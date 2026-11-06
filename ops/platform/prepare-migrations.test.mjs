import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationOperatorCommand, prepareMigrationBundle, prepareProfiledCurrentMigrationBundle } from "./prepare-migrations.mjs";
import { createHash } from "node:crypto";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { decodeQualificationTargetJson, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";

function fixture() {
  const candidate = JSON.parse(readFileSync(new URL("./release.candidate.json", import.meta.url), "utf8"));
  candidate.releaseId = "fixture-release"; candidate.integration = { state: "passed" };
  candidate.contractManifestSha256 = `sha256:${"d".repeat(64)}`;
  candidate.sourceApproval = { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" };
  for (const source of Object.values(candidate.sources)) { source.commit = "a".repeat(40); source.requiredChecks = "passed"; }
  const settings = { environment: "staging", services: {} }, schemas = {};
  for (const name of ["course", "community"]) {
    for (const suffix of ["runtime", "migration"]) candidate.artifacts[`${name}${suffix === "runtime" ? "Runtime" : "Migration"}`] = {
      image: `ghcr.io/princessdardan/lash-her-platform-${name}-${suffix}@sha256:${(suffix === "migration" ? "b" : "c").repeat(64)}`,
      scan: "passed", sbomSha256: `sha256:${"d".repeat(64)}`, provenanceSha256: `sha256:${"e".repeat(64)}` };
    settings.services[name] = { host: `${name}.example.invalid`, port: 5432, database: `${name}_test`, user: "migration_role", serverMajor: 18,
      runtimeRole: "runtime_role", approvedPendingTags: ["0000_fixture"], allowEmptyBootstrap: true,
      providerIdentityEvidenceRef: "owned/reviewed-target", recoveryRef: "owned/recreation" };
    schemas[name] = { status: "OPERATOR_MIGRATION_OWNED_POSTGRES_PASS", service: `lash-her-${name}-api`, postgresMajor: 18, providerTouched: false,
      schemaBaseline: { schemaVersion: 1, serverMajor: 18, artifactSha256: "f".repeat(64), catalog: {} } };
  }
  return { candidate, settings, schemas };
}

function profiled(f) {
  f.candidate.version = 3;
  f.candidate.environment = "staging";
  f.candidate.approval ??= { state: "pending" };
  f.candidate.workload = { environment: "production", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" };
  f.settings.qualificationTargetProfile = current;
  for (const carrier of [f.candidate, f.candidate.sourceApproval, f.candidate.integration, ...Object.values(f.candidate.sources),
    f.candidate.workload, f.candidate.approval, ...Object.values(f.settings.services)]) carrier.qualificationTargetProfile = current;
  return f;
}

test("bundle preparation derives image/source/SQL bindings and excludes unknown credential fields", () => {
  const f = fixture(); f.settings.services.course.password = "fixture-credential-must-not-copy";
  const prepared = prepareMigrationBundle(f.candidate, f.settings, f.schemas);
  assert.equal(prepared.jobs.course.sourceCommit, f.candidate.sources.course.commit);
  assert.equal(prepared.jobs.course.target.artifactSha256, f.schemas.course.schemaBaseline.artifactSha256);
  assert.equal(prepared.jobs.course.schemaBaselineSha256, createHash("sha256").update(prepared.baselines.course).digest("hex"));
  assert.ok(!JSON.stringify(prepared).includes("fixture-credential-must-not-copy"));
  assert.equal(prepared.release.approval.state, "pending");
});

test("wrong schema service/version, mutable images and a URL in the hostname refuse", () => {
  for (const mutate of [
    (f) => { f.schemas.course.service = "other-api"; },
    (f) => { f.schemas.community.postgresMajor = 16; },
    (f) => { f.candidate.artifacts.courseMigration.image = "mutable:latest"; },
    (f) => { f.settings.services.course.host = "postgresql://fixture:private@wrong.invalid/db"; },
    (f) => { f.candidate.sources.course.commit = "0".repeat(40); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => prepareMigrationBundle(f.candidate, f.settings, f.schemas)); }
});

test("profiled preparation emits only v2 API carriers and uses the source-selected command map", () => {
  const f = profiled(fixture()), prepared = prepareProfiledCurrentMigrationBundle(f.candidate, f.settings, f.schemas);
  assert.equal(prepared.release.version, 3);
  assert.deepEqual(prepared.release.qualificationTargetProfile, current);
  assert.deepEqual(prepared.release.approval.qualificationTargetProfile, current);
  for (const job of Object.values(prepared.jobs)) {
    assert.equal(job.schemaVersion, 2);
    assert.deepEqual(job.qualificationTargetProfile, current);
    assert.equal(job.target.schemaVersion, 2);
    assert.deepEqual(job.target.qualificationTargetProfile, current);
    assert.equal(job.stagingVerification, null);
  }
  assert.equal(migrationOperatorCommand(undefined, "check"), "--check");
  assert.equal(migrationOperatorCommand(undefined, "execute"), "--execute");
  assert.equal(migrationOperatorCommand(current, "check"), "--check-profiled-current");
  assert.equal(migrationOperatorCommand(current, "execute"), "--execute-profiled-current");
  assert.throws(() => migrationOperatorCommand(null, "check"));
  assert.throws(() => migrationOperatorCommand(current, "other"));
});

test("profiled preparation refuses stripped, mixed, source-graph and legacy frontend consumers", () => {
  for (const mutate of [
    (f) => { delete f.candidate.integration.qualificationTargetProfile; },
    (f) => { delete f.settings.qualificationTargetProfile; },
    (f) => { f.settings.services.course.qualificationTargetProfile = { ...current, sha256: "f".repeat(64) }; },
    (f) => { f.candidate.version = 2; },
    (f) => { f.candidate.sourceGraph = { state: "passed" }; },
    (f) => { f.candidate.frontendMigration = { qualificationTargetProfile: current }; },
  ]) {
    const f = profiled(fixture()); mutate(f);
    assert.throws(() => prepareProfiledCurrentMigrationBundle(f.candidate, f.settings, f.schemas));
  }
  const legacy = fixture(); legacy.candidate.qualificationTargetProfile = current;
  assert.throws(() => prepareMigrationBundle(legacy.candidate, legacy.settings, legacy.schemas));
});

test("legacy preparation retains exact v1 unprofiled output", () => {
  const f = fixture(), prepared = prepareMigrationBundle(f.candidate, f.settings, f.schemas);
  assert.equal(prepared.release.version, 2);
  assert.equal(Object.hasOwn(prepared.release, "qualificationTargetProfile"), false);
  assert.deepEqual(Object.keys(prepared.release.approval).sort(), ["approvedAt", "environment", "operator", "releaseId", "state"]);
  for (const job of Object.values(prepared.jobs)) {
    assert.equal(job.schemaVersion, 1);
    assert.equal(Object.hasOwn(job, "qualificationTargetProfile"), false);
    assert.equal(job.target.schemaVersion, 1);
    assert.equal(Object.hasOwn(job.target, "qualificationTargetProfile"), false);
  }
});

test("production preparation requires staging receipts later and binds exact artifact identities", () => {
  const f = fixture(); f.settings.environment = "production";
  assert.throws(() => prepareMigrationBundle(f.candidate, f.settings, f.schemas));
  f.settings.workload = { environment: "production", projectId: "prj_productionFixture" };
  const prepared = prepareMigrationBundle(f.candidate, f.settings, f.schemas);
  assert.equal(prepared.release.environment, "production");
  assert.equal(prepared.jobs.course.stagingVerification.receiptRef, "staging/course");
  assert.equal(prepared.jobs.course.stagingVerification.migrationImageDigest, prepared.jobs.course.migrationImageDigest);
  assert.equal(prepared.release.approval.state, "pending");
  assert.equal(prepared.release.workload.projectId, "prj_productionFixture");
  f.settings.workload.projectId = f.candidate.workload.projectId;
  assert.throws(() => prepareMigrationBundle(f.candidate, f.settings, f.schemas));
});

test("real preparation CLI creates a private bundle accepted by the read-only host plan and never overwrites", () => {
  const root = mkdtempSync(join(tmpdir(), "operator-bundle-test-"));
  try {
    const f = fixture(); const schemas = join(root, "schemas"), output = join(root, "bundle"); mkdirSync(schemas);
    const candidate = join(root, "candidate.json"), settings = join(root, "targets.json");
    writeFileSync(candidate, JSON.stringify(f.candidate)); writeFileSync(settings, JSON.stringify(f.settings));
    for (const name of ["course", "community"]) { mkdirSync(join(schemas, name)); writeFileSync(join(schemas, name, "operator-schema-postgres18.json"), JSON.stringify(f.schemas[name])); }
    const command = ["ops/platform/prepare-migrations.mjs", candidate, settings, schemas, output];
    const run = () => spawnSync(process.execPath, command, { encoding: "utf8", timeout: 10_000 });
    assert.equal(run().status, 0);
    const plan = spawnSync("python3", ["ops/platform/host/migrate.py", output, join(root, "not-created")], { encoding: "utf8", timeout: 10_000 });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).credentialsRead, false);
    assert.equal(run().status, 1);
    const checkout = join(root, "checkout"); mkdirSync(checkout); mkdirSync(join(checkout, ".git"));
    const refused = spawnSync(process.execPath, [...command.slice(0, -1), join(checkout, "private-bundle")], { encoding: "utf8", timeout: 10_000 });
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(readFileSync(join(output, "jobs/course.json"), "utf8")).releaseId, "fixture-release");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fixed profiled preparation CLI binds raw carriers before output and refuses reciprocal input", () => {
  const root = mkdtempSync(join(tmpdir(), "profiled-operator-bundle-test-"));
  try {
    const f = profiled(fixture()), schemas = join(root, "schemas"); mkdirSync(schemas);
    for (const name of ["course", "community"]) {
      mkdirSync(join(schemas, name));
      writeFileSync(join(schemas, name, "operator-schema-postgres18.json"), JSON.stringify(f.schemas[name]));
    }
    const candidate = join(root, "candidate.json"), settings = join(root, "targets.json");
    writeFileSync(candidate, JSON.stringify(f.candidate)); writeFileSync(settings, JSON.stringify(f.settings));
    const run = (out, prefix = ["--prepare-profiled-current"], candidateFile = candidate) => spawnSync(process.execPath,
      ["ops/platform/prepare-migrations.mjs", ...prefix, candidateFile, settings, schemas, out], { encoding: "utf8", timeout: 10_000 });
    const output = join(root, "profiled");
    const prepared = run(output); assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(output, "jobs/course.json"), "utf8")).qualificationTargetProfile, current);
    assert.equal(run(join(root, "legacy-refusal"), []).status, 1);
    const duplicate = join(root, "duplicate.json");
    writeFileSync(duplicate, JSON.stringify(f.candidate).replace('"releaseId":"fixture-release"',
      '"releaseId":"fixture-release","releaseId":"private-must-not-print"'));
    const refused = run(join(root, "duplicate-refusal"), ["--prepare-profiled-current"], duplicate);
    assert.equal(refused.status, 1); assert.ok(refused.stderr.endsWith("Migration bundle preparation refused\n"));
    assert.ok(!`${refused.stdout}${refused.stderr}`.includes("private-must-not-print"));
    const linked = join(root, "candidate-link.json"); symlinkSync(candidate, linked);
    const linkedRefusal = run(join(root, "link-refusal"), ["--prepare-profiled-current"], linked);
    assert.equal(linkedRefusal.status, 1); assert.ok(linkedRefusal.stderr.endsWith("Migration bundle preparation refused\n"));
    assert.ok(!linkedRefusal.stderr.includes(linked));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real bundle CLI includes optional frontend bindings and refuses a substituted CI schema", () => {
  const root = mkdtempSync(join(tmpdir(), "frontend-bundle-test-"));
  try {
    const f = fixture(), artifact = frontendMigrationArtifact();
    f.candidate.artifacts.frontendMigration = { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@sha256:${"b".repeat(64)}`,
      scan: "passed", sbomSha256: `sha256:${"d".repeat(64)}`, provenanceSha256: `sha256:${"e".repeat(64)}` };
    const baseline = { version: 1, serverMajor: 18, sqlArtifactSha256: artifact.sqlArtifactSha256,
      catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums", "sequences", "policies"].map((key) => [key, []])) };
    f.candidate.contractManifestSha256 = artifact.contractManifestSha256;
    f.candidate.frontendMigration = { sourceCommit: f.candidate.sources.frontend.commit, sqlArtifactSha256: artifact.sqlArtifactSha256,
      contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { 18: createHash("sha256").update(JSON.stringify(baseline)).digest("hex") } };
    for (const value of [f.candidate, f.candidate.frontendMigration]) Object.assign(value, { contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 });
    f.settings.frontend = { ...f.settings.services.course, host: "frontend.example.invalid", approvedPendingTags: artifact.migrations.map(({ tag }) => tag), password: "must-not-copy" };
    f.schemas.frontend = { status: "FRONTEND_MIGRATION_OWNED_POSTGRES_PASS", postgresMajor: 18, providerTouched: false, schemaBaseline: baseline, contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
    assert.doesNotThrow(() => prepareMigrationBundle(f.candidate, f.settings, f.schemas));
    assert.doesNotThrow(() => decodeQualificationTargetJson(JSON.stringify(f.candidate), "carrier"));
    assert.doesNotThrow(() => decodeQualificationTargetJson(JSON.stringify(f.settings), "carrier"));
    for (const schema of Object.values(f.schemas)) assert.doesNotThrow(() => decodeQualificationTargetJson(JSON.stringify(schema), "private-packet"));
    const schemas = join(root, "schemas"); mkdirSync(schemas);
    for (const [name, schema] of Object.entries(f.schemas)) { mkdirSync(join(schemas, name)); writeFileSync(join(schemas, name, "operator-schema-postgres18.json"), JSON.stringify(schema)); }
    const candidate = join(root, "candidate.json"), settings = join(root, "targets.json"), output = join(root, "bundle");
    writeFileSync(candidate, JSON.stringify(f.candidate)); writeFileSync(settings, JSON.stringify(f.settings));
    const run = (out) => spawnSync(process.execPath, ["ops/platform/prepare-migrations.mjs", candidate, settings, schemas, out],
      { encoding: "utf8", timeout: 10_000 });
    const prepared = run(output); assert.equal(prepared.status, 0, prepared.stderr);
    const job = readFileSync(join(output, "jobs/frontend.json"), "utf8");
    assert.equal(JSON.parse(job).sourceCommit, f.candidate.sources.frontend.commit); assert.ok(!job.includes("must-not-copy"));
    const check = spawnSync(process.execPath, ["ops/platform/frontend-migration.mjs", "--check", join(output, "release.candidate.json"), join(output, "jobs/frontend.json"), join(output, "schema/frontend.json")], { encoding: "utf8", timeout: 10_000 });
    assert.equal(check.status, 0, check.stderr); assert.equal(JSON.parse(check.stdout).credentialsRead, false);
    f.schemas.frontend.schemaBaseline.catalog.relations.push({ unexpected: true });
    writeFileSync(join(schemas, "frontend/operator-schema-postgres18.json"), JSON.stringify(f.schemas.frontend));
    assert.equal(run(join(root, "refused")).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
