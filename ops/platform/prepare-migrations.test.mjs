import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMigrationBundle } from "./prepare-migrations.mjs";
import { createHash } from "node:crypto";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";

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

test("real bundle CLI includes optional frontend bindings and refuses a substituted CI schema", () => {
  const root = mkdtempSync(join(tmpdir(), "frontend-bundle-test-"));
  try {
    const f = fixture(), artifact = frontendMigrationArtifact();
    const baseline = { version: 1, serverMajor: 18, sqlArtifactSha256: artifact.sqlArtifactSha256,
      catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums", "sequences", "policies"].map((key) => [key, []])) };
    f.candidate.contractManifestSha256 = artifact.contractManifestSha256;
    f.candidate.frontendMigration = { sourceCommit: f.candidate.sources.frontend.commit, sqlArtifactSha256: artifact.sqlArtifactSha256,
      contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { 18: createHash("sha256").update(JSON.stringify(baseline)).digest("hex") } };
    f.settings.frontend = { ...f.settings.services.course, host: "frontend.example.invalid", approvedPendingTags: artifact.migrations.map(({ tag }) => tag), password: "must-not-copy" };
    f.schemas.frontend = { status: "FRONTEND_MIGRATION_OWNED_POSTGRES_PASS", postgresMajor: 18, providerTouched: false, schemaBaseline: baseline };
    const schemas = join(root, "schemas"); mkdirSync(schemas);
    for (const [name, schema] of Object.entries(f.schemas)) { mkdirSync(join(schemas, name)); writeFileSync(join(schemas, name, "operator-schema-postgres18.json"), JSON.stringify(schema)); }
    const candidate = join(root, "candidate.json"), settings = join(root, "targets.json"), output = join(root, "bundle");
    writeFileSync(candidate, JSON.stringify(f.candidate)); writeFileSync(settings, JSON.stringify(f.settings));
    const run = (out) => spawnSync(process.execPath, ["ops/platform/prepare-migrations.mjs", candidate, settings, schemas, out], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run(output).status, 0);
    const job = readFileSync(join(output, "jobs/frontend.json"), "utf8");
    assert.equal(JSON.parse(job).sourceCommit, f.candidate.sources.frontend.commit); assert.ok(!job.includes("must-not-copy"));
    const check = spawnSync(process.execPath, ["ops/platform/frontend-migration.mjs", "--check", join(output, "release.candidate.json"), join(output, "jobs/frontend.json"), join(output, "schema/frontend.json")], { encoding: "utf8", timeout: 10_000 });
    assert.equal(check.status, 0); assert.equal(JSON.parse(check.stdout).credentialsRead, false);
    f.schemas.frontend.schemaBaseline.catalog.relations.push({ unexpected: true });
    writeFileSync(join(schemas, "frontend/operator-schema-postgres18.json"), JSON.stringify(f.schemas.frontend));
    assert.equal(run(join(root, "refused")).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
