// One deliberate continuation of the recorded snapshot-response failure.
// No stop, snapshot creation, provider mutation or credential access here.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

export const CONTINUATION=Object.freeze({
  action:"p1-recreate-access-20261103-c1",parentAction:"p1-recreate-access-20261103",
  parentSourceCommit:"40390f6ddc8a4dac8b282fa45d2a90b0d5b13fe4",
  snapshotName:"p1-recreate-access-20261103-original",
  snapshotArn:"arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/a9d51e18-1494-4b6a-ab98-d8936f40c33d",
  receiptsSha256:Object.freeze({
    "original-stop-completed.json":"970fbf61d029b11ade0c6e679f1a0ee27432dbddce6ed6b0d4502a3d28796f98",
    "original-snapshot-started.json":"bab88946d8426876d00b5d8b809c7575fd005b83764f0b57673048486ae40a29",
    "action-outcome.json":"97ad912797210fd4fad30a2c482009a631ab951d01518820d047000cf3934152",
  }),
});

export function validateContinuationParent(value) {
  assert.equal(value.parentAction,CONTINUATION.parentAction);
  assert.deepEqual(value.receiptsSha256,CONTINUATION.receiptsSha256,"Exact retained failure receipts required");
  const {stop,started,outcome}=value;
  assert.equal(outcome.action,CONTINUATION.parentAction);assert.equal(outcome.sourceCommit,CONTINUATION.parentSourceCommit);
  assert.equal(outcome.status,"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW");assert.equal(outcome.phase,"snapshot-original");
  assert.ok(Number.isSafeInteger(outcome.startedAt)&&Number.isSafeInteger(outcome.completedAt)&&outcome.completedAt>outcome.startedAt);
  for(const flag of ["productionChanged","migrationsExecuted","trafficAuthorized","releaseAccepted"])assert.equal(outcome[flag],false);
  assert.equal(started.action,CONTINUATION.parentAction);assert.equal(started.snapshotName,CONTINUATION.snapshotName);
  assert.ok(Number.isSafeInteger(started.startedAt)&&started.startedAt>=outcome.startedAt&&started.startedAt<=outcome.completedAt);
  assert.equal(started.instanceArn,stop.instanceArn);assert.equal(stop.instanceState,"stopped");assert.equal(stop.forcedStop,false);
  assert.equal(stop.status,"STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY");
  return value;
}

export function continuationParentReceipts(files) {
  assert.deepEqual(Object.keys(files).sort(),Object.keys(CONTINUATION.receiptsSha256).sort());
  const values={},receiptsSha256={};
  for(const [name,raw] of Object.entries(files)) {
    assert.ok(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=100000);
    receiptsSha256[name]=createHash("sha256").update(raw).digest("hex");
    assert.equal(receiptsSha256[name],CONTINUATION.receiptsSha256[name],"Retained parent bytes changed");
    values[name]=JSON.parse(raw.toString("utf8"));
  }
  return validateContinuationParent({parentAction:CONTINUATION.parentAction,receiptsSha256,
    stop:values["original-stop-completed.json"],started:values["original-snapshot-started.json"],outcome:values["action-outcome.json"]});
}

export function continuationPlan(plan,evidence) {
  validateContinuationParent(evidence);assert.equal(plan.action,CONTINUATION.action);
  const detach=plan.steps.indexOf("detach-static-address");assert.ok(detach>=0);
  return {...plan,operation:"continue-existing-stopped-snapshot",originalHostSnapshotName:CONTINUATION.snapshotName,
    existingSnapshotArn:CONTINUATION.snapshotArn,continuationOf:CONTINUATION.parentAction,
    parentSourceCommit:CONTINUATION.parentSourceCommit,parentReceiptsSha256:evidence.receiptsSha256,
    stopRequestIncluded:false,snapshotCreationIncluded:false,
    steps:["verify-provider-producers-and-held-inputs","verify-recorded-stopped-original-and-existing-regional-snapshot",
      ...plan.steps.slice(detach)]};
}
