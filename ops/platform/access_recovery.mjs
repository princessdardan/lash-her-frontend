// Recovery from the original host's now-unreachable operator /32. Pure plans
// and provider observations only; these helpers execute no cloud mutation.
import assert from "node:assert/strict";
import {stagingInfrastructureSpec, inspectInfrastructureState} from "./infrastructure.mjs";
import {hostTemplateSha256, inspectHostLifecycleChangeSet} from "./host_lifecycle.mjs";

export const RECOVERY_PHASES = ["initial", "detached", "absent", "verify-key", "ready"];
const originalCidr = "99.239.200.211/32";
const hostState = phase => ({initial:"attached",detached:"detached",absent:"absent","verify-key":"attached",ready:"attached"})[phase];

export function operatorCidr(value) {
  assert.equal(typeof value,"string");
  assert.match(value,/^(?:\d{1,3}\.){3}\d{1,3}\/32$/u,"One operator IPv4 required");
  const octets=value.slice(0,-3).split(".").map(Number);
  assert.ok(octets.every((part,index)=>part<=255&&String(part)===value.slice(0,-3).split(".")[index]));
  const [a,b]=octets;
  assert.ok(a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)
    &&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127),"Public operator address required");
  return value;
}

export function accessRecoverySpec(templateBody,addressArn,currentCidr,phase) {
  assert.ok(RECOVERY_PHASES.includes(phase));
  const spec=stagingInfrastructureSpec(templateBody,hostTemplateSha256(templateBody),addressArn);
  operatorCidr(currentCidr);
  if(phase!=="initial")spec.parameters.BrowserSshAccess=["verify-key","ready"].includes(phase)?"true":"false";
  spec.parameters.OperatorIpv4Cidr=["verify-key","ready"].includes(phase)?currentCidr:originalCidr;
  return spec;
}

export async function readAccessRecoveryState(aws,spec,phase,originalState=phase==="detached"?"stopped":"running") {
  assert.ok(RECOVERY_PHASES.includes(phase));assert.ok(["running","stopped"].includes(originalState));
  const api=(service,operation,params)=>aws({service,operation,region:spec.region,params});
  const identity=await api("sts","GetCallerIdentity",{});
  assert.equal(identity.Account,spec.accountId);
  const [stacks,resources,template,address,instances]=await Promise.all([
    api("cloudformation","DescribeStacks",{StackName:spec.stackId}),
    api("cloudformation","ListStackResources",{StackName:spec.stackId}),
    api("cloudformation","GetTemplate",{StackName:spec.stackId}),
    api("lightsail","GetStaticIp",{staticIpName:spec.addressName}),api("lightsail","GetInstances",{}),
  ]);
  const ports=phase==="absent"?{}:await api("lightsail","GetInstancePortStates",{instanceName:spec.instanceName});
  const expectedState=["initial","detached"].includes(phase)?originalState:"running";
  const state=inspectInfrastructureState({identity,stacks,resources,template,address,instances,ports},spec,hostState(phase),expectedState);
  if(phase==="initial")assert.equal(state.instanceArn,spec.originalInstanceArn);
  if(["verify-key","ready"].includes(phase))assert.notEqual(state.instanceArn,spec.originalInstanceArn);
  return {...state,accessRecoveryPhase:phase,instanceState:phase==="absent"?null:expectedState,
    operatorIpv4Cidr:spec.parameters.OperatorIpv4Cidr,browserSshEnabled:spec.parameters.BrowserSshAccess==="true"};
}

export function stoppedOriginal(state,spec) {
  assert.equal(state.status,"STAGING_INFRASTRUCTURE_STATE_VERIFIED");
  assert.equal(state.stackId,spec.stackId);assert.equal(state.instanceArn,spec.originalInstanceArn);
  assert.equal(state.addressArn,spec.addressArn);assert.equal(state.address,spec.address);
  assert.equal(state.accessRecoveryPhase,"initial");assert.equal(state.instanceState,"stopped");
  assert.equal(state.allocationPreserved,true);assert.equal(state.browserSshEnabled,false);
  return {status:"STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY",environment:"staging",
    accountId:spec.accountId,region:spec.region,stackId:spec.stackId,instanceArn:spec.originalInstanceArn,
    hostMachineId:spec.originalMachineId,instanceName:spec.instanceName,address:spec.address,
    instanceState:"stopped",perContainerGracefulExitObserved:false,forcedStop:false};
}

export function inspectRecoverySnapshot(value,spec,action,startedAt) {
  assert.match(action,/^p1-recreate-access-[a-z0-9-]{1,20}$/u);
  assert.ok(Number.isSafeInteger(startedAt)&&startedAt>0);
  const s=value.instanceSnapshot;
  assert.ok(s&&typeof s==="object");
  assert.equal(s.name,action+"-original");assert.equal(s.state,"available");
  assert.equal(s.fromInstanceArn,spec.originalInstanceArn);assert.equal(s.fromInstanceName,spec.instanceName);
  assert.equal(s.fromBundleId,spec.parameters.BundleId);assert.equal(s.fromBlueprintId,"ubuntu_24_04");
  // Lightsail instance snapshots are regional. AWS reports their zone as
  // "all", while the source instance remains bound to the reviewed AZ.
  assert.equal(s.location?.regionName,spec.region);assert.equal(s.location?.availabilityZone,"all");
  assert.equal(s.resourceType,"InstanceSnapshot");assert.equal(s.isFromAutoSnapshot,false);
  assert.match(s.arn,/^arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot\/[a-f0-9-]{36}$/u);
  const created=typeof s.createdAt==="number"?s.createdAt*1000:Date.parse(s.createdAt);
  assert.ok(Number.isFinite(created)&&created>=startedAt-5000,"Snapshot from this action required");
  const tags=s.tags??[];assert.equal(new Set(tags.map(t=>t.key)).size,tags.length);
  const mapped=Object.fromEntries(tags.map(t=>[t.key,t.value]));
  assert.equal(mapped.Project,"lash-her");assert.equal(mapped.Environment,"staging");assert.equal(mapped.Purpose,"operator-access-recovery");
  return {status:"STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE",snapshotArn:s.arn,snapshotName:s.name,
    fromInstanceArn:s.fromInstanceArn,createdAt:s.createdAt,privateRootDiskIncluded:true,
    snapshotContentsFetched:false,cleanupRequiresSuccessfulRecovery:true};
}

function hostModification(change,allowed) {
  assert.equal(change.Type,"Resource");const r=change.ResourceChange;
  assert.equal(r.LogicalResourceId,"ApiHost");assert.equal(r.ResourceType,"AWS::Lightsail::Instance");
  assert.equal(r.Action,"Modify");assert.equal(r.Replacement,"False");
  assert.ok(Array.isArray(r.Scope)&&r.Scope.length>0&&r.Scope.every(s=>["Properties","Metadata"].includes(s)));
  assert.ok(Array.isArray(r.Details)&&r.Details.length>0);
  for(const d of r.Details) {
    assert.ok(d.Target?.Attribute==="Metadata"||(d.Target?.Attribute==="Properties"&&allowed.includes(d.Target.Name)));
    assert.ok(d.Target.RequiresRecreation===undefined||d.Target.RequiresRecreation==="Never");
  }
}

export function inspectAccessRecoveryChangeSet(value,spec,to,actualTemplateBody) {
  assert.ok(["detached","absent","verify-key","ready"].includes(to));
  assert.equal(value.StackId,spec.stackId);
  if(to==="ready") {
    assert.equal(value.Status,"CREATE_COMPLETE");assert.equal(value.ExecutionStatus,"AVAILABLE");
    assert.equal(value.NextToken,undefined);assert.equal(value.IncludeNestedStacks??false,false);
    assert.ok(value.ChangeSetId?.startsWith(`arn:aws:cloudformation:${spec.region}:${spec.accountId}:changeSet/`));
    assert.equal(hostTemplateSha256(actualTemplateBody),spec.templateSha256);
    assert.deepEqual(Object.fromEntries((value.Parameters??[]).map(p=>[p.ParameterKey,p.ParameterValue])),
      {Environment:"staging",HostState:"attached",...spec.parameters});
    assert.equal(value.Parameters.length,Object.keys(spec.parameters).length+2);
    assert.equal(spec.parameters.BrowserSshAccess,"true");
    assert.equal(value.Changes?.length,1);hostModification(value.Changes[0],["Networking"]);
    assert.ok(value.Changes[0].ResourceChange.Details.some(d=>d.Target?.Attribute==="Properties"&&d.Target.Name==="Networking"));
    return {status:"STAGING_OPERATOR_SSH_SOURCE_CHANGE_SET_REVIEWED",stackId:spec.stackId,
      changeSetId:value.ChangeSetId,executionAuthorized:false};
  }
  const copy=structuredClone(value);
  if(to==="detached") {
    const modifications=copy.Changes.filter(c=>c.ResourceChange?.LogicalResourceId==="ApiHost");
    assert.ok(modifications.length<=1);
    if(modifications.length)hostModification(modifications[0],["UserData","Networking"]);
    copy.Changes=copy.Changes.filter(c=>c.ResourceChange?.LogicalResourceId!=="ApiHost");
    assert.equal(spec.parameters.BrowserSshAccess,"false");assert.equal(spec.parameters.OperatorIpv4Cidr,originalCidr);
  }
  const from=to==="detached"?"attached":to==="absent"?"detached":"absent";
  return inspectHostLifecycleChangeSet(copy,{...spec,from,to:hostState(to)},actualTemplateBody);
}

export function accessRecoveryPlan({action,sourceCommit,templateBody,addressArn,currentCidr,candidateSha256,inputManifestSha256}) {
  assert.match(action,/^p1-recreate-access-[a-z0-9-]{1,20}$/u);assert.match(sourceCommit,/^[a-f0-9]{40}$/u);
  for(const hash of [candidateSha256,inputManifestSha256])assert.match(hash,/^[a-f0-9]{64}$/u);
  const spec=accessRecoverySpec(templateBody,addressArn,currentCidr,"ready");
  return {status:"STAGING_OPERATOR_ACCESS_RECOVERY_PLAN",action,sourceCommit,accountId:spec.accountId,region:spec.region,
    stackId:spec.stackId,originalInstanceArn:spec.originalInstanceArn,address:spec.address,addressArn,
    operatorIpv4Cidr:currentCidr,templateSha256:spec.templateSha256,candidateSha256,inputManifestSha256,
    originalHostSnapshotName:action+"-original",snapshotContainsPrivateRootDisk:true,
    steps:["verify-provider-producers-and-held-inputs","stop-original-without-force","snapshot-stopped-original",
      "detach-static-address","delete-original-compute","create-reviewed-fresh-host-with-managed-browser-ssh",
      "verify-new-key-through-authenticated-aws-browser","verify-current-operator-and-authenticated-browser-edge",
      "bootstrap-and-cache-six-pinned-images","restore-held-private-configuration-and-tls",
      "verify-three-current-databases-read-only","start-eight-existing-runtime-services-in-maintenance"],
    hostSshPolicy:"provider-ipv4-source-v2",publicSshSourceFilter:"Lightsail current operator /32 plus IAM-authenticated lightsail-connect",
    authenticatedBrowserRecoveryAccessRetained:true,
    privateNetworkSshDenied:true,ipv6SshAllowed:false,passwordAuthentication:false,rootLogin:false,
    frontendBuildOrPromotion:false,sqlMigrations:false,syntheticBusinessWrites:false,productionChanged:false,
    currentFrontendDeployment:"dpl_CdhFqwVANweysVe9cCTNpmHfduiy",gatewayWritesAdmitted:false,
    businessSchedulesEnabled:false,liveRollbackQualified:false,p1RecreationQualified:false,
    executionAuthorized:false};
}
