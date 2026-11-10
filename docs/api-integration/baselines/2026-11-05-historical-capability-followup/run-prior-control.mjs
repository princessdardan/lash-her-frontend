// Reproduce the former gap from exact committed source, using an empty owned record.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/u,'');
const priorCommit='502b7d2fe15edf2cf62ace1bf27a358c218554ce',sourceCommit='b99d4f346696f897fa6a6729dfcc52d6503fe8d6';
const directory=mkdtempSync(join(tmpdir(),'historical-six-prior-control-'));
try {
  const git=path=>execFileSync('git',['--no-replace-objects','--no-optional-locks','show',`${priorCommit}:${path}`],{cwd:repository,maxBuffer:96000000});
  const module=join(directory,'frontend-historical-source.mjs'),profiles=join(directory,'profiles/frontend-historical-sources');mkdirSync(profiles,{recursive:true});
  writeFileSync(module,git('ops/platform/frontend-historical-source.mjs'));
  for(const file of readdirSync(new URL('../../../../ops/platform/profiles/frontend-historical-sources/',import.meta.url)))
    writeFileSync(join(profiles,file),git(`ops/platform/profiles/frontend-historical-sources/${file}`));
  const source=await import(pathToFileURL(module));
  const hash=source.historicalSourceSha256;
  assert.equal(hash(readFileSync(module)),'eb5e8c974d29ee60d42417d8fa84bfce68c958fce11af95b15adb7ce2dcdaa2e');
  const requirements=source.verifiedSourceRequirements(repository,sourceCommit),environment={},keyCatalog=[];
  const provenance={sourceCommit,surfaceSha256:hash('owned-prior-control-surface'),configurationRecordSha256:hash('owned-prior-control-record'),kind:'deployment',immutableReference:'owned-fixture/prior-control',entrypoint:null,keyCatalogSha256:hash(keyCatalog)};
  const binding={sourceCommit,surfaceSha256:provenance.surfaceSha256,configurationRecordSha256:provenance.configurationRecordSha256,sourceConfiguration:{...provenance,provenanceSha256:hash(provenance),databaseRoles:[]}};
  const original={sourceCommit,configurationRecordSha256:provenance.configurationRecordSha256,provenance,keyCatalog,environment};
  source.prepareHistoricalSourceOriginalConfiguration(requirements,binding,original);
  const sql=await source.observeHistoricalSourceSqlCredentials(requirements,{binding,originalConfiguration:original,clientsByKey:new Map(),physicalDatabasesByKey:new Map(),verifySession:async()=>{}});
  const result=source.deriveHistoricalSourceCapabilityClosures(requirements,binding,original,sql);
  assert.equal(result.capabilityClosures.length,30);
  assert.deepEqual(result.unresolvedFamilyIds,['google.identity','google.oauth','google.calendar','sanity.editorial','sanity.callbacks','mux.studio']);
  process.stdout.write(JSON.stringify({status:'MISSING_REVIEWED_PREDICATES_REPRODUCED',fixtureOnly:true,actualHistoricalDeploymentObserved:false,priorCommit,priorModuleSha256:hash(readFileSync(module)),sourceCommit,sourceInventorySha256:requirements.sourceInventorySha256,requirementsSha256:requirements.requirementsSha256,closedFamilies:result.capabilityClosures.length,unresolvedFamilyIds:result.unresolvedFamilyIds,liveProviderCalls:0},null,2)+'\n');
} finally {rmSync(directory,{recursive:true,force:true});}
