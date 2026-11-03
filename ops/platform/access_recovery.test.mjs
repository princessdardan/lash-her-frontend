import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {accessRecoveryPlan,accessRecoverySpec,inspectAccessRecoveryChangeSet,inspectRecoverySnapshot,operatorCidr,stoppedOriginal} from "./access_recovery.mjs";

const body=readFileSync(new URL("../aws/lightsail-access-recovery.cfn.json",import.meta.url),"utf8");
const addressArn="arn:aws:lightsail:us-east-1:691588646557:StaticIp/dfdce3fc-150b-47c0-87df-2bffeb81e963";
const cidr="99.239.187.88/32",action="p1-recreate-access-20261103";
const spec=phase=>accessRecoverySpec(body,addressArn,cidr,phase);
const modification=(logical,name)=>({Type:"Resource",ResourceChange:{LogicalResourceId:logical,
  ResourceType:logical==="ApiHost"?"AWS::Lightsail::Instance":"AWS::Lightsail::StaticIp",Action:"Modify",Replacement:"False",
  Scope:["Properties"],Details:[{Target:{Attribute:"Properties",Name:name,RequiresRecreation:"Never"}}]}});
function change(to) {
  const s=spec(to),state={detached:"detached",absent:"absent","verify-key":"attached",ready:"attached"}[to];
  return {StackId:s.stackId,ChangeSetId:"arn:aws:cloudformation:us-east-1:691588646557:changeSet/owned/11111111-1111-4111-8111-111111111111",
    Status:"CREATE_COMPLETE",ExecutionStatus:"AVAILABLE",Parameters:Object.entries({Environment:"staging",HostState:state,...s.parameters}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),
    Changes:to==="detached"?[modification("ApiHost","UserData"),modification("GatewayAddress","AttachedTo")]:to==="ready"?[modification("ApiHost","Networking")]:
      to==="absent"?[{Type:"Resource",ResourceChange:{LogicalResourceId:"ApiHost",ResourceType:"AWS::Lightsail::Instance",Action:"Remove"}}]:
        [{Type:"Resource",ResourceChange:{LogicalResourceId:"ApiHost",ResourceType:"AWS::Lightsail::Instance",Action:"Add"}},modification("GatewayAddress","AttachedTo")]};
}

test("recovery phases preserve the old source until fresh creation and retain authenticated browser recovery",()=>{
  assert.equal(spec("initial").parameters.BrowserSshAccess,undefined);
  for(const phase of ["detached","absent"])assert.deepEqual([spec(phase).parameters.OperatorIpv4Cidr,spec(phase).parameters.BrowserSshAccess],["99.239.200.211/32","false"]);
  assert.deepEqual([spec("verify-key").parameters.OperatorIpv4Cidr,spec("verify-key").parameters.BrowserSshAccess],[cidr,"true"]);
  assert.deepEqual([spec("ready").parameters.OperatorIpv4Cidr,spec("ready").parameters.BrowserSshAccess],[cidr,"true"]);
  for(const bad of ["0.0.0.0/0","10.1.2.3/32","172.16.0.1/32","192.168.1.1/32","127.0.0.1/32","100.64.0.1/32","99.239.187.088/32","256.1.2.3/32"])assert.throws(()=>operatorCidr(bad));
});

test("each exact CloudFormation change is reviewable without executing an operation",()=>{
  for(const phase of ["detached","absent","verify-key","ready"]){const r=inspectAccessRecoveryChangeSet(change(phase),spec(phase),phase,body);assert.equal(r.executionAuthorized,false);}
});

test("unexpected host properties, replacement, allocation deletion, parameter drift and partial pages refuse",()=>{
  for(const [phase,mutate] of [
    ["detached",v=>{v.Changes[0].ResourceChange.Details[0].Target.Name="BundleId";}],
    ["detached",v=>{v.Changes[0].ResourceChange.Replacement="True";}],
    ["absent",v=>{v.Changes[0].ResourceChange.LogicalResourceId="GatewayAddress";}],
    ["verify-key",v=>{v.Parameters.find(p=>p.ParameterKey==="OperatorIpv4Cidr").ParameterValue="0.0.0.0/0";}],
    ["ready",v=>{v.Changes[0].ResourceChange.Details[0].Target.Name="UserData";}],
    ["ready",v=>{v.NextToken="more";}],
    ["ready",v=>{v.Parameters.push({...v.Parameters[0]});}],
    ["ready",v=>{v.StackId+="other";}],
  ]){const v=change(phase);mutate(v);assert.throws(()=>inspectAccessRecoveryChangeSet(v,spec(phase),phase,body));}
});

test("snapshot must be a fresh manual snapshot of the exact stopped source identity",()=>{
  const s=spec("initial"),started=Date.parse("2026-11-03T00:00:00Z");
  const snapshot={instanceSnapshot:{name:action+"-original",arn:"arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/11111111-1111-4111-8111-111111111111",
    state:"available",fromInstanceArn:s.originalInstanceArn,fromInstanceName:s.instanceName,fromBundleId:s.parameters.BundleId,
    fromBlueprintId:"ubuntu_24_04",resourceType:"InstanceSnapshot",isFromAutoSnapshot:false,createdAt:"2026-11-03T00:00:01Z",
    location:{regionName:s.region,availabilityZone:s.parameters.AvailabilityZone},
    tags:[{key:"Project",value:"lash-her"},{key:"Environment",value:"staging"},{key:"Purpose",value:"operator-access-recovery"}]}};
  assert.equal(inspectRecoverySnapshot(snapshot,s,action,started).snapshotContentsFetched,false);
  for(const mutate of [v=>{v.instanceSnapshot.state="pending";},v=>{v.instanceSnapshot.fromInstanceArn+="other";},v=>{v.instanceSnapshot.createdAt="2026-11-02T00:00:00Z";},v=>{v.instanceSnapshot.isFromAutoSnapshot=true;}]){
    const v=structuredClone(snapshot);mutate(v);assert.throws(()=>inspectRecoverySnapshot(v,s,action,started));
  }
});

test("AWS stopped evidence does not claim per-container graceful shutdown or P1 qualification",()=>{
  const s=spec("initial"),raw={status:"STAGING_INFRASTRUCTURE_STATE_VERIFIED",stackId:s.stackId,instanceArn:s.originalInstanceArn,
    addressArn:s.addressArn,address:s.address,accessRecoveryPhase:"initial",instanceState:"stopped",allocationPreserved:true,browserSshEnabled:false};
  assert.equal(stoppedOriginal(raw,s).perContainerGracefulExitObserved,false);
  assert.throws(()=>stoppedOriginal({...raw,instanceState:"running"},s));
  const p=accessRecoveryPlan({action,sourceCommit:"a".repeat(40),templateBody:body,addressArn,currentCidr:cidr,candidateSha256:"b".repeat(64),inputManifestSha256:"c".repeat(64)});
  for(const key of ["executionAuthorized","p1RecreationQualified","liveRollbackQualified","sqlMigrations","frontendBuildOrPromotion","productionChanged","gatewayWritesAdmitted"])assert.equal(p[key],false);
});

test("template is staging-only, preserves the allocation and bounds managed browser access",()=>{
  const t=JSON.parse(body),ports=t.Resources.ApiHost.Properties.Networking.Ports;
  assert.deepEqual(t.Parameters.Environment.AllowedValues,["staging"]);
  assert.equal(t.Parameters.BrowserSshAccess.Default,"false");
  assert.deepEqual(ports[0].CidrListAliases,{"Fn::If":["BrowserSshEnabled",["lightsail-connect"],[]]});
  assert.deepEqual(ports[0].Cidrs,[{Ref:"OperatorIpv4Cidr"}]);assert.deepEqual(ports.map(p=>p.FromPort),[22,443]);
  assert.ok(ports.every(p=>p.Ipv6Cidrs.length===0));assert.equal(t.Resources.GatewayAddress.Condition,undefined);
  const u=t.Resources.ApiHost.Properties.UserData["Fn::Join"][1];
  const rules=u.filter(v=>typeof v==="string"&&/^ufw (allow|deny) /u.test(v));
  assert.deepEqual(rules,["ufw deny from 10.0.0.0/8 to any port 22 proto tcp","ufw deny from 172.16.0.0/12 to any port 22 proto tcp",
    "ufw deny from 192.168.0.0/16 to any port 22 proto tcp","ufw allow from 0.0.0.0/0 to any port 22 proto tcp","ufw allow from 0.0.0.0/0 to any port 443 proto tcp"]);
});
