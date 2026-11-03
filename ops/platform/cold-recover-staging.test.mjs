import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {recoverySettings} from "./cold-recover-staging.mjs";

test("settings carry only reviewed public identities; invalid CLI arguments refuse before environment access",()=> {
  const value={version:1,action:"p1-recreate-access-owned",sourceCommit:"a".repeat(40),operatorIpv4Cidr:"99.239.187.88/32"};
  assert.equal(recoverySettings(value),value);
  for(const invalid of [{...value,token:"do-not-accept"},{...value,action:"production"},{...value,sourceCommit:"main"}])assert.throws(()=>recoverySettings(invalid));
  const r=spawnSync(process.execPath,[fileURLToPath(new URL("./cold-recover-staging.mjs",import.meta.url)),"--force"],
    {encoding:"utf8",env:{PATH:process.env.PATH},timeout:15000});
  assert.equal(r.status,1);assert.match(r.stderr,/STAGING_ACCESS_RECOVERY_REFUSED_OR_REQUIRES_REVIEW/u);
  assert.equal(r.stdout,"");
});

test("continuation settings bind only the recorded stopped-snapshot failure and a fresh action",()=> {
  const v={version:2,action:"p1-recreate-access-20261103-c1",continuationOf:"p1-recreate-access-20261103",sourceCommit:"a".repeat(40),operatorIpv4Cidr:"99.239.187.88/32"};
  assert.equal(recoverySettings(v),v);
  for(const bad of [{...v,continuationOf:"another-action"},{...v,action:v.continuationOf},{...v,snapshotName:"arbitrary"}])assert.throws(()=>recoverySettings(bad));
});
