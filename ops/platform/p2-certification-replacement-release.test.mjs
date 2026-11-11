import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { frontendCandidateSurfaces } from "./frontend-release-inventory.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { frontendWriterInventory } from "./frontend-writer-inventory.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { prepareP2CertificationReplacementRelease, validP2CertificationReplacementDescriptor } from "./p2-certification-replacement-release.mjs";
import { P2_CERTIFICATION_READY_FILES, p2ProfiledCertificationOperator, prepareP2BoundedCertification,
  prepareP2ProfiledCertificationOperator } from "./p2-certification.mjs";
import { prepareP2CertificationRotationSuccessor, rotationSuccessorKind } from "./p2-certification-rotation-successor.mjs";
import { prepareP2FrontendReplacementPlan } from "./p2-frontend-replacement-plan.mjs";
import { bindP2ManagedIdentityRotationPlan } from "./p2-identity-key-rotation-operator.mjs";
import { prepareP2IdentityRotationReplacementLease } from "./p2-identity-key-rotation-replacement.mjs";
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
const refuse = { message: "P2_CERTIFICATION_REPLACEMENT_RELEASE_REFUSED" };

const artifact = frontendMigrationArtifact();
const profileDefinition = resolveQualificationTargetProfile(profile);
const source = frontendWriterInventory(root);
const { phase2ContractRevisions } = phase2ContractManifestBinding(root, { requireReleased: true });
const environment = "staging", releaseId = "owned-certification-replacement";
const phase2 = { contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
const contractManifestSha256 = artifact.contractManifestSha256, sqlArtifactSha256 = artifact.sqlArtifactSha256;

function reviewedFixture(t, sourceCommit, fixtureOptions = {}) {
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
      administrativeLogins: [{ name: "owned_admin_z", oid: "51" }, { name: "owned_admin_a", oid: "52" }], recoveryRef: job.recoveryRef } };
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
        host: `${name}.example.invalid`, port: 5432, database: name, user: "owned_migration", serverMajor: 18, approvedPendingTags: [] },
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
    certification: structuredClone(P2_CERTIFICATION_PROFILE), producerSha256: write(writerReviewFile, writerReview),
    ...(fixtureOptions.initializeStagingCronSecret === true ? { initializeStagingCronSecret: true } : {}) };
  const settings = { version: 1, qualificationTargetProfile: profile, environment, arm, configuration, runtimeReviewFile,
    runtimeReviewSha256: write(runtimeReviewFile, runtimeReview), writerReviewFile, providerContext: join(directory, "provider-context.json") };
  return { settings, plan, probe, administrativeLogins, runtimeReview, writerReview, bundle, directory };
}

function fixture(t, sourceCommit = "a".repeat(40), options = {}) {
  const review = reviewedFixture(t, sourceCommit, options);
  const { plan, probe, administrativeLogins, settings, runtimeReview } = review;
  const action = join(settings.arm.results, plan.releaseId + "-replacement-write");
  const frontend = join(action, "frontend"), vercel = join(frontend, "vercel");
  for (const dir of [action, frontend, vercel]) mkdirSync(dir, { mode: 0o700 });
  const { job } = probe;
  const application = { version: 2, qualificationTargetProfile: profile, service: "frontend",
    ...Object.fromEntries(["environment", "releaseId", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
      "schemaBaselineSha256", "contractManifestSha256", "operator", "recoveryRef"].map(key => [key, job[key]])), ...phase2,
    migrationMode: "apply-forward", target: Object.fromEntries(["host", "port", "database", "user", "serverMajor"].map(key => [key, job.target[key]])),
    trafficAuthorized: false };
  const database = { ...application, status: "DATABASE_VERIFIED", before: [],
    after: artifact.migrations.map(({ hash, folderMillis }) => ({ hash, created_at: String(folderMillis) })),
    applied: artifact.migrations.map(({ tag, hash }) => ({ tag, hash })), schemaVerified: true, runtimeRoleVerified: true, readOnlyVerified: false };
  const frontendDatabaseReceiptSha256 = write(join(frontend, "database-receipt.json"), database);
  const frontendContinuationStartedSha256 = write(join(frontend, "frontend-continuation-started.json"),
    { ...application, status: "FRONTEND_CONTINUATION_STARTED", databaseVerified: true });
  const frontendContinuationCompletedSha256 = write(join(frontend, "frontend-continuation-completed.json"),
    { ...application, status: "FRONTEND_CONTINUATION_COMPLETED", databaseVerified: true });
  const frontendTerminalSha256 = write(join(frontend, "job-outcome.json"),
    { ...application, status: "DATABASE_VERIFIED", phase: "completed", readOnlyVerified: false });

  const shared = { environment, releaseId, sourceCommit, candidateSha256: plan.candidateSha256, targetSha256: plan.targetSha256 };
  const physical = { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    status: "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", environment, releaseId, sourceCommit, targetSha256: plan.targetSha256,
    databaseOid: probe.databaseOid, migrationRoleOid: probe.migrationRoleOid, marker: "6".repeat(64),
    backendPid: 102, backendStart: "2026-11-09T14:00:00.000000Z", readOnlyVerified: true, authorityIssued: false, trafficAuthorized: false };
  const physicalRaw = JSON.stringify(physical, null, 2) + "\n", physicalObservationSha256 = digest(physicalRaw);
  const armReceiptSha256 = "8".repeat(64);
  write(join(frontend, `${physicalObservationSha256}-${armReceiptSha256}.json`), physicalRaw);
  write(join(frontend, "replacement-write-custody.json"), { version: 1, qualificationTargetProfile: profile, ...shared,
    status: "P2_FRONTEND_REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED", reviewedPlanSha256: settings.arm.reviewedPlanSha256,
    bootstrapAuthorized: false, migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false,
    armReceiptSha256, emptyCatalogReceiptSha256: "9".repeat(64), physicalObservationSha256, automaticReplayAuthorized: false });
  const owner = { name: FRONTEND_PREPARATION_ROLES.owner, oid: "61" }, runtime = { name: FRONTEND_PREPARATION_ROLES.runtime, oid: "62" };
  const postflight = { ...physical, status: "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED", operation: "verify-replacement-written",
    physicalObservationSha256, databaseReceiptSha256: frontendDatabaseReceiptSha256, continuationStartedSha256: frontendContinuationStartedSha256,
    owner, runtime, producerSha256: runtimeReview.producerSha256, administrativeLogins: [...administrativeLogins].sort((a, b) => a.name.localeCompare(b.name)),
    appliedMigrationCount: artifact.migrations.length, epoch: "1", newWork: false, recovery: false, active: 0, uncertain: 0,
    schemaVerified: true, runtimeRoleVerified: true, effectiveLoginBoundaryVerified: true };
  const postflightSha256 = digest(serialize(postflight));
  write(join(frontend, `${postflightSha256}-${frontendDatabaseReceiptSha256}.json`), postflight);
  const closed = { ...postflight, status: "P2_FRONTEND_REPLACEMENT_SESSION_CLOSED", operation: "verify-replacement-closed",
    writtenObservationSha256: postflightSha256, originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true };
  const writePinned = (value, right) => {
    const pin = digest(serialize(value));
    write(join(frontend, `${pin}-${right}.json`), value);
    return pin;
  };
  const frontendSessionClosedSha256 = writePinned(closed, postflightSha256);
  const flags = { frontendSqlApplied: true, frontendSqlReplayed: false, historicalProviderClosureClaimed: false,
    oldP200Qualified: false, nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false };
  const api = { version: 2, qualificationTargetProfile: profile, environment, releaseId, candidateSha256: plan.candidateSha256,
    ...phase2, ...flags, phase: "completed", frontendMigrationMode: "apply-forward", frontendReadOnlyVerified: false,
    frontendReplacementReadbackSha256: postflightSha256, frontendContinuationStartedSha256 };
  const migrationOutcomeSha256 = writePinned({ ...api, status: "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN",
    databaseReceiptSha256: { frontend: frontendDatabaseReceiptSha256, course: "a".repeat(64), community: "b".repeat(64) } }, postflightSha256);
  const apiRuntime = { ...api, status: "API_RUNTIME_READY", sourceCommit, configurationSha256: runtimeReview.configurationSha256,
    migrationOutcomeSha256, frontendPromotionAuthorized: false };
  const runtimeOutcomeSha256 = writePinned(apiRuntime, postflightSha256);

  const deploymentId = "dpl_ownedCandidate", previousDeploymentId = plan.predecessor.deploymentId;
  const provider = { version: 2, qualificationTargetProfile: profile, environment, releaseId, sourceCommit, deploymentId,
    projectId: probe.candidate.workload.projectId, previousDeploymentId, trafficAuthorized: false, phase: "completed" };
  const writerAdmissionBinding = { mode: "enforce", targetSha256: plan.targetSha256, producerSha256: runtimeReview.producerSha256,
    sourceCommit, roleName: runtime.name };
  const workload = { ...provider, ...phase2, status: "FRONTEND_VERIFIED", featureControls: runtimeReview.certification.featureControls,
    writerAdmissionBinding, nativeSchedulerVerified: false, checks: ["frontend-server-gateway-course-catalog-p2"] };
  const frontendWorkloadReceiptSha256 = write(join(vercel, "frontend-workload-outcome.json"), workload);
  const promotion = { ...provider, status: "FRONTEND_DOMAINS_PROMOTED", previousAliasRequestedAt: 0, aliasRequestedAt: 1,
    frontendDomainsPromoted: true, gatewayTrafficAuthorized: false };
  const frontendPromotionReceiptSha256 = write(join(vercel, "frontend-promotion-outcome.json"), promotion);
  const frontendDeploymentProofSha256 = "b".repeat(64);
  const base = { version: 2, qualificationTargetProfile: profile, ...shared, ...phase2, ...flags,
    configurationSha256: runtimeReview.configurationSha256, postflightSha256, reviewedPlanSha256: settings.arm.reviewedPlanSha256,
    runtimeReviewSha256: settings.runtimeReviewSha256, runtimeOutcomeSha256, migrationOutcomeSha256 };
  const release = { ...base, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED", deploymentProofSha256: frontendDeploymentProofSha256 };
  const frontendReleaseOutcomeSha256 = write(join(frontend, "frontend-release-outcome.json"), release);
  const terminal = { ...base, status: "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION", frontendSessionClosed: true, migrationMode: "apply-forward",
    deploymentId, owner, runtime, producerSha256: runtimeReview.producerSha256, frontendDatabaseReceiptSha256, frontendContinuationStartedSha256,
    frontendDeploymentProofSha256, frontendWorkloadReceiptSha256, frontendPromotionReceiptSha256, frontendTerminalSha256,
    frontendContinuationCompletedSha256, frontendReleaseOutcomeSha256, frontendSessionClosedSha256 };
  const select = value => {
    const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
    const terminalSha256 = digest(raw);
    const terminalFile = join(frontend, `${terminalSha256}-${"c".repeat(64)}.json`);
    write(terminalFile, raw);
    return { terminalFile, terminalSha256 };
  };
  return { ...review, action, frontend, vercel, terminal, selection: select(terminal), select, release, closed, apiRuntime, promotion,
    writePinned, writerAdmissionBinding };
}

test("replacement certification joins original apply-forward evidence and derives the closed inventory", t => {
  const f = fixture(t);
  const loaded = prepareP2CertificationReplacementRelease(f.settings, f.selection);
  assert.deepEqual(loaded.originalReleaseReceipt, readFileSync(f.selection.terminalFile));
  assert.deepEqual(loaded.candidateBytes, readFileSync(join(f.bundle, "release.candidate.json")));
  assert.equal(loaded.directory, f.action);
  assert.equal(loaded.frontendReceipts, f.vercel);
  assert.equal(loaded.host.configuration, join(f.settings.arm.host.results, `runtime-profiled-frontend-replacement-${releaseId}`, "configuration"));
  assert.equal(loaded.profiledRelease.configurationDirectory, loaded.host.configuration);
  assert.equal(loaded.profiledRelease.receiptSha256, f.selection.terminalSha256);
  assert.equal(loaded.profiledRelease.planSha256, f.settings.arm.reviewedPlanSha256);
  assert.deepEqual(loaded.original.migration.job, f.probe.job);
  assert.equal(loaded.original.migration.job.target.approvedPendingTags.length, artifact.migrations.length);
  assert.deepEqual(loaded.original.plan.writerAdmissionBinding, f.writerAdmissionBinding);
  assert.equal(loaded.original.plan.inventorySha256, hash(loaded.original.inventory));
  assert.deepEqual(loaded.original.plan.apiJobSha256, f.runtimeReview.apiJobSha256);
  assert.deepEqual(loaded.original.inventory.producers, [{ producerSha256: f.terminal.producerSha256, role: f.terminal.runtime }]);
  assert.deepEqual(loaded.original.inventory.restoration, { version: 2, qualificationTargetProfile: profile,
    newWork: false, recovery: false, nativeSchedulesEnabled: false, providerIngress: "replacement-closed",
    gatewayBindingSha256: f.writerReview.gatewayBindingSha256 });
  const descriptor = loaded.profiledRelease.replacementRelease;
  assert.deepEqual(descriptor, loaded.original.inventory.replacementRelease);
  assert.equal(validP2CertificationReplacementDescriptor(descriptor), true);
  assert.equal(descriptor.databaseOid, f.probe.databaseOid);
  assert.deepEqual(descriptor.administrativeLogins.map(login => login.name), ["owned_admin_a", "owned_admin_z"]);
  for (const invalid of [null, { ...descriptor, extra: true }, { ...descriptor, databaseOid: "4294967296" },
    { ...descriptor, postflightSha256: "0".repeat(64) }, { ...descriptor, administrativeLogins: descriptor.administrativeLogins.toReversed() },
    { ...descriptor, administrativeLogins: [descriptor.administrativeLogins[0], { name: "owned_admin_z", oid: descriptor.administrativeLogins[0].oid }] }]) {
    assert.equal(validP2CertificationReplacementDescriptor(invalid), false);
  }
});

test("cron initialization remains bound through original receipts without replay authority", t => {
  const f = fixture(t, "a".repeat(40), { initializeStagingCronSecret: true });
  const loaded = prepareP2CertificationReplacementRelease(f.settings, f.selection);
  const runtimeReviewSha256 = digest(readFileSync(f.settings.runtimeReviewFile));
  assert.equal(f.runtimeReview.initializeStagingCronSecret, true);
  assert.equal(f.terminal.runtimeReviewSha256, runtimeReviewSha256);
  assert.equal(loaded.profiledRelease.replacementRelease.runtimeReviewSha256, runtimeReviewSha256);
  assert.equal(loaded.original.inventory.replacementRelease.runtimeReviewSha256, runtimeReviewSha256);
  assert.equal(loaded.original.plan.inventorySha256, hash(loaded.original.inventory));
  assert.equal(Object.hasOwn(loaded.original.inventory, "initializeStagingCronSecret"), false);
  assert.equal(Object.hasOwn(loaded.profiledRelease.replacementRelease, "initializeStagingCronSecret"), false);

  const plain = fixture(t);
  const ordinary = prepareP2CertificationReplacementRelease(plain.settings, plain.selection);
  assert.notEqual(ordinary.original.inventory.replacementRelease.runtimeReviewSha256, runtimeReviewSha256);
  assert.notEqual(ordinary.original.plan.inventorySha256, loaded.original.plan.inventorySha256);

  const withoutInitialization = { ...f.runtimeReview };
  delete withoutInitialization.initializeStagingCronSecret;
  f.settings.runtimeReviewSha256 = write(f.settings.runtimeReviewFile, withoutInitialization);
  assert.throws(() => prepareP2CertificationReplacementRelease(f.settings, f.selection), refuse);
  assert.throws(() => prepareP2CertificationReplacementRelease(f.settings,
    f.select({ ...f.terminal, runtimeReviewSha256: f.settings.runtimeReviewSha256 })), refuse);
});

test("replacement certification refuses substituted originals and retagged semantic failures", t => {
  const f = fixture(t);
  const load = selection => prepareP2CertificationReplacementRelease(f.settings, selection);
  for (const changed of [
    { ...f.terminal, trafficAuthorized: true },
    { ...f.terminal, extra: true },
    { ...f.terminal, migrationMode: "verify-current-only" },
    { ...f.terminal, owner: { ...f.terminal.owner, oid: f.probe.migrationRoleOid } },
    { ...f.terminal, configurationSha256: {} },
    { ...f.terminal, frontendSessionClosedSha256: f.writePinned({ ...f.closed, originalLocksAbsent: false }, f.terminal.postflightSha256) },
  ]) assert.throws(() => load(f.select(changed)), refuse);
  assert.throws(() => load(f.select(JSON.stringify(f.terminal).replace('"version":2', '"version":2,"version":2') + "\n")), refuse);
  for (const file of ["database-receipt.json", "frontend-continuation-started.json", "job-outcome.json", "frontend-continuation-completed.json",
    "frontend-release-outcome.json", `${f.terminal.postflightSha256}-${f.terminal.frontendDatabaseReceiptSha256}.json`,
    `${f.terminal.frontendSessionClosedSha256}-${f.terminal.postflightSha256}.json`,
    `${f.terminal.migrationOutcomeSha256}-${f.terminal.postflightSha256}.json`, `${f.terminal.runtimeOutcomeSha256}-${f.terminal.postflightSha256}.json`,
    "vercel/frontend-workload-outcome.json", "vercel/frontend-promotion-outcome.json"]) {
    const path = join(f.frontend, file), original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
    assert.throws(() => load(f.selection), refuse, file);
    writeFileSync(path, original);
  }
  const runtimeOutcomeSha256 = f.writePinned({ ...f.apiRuntime, frontendSqlReplayed: true }, f.terminal.postflightSha256);
  const frontendReleaseOutcomeSha256 = write(join(f.frontend, "frontend-release-outcome.json"), { ...f.release, runtimeOutcomeSha256 });
  assert.throws(() => load(f.select({ ...f.terminal, runtimeOutcomeSha256, frontendReleaseOutcomeSha256 })), refuse);
});

test("replacement certification requires the private digest-named terminal within its action", t => {
  const f = fixture(t);
  const load = selection => prepareP2CertificationReplacementRelease(f.settings, selection);
  assert.throws(() => load({ ...f.selection, terminalSha256: "d".repeat(64) }), refuse);
  const foreign = join(f.directory, "foreign.json");
  write(foreign, readFileSync(f.selection.terminalFile, "utf8"));
  assert.throws(() => load({ ...f.selection, terminalFile: foreign }), refuse);
  const alias = join(f.frontend, `${f.selection.terminalSha256}-${"e".repeat(64)}.json`);
  symlinkSync(f.selection.terminalFile, alias);
  assert.throws(() => load({ ...f.selection, terminalFile: alias }), refuse);
  rmSync(alias);
  linkSync(f.selection.terminalFile, alias);
  assert.throws(() => load(f.selection), refuse);
  rmSync(alias);
  chmodSync(f.selection.terminalFile, 0o644);
  assert.throws(() => load(f.selection), refuse);
});

function profiledFixture(t) {
  const sourceCommit = nativeSourceCommit(), f = fixture(t, sourceCommit);
  const { original } = prepareP2CertificationReplacementRelease(f.settings, f.selection);
  const { plan, inventory } = original;
  const deploymentId = f.terminal.deploymentId, deploymentUrl = "https://owned-candidate.vercel.app";
  const readyIdentity = { version: 2, qualificationTargetProfile: profile, environment, releaseId, sourceCommit,
    projectId: f.probe.candidate.workload.projectId, previousDeploymentId: f.plan.predecessor.deploymentId };
  const build = { ...readyIdentity, trafficAuthorized: false, promotionAuthorized: false };
  for (const [name, record] of Object.entries({
    "frontend-build-started.json": build,
    "frontend-build-created.json": { ...build, deploymentId },
    "frontend-build-outcome.json": { ...build, deploymentId, status: "FRONTEND_STAGED", phase: "completed", readyState: "READY", url: deploymentUrl },
    "frontend-promotion-started.json": { ...readyIdentity, deploymentId, previousAliasRequestedAt: 0 },
  })) write(join(f.vercel, name), record);
  const readyReceiptSha256 = Object.fromEntries(P2_CERTIFICATION_READY_FILES.map(name => [name, digest(readFileSync(join(f.vercel, name)))]));
  const certification = { version: 2, qualificationTargetProfile: profile, environment, certificationActionId: "owned-certification",
    mode: "lifecycle-persistence", startState: "already-closed", initialEpoch: "1", candidateSha256: plan.candidateSha256,
    inventorySha256: plan.inventorySha256, configurationSha256: hash(plan.configurationSha256), readyReceiptSha256,
    runtimeInventorySha256: "1".repeat(64), gatewayProcessSha256: "2".repeat(64), gatewayConfigurationSha256: plan.configurationSha256["gateway.json"],
    operatorSourceClosureSha256: "3".repeat(64), persistenceReviewedSha256: "4".repeat(64),
    scopedAction: { stage: "verify-delete", subjectBindingSha256: "5".repeat(64) },
    native: { version: 2, qualificationTargetProfile: profile, actionId: releaseId, deploymentId, deploymentUrl,
      configurationRecordSha256: f.terminal.frontendWorkloadReceiptSha256, epoch: "1", target: f.probe.job.target,
      targetSha256: plan.targetSha256, owner: inventory.owner, producer: inventory.producers[0], featureControls: inventory.certification.featureControls,
      windowSeconds: 60, drainSeconds: 15, finalDisposition: "disabled-and-admission-closed", commandWitnesses: [] } };
  const settings = { version: 2, qualificationTargetProfile: profile, environment, operatorSourceCommit: sourceCommit,
    releaseSettings: f.settings, replacementRelease: f.selection, certification };
  return { f, original, plan, inventory, sourceCommit, deploymentId, readyReceiptSha256, certification, settings };
}

test("guarded worker planning accepts the pinned receiver contracts and still validates suspension input", t => {
  const { settings, certification } = profiledFixture(t);
  const guarded = { ...certification, mode: "direct-worker",
    worker: { input: { receiverNegatives: { profile: "suspended-head-negatives-v2" } } } };
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...settings, certification: guarded, worker: { suspensionInput: {} } }),
    { message: "QUALIFICATION_TARGET_PROFILE_REQUIRED" });
});

test("profiled certification planner consumes replacement readiness and binds the known acknowledgement intent", t => {
  const { f, original, plan, inventory, sourceCommit, deploymentId, readyReceiptSha256, certification, settings } = profiledFixture(t);
  const selected = prepareP2ProfiledCertificationOperator(settings);
  assert.equal(selected.originalReleasePlanSha256, f.settings.arm.reviewedPlanSha256);
  assert.equal(selected.originalReleaseReceiptSha256, f.selection.terminalSha256);
  assert.deepEqual(selected.replacementRelease, inventory.replacementRelease);
  assert.deepEqual(selected.readyReceiptSha256, readyReceiptSha256);
  assert.equal(selected.nativePlan.deploymentId, deploymentId);
  assert.equal(selected.frontendSqlReplay, false);
  const known = structuredClone(certification);
  delete known.scopedAction;
  delete known.persistenceReviewedSha256;
  known.mode = "known-ack-recovery";
  known.requestEvidence = { kind: "operator-recorded-request-details", path: join(f.directory, "known-request.json") };
  known.fault = { stageId: "owned-drop", receiver: "course", commandIndex: 0, commandSha256: "7".repeat(64) };
  known.native.commandWitnesses = [{ commandId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", accountVersion: "1", action: "suspend" }];
  known.knownAckRecovery = { version: 2, qualificationTargetProfile: profile, recoveryActionId: "owned-known-replacement",
    configurationInputDirectory: "/var/lib/lash-her/releases/staging/owned-known-input",
    receiverTargets: Object.fromEntries(Object.entries(original.apiJobs).map(([service, job]) => {
      const { host, port, database, serverMajor } = job.target;
      return [service, { host, port, database, serverMajor, user: job.runtimeRole, roleOid: "102" }];
    })) };
  const knownSettings = { ...settings, certification: known };
  const knownPlan = prepareP2ProfiledCertificationOperator(knownSettings);
  const intent = knownPlan.knownAckRecovery.intent;
  assert.deepEqual(intent.replacementRelease, inventory.replacementRelease);
  assert.equal(intent.originalReleaseReceiptSha256, f.selection.terminalSha256);
  assert.equal(intent.originalReleasePlanSha256, f.settings.arm.reviewedPlanSha256);
  assert.equal(intent.sqlReplayAllowed, false);
  assert.equal(intent.roleChangeAllowed, false);
  assert.equal(intent.runtimeReplacements, 1);
  const wrong = structuredClone(knownSettings);
  wrong.certification.knownAckRecovery.receiverTargets.course.database = "foreign";
  assert.throws(() => prepareP2ProfiledCertificationOperator(wrong));
  const prior = "owned-prior-certification", runtimeActionId = "owned-known-replacement";
  const priorDirectory = join(f.settings.arm.results, prior);
  mkdirSync(priorDirectory, { mode: 0o700 });
  const receiptFile = join(priorDirectory, "p2-replacement-successor-runtime.json");
  const receiptSha256 = write(receiptFile, {
    version: 2, qualificationTargetProfile: profile, status: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED", environment,
    kind: "known-ack", actionId: prior, runtimeActionId, releaseId, sourceCommit, hostMachineId: f.settings.arm.host.machineId,
    candidateSha256: plan.candidateSha256, targetSha256: plan.targetSha256, configurationCanonicalSha256: p2NativeHash(plan.configurationSha256),
    replacementRelease: inventory.replacementRelease, originalReleaseReceiptSha256: f.selection.terminalSha256,
    originalReleasePlanSha256: f.settings.arm.reviewedPlanSha256, terminalSha256: "a".repeat(64), runtimeReceiptSha256: "b".repeat(64),
    frontendSessionClosedSha256: "c".repeat(64), frontendEpoch: "4", runtimeInventorySha256: "d".repeat(64), gatewayProcessSha256: "e".repeat(64),
  });
  const successorSettings = { ...settings, successorRuntime: { receiptFile, receiptSha256 }, certification: {
    ...certification, initialEpoch: "4", runtimeInventorySha256: "d".repeat(64), gatewayProcessSha256: "e".repeat(64),
  } };
  const successorPlan = prepareP2ProfiledCertificationOperator(successorSettings);
  assert.deepEqual(successorPlan.successorRuntime, { kind: "known-ack", actionId: prior, runtimeActionId, receiptSha256 });
  assert.equal(successorPlan.originalReleasePlanSha256, selected.originalReleasePlanSha256);
  assert.equal(successorPlan.originalReleaseReceiptSha256, selected.originalReleaseReceiptSha256);
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...successorSettings, certification: {
    ...successorSettings.certification, initialEpoch: "3",
  } }));
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...successorSettings, certification: {
    ...known, initialEpoch: "4", runtimeInventorySha256: "d".repeat(64), gatewayProcessSha256: "e".repeat(64),
  } }));
  const path = join(f.vercel, "frontend-build-outcome.json"), originalReady = readFileSync(path);
  writeFileSync(path, Buffer.concat([originalReady, Buffer.from("\n")]));
  assert.throws(() => prepareP2ProfiledCertificationOperator(settings));
  writeFileSync(path, originalReady);
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...settings, certification: { ...certification, startState: "qualified-ready" } }));
});

function rotationFixture(t, predecessorKind) {
  const { f, original, plan: release, inventory, sourceCommit, readyReceiptSha256: originalReady, settings } = profiledFixture(t);
  const actionId = "p2-key-rotation-owned-successor";
  const sourceFiles = ["ops/platform/p2-certification-current-probe.mjs", "ops/platform/p2-identity-key-rotation-replacement.mjs"]
    .map(path => ({ path, sha256: digest(path), data: Buffer.from(path).toString("base64") }));
  const sourceClosure = p2NativeHash(JSON.stringify(sourceFiles.map(({ path, sha256 }) => [path, sha256])));
  const predecessorInventory = digest("predecessor inventory"), gatewayProcessSha256 = digest("gateway");
  const results = f.settings.arm.results;
  let predecessor;
  if (predecessorKind) {
    const priorAction = "owned-prior-certification";
    const runtimeActionId = predecessorKind === "known-ack" ? "owned-runtime-successor" : priorAction;
    const priorDirectory = join(results, priorAction);
    mkdirSync(priorDirectory, { mode: 0o700 });
    const receiptFile = join(priorDirectory, "p2-replacement-successor-runtime.json");
    const terminalSha256 = digest("previous terminal");
    const receiptSha256 = write(receiptFile, {
      version: 2, qualificationTargetProfile: profile, environment, status: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED",
      kind: predecessorKind, actionId: priorAction, runtimeActionId, releaseId, sourceCommit, hostMachineId: f.settings.arm.host.machineId,
      candidateSha256: release.candidateSha256, targetSha256: release.targetSha256, configurationCanonicalSha256: p2NativeHash(release.configurationSha256),
      replacementRelease: inventory.replacementRelease, originalReleaseReceiptSha256: f.selection.terminalSha256,
      originalReleasePlanSha256: f.settings.arm.reviewedPlanSha256, terminalSha256,
      runtimeReceiptSha256: predecessorKind === "known-ack" ? digest("previous runtime") : terminalSha256,
      frontendSessionClosedSha256: digest("previous close"), frontendEpoch: "3",
      runtimeInventorySha256: predecessorInventory, gatewayProcessSha256,
    });
    predecessor = { receiptFile, receiptSha256 };
  }
  const lease = prepareP2IdentityRotationReplacementLease({
    version: 2, qualificationTargetProfile: profile, environment, operatorSourceCommit: sourceCommit,
    releaseSettings: f.settings, replacementRelease: f.selection, ...(predecessor ? { successorRuntime: predecessor } : {}),
    custody: { actionId, initialEpoch: "4", runtimeInventorySha256: predecessorInventory, gatewayProcessSha256,
      operatorSourceClosureSha256: sourceClosure, authenticationWindows: ["overlap", "current-only", "post-removal"] },
  });
  const phases = ["baseline", "overlap", "current-only"];
  const rotationPath = "/var/lib/lash-her/releases/staging/owned/rotation";
  const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
  const { plan, hostReview } = bindP2ManagedIdentityRotationPlan(lease, sourceFiles, rotationPath, {
    actionId, courseId: id("1"),
    subjects: { "course-learner": id("2"), "course-admin": id("3"), "community-member": id("4"), "community-admin": id("5") },
    configuration: Object.fromEntries(phases.map(phase => [phase, { privateRef: join(rotationPath, phase), sha256: digest(phase) }])),
    privateConfigurationSha256: Object.fromEntries(phases.map(phase => [phase, digest(`private-${phase}`)])),
  });
  const directory = join(results, actionId);
  mkdirSync(directory, { mode: 0o700 });
  const save = (name, value) => write(join(directory, name), value);
  save("reviewed-plan.json", plan);
  save("frontend-custody.json", hostReview);
  const frontendSessionClosedSha256 = digest("rotation closure"), postRemovalSignerReceiptSha256 = digest("signer");
  const profileEvidenceClass = { "course-learner": "actual-protected-course-http", "course-admin": "actual-protected-course-http",
    "community-member": "deployed-private-community-verifier", "community-admin": "deployed-private-community-verifier" };
  save("host-rotation-joined.json", {
    version: 2, qualificationTargetProfile: profile, environment, status: "P2_IDENTITY_KEY_ROTATION_QUALIFIED",
    actionId, bindingSha256: plan.bindingSha256, candidateSha256: plan.candidateSha256, sourceCommit, keyRemovalVerified: true,
    frontendCustodyPlanSha256: plan.frontendCustodyPlanSha256, frontendFinalEpoch: plan.finalEpoch,
    frontendSessionCloseReceiptSha256: frontendSessionClosedSha256, configurationSha256: plan.configuration["current-only"].sha256,
    sourceParentDispatchIntegrated: true, profileEvidenceClass,
    profileReceiptSha256: Object.fromEntries(Object.keys(profileEvidenceClass).map(profile => [profile,
      { overlap: digest(profile + "overlap"), "current-only": digest(profile + "current-only") }])),
    frontendSignerReceiptSha256: { overlap: digest("overlap signer"), "current-only": digest("current signer"), "post-removal": postRemovalSignerReceiptSha256 },
    ...Object.fromEntries(["nativeSchedulesEnabled", "trafficAuthorized", "releaseAccepted", "g2Accepted", "sqlExecuted", "rolesPrepared",
      "loginChanged", "tokenBytesOutput", "credentialHashesOutput", "communityMemberFeatureAdded", "newPublicEndpoint"].map(key => [key, false])),
  });
  const deploymentId = "dpl_ownedCurrentOnly", deploymentUrl = "https://owned-current-only.vercel.app";
  const readyBytes = Object.fromEntries(P2_CERTIFICATION_READY_FILES.map(name => {
    const ready = JSON.parse(readFileSync(join(f.vercel, name)));
    ready.previousDeploymentId = "dpl_ownedOverlap";
    if (name !== "frontend-build-started.json") ready.deploymentId = deploymentId;
    if (name === "frontend-build-outcome.json") ready.url = deploymentUrl;
    return [name, Buffer.from(serialize(ready))];
  }));
  const readyReceiptSha256 = Object.fromEntries(Object.entries(readyBytes).map(([name, raw]) => [name, digest(raw)]));
  const terminalReceiptSha256 = digest("exact raw guardian terminal"), runtimeInventorySha256 = digest("mixed inventory");
  const receipt = { version: 2, qualificationTargetProfile: profile, environment,
    status: "P2_IDENTITY_ROTATION_MIXED_SUCCESSOR_RUNTIME_VERIFIED", kind: rotationSuccessorKind, actionId, releaseId,
    bindingSha256: plan.bindingSha256, sourceCommit, candidateSha256: plan.candidateSha256, hostMachineId: plan.hostMachineId,
    targetSha256: plan.targetSha256, originalReleasePlanSha256: f.settings.arm.reviewedPlanSha256,
    originalReleaseReceiptSha256: f.selection.terminalSha256, predecessorRuntimeInventorySha256: predecessorInventory,
    ...(predecessor ? { predecessorSuccessorReceiptSha256: predecessor.receiptSha256 } : {}),
    terminalReceiptSha256, frontendSessionClosedSha256, configurationSha256: plan.configuration["current-only"].sha256,
    currentOnlyRuntimeConfigurationSha256: digest("current private composite"), runtimeInventorySha256, gatewayProcessSha256,
    gatewayConfigurationSha256: release.configurationSha256["gateway.json"], frontendEpoch: plan.finalEpoch,
    frontend: { deploymentId, deploymentUrl, readyReceiptSha256, postRemovalSignerReceiptSha256 },
    mutationReceipts: [["overlap", "api"], ["overlap", "frontend"], ["current-only", "frontend"], ["current-only", "api"]]
      .map(([phase, kind]) => ({ phase, kind, attemptReceiptSha256: digest(phase + kind), observationReceiptSha256: digest(kind + phase) })),
    phaseRuntimeInventoryReceiptSha256: Object.fromEntries(phases.map(phase => [phase, digest("inventory" + phase)])),
    unchangedOriginalServices: ["community-tls", "course-tls", "course-snapshot", "community-worker", "course-media", "course-export-cleanup", "course-publisher", "gateway"],
    currentOnlyRecreatedServices: ["course-api", "community-api"], frontendAdmissionClosed: true, gatewayAdmissionClosed: true,
    nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false, g2Accepted: false };
  const record = value => {
    const raw = Buffer.from(serialize(value)), receiptSha256 = digest(raw);
    save("managed-rotation-successor-evidence.json", { receiptSha256, terminalReceiptSha256, originalBytesBase64: raw.toString("base64") });
    save("managed-rotation-frontend-ready.json", { successorReceiptSha256: receiptSha256,
      originalBytesBase64: Object.fromEntries(Object.entries(readyBytes).map(([name, bytes]) => [name, bytes.toString("base64")])) });
    return { ...settings, rotationSuccessor: { actionId, receiptSha256 }, certification: { ...settings.certification,
      runtimeInventorySha256, gatewayProcessSha256, operatorSourceClosureSha256: sourceClosure, initialEpoch: plan.finalEpoch, readyReceiptSha256,
      native: { ...settings.certification.native, deploymentId, deploymentUrl, epoch: plan.finalEpoch,
        configurationRecordSha256: readyReceiptSha256["frontend-workload-outcome.json"] } } };
  };
  const checked = prepareP2CertificationReplacementRelease(f.settings, f.selection);
  return { f, original, originalReady, predecessor, receipt, record, directory, checked, plan, hostReview };
}

test("profiled mixed successor plans with current READY evidence and retains the original release and mount chain", async t => {
  for (const kind of [null, "known-ack", "interrupted-known-ack"]) {
    const fixture = rotationFixture(t, kind);
    const settings = fixture.record(fixture.receipt);
    const selected = prepareP2ProfiledCertificationOperator(settings);
    assert.deepEqual(selected.rotationSuccessor, {
      kind: rotationSuccessorKind, ...settings.rotationSuccessor, bindingSha256: fixture.plan.bindingSha256,
      ...(kind ? { predecessorRuntime: fixture.hostReview.certificationPlan.successorRuntime } : {}),
    });
    assert.equal(selected.nativePlan.deploymentId, fixture.receipt.frontend.deploymentId);
    assert.deepEqual(selected.readyReceiptSha256, fixture.receipt.frontend.readyReceiptSha256);
    assert.deepEqual(selected.originalFrontendReady, { deploymentId: fixture.f.terminal.deploymentId,
      deploymentUrl: fixture.hostReview.certificationPlan.nativePlan.deploymentUrl, readyReceiptSha256: fixture.originalReady });
    assert.equal(selected.originalReleaseReceiptSha256, fixture.f.selection.terminalSha256);
    assert.deepEqual(selected.apiJobSha256, fixture.original.plan.apiJobSha256);
    const review = prepareP2CertificationRotationSuccessor(settings.rotationSuccessor, fixture.checked,
      settings.certification, settings.releaseSettings.arm.results, P2_CERTIFICATION_READY_FILES);
    assert.equal(review.configuration, fixture.hostReview.configuration);
    assert.equal(review.frontendEpoch, fixture.plan.finalEpoch);
    const next = { ...settings.certification, operatorSourceCommit: settings.operatorSourceCommit };
    const { original, candidateBytes, profiledRelease } = fixture.checked;
    const planAction = input => prepareP2BoundedCertification({ migration: original.migration, plan: original.inventory }, input,
      candidateBytes, { frontendReceipts: review.currentReady, configurationSha256: original.plan.configurationSha256,
        profiledRelease: { ...profiledRelease, rotationSuccessor: review.binding,
          rotationSuccessorFrontendEpoch: review.frontendEpoch, originalFrontendReady: review.originalFrontendReady } });
    assert.equal(planAction(next).initialEpoch, review.frontendEpoch);
    assert.throws(() => planAction({ ...next, certificationActionId: "owned-earlier-authentication",
      initialEpoch: (BigInt(review.frontendEpoch) - 2n).toString() }),
    { message: "P2_CERTIFICATION_ROTATION_SUCCESSOR_EPOCH_REFUSED" });
    assert.equal(digest(Buffer.from(review.rawReceiptBase64, "base64")), settings.rotationSuccessor.receiptSha256);
    assert.equal(digest(review.originalReady.get("frontend-workload-outcome.json")), fixture.f.terminal.frontendWorkloadReceiptSha256);
    assert.equal(digest(review.currentReady.get("frontend-workload-outcome.json")), selected.nativePlan.configurationRecordSha256);
    await assert.rejects(p2ProfiledCertificationOperator(settings, { confirmation: "staging/other-certification" }),
      { message: "P2_CERTIFICATION_ROTATION_SUCCESSOR_LIVE_UNQUALIFIED" });
  }
});

test("live mixed successor accepts only Mux readiness before preparing any other action", async () => {
  for (const mode of ["auth-preparation", "browser-pending", "direct-worker", "interactive-browser",
    "lifecycle-persistence", "export-cleanup", "mux-replacement-evidence", "native-window"]) {
    await assert.rejects(p2ProfiledCertificationOperator({ rotationSuccessor: {}, certification: { mode } }),
      { message: "P2_CERTIFICATION_ROTATION_SUCCESSOR_LIVE_UNQUALIFIED" });
  }
});

test("mixed successor refuses stale epochs, foreign provenance, changed original bytes, and wrong READY records", t => {
  const fixture = rotationFixture(t, "known-ack");
  for (const change of [
    { originalReleaseReceiptSha256: digest("foreign release") },
    { predecessorSuccessorReceiptSha256: digest("foreign predecessor") },
    { currentOnlyRuntimeConfigurationSha256: undefined },
    { unchangedOriginalServices: [] },
    { frontend: { ...fixture.receipt.frontend, postRemovalSignerReceiptSha256: digest("foreign signer") } },
  ]) assert.throws(() => prepareP2ProfiledCertificationOperator(fixture.record({ ...fixture.receipt, ...change })));
  const settings = fixture.record(fixture.receipt);
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...settings, successorRuntime: fixture.predecessor }));
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...settings, certification: { ...settings.certification, initialEpoch: "9" } }));
  assert.throws(() => prepareP2ProfiledCertificationOperator({ ...settings,
    certification: { ...settings.certification, mode: "contain-native", scopedAction: undefined, persistenceReviewedSha256: undefined } }));
  const original = join(fixture.f.vercel, "frontend-build-outcome.json");
  const saved = readFileSync(original);
  writeFileSync(original, Buffer.concat([saved, Buffer.from("\n")]));
  assert.throws(() => prepareP2ProfiledCertificationOperator(settings));
  writeFileSync(original, saved);
  const retained = join(fixture.directory, "managed-rotation-frontend-ready.json");
  const ready = JSON.parse(readFileSync(retained));
  ready.originalBytesBase64["frontend-workload-outcome.json"] = ready.originalBytesBase64["frontend-build-outcome.json"];
  write(retained, ready);
  assert.throws(() => prepareP2ProfiledCertificationOperator(settings));
});
