import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFrontendReceipt } from "./frontend-migration.mjs";
import test from "node:test";
import { P2_CERTIFICATION_READY_FILES } from "./p2-certification.mjs";
import { p2IdentityRotationOperator, prepareP2IdentityRotationDispatch, prepareP2IdentityRotationPlanFromChecked,
  validateP2ManagedRotationFrontendReady, validateP2ManagedRotationSuccessorEvidence } from "./p2-identity-key-rotation-operator.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { prepareP2IdentityRotationParent, runP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";
import { withP2IdentityRotationTransport } from "./p2-identity-key-rotation-transport.mjs";
import { P2_IDENTITY_ROTATION_SERVICES } from "./p2-identity-key-rotation-observer.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

test("managed successor custody retains original guardian bytes and refuses stale closure or action evidence", () => {
  const identity = { actionId: "p2-key-rotation-owned", sourceCommit: "a".repeat(40), candidateSha256: sha("candidate"),
    bindingSha256: sha("binding"), qualificationTargetProfile: profile };
  const plan = { ...identity, originalReleaseId: "owned", hostMachineId: "f".repeat(32), targetSha256: sha("target"), finalEpoch: "15",
    configuration: { "current-only": { sha256: sha("current") } } };
  const joined = { ...identity, status: "P2_IDENTITY_KEY_ROTATION_QUALIFIED", keyRemovalVerified: true,
    frontendFinalEpoch: "15", frontendSessionCloseReceiptSha256: sha("closed"),
    frontendSignerReceiptSha256: { "post-removal": sha("signer") } };
  const readyBytes = Object.fromEntries(P2_CERTIFICATION_READY_FILES.map(name => [name, Buffer.from(`{"name":"${name}"}\n`)]));
  const frontend = { deploymentId: "dpl_Owned", deploymentUrl: "https://owned.vercel.app",
    readyReceiptSha256: Object.fromEntries(Object.entries(readyBytes).map(([name, bytes]) => [name, sha(bytes)])),
    postRemovalSignerReceiptSha256: joined.frontendSignerReceiptSha256["post-removal"] };
  const receipt = { ...identity, version: 2, environment: "staging", status: "P2_IDENTITY_ROTATION_MIXED_SUCCESSOR_RUNTIME_VERIFIED",
    kind: "identity-key-rotation-mixed-mount-v1", releaseId: plan.originalReleaseId, hostMachineId: plan.hostMachineId,
    targetSha256: plan.targetSha256, frontendEpoch: plan.finalEpoch, configurationSha256: plan.configuration["current-only"].sha256,
    currentOnlyRuntimeConfigurationSha256: sha("current runtime"),
    terminalReceiptSha256: sha("terminal"), runtimeInventorySha256: sha("runtime"),
    frontendSessionClosedSha256: joined.frontendSessionCloseReceiptSha256, frontend, frontendAdmissionClosed: true, gatewayAdmissionClosed: true,
    nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false, g2Accepted: false };
  const raw = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const response = value => ({ bytes: raw(value).toString("base64") });
  const proof = validateP2ManagedRotationSuccessorEvidence(response(receipt), plan, joined);
  assert.deepEqual(Buffer.from(proof.originalBytesBase64, "base64"), raw(receipt));
  assert.equal(proof.receiptSha256, sha(raw(receipt)));
  const ready = Object.fromEntries(Object.entries(readyBytes).map(([name, bytes]) => [name, bytes.toString("base64")]));
  assert.deepEqual(validateP2ManagedRotationFrontendReady(response(ready), proof), {
    successorReceiptSha256: proof.receiptSha256, originalBytesBase64: ready,
  });
  assert.throws(() => validateP2ManagedRotationFrontendReady(response(ready), { ...proof, receiptSha256: sha("foreign") }));
  assert.throws(() => validateP2ManagedRotationFrontendReady(response({ ...ready, "frontend.env": "unexpected" }), proof));
  assert.throws(() => validateP2ManagedRotationFrontendReady(response({ ...ready,
    "frontend-workload-outcome.json": Buffer.from("{}\n").toString("base64") }), proof));
  for (const changes of [{ frontendEpoch: "13" }, { frontendSessionClosedSha256: sha("other") },
    { currentOnlyRuntimeConfigurationSha256: "0".repeat(64) },
    { sourceCommit: "b".repeat(40) }, { gatewayAdmissionClosed: false }]) {
    assert.throws(() => validateP2ManagedRotationSuccessorEvidence(response({ ...receipt, ...changes }), plan, joined));
  }
  for (const changes of [{ deploymentId: "foreign" }, { deploymentUrl: "https://staging.lashher.com" },
    { readyReceiptSha256: { "frontend-workload-outcome.json": sha("workload") } },
    { postRemovalSignerReceiptSha256: sha("foreign signer") }, { credentials: "unexpected" }]) {
    assert.throws(() => validateP2ManagedRotationSuccessorEvidence(response({ ...receipt, frontend: { ...frontend, ...changes } }), plan, joined));
  }
});

function fixture() {
  const sourceCommit = "a".repeat(40), actionId = "p2-key-rotation-owned";
  const writerAdmissionBinding = { mode: "enforce", targetSha256: sha("target"), producerSha256: sha("producer"),
    sourceCommit, roleName: "frontend_runtime" };
  const candidate = { releaseId: "original-release", environment: "staging", contractPhase: "p2",
    sources: { frontend: { commit: sourceCommit } }, workload: { projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" },
    phase2ContractManifestSha256: sha("contract") };
  const checked = { action: { recoveryActionId: actionId, sourceCommit, candidateSha256: sha("candidate"), originalReceiptSha256: {
    "frontend-release-started.json": sha("started"), "database-receipt.json": sha("database"), "job-outcome.json": null } },
    original: { candidate, job: { sourceCommit, target: { host: "db.owned.invalid", port: 5432, database: "owned",
      user: "frontend_runtime", serverMajor: 16, runtimeRole: "frontend_runtime" } },
      plan: { writerAdmissionBinding } },
    prepared: { migration: { candidate, job: { sourceCommit } }, plan: { targetSha256: writerAdmissionBinding.targetSha256,
      owner: { name: "frontend_owner", oid: "42" }, certification: { featureControls: { customerIdentityEnabled: true } } } } };
  const root = "/var/lib/lash-her/releases/staging/rotation-owned";
  const configuration = Object.fromEntries(["baseline", "overlap", "current-only"].map(phase => [phase,
    { sha256: sha(`public-${phase}`), privateRef: `${root}/${phase}` }]));
  const privateConfigurationSha256 = Object.fromEntries(["baseline", "overlap", "current-only"].map(phase => [phase, sha(`private-${phase}`)]));
  const names = ["frontend-build-started.json", "frontend-build-created.json", "frontend-build-outcome.json",
    "frontend-workload-outcome.json", "frontend-promotion-started.json", "frontend-promotion-outcome.json"];
  const settings = { version: 1, environment: "staging", operatorSourceCommit: sourceCommit,
    host: { machineId: "b".repeat(32), rotationConfiguration: root }, frontendReceipts: "/private/owned",
    rotation: { actionId, courseId: uuid("1"), subjects: { "course-learner": uuid("2"), "course-admin": uuid("3"),
      "community-member": uuid("4"), "community-admin": uuid("5") }, configuration, privateConfigurationSha256,
      baseline: { deploymentId: "dpl_Owned", deploymentUrl: "https://owned.vercel.app", configurationRecordSha256: sha("workload") },
      readyReceiptSha256: Object.fromEntries(names.map(name => [name, sha(name)])) } };
  return { settings, checked };
}

test("source plan binds current recovery, three private references, native deployment, and exact READY receipts", () => {
  const { settings, checked } = fixture(); let joined;
  const result = prepareP2IdentityRotationPlanFromChecked(settings, checked, (directory, plan) => { joined = { directory, plan }; });
  assert.equal(result.plan.actionId, checked.action.recoveryActionId);
  assert.equal(result.plan.originalReleaseId, checked.original.candidate.releaseId);
  assert.equal(result.plan.bindingSha256.length, 64);
  assert.equal(result.nativePlan.deploymentId, settings.rotation.baseline.deploymentId);
  assert.deepEqual(joined.plan.readyReceiptSha256, settings.rotation.readyReceiptSha256);
  const parent = prepareP2IdentityRotationParent(result.plan, checked.prepared, checked.action,
    { sourceCommit: result.plan.sourceCommit, candidateSha256: result.plan.candidateSha256,
      bindingSha256: result.plan.bindingSha256, configuration: result.plan.configuration,
      featureControls: result.plan.featureControls, writerAdmissionBinding: result.plan.writerAdmissionBinding },
    { getUrl: () => "owned", verifyEnvironment: () => {}, resultsDirectory: realpathSync(tmpdir()) });
  assert.deepEqual(parent, result.plan);
  assert.equal(Object.isFrozen(result.plan), true);
  assert.throws(() => { result.plan.actionId = "changed"; }, TypeError);
});

test("foreign recovery, configuration reference, source, or READY proof refuses before apply", () => {
  for (const change of [
    ({ checked }) => { checked.action.recoveryActionId = "different"; },
    ({ settings }) => { settings.rotation.configuration.overlap.privateRef += "-other"; },
    ({ settings }) => { settings.operatorSourceCommit = "f".repeat(40); },
    ({ settings }) => { settings.rotation.readyReceiptSha256["frontend-build-outcome.json"] = "invalid"; },
  ]) {
    const value = fixture(); change(value);
    assert.throws(() => prepareP2IdentityRotationPlanFromChecked(value.settings, value.checked, () => {}),
      /P2_IDENTITY_ROTATION_OPERATOR_REFUSED/u);
  }
});

function dispatchFixture() {
  const { settings, checked } = fixture();
  const selected = prepareP2IdentityRotationPlanFromChecked(settings, checked, () => {});
  const { actionId, candidateSha256, sourceCommit } = selected.plan;
  const initial = { version: 1, mode: "p2-identity-key-rotation", environment: "staging",
    rotationActionId: actionId, candidateSha256, sourceCommit };
  settings.results = realpathSync(tmpdir());
  const dependencies = { getUrl: () => { throw new Error("fixture must not read credentials"); }, verifyEnvironment: async () => {} };
  return { settings, selected, initial, dependencies };
}

test("fixed dispatch binds transport to the immutable prepared plan by object identity", async () => {
  const { settings, selected, initial, dependencies } = dispatchFixture();
  const one = prepareP2IdentityRotationDispatch(settings, selected, initial, dependencies);
  const two = prepareP2IdentityRotationDispatch(settings, selected, initial, dependencies);
  assert.notEqual(one.plan, selected.plan);
  assert.equal(Object.isFrozen(one.plan.configuration.overlap), true);
  await assert.rejects(() => withP2IdentityRotationTransport(one.transport, structuredClone(one.plan), () => {}),
    /P2_IDENTITY_ROTATION_TRANSPORT_REFUSED/u);
  await assert.rejects(() => withP2IdentityRotationTransport(two.transport, two.plan, () => {}),
    /P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED/u);
  await assert.rejects(() => p2IdentityRotationOperator({}, { apply: true }),
    /P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED/u);
});

test("fixed parent dispatch runs the real controller against the retained review and private local records", async t => {
  const { settings, selected, initial, dependencies } = dispatchFixture();
  settings.results = mkdtempSync(join(realpathSync(tmpdir()), "p2-rotation-dispatch-"));
  t.after(() => rmSync(settings.results, { recursive: true, force: true }));
  const actionDirectory = join(settings.results, selected.plan.actionId);
  const controllerDirectory = join(actionDirectory, "controller");
  mkdirSync(actionDirectory, { mode: 0o700 });
  mkdirSync(controllerDirectory, { mode: 0o700 });
  writeFrontendReceipt(actionDirectory, "reviewed-plan.json", JSON.parse(canonical(selected.plan)));
  const dispatch = prepareP2IdentityRotationDispatch(settings, selected, initial, dependencies);
  const { plan, transport } = dispatch, { configuration } = plan;
  const input = { confirmation: `staging/${plan.actionId}`, transport };
  const profileNames = ["community-admin", "community-member", "course-admin", "course-learner"];
  const containers = P2_IDENTITY_ROTATION_SERVICES.map((service, index) => ({ service,
    containerId: (index + 1).toString(16).padStart(64, "0"),
    image: `ghcr.io/princessdardan/lash-her-platform-${service}@sha256:${"b".repeat(64)}` }));
  const steps = [];
  let clock = Math.floor(Date.now() / 1000) * 1000, frontend = "baseline", runtime = "baseline", captures;
  const host = {
    active: () => true,
    check: async () => {},
    arm: async () => ({ status: "P2_IDENTITY_ROTATION_PARENT_ARMED", bindingSha256: plan.bindingSha256 }),
    observeRuntime: async () => ({ configurationSha256: configuration[runtime].sha256,
      nativeSchedulesEnabled: false, businessSchedulesEnabled: false, containers, courseCurrent: true, communityCurrent: true,
      boundaryChecks: ["private-application-credential-required", "private-community-peer-denied", "private-course-tls-catalog",
        "public-metrics-hidden", "public-tls-missing-workload-denied"] }),
    observeFrontendProvider: async () => ({ configurationSha256: configuration[frontend].sha256,
      cronsEnabled: false, aliasJobActive: false, deploymentId: "dpl_Owned" }),
    applyMutation: async intent => {
      const { actionId, phase, kind, fromConfigurationSha256, toConfigurationSha256 } = intent;
      const retained = JSON.parse(readFileSync(join(controllerDirectory, `${phase}-${kind}-intent.json`), "utf8"));
      assert.deepEqual(retained, intent);
      assert.equal(retained.privateConfigurationRef, selected.plan.configuration[phase].privateRef);
      steps.push(`${phase}:${kind}`);
      if (kind === "api") runtime = phase;
      else frontend = phase;
      return { version: 1, status: "P2_IDENTITY_ROTATION_MUTATION_QUALIFIED", actionId, phase, kind,
        fromConfigurationSha256, toConfigurationSha256, mutationCount: 1, getFirstReconciled: false, runtimeVerified: true,
        sqlExecuted: false, rolesPrepared: false, loginChanged: false };
    },
    captureTokens: async () => {
      assert.deepEqual([runtime, frontend], ["overlap", "current-only"]);
      captures = profileNames.map(profile => ({ status: "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", profile,
        tokenIssuedAt: new Date(clock).toISOString(), tokenExpiresAt: new Date(clock + 300_000).toISOString() }));
      return captures;
    },
    observeProfiles: async phase => captures.map(row => ({ profile: row.profile, phase,
      status: "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED", retainedTokenContinuityVerified: true, releaseAccepted: false,
      oldResult: phase === "overlap" ? "accepted" : "rejected", newResult: "accepted", observedAt: new Date(clock).toISOString(),
      oldTokenIssuedAt: row.tokenIssuedAt, oldTokenExpiresAt: row.tokenExpiresAt })),
    reconcileMutation: async () => { throw new Error("unexpected reconciliation"); },
    failClosed: async () => { throw new Error("unexpected containment"); },
    restoreQualified: async () => { throw new Error("unexpected restoration"); },
  };
  const options = {
    fixture: true, nowMs: () => clock,
    withTransport: async (handle, reviewed, task) => {
      assert.equal(handle, transport);
      assert.equal(reviewed, plan);
      return task(host);
    },
    withSession: async (_prepared, _action, _dependencies, task) => task({ client: {}, verify: async () => {},
      receipt: { admissionEpoch: "1", candidateSha256: plan.candidateSha256 }, probe: { receipt: { sourceCommit: plan.sourceCommit } } }),
    observePhysical: async () => ({ status: "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED", sourceCommit: plan.sourceCommit,
      admission: { newWork: false, recovery: false, active: 0, uncertain: 0 } }),
    observeFrontendSigner: async phase => {
      clock += 1_000;
      return { status: "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED", phase,
        configurationSha256: configuration[phase === "post-removal" ? "current-only" : phase].sha256,
        issuanceCutoffAt: new Date(clock - (phase === "overlap" ? 332_000 : 0)).toISOString(), receiptSha256: sha(phase) };
    },
  };
  const outcome = await runP2IdentityRotationParent(plan, input, options);
  assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_PARENT_FIXTURE_VALIDATED");
  assert.equal(outcome.liveEligible, false);
  assert.deepEqual(steps, ["overlap:api", "overlap:frontend", "current-only:frontend", "current-only:api"]);
  const terminal = join(controllerDirectory, "rotation-controller-qualified.json");
  assert.equal(statSync(terminal).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(terminal, "utf8")).bindingSha256, selected.plan.bindingSha256);
  assert.equal((await runP2IdentityRotationParent(plan, input, options)).status, outcome.status);
  assert.equal(steps.length, 4);
  writeFileSync(terminal, '{"version":1,' + readFileSync(terminal, "utf8").slice(1));
  await assert.rejects(() => runP2IdentityRotationParent(plan, input, options), error => error.check === "private-record-bytes");
  writeFileSync(join(actionDirectory, "reviewed-plan.json"), canonical({ ...plan, environment: "production" }) + "\n");
  await assert.rejects(() => runP2IdentityRotationParent(plan, input, options), /P2_IDENTITY_ROTATION_PARENT_RETAINED_PLAN_REFUSED/u);
});
