import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {accessRecoveryController} from "./access_recovery_controller.mjs";

const body=readFileSync(new URL("../aws/lightsail-access-recovery.cfn.json",import.meta.url),"utf8");
const action="p1-recreate-access-owned",addressArn="arn:aws:lightsail:us-east-1:691588646557:StaticIp/dfdce3fc-150b-47c0-87df-2bffeb81e963";
const original="arn:aws:lightsail:us-east-1:691588646557:Instance/2e608d2c-a88f-416f-a23f-209d20e042f4";
const fresh=original.replace("2e608d2c-a88f-416f-a23f-209d20e042f4","22222222-2222-4222-8222-222222222222");
const stack="arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733";
const modify=(name,property)=>({Type:"Resource",ResourceChange:{LogicalResourceId:name,ResourceType:name==="ApiHost"?"AWS::Lightsail::Instance":"AWS::Lightsail::StaticIp",
  Action:"Modify",Replacement:"False",Scope:["Properties"],Details:[{Target:{Attribute:"Properties",Name:property,RequiresRecreation:"Never"}}]}});

function owned(options={}) {
  let current="initial",instanceState="running",change,clock=Date.parse("2026-11-03T00:00:00Z");
  const calls=[],records=[],observations=[];
  const observe=async (_aws,spec,phase,expected)=> {
    observations.push({phase,expected});assert.ok(phase===current||phase==="ready"&&current==="verify-key");
    if(phase!=="absent")assert.equal(instanceState,phase==="initial"?expected:phase==="detached"?"stopped":"running");
    return {status:"STAGING_INFRASTRUCTURE_STATE_VERIFIED",state:phase==="initial"||["verify-key","ready"].includes(phase)?"attached":phase,
      accessRecoveryPhase:phase,instanceState:phase==="absent"?null:instanceState,stackId:stack,addressArn,address:spec.address,
      instanceArn:phase==="absent"?null:["verify-key","ready"].includes(phase)?fresh:original,
      allocationPreserved:true,browserSshEnabled:["verify-key","ready"].includes(phase)};
  };
  const aws=async request=> {
    calls.push(request);const p=request.params;
    if(request.operation==="StopInstance") {
      assert.equal(records.at(-1)[0],"original-stop-started");assert.equal(p.force,undefined);
      if(options.uncertainStop)throw Error("uncertain");instanceState="stopped";
      return {operations:[{resourceName:"lash-her-api-staging-host",operationType:"StopInstance",status:"Started"}]};
    }
    if(request.operation==="GetInstances")return {instances:[{name:"lash-her-api-staging-host",arn:original,state:{name:instanceState}}]};
    if(request.operation==="GetInstanceSnapshots")return {instanceSnapshots:[]};
    if(request.operation==="CreateInstanceSnapshot") {
      assert.equal(records.at(-1)[0],"original-snapshot-started");
      return {operations:[{resourceName:action+"-original",operationType:"CreateInstanceSnapshot",status:"Started"}]};
    }
    if(request.operation==="GetInstanceSnapshot")return {instanceSnapshot:{name:action+"-original",state:options.badSnapshot?"error":"available",
      arn:"arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/33333333-3333-4333-8333-333333333333",
      fromInstanceArn:original,fromInstanceName:"lash-her-api-staging-host",fromBundleId:"medium_3_0",fromBlueprintId:"ubuntu_24_04",
      location:{regionName:"us-east-1",availabilityZone:"us-east-1a"},resourceType:"InstanceSnapshot",isFromAutoSnapshot:false,
      createdAt:clock/1000,tags:[{key:"Project",value:"lash-her"},{key:"Environment",value:"staging"},{key:"Purpose",value:"operator-access-recovery"}]}};
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
  return {controller,calls,records,observations};
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
