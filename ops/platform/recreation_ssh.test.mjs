import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,mkdir,rm,readFile,readdir,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {realpathSync} from "node:fs";
import {join} from "node:path";
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
