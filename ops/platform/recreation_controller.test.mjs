import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,stat} from "node:fs/promises";
import {readFileSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {executeRecreation} from "./recreation_controller.mjs";
import {sha256,manifestSha256} from "./recreation_inputs.mjs";
import {stagingInfrastructureSpec} from "./infrastructure.mjs";
import {hostTemplateSha256} from "./host_lifecycle.mjs";

const templateBody=readFileSync(new URL("../aws/lightsail-host.cfn.json",import.meta.url),"utf8");
const spec=stagingInfrastructureSpec(templateBody,hostTemplateSha256(templateBody),"arn:aws:lightsail:us-east-1:691588646557:StaticIp/11111111-1111-4111-8111-111111111111");
const services={"gateway":"gateway","course-api":"courseRuntime","course-tls":"gateway","course-publisher":"courseRuntime",
  "course-snapshot":"courseRuntime","community-api":"communityRuntime","community-tls":"gateway","community-worker":"communityRuntime"};
const bytes=value=>Buffer.from(JSON.stringify(value)+"\n");

async function fixture(t,options={}) {
  const root=await mkdtemp(join(realpathSync(tmpdir()),"lash-recreation-owned-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,"action"),events=[],providerCalls=[],saved=new Map();
  const action="p1-recreate-owned",releaseId="p1-41541683416-1";
  const selected={environment:"staging",releaseId,artifacts:Object.fromEntries(["gateway","courseRuntime","communityRuntime","frontendMigration","courseMigration","communityMigration"]
    .map(key=>[key,{image:`ghcr.io/princessdardan/lash-her-platform-${key.toLowerCase()}@sha256:${sha256(key)}`}]))};
  const inputs={selected,candidateSha256:"a".repeat(64),migrationOutcomeSha256:"b".repeat(64),checkerSha256:"c".repeat(64),
    previousSha256:"d".repeat(64),proofSha256:"e".repeat(64),configurationSha256:{owned:"f".repeat(64)},files:[{path:"owned.json",sha256:"a".repeat(64),data:"e30="}]};
  inputs.manifestSha256=manifestSha256(inputs.files);
  const ready=(phase,machine)=>({status:"API_RUNTIME_RESTORED_FOR_QUALIFICATION",phase:"completed",environment:"staging",releaseId,
    hostMachineId:machine,candidateSha256:inputs.candidateSha256,migrationOutcomeSha256:inputs.migrationOutcomeSha256,
    trafficAuthorized:false,releaseAccepted:false,containers:Object.entries(services).map(([service,key])=>({service,
      containerId:sha256(phase+service),image:selected.artifacts[key].image}))});
  const current=ready("rollback",spec.originalMachineId),currentBytes=bytes(current);
  const retired={status:"STAGING_RUNTIME_QUIESCED_FOR_RECREATION",environment:"staging",originalHostMachineId:spec.originalMachineId,
    candidateSha256:inputs.candidateSha256,migrationOutcomeSha256:inputs.migrationOutcomeSha256,runtimeReceiptSha256:sha256(currentBytes),
    trafficAuthorized:false,nativeSchedulesDisabled:true,externalProducersSuspended:true,publicIngressStopped:true,hostTimersStopped:true,
    stoppedContainers:current.containers.map(c=>({...c,running:false,exitCode:0,oomKilled:false}))};
  if(options.badStop)retired.stoppedContainers[0].exitCode=137;
  saved.set("rollback",new Map([["rollback-outcome.json",bytes({status:"STAGING_COMPATIBLE_ROLLBACK_AND_CURRENT_RESTORE_VERIFIED"})],
    ["restored-current/runtime-outcome.json",currentBytes]]));
  const retirement=new Map([["retirement-outcome.json",bytes(retired)],
    ["pending-work/retained-work.json",bytes({status:"STAGING_DURABLE_WORK_RETAINED",events:[{eventId:"owned-lease"},{eventId:"owned-retry"}]})],
    ["pending-work/business-baseline.json",bytes({ownedPrivateKeyedFingerprint:"synthetic-private-business-summary"})]]);
  if(options.missingPending)retirement.delete("pending-work/business-baseline.json");
  saved.set("retirement",retirement);
  let state="attached",recreated=false,change=null;
  function providerState() {
    const present=state!=="absent",arn=recreated?spec.originalInstanceArn.replace("2e608d2c-a88f-416f-a23f-209d20e042f4","22222222-2222-4222-8222-222222222222"):spec.originalInstanceArn;
    return {GetCallerIdentity:{Account:spec.accountId},DescribeStacks:{Stacks:[{StackName:spec.stackName,StackId:spec.stackId,StackStatus:"UPDATE_COMPLETE",
      Parameters:Object.entries({Environment:"staging",HostState:state,...spec.parameters}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),
      Outputs:Object.entries({ApplicationEnvironment:"staging",GatewayIpv4:spec.address,...(present?{InstanceName:spec.instanceName,InstanceArn:arn}:{})})
        .map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]},
      ListStackResources:{StackResourceSummaries:[{LogicalResourceId:"GatewayAddress",PhysicalResourceId:spec.addressName,ResourceType:"AWS::Lightsail::StaticIp",ResourceStatus:"UPDATE_COMPLETE"},
        ...(present?[{LogicalResourceId:"ApiHost",PhysicalResourceId:spec.instanceName,ResourceType:"AWS::Lightsail::Instance",ResourceStatus:"CREATE_COMPLETE"}]:[])]},
      GetTemplate:{TemplateBody:templateBody},GetStaticIp:{staticIp:{arn:spec.addressArn,name:spec.addressName,ipAddress:spec.address,isAttached:state==="attached",
        ...(state==="attached"?{attachedTo:spec.instanceName}:{})}},
      GetInstances:{instances:present?[{name:spec.instanceName,arn,createdAt:"2026-11-03T05:00:01Z",blueprintId:"ubuntu_24_04",bundleId:spec.parameters.BundleId,
        sshKeyName:spec.parameters.KeyPairName,location:{availabilityZone:"us-east-1a",regionName:spec.region},state:{name:"running"},isStaticIp:state==="attached",publicIpAddress:spec.address}]:[]},
      GetInstancePortStates:{portStates:[22,443].map(port=>({protocol:"tcp",fromPort:port,toPort:port,state:"open",cidrs:[port===22?spec.parameters.OperatorIpv4Cidr:"0.0.0.0/0"],ipv6Cidrs:[],cidrListAliases:[]}))}};
  }
  const aws=async request=> {
    providerCalls.push(request);
    if(request.operation==="CreateChangeSet") {
      events.push("create-change-set");
      assert.equal((await stat(join(directory,"retirement/pending-work/business-baseline.json"))).mode&0o777,0o600);
      assert.equal((await readFile(join(directory,"retirement/retirement-outcome.json"))).toString(),bytes(retired).toString());
      const to=request.params.Parameters.find(p=>p.ParameterKey==="HostState").ParameterValue;
      const modify={Type:"Resource",ResourceChange:{LogicalResourceId:"GatewayAddress",ResourceType:"AWS::Lightsail::StaticIp",Action:"Modify",Replacement:"False",
        Scope:["Properties"],Details:[{Target:{Attribute:"Properties",Name:"AttachedTo",RequiresRecreation:"Never"}}]}};
      const host=Action=>({Type:"Resource",ResourceChange:{LogicalResourceId:"ApiHost",ResourceType:"AWS::Lightsail::Instance",Action}});
      change={StackId:spec.stackId,ChangeSetId:`arn:aws:cloudformation:us-east-1:691588646557:changeSet/${request.params.ChangeSetName}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        Status:"CREATE_COMPLETE",ExecutionStatus:"AVAILABLE",Parameters:request.params.Parameters,
        Changes:state==="attached"?[modify]:state==="detached"?[host("Remove")]:[host("Add"),modify],to};
      return {StackId:spec.stackId,Id:change.ChangeSetId};
    }
    if(request.operation==="DescribeChangeSet")return change;
    if(request.operation==="DescribeEvents")return {OperationEvents:[{StackId:spec.stackId,OperationId:change.ChangeSetId.split("/").at(-1),
      OperationType:"CREATE_CHANGESET",EventType:"STACK_EVENT",OperationStatus:"SUCCEEDED"}]};
    if(request.operation==="ExecuteChangeSet") {
      events.push("execute-"+change.to);
      if(options.uncertain)throw Error("OWNED_CFN_ACK_UNCERTAIN");
      if(state==="absent")recreated=true;state=change.to;return {};
    }
    return providerState()[request.operation];
  };
  const ssh=name=>({
    machine:async()=>({status:"SSH_MACHINE_ID_OBSERVED",machineId:name==="old"?spec.originalMachineId:"2".repeat(32)}),
    installSource:async()=>{events.push(name+"-source");return {status:"EXACT_OPERATOR_SOURCE_INSTALLED"};},
    privateFiles:async(_commit,payload)=> {
      if(payload.operation==="stage"){events.push(name+"-inputs");return {status:"RECREATION_PRIVATE_INPUTS_STAGED",manifestSha256:manifestSha256(payload.files)};}
      const files=saved.get(payload.phase);assert.ok(files,"Owned receipt phase exists");
      events.push(name+"-export-"+payload.phase);
      return {status:"RECREATION_EXACT_PRIVATE_RECEIPTS",phase:payload.phase,files:[...files].map(([path,raw])=>({path,sha256:sha256(raw),data:raw.toString("base64")}))};
    },
    prepare:async(_commit,payload)=> {
      events.push(name+"-"+payload.operation);
      const status=payload.operation==="bootstrap"?"RECREATION_FRESH_BOOTSTRAP_COMPLETE":"RECREATION_EXACT_IMAGES_CACHED";
      saved.set("prepare-"+payload.operation,new Map([["preparation-outcome.json",bytes({status})]]));return {status};
    },
    phase:async(_commit,payload)=> {
      events.push(name+"-"+payload.operation);
      if(payload.operation==="rollback")return {status:"STAGING_COMPATIBLE_ROLLBACK_AND_CURRENT_RESTORE_VERIFIED"};
      if(payload.operation==="retire")return {status:"STAGING_RUNTIME_QUIESCED_FOR_RECREATION"};
      if(options.restoreFailure) {
        if(options.terminalFailure)saved.set("restore",new Map([["restore-outcome.json",bytes({status:"FAILED_REQUIRES_REVIEW"})]]));
        throw Error("OWNED_RESTORE_REQUIRES_REVIEW");
      }
      const freshBytes=bytes(ready(options.reusedContainerIds?"rollback":"new-machine","2".repeat(32)));
      saved.set("restore",new Map([["runtime-outcome.json",freshBytes],["native-qualification/qualification-outcome.json",bytes({
        status:"NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE",restoredRuntimeReceiptSha256:sha256(freshBytes),
        nativeSchedulesDisabled:true,nativeSchedulerVerified:false,frontendDeploymentId:"dpl_ownedNew"})]]));
      return {status:"API_RUNTIME_RESTORED_FOR_QUALIFICATION"};
    },
    maintenance:async(_commit,payload)=> {
      events.push(name+"-maintenance-"+payload.operation);
      const status=payload.operation==="install"?"RECREATION_MAINTENANCE_INSTALLED_DISABLED":"RECREATION_MAINTENANCE_ACTIVE";
      saved.set("maintenance-"+payload.operation,new Map([["maintenance-outcome.json",bytes({status})]]));return {status};
    },
  });
  let clock=Date.parse("2026-11-03T05:00:00Z");
  const args={action,privateDirectory:directory,sourceCommit:"1".repeat(40),sourceFiles:[],inputs,programs:{},expectedDeployment:"dpl_ownedOriginal",
    privateFingerprintKey:"f".repeat(64),databaseCredentials:{frontend:"synthetic-private-db",course:"synthetic-private-db",community:"synthetic-private-db"},
    vercelToken:"synthetic-private-vercel-token",registry:{username:"princessdardan",token:"synthetic-private-registry-token"},spec,templateBody,packageLockSha256:"d".repeat(64),
    aws,oldSsh:ssh("old"),newSsh:ssh("new"),freshInventory:async phase=>{events.push("inventory-"+phase);return {sha256:sha256("{}"),data:"e30="};},
    establishTrust:async()=>{events.push("new-trust");},verifySource:async()=>({sourceCommit:"1".repeat(40),requiredChecks:"passed"}),
    now:()=>clock++,apply:true,confirmation:"staging/"+action};
  return {args,directory,events,providerCalls};
}

test("plan and absent confirmation cannot run AWS, SSH or private receipt export",async t=> {
  const f=await fixture(t);
  const plan=await executeRecreation({...f.args,apply:false,privateFingerprintKey:undefined});
  assert.equal(plan.executionAuthorized,false);assert.equal(f.events.length,0);assert.equal(f.providerCalls.length,0);
  await assert.rejects(executeRecreation({...f.args,confirmation:"production/owned"}),/Explicit complete staging/u);
  assert.equal(f.events.length,0);assert.equal(f.providerCalls.length,0);
});
test("complete ordered orchestration retains private work before real change-set gates and ends pending provider evidence",async t=> {
  const f=await fixture(t),result=await executeRecreation(f.args);
  assert.equal(result.status,"STAGING_HOST_RECREATED_AWAITING_PROVIDER_AND_EXTERNAL_EVIDENCE");
  assert.equal(result.nativeSchedulerVerified,false);assert.equal(result.releaseAccepted,false);
  assert.equal(f.providerCalls.filter(c=>c.operation==="ExecuteChangeSet").length,3);
  assert.ok(f.events.indexOf("old-export-retirement")<f.events.indexOf("execute-detached"));
  assert.ok(f.events.indexOf("execute-attached")<f.events.indexOf("new-trust"));
  assert.ok(f.events.indexOf("new-bootstrap")<f.events.indexOf("new-cache-current"));
  assert.ok(f.events.indexOf("new-maintenance-install")<f.events.indexOf("new-restore"));
  assert.ok(f.events.indexOf("new-export-restore")<f.events.indexOf("new-maintenance-activate"));
  const common=await readFile(join(f.directory,"action-outcome.json"),"utf8");
  for(const privateValue of ["synthetic-private-business-summary","synthetic-private-db","synthetic-private-vercel-token","synthetic-private-registry-token"])
    assert.ok(!common.includes(privateValue));
});
test("missing retained work or non-graceful stop prevents every AWS mutation",async t=> {
  for(const options of [{missingPending:true},{badStop:true}]) {
    const f=await fixture(t,options);await assert.rejects(executeRecreation(f.args));
    assert.equal(f.providerCalls.filter(c=>["CreateChangeSet","ExecuteChangeSet"].includes(c.operation)).length,0);
    assert.equal(JSON.parse(await readFile(join(f.directory,"action-outcome.json"),"utf8")).releaseAccepted,false);
  }
});
test("uncertain AWS acknowledgement is preserved without retry or another lifecycle transition",async t=> {
  const f=await fixture(t,{uncertain:true});await assert.rejects(executeRecreation(f.args),/OWNED_CFN_ACK_UNCERTAIN/u);
  assert.equal(f.providerCalls.filter(c=>c.operation==="ExecuteChangeSet").length,1);
  assert.equal(f.providerCalls.filter(c=>c.operation==="CreateChangeSet").length,1);
  assert.ok(!f.events.includes("new-trust"));
});
test("failed new-host restoration preserves off-host recovery inputs and does not enable maintenance or repeat compute changes",async t=> {
  const f=await fixture(t,{restoreFailure:true});await assert.rejects(executeRecreation(f.args),/OWNED_RESTORE_REQUIRES_REVIEW/u);
  assert.equal(f.providerCalls.filter(c=>c.operation==="ExecuteChangeSet").length,3);
  assert.ok(!f.events.includes("new-maintenance-activate"));
  assert.equal((await stat(join(f.directory,"retirement/pending-work/business-baseline.json"))).mode&0o777,0o600);
  const outcome=JSON.parse(await readFile(join(f.directory,"action-outcome.json"),"utf8"));
  assert.equal(outcome.remotePhaseMayStillBeRunning,true);
  assert.equal(outcome.remoteTerminalStateUnverified,true);
});
test("actual terminal failure receipts are retained by observation without executing the failed phase again",async t=> {
  const f=await fixture(t,{restoreFailure:true,terminalFailure:true});await assert.rejects(executeRecreation(f.args));
  const outcome=JSON.parse(await readFile(join(f.directory,"action-outcome.json"),"utf8"));
  assert.equal(outcome.remotePhaseTerminalReceiptsRetained,true);
  assert.equal(outcome.remotePhaseMayStillBeRunning,undefined);
  assert.equal(f.events.filter(event=>event==="new-restore").length,1);
  assert.equal(JSON.parse(await readFile(join(f.directory,"failure-restore/restore-outcome.json"),"utf8")).status,"FAILED_REQUIRES_REVIEW");
});
test("old container identities cannot qualify a newly created machine",async t=> {
  const f=await fixture(t,{reusedContainerIds:true});await assert.rejects(executeRecreation(f.args),/NEW_HOST_CONTAINER_IDENTITIES_REQUIRED/u);
  assert.ok(!f.events.includes("new-maintenance-activate"));
});
