// All remote commands are fixed reviewed programs; private inputs use stdin.
// This transport never chooses a new server key or relaxes SSH verification.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {lstat, realpath, writeFile} from "node:fs/promises";
import {isAbsolute, dirname, join} from "node:path";

const quote = value => "'" + value.replace(/'/gu, "'\"'\"'") + "'";
const header = "import json,os,pathlib,sys\n";
const inspect = header + `
if os.geteuid()!=0: raise ValueError('ROOT_REQUIRED')
machine=pathlib.Path('/etc/machine-id').read_text().strip()
if len(machine)!=32: raise ValueError('MACHINE_ID_REQUIRED')
print(json.dumps({'status':'SSH_MACHINE_ID_OBSERVED','machineId':machine}))
`;
const bareRuntime = header + `
import shutil
if os.geteuid()!=0: raise ValueError('ROOT_REQUIRED')
root=pathlib.Path('/var/lib/lash-her/releases/staging')
old=root/'p1-recreate-access-20261103-c2'
new=root/'p1-recreate-access-20261103-c3'
if any(p.exists() or p.is_symlink() for p in (old,new)) or shutil.which('docker') is not None: raise ValueError('BARE_RUNTIME_RESTORE_REQUIRED')
print(json.dumps({'status':'BARE_RUNTIME_RESTORE_VERIFIED','hostMachineId':pathlib.Path('/etc/machine-id').read_text().strip(),'failedActionInputsPresent':False,'newActionPresent':False,'dockerInstalled':False,'readOnly':True}))
`;
const sourceInstall = header + `
import base64,hashlib
if os.geteuid()!=0: raise ValueError('ROOT_REQUIRED')
p=json.load(sys.stdin)
commit=p['commit']
if len(commit)!=40 or any(c not in '0123456789abcdef' for c in commit): raise ValueError('SOURCE_COMMIT_REQUIRED')
root=pathlib.Path('/opt/lash-her/operators')/commit
if any(p.is_symlink() for p in (root,*root.parents)): raise ValueError('SOURCE_PARENT_SYMLINK_REFUSED')
if any(p.exists() and (p.stat().st_uid!=0 or p.stat().st_mode & 0o022) for p in root.parents): raise ValueError('ROOT_OWNED_SOURCE_PARENTS_REQUIRED')
files=p['files']
if not isinstance(files,list) or not 1<=len(files)<=400: raise ValueError('SOURCE_FILES_REQUIRED')
seen=set(); verified=[]; total=0
for f in files:
 name=f['path']; rel=pathlib.PurePosixPath(name)
 if not name.startswith('ops/') or rel.is_absolute() or '..' in rel.parts or name in seen: raise ValueError('SOURCE_PATH_REFUSED')
 if not name.endswith(('.py','.mjs','.json','.yaml','.yml','.service','.timer','.sh','.guard')): raise ValueError('SOURCE_TYPE_REFUSED')
 raw=base64.b64decode(f['data'],validate=True); total+=len(raw)
 if len(raw)>2000000 or total>40000000 or hashlib.sha256(raw).hexdigest()!=f['sha256']: raise ValueError('SOURCE_HASH_REFUSED')
 seen.add(name); verified.append((rel,raw))
if root.exists():
 if not root.is_dir() or root.stat().st_uid!=0 or root.stat().st_mode & 0o022: raise ValueError('ROOT_OWNED_EXISTING_SOURCE_REQUIRED')
 actual=list(root.rglob('*'))
 if any(f.is_symlink() for f in actual): raise ValueError('EXISTING_SOURCE_SYMLINK_REFUSED')
 for f in actual:
  if not f.is_file():
   if not f.is_dir() or f.stat().st_uid!=0 or f.stat().st_mode & 0o022: raise ValueError('ROOT_OWNED_EXISTING_SOURCE_REQUIRED')
   continue
  rel=str(f.relative_to(root))
  if rel not in seen and not ('__pycache__' in f.parts and f.suffix=='.pyc'): raise ValueError('UNREVIEWED_EXISTING_SOURCE_REFUSED')
  if f.stat().st_uid!=0 or f.stat().st_mode & 0o022: raise ValueError('ROOT_OWNED_EXISTING_SOURCE_REQUIRED')
 for rel,raw in verified:
  target=root/rel
  if not target.is_file() or target.read_bytes()!=raw: raise ValueError('EXISTING_SOURCE_HASH_MISMATCH')
 print(json.dumps({'status':'EXACT_OPERATOR_SOURCE_INSTALLED','commit':commit,'files':len(verified),'existingSourceVerified':True}))
 sys.exit(0)
root.mkdir(parents=True,mode=0o755)
for rel,raw in verified:
 target=root/rel; target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
 with target.open('xb') as stream: stream.write(raw)
 target.chmod(0o644)
print(json.dumps({'status':'EXACT_OPERATOR_SOURCE_INSTALLED','commit':commit,'files':len(verified)}))
`;

export function sshCommand({knownHosts, keyFile}, remote) {
  assert.ok(isAbsolute(knownHosts) && isAbsolute(keyFile));
  assert.ok(Array.isArray(remote) && remote.length > 0 && remote.every(arg => typeof arg === "string" && !arg.includes("\0")));
  return ["-T", "-i", keyFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "ubuntu@184.196.129.231", remote.map(quote).join(" ")];
}

async function outsideCheckout(path) {
  assert.ok(isAbsolute(path));
  const actual = await realpath(path);
  assert.equal(actual,path,"Canonical private path required");
  for (let parent=(await lstat(path)).isDirectory()?path:dirname(path); ; parent=dirname(parent)) {
    try {await lstat(join(parent,".git")); assert.fail("Private transport files must be outside Git");}
    catch(error) {if(error.code!=="ENOENT")throw error;}
    if(dirname(parent)===parent)break;
  }
}

async function runSsh(args, payload, {timeout, environment, maxOutput, signal}) {
  const child=spawn("/usr/bin/ssh",args,{env:environment,stdio:["pipe","pipe","pipe"],signal});
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0), overflow=false;
  const append=(stream,chunk)=> {
    if(stream.length+chunk.length>maxOutput){overflow=true;child.kill("SIGTERM");return stream;}
    return Buffer.concat([stream,chunk]);
  };
  child.stdout.on("data",chunk=>{stdout=append(stdout,chunk);});
  child.stderr.on("data",chunk=>{stderr=append(stderr,chunk);});
  child.stdin.on("error",()=>{});
  let killTimer;
  const timer=setTimeout(()=>{child.kill("SIGTERM");killTimer=setTimeout(()=>child.kill("SIGKILL"),5000);},timeout);
  let exitCode;
  try {
    exitCode=await new Promise((resolve,reject)=>{child.once("error",()=>reject(new Error("SSH_TRANSPORT_START_FAILED")));child.once("close",resolve);child.stdin.end(payload);});
  } finally {clearTimeout(timer);clearTimeout(killTimer);}
  return {exitCode,stdout,stderr,overflow};
}

export async function recreationSsh({knownHosts,keyFile,diagnostics,environment=process.env,execute=runSsh,signal}) {
  for(const path of [knownHosts,keyFile,diagnostics])await outsideCheckout(path);
  for(const [path,modes] of [[knownHosts,[0o600,0o644]],[keyFile,[0o400]],[diagnostics,[0o700]]]) {
    const file=await lstat(path);
    assert.ok(modes.includes(file.mode & 0o777),"Private SSH file permissions required");
    assert.equal(file.uid,process.getuid(),"Operator-owned SSH files required");
    assert.equal(file.isSymbolicLink(),false); assert.equal(path===diagnostics?file.isDirectory():file.isFile(),true);
  }
  const env=Object.fromEntries(["PATH","HOME","TMPDIR","LANG"].filter(k=>environment[k]!==undefined).map(k=>[k,environment[k]]));
  let sequence=0;
  async function run(remote,payload,timeout=120_000,maxOutput=4_000_000,readAfterAbort=false,maxInput=24_000_000) {
    assert.ok(timeout>=1000 && timeout<=3_600_000);
    const raw=payload===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(payload));
    assert.ok(raw.length<=maxInput,"Bounded SSH input required");
    // Persist a public command identifier before an uncertain remote mutation;
    // neither the caller nor transport automatically repeats it.
    const id=String(++sequence).padStart(3,"0");
    await writeFile(join(diagnostics,id+"-started.json"),JSON.stringify({command:remote[remote.length-1].endsWith("recreation_host.py")?"host-phase":"fixed-program",timeout}),{mode:0o600,flag:"wx"});
    let result;
    try {result=await execute(sshCommand({knownHosts,keyFile},remote),raw,{timeout,maxOutput,environment:env,signal:readAfterAbort?undefined:signal});}
    catch {throw new Error("SSH_OPERATION_UNCERTAIN_REQUIRES_REVIEW");}
    assert.ok(Buffer.isBuffer(result.stdout)&&Buffer.isBuffer(result.stderr));
    if(result.exitCode!==0||result.overflow) {
      await writeFile(join(diagnostics,id+"-private-stdout.bin"),result.stdout,{mode:0o600,flag:"wx"});
      await writeFile(join(diagnostics,id+"-private-stderr.bin"),result.stderr,{mode:0o600,flag:"wx"});
      throw new Error("SSH_OPERATION_REQUIRES_REVIEW");
    }
    let value;
    try {value=JSON.parse(result.stdout.toString("utf8"));}
    catch {await writeFile(join(diagnostics,id+"-private-stdout.bin"),result.stdout,{mode:0o600,flag:"wx"});throw new Error("SSH_RESPONSE_REQUIRES_REVIEW");}
    assert.ok(value&&typeof value==="object"&&!Array.isArray(value));
    return value;
  }
  return {
    machine:()=>run(["sudo","-n","/usr/bin/python3","-c",inspect]),
    bareRuntime:()=>run(["sudo","-n","/usr/bin/python3","-c",bareRuntime]),
    // Only public source installation needs room for the 40 MB decoded bound
    // plus base64/JSON. Private action inputs retain their existing 24 MB cap.
    installSource:payload=>run(["sudo","-n","/usr/bin/python3","-c",sourceInstall],payload,120_000,4_000_000,false,56_000_000),
    phase:(commit,payload)=> {
      assert.match(commit,/^[a-f0-9]{40}$/u);
      assert.ok(["rollback","retire","restore"].includes(payload.operation));
      return run(["sudo","-n","/usr/bin/python3",`/opt/lash-her/operators/${commit}/ops/platform/host/recreation_host.py`],payload,3_600_000);
    },
    privateFiles:(commit,payload)=> {
      assert.match(commit,/^[a-f0-9]{40}$/u);
      assert.ok(["stage","receipts"].includes(payload.operation));
      return run(["sudo","-n","/usr/bin/python3",`/opt/lash-her/operators/${commit}/ops/platform/host/recreation_files.py`],payload,
        120_000,payload.operation==="receipts"?14_000_000:4_000_000,payload.operation==="receipts");
    },
    prepare:(commit,payload)=> {
      assert.match(commit,/^[a-f0-9]{40}$/u);
      assert.ok(["bootstrap","cache-compatible","cache-current"].includes(payload.operation));
      return run(["sudo","-n","/usr/bin/python3",`/opt/lash-her/operators/${commit}/ops/platform/host/recreation_prepare.py`],payload,1_800_000);
    },
    maintenance:(commit,payload)=> {
      assert.match(commit,/^[a-f0-9]{40}$/u);
      assert.ok(["install","activate"].includes(payload.operation));
      return run(["sudo","-n","/usr/bin/python3",`/opt/lash-her/operators/${commit}/ops/platform/host/recreation_maintenance.py`],payload,600_000);
    },
    coldRestore:(commit,payload)=> {
      assert.match(commit,/^[a-f0-9]{40}$/u);
      assert.equal(payload.operation,"cold-restore");
      assert.match(payload.action,/^p1-recreate-access-[a-z0-9-]{1,20}$/u);
      return run(["sudo","-n","/usr/bin/python3",`/opt/lash-her/operators/${commit}/ops/platform/host/cold_restore.py`,
        "--apply","--confirm",`staging/p1-41541683416-1/cold-restore-${payload.action}`],payload,1_800_000);
    },
  };
}
