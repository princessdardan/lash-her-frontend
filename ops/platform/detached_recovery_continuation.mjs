// Fixed continuation of the completed detach / provider-started source failure.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {CONTINUATION} from "./access_recovery_continuation.mjs";

export const DETACHED_CONTINUATION=Object.freeze({
  action:"p1-recreate-access-20261103-c2",parentAction:CONTINUATION.action,
  parentSourceCommit:"0a53a074b03791caba80f61e2aa9f0060dd8afed",
  snapshotStartedAt:1793729257262,snapshotName:CONTINUATION.snapshotName,snapshotArn:CONTINUATION.snapshotArn,
  changeSetId:"arn:aws:cloudformation:us-east-1:691588646557:changeSet/p1-recreate-access-20261103-c1-detached/532a1bef-f028-4943-bcd0-130facaac3ae",
  receiptsSha256:Object.freeze({
    "action-outcome.json":"4c0fb6adfb82c8cd9febdc492998e9a1cf3b9b8f4ce2ca8ff68db802a40aca8d",
    "original-stop-completed.json":"970fbf61d029b11ade0c6e679f1a0ee27432dbddce6ed6b0d4502a3d28796f98",
    "original-snapshot-completed.json":"e2066bddefef42e0acb72447382992856c7bcc960d54718bfcb22e67080156d8",
    "p1-recreate-access-20261103-c1-detached-review.json":"17002a84e6b748014c24da8b182c61863b9d59b71fc8154c73da7b44198acc0f",
    "p1-recreate-access-20261103-c1-detached-execute-started.json":"5dd62fcd4fb184b724d9d0c9da542ce0fce91cbe4c955f7142bcf9aa02a9d2b2",
    "existing-stopped-snapshot-adopted.json":"47cbd54469be7f678855322d09dbda020512528236376f4185ab0bc7b8f0bdf1",
  }),
});

export function validateDetachedParent(value) {
  const fixed=DETACHED_CONTINUATION;
  assert.equal(value.parentAction,fixed.parentAction);assert.deepEqual(value.receiptsSha256,fixed.receiptsSha256);
  const {outcome,stop,snapshot,review,started,adopted}=value;
  assert.equal(outcome.action,fixed.parentAction);assert.equal(outcome.sourceCommit,fixed.parentSourceCommit);
  assert.equal(outcome.status,"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW");assert.equal(outcome.phase,"infrastructure-detached");
  assert.equal(outcome.failureCode,"REVIEWED_STATE_ASSERTION_FAILED");
  for(const flag of ["productionChanged","migrationsExecuted","trafficAuthorized","releaseAccepted"])assert.equal(outcome[flag],false);
  assert.equal(stop.status,"STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY");assert.equal(stop.instanceState,"stopped");assert.equal(stop.forcedStop,false);
  assert.equal(snapshot.status,"STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE");assert.equal(snapshot.snapshotArn,fixed.snapshotArn);
  assert.equal(snapshot.snapshotName,fixed.snapshotName);assert.equal(snapshot.fromInstanceArn,stop.instanceArn);
  assert.equal(snapshot.privateRootDiskIncluded,true);assert.equal(snapshot.snapshotContentsFetched,false);
  assert.equal(review.status,"STAGING_LIFECYCLE_CHANGE_SET_REVIEWED");assert.equal(review.from,"attached");assert.equal(review.to,"detached");
  assert.equal(review.changeSetId,fixed.changeSetId);assert.equal(review.snapshotArn,fixed.snapshotArn);
  assert.equal(review.before.instanceArn,stop.instanceArn);assert.equal(review.before.instanceState,"stopped");
  assert.equal(started.action,fixed.parentAction);assert.equal(started.changeSetId,fixed.changeSetId);
  assert.equal(started.from,"initial");assert.equal(started.to,"detached");
  assert.equal(adopted.parentAction,CONTINUATION.parentAction);assert.deepEqual(adopted.parentReceiptsSha256,CONTINUATION.receiptsSha256);
  assert.equal(adopted.snapshotArn,fixed.snapshotArn);assert.equal(adopted.mutationsPerformed,false);
  return value;
}

export function detachedParentReceipts(files) {
  const fixed=DETACHED_CONTINUATION,values={},receiptsSha256={};
  assert.deepEqual(Object.keys(files).sort(),Object.keys(fixed.receiptsSha256).sort());
  for(const [name,raw] of Object.entries(files)) {
    assert.ok(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=100000);
    receiptsSha256[name]=createHash("sha256").update(raw).digest("hex");assert.equal(receiptsSha256[name],fixed.receiptsSha256[name]);
    values[name]=JSON.parse(raw.toString("utf8"));
  }
  return validateDetachedParent({parentAction:fixed.parentAction,receiptsSha256,outcome:values["action-outcome.json"],
    stop:values["original-stop-completed.json"],snapshot:values["original-snapshot-completed.json"],
    review:values[fixed.parentAction+"-detached-review.json"],started:values[fixed.parentAction+"-detached-execute-started.json"],
    adopted:values["existing-stopped-snapshot-adopted.json"]});
}

export function detachedContinuationPlan(plan,evidence) {
  validateDetachedParent(evidence);assert.equal(plan.action,DETACHED_CONTINUATION.action);
  const remove=plan.steps.indexOf("delete-original-compute");assert.ok(remove>=0);
  return {...plan,operation:"continue-detached-provider-started-source",continuationOf:DETACHED_CONTINUATION.parentAction,
    parentSourceCommit:DETACHED_CONTINUATION.parentSourceCommit,parentReceiptsSha256:evidence.receiptsSha256,
    originalHostSnapshotName:DETACHED_CONTINUATION.snapshotName,existingSnapshotArn:DETACHED_CONTINUATION.snapshotArn,
    stopRequestIncluded:true,snapshotCreationIncluded:false,detachUpdateIncluded:false,
    steps:["verify-provider-producers-and-held-inputs","verify-completed-detach-and-existing-snapshot",
      "normally-stop-provider-started-original-without-force",...plan.steps.slice(remove)]};
}
