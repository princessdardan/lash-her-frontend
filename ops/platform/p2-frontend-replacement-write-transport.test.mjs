import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-admission-bootstrap.mjs";
import { selectManagedNeonCatalog } from "./frontend-managed-neon-catalog.mjs";
import { exchangeFrontendReplacementWrite } from "./p2-frontend-replacement-write-transport.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = { message: "P2_FRONTEND_REPLACEMENT_WRITE_TRANSPORT_REFUSED" };
const raw = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const release = {
  version: 1, qualificationTargetProfile: profile, environment: "staging",
  releaseId: "owned-replacement-write", sourceCommit: "a".repeat(40), candidateSha256: "b".repeat(64), targetSha256: "c".repeat(64),
};
const producerSha256 = "d".repeat(64), phase2ContractManifestSha256 = "sha256:" + "e".repeat(64);
const target = { host: "replacement.invalid", port: 5432, database: "replacement", user: "owner",
  runtimeRole: FRONTEND_PREPARATION_ROLES.runtime, serverMajor: 18 };
const predecessorTarget = { ...target, host: "prior.invalid", runtimeRole: "prior_runtime" };
const approvedPendingTags = ["0001_owned", "0002_owned"];
const administrativeLogins = [{ name: "owned_admin_a", oid: "48" }, { name: "owned_admin_z", oid: "49" }];
const plan = { ...release, status: "P2_FRONTEND_REPLACEMENT_PLAN_PREPARED", phase2ContractManifestSha256,
  replacement: { target, approvedPendingTags, administrativeLogins, databaseOid: "41", migrationRoleOid: "42" },
  predecessor: { target: predecessorTarget } };
const reviewedPlanBytes = raw(plan), reviewedPlanSha256 = hash(reviewedPlanBytes);
const reviewed = { ...release, reviewedPlanSha256, hostMachineId: "a".repeat(32), producerSha256,
  apiJobSha256: { course: "1".repeat(64), community: "2".repeat(64) }, configurationSha256: { "runtime.json": "3".repeat(64) } };
const reviewedBytes = raw(reviewed), runtimeReviewSha256 = hash(reviewedBytes);
const initial = { ...release, mode: "p2-profiled-frontend-replacement-write", hostMachineId: reviewed.hostMachineId,
  reviewedPlanBytes: reviewedPlanBytes.toString("base64"), reviewedPlanSha256, runtimeReviewBytes: reviewedBytes.toString("base64"),
  runtimeReviewSha256, confirmation: `staging/${release.releaseId}/replacement-write/${reviewedPlanSha256}/${runtimeReviewSha256}` };
const noReview = Object.fromEntries(Object.entries(initial).filter(([key]) => !key.startsWith("runtimeReview")));
noReview.confirmation = `staging/${release.releaseId}/replacement-write/${reviewedPlanSha256}`;
const probe = { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
  job: { target: { ...target, approvedPendingTags, allowEmptyBootstrap: true }, releaseId: release.releaseId, sourceCommit: release.sourceCommit },
  predecessorTarget, targetSha256: plan.targetSha256, databaseOid: "41", migrationRoleOid: "42",
  marker: "f".repeat(64), backendPid: 313, backendStart: "2026-11-09T19:45:00.123456Z" };
const physical = { version: 1, qualificationTargetProfile: profile, operation: probe.operation,
  status: "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", environment: release.environment, releaseId: release.releaseId,
  sourceCommit: release.sourceCommit, targetSha256: probe.targetSha256, databaseOid: probe.databaseOid,
  migrationRoleOid: probe.migrationRoleOid, marker: probe.marker, backendPid: probe.backendPid, backendStart: probe.backendStart,
  readOnlyVerified: true, authorityIssued: false, trafficAuthorized: false };
const physicalBytes = raw(physical);
const armData = { physicalObservation: physicalBytes.toString("base64"), physicalObservationSha256: hash(physicalBytes) };
const guarded = { ...release, reviewedPlanSha256, bootstrapAuthorized: false, migrationAuthorized: false,
  deploymentAuthorized: false, trafficAuthorized: false };
const armed = { ...guarded, ...armData, status: "P2_FRONTEND_REPLACEMENT_ARMED" };
const armReceiptSha256 = hash(raw(armed));
const boundary = { version: 1, status: "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED", target, predecessorTarget,
  databaseOid: probe.databaseOid, migrationRoleOid: probe.migrationRoleOid, administrativeLogins,
  catalogScope: "postgresql-16-18-stock-replacement-v1", zeroCatalogCounts: { pg_class: 0 }, observedAt: "2026-11-09T19:45:00.123Z",
  readOnlyVerified: true, completeDatabaseEmptyProven: false, authorityIssued: false };
const custody = { ...guarded, armReceiptSha256, emptyCatalogReceiptSha256: hash(raw(boundary)),
  physicalObservationSha256: armData.physicalObservationSha256, automaticReplayAuthorized: false,
  status: "P2_FRONTEND_REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED" };
const writeIntentSha256 = hash(raw(custody));
const databaseReceipt = raw({ status: "DATABASE_VERIFIED", after: [1, 2] });
const continuationStarted = raw({ status: "FRONTEND_CONTINUATION_STARTED", databaseVerified: true });
const owner = { name: FRONTEND_PREPARATION_ROLES.owner, oid: "43" }, runtimeRole = { name: FRONTEND_PREPARATION_ROLES.runtime, oid: "44" };
const writtenInput = { databaseReceipt, continuationStarted, owner, runtime: runtimeRole, producerSha256 };
const written = { ...physical, operation: "verify-replacement-written", status: "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED",
  physicalObservationSha256: armData.physicalObservationSha256, databaseReceiptSha256: hash(databaseReceipt),
  continuationStartedSha256: hash(continuationStarted), owner, runtime: runtimeRole, producerSha256, administrativeLogins,
  appliedMigrationCount: 2, epoch: "1", newWork: false, recovery: false, active: 0, uncertain: 0,
  schemaVerified: true, runtimeRoleVerified: true, effectiveLoginBoundaryVerified: true };
const postflightSha256 = hash(raw(written));
const runtimeIntent = { ...release, status: "P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED", reviewedPlanSha256,
  runtimeReviewSha256, postflightSha256, apiJobSha256: reviewed.apiJobSha256, configurationSha256: reviewed.configurationSha256,
  trafficAuthorized: false };
const apiCommon = { version: 2, qualificationTargetProfile: profile, environment: "staging", releaseId: release.releaseId,
  candidateSha256: release.candidateSha256, contractPhase: "p2", phase2ContractManifestSha256, phase: "completed",
  frontendSqlApplied: true, frontendMigrationMode: "apply-forward", frontendReadOnlyVerified: false, frontendSqlReplayed: false,
  frontendReplacementReadbackSha256: postflightSha256, frontendContinuationStartedSha256: hash(continuationStarted),
  trafficAuthorized: false, historicalProviderClosureClaimed: false, oldP200Qualified: false, nativeSchedulesEnabled: false, releaseAccepted: false };
const migration = { ...apiCommon, status: "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN", databaseReceiptSha256: { frontend: hash(databaseReceipt) } };
const migrationOutcomeSha256 = hash(raw(migration));
const runtimeOutcome = { ...apiCommon, status: "API_RUNTIME_READY", sourceCommit: release.sourceCommit,
  configurationSha256: reviewed.configurationSha256, migrationOutcomeSha256, frontendPromotionAuthorized: false };
const runtimeOutcomeSha256 = hash(raw(runtimeOutcome));
const releaseBase = { ...release, version: 2, configurationSha256: reviewed.configurationSha256, postflightSha256,
  reviewedPlanSha256, runtimeReviewSha256, runtimeOutcomeSha256, migrationOutcomeSha256,
  contractPhase: "p2", phase2ContractManifestSha256, frontendSqlApplied: true, frontendSqlReplayed: false,
  historicalProviderClosureClaimed: false, oldP200Qualified: false, nativeSchedulesEnabled: false, trafficAuthorized: false,
  releaseAccepted: false };
const deployment = { deploymentId: "dpl_owned", releaseId: release.releaseId, sourceCommit: release.sourceCommit,
  environment: release.environment, trafficAuthorized: false };
const proof = { ...releaseBase, ...deployment, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED" };
const workload = { ...deployment, status: "FRONTEND_VERIFIED" }, promotion = { ...deployment, status: "FRONTEND_DOMAINS_PROMOTED" };
const proofSha256 = hash(raw(proof));
const closePrepared = { ...guarded, status: "P2_FRONTEND_REPLACEMENT_CLOSE_PREPARED", providerProofSha256: proofSha256 };
const closedReceipt = { ...written, status: "P2_FRONTEND_REPLACEMENT_SESSION_CLOSED", operation: "verify-replacement-closed",
  writtenObservationSha256: postflightSha256, originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true };
const sessionClosedSha256 = hash(raw(closedReceipt));
const terminal = { status: "DATABASE_VERIFIED", phase: "completed", readOnlyVerified: false };
const continuationCompleted = { ...JSON.parse(continuationStarted), status: "FRONTEND_CONTINUATION_COMPLETED" };
const releaseOutcome = { ...releaseBase, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED", deploymentProofSha256: proofSha256 };
const commitIntent = { ...releaseBase, status: "P2_FRONTEND_REPLACEMENT_WRITE_COMMIT_INTENT", frontendSessionClosed: true,
  migrationMode: "apply-forward", deploymentId: deployment.deploymentId, owner, runtime: runtimeRole, producerSha256,
  frontendDatabaseReceiptSha256: hash(databaseReceipt), frontendContinuationStartedSha256: hash(continuationStarted),
  frontendDeploymentProofSha256: proofSha256, frontendWorkloadReceiptSha256: hash(raw(workload)),
  frontendPromotionReceiptSha256: hash(raw(promotion)), frontendTerminalSha256: hash(raw(terminal)),
  frontendContinuationCompletedSha256: hash(raw(continuationCompleted)), frontendReleaseOutcomeSha256: hash(raw(releaseOutcome)),
  frontendSessionClosedSha256: sessionClosedSha256 };
const commitIntentSha256 = hash(raw(commitIntent));
const writeOutcome = { ...commitIntent, status: "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION" };
const providerInitial = { ...initial, vercelToken: "owned-test-token" };
const freshIdentity = { marker: "3".repeat(64), backendPid: 317, backendStart: "2026-11-11T19:45:00.123456Z" };
const freshProbe = { ...probe, ...freshIdentity }, freshPhysical = { ...physical, ...freshIdentity };
const originalDirectory = `/var/lib/lash/results/p2-profiled-replacement-write-${release.releaseId}`;
const recoveryReview = { actionId: "owned-replacement-recovery", originalDirectory, originalEvidenceSha256: {
  physicalObservation: hash(physicalBytes), databaseReceipt: hash(databaseReceipt), continuationStarted: hash(continuationStarted),
  writtenObservation: postflightSha256, abortObservation: "4".repeat(64), runtimeOutcome: "5".repeat(64),
  writeContainment: "6".repeat(64), runtimeContainment: "7".repeat(64),
} };
const retained = { originalProbe: probe, physicalObservation: physicalBytes, databaseReceipt, continuationStarted, writtenObservation: raw(written) };

function recoveryInitial(review = recoveryReview) {
  const bytes = raw(review), sha = hash(bytes);
  return { ...providerInitial, operatorSourceCommit: "9".repeat(40), results: `/var/lib/lash/results/${review.actionId}`,
    recoveryReviewBytes: bytes.toString("base64"), recoveryReviewSha256: sha, confirmation: `${initial.confirmation}/recover/${sha}` };
}

function host({ mutate = value => value, slowArm = false, alterEvidence = (_name, bytes) => bytes, exit = 1,
  replacement = { armed, armReceiptSha256, boundary, custody, writeIntentSha256 } } = {}) {
  const child = new EventEmitter(), calls = [], reads = [], timers = [];
  const records = {
    "p2-frontend-replacement-guard-armed.json": replacement.armed,
    "p2-frontend-replacement-empty-catalog.json": replacement.boundary,
    "p2-frontend-replacement-write-intent.json": replacement.custody,
    "p2-frontend-replacement-written-observation.json": written,
    "p2-frontend-replacement-recovery-physical-observation.json": freshPhysical,
    "p2-frontend-replacement-runtime-intent.json": runtimeIntent,
    "migration-outcome.json": migration,
    "runtime-outcome.json": runtimeOutcome,
    "frontend-deployment-proof.json": proof,
    "frontend-workload-outcome.json": workload,
    "frontend-promotion-outcome.json": promotion,
    "p2-frontend-replacement-close-prepared.json": closePrepared,
    "frontend-session-closed.json": closedReceipt,
    "frontend-job-outcome.json": terminal,
    "frontend-continuation-completed.json": continuationCompleted,
    "frontend-release-outcome.json": releaseOutcome,
    "p2-frontend-replacement-write-commit-intent.json": commitIntent,
    "p2-frontend-replacement-write-outcome.json": writeOutcome,
  };
  let closed = false, reaped = false, armPending = false, heldChecks = "";
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    timers.forEach(clearTimeout);
    setImmediate(() => { reaped = true; child.emit("close", code, signal); });
  };
  child.kill = signal => close(null, signal);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const packet = JSON.parse(chunk);
      const operation = packet.operation ?? "initial", id = packet.id ?? 0;
      calls.push({ operation, packet });
      let response = { id, status: "LOCKED" };
      if (operation === "arm-replacement") response = { id, status: "REPLACEMENT_ARMED", receipt: replacement.armed,
        armReceiptSha256: replacement.armReceiptSha256 };
      if (operation === "authorize-replacement-write") response = { id, status: "REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED", receipt: replacement.custody,
        writeIntentSha256: replacement.writeIntentSha256 };
      if (operation === "verify-replacement-written") response = { id, status: "REPLACEMENT_WRITTEN_VERIFIED", postflightSha256 };
      if (operation === "resume-replacement-written") response = { id, status: "REPLACEMENT_WRITTEN_RESUMED", postflightSha256 };
      if (operation === "start-replacement-runtime") response = { id, status: "REPLACEMENT_API_RUNTIME_READY", runtimeOutcomeSha256, migrationOutcomeSha256 };
      if (operation === "verify-replacement-frontend") response = { id, status: "REPLACEMENT_FRONTEND_VERIFIED", proofSha256 };
      if (operation === "prepare-replacement-close") response = { id, status: "REPLACEMENT_CLOSE_PREPARED" };
      if (operation === "observe-replacement-closed") response = { id, status: "REPLACEMENT_SESSION_CLOSED", sessionClosedSha256 };
      if (operation === "finish-replacement") response = { id, status: "REPLACEMENT_JOINED", commitIntentSha256 };
      if (operation === "commit") response = { id, status: "COMMITTED", commitIntentSha256 };
      response = mutate(response, packet);
      const line = typeof response === "string" ? response : JSON.stringify(response) + "\n";
      if (slowArm && operation === "arm-replacement") armPending = true;
      if (armPending && operation === "check") heldChecks += line;
      else timers.push(setTimeout(() => {
        child.stdout.write(line.slice(0, 5));
        child.stdout.write(line.slice(5) + heldChecks);
        if (operation === "arm-replacement") armPending = false;
        heldChecks = "";
      }, armPending ? 1250 : 0));
      callback();
    },
    final(callback) { close(exit, null); callback(); },
  });
  return { child, calls, reads, close, reaped: () => reaped,
    readHostEvidence(name) { reads.push(name); return alterEvidence(name, raw(records[name])); } };
}

async function toRuntime(operator) {
  assert.equal(operator.signal.aborted, false);
  const arm = await operator.armReplacement(probe);
  assert.deepEqual(arm, { ...armData, armReceiptSha256 });
  assert.deepEqual(await operator.authorizeReplacementWrite(boundary), { receipt: custody, writeIntentSha256 });
  const postflight = await operator.verifyReplacementWritten(writtenInput);
  assert.deepEqual(postflight, { receipt: written, bytes: raw(written), postflightSha256 });
  const ready = await operator.startReplacementRuntime();
  assert.deepEqual(ready, { migrationOutcome: migration, migrationOutcomeBytes: raw(migration), migrationOutcomeSha256,
    runtimeOutcome, runtimeOutcomeBytes: raw(runtimeOutcome), runtimeOutcomeSha256 });
}

const exchange = (fixture, task, input = initial) =>
  exchangeFrontendReplacementWrite(fixture.child, input, plan, task, { readHostEvidence: fixture.readHostEvidence });

const exchangeRecovery = (fixture, task, input = recoveryInitial(), recovery = retained) =>
  exchangeFrontendReplacementWrite(fixture.child, input, plan, task, { readHostEvidence: fixture.readHostEvidence, recovery });

test("write transport joins original receipts and heartbeats during a pending arm, then contains on EOF", async () => {
  const fixture = host({ slowArm: true });
  let reachedRuntime = false;
  await assert.rejects(exchange(fixture, async operator => {
    await toRuntime(operator);
    reachedRuntime = true;
  }), refusal);
  assert.equal(reachedRuntime, true);
  assert.equal(fixture.reaped(), true);
  const operations = fixture.calls.map(call => call.operation);
  assert.deepEqual(operations.filter(operation => operation !== "check"),
    ["initial", "arm-replacement", "authorize-replacement-write", "verify-replacement-written", "start-replacement-runtime"]);
  assert.ok(operations.slice(operations.indexOf("arm-replacement") + 1, operations.indexOf("authorize-replacement-write")).includes("check"));
  const request = fixture.calls.find(call => call.operation === "verify-replacement-written").packet;
  assert.deepEqual(request, { id: request.id, operation: "verify-replacement-written", writeIntentSha256,
    databaseReceipt: databaseReceipt.toString("base64"), continuationStarted: continuationStarted.toString("base64"),
    owner, runtime: runtimeRole, producerSha256 });
  const { packet } = fixture.calls.at(-1);
  assert.deepEqual(packet, { id: packet.id, operation: "start-replacement-runtime", postflightSha256 });
});

function managedReplacementFixture() {
  const bytes = readFileSync(new URL("./managed-neon-replacement-catalog.json", import.meta.url));
  const { id, provider, target, databaseOid, migrationRoleOid, administrativeLogins } = JSON.parse(bytes);
  const reference = { id, sha256: hash(bytes) };
  const managedTarget = { ...target, runtimeRole: FRONTEND_PREPARATION_ROLES.runtime };
  const identity = { provider, target: managedTarget, databaseOid, migrationRoleOid, administrativeLogins };
  const managed = selectManagedNeonCatalog(reference, identity);
  const managedPlan = { ...plan, replacement: { ...plan.replacement, ...identity, managedCatalog: reference } };
  const managedPlanBytes = raw(managedPlan), planSha256 = hash(managedPlanBytes);
  const managedInitial = { ...noReview, reviewedPlanBytes: managedPlanBytes.toString("base64"), reviewedPlanSha256: planSha256,
    confirmation: `staging/${release.releaseId}/replacement-write/${planSha256}` };
  const managedProbe = { ...probe, databaseOid, migrationRoleOid, job: { ...probe.job,
    target: { ...probe.job.target, ...managedTarget } } };
  const physicalObservation = raw({ ...physical, databaseOid, migrationRoleOid });
  const armReceipt = { ...armed, reviewedPlanSha256: planSha256, physicalObservation: physicalObservation.toString("base64"),
    physicalObservationSha256: hash(physicalObservation) };
  const { zeroCatalogCounts: _unused, ...sharedBoundary } = boundary;
  const managedBoundary = { ...sharedBoundary, target: managedTarget, databaseOid, migrationRoleOid, administrativeLogins,
    catalogScope: "postgresql-18-managed-neon-replacement-v1", catalogCounts: managed.expectedCatalogCounts, managedCatalog: reference };
  const armHash = hash(raw(armReceipt));
  const managedCustody = { ...custody, reviewedPlanSha256: planSha256, physicalObservationSha256: hash(physicalObservation),
    armReceiptSha256: armHash, emptyCatalogReceiptSha256: hash(raw(managedBoundary)) };
  return { plan: managedPlan, initial: managedInitial, probe: managedProbe, boundary: managedBoundary,
    replacement: { armed: armReceipt, armReceiptSha256: armHash, boundary: managedBoundary, custody: managedCustody,
      writeIntentSha256: hash(raw(managedCustody)) } };
}

test("managed write custody joins the exact source catalog reference and complete pinned counts", async () => {
  const selected = managedReplacementFixture(), fixture = host({ replacement: selected.replacement });
  let reachedCustody = false;
  await assert.rejects(exchangeFrontendReplacementWrite(fixture.child, selected.initial, selected.plan, async operator => {
    await operator.armReplacement(selected.probe);
    const receipt = await operator.authorizeReplacementWrite(selected.boundary);
    assert.deepEqual(receipt, { receipt: selected.replacement.custody, writeIntentSha256: selected.replacement.writeIntentSha256 });
    reachedCustody = true;
  }, { readHostEvidence: fixture.readHostEvidence }), refusal);
  assert.equal(reachedCustody, true);
  assert.equal(fixture.reaped(), true);

  for (const drift of [
    { managedCatalog: { ...selected.boundary.managedCatalog, sha256: "8".repeat(64) } },
    { catalogCounts: {} },
    { catalogCounts: { ...selected.boundary.catalogCounts, pg_default_acl: 0 } },
    { catalogCounts: { ...selected.boundary.catalogCounts, invented: 0 } },
    { zeroCatalogCounts: { pg_class: 0 } },
    { catalogScope: boundary.catalogScope },
    { observedAt: "2026-02-30T19:45:00.123Z" },
  ]) {
    const rejected = host({ replacement: selected.replacement });
    await assert.rejects(exchangeFrontendReplacementWrite(rejected.child, selected.initial, selected.plan, async operator => {
      await operator.armReplacement(selected.probe);
      await operator.authorizeReplacementWrite({ ...selected.boundary, ...drift });
    }, { readHostEvidence: rejected.readHostEvidence }), refusal);
    assert.equal(rejected.calls.some(({ operation }) => operation === "authorize-replacement-write"), false);
    assert.equal(rejected.reaped(), true);
  }
});

test("write transport refuses mismatched, duplicate or overlong host evidence", async () => {
  for (const mutate of [
    value => value.id === 0 ? '{"id":0,"id":0,"status":"LOCKED"}\n' : value,
    value => value.id === 0 ? JSON.stringify(value) + "\n" + JSON.stringify(value) + "\n" : value,
    value => value.id === 0 ? "x".repeat(4096) : value,
    value => value.status === "REPLACEMENT_ARMED" ? { ...value, armReceiptSha256: "1".repeat(64) } : value,
    value => value.status === "REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED" ? { ...value, receipt: { ...value.receipt, migrationAuthorized: true } } : value,
    value => value.status === "REPLACEMENT_WRITTEN_VERIFIED" ? { ...value, postflightSha256: "1".repeat(64) } : value,
    value => value.status === "REPLACEMENT_API_RUNTIME_READY" ? { ...value, migrationOutcomeSha256: value.runtimeOutcomeSha256 } : value,
  ]) {
    const fixture = host({ mutate });
    await assert.rejects(exchange(fixture, toRuntime), refusal);
    assert.equal(fixture.reaped(), true);
  }
  const fixture = host({ alterEvidence: (name, bytes) => name === "runtime-outcome.json" ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes });
  await assert.rejects(exchange(fixture, toRuntime), refusal);
  assert.equal(fixture.reaped(), true);
});

test("write transport refuses early stages and optional runtime without review", async () => {
  const early = host();
  await assert.rejects(exchange(early, operator => operator.authorizeReplacementWrite(boundary)), refusal);
  assert.deepEqual(early.calls.map(call => call.operation), ["initial", "check"]);
  const unreviewed = host();
  await assert.rejects(exchange(unreviewed, async operator => {
    await operator.armReplacement(probe);
    await operator.authorizeReplacementWrite(boundary);
    await operator.verifyReplacementWritten(writtenInput);
    await operator.startReplacementRuntime();
  }, noReview), refusal);
  assert.equal(unreviewed.calls.some(call => call.operation === "start-replacement-runtime"), false);
});

test("host loss cancels the task and reaps even if the callback remains pending", async () => {
  const fixture = host();
  let signal;
  await assert.rejects(exchange(fixture, operator => {
    signal = operator.signal;
    fixture.close(1, null);
    return new Promise(() => {});
  }), refusal);
  assert.equal(signal.aborted, true);
  assert.equal(fixture.reaped(), true);
});

async function toJoined(operator) {
  await toRuntime(operator);
  return joinReplacement(operator);
}

async function joinReplacement(operator) {
  assert.deepEqual(await operator.verifyReplacementFrontend({ proof: raw(proof), workload: raw(workload), promotion: raw(promotion) }),
    { receipt: proof, bytes: raw(proof), proofSha256 });
  await operator.prepareReplacementClose();
  assert.deepEqual(await operator.observeReplacementClosed(), { receipt: closedReceipt, bytes: raw(closedReceipt), sessionClosedSha256 });
  assert.deepEqual(await operator.finishReplacement({ terminal: raw(terminal), continuationCompleted: raw(continuationCompleted),
    releaseOutcome: raw(releaseOutcome) }), { receipt: commitIntent, bytes: raw(commitIntent), commitIntentSha256 });
  return "owned-joined";
}

test("write transport publishes a matching terminal only after host reap", async () => {
  const fixture = host({ exit: 0, alterEvidence(name, bytes) {
    if (name === "p2-frontend-replacement-write-outcome.json") assert.equal(fixture.reaped(), true);
    return bytes;
  } });
  assert.deepEqual(await exchange(fixture, toJoined, providerInitial),
    { result: "owned-joined", receipt: writeOutcome, bytes: raw(writeOutcome), commitIntentSha256 });
  assert.deepEqual(fixture.calls.map(call => call.operation).slice(-5),
    ["verify-replacement-frontend", "prepare-replacement-close", "observe-replacement-closed", "finish-replacement", "commit"]);
  for (const [operation, originals] of [["verify-replacement-frontend", { proof, workload, promotion }],
    ["finish-replacement", { terminal, continuationCompleted, releaseOutcome }]]) {
    const { packet } = fixture.calls.find(call => call.operation === operation);
    for (const [key, record] of Object.entries(originals)) assert.equal(packet[key], raw(record).toString("base64"));
  }
});

test("late uncertain exit, wrong commit digest and altered terminal refuse success", async () => {
  for (const options of [
    { exit: 1 },
    { mutate: response => response.status === "COMMITTED" ? { ...response, commitIntentSha256: "1".repeat(64) } : response },
    { alterEvidence: (name, bytes) => name === "p2-frontend-replacement-write-outcome.json" ? raw({ ...writeOutcome, trafficAuthorized: true }) : bytes },
  ]) {
    const fixture = host({ exit: 0, ...options });
    await assert.rejects(exchange(fixture, toJoined, providerInitial), refusal);
    assert.equal(fixture.reaped(), true);
  }
});

test("recovery joins original committed bytes using independently verified fresh lock evidence", async () => {
  const fixture = host({ exit: 0 });
  const result = await exchangeRecovery(fixture, async operator => {
    for (const key of ["armReplacement", "authorizeReplacementWrite", "verifyReplacementWritten"]) assert.equal(operator[key], undefined);
    const resumed = await operator.resumeReplacementWritten(freshProbe);
    assert.deepEqual(resumed, { receipt: written, bytes: retained.writtenObservation, postflightSha256 });
    await operator.startReplacementRuntime();
    return joinReplacement(operator);
  });
  assert.deepEqual(result, { result: "owned-joined", receipt: writeOutcome, bytes: raw(writeOutcome), commitIntentSha256 });
  assert.deepEqual(fixture.calls.map(call => call.operation).filter(operation => operation !== "check"), ["initial",
    "resume-replacement-written", "start-replacement-runtime", "verify-replacement-frontend", "prepare-replacement-close",
    "observe-replacement-closed", "finish-replacement", "commit"]);
  const request = fixture.calls.find(call => call.operation === "resume-replacement-written").packet;
  assert.deepEqual(request, { id: request.id, operation: "resume-replacement-written", probe: freshProbe });
});

test("recovery refuses unreviewed input or reuse of the original result path before a host command", async () => {
  for (const [input, recovery] of [
    [recoveryInitial(), { ...retained, databaseReceipt: raw({ status: "DATABASE_VERIFIED", after: [1] }) }],
    [{ ...recoveryInitial(), results: originalDirectory }, retained],
    [recoveryInitial({ ...recoveryReview, originalEvidenceSha256: { ...recoveryReview.originalEvidenceSha256, abortObservation: undefined } }), retained],
  ]) {
    const fixture = host();
    await assert.rejects(exchangeRecovery(fixture, () => assert.fail("Host should not start"), input, recovery), refusal);
    assert.deepEqual(fixture.calls, []);
  }
});

test("recovery refuses an old backend, mismatched fresh evidence or a rewritten original observation", async () => {
  for (const [candidate, alterEvidence] of [
    [{ ...freshProbe, backendPid: probe.backendPid }],
    [freshProbe, (name, bytes) => name.includes("recovery-physical-observation") ? physicalBytes : bytes],
    [freshProbe, (name, bytes) => name.includes("replacement-written-observation") ? raw({ ...written, ...freshIdentity }) : bytes],
  ]) {
    const fixture = host({ alterEvidence });
    await assert.rejects(exchangeRecovery(fixture, async operator => {
      await operator.resumeReplacementWritten(candidate);
      assert.fail("Invalid recovery must not reach runtime");
    }), refusal);
    assert.equal(fixture.calls.some(call => call.operation === "start-replacement-runtime"), false);
  }
});
