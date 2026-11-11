import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendMigrationArtifact, runP2FrontendReplacementRelease } from "./frontend-migration.mjs";
import { frontendCandidateSurfaces } from "./frontend-release-inventory.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { frontendWriterInventory } from "./frontend-writer-inventory.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { prepareP2FrontendReplacementPlan } from "./p2-frontend-replacement-plan.mjs";
import { prepareP2FrontendReplacementReleaseReview } from "./p2-frontend-replacement-release-review.mjs";
import { P2_PROFILED_CURRENT_CONFIGURATION_FILES } from "./p2-profiled-current-release.mjs";
import { resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { phase2ContractManifestBinding } from "./release.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const serialize = value => JSON.stringify(value) + "\n";
const hash = value => digest(JSON.stringify(value));
const write = (path, value) => {
  const raw = typeof value === "string" ? value : serialize(value);
  writeFileSync(path, raw, { mode: 0o600 });
  return digest(raw);
};
const refuse = { message: "P2_FRONTEND_REPLACEMENT_RELEASE_REVIEW_REFUSED" };

const artifact = frontendMigrationArtifact();
const profileDefinition = resolveQualificationTargetProfile(profile);
const source = frontendWriterInventory(root);
const { phase2ContractRevisions } = phase2ContractManifestBinding(root, { requireReleased: true });
const sourceCommit = "a".repeat(40), environment = "staging", releaseId = "owned-replacement-release-review";
const phase2 = { contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
const contractManifestSha256 = artifact.contractManifestSha256, sqlArtifactSha256 = artifact.sqlArtifactSha256;

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2-replacement-plan-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, "bundle");
  for (const name of ["bundle", "bundle/jobs", "bundle/schema", "configuration", "configuration/tls", "configuration/tls/gateway",
    "configuration/tls/course", "configuration/tls/community", "results"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const files = { candidate: join(bundle, "release.candidate.json"), job: join(bundle, "jobs/frontend.json"),
    baseline: join(bundle, "schema/frontend.json"), review: join(directory, "review.json"), lineage: join(directory, "lineage.json") };
  const provider = label => ({ kind: "neon", projectId: "same-owner-project", branchId: "br-" + label, endpointId: "ep-" + label,
    directHost: "ep-" + label + ".us-east-1.aws.neon.tech" });
  const predecessorProvider = provider("prior"), replacementProvider = provider("replacement");
  const target = { host: replacementProvider.directHost, port: 5432, database: "owned_replacement", user: "owned_migration",
    serverMajor: 18, runtimeRole: FRONTEND_PREPARATION_ROLES.runtime };
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
    workload: { qualificationTargetProfile: profile, environment: "production", projectId: profileDefinition.frontend.projectId },
    runtime: { composeSha256: "sha256:" + digest(readFileSync(join(root, "ops/platform/compose.yaml"))),
      privateTlsPolicies: { course: { name: "owned-course-policy" }, community: { name: "owned-community-policy" } } } };
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
    replacement: { provider: replacementProvider, databaseOid: "42", migrationRoleOid: "55",
      administrativeLogins: [{ name: "owned_admin", oid: "51" }], recoveryRef: job.recoveryRef } };
  const options = { bundle, reviewFile: files.review, reviewSha256: write(files.review, review), lineageFile: files.lineage };
  const { plan, probe, administrativeLogins } = prepareP2FrontendReplacementPlan(options);
  const hostRoot = "/var/lib/lash-her/releases/staging/owned-replacement";
  const host = { machineId: "a".repeat(32), bundle: hostRoot + "/bundle", results: hostRoot + "/results" };
  const reviewedPlanFile = join(directory, "reviewed-plan.json");
  const arm = { version: 1, qualificationTargetProfile: profile, environment, ...options, host,
    reviewedPlanFile, reviewedPlanSha256: write(reviewedPlanFile, plan), results: join(directory, "results"),
    knownHosts: join(directory, "known-hosts"), sshKey: join(directory, "ssh-key") };
  const apiJobSha256 = {};
  for (const name of ["course", "community"]) {
    const schemaBaselineSha256 = write(join(bundle, "schema", name + ".json"), { serverMajor: 18, owned: name });
    apiJobSha256[name] = write(join(bundle, "jobs", name + ".json"), {
      schemaVersion: 2, qualificationTargetProfile: profile, kind: "operator-migration", releaseId, operator: "Dardan", environment,
      ...phase2, sourceCommit: sources[name].commit, migrationImageDigest: artifacts[name + "Migration"].image.split("@")[1],
      runtimeImageDigest: artifacts[name + "Runtime"].image.split("@")[1], contractSha256: contractManifestSha256.slice(7),
      target: { schemaVersion: 2, qualificationTargetProfile: profile, service: `lash-her-${name}-api`, environment,
        host: `${name}.example.invalid`, port: 5432, database: name, user: "owned_migration", approvedPendingTags: [] },
      schemaBaselineSha256, runtimeRole: "owned_runtime",
    });
  }
  const configuration = join(directory, "configuration");
  const runtime = { version: 2, qualificationTargetProfile: profile, environment, releaseId, hostMachineId: host.machineId,
    maintenanceRef: "owned/maintenance", previousReleaseRef: "owned/previous" };
  const gateway = { appEnv: "staging", environment: "production", ownerId: profileDefinition.frontend.teamId,
    projectId: profileDefinition.frontend.projectId, publicHost: new URL(profileDefinition.gateway.publicOrigin).hostname,
    courseOrigin: "https://course-tls:8443", communityOrigin: "https://community-tls:8443", maintenance: true,
    tlsKeyFile: "/tls/key.pem", tlsCertFile: "/tls/cert.pem", upstreamCaFile: "/tls/ca.pem",
    admission: { file: "/admission/state.json", releaseId, candidateSha256: plan.candidateSha256 } };
  const values = { "runtime.json": runtime, "gateway.json": gateway, "course-tls.json": candidate.runtime.privateTlsPolicies.course,
    "community-tls.json": candidate.runtime.privateTlsPolicies.community };
  const configurationSha256 = Object.fromEntries(P2_PROFILED_CURRENT_CONFIGURATION_FILES.map(name =>
    [name, write(join(configuration, name), values[name] ?? "private-fixture-contents\n")]));
  const writerReview = { version: 1, qualificationTargetProfile: profile, sourceCommit, targetSha256: plan.targetSha256,
    sourceInventorySha256: hash(source), adaptersSha256: "1".repeat(64), gatewayBindingSha256: "2".repeat(64),
    candidateCoverage: frontendCandidateSurfaces(source).map(({ surfaceSha256 }, index) => ({
      surfaceSha256, disposition: ["admitted", "read-only", "closed"][index % 3], evidenceSha256: "3".repeat(64),
    })) };
  const writerReviewFile = join(directory, "writer-review.json"), runtimeReviewFile = join(directory, "runtime-review.json");
  const runtimeReview = { version: 1, qualificationTargetProfile: profile, environment, releaseId, sourceCommit,
    candidateSha256: plan.candidateSha256, targetSha256: plan.targetSha256, reviewedPlanSha256: arm.reviewedPlanSha256,
    hostMachineId: host.machineId, configuration: hostRoot + "/configuration", configurationSha256, apiJobSha256,
    certification: structuredClone(P2_CERTIFICATION_PROFILE), producerSha256: write(writerReviewFile, writerReview) };
  const settings = { version: 1, qualificationTargetProfile: profile, environment, arm, configuration, runtimeReviewFile,
    runtimeReviewSha256: write(runtimeReviewFile, runtimeReview), writerReviewFile, providerContext: join(directory, "provider-context.json") };
  const rewriteRuntime = () => { settings.runtimeReviewSha256 = write(runtimeReviewFile, runtimeReview); };
  const rewriteWriter = () => { runtimeReview.producerSha256 = write(writerReviewFile, writerReview); rewriteRuntime(); };
  return { settings, plan, probe, administrativeLogins, runtimeReview, writerReview, rewriteRuntime, rewriteWriter, gateway, bundle, directory };
}

test("replacement review preserves original byte custody and the single reviewed producer", t => {
  const f = fixture(t);
  const priorGatewayReference = { kind: "stopped-current-candidate",
    stopReceiptDirectory: "/var/lib/lash-her/releases/staging/prior/results", stopReceiptSha256: "9".repeat(64) };
  f.runtimeReview.priorGatewayReference = priorGatewayReference;
  f.rewriteRuntime();
  const result = prepareP2FrontendReplacementReleaseReview(f.settings);
  assert.deepEqual(result.plan, f.plan);
  assert.deepEqual(result.probe, f.probe);
  assert.equal(result.plan.targetSha256, frontendAdmissionTargetSha256(environment, result.probe.job.target));
  assert.deepEqual(result.administrativeLogins, f.administrativeLogins);
  assert.deepEqual(result.runtimeReview, f.runtimeReview);
  assert.deepEqual(result.writerReview, f.writerReview);
  assert.deepEqual(result.settings, f.settings);
  assert.equal(result.plan.replacementObserved, false);
  assert.equal(result.plan.migrationAuthorized, false);
  assert.equal(result.plan.trafficAuthorized, false);
  assert.equal(result.plan.releaseAccepted, false);
  assert.equal(digest(result.reviewedPlanBytes), f.settings.arm.reviewedPlanSha256);
  assert.equal(digest(result.runtimeReviewBytes), f.settings.runtimeReviewSha256);
  assert.equal(digest(result.writerReviewBytes), f.runtimeReview.producerSha256);
  assert.deepEqual(result.reviewedPlanBytes, readFileSync(f.settings.arm.reviewedPlanFile));
  assert.deepEqual(result.runtimeReviewBytes, readFileSync(f.settings.runtimeReviewFile));
  assert.deepEqual(result.writerReviewBytes, readFileSync(f.settings.writerReviewFile));
  assert(Object.isFrozen(result.runtimeReview.priorGatewayReference));
  assert(Object.isFrozen(result.writerReview.candidateCoverage[0]));
  assert(!JSON.stringify(result).includes("private-fixture-contents"));
  assert.equal(existsSync(f.settings.providerContext), false);
});

test("replacement review refuses changed original bytes and unsafe file custody", t => {
  const f = fixture(t);
  for (const file of [f.settings.runtimeReviewFile, f.settings.writerReviewFile, join(f.bundle, "jobs/course.json"),
    join(f.bundle, "schema/community.json"), join(f.settings.configuration, "course-api.env")]) {
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from("\n")]));
    assert.throws(() => prepareP2FrontendReplacementReleaseReview(f.settings), refuse);
    writeFileSync(file, original);
  }
  const alias = join(f.directory, "review-alias.json");
  for (const makeAlias of [symlinkSync, linkSync]) {
    makeAlias(f.settings.runtimeReviewFile, alias);
    assert.throws(() => prepareP2FrontendReplacementReleaseReview({ ...f.settings, runtimeReviewFile: alias }), refuse);
    rmSync(alias);
  }
  linkSync(f.settings.arm.reviewedPlanFile, alias);
  assert.throws(() => prepareP2FrontendReplacementReleaseReview(f.settings), refuse);
  rmSync(alias);
  chmodSync(f.settings.writerReviewFile, 0o644);
  assert.throws(() => prepareP2FrontendReplacementReleaseReview(f.settings), refuse);
});

test("fixed replacement operator plans with exact confirmation before provider credential access", async t => {
  const f = fixture(t);
  const path = join(f.directory, "replacement-operator-settings.json");
  writeFileSync(path, JSON.stringify(f.settings) + "\n", { mode: 0o600, flag: "wx" });
  const program = fileURLToPath(new URL("./p2-frontend-replacement-release.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [program, "--plan", path], { encoding: "utf8",
    env: { PATH: process.env.PATH }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.confirmation, `staging/${f.plan.releaseId}/replacement-write/${f.settings.arm.reviewedPlanSha256}/${f.settings.runtimeReviewSha256}`);
  assert.equal(plan.migrationCount, f.plan.replacement.approvedPendingTags.length);
  assert.equal(plan.providerCredentialsResolved, false);
  assert.equal(Object.hasOwn(plan, "stagingCronSecretInitialization"), false);
  assert.equal(plan.migrationAuthorized, false);
  assert.equal(existsSync(f.settings.providerContext), false);
  await assert.rejects(runP2FrontendReplacementRelease(f.settings, "staging/unreviewed"),
    /P2_FRONTEND_REPLACEMENT_RELEASE_REVIEW_REQUIRED/u);
  const refused = spawnSync(process.execPath, [program, "--apply", path, "--confirm", "staging/unreviewed"],
    { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000 });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /P2_FRONTEND_REPLACEMENT_RELEASE_REVIEW_REQUIRED/u);
});

test("reviewed staging cron initialization is explicit and concrete in the offline plan", t => {
  const f = fixture(t);
  f.runtimeReview.initializeStagingCronSecret = true;
  f.rewriteRuntime();
  assert.equal(prepareP2FrontendReplacementReleaseReview(f.settings).runtimeReview.initializeStagingCronSecret, true);
  const path = join(f.directory, "replacement-operator-settings-cron.json");
  writeFileSync(path, JSON.stringify(f.settings) + "\n", { mode: 0o600, flag: "wx" });
  const program = fileURLToPath(new URL("./p2-frontend-replacement-release.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [program, "--plan", path], {
    encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).stagingCronSecretInitialization, {
    action: "initialize-staging-cron-secret", provider: "vercel", environment: "staging",
    projectId: profileDefinition.frontend.projectId, workloadTarget: "production", key: "CRON_SECRET",
    type: "sensitive", source: "FRONTEND_STAGING_CRON_SECRET", nativeSchedulesEnabled: false,
    providerApiAcknowledgementRequired: true, deployedBearerVerification: "day-two-workload-certification",
  });
  for (const value of [false, "true", null]) {
    f.runtimeReview.initializeStagingCronSecret = value;
    f.rewriteRuntime();
    assert.throws(() => prepareP2FrontendReplacementReleaseReview(f.settings), refuse);
  }
});

test("raw approval cannot substitute a different host, profile, gateway, API job or coverage", async t => {
  const cases = [
    ["different host", f => { f.runtimeReview.hostMachineId = "b".repeat(32); f.rewriteRuntime(); }],
    ["wrong target profile", f => { f.runtimeReview.qualificationTargetProfile = { ...profile, id: "other" }; f.rewriteRuntime(); }],
    ["different approved plan", f => { f.runtimeReview.reviewedPlanSha256 = "f".repeat(64); f.rewriteRuntime(); }],
    ["configuration inside host bundle", f => { f.runtimeReview.configuration = f.settings.arm.host.bundle + "/configuration"; f.rewriteRuntime(); }],
    ["unverified prior", f => { f.runtimeReview.priorGatewayReference = { kind: "stopped-current-candidate", stopReceiptDirectory: "/tmp/not-staging", stopReceiptSha256: "9".repeat(64) }; f.rewriteRuntime(); }],
    ["enabled schedules", f => { f.runtimeReview.certification.nativeSchedulesEnabled = true; f.rewriteRuntime(); }],
    ["unfenced gateway", f => {
      f.gateway.maintenance = false;
      f.runtimeReview.configurationSha256["gateway.json"] = write(join(f.settings.configuration, "gateway.json"), f.gateway);
      f.rewriteRuntime();
    }],
    ["wrong API source", f => {
      const file = join(f.bundle, "jobs/course.json"), job = JSON.parse(readFileSync(file));
      f.runtimeReview.apiJobSha256.course = write(file, { ...job, sourceCommit: "b".repeat(40) });
      f.rewriteRuntime();
    }],
    ["wrong source inventory", f => { f.writerReview.sourceInventorySha256 = "b".repeat(64); f.rewriteWriter(); }],
    ["missing surface", f => { f.writerReview.candidateCoverage.pop(); f.rewriteWriter(); }],
    ["duplicate surface", f => { f.writerReview.candidateCoverage[0] = f.writerReview.candidateCoverage[1]; f.rewriteWriter(); }],
    ["foreign producer", f => { f.writerReview.candidateCoverage[0].producerSha256 = "4".repeat(64); f.rewriteWriter(); }],
    ["unexpected closure claim", f => { f.writerReview.historicalProviderClosureClaimed = true; f.rewriteWriter(); }],
    ["unknown runtime selector", f => { f.runtimeReview.initializeCronSecret = true; f.rewriteRuntime(); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, t => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => prepareP2FrontendReplacementReleaseReview(f.settings), refuse);
  });
});
