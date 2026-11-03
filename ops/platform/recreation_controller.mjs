// One reviewed local lifecycle. AWS and SSH bindings are supplied by the CLI;
// actual receipts are saved privately before compute removal. No SQL apply,
// automatic mutation retry, production target or traffic admission exists here.
import assert from "node:assert/strict";
import {open,mkdir,lstat} from "node:fs/promises";
import {dirname,join,isAbsolute} from "node:path";
import {infrastructureController,verifyRetirementForInfrastructure} from "./infrastructure.mjs";
import {decodePrivateReceipts,manifestSha256,replacePrivateInput,sha256} from "./recreation_inputs.mjs";

const originalMachine="ec265c34b9fbf4d051aecfa185362c0a";
const imageKeys={"gateway":"gateway","course-api":"courseRuntime","course-tls":"gateway","course-publisher":"courseRuntime",
  "course-snapshot":"courseRuntime","community-api":"communityRuntime","community-tls":"gateway","community-worker":"communityRuntime"};
const parsed=(files,name)=>JSON.parse(files.get(name));

export async function durablePrivateFile(path,raw) {
  assert.ok(isAbsolute(path));
  const parent=await lstat(dirname(path));
  assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===process.getuid()&&(parent.mode&0o077)===0,"Private receipt directory required");
  const file=await open(path,"wx",0o600);
  try {await file.writeFile(raw);await file.sync();}finally{await file.close();}
  const directory=await open(dirname(path),"r");
  try {await directory.sync();}finally{await directory.close();}
}

function verifyCurrentRuntime(value,inputs,machine) {
  assert.equal(value.status,"API_RUNTIME_RESTORED_FOR_QUALIFICATION");assert.equal(value.phase,"completed");
  assert.equal(value.environment,"staging");assert.equal(value.releaseId,inputs.selected.releaseId);
  assert.equal(value.hostMachineId,machine);assert.equal(value.candidateSha256,inputs.candidateSha256);
  assert.equal(value.migrationOutcomeSha256,inputs.migrationOutcomeSha256);
  assert.equal(value.trafficAuthorized,false);assert.equal(value.releaseAccepted,false);
  assert.equal(value.containers?.length,8);assert.equal(new Set(value.containers.map(c=>c.containerId)).size,8);
  assert.deepEqual(value.containers.map(c=>c.service).sort(),Object.keys(imageKeys).sort());
  for(const container of value.containers) {
    assert.match(container.containerId,/^[a-f0-9]{64}$/u);
    assert.equal(container.image,inputs.selected.artifacts[imageKeys[container.service]].image);
  }
  return value;
}

export async function executeRecreation({action,privateDirectory,sourceCommit,sourceFiles,inputs,programs,
  expectedDeployment,privateFingerprintKey,databaseCredentials,vercelToken,registry,spec,templateBody,packageLockSha256,
  aws,oldSsh,newSsh,freshInventory,establishTrust,verifySource,progress=()=>{},now=Date.now,apply=false,confirmation}) {
  assert.match(action,/^p1-recreate-[a-z0-9][a-z0-9-]{0,24}$/u);
  assert.match(sourceCommit,/^[a-f0-9]{40}$/u);
  assert.equal(inputs.selected.environment,"staging");assert.equal(inputs.selected.releaseId,"p1-41541683416-1");
  assert.match(expectedDeployment,/^dpl_[A-Za-z0-9]+$/u);
  const plan={status:"STAGING_HOST_RECREATION_PLAN",action,environment:"staging",releaseId:inputs.selected.releaseId,
    sourceCommit,accountId:spec.accountId,stackId:spec.stackId,address:spec.address,
    candidateSha256:inputs.candidateSha256,migrationOutcomeSha256:inputs.migrationOutcomeSha256,
    expectedFrontendDeploymentId:expectedDeployment,inputFiles:inputs.files.length,privateInputManifestSha256:inputs.manifestSha256,
    review:inputs.review??null,
    migrationsExecuted:false,productionChanged:false,trafficAuthorized:false,releaseAccepted:false,executionAuthorized:false};
  if(!apply)return plan;
  assert.equal(confirmation,`staging/${action}`,"Explicit complete staging recreation confirmation required");
  assert.match(privateFingerprintKey,/^[a-f0-9]{64}$/u);
  assert.ok(isAbsolute(privateDirectory)&&typeof freshInventory==="function"&&typeof establishTrust==="function"&&typeof verifySource==="function");
  const parentInfo=await lstat(dirname(privateDirectory));
  assert.ok(parentInfo.isDirectory()&&parentInfo.uid===process.getuid()&&(parentInfo.mode&0o077)===0,"Private action parent required");
  for(let parent=dirname(privateDirectory);;parent=dirname(parent)) {
    assert.equal((await lstat(parent)).isSymbolicLink(),false,"Canonical private action path required");
    try {await lstat(join(parent,".git"));assert.fail("Private action receipts must stay outside Git");}
    catch(error){if(error.code!=="ENOENT")throw error;}
    if(dirname(parent)===parent)break;
  }
  await mkdir(privateDirectory,{mode:0o700});
  const record=async(name,value)=>durablePrivateFile(join(privateDirectory,name+".json"),Buffer.from(JSON.stringify(value)+"\n"));
  const infrastructure=infrastructureController({spec,templateBody,aws,record,now});
  const startedAt=now();
  const remote=`/var/lib/lash-her/releases/staging/${action}`;
  const common={version:1,environment:"staging",action,releaseId:inputs.selected.releaseId,
    candidate_sha256:inputs.candidateSha256,checker_sha256:inputs.checkerSha256,previous_sha256:inputs.previousSha256,proof_sha256:inputs.proofSha256,
    configuration_sha256:inputs.configurationSha256,expected_deployment:expectedDeployment,programs,privateFingerprintKey,vercelToken};
  const paths={bundle:remote+"/inputs/bundle",configuration:remote+"/inputs/configuration",database_receipts:remote+"/inputs/database-receipts",
    runtime_receipts:remote+"/inputs/runtime-receipts",compose_file:remote+"/inputs/compose.yaml",programs_directory:remote+"/inputs/programs",
    compatibility_directory:remote+"/inputs/compatibility",inventory_directory:remote+"/inputs/inventory",
    retirement_directory:remote+"/inputs/retirement"};
  let phase="source-preflight",newMachine=null,newInstance=null,receiptSequence=0,activeReceipt=null;
  let maintenanceStartedAt=null,retirementRequestedAt=null,runtimeObservedAt=null;
  const outcome={status:"STAGING_RECREATION_REQUIRES_REVIEW",action,environment:"staging",releaseId:inputs.selected.releaseId,
    sourceCommit,startedAt,candidateSha256:inputs.candidateSha256,migrationsExecuted:false,productionChanged:false,
    trafficAuthorized:false,releaseAccepted:false,nativeSchedulerVerified:false};
  async function intent(name) {
    phase=name;await record("step-"+String(++receiptSequence).padStart(2,"0")+"-"+name,{action,phase,startedAt:now()});
    await progress({status:"STAGING_RECREATION_PROGRESS",action,phase});
  }
  async function retain(ssh,name,targetName=name) {
    const response=await ssh.privateFiles(sourceCommit,{version:1,operation:"receipts",action,phase:name});
    const files=decodePrivateReceipts(response,name),directory=join(privateDirectory,targetName);
    await mkdir(directory,{mode:0o700});
    for(const [path,raw] of files) {
      const target=join(directory,path);
      const missing=[];let parent=dirname(target);
      for(;;) {try{await lstat(parent);break;}catch(error){if(error.code!=="ENOENT")throw error;missing.push(parent);parent=dirname(parent);}}
      for(const directory of missing.reverse())await mkdir(directory,{mode:0o700});
      await durablePrivateFile(target,raw);
    }
    return files;
  }
  async function stage(ssh,files) {
    const result=await ssh.privateFiles(sourceCommit,{version:1,operation:"stage",action,files,manifestSha256:manifestSha256(files)});
    assert.equal(result.status,"RECREATION_PRIVATE_INPUTS_STAGED");assert.equal(result.manifestSha256,manifestSha256(files));
  }
  async function prepare(ssh,operation,machine) {
    await intent(operation);
    activeReceipt={ssh,name:"prepare-"+operation};
    const result=await ssh.prepare(sourceCommit,{version:1,environment:"staging",operation,action,expectedMachineId:machine,
      confirmation:`staging/${action}/${operation}`,candidate_sha256:inputs.candidateSha256,previous_sha256:inputs.previousSha256,
      proof_sha256:inputs.proofSha256,packageLockSha256,registryUsername:registry.username,registryReadToken:registry.token});
    assert.equal(result.status,operation==="bootstrap"?"RECREATION_FRESH_BOOTSTRAP_COMPLETE":"RECREATION_EXACT_IMAGES_CACHED");
    const receipts=await retain(ssh,"prepare-"+operation);
    assert.equal(parsed(receipts,"preparation-outcome.json").status,result.status);
    activeReceipt=null;
  }
  try {
    const source=await verifySource();
    assert.equal(source.sourceCommit,sourceCommit);assert.equal(source.requiredChecks,"passed");
    await record("source-ci",source);
    await record("action-started",{...outcome,privateReceiptDestination:privateDirectory,privateReceiptValuesDisplayed:false});
    await durablePrivateFile(join(privateDirectory,"private-fingerprint-key"),Buffer.from(privateFingerprintKey+"\n"));
    assert.equal((await infrastructure.state("attached")).instanceArn,spec.originalInstanceArn);
    assert.deepEqual(await oldSsh.machine(),{status:"SSH_MACHINE_ID_OBSERVED",machineId:originalMachine});
    await intent("install-old-host-operator");
    assert.equal((await oldSsh.installSource({commit:sourceCommit,files:sourceFiles})).status,"EXACT_OPERATOR_SOURCE_INSTALLED");
    await intent("stage-old-host-inputs");await stage(oldSsh,inputs.files);
    await prepare(oldSsh,"cache-compatible",originalMachine);
    const inventory=await freshInventory("rollback");
    assert.equal(sha256(Buffer.from(inventory.data,"base64")),inventory.sha256);
    await durablePrivateFile(join(privateDirectory,"external-inventory-rollback.json"),Buffer.from(inventory.data,"base64"));
    await intent("compatible-runtime-rollback");
    maintenanceStartedAt=now();activeReceipt={ssh:oldSsh,name:"rollback"};
    const rollback=await oldSsh.phase(sourceCommit,{...common,operation:"rollback",inventory_sha256:inventory.sha256,
      externalInventory:inventory.data,paths:{...paths,inventory_directory:remote+"/inventory-rollback",output:remote+"/rollback"},
      databaseCredentials,confirmation:`staging/${common.releaseId}/rollback-${action}`});
    assert.equal(rollback.status,"STAGING_COMPATIBLE_ROLLBACK_AND_CURRENT_RESTORE_VERIFIED");
    const rollbackFiles=await retain(oldSsh,"rollback");
    assert.equal(parsed(rollbackFiles,"rollback-outcome.json").status,rollback.status);
    const readyBytes=rollbackFiles.get("restored-current/runtime-outcome.json");assert.ok(readyBytes);
    const current=verifyCurrentRuntime(JSON.parse(readyBytes),inputs,originalMachine);
    activeReceipt=null;
    const finalInventory=await freshInventory("retirement");
    assert.equal(sha256(Buffer.from(finalInventory.data,"base64")),finalInventory.sha256);
    await durablePrivateFile(join(privateDirectory,"external-inventory-retirement.json"),Buffer.from(finalInventory.data,"base64"));
    await intent("final-retirement");
    retirementRequestedAt=now();activeReceipt={ssh:oldSsh,name:"retirement"};
    const retiredResult=await oldSsh.phase(sourceCommit,{...common,operation:"retire",inventory_sha256:finalInventory.sha256,
      externalInventory:finalInventory.data,paths:{...paths,configuration:remote+"/rollback/restored-current/configuration",
        runtime_receipts:remote+"/rollback/restored-current",inventory_directory:remote+"/inventory-retirement",output:remote+"/retirement"},
      confirmation:`staging/${common.releaseId}/retire-${action}`});
    assert.equal(retiredResult.status,"STAGING_RUNTIME_QUIESCED_FOR_RECREATION");
    const retirementFiles=await retain(oldSsh,"retirement"),retired=parsed(retirementFiles,"retirement-outcome.json");
    verifyRetirementForInfrastructure(retired,inputs.candidateSha256);
    assert.equal(retired.migrationOutcomeSha256,inputs.migrationOutcomeSha256);assert.equal(retired.runtimeReceiptSha256,sha256(readyBytes));
    assert.deepEqual(retired.stoppedContainers.map(c=>c.containerId).sort(),current.containers.map(c=>c.containerId).sort());
    for(const name of ["pending-work/retained-work.json","pending-work/business-baseline.json"])assert.ok(retirementFiles.has(name));
    const retained=parsed(retirementFiles,"pending-work/retained-work.json");
    assert.equal(retained.status,"STAGING_DURABLE_WORK_RETAINED");assert.equal(retained.events?.length,2);
    await record("off-host-retirement-retained",{retirementOutcomeSha256:sha256(retirementFiles.get("retirement-outcome.json")),
      currentRuntimeReceiptSha256:sha256(readyBytes),pendingWorkReceiptsRetained:true,privateReceiptValuesDisplayed:false});
    activeReceipt=null;
    // All off-host receipt writes above are fsynced before the first AWS change.
    await intent("detach-instance");await infrastructure.step("attached","detached",action+"-detach",inputs.candidateSha256,retired);
    await intent("remove-instance");await infrastructure.step("detached","absent",action+"-remove",inputs.candidateSha256,retired);
    await intent("create-instance");
    newInstance=await infrastructure.step("absent","attached",action+"-create",inputs.candidateSha256,retired);
    assert.notEqual(newInstance.instanceArn,spec.originalInstanceArn);
    assert.ok(Date.parse(newInstance.instanceCreatedAt)>=startedAt,"New instance creation time required");
    await intent("new-host-ssh-trust");await establishTrust(newInstance,startedAt);
    const fresh=await newSsh.machine();
    assert.equal(fresh.status,"SSH_MACHINE_ID_OBSERVED");assert.match(fresh.machineId,/^[a-f0-9]{32}$/u);
    assert.notEqual(fresh.machineId,originalMachine);newMachine=fresh.machineId;
    await record("new-machine-identity",{oldMachineId:originalMachine,newMachineId:newMachine,instanceArn:newInstance.instanceArn,address:spec.address});
    await intent("install-new-host-operator");
    assert.equal((await newSsh.installSource({commit:sourceCommit,files:sourceFiles})).status,"EXACT_OPERATOR_SOURCE_INSTALLED");
    let restoredFiles=replacePrivateInput(inputs.files,"runtime-receipts/runtime-outcome.json",readyBytes);
    for(const name of ["retirement-outcome.json","pending-work/retained-work.json","pending-work/business-baseline.json"])
      restoredFiles=replacePrivateInput(restoredFiles,"retirement/"+name,retirementFiles.get(name));
    await intent("stage-new-host-inputs");await stage(newSsh,restoredFiles);
    await prepare(newSsh,"bootstrap",newMachine);await prepare(newSsh,"cache-current",newMachine);
    await intent("install-maintenance-disabled");
    activeReceipt={ssh:newSsh,name:"maintenance-install"};
    assert.equal((await newSsh.maintenance(sourceCommit,{version:1,environment:"staging",operation:"install",action,expectedMachineId:newMachine,
      confirmation:`staging/${action}/maintenance-install`})).status,"RECREATION_MAINTENANCE_INSTALLED_DISABLED");
    await retain(newSsh,"maintenance-install");
    activeReceipt=null;
    await intent("restore-runtime-and-qualify-frontend");
    activeReceipt={ssh:newSsh,name:"restore"};
    assert.equal((await newSsh.phase(sourceCommit,{...common,operation:"restore",inventory_sha256:finalInventory.sha256,
      paths:{...paths,output:remote+"/restore"},new_machine:newMachine,retirement_sha256:sha256(retirementFiles.get("retirement-outcome.json")),
      databaseCredentials,confirmation:`staging/${common.releaseId}/restore-${action}`})).status,"API_RUNTIME_RESTORED_FOR_QUALIFICATION");
    runtimeObservedAt=now();
    const restored=await retain(newSsh,"restore");
    const restoredRuntime=verifyCurrentRuntime(parsed(restored,"runtime-outcome.json"),inputs,newMachine);
    const oldContainerIds=new Set(current.containers.map(container=>container.containerId));
    assert.ok(restoredRuntime.containers.every(container=>!oldContainerIds.has(container.containerId)),"NEW_HOST_CONTAINER_IDENTITIES_REQUIRED");
    const qualification=parsed(restored,"native-qualification/qualification-outcome.json");
    assert.equal(qualification.status,"NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE");
    assert.equal(qualification.restoredRuntimeReceiptSha256,sha256(restored.get("runtime-outcome.json")));
    assert.equal(qualification.nativeSchedulesDisabled,true);assert.equal(qualification.nativeSchedulerVerified,false);
    activeReceipt=null;
    await intent("activate-maintenance");
    activeReceipt={ssh:newSsh,name:"maintenance-activate"};
    assert.equal((await newSsh.maintenance(sourceCommit,{version:1,environment:"staging",operation:"activate",action,expectedMachineId:newMachine,
      vercelToken,confirmation:`staging/${action}/maintenance-activate`})).status,"RECREATION_MAINTENANCE_ACTIVE");
    await retain(newSsh,"maintenance-activate");
    activeReceipt=null;
    outcome.status="STAGING_HOST_RECREATED_AWAITING_PROVIDER_AND_EXTERNAL_EVIDENCE";
    outcome.frontendDeploymentId=qualification.frontendDeploymentId;
    outcome.nativeSchedulesDisabled=true;
    return outcome;
  } catch(error) {
    outcome.failureCode=/^[A-Z_]{1,100}$/u.test(error.message??"")?error.message:"STAGING_RECREATION_REQUIRES_REVIEW";
    if(activeReceipt) {
      // This is fixed-file observation, not another phase execution. An absent
      // terminal receipt remains uncertainty; it never authorizes a retry.
      try {
        await retain(activeReceipt.ssh,activeReceipt.name,"failure-"+activeReceipt.name);
        outcome.remotePhaseTerminalReceiptsRetained=true;
      } catch {
        outcome.remotePhaseMayStillBeRunning=true;
        outcome.remoteTerminalStateUnverified=true;
      }
    }
    throw new Error(outcome.failureCode);
  } finally {
    Object.assign(outcome,{phase,completedAt:now(),actionElapsedMilliseconds:now()-startedAt,
      maintenanceActionMilliseconds:maintenanceStartedAt===null?null:now()-maintenanceStartedAt,
      gatewayOutageUpperBoundMilliseconds:runtimeObservedAt===null?null:runtimeObservedAt-retirementRequestedAt,
      newHostMachineId:newMachine,newInstanceArn:newInstance?.instanceArn??null});
    await record("action-outcome",outcome);
  }
}
