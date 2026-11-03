// Explicit one-time access recovery. No routine release, production, SQL apply,
// automatic retry, frontend promotion, business scheduler or traffic admission.
import assert from "node:assert/strict";
import {readFile,mkdir} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {prepareRecreation,releaseBindings,freshInventory,privateParents,privateJson} from "./recreate-staging.mjs";
import {durablePrivateFile} from "./recreation_controller.mjs";
import {operatorAwsCli} from "./aws_cli.mjs";
import {accessRecoveryPlan,accessRecoverySpec,readAccessRecoveryState,inspectRecoverySnapshot} from "./access_recovery.mjs";
import {accessRecoveryController} from "./access_recovery_controller.mjs";
import {readRecoveryProducers,verifyRecoveryMux} from "./access_recovery_producers.mjs";
import {verifiedBrowserSshProof} from "./browser_ssh_trust.mjs";
import {recreationSsh} from "./recreation_ssh.mjs";
import {decodePrivateReceipts,sha256} from "./recreation_inputs.mjs";
import {verifyOperatorCi} from "./recreation_source.mjs";
import {githubSourceApi} from "./release-inputs.mjs";
import {CONTINUATION,continuationParentReceipts,continuationPlan} from "./access_recovery_continuation.mjs";
import {DETACHED_CONTINUATION,detachedParentReceipts,detachedContinuationPlan} from "./detached_recovery_continuation.mjs";
import {EXISTING_RUNTIME,runtimeParentReceipts,runtimeContinuationPlan,retainedRuntimeBrowserTrust} from "./existing_runtime_continuation.mjs";

const source=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const parent="/Users/dardan/.local/share/lash-her/recreations/staging";
const addressArn="arn:aws:lightsail:us-east-1:691588646557:StaticIp/dfdce3fc-150b-47c0-87df-2bffeb81e963";
const print=value=>process.stdout.write(JSON.stringify(value)+"\n");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function recoverySettings(value) {
  assert.ok(value&&typeof value==="object"&&!Array.isArray(value));
  assert.ok([1,2,3,4].includes(value.version));
  assert.deepEqual(Object.keys(value).sort(),value.version===1?["action","operatorIpv4Cidr","sourceCommit","version"]:
    ["action","continuationOf","operatorIpv4Cidr","sourceCommit","version"]);
  if(value.version===2){assert.equal(value.action,CONTINUATION.action);assert.equal(value.continuationOf,CONTINUATION.parentAction);}
  if(value.version===3){assert.equal(value.action,DETACHED_CONTINUATION.action);assert.equal(value.continuationOf,DETACHED_CONTINUATION.parentAction);}
  if(value.version===4){assert.equal(value.action,EXISTING_RUNTIME.action);assert.equal(value.continuationOf,EXISTING_RUNTIME.parentAction);}
  assert.match(value.action,/^p1-recreate-access-[a-z0-9-]{1,20}$/u);
  assert.match(value.sourceCommit,/^[a-f0-9]{40}$/u);return value;
}

function databaseBindings(bindings,review) {
  for(const [app,name] of Object.entries({frontend:"FRONTEND_STAGING_MIGRATION_DATABASE_URL",course:"COURSE_STAGING_DATABASE_URL",community:"COMMUNITY_STAGING_DATABASE_URL"})) {
    const target=review.databases[app],url=new URL(bindings[name]);
    assert.ok(["postgres:","postgresql:"].includes(url.protocol));assert.equal(url.hostname,target.host);
    assert.equal(Number(url.port||5432),target.port);assert.equal(decodeURIComponent(url.pathname),"/"+target.database);
    assert.equal(decodeURIComponent(url.username),target.migrationUser);assert.ok(url.password&&!url.hash);
    assert.equal(url.search,"?sslmode=verify-full","Existing direct verified-TLS migration binding required");
  }
}

export async function runAccessRecovery(settings,{apply=false,confirmation}={}) {
  recoverySettings(settings);
  if(apply)assert.equal(confirmation,"staging/"+settings.action,"Explicit reviewed access recovery required");
  const prepared=await prepareRecreation({version:1,action:settings.action,sourceCommit:settings.sourceCommit,trustMode:"provider-browser"});
  const templateBody=await readFile(join(source,"ops/aws/lightsail-access-recovery.cfn.json"),"utf8");
  let plan=accessRecoveryPlan({action:settings.action,sourceCommit:settings.sourceCommit,templateBody,addressArn,
    currentCidr:settings.operatorIpv4Cidr,candidateSha256:prepared.inputs.candidateSha256,inputManifestSha256:prepared.inputs.manifestSha256});
  let continuation=null;
  if(settings.version>=2) {
    const fixed=settings.version===2?CONTINUATION:settings.version===3?DETACHED_CONTINUATION:EXISTING_RUNTIME;
    const files={};
    for(const name of Object.keys(fixed.receiptsSha256)) {
      const path=join(parent,fixed.parentAction,name);await privateJson(path);files[name]=await readFile(path);
    }
    continuation=settings.version===2?continuationParentReceipts(files):settings.version===3?detachedParentReceipts(files):runtimeParentReceipts(files);
    plan=settings.version===2?continuationPlan(plan,continuation):settings.version===3?detachedContinuationPlan(plan,continuation):runtimeContinuationPlan(plan,continuation,prepared.inputs.files.length);
  }
  if(!apply)return {...plan,review:prepared.inputs.review,inputFiles:prepared.inputs.files.length,
    privateReceiptDirectory:join(parent,settings.action),sourceCiVerified:false,startRequiresExactSourceCi:true};
  const bindings=await releaseBindings();databaseBindings(bindings,prepared.inputs.review);
  const ci=await verifyOperatorCi({api:githubSourceApi(bindings.PLATFORM_SOURCE_READ_TOKEN),sourceCommit:settings.sourceCommit,
    branch:prepared.committed.branch,workflowBytes:prepared.committed.workflowBytes});
  await privateParents(parent);await privateParents(join(parent,"incoming"));
  const directory=join(parent,settings.action);await mkdir(directory,{mode:0o700});
  const record=(name,value)=>durablePrivateFile(join(directory,name+".json"),Buffer.from(JSON.stringify(value)+"\n"));
  const abort=new AbortController(),stop=()=>abort.abort();
  for(const name of ["SIGINT","SIGTERM","SIGHUP"])process.on(name,stop);
  const guard=()=>{if(abort.signal.aborted)throw Error("ACCESS_RECOVERY_INTERRUPTED_REVIEW_REQUIRED");};
  let phase="preflight",observation=0,newSsh=null,activeReceipt=null,inventory=null;
  const outcome={status:"STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW",action:settings.action,sourceCommit:settings.sourceCommit,
    startedAt:Date.now(),productionChanged:false,migrationsExecuted:false,trafficAuthorized:false,releaseAccepted:false,
    liveRollbackQualified:false,p1RecreationQualified:false};
  async function progress(name) {guard();phase=name;print({status:"STAGING_ACCESS_RECOVERY_PROGRESS",action:settings.action,phase});}
  async function producers() {
    guard();const frontend=await readRecoveryProducers(bindings.VERCEL_TOKEN);
    const fresh=await freshInventory(settings.action,"access-recovery",abort.signal);
    inventory=verifyRecoveryMux(JSON.parse(Buffer.from(fresh.data,"base64")));
    await record("producer-observation-"+String(++observation).padStart(2,"0"),{frontend,muxInventorySha256:fresh.sha256,observedAt:inventory.observedAt});
  }
  async function retain(name) {
    const value=await newSsh.privateFiles(settings.sourceCommit,{version:1,operation:"receipts",action:settings.action,phase:name});
    const files=decodePrivateReceipts(value,name),destination=join(directory,"receipts-"+name);
    await mkdir(destination,{mode:0o700});
    for(const [name,raw] of files) {
      const target=join(destination,name);await mkdir(dirname(target),{recursive:true,mode:0o700});
      // Reused receipt paths are fixed by the reviewed server allowlist.
      await durablePrivateFile(target,raw);
    }
    return files;
  }
  try {
    await record("reviewed-plan",plan);await record("source-ci",ci);
    print({...plan,sourceCiVerified:true,review:prepared.inputs.review});
    const current=await fetch("https://checkip.amazonaws.com/",{redirect:"error",signal:AbortSignal.timeout(15000)});
    assert.equal(current.status,200);assert.equal((await current.text()).trim()+"/32",settings.operatorIpv4Cidr,"Operator address changed before recovery");
    const baseAws=operatorAwsCli({binary:"/Users/dardan/.local/bin/aws"});
    const controller=settings.version===4?null:accessRecoveryController({templateBody,addressArn,currentCidr:settings.operatorIpv4Cidr,action:settings.action,
      aws:request=>{guard();return baseAws(request);},record,verifyProducers:producers,confirmation,signal:abort.signal});
    const readOnlyOperations=new Set(["GetCallerIdentity","DescribeStacks","ListStackResources","GetTemplate","GetStaticIp","GetInstances","GetInstancePortStates","GetInstanceSnapshot"]);
    const readOnlyAws=request=>{guard();assert.ok(readOnlyOperations.has(request.operation));return baseAws(request);};
    const currentRuntimeState=async()=> {
      const spec=accessRecoverySpec(templateBody,addressArn,settings.operatorIpv4Cidr,"ready");
      const state=await readAccessRecoveryState(readOnlyAws,spec,"ready");
      const raw=await readOnlyAws({service:"lightsail",operation:"GetInstanceSnapshot",region:spec.region,params:{instanceSnapshotName:continuation.snapshot.snapshotName}});
      assert.deepEqual(inspectRecoverySnapshot(raw,spec,"p1-recreate-access-20261103",1793729257262),continuation.snapshot);
      return state;
    };
    await producers();let originalStop,recoverySnapshot,instance,browser;
    if(settings.version===4) {
      await progress("verify-existing-pinned-host");instance=await currentRuntimeState();
      browser=retainedRuntimeBrowserTrust(continuation,instance);
      originalStop=continuation.stop;recoverySnapshot=continuation.snapshot;
      await record("existing-runtime-infrastructure",instance);await record("retained-browser-trust-reused",{...browser,knownHosts:undefined});
    } else if(settings.version===3) {
      await progress("verify-and-stop-detached-provider-started-original");
      ({originalStop,recoverySnapshot}=await controller.adoptDetachedSnapshot(continuation));
      await record("original-infrastructure",await controller.state());
    } else if(continuation) {
      await progress("verify-existing-stopped-snapshot");
      ({originalStop,recoverySnapshot}=await controller.adoptStoppedSnapshot(continuation));
      await record("original-infrastructure",await controller.state());
    } else {
      await record("original-infrastructure",await controller.state());
      await progress("stop-original");originalStop=await controller.stopOriginal();
      await progress("snapshot-original");recoverySnapshot=await controller.snapshotOriginal();
    }
    if(settings.version!==4) {
      for(const step of settings.version===3?["absent","verify-key"]:["detached","absent","verify-key"]) {await progress("infrastructure-"+step);await controller.step(step);}
      instance=await controller.state();const proofPath=join(parent,"incoming/browser-ssh-"+settings.action+".json");
      await progress("independent-browser-ssh-verification");
      print({status:"WAITING_FOR_AUTHENTICATED_AWS_BROWSER_SSH_PROOF",action:settings.action,accountId:"691588646557",
        instanceArn:instance.instanceArn,address:instance.address,proofPath,
        commands:["cat /etc/machine-id","cat /etc/ssh/ssh_host_ed25519_key.pub","ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256"]});
      let proof;
      for(;;) {guard();try {proof=await privateJson(proofPath);break;}catch(error){if(error.code!=="ENOENT")throw error;}await sleep(1000);}
      browser=verifiedBrowserSshProof(proof,instance,settings.action,prepared.spec.originalMachineId);
    }
    const knownHosts=join(directory,"new-host-known_hosts");await durablePrivateFile(knownHosts,Buffer.from(browser.knownHosts));
    const trust={...browser,knownHosts:undefined};await record("browser-ssh-trust",trust);
    const diagnostics=join(directory,"ssh");await mkdir(diagnostics,{mode:0o700});
    newSsh=await recreationSsh({knownHosts,keyFile:"/Users/dardan/.ssh/Dardan.pem",diagnostics,signal:abort.signal});
    const machine=await newSsh.machine();assert.equal(machine.machineId,browser.hostMachineId);
    if(settings.version===4) {
      const bare=await newSsh.bareRuntime();assert.equal(bare.status,"BARE_RUNTIME_RESTORE_VERIFIED");assert.equal(bare.hostMachineId,EXISTING_RUNTIME.machineId);
      await record("bare-runtime-preflight",bare);
    }
    await progress("verify-steady-state-access");const infrastructure=settings.version===4?await currentRuntimeState():await controller.step("ready",trust);
    if(settings.version===4)assert.equal(infrastructure.instanceArn,EXISTING_RUNTIME.instanceArn);
    await progress("install-exact-public-source");await newSsh.installSource({commit:settings.sourceCommit,files:prepared.committed.files});
    await progress("restore-reviewed-private-inputs");
    await newSsh.privateFiles(settings.sourceCommit,{version:1,operation:"stage",action:settings.action,
      files:prepared.inputs.files,manifestSha256:prepared.inputs.manifestSha256});
    const common={version:1,environment:"staging",action:settings.action,expectedMachineId:machine.machineId};
    for(const operation of ["bootstrap","cache-current"]) {
      await progress(operation);activeReceipt="prepare-"+operation;
      await newSsh.prepare(settings.sourceCommit,{...common,operation,candidate_sha256:prepared.inputs.candidateSha256,
        packageLockSha256:prepared.packageLockSha256,sshAccessPolicy:"provider-ipv4-source-v2",
        ...(operation==="cache-current"?{registryUsername:bindings.GHCR_USERNAME,registryReadToken:bindings.GHCR_READ_TOKEN}:{}),
        confirmation:`staging/${settings.action}/${operation}`});
      await retain(activeReceipt);activeReceipt=null;
    }
    await progress("install-existing-maintenance-disabled");activeReceipt="maintenance-install";
    await newSsh.maintenance(settings.sourceCommit,{...common,operation:"install",confirmation:`staging/${settings.action}/maintenance-install`});
    await retain(activeReceipt);activeReceipt=null;
    await producers();await progress("read-only-database-checks-and-runtime-restore");activeReceipt="cold-restore";
    const restored=await newSsh.coldRestore(settings.sourceCommit,{version:1,environment:"staging",operation:"cold-restore",action:settings.action,
      newMachineId:machine.machineId,configurationSha256:prepared.inputs.configurationSha256,checkerSha256:prepared.inputs.checkerSha256,
      originalStop,recoverySnapshot,newInfrastructure:infrastructure,browserTrust:trust,muxInventory:inventory,
      databaseCredentials:{frontend:bindings.FRONTEND_STAGING_MIGRATION_DATABASE_URL,course:bindings.COURSE_STAGING_DATABASE_URL,community:bindings.COMMUNITY_STAGING_DATABASE_URL},
      vercelToken:bindings.VERCEL_TOKEN});
    assert.equal(restored.status,"STAGING_COLD_RUNTIME_RESTORED_FOR_QUALIFICATION");
    const receipts=await retain(activeReceipt);activeReceipt=null;
    const ready=JSON.parse(receipts.get("runtime-outcome.json"));assert.equal(ready.hostMachineId,machine.machineId);
    assert.equal(ready.candidateSha256,prepared.inputs.candidateSha256);assert.equal(ready.containers.length,8);
    const binding=JSON.parse(receipts.get("configuration-binding.json"));
    assert.equal(sha256(receipts.get("runtime-binding.json")),binding.restoredSha256["runtime.json"]);
    await producers();await record("final-infrastructure",settings.version===4?await currentRuntimeState():await controller.state());
    outcome.status="STAGING_OPERATOR_ACCESS_AND_RUNTIME_RECOVERED_AWAITING_P1_QUALIFICATION";
    Object.assign(outcome,{newInstanceArn:instance.instanceArn,newHostMachineId:machine.machineId,snapshotArn:recoverySnapshot.snapshotArn,
      currentRuntimeReceiptSha256:sha256(receipts.get("runtime-outcome.json")),nativeSchedulesEnabled:false,
      maintenanceUnitsInstalledButDisabled:true,frontendDeploymentId:plan.currentFrontendDeployment,
      authenticatedBrowserSshRetained:true,actualContainerCount:8});
    return outcome;
  } catch(error) {
    outcome.failureCode=error?.code==="ERR_ASSERTION"?"REVIEWED_STATE_ASSERTION_FAILED":"ACTION_PHASE_FAILED";
    if(newSsh&&activeReceipt)try {
      const files=await retain(activeReceipt);outcome.remoteReceiptsRetained=true;
      const terminal=activeReceipt==="cold-restore"?"cold-restore-outcome.json":activeReceipt.startsWith("maintenance-")?"maintenance-outcome.json":"preparation-outcome.json";
      if(!files.has(terminal))outcome.remotePhaseMayStillBeRunning=true;
    }catch {outcome.remotePhaseMayStillBeRunning=true;}
    throw Error("STAGING_ACCESS_RECOVERY_REQUIRES_REVIEW");
  } finally {
    Object.assign(outcome,{phase,completedAt:Date.now()});await record("action-outcome",outcome);
    for(const name of ["SIGINT","SIGTERM","SIGHUP"])process.removeListener(name,stop);
  }
}

export async function main(args=process.argv.slice(2)) {
  assert.ok(args.length===2&&args[0]==="plan"||args.length===4&&args[0]==="apply"&&args[2]==="--confirm",
    "Usage: cold-recover-staging.mjs plan SETTINGS | apply SETTINGS --confirm staging/ACTION");
  const settings=recoverySettings(await privateJson(resolve(args[1])));
  print(await runAccessRecovery(settings,{apply:args[0]==="apply",confirmation:args[3]}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(()=>{process.stderr.write("STAGING_ACCESS_RECOVERY_REFUSED_OR_REQUIRES_REVIEW\n");process.exitCode=1;});
