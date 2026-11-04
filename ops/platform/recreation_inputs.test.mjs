import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {build} from "esbuild";
import {compileRecreationPrograms,decodePrivateReceipts,manifestSha256,replacePrivateInput,sha256} from "./recreation_inputs.mjs";

const source=resolve(fileURLToPath(new URL("../..",import.meta.url)));
test("compiled operator programs bind owned modules and reject production before runtime imports or HTTP",async()=> {
  const compiled=await compileRecreationPrograms(source,build);
  assert.deepEqual(Object.keys(compiled.programs).sort(),["fixture","work"]);
  assert.deepEqual(Object.keys(compiled.sourceSha256.work).sort(),["ops/platform/host/business_fingerprint.mjs","ops/platform/host/staging_work.mjs","ops/platform/host/staging_work_image.mjs"]);
  for(const [name,input] of [["fixture",{version:1,environment:"production",applicationToken:"synthetic-private-token"}],
    ["work",{version:1,service:"production",mode:"preflight",privateFingerprintKey:"f".repeat(64)}]]) {
    const file=compiled.files.find(f=>f.path===`programs/staging-${name}-operator.mjs`);
    const raw=Buffer.from(file.data,"base64");assert.equal(sha256(raw),compiled.programs[name].sha256);
    const child=spawnSync(process.execPath,["--input-type=module","--eval",raw.toString("utf8")],
      {input:JSON.stringify(input),encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH}});
    assert.notEqual(child.status,0);assert.equal(child.stdout,"");
    assert.ok(!child.stderr.includes("synthetic-private-token"));
    assert.ok(!child.stderr.includes("f".repeat(64)));
  }
});
test("foreign compiler inputs cannot be treated as reviewed program sources",async()=> {
  await assert.rejects(compileRecreationPrograms(source,async()=>({outputFiles:[{contents:Buffer.from("owned output")}],
    metafile:{inputs:{"../foreign.mjs":{}}}})),/Only owned operator modules/u);
});
test("private receipt decoding verifies raw hashes and rejects duplicates, traversal and invalid base64",()=> {
  const raw=Buffer.from('{"status":"owned-private-status"}\n');
  const file={path:"retirement-outcome.json",sha256:sha256(raw),data:raw.toString("base64")};
  const value={status:"RECREATION_EXACT_PRIVATE_RECEIPTS",phase:"retirement",files:[file]};
  assert.deepEqual(decodePrivateReceipts(value,"retirement").get(file.path),raw);
  for(const bad of [{...file,path:"../ca.json"},{...file,sha256:"0".repeat(64)},{...file,data:file.data+"!"}])
    assert.throws(()=>decodePrivateReceipts({...value,files:[bad]},"retirement"));
  assert.throws(()=>decodePrivateReceipts({...value,files:[file,file]},"retirement"));
  assert.throws(()=>decodePrivateReceipts(value,"restore"));
});
test("new-machine private handoff replaces the action copy without mutating original receipts",()=> {
  const raw=Buffer.from('{"status":"original"}');
  const original=[{path:"runtime-receipts/runtime-outcome.json",sha256:sha256(raw),data:raw.toString("base64")}];
  const changed=replacePrivateInput(original,original[0].path,Buffer.from('{"status":"new-current-runtime"}'));
  assert.notEqual(changed[0].sha256,original[0].sha256);
  assert.equal(Buffer.from(original[0].data,"base64").toString(),raw.toString());
  assert.notEqual(manifestSha256(changed),manifestSha256(original));
  assert.equal(manifestSha256([...changed].reverse()),manifestSha256(changed));
});
