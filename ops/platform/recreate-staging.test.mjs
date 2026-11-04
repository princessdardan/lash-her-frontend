import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {runRecreation,validateRecreationSettings} from "./recreate-staging.mjs";

const settings={version:1,action:"p1-recreate-owned",sourceCommit:"a".repeat(40),trustMode:"pending"};
test("pending trust or an absent action confirmation refuses before private input or provider access",async()=> {
  await assert.rejects(runRecreation(settings,{apply:true,confirmation:"staging/"+settings.action}),/trust choice must be resolved/u);
  await assert.rejects(runRecreation({...settings,trustMode:"operator-first-use"},{apply:true}),/Explicit complete staging/u);
});
test("settings accept no production target, credentials or arbitrary trust mode",()=> {
  assert.deepEqual(validateRecreationSettings(settings),settings);
  for(const value of [{...settings,environment:"production"},{...settings,token:"synthetic-private-token"},
    {...settings,action:"production-recreate"},{...settings,trustMode:"automatic-first-use"}])
    assert.throws(()=>validateRecreationSettings(value));
});
test("actual CLI invalid invocation prints only the fixed refusal and does not reveal ambient bindings",()=> {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL("./recreate-staging.mjs",import.meta.url)),"--force"],
    {encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH,VERCEL_TOKEN:"synthetic-private-token"}});
  assert.equal(result.status,1);assert.equal(result.stdout,"");
  assert.equal(result.stderr,"STAGING_RECREATION_REFUSED_OR_REQUIRES_REVIEW\n");
});
