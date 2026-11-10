import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { frontendCoordinationHash } from "./frontend-release-inventory.mjs";
import { P2_CERTIFICATION_READY_FILES } from "./p2-certification.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { bindP2ManagedIdentityRotationPlan, p2IdentityRotationOperator, prepareP2ManagedIdentityRotationDispatch } from "./p2-identity-key-rotation-operator.mjs";
import { prepareP2IdentityRotationReplacementLease, readP2IdentityRotationReplacementCustody,
  readP2IdentityRotationReplacementHostReview, withP2IdentityRotationReplacementLease } from "./p2-identity-key-rotation-replacement.mjs";
import { runP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";
import { recordP2IdentityRotationBrowserReads } from "./p2-identity-key-rotation-browser-recorder.mjs";
import { runIdentityKeyRotationController } from "./p2-identity-key-rotation-controller.mjs";
import { P2_IDENTITY_ROTATION_SERVICES } from "./p2-identity-key-rotation-observer.mjs";
import { readProfiledCurrentOperatorSourceFiles } from "./recreation_source.mjs";

const base = { version: 2, qualificationTargetProfile: profile, environment: "staging" };
const pin = value => value.repeat(64);
const raw = value => Buffer.from(JSON.stringify(value) + "\n");
const proofRefusal = { message: "P2_IDENTITY_ROTATION_REPLACEMENT_CUSTODY_REFUSED" };
const sourceFiles = ["ops/platform/p2-certification-current-probe.mjs", "ops/platform/p2-identity-key-rotation-replacement.mjs"].map(path =>
  ({ path, sha256: p2NativeHash(path), data: Buffer.from(path).toString("base64") }));
const sourceClosureSha256 = p2NativeHash(JSON.stringify(sourceFiles.map(({ path, sha256 }) => [path, sha256])));

function managedFixture(t, owned) {
  const f = fixture(t, owned);
  const lease = f.load({ ...f.settings, custody: { ...f.settings.custody,
    authenticationWindows: ["overlap", "current-only", "post-removal"] } });
  const path = owned ? join(owned.hostRoot, "rotation") : "/var/lib/lash-her/releases/staging/owned/rotation";
  const phases = ["baseline", "overlap", "current-only"];
  const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const rotation = { actionId: lease.plan.actionId, courseId: uuid("1"),
    subjects: { "course-learner": uuid("2"), "course-admin": uuid("3"), "community-member": uuid("4"), "community-admin": uuid("5") },
    configuration: Object.fromEntries(phases.map((phase, index) => [phase, { privateRef: join(path, phase), sha256: pin("abc"[index]) }])),
    privateConfigurationSha256: Object.fromEntries(phases.map((phase, index) => [phase, pin("def"[index])])) };
  return { f, lease, path, rotation };
}

test("managed operator plan pins the reviewed lease, phases, actors and exact local source while apply stays gated", async t => {
  const { f, lease, path, rotation } = managedFixture(t);
  const { plan, hostReview } = bindP2ManagedIdentityRotationPlan(lease, sourceFiles, path, rotation);
  assert.equal(plan.frontendCustodyPlanSha256, hostReview.certificationPlan.planSha256);
  assert.equal(plan.operatorSourceClosureSha256, sourceClosureSha256);
  assert.equal(plan.finalEpoch, "9007199254740999");
  assert.equal(plan.liveEligible, false);
  assert.equal(Object.isFrozen(plan.configuration.baseline), true);
  assert.equal(Object.hasOwn(plan, "privateConfigurationSha256"), false);
  assert.throws(() => bindP2ManagedIdentityRotationPlan(lease, sourceFiles, path,
    { ...rotation, subjects: { ...rotation.subjects, "course-admin": rotation.subjects["course-learner"] } }));
  assert.throws(() => bindP2ManagedIdentityRotationPlan(lease, sourceFiles, path + "/other", rotation));
  assert.throws(() => bindP2ManagedIdentityRotationPlan(f.load(), sourceFiles, path, rotation));
  await assert.rejects(() => p2IdentityRotationOperator({ version: 2 }, { apply: true }),
    { message: "P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED" });
});

function fixture(t, owned) {
  const results = realpathSync(mkdtempSync(join(tmpdir(), "p2-rotation-replacement-lease-")));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const prepared = owned?.postgres.selected.prepared;
  const physical = prepared?.migration;
  const releaseId = physical?.job.releaseId ?? "owned-replacement-release", sourceCommit = physical?.job.sourceCommit ?? "a".repeat(40);
  const targetSha256 = prepared?.plan.targetSha256 ?? pin("3");
  const phase2ContractManifestSha256 = physical?.job.phase2ContractManifestSha256 ?? "sha256:" + pin("b");
  const projectId = "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM";
  const candidate = { ...base, version: 3, releaseId, phase2ContractManifestSha256,
    sources: { frontend: { commit: sourceCommit } }, ...physical?.candidate, workload: { projectId } };
  if (owned) {
    candidate.workload = { projectId, environment: "production", qualificationTargetProfile: profile };
    candidate.sources = Object.fromEntries(["frontend", "course", "community"].map(service => [service, {
      commit: sourceCommit, ...candidate.sources[service], qualificationTargetProfile: profile,
    }]));
    for (const key of ["integration", "sourceApproval", "approval"]) {
      candidate[key] = { ...candidate[key], qualificationTargetProfile: profile };
    }
    candidate.artifacts = { ...candidate.artifacts, ...owned.artifacts };
    candidate.runtime = { composeSha256: owned.composeSha256 };
  }
  const candidateBytes = raw(candidate), candidateSha256 = p2NativeHash(candidateBytes);
  const target = physical?.job.target ?? { qualificationTargetProfile: profile, host: "owned-neon.invalid", port: 5432, database: "owned_frontend",
    user: "owned_migration", serverMajor: 16, runtimeRole: "owned_runtime" };
  const job = physical?.job ?? { ...base, releaseId, sourceCommit, target, phase2ContractManifestSha256 };
  const owner = prepared?.plan.owner ?? { name: "owned_owner", oid: "103" };
  const runtime = prepared?.plan.producers[0].role ?? { name: target.runtimeRole, oid: "104" };
  const producer = prepared?.plan.producers[0] ?? { producerSha256: pin("4"), role: runtime };
  const replacementRelease = prepared?.plan.replacementRelease ?? { version: 1, kind: "frontend-replacement", qualificationTargetProfile: profile,
    reviewedPlanSha256: pin("1"), runtimeReviewSha256: pin("2"), postflightSha256: pin("5"),
    frontendSessionClosedSha256: pin("6"), frontendDatabaseReceiptSha256: pin("7"),
    databaseOid: "101", migrationRoleOid: "102", predecessorRuntimeRole: "owned_previous", administrativeLogins: [] };
  const hostRoot = owned?.hostRoot ?? "/var/lib/lash-her/releases/staging/owned";
  const hostResults = join(hostRoot, "results");
  const host = { machineId: owned?.hostMachineId ?? "c".repeat(32), bundle: join(hostRoot, "bundle"), results: hostResults,
    configuration: join(hostResults, `runtime-profiled-frontend-replacement-${releaseId}`, "configuration") };
  const certification = owned ? P2_CERTIFICATION_PROFILE : { featureControls: { CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED: true } };
  const { featureControls } = certification;
  const writerAdmissionBinding = { mode: "enforce", targetSha256, producerSha256: producer.producerSha256,
    sourceCommit, roleName: runtime.name };
  const configurationSha256 = owned?.configurationSha256 ?? { "runtime.json": pin("8"), "gateway.json": pin("9") };
  const apiJobSha256 = { course: pin("a"), community: pin("b") };
  const frontendReceipts = join(results, "vercel");
  mkdirSync(frontendReceipts, { mode: 0o700 });
  const deploymentId = "dpl_Owned", previousDeploymentId = "dpl_Prior";
  const identity = { ...base, releaseId, sourceCommit, projectId, previousDeploymentId, trafficAuthorized: false };
  const provider = { ...identity, deploymentId };
  const documents = [
    { ...identity, status: "FRONTEND_BUILD_STARTED", promotionAuthorized: false },
    { ...provider, status: "FRONTEND_BUILD_CREATED", promotionAuthorized: false },
    { ...provider, status: "FRONTEND_STAGED", promotionAuthorized: false, readyState: "READY",
      phase: "completed", url: "https://owned.vercel.app" },
    { ...provider, status: "FRONTEND_VERIFIED", phase: "completed", contractPhase: "p2", phase2ContractManifestSha256,
      nativeSchedulerVerified: false, featureControls, writerAdmissionBinding, checks: ["frontend-server-gateway-course-catalog-p2"] },
    { ...provider, status: "FRONTEND_PROMOTION_STARTED", previousAliasRequestedAt: 1 },
    { ...provider, status: "FRONTEND_DOMAINS_PROMOTED", phase: "completed", previousAliasRequestedAt: 1, aliasRequestedAt: 2,
      frontendDomainsPromoted: true, gatewayTrafficAuthorized: false },
  ];
  const records = Object.fromEntries(P2_CERTIFICATION_READY_FILES.map((name, index) => {
    const bytes = raw(documents[index]);
    writeFileSync(join(frontendReceipts, name), bytes, { mode: 0o600 });
    return [name, bytes];
  }));
  const originalReleaseReceipt = raw({ ...base, status: "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION",
    releaseId, sourceCommit, candidateSha256, targetSha256, deploymentId, owner, runtime, producerSha256: producer.producerSha256,
    reviewedPlanSha256: replacementRelease.reviewedPlanSha256,
    ...(owned && { runtimeReviewSha256: replacementRelease.runtimeReviewSha256, postflightSha256: replacementRelease.postflightSha256,
      frontendSessionClosedSha256: replacementRelease.frontendSessionClosedSha256,
      frontendDatabaseReceiptSha256: replacementRelease.frontendDatabaseReceiptSha256,
      frontendSqlApplied: true, frontendSqlReplayed: false, frontendSessionClosed: true }),
    frontendWorkloadReceiptSha256: p2NativeHash(records["frontend-workload-outcome.json"]),
    frontendPromotionReceiptSha256: p2NativeHash(records["frontend-promotion-outcome.json"]) });
  const profiledRelease = { replacementRelease, receiptSha256: p2NativeHash(originalReleaseReceipt),
    planSha256: replacementRelease.reviewedPlanSha256, configurationDirectory: host.configuration, apiJobSha256 };
  const inventory = { ...base, actionId: releaseId, sourceCommit, targetSha256, owner, producers: [producer], replacementRelease };
  const original = { plan: { ...base, releaseId, sourceCommit, candidateSha256, targetSha256, configurationSha256,
    phase2ContractManifestSha256, apiJobSha256, inventorySha256: frontendCoordinationHash(inventory), writerAdmissionBinding,
    certification }, inventory, migration: { ...physical, candidate, job, baseline: physical?.baseline ?? { version: 1 } } };
  const loaded = { original, profiledRelease, host, frontendReceipts, originalReleaseReceipt, candidateBytes };
  const settings = { ...base, operatorSourceCommit: sourceCommit,
    releaseSettings: { arm: { results, knownHosts: join(results, "fixture-known-hosts"), sshKey: join(results, "fixture-ssh-key") } },
    replacementRelease: { terminalFile: join(results, "owned-terminal.json"), terminalSha256: profiledRelease.receiptSha256 },
    custody: { actionId: "p2-key-rotation-owned", initialEpoch: owned?.postgres.selected.plan.initialEpoch ?? "9007199254740993",
      runtimeInventorySha256: owned?.runtimeInventorySha256 ?? pin("d"), gatewayProcessSha256: pin("e"),
      operatorSourceClosureSha256: owned?.sourceClosureSha256 ?? sourceClosureSha256 } };
  const load = (value = settings) => prepareP2IdentityRotationReplacementLease(value, { fixture: true,
    readReplacement(releaseSettings, selection) {
      assert.equal(releaseSettings, settings.releaseSettings);
      assert.equal(selection, settings.replacementRelease);
      return loaded;
    } });
  const successor = kind => {
    const interrupted = kind === "interrupted-known-ack";
    const actionId = interrupted ? "owned-interrupted" : "owned-known-ack";
    const runtimeActionId = interrupted ? actionId : "owned-runtime-action";
    const bytes = raw({ ...base, status: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED", kind, actionId, runtimeActionId,
      releaseId, sourceCommit, candidateSha256, targetSha256, hostMachineId: host.machineId,
      configurationCanonicalSha256: p2NativeHash(configurationSha256), replacementRelease,
      originalReleaseReceiptSha256: profiledRelease.receiptSha256, originalReleasePlanSha256: profiledRelease.planSha256,
      terminalSha256: pin("f"), runtimeReceiptSha256: pin(interrupted ? "f" : "c"), frontendSessionClosedSha256: pin("6"),
      frontendEpoch: settings.custody.initialEpoch, runtimeInventorySha256: settings.custody.runtimeInventorySha256,
      gatewayProcessSha256: settings.custody.gatewayProcessSha256 });
    const directory = join(results, actionId);
    mkdirSync(directory, { mode: 0o700 });
    const receiptFile = join(directory, "p2-replacement-successor-runtime.json");
    writeFileSync(receiptFile, bytes, { mode: 0o600 });
    return { selection: { receiptFile, receiptSha256: p2NativeHash(bytes) }, bytes, actionId, runtimeActionId };
  };
  return { settings, load, loaded, records, successor };
}

test("replacement custody composes exact profiled host packet and retains the original promotion and API job pins", t => {
  const f = fixture(t);
  const lease = f.load(), { plan, host } = lease;
  assert.equal(plan.frontendPlan.mode, "contain-native");
  assert.deepEqual(plan.frontendPlan.nativePlan.commandWitnesses, []);
  assert.equal(plan.finalEpoch, plan.initialEpoch);
  assert.equal(plan.liveEligible, false);
  assert(Object.isFrozen(plan.frontendPlan.nativePlan.producer.role));
  assert.equal(host.configuration, f.loaded.host.configuration);
  const retained = readP2IdentityRotationReplacementCustody(lease);
  assert.deepEqual(Buffer.from(retained.originalReleaseReceipt, "base64"), f.loaded.originalReleaseReceipt);
  assert.deepEqual(Buffer.from(retained.readyReceipts["frontend-promotion-outcome.json"], "base64"),
    f.records["frontend-promotion-outcome.json"]);
  const review = readP2IdentityRotationReplacementHostReview(lease, sourceFiles);
  assert.equal(review.certificationActionId, plan.actionId);
  assert.deepEqual(review.certificationPlan, plan.frontendPlan);
  assert.deepEqual(review.apiJobSha256, f.loaded.profiledRelease.apiJobSha256);
  assert.equal(review.sourceClosureSha256, sourceClosureSha256);
  assert.equal(Object.hasOwn(review, "credentials"), false);
  assert.throws(() => readP2IdentityRotationReplacementCustody(structuredClone(lease)), proofRefusal);
  assert.throws(() => readP2IdentityRotationReplacementHostReview(lease,
    [{ ...sourceFiles[0], data: Buffer.from("different source").toString("base64") }, sourceFiles[1]]), proofRefusal);
  assert.throws(() => f.load({ ...f.settings, operatorSourceCommit: "b".repeat(40) }), proofRefusal);
  writeFileSync(join(f.loaded.frontendReceipts, "frontend-promotion-outcome.json"), "{}");
  assert.throws(() => f.load(), proofRefusal);
});

test("both exact successor kinds select the retained active mount and reject stale epoch and wrong runtime pins", t => {
  const f = fixture(t);
  for (const kind of ["known-ack", "interrupted-known-ack"]) {
    const { selection, bytes, actionId, runtimeActionId } = f.successor(kind);
    const settings = { ...f.settings, successorRuntime: selection };
    const lease = f.load(settings);
    assert.deepEqual(lease.plan.frontendPlan.successorRuntime, { kind, actionId, runtimeActionId, receiptSha256: selection.receiptSha256 });
    assert.deepEqual(Buffer.from(readP2IdentityRotationReplacementCustody(lease).successorReceipt, "base64"), bytes);
    const expected = kind === "known-ack"
      ? `/var/lib/lash-her/releases/staging/p2-profiled-known-ack-${runtimeActionId}/runtime-known-ack/configuration`
      : join(f.loaded.host.results, `p2-profiled-known-ack-restoration-${actionId}`, "runtime-interrupted", "configuration");
    assert.equal(lease.host.configuration, expected);
    for (const changed of [{ initialEpoch: "1" }, { gatewayProcessSha256: pin("f") }]) {
      assert.throws(() => f.load({ ...settings, custody: { ...settings.custody, ...changed } }),
        { message: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_REFUSED" });
    }
  }
});

function observerFixture(lease, alter = proof => proof) {
  const { frontendPlan, initialEpoch } = lease.plan;
  const { replacementRelease, nativePlan } = frontendPlan;
  const observationCalls = [], statements = [];
  const journalSha256 = pin("c"), initialWitness = pin("d");
  let held = false, currentEpoch = initialEpoch, currentWitness = initialWitness;
  const closedAdmission = () => ({ epoch: currentEpoch, newWork: false, recovery: false, active: 0, uncertain: 0 });
  const dependencies = { getUrl: () => { throw new Error("fixture must not read credentials"); },
    verifyEnvironment: async () => {} };
  const options = {
    fixture: true,
    withSession: async (prepared, plan, _deps, task, expectedProfile) => {
      assert.equal(plan, frontendPlan);
      assert.equal(expectedProfile, profile);
      const { migration: { job, baseline }, plan: { owner, producers } } = prepared;
      const receipt = { ...base, status: "P2_CERTIFICATION_DATABASE_CURRENT", releaseId: plan.originalReleaseId,
        sourceCommit: plan.sourceCommit, certificationActionId: plan.certificationActionId, candidateSha256: plan.candidateSha256,
        targetSha256: plan.targetSha256, planSha256: plan.planSha256, target: job.target,
        schemaVerified: true, runtimeRoleVerified: true, sqlReplayed: false, trafficAuthorized: false,
        replacementRelease, effectiveLoginBoundaryVerified: true, predecessorRuntimeRoleAbsent: true,
        admission: closedAdmission(), journalSha256, witnessSha256: currentWitness };
      const probe = { version: 2, qualificationTargetProfile: profile, marker: pin("b"), backendPid: 18,
        backendStart: "2026-11-09T14:00:00.000001Z", job, baseline, owner, producers, replacementRelease, plan, receipt };
      const client = { query: async (sql, parameters) => {
        statements.push(sql);
        if (sql.startsWith("SELECT")) {
          assert.deepEqual(parameters, [nativePlan.owner.name]);
          return { rows: [{ oid: nativePlan.owner.oid }] };
        }
        return { rows: [] };
      } };
      held = true;
      try { return await task({ client, probe, receipt, verify: async () => assert.equal(held, true) }); }
      finally { held = false; }
    },
    observePhysical: async probe => {
      const closing = probe.operation === "verify-closed";
      assert.equal(held, !closing);
      observationCalls.push([probe.operation, currentEpoch]);
      const { sourceCommit, releaseId, targetSha256 } = probe.receipt;
      return alter({ ...base, status: closing ? "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED" : "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED",
        marker: probe.marker, backendPid: probe.backendPid, backendStart: probe.backendStart, sourceCommit, releaseId, targetSha256,
        admission: closedAdmission(), journalSha256, witnessSha256: currentWitness, replacementRelease,
        effectiveLoginBoundaryVerified: true, predecessorRuntimeRoleAbsent: true,
        ...(closing ? { backendAbsent: true, migrationLockReleased: true, nonceLockReleased: true } : {}) });
    },
  };
  return { options, dependencies, observationCalls, statements,
    advance(value) { currentEpoch = value; currentWitness = pin("e"); } };
}

test("owned lease proves direct closed state, owner reset, and independent closure after both locks leave", async t => {
  const { load } = fixture(t), lease = load();
  const f = observerFixture(lease);
  let retained;
  const result = await withP2IdentityRotationReplacementLease(lease, f.dependencies, async scope => {
    retained = scope;
    assert.equal(scope.initial.admission.epoch, lease.plan.initialEpoch);
    await scope.withOwner(async client => {
      assert.equal(client, scope.client);
      await assert.rejects(scope.verify, proofRefusal);
    });
    return "owned-result";
  }, f.options);
  assert.equal(result.result, "owned-result");
  assert.equal(result.frontendSessionClosed.migrationLockReleased, true);
  assert.equal(result.frontendSessionClosed.nonceLockReleased, true);
  assert.equal(result.frontendSessionClosedSha256, p2NativeHash(result.frontendSessionClosed));
  assert.deepEqual(f.observationCalls.map(row => row[0]), ["observe", "observe", "verify-closed"]);
  assert.deepEqual(f.statements.slice(-2), ['SET ROLE "owned_owner"', "RESET ROLE"]);
  await assert.rejects(retained.verify, proofRefusal);
  await assert.rejects(withP2IdentityRotationReplacementLease(lease, f.dependencies, () => assert.fail("live task ran")),
    { message: "P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED" });
});

test("reviewed writer windows derive exact epochs and closure refuses role, journal, final witness or lock drift", async t => {
  const f = fixture(t);
  const custody = { ...f.settings.custody, authenticationWindows: ["overlap", "current-only", "post-removal"] };
  const lease = f.load({ ...f.settings, custody });
  assert.equal(lease.plan.finalEpoch, "9007199254740999");
  assert.deepEqual(lease.plan.authenticationWindows.map(window => window.closedEpoch),
    ["9007199254740995", "9007199254740997", "9007199254740999"]);
  for (const authenticationWindows of [null, ["current-only"]]) {
    assert.throws(() => f.load({ ...f.settings, custody: { ...custody, authenticationWindows } }), proofRefusal);
  }
  assert.throws(() => f.load({ ...f.settings, custody: { ...custody, initialEpoch: "999999999999999998" } }), proofRefusal);
  for (const drift of [null, { effectiveLoginBoundaryVerified: false }, { journalSha256: pin("f") },
    { witnessSha256: pin("f") }, { nonceLockReleased: false }, { backendAbsent: false }]) {
    const execution = observerFixture(lease, proof => drift && proof.backendAbsent ? { ...proof, ...drift } : proof);
    const run = withP2IdentityRotationReplacementLease(lease, execution.dependencies, async scope => {
      for (const window of lease.plan.authenticationWindows) {
        assert.equal((await scope.observeClosed(window.phase, "before")).admission.epoch, window.beforeEpoch);
        execution.advance(window.closedEpoch);
        assert.equal((await scope.observeClosed(window.phase, "after")).admission.epoch, window.closedEpoch);
      }
    }, execution.options);
    if (drift) await assert.rejects(run, proofRefusal);
    else assert.equal((await run).frontendSessionClosed.admission.epoch, lease.plan.finalEpoch);
  }
  const wrong = observerFixture(lease);
  await assert.rejects(withP2IdentityRotationReplacementLease(lease, wrong.dependencies, () => {}, wrong.options), proofRefusal);
  assert.equal(wrong.observationCalls.some(([operation]) => operation === "verify-closed"), false);
});

function ownedChannel(handle) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.stdin.end(); };
  const lines = createInterface({ input: child.stdin });
  lines.on("line", rawPacket => {
    try {
      const reply = handle(JSON.parse(rawPacket));
      child.stdout.write(JSON.stringify(reply) + "\n");
    } catch (error) {
      child.emit("error", error);
      child.stdin.end();
    }
  });
  child.stdin.on("end", () => {
    child.stdout.end(); child.stderr.end();
    setImmediate(() => { child.emit("exit", 0); child.emit("close", 0); });
  });
  return child;
}

test("managed source dispatch joins the actual controller, fixed wire, reviewed +6 epoch and independent closure", async t => {
  const { lease, path, rotation } = managedFixture(t);
  const selected = bindP2ManagedIdentityRotationPlan(lease, sourceFiles, path, rotation);
  let hostStarted = false, runtime = "baseline", frontend = "baseline", clock = Math.floor(Date.now() / 1000) * 1000;
  let captures, prepared, joined, armedProbe, observedClosure;
  const steps = [], signerPhases = [];
  const candidate = observerFixture(lease);
  const names = ["community-admin", "community-member", "course-admin", "course-learner"];
  const configuration = selected.plan.configuration;
  const containers = P2_IDENTITY_ROTATION_SERVICES.map((service, index) => ({ service,
    containerId: (index + 1).toString(16).padStart(64, "0"),
    image: `ghcr.io/princessdardan/lash-her-platform-${service}@sha256:${pin("a")}` }));
  const privateInputs = {
    credentials: { FRONTEND_STAGING_MIGRATION_DATABASE_URL: "owned-db-private-fixture",
      COURSE_STAGING_DATABASE_URL: "owned-course-private-fixture", COMMUNITY_STAGING_DATABASE_URL: "owned-community-private-fixture" },
    vercelToken: "owned-vercel-private-fixture", scopedCronSecret: "owned-cron-private-fixture".repeat(2),
    gatewayHost: new URL(resolveQualificationTargetProfile(profile).gateway.publicOrigin).hostname,
    operatorProgramSha256: pin("a"), rotationBrowserProgramSha256: pin("b"),
  };
  const confirmation = `staging/${selected.plan.actionId}`;
  const fixtureTransport = { fixture: true, openOwnedChannel: () => ownedChannel(packet => {
    if (!hostStarted) {
      hostStarted = true;
      assert.equal(packet.version, 2);
      assert.deepEqual(packet.rotationPlan, selected.plan);
      assert.deepEqual(packet.frontendCustody, selected.hostReview);
      assert.deepEqual(packet.nativePlan, selected.hostReview.certificationPlan.nativePlan);
      assert.deepEqual(packet.privateRotationConfigurationSha256, rotation.privateConfigurationSha256);
      assert.deepEqual(packet.credentials, privateInputs.credentials);
      assert.equal(packet.confirmation, confirmation);
      assert.equal(Object.hasOwn(packet, "privateProbe"), false);
      assert.equal(Object.hasOwn(packet, "historicalLogins"), false);
      const host = fileURLToPath(new URL("./host", import.meta.url));
      const validator = "import json,sys;sys.path.insert(0,sys.argv[1]);from p2_identity_rotation_replacement import validate_managed_rotation_initial;validate_managed_rotation_initial(json.load(sys.stdin));print('accepted')";
      assert.equal(execFileSync("python3", ["-I", "-B", "-c", validator, host], {
        input: JSON.stringify(packet), encoding: "utf8", timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(), "accepted");
      return { id: 0, status: "LOCKED" };
    }
    const { id, operation } = packet;
    const reply = (status, receipt) => ({ id, status, ...(receipt ? { receipt } : {}) });
    if (operation === "check") return reply("HELD");
    if (operation === "rotation-arm") {
      assert.equal(packet.probe.version, 2);
      assert.deepEqual(JSON.parse(Buffer.from(packet.receipt, "base64")), packet.probe.receipt);
      assert.equal(packet.probe.plan.planSha256, selected.plan.frontendCustodyPlanSha256);
      armedProbe = packet.probe;
      const { actionId, bindingSha256, sourceCommit, candidateSha256 } = selected.plan;
      return reply("ROTATION_ARMED", { ...base, status: "P2_IDENTITY_ROTATION_PARENT_ARMED", actionId, bindingSha256,
        sourceCommit, candidateSha256, trafficAuthorized: false });
    }
    assert.ok(armedProbe);
    if (operation === "rotation-observe-runtime") return reply("ROTATION_OBSERVED", {
      configurationSha256: configuration[runtime].sha256, nativeSchedulesEnabled: false, businessSchedulesEnabled: false,
      containers, courseCurrent: true, communityCurrent: true, boundaryChecks: ["private-application-credential-required",
        "private-community-peer-denied", "private-course-tls-catalog", "public-metrics-hidden", "public-tls-missing-workload-denied"],
    });
    if (operation === "rotation-observe-frontend") return reply("ROTATION_OBSERVED", {
      configurationSha256: configuration[frontend].sha256, cronsEnabled: false, aliasJobActive: false, deploymentId: "dpl_Owned",
    });
    if (operation === "rotation-apply-mutation") {
      const { actionId, phase, kind, fromConfigurationSha256, toConfigurationSha256 } = packet.intent;
      steps.push(`${phase}:${kind}`);
      if (kind === "api") runtime = phase;
      else frontend = phase;
      return reply("ROTATION_MUTATION", { version: 1, status: "P2_IDENTITY_ROTATION_MUTATION_QUALIFIED", actionId, phase, kind,
        fromConfigurationSha256, toConfigurationSha256, mutationCount: 1, getFirstReconciled: false,
        runtimeVerified: true, sqlExecuted: false, rolesPrepared: false, loginChanged: false });
    }
    if (operation === "rotation-capture") {
      assert.deepEqual([runtime, frontend], ["overlap", "current-only"]);
      captures = names.map(profile => ({ status: "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", profile,
        tokenIssuedAt: new Date(clock).toISOString(), tokenExpiresAt: new Date(clock + 300_000).toISOString() }));
      return reply("ROTATION_CAPTURED", captures);
    }
    if (operation === "rotation-observe-profiles") return reply("ROTATION_PROFILES_OBSERVED", captures.map(row => ({
      profile: row.profile, phase: packet.phase, status: "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED",
      retainedTokenContinuityVerified: true, releaseAccepted: false, oldResult: packet.phase === "overlap" ? "accepted" : "rejected",
      newResult: "accepted", observedAt: new Date(clock).toISOString(), oldTokenIssuedAt: row.tokenIssuedAt, oldTokenExpiresAt: row.tokenExpiresAt,
    })));
    if (operation === "rotation-prepare-close") {
      assert.equal(packet.outcome.version, 1);
      assert.equal(packet.outcome.postRemovalFrontendSignerReceiptSha256, p2NativeHash("post-removal"));
      assert.equal(candidate.observationCalls.some(([kind]) => kind === "verify-closed"), false);
      const { actionId, bindingSha256, sourceCommit, candidateSha256, finalEpoch, frontendCustodyPlanSha256 } = selected.plan;
      prepared = { ...base, status: "P2_IDENTITY_KEY_ROTATION_CLOSE_PREPARED", actionId, bindingSha256,
        sourceCommit, candidateSha256, frontendFinalEpoch: finalEpoch, frontendCustodyPlanSha256, keyRemovalVerified: false,
        sqlExecuted: false, rolesPrepared: false, loginChanged: false, trafficAuthorized: false,
        tokenBytesOutput: false, credentialHashesOutput: false, communityMemberFeatureAdded: false, newPublicEndpoint: false };
      return reply("ROTATION_CLOSE_PREPARED", prepared);
    }
    if (operation === "rotation-session-closed") {
      assert.deepEqual(candidate.observationCalls.at(-1), ["verify-closed", selected.plan.finalEpoch]);
      observedClosure = packet.frontendSessionClosed;
      assert.equal(observedClosure.backendPid, armedProbe.backendPid);
      assert.equal(observedClosure.admission.epoch, selected.plan.finalEpoch);
      assert.equal(observedClosure.nonceLockReleased, true);
      assert.equal(observedClosure.migrationLockReleased, true);
      joined = { ...prepared, status: "P2_IDENTITY_KEY_ROTATION_QUALIFIED", keyRemovalVerified: true,
        frontendSessionCloseReceiptSha256: pin("f") };
      return reply("ROTATION_JOINED", joined);
    }
    assert.equal(operation, "commit");
    assert.ok(observedClosure);
    return reply("COMMITTED", joined);
  }) };
  const dispatch = prepareP2ManagedIdentityRotationDispatch(selected, privateInputs, { verifyEnvironment: async () => {} }, fixtureTransport);
  for (const file of ["reviewed-plan.json", "frontend-custody.json", "private-input-bindings.json"]) {
    const location = join(dispatch.directory, file);
    assert.equal(statSync(location).mode & 0o777, 0o600);
    assert.equal(readFileSync(location, "utf8").includes("owned-db-private-fixture"), false);
    assert.equal(readFileSync(location, "utf8").includes("owned-vercel-private-fixture"), false);
  }
  const options = {
    ...candidate.options, nowMs: () => clock,
    observeFrontendSigner: async (phase, window) => {
      signerPhases.push(phase);
      candidate.advance(window.closedEpoch);
      clock += 1000;
      return { status: "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED", phase,
        configurationSha256: configuration[phase === "post-removal" ? "current-only" : phase].sha256,
        receiptSha256: p2NativeHash(phase), issuanceCutoffAt: new Date(clock - (phase === "overlap" ? 332_000 : 0)).toISOString() };
    },
  };
  const input = { confirmation, transport: dispatch.transport };
  const reviewPath = join(dispatch.directory, "frontend-custody.json");
  const exactReview = readFileSync(reviewPath);
  writeFileSync(reviewPath, "{}\n");
  await assert.rejects(runP2IdentityRotationParent(dispatch.plan, input, options),
    { message: "P2_IDENTITY_ROTATION_PARENT_RETAINED_PLAN_REFUSED" });
  assert.equal(hostStarted, false);
  writeFileSync(reviewPath, exactReview);
  const receipt = await runP2IdentityRotationParent(dispatch.plan, input, options);
  assert.deepEqual(steps, ["overlap:api", "overlap:frontend", "current-only:frontend", "current-only:api"]);
  assert.deepEqual(signerPhases, ["overlap", "current-only", "post-removal"]);
  assert.equal(receipt.status, "P2_IDENTITY_KEY_ROTATION_PARENT_FIXTURE_JOINED");
  assert.equal(receipt.keyRemovalVerified, false);
  assert.equal(receipt.liveEligible, false);
  assert.equal(receipt.frontendSessionClosedSha256, p2NativeHash(observedClosure));
  assert.deepEqual(JSON.parse(readFileSync(join(dispatch.directory, "fixture-host-rotation-joined.json"), "utf8")), joined);
  assert.deepEqual(JSON.parse(readFileSync(join(dispatch.directory, "fixture-frontend-session-close-observation.json"), "utf8")), observedClosure);
  await assert.rejects(runP2IdentityRotationParent(dispatch.plan, { confirmation, transport: dispatch.transport }),
    { message: "P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED" });
});

function ownedOverlapBrowser(postgres, browserProgramSha256, evidence, command, args, options) {
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(0, 2), ["--input-type=module", "--eval"]);
  assert.equal(p2NativeHash(args[2]), browserProgramSha256);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  const child = new EventEmitter();
  let source, ended = false;
  const exit = (code, signal = null) => {
    if (ended) return;
    ended = true;
    setImmediate(() => child.emit("exit", code, signal));
  };
  child.kill = signal => exit(null, signal);
  child.send = ({ type, input }, callback) => {
    callback(null);
    void Promise.resolve().then(async () => {
      if (type === "initialize") {
        assert.equal(source, undefined);
        assert.equal(input.phase, "overlap");
        assert.equal(input.deploymentId, "dpl_OwnedOverlap");
        source = input;
        child.emit("message", { type: "initialized", challenge: source.challenge });
        return;
      }
      assert.equal(input.challenge, source.challenge);
      if (type === "authenticate") {
        assert.equal(input.permit.stage, "identity");
        assert.equal(input.permit.epoch, "2");
        assert.ok(typeof input.permit.customerCookie === "string" && typeof input.permit.adminCookie === "string" &&
          input.permit.customerCookie !== input.permit.adminCookie);
        assert.equal(evidence.operationIds, undefined);
        evidence.operationIds = await postgres.exerciseAuthentication(input.permit.epoch);
        child.emit("message", { type: "authenticated", challenge: source.challenge, value: {
          customerAuthenticated: true, adminFresh: true, observedAt: new Date().toISOString(),
        } });
        return;
      }
      assert.equal(type, "arm");
      assert.equal(input.permit.stage, "rotation-admin");
      assert.equal(input.permit.epoch, "3");
      assert.ok(!Object.hasOwn(input.permit, "customerCookie"));
      const page = path => ({ request: { async get(url) {
        assert.equal(url, `${source.browserOrigin}/api/${path}/courses/${source.courseId}`);
        evidence.reads.push(path);
        return { status: () => 200, allHeaders: async () => ({ "cache-control": "private, no-store", "x-request-id": randomUUID() }),
          body: async () => raw({ course: { id: source.courseId } }) };
      } } });
      evidence.sourceRecord = await recordP2IdentityRotationBrowserReads(source, { customer: page("academy"), admin: page("admin") });
      child.emit("message", { type: "complete", challenge: source.challenge, value: evidence.sourceRecord });
      exit(0);
    }).catch(error => { evidence.error = error; child.emit("error", error); exit(1); });
    return true;
  };
  return child;
}

async function rehearseManagedWire(t, afterOverlap) {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 0);
  assert.ok(existsSync("/.dockerenv") && Object.values(networkInterfaces()).flat().every(address => address.internal));
  const sourceRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
  const sourceCommit = process.env.P2_ROTATION_OWNED_SOURCE_COMMIT;
  assert.match(sourceCommit, /^(?!0+$)[a-f0-9]{40}$/u);
  const installed = join("/opt/lash-her/operators", sourceCommit);
  assert.equal(existsSync(installed), false);
  mkdirSync(installed, { recursive: true, mode: 0o755 });
  t.after(() => rmSync(installed, { recursive: true, force: true }));
  const files = readProfiledCurrentOperatorSourceFiles(sourceRoot);
  for (const { path, data } of files) {
    const destination = join(installed, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, Buffer.from(data, "base64"), { mode: 0o644, flag: "wx" });
  }
  const closureSha = p2NativeHash(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
  const hostParent = "/var/lib/lash-her/releases/staging";
  mkdirSync(hostParent, { recursive: true, mode: 0o700 });
  const hostRoot = mkdtempSync(join(hostParent, "p2-owned-rotation-"));
  t.after(() => rmSync(hostRoot, { recursive: true, force: true }));
  const hostMachineId = readFileSync("/etc/machine-id", "utf8").trim();
  assert.match(hostMachineId, /^(?!0+$)[a-f0-9]{32}$/u);
  const releaseId = "owned-frontend-replacement";
  const configuration = join(hostRoot, "results", `runtime-profiled-frontend-replacement-${releaseId}`, "configuration");
  for (const directory of [join(configuration, "admission"), join(hostRoot, "bundle"), join(hostRoot, "rotation")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const configurationFiles = ["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
    "tls/gateway/ca.pem", ...["gateway", "course", "community"].flatMap(service => [`tls/${service}/key.pem`, `tls/${service}/cert.pem`]),
    ...["course-api", "course-publisher", "course-snapshot", "community-api", "community-worker", "course-media", "course-export-cleanup"]
      .map(service => `${service}.env`)];
  const configurationSha256 = Object.fromEntries(configurationFiles.map(name => {
    const destination = join(configuration, name);
    const contents = name.endsWith(".json") ? raw({ ...base, hostMachineId, releaseId }) : Buffer.from(`owned fixture ${name}\n`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, contents, { mode: 0o600, flag: "wx" });
    return [name, p2NativeHash(contents)];
  }));
  const compose = readFileSync(join(installed, "ops/platform/compose.yaml"));
  writeFileSync(join(configuration, "compose.yaml"), compose, { mode: 0o600, flag: "wx" });
  const artifacts = Object.fromEntries(["gateway", "courseRuntime", "communityRuntime"].map((name, index) => [name, {
    image: `ghcr.io/princessdardan/lash-her-platform-owned-rotation-${name.toLowerCase()}@sha256:${pin("abc"[index])}`,
  }]));
  const services = ["community-api", "course-api", "community-tls", "course-tls", "course-snapshot", "community-worker",
    "course-media", "course-export-cleanup", "course-publisher", "gateway"];
  const inventory = services.map(service => ({ service,
    containerId: createHash("sha256").update(`p2-owned-container:${service}`).digest("hex"),
    image: artifacts[service.endsWith("-tls") || service === "gateway" ? "gateway"
      : service.startsWith("course-") ? "courseRuntime" : "communityRuntime"].image,
    health: service.endsWith("-tls") ? "none" : "healthy",
  }));
  const { withOwnedP2RotationPostgres } = await import("./p2-certification-replacement-probe.test.mjs");
  await withOwnedP2RotationPostgres({ pgBin: process.env.PG_BIN, serverMajor: 18, runAsPostgres: true,
    sourceCommit, releaseId, producerSha256: pin("b") }, async postgres => {
    const { f, lease, path, rotation } = managedFixture(t, { postgres, hostRoot, hostMachineId, artifacts,
      composeSha256: "sha256:" + p2NativeHash(compose), configurationSha256,
      runtimeInventorySha256: p2NativeHash(inventory), sourceClosureSha256: closureSha });
    writeFileSync(join(f.loaded.host.bundle, "release.candidate.json"), f.loaded.candidateBytes, { mode: 0o600, flag: "wx" });
    writeFileSync(join(configuration, "admission/state.json"), raw({ version: 1, environment: "staging", releaseId,
      candidateSha256: f.loaded.original.plan.candidateSha256, actionId: "owned-fixture", newWork: false, recovery: false }),
    { mode: 0o644, flag: "wx" });
    const selected = bindP2ManagedIdentityRotationPlan(lease, files, path, rotation);
    const program = "import hashlib,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import p2_identity_key_rotation as p;print(hashlib.sha256(p.private_program(Path(sys.argv[2]))).hexdigest())";
    const operatorProgramSha256 = execFileSync("/usr/bin/python3", ["-I", "-B", "-c", program,
      join(installed, "ops/platform/host"), installed], { encoding: "utf8", timeout: 10_000 }).trim();
    const browser = readFileSync(join(installed, "ops/platform/p2-identity-key-rotation-browser-recorder.mjs"));
    const privateInputs = { credentials: { FRONTEND_STAGING_MIGRATION_DATABASE_URL: await postgres.getUrl(),
      COURSE_STAGING_DATABASE_URL: "owned-course-projection", COMMUNITY_STAGING_DATABASE_URL: "owned-community-projection" },
      vercelToken: "owned-vercel-projection", scopedCronSecret: "owned-cron-projection".repeat(2),
      gatewayHost: new URL(resolveQualificationTargetProfile(profile).gateway.publicOrigin).hostname, operatorProgramSha256,
      rotationBrowserProgramSha256: p2NativeHash(Buffer.concat([browser, Buffer.from("\nawait runP2IdentityRotationBrowserChild();\n")])) };
    let exited, probe, overlapSigner;
    const browserEvidence = { reads: [] };
    const diagnostics = [];
    const dispatch = prepareP2ManagedIdentityRotationDispatch(selected, privateInputs, { verifyEnvironment: postgres.verifyEnvironment },
      { fixture: true, openOwnedChannel: () => {
        const child = spawn("/usr/bin/python3", ["-I", "-B", "-u", join(sourceRoot, "ops/platform/host/p2_rotation_owned_rehearsal_test.py"),
          "--supervisor", installed], { stdio: ["pipe", "pipe", "pipe"], env: { ...postgres.observerEnvironment(),
          P2_ROTATION_OWNED_NODE_SOURCE: sourceRoot } });
        child.on("exit", code => { exited = code; });
        child.stderr.on("data", bytes => {
          for (const code of bytes.toString().match(/(?:P2_|PROFILED_|QUALIFICATION_)[A-Z0-9_]{4,100}(?: [a-z0-9_]+\.py \d+)?/gu) ?? []) {
            if (diagnostics.length < 24 && !diagnostics.includes(code)) diagnostics.push(code);
          }
        });
        return child;
      } });
    const hostAction = join(f.loaded.host.results, `p2-identity-key-rotation-${dispatch.plan.actionId}`);
    const readReceipt = name => JSON.parse(readFileSync(join(hostAction, name), "utf8"));
    await assert.rejects(runP2IdentityRotationParent(dispatch.plan,
      { confirmation: `staging/${dispatch.plan.actionId}`, transport: dispatch.transport }, {
        fixture: true,
        ...(afterOverlap ? { openOwnedBrowserChild: (...args) =>
          ownedOverlapBrowser(postgres, privateInputs.rotationBrowserProgramSha256, browserEvidence, ...args) } : {}),
        runController: async (controllerPlan, parent, dependencies, options) => {
          assert.equal(parent.hostLockHeld, true);
          assert.equal(parent.frontendPhysicalLockHeld, true);
          const current = await dependencies.frontendSession.observeCurrent();
          assert.equal(current.status, "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED");
          assert.deepEqual(current.admission, { epoch: "1", newWork: false, recovery: false, active: 0, uncertain: 0 });
          assert.equal(readReceipt("p2-identity-rotation-guard-ready.json").status, "P2_MANAGED_ROTATION_GUARD_ARM_READY");
          assert.throws(() => execFileSync("/usr/bin/flock", ["-n", "/run/lock/lash-her-release.lock", "/usr/bin/true"]), { status: 1 });
          probe = dependencies.frontendSession.probe;
          if (!afterOverlap) throw new Error("OWNED_CONTROLLER_DISCONNECTED_AFTER_ARM");
          return runIdentityKeyRotationController(controllerPlan, parent, {
            ...dependencies,
            observeFrontendSigner: async phase => {
              assert.equal(phase, "overlap");
              const signer = await dependencies.observeFrontendSigner(phase);
              assert.equal(signer.status, "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED");
              assert.equal(signer.receiptSha256, p2NativeHash(browserEvidence.sourceRecord));
              assert.deepEqual((await dependencies.frontendSession.observeCurrent()).admission,
                { epoch: "3", newWork: false, recovery: false, active: 0, uncertain: 0 });
              overlapSigner = signer;
              throw new Error("OWNED_CONTROLLER_DISCONNECTED_AFTER_OVERLAP_SIGNER");
            },
          }, options);
        },
      }), { message: "P2_IDENTITY_ROTATION_FAILED_REQUIRES_REVIEW" });
    assert.ok(probe, `Owned broker did not reach ARM (${diagnostics.join(", ")})`);
    if (afterOverlap) {
      assert.ifError(browserEvidence.error);
      assert.ok(overlapSigner, `Owned broker did not retain the overlap signer (${diagnostics.join(", ")})`);
      assert.deepEqual(browserEvidence.reads, ["academy", "admin"]);
      const authentication = readReceipt("browser-overlap-authentication-writer-scope.json");
      const signer = readReceipt("browser-overlap-signer-read-writer-scope.json");
      for (const scope of [authentication, signer]) {
        assert.equal(scope.status, "P2_ROTATION_BROWSER_WRITER_SCOPE_CLOSED");
        assert.equal(scope.closedEpoch, "3");
        assert.equal(scope.challengeSha256, p2NativeHash(browserEvidence.sourceRecord.challenge));
        assert.deepEqual(Object.fromEntries(["newWork", "recovery", "active", "uncertain"].map(key => [key, scope[key]])),
          { newWork: false, recovery: false, active: 0, uncertain: 0 });
        const receipt = readReceipt(`browser-overlap-${scope.kind}-closed.json`);
        assert.equal(receipt.writerScopeSha256, p2NativeHash(readFileSync(join(hostAction,
          `browser-overlap-${scope.kind}-writer-scope.json`))));
      }
      assert.equal(authentication.permitEpoch, "2");
      assert.deepEqual(authentication.operationCounts, { "new-work": 5, recovery: 2 });
      assert.equal(signer.permitEpoch, "3");
      assert.deepEqual(signer.operationCounts, { "new-work": 0, recovery: 0 });
      const { rows } = await postgres.admin.query(`SELECT id::text, epoch::text, kind, state, source_sha,
        database_role::text AS role_oid, reconciliation_sha256 FROM frontend_admission.operations ORDER BY started_at,id`);
      assert.deepEqual(rows.map(row => row.id), browserEvidence.operationIds);
      assert.equal(rows.length, 7);
      assert.ok(rows.every(row => row.epoch === "2" && row.state === "completed" && row.source_sha === sourceCommit &&
        row.role_oid === postgres.selected.prepared.plan.producers[0].role.oid && row.reconciliation_sha256 === null));
      assert.equal(existsSync(join(hostAction, "host-current-only-frontend-attempted.json")), false);
    }
    assert.equal(exited, 1);
    const failure = readReceipt("p2-independent-guard-outcome.json");
    assert.equal(failure.workerProcessesQuiesced, true);
    assert.equal(failure.managedRotationArmReceiptVerified, true);
    assert.equal(failure.frontendAdmissionClosed, true);
    assert.equal(failure.gatewayAdmissionAcknowledged, true);
    assert.equal(failure.runtimeStopped, true);
    assert.deepEqual(Object.fromEntries(["epoch", "newWork", "recovery", "active", "uncertain", "admissionChanged"]
      .map(key => [key, failure.frontendFence[key]])),
    { epoch: afterOverlap ? "3" : "1", newWork: false, recovery: false, active: 0, uncertain: 0, admissionChanged: false });
    assert.equal(existsSync(join(hostAction, "p2-identity-key-rotation-outcome.json")), false);
    execFileSync("/usr/bin/flock", ["-n", "/run/lock/lash-her-release.lock", "/usr/bin/true"]);
    const closed = await postgres.observeClosed(probe);
    assert.equal(closed.backendAbsent && closed.migrationLockReleased && closed.nonceLockReleased, true);
    assert.deepEqual(closed.admission, { epoch: afterOverlap ? "3" : "1", newWork: false, recovery: false, active: 0, uncertain: 0 });
  });
}

const ownedWireOptions = { skip: process.env.P2_ROTATION_OWNED_REHEARSAL !== "true", timeout: 300_000 };
test("owned Linux managed wire arms a real frontend lease and fences after controller loss",
  ownedWireOptions, t => rehearseManagedWire(t, false));
test("owned Linux managed wire retains overlap signer scopes and fences a real closed epoch",
  ownedWireOptions, t => rehearseManagedWire(t, true));
