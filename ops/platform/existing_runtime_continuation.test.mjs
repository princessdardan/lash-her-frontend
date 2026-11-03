import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {EXISTING_RUNTIME,validateRuntimeParent,runtimeParentReceipts,runtimeContinuationPlan,retainedRuntimeBrowserTrust} from "./existing_runtime_continuation.mjs";

function owned() {
  const f=EXISTING_RUNTIME,raw=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from("ssh-ed25519"),Buffer.from([0,0,0,32]),Buffer.alloc(32,3)]);
  const trust={version:1,action:f.parentAction,method:"authenticated-aws-browser",accountId:"691588646557",browserAccountVerified:true,
    instanceArn:f.instanceArn,address:"184.196.129.231",hostMachineId:f.machineId,hostPublicKey:"ssh-ed25519 "+raw.toString("base64"),
    fingerprint:"SHA256:"+createHash("sha256").update(raw).digest("base64").replace(/=+$/u,""),keyPinnedBeforePrivateTransfer:true};
  const infrastructure={instanceArn:f.instanceArn,accessRecoveryPhase:"ready",browserSshEnabled:true,instanceState:"running",address:trust.address};
  return {parentAction:f.parentAction,receiptsSha256:{...f.receiptsSha256},trust,infrastructure,
    outcome:{action:f.parentAction,sourceCommit:f.parentSourceCommit,status:"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW",phase:"restore-reviewed-private-inputs",
      failureCode:"ACTION_PHASE_FAILED",productionChanged:false,migrationsExecuted:false,trafficAuthorized:false,releaseAccepted:false},
    error:{status:"RECREATION_FILES_REQUIRES_REVIEW",failureCode:"RECREATION_FILES_ACME_SCOPE_REQUIRED"},
    stop:{status:"STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY",forcedStop:false},
    snapshot:{status:"STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE",snapshotName:"p1-recreate-access-20261103-original",snapshotArn:"owned-snapshot"},
    plan:{inputManifestSha256:"1aae2f0d42177cec9be85da8ab9ba20a077d6ec6bb9822a3334dca685f14c410"}};
}

test("runtime-only continuation retains the exact existing host and browser observation without infrastructure steps",()=> {
  const e=owned(),f=EXISTING_RUNTIME;assert.equal(validateRuntimeParent(e),e);
  const p=runtimeContinuationPlan({action:f.action,inputManifestSha256:f.inputManifestSha256},e,50);
  for(const flag of ["providerMutationsIncluded","stopRequestIncluded","snapshotCreationIncluded","hostReplacementIncluded","detachUpdateIncluded"])assert.equal(p[flag],false);
  assert.equal(p.excludedInput,"maintenance/acme-staging/initial-issuance.log");
  assert.equal(p.existingInstanceArn,f.instanceArn);
  const t=retainedRuntimeBrowserTrust(e,e.infrastructure);assert.equal(t.reusedFromAction,f.parentAction);assert.equal(t.action,f.parentAction);
  assert.equal(t.knownHosts,e.trust.address+" "+e.trust.hostPublicKey+"\n");
  assert.throws(()=>retainedRuntimeBrowserTrust(e,{...e.infrastructure,instanceArn:"another"}));
});

test("wrong failure, changed receipt bytes, private scope or retained key cannot authorize runtime restoration",()=> {
  assert.throws(()=>runtimeParentReceipts({}));
  assert.throws(()=>runtimeParentReceipts(Object.fromEntries(Object.keys(EXISTING_RUNTIME.receiptsSha256).map(k=>[k,Buffer.from("{}")]))));
  for(const mutate of [e=>{e.error.failureCode="OTHER";},e=>{e.outcome.phase="bootstrap";},e=>{e.trust.hostMachineId="0".repeat(32);},
    e=>{e.receiptsSha256["action-outcome.json"]="0".repeat(64);},e=>{e.infrastructure.browserSshEnabled=false;}]) {
    const e=owned();mutate(e);assert.throws(()=>validateRuntimeParent(e));
  }
  assert.throws(()=>runtimeContinuationPlan({action:EXISTING_RUNTIME.action,inputManifestSha256:"0".repeat(64)},owned(),50));
  assert.throws(()=>runtimeContinuationPlan({action:EXISTING_RUNTIME.action,inputManifestSha256:EXISTING_RUNTIME.inputManifestSha256},owned(),51));
  const e=owned();e.trust.fingerprint="SHA256:"+"a".repeat(43);assert.throws(()=>retainedRuntimeBrowserTrust(e,e.infrastructure));
});
