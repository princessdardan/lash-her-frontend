// Initial P1 host exercise only. Routine releases do not repeat this lifecycle.
import assert from "node:assert/strict";
import {randomBytes,createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify,parseEnv} from "node:util";
import {readFile,lstat,mkdir} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
import {operatorAwsCli} from "./aws_cli.mjs";
import {infrastructureController,stagingInfrastructureSpec} from "./infrastructure.mjs";
import {hostTemplateSha256} from "./host_lifecycle.mjs";
import {githubSourceApi} from "./release-inputs.mjs";
import {compileRecreationPrograms,collectPrivateInputs,sha256} from "./recreation_inputs.mjs";
import {committedOperatorSource,verifyOperatorCi} from "./recreation_source.mjs";
import {durablePrivateFile,executeRecreation} from "./recreation_controller.mjs";
import {recreationSsh} from "./recreation_ssh.mjs";
import {operatorAcceptedSshTrust} from "./ssh_trust.mjs";

const source=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const privateParent="/Users/dardan/.local/share/lash-her/recreations/staging";
const releaseRoot="/Users/dardan/.local/share/lash-her/releases/staging/p1-41541683416-1";
const baselines="/Users/dardan/workspace/lash-her-frontend/docs/api-integration/baselines";
const candidateSha256="b086558ed575cbdd0ceea8a3267e178e7ac390b77db9d2361cb721f750792900";
const migrationOutcomeSha256="500707409055bc6787cc756eb26f663aeeb4be1405591692e7942f05473187a9";
const expectedDeployment="dpl_CdhFqwVANweysVe9cCTNpmHfduiy";
const addressArn="arn:aws:lightsail:us-east-1:691588646557:StaticIp/dfdce3fc-150b-47c0-87df-2bffeb81e963";
const keyFile="/Users/dardan/.ssh/Dardan.pem";
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const print=value=>process.stdout.write(JSON.stringify(value)+"\n");

export function validateRecreationSettings(settings) {
  assert.ok(settings&&typeof settings==="object"&&!Array.isArray(settings));
  assert.deepEqual(Object.keys(settings).sort(),["action","sourceCommit","trustMode","version"]);
  assert.equal(settings.version,1);assert.match(settings.action,/^p1-recreate-[a-z0-9][a-z0-9-]{0,24}$/u);
  assert.match(settings.sourceCommit,/^[a-f0-9]{40}$/u);
  assert.ok(["pending","operator-first-use","provider-browser"].includes(settings.trustMode));
  return settings;
}

async function privateParents(target) {
  const missing=[];let path=target;
  for(;;) {
    try {assert.equal((await lstat(path)).isSymbolicLink(),false);break;}
    catch(error){if(error.code!=="ENOENT")throw error;missing.push(path);path=dirname(path);}
  }
  for(const path of missing.reverse())await mkdir(path,{mode:0o700});
  const info=await lstat(target);assert.ok(info.isDirectory()&&info.uid===process.getuid()&&(info.mode&0o077)===0);
}

async function privateJson(path) {
  const info=await lstat(path);
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o077)===0&&info.size<=100_000);
  return JSON.parse(await readFile(path,"utf8"));
}

export async function prepareRecreation(settings) {
  validateRecreationSettings(settings);
  const committed=committedOperatorSource(source,settings.sourceCommit);
  const programs=await compileRecreationPrograms(source,build);
  const inputs=await collectPrivateInputs({source,programs,releaseRoot,
    compatibilityCandidate:"/private/tmp/lash-p1-compatible-runtime-inputs/compatible.candidate.json",
    compatibilityProof:"/private/tmp/lash-p1-compatible-runtime-inputs/compatibility-proof.json",
    inventory:join(baselines,"2026-11-02-mux-dev-webhook-dashboard-inventory.json"),
    acmeRoot:"/Users/dardan/.local/share/lash-her/releases/staging/p1-41524352057-1/host-recreation-backup/owned-file-restore/acme-staging",
    candidateSha256,migrationOutcomeSha256});
  const templateBody=await readFile(join(source,"ops/aws/lightsail-host.cfn.json"),"utf8");
  const spec=stagingInfrastructureSpec(templateBody,hostTemplateSha256(templateBody),addressArn);
  const packageLockSha256=sha256(await readFile(join(source,"ops/platform/host/packages.lock.json")));
  return {committed,programs,inputs,templateBody,spec,packageLockSha256};
}

async function releaseBindings() {
  // The operator's existing 1Password Environment may prompt on this read.
  // Only selected bindings leave this function; no dotenv value is printed.
  const values=parseEnv(await readFile("/Users/dardan/workspace/lash-her-frontend/.env","utf8"));
  const names=["PLATFORM_SOURCE_READ_TOKEN","VERCEL_TOKEN","GHCR_READ_TOKEN","GHCR_USERNAME",
    "FRONTEND_STAGING_MIGRATION_DATABASE_URL","COURSE_STAGING_DATABASE_URL","COMMUNITY_STAGING_DATABASE_URL"];
  for(const name of names)assert.ok(typeof values[name]==="string"&&values[name].length>0,"Existing release bindings required");
  return Object.fromEntries(names.map(name=>[name,values[name]]));
}

async function freshInventory(action,phase,signal) {
  const path=join(privateParent,"incoming/mux-inventory.json");let announced=false;
  for(;;) {
    if(signal.aborted)throw Error("STAGING_RECREATION_STOP_REQUESTED");
    try {
      const value=await privateJson(path);
      assert.equal(value.status,"MUX_DEV_DASHBOARD_INVENTORY_VERIFIED");assert.equal(value.environmentId,"7j65e8");
      assert.equal(value.organizationId,"4g1uhq");assert.equal(value.inventoryComplete,true);assert.equal(value.settingsChanged,false);
      if(Number.isSafeInteger(value.observedAt)&&Date.now()-value.observedAt>=0&&Date.now()-value.observedAt<=300_000) {
        const raw=await readFile(path);return {sha256:sha256(raw),data:raw.toString("base64")};
      }
    } catch(error){if(error.code!=="ENOENT")throw error;}
    if(!announced){print({status:"WAITING_FOR_FRESH_MUX_INVENTORY",action,phase,path});announced=true;}
    await pause(1000);
  }
}

export async function runRecreation(settings,{apply=false,confirmation}={}) {
  validateRecreationSettings(settings);
  if(apply) {
    assert.equal(confirmation,`staging/${settings.action}`,"Explicit complete staging recreation confirmation required");
    assert.equal(settings.trustMode,"operator-first-use","New-host trust choice must be resolved and implemented before apply");
  }
  const prepared=await prepareRecreation(settings);
  const directory=join(privateParent,settings.action);
  const common={action:settings.action,privateDirectory:directory,sourceCommit:settings.sourceCommit,sourceFiles:prepared.committed.files,
    inputs:prepared.inputs,programs:prepared.programs.programs,expectedDeployment,spec:prepared.spec,
    templateBody:prepared.templateBody,packageLockSha256:prepared.packageLockSha256};
  if(!apply)return {...await executeRecreation(common),trustMode:settings.trustMode,sourceCiVerified:false,
    startRequiresCurrentSourceCi:true,startRequiresFreshMuxInventory:true,
    trustChoiceResolved:settings.trustMode!=="pending",trustModeImplemented:settings.trustMode==="operator-first-use",
    privateReceiptDirectory:directory,inputValuesDisplayed:false};
  // No firewall expansion is inferred from the pending browser-SSH option.
  const abort=new AbortController();
  const interrupted=()=>abort.abort();
  for(const signal of ["SIGTERM","SIGINT","SIGHUP"])process.on(signal,interrupted);
  try {
    const bindings=await releaseBindings();
    const verifySource=()=>verifyOperatorCi({api:githubSourceApi(bindings.PLATFORM_SOURCE_READ_TOKEN),sourceCommit:settings.sourceCommit,
      branch:prepared.committed.branch,workflowBytes:prepared.committed.workflowBytes});
    await privateParents(privateParent);await privateParents(join(privateParent,"incoming"));
    const oldDiagnostics=join(privateParent,settings.action+"-ssh-old");await mkdir(oldDiagnostics,{mode:0o700});
    const newDiagnostics=join(privateParent,settings.action+"-ssh-new");await mkdir(newDiagnostics,{mode:0o700});
    const oldSsh=await recreationSsh({knownHosts:"/private/tmp/lash-her-staging-20261102-known_hosts",keyFile,diagnostics:oldDiagnostics,signal:abort.signal});
    let authenticatedNewSsh;
    const newSsh=Object.fromEntries(["machine","installSource","privateFiles","prepare","phase","maintenance"].map(name=>[name,(...args)=> {
      assert.ok(authenticatedNewSsh,"New SSH trust has not been established");return authenticatedNewSsh[name](...args);
    }]));
    const baseAws=operatorAwsCli({binary:"/Users/dardan/.local/bin/aws"});
    const aws=request=> {
      if(abort.signal.aborted&&["CreateChangeSet","ExecuteChangeSet"].includes(request.operation))throw Error("STAGING_RECREATION_STOP_REQUESTED");
      return baseAws(request);
    };
    const observer=infrastructureController({spec:prepared.spec,templateBody:prepared.templateBody,aws,record:async()=>{}});
    const establishTrust=async(instance,startedAt)=> {
      const response=await promisify(execFile)("/usr/bin/ssh-keyscan",["-T","10","-t","ed25519",prepared.spec.address],
        {env:Object.fromEntries(["PATH","HOME"].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),timeout:15000,maxBuffer:65536});
      const lines=response.stdout.trim().split("\n");assert.equal(lines.length,1);
      const [address,algorithm,key]=lines[0].split(/\s+/u);assert.equal(address,prepared.spec.address);assert.equal(algorithm,"ssh-ed25519");
      const fingerprint="SHA256:"+createHash("sha256").update(Buffer.from(key,"base64")).digest("base64").replace(/=+$/u,"");
      const path=join(privateParent,"incoming/ssh-trust-"+settings.action+".json");
      print({status:"WAITING_FOR_OPERATOR_FIRST_USE_ACCEPTANCE",action:settings.action,instanceArn:instance.instanceArn,
        address,fingerprint,proofPath:path,awsAuthenticatedHostKey:false});
      let proof;
      for(;;) {
        if(abort.signal.aborted)throw Error("STAGING_RECREATION_STOP_REQUESTED");
        try {proof=await privateJson(path);break;}catch(error){if(error.code!=="ENOENT")throw error;}
        await pause(1000);
      }
      assert.equal(proof.acceptedFingerprint,fingerprint);assert.equal(proof.hostPublicKey,algorithm+" "+key);
      const current=await observer.state("attached");assert.equal(current.instanceArn,instance.instanceArn);
      const trusted=operatorAcceptedSshTrust(proof,current,prepared.spec,settings.action,startedAt);
      const knownHosts=join(directory,"new-host-known_hosts");await durablePrivateFile(knownHosts,Buffer.from(trusted.knownHosts));
      await durablePrivateFile(join(directory,"new-host-trust.json"),Buffer.from(JSON.stringify({...trusted,knownHosts:undefined})+"\n"));
      authenticatedNewSsh=await recreationSsh({knownHosts,keyFile,diagnostics:newDiagnostics,signal:abort.signal});
    };
    const result=await executeRecreation({...common,apply:true,confirmation,oldSsh,newSsh,aws,verifySource,establishTrust,
      freshInventory:phase=>freshInventory(settings.action,phase,abort.signal),
      privateFingerprintKey:randomBytes(32).toString("hex"),
      databaseCredentials:{frontend:bindings.FRONTEND_STAGING_MIGRATION_DATABASE_URL,course:bindings.COURSE_STAGING_DATABASE_URL,community:bindings.COMMUNITY_STAGING_DATABASE_URL},
      vercelToken:bindings.VERCEL_TOKEN,registry:{username:bindings.GHCR_USERNAME,token:bindings.GHCR_READ_TOKEN},
      progress:value=>{if(abort.signal.aborted)throw Error("STAGING_RECREATION_STOP_REQUESTED");print(value);}});
    return result;
  } finally {
    for(const signal of ["SIGTERM","SIGINT","SIGHUP"])process.removeListener(signal,interrupted);
  }
}

export async function main(args=process.argv.slice(2)) {
  assert.ok((args.length===2&&args[0]==="plan")||(args.length===4&&args[0]==="apply"&&args[2]==="--confirm"),
    "Usage: recreate-staging.mjs plan SETTINGS | apply SETTINGS --confirm staging/ACTION");
  const settings=validateRecreationSettings(await privateJson(resolve(args[1])));
  const result=await runRecreation(settings,{apply:args[0]==="apply",confirmation:args[3]});print(result);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(()=>{process.stderr.write('STAGING_RECREATION_REFUSED_OR_REQUIRES_REVIEW\n');process.exitCode=1;});
