import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,mkdir,rm,readFile,readdir,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {realpathSync} from "node:fs";
import {join} from "node:path";
import {createHash,randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {gunzipSync,gzipSync} from "node:zlib";
import {recreationSsh,sshCommand} from "./recreation_ssh.mjs";
import {PROFILED_CURRENT_OPERATOR_SOURCE_BOUNDS} from "./recreation_source.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceFile = (path, bytes) => ({path,sha256:digest(bytes),data:bytes.toString("base64")});

function runOwnedInstaller(root,args,stdin) {
  // Execute the actual embedded installer with only root identity and the
  // installation directory projected into this owned temporary fixture.
  const harness=`import os,pathlib,shlex,sys
parts=shlex.split(sys.argv[1])
assert parts[:4]==['sudo','-n','/usr/bin/python3','-c'] and len(parts)==5
code=parts[4]
substitutions={"pathlib.Path('/opt/lash-her/operators')":"pathlib.Path("+repr(sys.argv[2])+")", "os.geteuid()!=0":"os.geteuid()!="+str(os.getuid()), "st_uid!=0":"st_uid!="+str(os.getuid()), "for p in root.parents)":"for p in (root.parent,))"}
for old,new in substitutions.items():
 assert old in code
 code=code.replace(old,new)
exec(compile(code,'<owned-fixed-source-installer>','exec'))
`;
  const result=spawnSync("python3",["-c",harness,args.at(-1),join(root,"operators")],{input:stdin,maxBuffer:2_000_000});
  if(result.error)throw result.error;
  return {exitCode:result.status,stdout:result.stdout,stderr:result.stderr};
}

async function fixture(t,execute) {
  const root=await mkdtemp(join(realpathSync(tmpdir()),"lash-ssh-owned-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const keyFile=join(root,"operator.pem"),knownHosts=join(root,"known_hosts"),diagnostics=join(root,"diagnostics");
  await writeFile(keyFile,"synthetic-private-key-not-read",{mode:0o400});
  await writeFile(knownHosts,"owned-host-public-key",{mode:0o600}); await mkdir(diagnostics,{mode:0o700});
  return {root,keyFile,knownHosts,diagnostics,ssh:await recreationSsh({keyFile,knownHosts,diagnostics,
    environment:{PATH:"owned-path",HOME:root,VERCEL_TOKEN:"must-not-inherit",SSH_AUTH_SOCK:"must-not-inherit"},execute})};
}
test("SSH retains strict separate known-hosts and quotes every remote argument",()=> {
  const args=sshCommand({keyFile:"/private/operator.pem",knownHosts:"/private/known_hosts"},["python3","-c","print('literal$`value')"]);
  assert.ok(args.includes("StrictHostKeyChecking=yes")); assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("GlobalKnownHostsFile=/dev/null"));
  assert.equal(args.at(-1),"'python3' '-c' 'print('\"'\"'literal$`value'\"'\"')'");
  assert.equal(args.at(-2),"ubuntu@184.196.129.231");
});
test("private phase payload reaches only SSH stdin, without ambient tokens or agent",async t=> {
  const calls=[];
  const f=await fixture(t,async(args,stdin,options)=> {
    calls.push({args,stdin,options});return {exitCode:0,stdout:Buffer.from('{"status":"owned"}'),stderr:Buffer.alloc(0)};
  });
  const privateToken="owned-private-stdin-token";
  const result=await f.ssh.phase("a".repeat(40),{operation:"rollback",vercelToken:privateToken});
  assert.equal(result.status,"owned"); assert.equal(calls.length,1);
  assert.equal(JSON.parse(calls[0].stdin).vercelToken,privateToken);
  assert.ok(!JSON.stringify(calls[0].args).includes(privateToken));
  assert.deepEqual(Object.keys(calls[0].options.environment).sort(),["HOME","PATH"]);
  const common=await readFile(join(f.diagnostics,"001-started.json"),"utf8");
  assert.ok(!common.includes(privateToken));
});
test("uncertain child response retains private diagnostics once and never retries",async t=> {
  let calls=0;
  const f=await fixture(t,async()=>{calls++;return {exitCode:1,stdout:Buffer.from("private-child-data"),stderr:Buffer.from("private-provider-error")};});
  await assert.rejects(f.ssh.machine(),{message:"SSH_OPERATION_REQUIRES_REVIEW"});
  assert.equal(calls,1);
  const names=await readdir(f.diagnostics);
  assert.equal(names.length,3);
  assert.equal(await readFile(join(f.diagnostics,"001-private-stderr.bin"),"utf8"),"private-provider-error");
});
test("a missing or permissive trust file refuses before SSH starts",async t=> {
  let calls=0;const f=await fixture(t,async()=>{calls++;throw Error("unexpected");});
  await rm(f.knownHosts);
  await assert.rejects(recreationSsh({...f,execute:async()=>{calls++;}}));
  await writeFile(f.knownHosts,"public",{mode:0o644});
  await chmod(f.knownHosts,0o666);
  await assert.rejects(recreationSsh({...f,execute:async()=>{calls++;}}),/permissions required/u);
  assert.equal(calls,0);
});
test("large public source handoff does not expand private phase input limits",async t=> {
  const calls=[];
  const f=await fixture(t,async(args,stdin)=> {
    calls.push({args,bytes:stdin.length});
    return {exitCode:0,stdout:Buffer.from('{"status":"owned"}'),stderr:Buffer.alloc(0)};
  });
  const file={path:"ops/owned.mjs",sha256:"b".repeat(64),data:Buffer.alloc(1_500_000,120).toString("base64")};
  const payload={commit:"a".repeat(40),files:Array.from({length:12},(_,index)=>({...file,path:`ops/owned-${index}.mjs`}))};
  await f.ssh.installSource(payload);
  assert.equal(calls.length,1);assert.ok(calls[0].bytes>24_000_000);
  await assert.rejects(f.ssh.phase("a".repeat(40),{operation:"rollback",...payload}),/Bounded SSH input required/u);
  assert.equal(calls.length,1);
});
test("fixed installer enforces source count, decoded aggregate and per-file limits",async t=> {
  const outcomes=[];
  const f=await fixture(t,async(args,stdin)=> {
    const result=runOwnedInstaller(f.root,args,stdin);
    outcomes.push(result.stderr.toString());
    return result;
  });
  await mkdir(join(f.root,"operators"),{mode:0o700});
  let selection=0;
  const file=(index,bytes)=>sourceFile(`ops/owned-${index}.mjs`,bytes);
  const payload=files=>({commit:(++selection).toString(16).padStart(40,"0"),files});
  const small=Array.from({length:512},(_,index)=>file(index,Buffer.from("owned")));
  assert.equal((await f.ssh.installSource(payload(small))).files,512);
  await assert.rejects(f.ssh.installSource(payload([...small,file(512,Buffer.from("owned"))])));
  assert.match(outcomes.at(-1),/SOURCE_FILES_REQUIRED/u);
  const profiled=Array.from({length:544},(_,index)=>file(index,Buffer.from("owned")));
  assert.equal((await f.ssh.installProfiledCurrentSource(payload(profiled))).files,544);
  await assert.rejects(f.ssh.installProfiledCurrentSource(payload([...profiled,file(544,Buffer.from("owned"))])));
  assert.match(outcomes.at(-1),/SOURCE_FILES_REQUIRED/u);
  await assert.rejects(f.ssh.installProfiledCurrentSource(payload([file(0,Buffer.alloc(2_000_001,120))])));
  assert.match(outcomes.at(-1),/SOURCE_HASH_REFUSED/u);
  await assert.rejects(f.ssh.installSource(payload([file(0,Buffer.alloc(2_000_001,120))])));
  assert.match(outcomes.at(-1),/SOURCE_HASH_REFUSED/u);
  const large=Array.from({length:20},(_,index)=>file(index,Buffer.alloc(2_000_000,120)));
  large.push(file(20,Buffer.alloc(1_000_000,120)));
  assert.equal((await f.ssh.installSource(payload(large))).files,21);
  large[20]=file(20,Buffer.alloc(1_000_001,120));
  await assert.rejects(f.ssh.installSource(payload(large)));
  assert.match(outcomes.at(-1),/SOURCE_HASH_REFUSED/u);
  const max=PROFILED_CURRENT_OPERATOR_SOURCE_BOUNDS.decodedBytes;
  const atLimit=Array.from({length:Math.ceil(max/2_000_000)},(_,index)=>file(index,Buffer.alloc(Math.min(2_000_000,max-2_000_000*index),120)));
  assert.equal((await f.ssh.installProfiledCurrentSource(payload(atLimit))).files,atLimit.length);
  await assert.rejects(f.ssh.installProfiledCurrentSource(payload([...atLimit,file(atLimit.length,Buffer.from('x'))])));
  assert.match(outcomes.at(-1),/SOURCE_HASH_REFUSED/u);
});

test("profiled source round trips exact historical and binary bytes through the real fixed installer",async t=> {
  const records=[];
  const f=await fixture(t,async(args,stdin)=> {
    const result=runOwnedInstaller(f.root,args,stdin);
    records.push({args,stdin,result});
    return result;
  });
  await mkdir(join(f.root,"operators"),{mode:0o700});
  const historical="ops/platform/profiles/frontend-historical-sources/b99d4f346696f897fa6a6729dfcc52d6503fe8d6.json";
  const historicalBytes=await readFile(new URL(`../../${historical}`,import.meta.url));
  const binary=Buffer.from([0,255,0xc0,0xaf,13,10,0,99]);
  const files=[sourceFile(historical,historicalBytes),sourceFile("ops/owned-binary.json",binary)];
  const payload={commit:"1".repeat(40),files};
  const installed=await f.ssh.installProfiledCurrentSource(payload);
  assert.deepEqual(installed,{status:"EXACT_OPERATOR_SOURCE_INSTALLED",commit:payload.commit,files:2});
  const wrapper=JSON.parse(records[0].stdin);
  assert.deepEqual(Object.keys(wrapper),["encoding","data"]);
  assert.equal(wrapper.encoding,"gzip-base64-v1");
  assert.deepEqual(gunzipSync(Buffer.from(wrapper.data,"base64")),Buffer.from(JSON.stringify(payload)));
  for(const file of files)assert.deepEqual(await readFile(join(f.root,"operators",payload.commit,file.path)),Buffer.from(file.data,"base64"));
  assert.equal((await f.ssh.installProfiledCurrentSource(payload)).existingSourceVerified,true);
  const retained=join(f.root,"operators",payload.commit,files[1].path);
  await writeFile(retained,Buffer.from("drift"));
  await assert.rejects(f.ssh.installProfiledCurrentSource(payload));
  assert.match(records.at(-1).result.stderr.toString(),/EXISTING_SOURCE_HASH_MISMATCH/u);
  assert.deepEqual(await readFile(retained),Buffer.from("drift"));

  const legacy={...payload,commit:"2".repeat(40)};
  await f.ssh.installSource(legacy);
  assert.deepEqual(records.at(-1).stdin,Buffer.from(JSON.stringify(legacy)));
  assert.equal(digest(records.at(-1).args.at(-1)),"0cccc83ad16bd3575dda1d09bacd031cde4ddd07977f0a56f4f2dad3bb4f241a");
});

test("profiled receiver refuses malformed, concatenated, trailing and overexpanded source before any write",async t=> {
  let tamper;
  const errors=[];
  const f=await fixture(t,async(args,stdin)=> {
    const result=runOwnedInstaller(f.root,args,tamper(stdin));
    errors.push(result.stderr.toString());
    return result;
  });
  await mkdir(join(f.root,"operators"),{mode:0o700});
  const payload={commit:"3".repeat(40),files:[sourceFile("ops/owned.json",Buffer.from("owned"))]};
  const wrap=(data,encoding="gzip-base64-v1")=>Buffer.from(JSON.stringify({encoding,data:data.toString("base64")}));
  const mutate=fn=>stdin=>wrap(fn(Buffer.from(JSON.parse(stdin).data,"base64")));
  const cases=[
    [()=>Buffer.from(JSON.stringify(payload)),"WRAPPER_REFUSED"],
    [()=>wrap(gzipSync(JSON.stringify(payload)),"gzip-base64-v2"),"WRAPPER_REFUSED"],
    [stdin=>Buffer.from(JSON.stringify({...JSON.parse(stdin),expandedLimit:65_000_001})),"WRAPPER_REFUSED"],
    [()=>Buffer.from('{"encoding":"gzip-base64-v1","data":"AA==","data":"AA=="}'),"WRAPPER_REFUSED"],
    [()=>Buffer.from('{"encoding":"gzip-base64-v1","data":"AB=="}'),"WRAPPER_REFUSED"],
    [()=>Buffer.from(JSON.stringify({encoding:"gzip-base64-v1",data:"AA==\n"})),"WRAPPER_REFUSED"],
    [mutate(data=>data.subarray(0,data.length-1)),"GZIP_REFUSED"],
    [mutate(data=>{data[data.length-8]^=255;return data;}),"GZIP_REFUSED"],
    [mutate(data=>Buffer.concat([data,Buffer.from("junk")])),"GZIP_REFUSED"],
    [mutate(data=>Buffer.concat([data,gzipSync(Buffer.alloc(0))])),"GZIP_REFUSED"],
    [()=>wrap(gzipSync(Buffer.alloc(65_000_001,120))),"EXPANDED_BOUND_REFUSED"],
    [()=>wrap(gzipSync(Buffer.from([0xff,0xfe]))),"PAYLOAD_REFUSED"],
    [()=>wrap(gzipSync(`{"commit":"${payload.commit}","files":[],"files":${JSON.stringify(payload.files)}}`)),"PAYLOAD_REFUSED"],
    [()=>Buffer.alloc(56_000_001,120),"WIRE_BOUND_REFUSED"],
    [()=>wrap(gzipSync(JSON.stringify({...payload,files:[{...payload.files[0],sha256:"0".repeat(64)}]}))),"SOURCE_HASH_REFUSED"],
  ];
  for(const [replacement,code] of cases){
    tamper=replacement;
    await assert.rejects(f.ssh.installProfiledCurrentSource(payload));
    assert.match(errors.at(-1),new RegExp(code,"u"));
    assert.deepEqual(await readdir(join(f.root,"operators")),[]);
  }
  tamper=()=>{
    const raw=Buffer.from(JSON.stringify(payload));
    return wrap(gzipSync(Buffer.concat([raw,Buffer.alloc(65_000_000-raw.length,32)])));
  };
  assert.equal((await f.ssh.installProfiledCurrentSource(payload)).files,1);
});

test("public 56 MB and private 24 MB transport limits refuse overflow before execution",async t=> {
  let calls=0;
  const f=await fixture(t,async()=>{calls++;return {exitCode:0,stdout:Buffer.from('{"status":"owned"}'),stderr:Buffer.alloc(0)};});
  const sized=(fields,size)=>{
    const value={...fields,data:""};value.data="x".repeat(size-Buffer.byteLength(JSON.stringify(value)));
    assert.equal(Buffer.byteLength(JSON.stringify(value)),size);return value;
  };
  await f.ssh.installSource(sized({},56_000_000));
  assert.equal(calls,1);
  await assert.rejects(f.ssh.installSource(sized({},56_000_001)),/Bounded SSH input required/u);
  await f.ssh.phase("a".repeat(40),sized({operation:"rollback"},24_000_000));
  assert.equal(calls,2);
  await assert.rejects(f.ssh.phase("a".repeat(40),sized({operation:"rollback"},24_000_001)),/Bounded SSH input required/u);
  assert.equal(calls,2);
});

test("profiled source retains independent expanded and compressed send bounds before SSH execution",async t=> {
  const calls=[];
  const f=await fixture(t,async(_args,stdin)=>{calls.push(stdin.length);return {exitCode:0,stdout:Buffer.from('{}'),stderr:Buffer.alloc(0)};});
  const pad=length=>({data:"x".repeat(length-11)});
  await f.ssh.installProfiledCurrentSource(pad(65_000_000));
  await assert.rejects(f.ssh.installProfiledCurrentSource(pad(65_000_001)),/Bounded profiled source expansion required/u);
  // The high-entropy fixture remains below the expanded limit but its gzip
  // plus base64 encoding cannot fit in the unchanged public wire envelope.
  const data=randomBytes(42_500_000).toString("base64");
  await assert.rejects(f.ssh.installProfiledCurrentSource({data}),/Bounded SSH input required/u);
  assert.equal(calls.length,1);
  assert.ok(calls[0]<56_000_000);
});
