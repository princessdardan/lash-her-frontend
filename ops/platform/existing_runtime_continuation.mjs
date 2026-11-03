// Runtime-only continuation on the already-created and independently pinned host.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {verifiedBrowserSshProof} from "./browser_ssh_trust.mjs";

export const EXISTING_RUNTIME=Object.freeze({
  action:"p1-recreate-access-20261103-c3",parentAction:"p1-recreate-access-20261103-c2",
  parentSourceCommit:"738546802fd56517b4ecd1279666cd267fe2a2cd",
  instanceArn:"arn:aws:lightsail:us-east-1:691588646557:Instance/c88deb32-5f4f-42df-85b4-232609b0d23e",
  machineId:"ec2146be041cf26fda0a7986db4be3b6",inputManifestSha256:"f5b1a5faad65d47219e89c4de4abae24be8f299a4dedfbb5a5b034b7bc5dae51",
  receiptsSha256:Object.freeze({
    "action-outcome.json":"09d93ad762b4a8f25ff0f804eba281c3ad00b25b7c90aea14396918d5cfc70c3",
    "browser-ssh-trust.json":"a3718b9a8a6a5569d2fa0d3af081a792519c3362a14e9eaa3d01db93ef50953e",
    "p1-recreate-access-20261103-c2-browser-trust-verified.json":"d20f9e52ee76bda87281698775a2c4c2a9015f6b65eb0e1b024f0d95e4e3e786",
    "original-stop-completed.json":"970fbf61d029b11ade0c6e679f1a0ee27432dbddce6ed6b0d4502a3d28796f98",
    "original-snapshot-completed.json":"e2066bddefef42e0acb72447382992856c7bcc960d54718bfcb22e67080156d8",
    "reviewed-plan.json":"a85edfa912c027bc350bfd3438b54140615c103e7030bc1d80b080b173a677ff",
    "ssh/003-private-stderr.bin":"9c4351bdd5872b2a98dced1b89f22147c19430376625db644f7768f46a0d485f",
  }),
});

export function validateRuntimeParent(value) {
  const fixed=EXISTING_RUNTIME;
  assert.equal(value.parentAction,fixed.parentAction);assert.deepEqual(value.receiptsSha256,fixed.receiptsSha256);
  assert.equal(value.outcome.action,fixed.parentAction);assert.equal(value.outcome.sourceCommit,fixed.parentSourceCommit);
  assert.equal(value.outcome.status,"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW");assert.equal(value.outcome.phase,"restore-reviewed-private-inputs");
  assert.equal(value.outcome.failureCode,"ACTION_PHASE_FAILED");
  for(const flag of ["productionChanged","migrationsExecuted","trafficAuthorized","releaseAccepted"])assert.equal(value.outcome[flag],false);
  assert.equal(value.error.status,"RECREATION_FILES_REQUIRES_REVIEW");assert.equal(value.error.failureCode,"RECREATION_FILES_ACME_SCOPE_REQUIRED");
  assert.equal(value.infrastructure.instanceArn,fixed.instanceArn);assert.equal(value.infrastructure.accessRecoveryPhase,"ready");
  assert.equal(value.infrastructure.browserSshEnabled,true);assert.equal(value.infrastructure.instanceState,"running");
  assert.equal(value.trust.instanceArn,fixed.instanceArn);assert.equal(value.trust.hostMachineId,fixed.machineId);
  assert.equal(value.trust.keyPinnedBeforePrivateTransfer,true);assert.equal(value.trust.browserAccountVerified,true);
  assert.equal(value.stop.status,"STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY");assert.equal(value.stop.forcedStop,false);
  assert.equal(value.snapshot.status,"STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE");
  assert.equal(value.plan.inputManifestSha256,"1aae2f0d42177cec9be85da8ab9ba20a077d6ec6bb9822a3334dca685f14c410");
  return value;
}

export function runtimeParentReceipts(files) {
  const fixed=EXISTING_RUNTIME,values={},receiptsSha256={};
  assert.deepEqual(Object.keys(files).sort(),Object.keys(fixed.receiptsSha256).sort());
  for(const [name,raw] of Object.entries(files)) {
    assert.ok(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=100000);
    receiptsSha256[name]=createHash("sha256").update(raw).digest("hex");assert.equal(receiptsSha256[name],fixed.receiptsSha256[name]);
    values[name]=JSON.parse(raw.toString("utf8"));
  }
  return validateRuntimeParent({parentAction:fixed.parentAction,receiptsSha256,outcome:values["action-outcome.json"],
    trust:values["browser-ssh-trust.json"],infrastructure:values[fixed.parentAction+"-browser-trust-verified.json"],
    stop:values["original-stop-completed.json"],snapshot:values["original-snapshot-completed.json"],
    plan:values["reviewed-plan.json"],error:values["ssh/003-private-stderr.bin"]});
}

export function runtimeContinuationPlan(plan,evidence,inputFiles) {
  validateRuntimeParent(evidence);assert.equal(plan.action,EXISTING_RUNTIME.action);assert.equal(inputFiles,50);
  assert.equal(plan.inputManifestSha256,EXISTING_RUNTIME.inputManifestSha256);
  return {...plan,operation:"restore-runtime-on-existing-pinned-host",continuationOf:EXISTING_RUNTIME.parentAction,
    parentSourceCommit:EXISTING_RUNTIME.parentSourceCommit,parentReceiptsSha256:evidence.receiptsSha256,
    existingInstanceArn:EXISTING_RUNTIME.instanceArn,existingMachineId:EXISTING_RUNTIME.machineId,
    originalHostSnapshotName:evidence.snapshot.snapshotName,existingSnapshotArn:evidence.snapshot.snapshotArn,
    providerMutationsIncluded:false,stopRequestIncluded:false,snapshotCreationIncluded:false,hostReplacementIncluded:false,detachUpdateIncluded:false,
    excludedInput:"maintenance/acme-staging/initial-issuance.log",
    steps:["verify-source-producers-and-fifty-held-inputs","verify-existing-instance-and-retained-browser-key",
      "verify-bare-host-and-no-partial-handoff","install-exact-public-source","restore-fifty-validated-private-inputs",
      "bootstrap-and-cache-six-pinned-images","install-maintenance-disabled","verify-three-current-databases-read-only",
      "start-eight-existing-runtime-services-in-maintenance"]};
}

export function retainedRuntimeBrowserTrust(evidence,instance) {
  validateRuntimeParent(evidence);assert.equal(instance.instanceArn,EXISTING_RUNTIME.instanceArn);
  assert.equal(instance.accessRecoveryPhase,"ready");
  // Revalidate the retained C2 observation against the same current instance;
  // do not claim a new browser observation or accept a different server key.
  return {...verifiedBrowserSshProof(evidence.trust,{...instance,accessRecoveryPhase:"verify-key"},
    EXISTING_RUNTIME.parentAction,"ec265c34b9fbf4d051aecfa185362c0a"),reusedFromAction:EXISTING_RUNTIME.parentAction};
}
