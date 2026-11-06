import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,mkdir,rm,readFile,readdir,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {realpathSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {recreationSsh,sshCommand} from "./recreation_ssh.mjs";

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
    // Execute the actual embedded installer with only its root identity and
    // installation directory projected into this owned temporary fixture.
    // Decode, path/type, count, aggregate and hash checks remain unchanged.
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
    const result=spawnSync("python3",["-c",harness,args.at(-1),join(f.root,"operators")],{input:stdin,maxBuffer:2_000_000});
    if(result.error)throw result.error;
    outcomes.push(result.stderr.toString());
    return {exitCode:result.status,stdout:result.stdout,stderr:result.stderr};
  });
  await mkdir(join(f.root,"operators"),{mode:0o700});
  let selection=0;
  const file=(index,bytes)=>({path:`ops/owned-${index}.mjs`,sha256:createHash("sha256").update(bytes).digest("hex"),data:bytes.toString("base64")});
  const payload=files=>({commit:(++selection).toString(16).padStart(40,"0"),files});
  const small=Array.from({length:496},(_,index)=>file(index,Buffer.from("owned")));
  assert.equal((await f.ssh.installSource(payload(small))).files,496);
  await assert.rejects(f.ssh.installSource(payload([...small,file(496,Buffer.from("owned"))])));
  assert.match(outcomes.at(-1),/SOURCE_FILES_REQUIRED/u);
  await assert.rejects(f.ssh.installSource(payload([file(0,Buffer.alloc(2_000_001,120))])));
  assert.match(outcomes.at(-1),/SOURCE_HASH_REFUSED/u);
  const large=Array.from({length:20},(_,index)=>file(index,Buffer.alloc(2_000_000,120)));
  large.push(file(20,Buffer.alloc(1_000_000,120)));
  assert.equal((await f.ssh.installSource(payload(large))).files,21);
  large[20]=file(20,Buffer.alloc(1_000_001,120));
  await assert.rejects(f.ssh.installSource(payload(large)));
  assert.match(outcomes.at(-1),/SOURCE_HASH_REFUSED/u);
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
