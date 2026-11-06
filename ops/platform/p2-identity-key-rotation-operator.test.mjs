import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareP2IdentityRotationPlanFromChecked } from "./p2-identity-key-rotation-operator.mjs";
import { prepareP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
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
    { getUrl: () => "owned", verifyEnvironment: () => {} });
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
