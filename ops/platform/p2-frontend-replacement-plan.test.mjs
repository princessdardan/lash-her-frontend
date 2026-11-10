import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { prepareP2FrontendReplacementPlan } from "./p2-frontend-replacement-plan.mjs";
import { resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { phase2ContractManifestBinding } from "./release.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const command = fileURLToPath(new URL("./p2-frontend-replacement-plan.mjs", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const serialize = value => JSON.stringify(value) + "\n";
const hash = value => digest(JSON.stringify(value));
const write = (path, value) => {
  const raw = typeof value === "string" ? value : serialize(value);
  writeFileSync(path, raw, { mode: 0o600 });
  return digest(raw);
};
const artifact = frontendMigrationArtifact();
const { phase2ContractRevisions } = phase2ContractManifestBinding(root, { requireReleased: true });
const sourceCommit = "a".repeat(40), environment = "staging", releaseId = "owned-replacement-plan";
const phase2 = { contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
const contractManifestSha256 = artifact.contractManifestSha256, sqlArtifactSha256 = artifact.sqlArtifactSha256;

function fixture(t, managed) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2-replacement-plan-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, "bundle");
  for (const name of ["bundle", "bundle/jobs", "bundle/schema"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const files = { candidate: join(bundle, "release.candidate.json"), job: join(bundle, "jobs/frontend.json"),
    baseline: join(bundle, "schema/frontend.json"), review: join(directory, "review.json"), lineage: join(directory, "lineage.json") };
  const provider = label => ({ kind: "neon", projectId: "same-owner-project", branchId: "br-" + label, endpointId: "ep-" + label,
    directHost: "ep-" + label + ".us-east-1.aws.neon.tech" });
  const predecessorProvider = provider("prior"), replacementProvider = managed?.provider ?? provider("replacement");
  const target = { host: replacementProvider.directHost, port: 5432, database: "owned_replacement", user: "owned_migration",
    serverMajor: 18, ...managed?.target, runtimeRole: FRONTEND_PREPARATION_ROLES.runtime };
  const predecessorTarget = { ...target, host: predecessorProvider.directHost, database: "owned_prior", runtimeRole: "prior_runtime" };
  const baseline = { version: 1, serverMajor: target.serverMajor, sqlArtifactSha256,
    catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums",
      "sequences", "policies"].map(name => [name, []])) };
  const job = { version: 2, qualificationTargetProfile: profile, environment, releaseId, sourceCommit, operator: "Dardan", ...phase2,
    migrationImageDigest: "sha256:" + "1".repeat(64), contractManifestSha256, sqlArtifactSha256,
    schemaBaselineSha256: hash(baseline), recoveryRef: "owned/replacement-recovery",
    target: { ...target, qualificationTargetProfile: profile, allowEmptyBootstrap: true,
      approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  const sources = Object.fromEntries(Object.entries({ frontend: sourceCommit, course: phase2ContractRevisions.course,
    community: phase2ContractRevisions.community }).map(([name, commit]) => [name, { qualificationTargetProfile: profile,
    repository: `https://github.com/princessdardan/lash-her-${name}${name === "frontend" ? "" : "-api"}.git`, commit, requiredChecks: "passed" }]));
  const artifacts = Object.fromEntries([["frontendMigration", "frontend-migration"], ["courseMigration", "course-migration"],
    ["communityMigration", "community-migration"], ["courseRuntime", "course-runtime"], ["communityRuntime", "community-runtime"], ["gateway", "gateway"]]
    .map(([key, name], index) => [key, { image: `ghcr.io/princessdardan/lash-her-platform-${name}@sha256:${String(index + 1).repeat(64)}`,
      sbomSha256: "sha256:" + "d".repeat(64), provenanceSha256: "sha256:" + "e".repeat(64), scan: "passed" }]));
  const candidate = { version: 3, qualificationTargetProfile: profile, environment, releaseId, sources, artifacts, ...phase2,
    contractManifestSha256, frontendMigration: { qualificationTargetProfile: profile, sourceCommit, ...phase2, sqlArtifactSha256,
      contractManifestSha256, schemaBaselines: { [target.serverMajor]: job.schemaBaselineSha256 } },
    sourceApproval: { qualificationTargetProfile: profile, mode: "single-operator-dispatch", operatorGithubUserId: "8996309",
      runId: "1", runAttempt: 1, verifiedAt: "2020-01-01T00:00:00Z" },
    integration: { qualificationTargetProfile: profile, state: "passed" },
    approval: { qualificationTargetProfile: profile, environment, releaseId, state: "approved", operator: "Dardan", approvedAt: "2020-01-01T00:00:00Z" },
    migrations: { frontend: { state: "verified" }, course: { state: "verified" }, community: { state: "verified" } },
    recovery: { state: "verified" }, scheduler: { state: "verified", cancellation: "verified" },
    workload: { qualificationTargetProfile: profile, environment: "production", projectId: resolveQualificationTargetProfile(profile).frontend.projectId } };
  const observedTarget = { ...predecessorTarget };
  delete observedTarget.runtimeRole;
  const entries = artifact.manifest.entries;
  const appliedPrefix = entries.slice(0, -3).map(({ tag, folderMillis, hash }) => ({ tag, folderMillis, hash }));
  const lineage = { version: 1, qualificationTargetProfile: profile, sourceCommit: "d".repeat(40), target: observedTarget,
    status: "FRONTEND_LINEAGE_PENDING", journalPresent: true, appliedCount: appliedPrefix.length,
    lastApplied: appliedPrefix.at(-1), appliedPrefix, appliedPrefixSha256: hash(appliedPrefix),
    pendingTags: entries.slice(appliedPrefix.length).map(({ tag }) => tag), service: "frontend", environment,
    observedAt: "2020-01-01T00:00:00.000Z", sqlArtifactSha256, contractManifestSha256, contractPhase: "p2",
    phase2ContractManifestSha256: "sha256:" + "7".repeat(64),
    expectedMigrationCount: entries.length, databaseOid: "42", loginRoleOid: "43", verifiedTls: true,
    readOnlyVerified: true, migrationLockVerified: true, samePhysicalSessionVerified: true,
    applicationSqlApplied: false, bootstrapAuthorized: false, migrationAuthorized: false, trafficAuthorized: false };
  const review = { version: 1, qualificationTargetProfile: profile, environment, releaseId, sourceCommit,
    candidateSha256: write(files.candidate, candidate), frontendJobSha256: write(files.job, job),
    schemaBaselineFileSha256: write(files.baseline, baseline),
    predecessor: { provider: predecessorProvider, target: predecessorTarget, lineageSha256: write(files.lineage, lineage),
      deploymentId: "dpl_ownedPrior", recoveryRef: "owned/predecessor-recovery" },
    replacement: { provider: replacementProvider, databaseOid: managed?.databaseOid ?? "42", migrationRoleOid: managed?.migrationRoleOid ?? "55",
      administrativeLogins: managed?.administrativeLogins ?? [{ name: "owned_admin", oid: "51" }], recoveryRef: job.recoveryRef,
      ...(managed ? { managedCatalog: managed.reference } : {}) } };
  const options = { bundle, reviewFile: files.review, reviewSha256: write(files.review, review), lineageFile: files.lineage };
  return { directory, files, options, review, candidate, job, baseline, lineage };
}

function cli(options, mode = "--plan") {
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", command,
    mode, options.bundle, options.reviewFile, options.reviewSha256, options.lineageFile],
  { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH } });
}

test("offline plan binds exact replacement, retained lineage and complete SQL order", t => {
  const f = fixture(t);
  const { plan, probe, administrativeLogins } = prepareP2FrontendReplacementPlan(f.options);
  assert.equal(plan.status, "P2_FRONTEND_REPLACEMENT_PLAN_PREPARED");
  assert.equal(plan.reviewSha256, f.options.reviewSha256);
  assert.equal(plan.targetSha256, frontendAdmissionTargetSha256(environment, f.job.target));
  assert.deepEqual(plan.predecessor.pendingTags, f.lineage.pendingTags);
  assert.equal(plan.predecessor.lineageSha256, f.review.predecessor.lineageSha256);
  assert.equal(plan.predecessor.phase2ContractManifestSha256, f.lineage.phase2ContractManifestSha256);
  assert.notEqual(plan.predecessor.phase2ContractManifestSha256, plan.phase2ContractManifestSha256);
  assert.deepEqual(plan.replacement.approvedPendingTags, f.job.target.approvedPendingTags);
  assert.equal(plan.replacement.provider.projectId, plan.predecessor.provider.projectId);
  assert.notEqual(plan.replacement.provider.branchId, plan.predecessor.provider.branchId);
  assert.equal(plan.replacement.databaseOid, plan.predecessor.databaseOid);
  for (const key of ["replacementObserved", "bootstrapAuthorized", "migrationAuthorized", "deploymentAuthorized", "trafficAuthorized", "releaseAccepted"])
    assert.equal(plan[key], false);
  assert.deepEqual(probe, { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    candidate: f.candidate, job: f.job, baseline: f.baseline, predecessorTarget: f.review.predecessor.target,
    targetSha256: plan.targetSha256, databaseOid: "42", migrationRoleOid: "55" });
  assert.deepEqual(administrativeLogins, f.review.replacement.administrativeLogins);
  assert.equal(Object.hasOwn(plan.replacement, "managedCatalog"), false);
  assert(Object.isFrozen(plan.replacement.target) && Object.isFrozen(probe.job.target));
  const result = cli(f.options);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), plan);
});

test("managed Neon review binds only the pinned catalog reference without changing the physical probe", async t => {
  const bytes = readFileSync(new URL("./managed-neon-replacement-catalog.json", import.meta.url));
  const selected = JSON.parse(bytes);
  const reference = { id: selected.id, sha256: digest(bytes) };
  const f = fixture(t, { ...selected, reference });
  const { plan, probe } = prepareP2FrontendReplacementPlan(f.options);
  assert.deepEqual(plan.replacement.managedCatalog, reference);
  assert.equal(Object.isFrozen(plan.replacement.managedCatalog), true);
  assert.deepEqual(probe, { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    candidate: f.candidate, job: f.job, baseline: f.baseline, predecessorTarget: f.review.predecessor.target,
    targetSha256: plan.targetSha256, databaseOid: selected.databaseOid, migrationRoleOid: selected.migrationRoleOid });
  for (const [name, change] of [
    ["unknown catalog", row => { row.managedCatalog.id += "-other"; }],
    ["wrong baseline bytes", row => { row.managedCatalog.sha256 = "b".repeat(64); }],
    ["inline catalog", row => { row.managedCatalog.expectedCatalogCounts = {}; }],
    ["provider drift", row => { row.provider.projectId = "other-project"; }],
    ["database OID drift", row => { row.databaseOid = "43"; }],
    ["migration role OID drift", row => { row.migrationRoleOid = "44"; }],
    ["unreviewed administrator", row => { row.administrativeLogins.push({ name: "extra_owner", oid: "45" }); }],
  ]) await t.test(name, () => {
    const replacement = structuredClone(f.review.replacement);
    change(replacement);
    const reviewSha256 = write(f.files.review, { ...f.review, replacement });
    assert.throws(() => prepareP2FrontendReplacementPlan({ ...f.options, reviewSha256 }));
  });
});

test("reviewed raw bytes and private paths are mandatory", t => {
  const f = fixture(t);
  assert.throws(() => prepareP2FrontendReplacementPlan({ ...f.options, reviewSha256: "6".repeat(64) }));
  const alias = join(f.directory, "alias.json");
  for (const makeAlias of [symlinkSync, linkSync]) {
    makeAlias(f.files.review, alias);
    assert.throws(() => prepareP2FrontendReplacementPlan({ ...f.options, reviewFile: alias }));
    rmSync(alias);
  }
  chmodSync(f.files.lineage, 0o644);
  assert.throws(() => prepareP2FrontendReplacementPlan(f.options));
  chmodSync(f.files.lineage, 0o600);
  for (const [name, value] of [["lineage", f.lineage], ["candidate", f.candidate], ["baseline", f.baseline], ["job", f.job]]) {
    write(f.files[name], serialize(value) + "\n");
    assert.throws(() => prepareP2FrontendReplacementPlan(f.options));
    write(f.files[name], value);
  }
  const duplicate = serialize(f.review).replace('"version":1', '"version":1,"version":1');
  const reviewSha256 = write(f.files.review, duplicate);
  assert.throws(() => prepareP2FrontendReplacementPlan({ ...f.options, reviewSha256 }));
  const result = cli(f.options, "--apply");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "P2_FRONTEND_REPLACEMENT_PLAN_REFUSED");
});

test("a byte-approved document still cannot bypass semantic bindings", async t => {
  const cases = [
    ["wrong profile", f => { f.review.qualificationTargetProfile = { ...profile, id: "production" }; }],
    ["same provider branch", f => { f.review.replacement.provider.branchId = f.review.predecessor.provider.branchId; }],
    ["endpoint mismatch", f => { f.review.replacement.provider.endpointId = "ep-other"; }],
    ["missing recovery", f => { delete f.review.predecessor.recoveryRef; }],
    ["job recovery mismatch", f => { f.review.replacement.recoveryRef = "owned/wrong"; }],
    ["duplicate login OID", f => { f.review.replacement.administrativeLogins.push({ name: "other_admin", oid: "51" }); }],
    ["migration role OID included as an admin", f => { f.review.replacement.administrativeLogins[0].oid = "55"; }],
    ["fixed role admitted as an admin", f => { f.review.replacement.administrativeLogins[0].name = FRONTEND_PREPARATION_ROLES.owner; }],
    ["out-of-range database OID", f => { f.review.replacement.databaseOid = "4294967296"; }],
    ["wrong observed target", f => { f.lineage.target.port += 1; }],
    ["changed observed SQL hash", f => { f.lineage.appliedPrefix[0].hash = "8".repeat(64); f.lineage.appliedPrefixSha256 = hash(f.lineage.appliedPrefix); }],
    ["missing read-only verification", f => { f.lineage.readOnlyVerified = false; }],
    ["unexpected lineage authority", f => { f.lineage.migrationAuthorized = true; }],
    ["incomplete migration chain", f => { f.job.target.approvedPendingTags.shift(); }],
    ["unordered migration chain", f => { f.job.target.approvedPendingTags.reverse(); }],
    ["bootstrap not selected", f => { f.job.target.allowEmptyBootstrap = false; }],
    ["bad release image provenance", f => { delete f.candidate.artifacts.courseRuntime.provenanceSha256; }],
    ["unreleased API source pin", f => { f.candidate.sources.course.commit = "7".repeat(40); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, t => {
    const f = fixture(t);
    mutate(f);
    f.review.candidateSha256 = write(f.files.candidate, f.candidate);
    f.review.frontendJobSha256 = write(f.files.job, f.job);
    f.review.predecessor.lineageSha256 = write(f.files.lineage, f.lineage);
    f.options.reviewSha256 = write(f.files.review, f.review);
    assert.throws(() => prepareP2FrontendReplacementPlan(f.options));
  });
});
