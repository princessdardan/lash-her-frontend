// Local private handoff assembly. These bytes must never be printed, committed,
// or included in the sanitized plan/outcome. No provider or database is queried.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {lstat,readFile,readdir} from "node:fs/promises";
import {dirname,isAbsolute,join,relative,resolve} from "node:path";

export const CONFIGURATION_FILES = ["runtime.json","gateway.json","course-tls.json","community-tls.json",
  "tls/ca.pem","tls/gateway/ca.pem","tls/gateway/key.pem","tls/gateway/cert.pem","tls/course/key.pem","tls/course/cert.pem",
  "tls/community/key.pem","tls/community/cert.pem","course-api.env","course-publisher.env","course-snapshot.env","community-api.env","community-worker.env"];
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const manifestSha256 = files => sha256(JSON.stringify(Object.fromEntries(files.map(f=>[f.path,f.sha256]).sort(([a],[b])=>a<b?-1:a>b?1:0))));

async function regular(path, privateFile=true) {
  assert.ok(isAbsolute(path));
  for(let current=path;;current=dirname(current)) {
    const info=await lstat(current);
    assert.equal(info.isSymbolicLink(),false,"Handoff symlink refused");
    if(dirname(current)===current)break;
  }
  const info=await lstat(path);
  assert.ok(info.isFile()&&info.size>0&&info.size<=2_000_000,"Bounded regular handoff file required");
  if(privateFile)assert.ok(info.uid===process.getuid()&&(info.mode&0o077)===0,"Operator-private handoff file required");
  const raw=await readFile(path);
  assert.equal(raw.length,info.size,"Handoff input changed during read");
  return raw;
}

function record(path,raw) {
  assert.ok(/^[\x21-\x7e]+$/u.test(path)&&!path.startsWith("/")&&!path.split("/").includes("..")&&!path.includes("\\"));
  return {path,sha256:sha256(raw),data:raw.toString("base64")};
}

export async function compileRecreationPrograms(source, build) {
  assert.equal(typeof build,"function");
  const programs={},files=[],sourceSha256={};
  for(const [name,entry] of [["fixture","staging_fixture.mjs"],["work","staging_work_image.mjs"]]) {
    const result=await build({stdin:{contents:`import {main} from './ops/platform/host/${entry}'; await main();`,
      resolveDir:source,sourcefile:`staging-${name}-entry.mjs`},bundle:true,write:false,platform:"node",format:"esm",target:"node24",
      packages:"external",external:["/app/*"],metafile:true,logLevel:"silent"});
    assert.equal(result.outputFiles?.length,1);
    const raw=Buffer.from(result.outputFiles[0].contents);
    assert.ok(raw.length>0&&raw.length<=65_536,"Bounded reviewed operator program required");
    const inputs={};
    for(const path of Object.keys(result.metafile.inputs)) {
      if(path===`staging-${name}-entry.mjs`)continue;
      const absolute=resolve(source,path),rel=relative(source,absolute);
      assert.ok(rel.startsWith("ops/platform/host/")&&!rel.includes(".."),"Only owned operator modules may be bundled");
      inputs[rel]=sha256(await regular(absolute,false));
    }
    const file=`staging-${name}-operator.mjs`;
    programs[name]={file,sha256:sha256(raw)};
    files.push(record("programs/"+file,raw));
    sourceSha256[name]=inputs;
  }
  return {programs,files,sourceSha256};
}

export async function collectPrivateInputs({releaseRoot,source,compatibilityCandidate,compatibilityProof,inventory,acmeRoot,programs,
  candidateSha256,migrationOutcomeSha256}) {
  const files=[];
  const add=async(name,path,privateFile=true)=>files.push(record(name,await regular(path,privateFile)));
  const bundle=join(releaseRoot,"bundle-p1-41541683416-1");
  for(const name of ["release.candidate.json","build.candidate.json",...['frontend','course','community'].flatMap(n=>[`jobs/${n}.json`,`schema/${n}.json`])])
    await add("bundle/"+name,join(bundle,name));
  for(const name of CONFIGURATION_FILES)await add("configuration/"+name,join(releaseRoot,"runtime",name));
  await add("compose.yaml",join(source,"ops/platform/compose.yaml"),false);
  for(const name of ["candidate.json","migration-outcome.json",...['frontend','course','community'].flatMap(n=>[`${n}/database-receipt.json`,`${n}/job-outcome.json`])])
    await add("database-receipts/"+name,join(releaseRoot,"raw-live-receipts/databases",name));
  await add("runtime-receipts/runtime-outcome.json",join(releaseRoot,"raw-live-receipts/runtime/runtime-outcome.json"));
  await add("compatibility/compatible.candidate.json",compatibilityCandidate,false);
  await add("compatibility/compatibility-proof.json",compatibilityProof,false);
  await add("inventory/mux-inventory.json",inventory,false);
  await add("maintenance/private-ca/ca.key",join(releaseRoot,"private-ca/ca.key"));
  await add("maintenance/private-ca/ca.pem",join(releaseRoot,"runtime/tls/ca.pem"));
  await add("maintenance/certificates-staging.json",join(releaseRoot,"maintenance/certificates-staging.json"));
  async function walk(path) {
    for(const entry of await readdir(path,{withFileTypes:true})) {
      const absolute=join(path,entry.name);
      assert.equal(entry.isSymbolicLink(),false,"Existing ACME recovery symlink refused");
      if(entry.isDirectory())await walk(absolute);
      else {assert.ok(entry.isFile());await add("maintenance/acme-staging/"+relative(acmeRoot,absolute),absolute);}
    }
  }
  await walk(acmeRoot);
  assert.equal(files.filter(f=>f.path.startsWith("maintenance/acme-staging/")).length,8);
  files.push(...programs.files);
  assert.equal(new Set(files.map(f=>f.path)).size,files.length,"Duplicate handoff input refused");
  const bytes=name=>Buffer.from(files.find(f=>f.path===name).data,"base64");
  assert.equal(sha256(bytes("database-receipts/candidate.json")),candidateSha256);
  assert.equal(sha256(bytes("database-receipts/migration-outcome.json")),migrationOutcomeSha256);
  const selected=JSON.parse(bytes("bundle/release.candidate.json"));
  assert.deepEqual(selected,JSON.parse(bytes("database-receipts/candidate.json")));
  assert.equal(selected.environment,"staging");assert.equal(selected.releaseId,"p1-41541683416-1");
  assert.equal(selected.runtime.composeSha256,"sha256:"+sha256(bytes("compose.yaml")));
  const configHashes=Object.fromEntries(CONFIGURATION_FILES.map(name=>[name,sha256(bytes("configuration/"+name))]));
  const previous=JSON.parse(bytes("compatibility/compatible.candidate.json"));
  const review={frontendProjectId:selected.workload.projectId,frontendSourceCommit:selected.sources.frontend.commit,
    currentImages:Object.fromEntries(Object.entries(selected.artifacts).map(([name,value])=>[name,value.image])),
    compatibleRuntimeImages:Object.fromEntries(["gateway","courseRuntime","communityRuntime"].map(name=>[name,previous.images[name]])),
    compatibleRuntimeWasOnlyOwnedQualified:true,migrationsToExecute:[],
    databases:Object.fromEntries(["frontend","course","community"].map(name=>{
      const job=JSON.parse(bytes(`bundle/jobs/${name}.json`));
      return [name,{host:job.target.host,port:job.target.port,database:job.target.database,migrationUser:job.target.user,
        runtimeUser:job.runtimeRole,mode:"read-only-current-state"}];
    }))};
  return {files,manifestSha256:manifestSha256(files),configurationSha256:configHashes,selected,candidateSha256,migrationOutcomeSha256,
    review,
    previousSha256:sha256(bytes("compatibility/compatible.candidate.json")),proofSha256:sha256(bytes("compatibility/compatibility-proof.json")),
    inventorySha256:sha256(bytes("inventory/mux-inventory.json")),checkerSha256:sha256(await regular(join(source,"ops/platform/host/database_current.mjs"),false))};
}

export function replacePrivateInput(files,name,raw) {
  const existing=files.filter(file=>file.path!==name);
  return [...existing,record(name,raw)];
}

export function decodePrivateReceipts(value,phase) {
  assert.equal(value.status,"RECREATION_EXACT_PRIVATE_RECEIPTS");assert.equal(value.phase,phase);
  assert.ok(Array.isArray(value.files)&&value.files.length>0&&value.files.length<=30);
  const decoded=new Map();let total=0;
  for(const file of value.files) {
    assert.ok(/^[a-zA-Z0-9/.-]+\.json$/u.test(file.path)&&!file.path.startsWith("/")&&!file.path.split("/").includes("..")&&!decoded.has(file.path));
    const raw=Buffer.from(file.data,"base64");total+=raw.length;
    assert.ok(raw.toString("base64")===file.data&&raw.length<=2_000_000&&total<=10_000_000);
    assert.equal(sha256(raw),file.sha256);JSON.parse(raw);
    decoded.set(file.path,raw);
  }
  return decoded;
}
