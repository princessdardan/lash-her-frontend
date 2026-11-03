// A single reviewed access-recovery action, with one-attempt mutations.
import assert from "node:assert/strict";
import {accessRecoverySpec,inspectAccessRecoveryChangeSet,inspectRecoverySnapshot,readAccessRecoveryState,stoppedOriginal} from "./access_recovery.mjs";
import {inspectValidationEvents} from "./infrastructure.mjs";

export function accessRecoveryController({templateBody,addressArn,currentCidr,action,aws,record,verifyProducers,
  confirmation,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),signal,observe=readAccessRecoveryState}) {
  assert.match(action,/^p1-recreate-access-[a-z0-9-]{1,20}$/u);
  assert.equal(confirmation,"staging/"+action,"Explicit access-recovery action required");
  for(const fn of [aws,record,verifyProducers])assert.equal(typeof fn,"function");
  const spec=phase=>accessRecoverySpec(templateBody,addressArn,currentCidr,phase);
  const base=spec("initial"),attempts=new Set();let phase="initial",stop=null,snapshot=null;
  const abort=()=>{if(signal?.aborted)throw Error("ACCESS_RECOVERY_INTERRUPTED_REVIEW_REQUIRED");};
  const api=(service,operation,params)=>{abort();return aws({service,operation,region:base.region,params});};
  const state=()=>observe(apiRequest=>{abort();return aws(apiRequest);},spec(phase),phase,stop?"stopped":"running");
  function once(name) {assert.ok(!attempts.has(name),"Recovery mutation already attempted; deliberate failure review required");attempts.add(name);}
  async function recordIntent(name,detail) {abort();await record(name,{action,...detail});}
  function operations(value,resourceName,operationType) {
    assert.ok(Array.isArray(value.operations)&&value.operations.length>0);
    for(const op of value.operations) {
      assert.equal(op.resourceName,resourceName);assert.equal(op.operationType,operationType);
      assert.ok(op.status!=="Failed"&&!op.errorCode&&!op.errorDetails);
    }
  }
  async function stopOriginal() {
    assert.equal(phase,"initial");assert.equal(stop,null);
    const before=await state();await verifyProducers();
    once("stop");
    await recordIntent("original-stop-started",{instanceArn:base.originalInstanceArn,forcedStop:false,before});
    operations(await api("lightsail","StopInstance",{instanceName:base.instanceName}),base.instanceName,"StopInstance");
    const deadline=now()+600_000;let stopped=false;
    while(now()<deadline) {
      const raw=await api("lightsail","GetInstances",{});assert.equal(raw.nextPageToken,undefined);
      const hosts=raw.instances?.filter(h=>h.name===base.instanceName);assert.equal(hosts?.length,1);
      assert.equal(hosts[0].arn,base.originalInstanceArn);
      if(hosts[0].state?.name==="stopped"){stopped=true;break;}
      assert.ok(["running","stopping"].includes(hosts[0].state?.name));await sleep(2000);
    }
    assert.equal(stopped,true,"ACCESS_RECOVERY_STOP_OBSERVATION_TIMEOUT");
    const observed=await observe(aws,base,"initial","stopped");
    stop=Object.freeze(stoppedOriginal(observed,base));await record("original-stop-completed",stop);
    return structuredClone(stop);
  }
  async function snapshotOriginal() {
    assert.ok(stop&&snapshot===null);assert.equal(phase,"initial");
    once("snapshot");
    stoppedOriginal(await state(),base);
    const listed=await api("lightsail","GetInstanceSnapshots",{});assert.equal(listed.nextPageToken,undefined);
    assert.ok(Array.isArray(listed.instanceSnapshots)&&!listed.instanceSnapshots.some(s=>s.name===action+"-original"),"Fresh snapshot name required");
    const startedAt=now();await recordIntent("original-snapshot-started",{instanceArn:base.originalInstanceArn,snapshotName:action+"-original",startedAt});
    operations(await api("lightsail","CreateInstanceSnapshot",{instanceName:base.instanceName,instanceSnapshotName:action+"-original",
      tags:[{key:"Project",value:"lash-her"},{key:"Environment",value:"staging"},{key:"Purpose",value:"operator-access-recovery"}]}),
      action+"-original","CreateInstanceSnapshot");
    const deadline=now()+900_000;
    while(now()<deadline) {
      const raw=await api("lightsail","GetInstanceSnapshot",{instanceSnapshotName:action+"-original"});
      if(raw.instanceSnapshot?.state==="available") {
        stoppedOriginal(await state(),base);snapshot=Object.freeze(inspectRecoverySnapshot(raw,base,action,startedAt));
        await record("original-snapshot-completed",snapshot);return structuredClone(snapshot);
      }
      assert.equal(raw.instanceSnapshot?.state,"pending");await sleep(3000);
    }
    throw Error("ACCESS_RECOVERY_SNAPSHOT_OBSERVATION_TIMEOUT");
  }
  async function step(to,browserTrust) {
    assert.ok(stop&&snapshot,"Stopped source and verified snapshot required before compute removal");
    assert.equal(to,{initial:"detached",detached:"absent",absent:"verify-key","verify-key":"ready"}[phase],"Ordered recovery transitions required");
    once("step-"+to);
    const before=await state(),target=spec(to),targetState={detached:"detached",absent:"absent","verify-key":"attached",ready:"attached"}[to];
    if(to==="ready") {
      assert.equal(browserTrust?.method,"authenticated-aws-browser");assert.equal(browserTrust.accountId,base.accountId);
      assert.equal(browserTrust.instanceArn,before.instanceArn);assert.equal(browserTrust.address,before.address);
      assert.equal(browserTrust.browserAccountVerified,true);assert.equal(browserTrust.keyPinnedBeforePrivateTransfer,true);
      // Trust acceptance changes no provider setting. The browser recovery
      // alias is part of the explicitly reviewed steady-state access policy.
      const after=await observe(aws,target,"ready","running");
      assert.equal(after.instanceArn,before.instanceArn);assert.equal(after.browserSshEnabled,true);
      phase="ready";await record(action+"-browser-trust-verified",{...after,method:"authenticated-aws-browser"});
      return after;
    }
    const name=action+"-"+to;
    await verifyProducers();
    await recordIntent(name+"-create-started",{from:phase,to,snapshotArn:snapshot.snapshotArn,sourceInstanceArn:base.originalInstanceArn});
    const made=await api("cloudformation","CreateChangeSet",{StackName:base.stackId,ChangeSetName:name,ChangeSetType:"UPDATE",TemplateBody:templateBody,
      ClientToken:name+"-create",Parameters:Object.entries({Environment:"staging",HostState:targetState,...target.parameters})
        .map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}))});
    assert.equal(made.StackId,base.stackId);assert.ok(made.Id?.startsWith(`arn:aws:cloudformation:${base.region}:${base.accountId}:changeSet/${name}/`));
    const deadline=now()+180_000;let change;
    while(now()<deadline) {
      change=await api("cloudformation","DescribeChangeSet",{StackName:base.stackId,ChangeSetName:made.Id,IncludePropertyValues:true});
      if(["CREATE_PENDING","CREATE_IN_PROGRESS"].includes(change.Status)){await sleep(2000);continue;}
      assert.equal(change.Status,"CREATE_COMPLETE");break;
    }
    assert.equal(change?.Status,"CREATE_COMPLETE","ACCESS_RECOVERY_CHANGE_SET_OBSERVATION_TIMEOUT");
    assert.equal(change.ChangeSetId,made.Id);
    const fetched=await api("cloudformation","GetTemplate",{StackName:base.stackId,ChangeSetName:made.Id});
    const body=typeof fetched.TemplateBody==="string"?fetched.TemplateBody:JSON.stringify(fetched.TemplateBody);
    const reviewed=inspectAccessRecoveryChangeSet(change,target,to,body);
    inspectValidationEvents(await api("cloudformation","DescribeEvents",{StackName:base.stackId,ChangeSetName:made.Id}),change,target);
    await record(name+"-review",{...reviewed,before,snapshotArn:snapshot.snapshotArn});
    assert.deepEqual(await state(),before,"Infrastructure changed during review");await verifyProducers();
    await recordIntent(name+"-execute-started",{changeSetId:made.Id,from:phase,to});
    await api("cloudformation","ExecuteChangeSet",{StackName:base.stackId,ChangeSetName:made.Id,ClientRequestToken:name+"-execute",DisableRollback:true});
    const end=now()+900_000;let complete=false;
    while(now()<end) {
      const raw=await api("cloudformation","DescribeStacks",{StackName:base.stackId});
      assert.equal(raw.Stacks?.length,1);assert.equal(raw.Stacks[0].StackId,base.stackId);
      const status=raw.Stacks[0].StackStatus;
      if(status==="UPDATE_COMPLETE"){complete=true;break;}
      assert.ok(["UPDATE_IN_PROGRESS","UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"].includes(status));await sleep(3000);
    }
    assert.equal(complete,true,"ACCESS_RECOVERY_STACK_OBSERVATION_TIMEOUT");
    const after=await observe(aws,target,to,"stopped");
    phase=to;await record(name+"-completed",after);return after;
  }
  return {state,stopOriginal,snapshotOriginal,step};
}
