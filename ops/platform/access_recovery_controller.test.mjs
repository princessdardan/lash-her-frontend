import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {accessRecoveryController} from "./access_recovery_controller.mjs";
import {accessRecoverySpec,stoppedOriginal} from "./access_recovery.mjs";
import {CONTINUATION,continuationParentReceipts,continuationPlan,validateContinuationParent} from "./access_recovery_continuation.mjs";
import {DETACHED_CONTINUATION,detachedParentReceipts,detachedContinuationPlan} from "./detached_recovery_continuation.mjs";

const body=readFileSync(new URL("../aws/lightsail-access-recovery.cfn.json",import.meta.url),"utf8");
const addressArn="arn:aws:lightsail:us-east-1:691588646557:StaticIp/dfdce3fc-150b-47c0-87df-2bffeb81e963";
const original="arn:aws:lightsail:us-east-1:691588646557:Instance/2e608d2c-a88f-416f-a23f-209d20e042f4";
const fresh=original.replace("2e608d2c-a88f-416f-a23f-209d20e042f4","22222222-2222-4222-8222-222222222222");
const stack="arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733";
const modify=(name,property)=>({Type:"Resource",ResourceChange:{LogicalResourceId:name,ResourceType:name==="ApiHost"?"AWS::Lightsail::Instance":"AWS::Lightsail::StaticIp",
  Action:"Modify",Replacement:"False",Scope:["Properties"],Details:[{Target:{Attribute:"Properties",Name:property,RequiresRecreation:"Never"}}]}});

function owned(options={}) {
  const action=options.detached?DETACHED_CONTINUATION.action:options.continuation?CONTINUATION.action:"p1-recreate-access-owned";
  let current=options.detached?"detached":"initial",instanceState=options.continuation?"stopped":"running",change,clock=Date.parse(options.detached?"2026-11-03T18:50:00Z":"2026-11-03T00:00:00Z");
  const calls=[],records=[],observations=[];
  const observe=async (_aws,spec,phase,expected)=> {
    observations.push({phase,expected});assert.ok(phase===current||phase==="ready"&&current==="verify-key");
    if(phase!=="absent")assert.equal(instanceState,["initial","detached"].includes(phase)?expected:"running");
    return {status:"STAGING_INFRASTRUCTURE_STATE_VERIFIED",state:phase==="initial"||["verify-key","ready"].includes(phase)?"attached":phase,
      accessRecoveryPhase:phase,instanceState:phase==="absent"?null:instanceState,stackId:stack,addressArn,address:spec.address,
      instanceArn:phase==="absent"?null:["verify-key","ready"].includes(phase)?fresh:original,
      allocationPreserved:true,browserSshEnabled:["verify-key","ready"].includes(phase)};
  };
  const aws=async request=> {
    calls.push(request);const p=request.params;
    if(request.operation==="StopInstance") {
      assert.equal(records.at(-1)[0],options.detached?"detached-original-stop-started":"original-stop-started");assert.equal(p.force,undefined);
      if(options.uncertainStop)throw Error("uncertain");instanceState="stopped";
      return {operations:[{resourceName:"lash-her-api-staging-host",resourceType:"Instance",operationType:"StopInstance",status:"Started"}]};
    }
    if(request.operation==="GetInstances")return {instances:[{name:"lash-her-api-staging-host",arn:original,state:{name:instanceState}}]};
    if(request.operation==="GetInstanceSnapshots")return {instanceSnapshots:[]};
    if(request.operation==="CreateInstanceSnapshot") {
      assert.equal(records.at(-1)[0],"original-snapshot-started");
      const operations=[{resourceName:action+"-original",resourceType:"InstanceSnapshot",operationType:"CreateInstanceSnapshot",status:"Started"},
        {resourceName:"lash-her-api-staging-host",resourceType:"Instance",operationType:"CreateInstanceSnapshot",status:"Started"}];
      if(options.badSnapshotOperation)operations[1].resourceName="unreviewed-host";
      if(options.duplicateSnapshotOperation)operations[1]={...operations[0]};
      if(options.failedSnapshotOperation)operations[1].status="Failed";
      return {operations};
    }
    if(request.operation==="GetInstanceSnapshot")return {instanceSnapshot:{name:options.continuation||options.detached?CONTINUATION.snapshotName:action+"-original",state:options.badSnapshot?"error":"available",
      arn:(options.continuation||options.detached)&&!options.wrongSnapshotArn?CONTINUATION.snapshotArn:"arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/33333333-3333-4333-8333-333333333333",
      fromInstanceArn:original,fromInstanceName:"lash-her-api-staging-host",fromBundleId:"medium_3_0",fromBlueprintId:"ubuntu_24_04",
      location:{regionName:"us-east-1",availabilityZone:"all"},resourceType:"InstanceSnapshot",isFromAutoSnapshot:false,
      createdAt:options.detached?"2026-11-03T13:07:38.143000-05:00":clock/1000,tags:[{key:"Project",value:"lash-her"},{key:"Environment",value:"staging"},{key:"Purpose",value:"operator-access-recovery"}]}};
    if(request.operation==="CreateChangeSet") {
      assert.ok(records.some(r=>r[0]==="original-snapshot-completed"));assert.ok(records.at(-1)[0].endsWith("-create-started"));
      const to=p.ChangeSetName.slice(action.length+1);
      change={StackId:stack,ChangeSetId:`arn:aws:cloudformation:us-east-1:691588646557:changeSet/${p.ChangeSetName}/44444444-4444-4444-8444-444444444444`,
        Status:"CREATE_COMPLETE",ExecutionStatus:"AVAILABLE",Parameters:p.Parameters,
        Changes:to==="detached"?[modify("ApiHost","UserData"),modify("GatewayAddress","AttachedTo")]:to==="ready"?[modify("ApiHost","Networking")]:
          [{Type:"Resource",ResourceChange:{LogicalResourceId:"ApiHost",ResourceType:"AWS::Lightsail::Instance",Action:to==="absent"?"Remove":"Add"}},
            ...(to==="verify-key"?[modify("GatewayAddress","AttachedTo")]:[])]};
      return {StackId:stack,Id:change.ChangeSetId};
    }
    if(request.operation==="DescribeChangeSet")return change;
    if(request.operation==="GetTemplate")return {TemplateBody:body};
    if(request.operation==="DescribeEvents")return {OperationEvents:[{StackId:stack,OperationId:change.ChangeSetId.split("/").at(-1),
      OperationType:"CREATE_CHANGESET",EventType:"STACK_EVENT",OperationStatus:"SUCCEEDED"}]};
    if(request.operation==="ExecuteChangeSet") {
      assert.equal(p.DisableRollback,true);assert.ok(records.at(-1)[0].endsWith("-execute-started"));
      if(options.uncertainExecute)throw Error("uncertain");
      current=change.ChangeSetId.split("/")[1].slice(action.length+1);if(current==="verify-key")instanceState="running";return {};
    }
    if(request.operation==="DescribeStacks")return {Stacks:[{StackId:stack,StackStatus:"UPDATE_COMPLETE"}]};
    throw Error("Unexpected owned API");
  };
  const controller=accessRecoveryController({templateBody:body,addressArn,currentCidr:"99.239.187.88/32",action,aws,
    record:async(...r)=>records.push(r),verifyProducers:async()=>{if(options.badProducers)throw Error("Producer drift");},
    confirmation:"staging/"+action,now:()=>clock,sleep:async ms=>{clock+=ms;},observe});
  return {controller,calls,records,observations,observe,clock};
}

test("recovery requires stopped source and available snapshot before any CloudFormation mutation",async()=> {
  const f=owned();await assert.rejects(f.controller.step("detached"));assert.equal(f.calls.length,0);
  const stopped=await f.controller.stopOriginal();assert.equal(stopped.perContainerGracefulExitObserved,false);
  await assert.rejects(f.controller.step("detached"));assert.ok(!f.calls.some(r=>r.operation==="CreateChangeSet"));
  await f.controller.snapshotOriginal();
  for(const to of ["detached","absent","verify-key"])await f.controller.step(to);
  await assert.rejects(f.controller.step("ready"));
});

test("verified browser recovery is retained on the same new instance without an extra mutation",async()=> {
  const f=owned();await f.controller.stopOriginal();await f.controller.snapshotOriginal();
  for(const to of ["detached","absent","verify-key"])await f.controller.step(to);
  const after=await f.controller.step("ready",{method:"authenticated-aws-browser",accountId:"691588646557",instanceArn:fresh,
    address:"184.196.129.231",browserAccountVerified:true,keyPinnedBeforePrivateTransfer:true});
  assert.equal(after.instanceArn,fresh);assert.equal(after.browserSshEnabled,true);
  assert.equal(f.calls.filter(c=>c.operation==="ExecuteChangeSet").length,3);
  assert.ok(!f.calls.some(c=>["DeleteStack","ReleaseStaticIp","DeleteInstance"].includes(c.operation)));
});

test("uncertain mutation responses are recorded once and cannot be silently retried",async()=> {
  const f=owned({uncertainStop:true});await assert.rejects(f.controller.stopOriginal());await assert.rejects(f.controller.stopOriginal());
  assert.equal(f.calls.filter(c=>c.operation==="StopInstance").length,1);
  const g=owned({uncertainExecute:true});await g.controller.stopOriginal();await g.controller.snapshotOriginal();
  await assert.rejects(g.controller.step("detached"));await assert.rejects(g.controller.step("detached"));
  assert.equal(g.calls.filter(c=>c.operation==="ExecuteChangeSet").length,1);
});

test("producer drift or snapshot failure cannot delete compute",async()=> {
  const f=owned({badProducers:true});await assert.rejects(f.controller.stopOriginal());assert.equal(f.calls.length,0);
  const g=owned({badSnapshot:true});await g.controller.stopOriginal();await assert.rejects(g.controller.snapshotOriginal());
  await assert.rejects(g.controller.step("detached"));assert.ok(!g.calls.some(c=>c.operation==="CreateChangeSet"));
});

test("the documented paired snapshot operations are retained and any wrong, duplicate or failed source operation prevents removal",async()=> {
  const good=owned();await good.controller.stopOriginal();await good.controller.snapshotOriginal();
  assert.equal(good.records.find(r=>r[0]==="original-snapshot-operation-observed")[1].operations.length,2);
  for(const options of [{badSnapshotOperation:true},{duplicateSnapshotOperation:true},{failedSnapshotOperation:true}]) {
    const f=owned(options);await f.controller.stopOriginal();await assert.rejects(f.controller.snapshotOriginal());
    await assert.rejects(f.controller.step("detached"));assert.ok(!f.calls.some(c=>c.operation==="CreateChangeSet"));
    assert.equal(f.calls.filter(c=>c.operation==="CreateInstanceSnapshot").length,1);
  }
});

async function parentEvidence(f) {
  const spec=accessRecoverySpec(body,addressArn,"99.239.187.88/32","initial");
  return {parentAction:CONTINUATION.parentAction,receiptsSha256:{...CONTINUATION.receiptsSha256},
    stop:stoppedOriginal(await f.observe(null,spec,"initial","stopped"),spec),
    started:{action:CONTINUATION.parentAction,instanceArn:original,snapshotName:CONTINUATION.snapshotName,startedAt:f.clock-1000},
    outcome:{action:CONTINUATION.parentAction,sourceCommit:CONTINUATION.parentSourceCommit,status:"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW",
      phase:"snapshot-original",startedAt:f.clock-2000,completedAt:f.clock,productionChanged:false,migrationsExecuted:false,trafficAuthorized:false,releaseAccepted:false}};
}

test("deliberate continuation reads the exact stopped source and existing regional snapshot without another stop or snapshot creation",async()=> {
  const f=owned({continuation:true}),evidence=await parentEvidence(f);
  const retained=await f.controller.adoptStoppedSnapshot(evidence);assert.equal(retained.recoverySnapshot.snapshotArn,CONTINUATION.snapshotArn);
  assert.deepEqual(f.calls.map(c=>c.operation),["GetInstanceSnapshot"]);
  await assert.rejects(f.controller.stopOriginal());await assert.rejects(f.controller.snapshotOriginal());await assert.rejects(f.controller.adoptStoppedSnapshot(evidence));
  for(const step of ["detached","absent","verify-key"])await f.controller.step(step);
  assert.ok(!f.calls.some(c=>["StopInstance","CreateInstanceSnapshot"].includes(c.operation)));
});

test("changed parent receipts, a different failure phase or wrong existing snapshot refuse before compute mutation",async()=> {
  for(const mutate of [e=>{e.receiptsSha256["action-outcome.json"]="0".repeat(64);},e=>{e.outcome.phase="infrastructure-detached";},
    e=>{e.outcome.sourceCommit="0".repeat(40);},e=>{e.started.startedAt=e.outcome.completedAt+1;}]) {
    const f=owned({continuation:true}),e=await parentEvidence(f);mutate(e);
    await assert.rejects(f.controller.adoptStoppedSnapshot(e));assert.equal(f.calls.length,0);
  }
  const f=owned({continuation:true,wrongSnapshotArn:true});await assert.rejects(f.controller.adoptStoppedSnapshot(await parentEvidence(f)));
  assert.ok(!f.calls.some(c=>c.operation==="CreateChangeSet"));
});

test("parent input requires all exact recorded bytes and continuation plans remove stop and snapshot creation",async()=> {
  assert.throws(()=>continuationParentReceipts({}));
  assert.throws(()=>continuationParentReceipts(Object.fromEntries(Object.keys(CONTINUATION.receiptsSha256).map(k=>[k,Buffer.from("{}")]))));
  const f=owned({continuation:true}),e=await parentEvidence(f);assert.equal(validateContinuationParent(e),e);
  const plan=continuationPlan({action:CONTINUATION.action,steps:["stop-original-without-force","snapshot-stopped-original","detach-static-address","delete-original-compute"]},e);
  assert.equal(plan.stopRequestIncluded,false);assert.equal(plan.snapshotCreationIncluded,false);
  assert.equal(plan.originalHostSnapshotName,CONTINUATION.snapshotName);assert.ok(!plan.steps.includes("snapshot-stopped-original"));
});

function detachedEvidence() {
  const fixed=DETACHED_CONTINUATION;
  return {parentAction:fixed.parentAction,receiptsSha256:{...fixed.receiptsSha256},
    outcome:{action:fixed.parentAction,sourceCommit:fixed.parentSourceCommit,status:"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW",
      phase:"infrastructure-detached",failureCode:"REVIEWED_STATE_ASSERTION_FAILED",productionChanged:false,migrationsExecuted:false,trafficAuthorized:false,releaseAccepted:false},
    stop:{status:"STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY",instanceState:"stopped",forcedStop:false,instanceArn:original},
    snapshot:{status:"STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE",snapshotArn:fixed.snapshotArn,snapshotName:fixed.snapshotName,
      fromInstanceArn:original,createdAt:"2026-11-03T13:07:38.143000-05:00",privateRootDiskIncluded:true,snapshotContentsFetched:false,cleanupRequiresSuccessfulRecovery:true},
    review:{status:"STAGING_LIFECYCLE_CHANGE_SET_REVIEWED",from:"attached",to:"detached",changeSetId:fixed.changeSetId,
      snapshotArn:fixed.snapshotArn,before:{instanceArn:original,instanceState:"stopped"}},
    started:{action:fixed.parentAction,changeSetId:fixed.changeSetId,from:"initial",to:"detached"},
    adopted:{parentAction:CONTINUATION.parentAction,parentReceiptsSha256:{...CONTINUATION.receiptsSha256},snapshotArn:fixed.snapshotArn,mutationsPerformed:false}};
}

test("detached continuation verifies read-only, stops the provider-started original once and skips the completed detach update",async()=> {
  const f=owned({detached:true}),e=detachedEvidence();
  const before=await f.controller.verifyDetachedSnapshot(e);assert.equal(before.before.instanceState,"running");
  assert.deepEqual(f.calls.map(c=>c.operation),["GetInstanceSnapshot"]);
  await f.controller.adoptDetachedSnapshot(e);
  await assert.rejects(f.controller.adoptDetachedSnapshot(e));await assert.rejects(f.controller.stopOriginal());await assert.rejects(f.controller.snapshotOriginal());
  await assert.rejects(f.controller.step("detached"));
  for(const step of ["absent","verify-key"])await f.controller.step(step);
  assert.equal(f.calls.filter(c=>c.operation==="StopInstance").length,1);
  assert.equal(f.calls.filter(c=>c.operation==="ExecuteChangeSet").length,2);
  assert.ok(!f.calls.some(c=>c.operation==="CreateInstanceSnapshot"||c.params.ChangeSetName?.endsWith("-detached")));
});

test("detached continuation rejects changed parent or snapshot and uncertain stop cannot proceed to removal or retry",async()=> {
  for(const mutate of [e=>{e.receiptsSha256["action-outcome.json"]="0".repeat(64);},e=>{e.started.to="absent";},
    e=>{e.outcome.sourceCommit="0".repeat(40);},e=>{e.review.changeSetId="another";}]) {
    const f=owned({detached:true}),e=detachedEvidence();mutate(e);await assert.rejects(f.controller.adoptDetachedSnapshot(e));assert.equal(f.calls.length,0);
  }
  const bad=owned({detached:true,wrongSnapshotArn:true});await assert.rejects(bad.controller.adoptDetachedSnapshot(detachedEvidence()));
  assert.ok(!bad.calls.some(c=>["StopInstance","CreateChangeSet"].includes(c.operation)));
  const uncertain=owned({detached:true,uncertainStop:true});await assert.rejects(uncertain.controller.adoptDetachedSnapshot(detachedEvidence()));
  await assert.rejects(uncertain.controller.adoptDetachedSnapshot(detachedEvidence()));await assert.rejects(uncertain.controller.step("absent"));
  assert.equal(uncertain.calls.filter(c=>c.operation==="StopInstance").length,1);assert.ok(!uncertain.calls.some(c=>c.operation==="CreateChangeSet"));
});

test("detached parent byte pins and plan cannot select another snapshot or repeat detach",()=> {
  assert.throws(()=>detachedParentReceipts({}));
  assert.throws(()=>detachedParentReceipts(Object.fromEntries(Object.keys(DETACHED_CONTINUATION.receiptsSha256).map(k=>[k,Buffer.from("{}")]))));
  const plan=detachedContinuationPlan({action:DETACHED_CONTINUATION.action,steps:["detach-static-address","delete-original-compute","create-new"]},detachedEvidence());
  assert.equal(plan.stopRequestIncluded,true);assert.equal(plan.snapshotCreationIncluded,false);assert.equal(plan.detachUpdateIncluded,false);
  assert.ok(!plan.steps.includes("detach-static-address"));assert.equal(plan.originalHostSnapshotName,CONTINUATION.snapshotName);
});
