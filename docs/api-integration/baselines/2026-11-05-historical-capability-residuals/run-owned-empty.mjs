// Actual checked source pipeline, synthetic complete empty original catalog.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { historicalSourceSha256 as hash, verifiedSourceRequirements as getter, prepareHistoricalSourceOriginalConfiguration as prepare,
  observeHistoricalSourceSqlCredentials as observe, deriveHistoricalSourceCapabilityClosures as derive } from '../../../../ops/platform/frontend-historical-source.mjs';
const repository=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/u,''),sourceCommit='b99d4f346696f897fa6a6729dfcc52d6503fe8d6';
const requirements=getter(repository,sourceCommit),keyCatalog=[],environment={};
const provenance={sourceCommit,surfaceSha256:hash('owned-residual-fixture-surface'),configurationRecordSha256:hash('owned-residual-fixture-record'),kind:'deployment',immutableReference:'owned-fixture/empty-residual-control',entrypoint:null,keyCatalogSha256:hash(keyCatalog)};
const binding={sourceCommit,surfaceSha256:provenance.surfaceSha256,configurationRecordSha256:provenance.configurationRecordSha256,sourceConfiguration:{...provenance,provenanceSha256:hash(provenance),databaseRoles:[]}};
const original={sourceCommit,configurationRecordSha256:provenance.configurationRecordSha256,provenance,keyCatalog,environment};
prepare(requirements,binding,original);
const sql=await observe(requirements,{binding,originalConfiguration:original,clientsByKey:new Map(),physicalDatabasesByKey:new Map(),verifySession:async()=>{}});
const result=derive(requirements,binding,original,sql);
assert.equal(result.capabilityClosures.length,36);assert.deepEqual(result.unresolvedFrontendSqlFamilyIds,[]);
assert.deepEqual(result.unresolvedExternalCapabilityFamilyIds,['mux.studio','sanity.editorial']);assert.deepEqual(result.unresolvedFamilyIds,result.unresolvedExternalCapabilityFamilyIds);
process.stdout.write(JSON.stringify({status:'OWNED_SCOPED_FRONTEND_SQL_PASS',fixtureOnly:true,actualHistoricalDeploymentObserved:false,liveProviderCalls:0,
  sourceModuleSha256:hash(readFileSync(new URL('../../../../ops/platform/frontend-historical-source.mjs',import.meta.url))),sourceCommit,
  sourceInventorySha256:requirements.sourceInventorySha256,requirementsSha256:requirements.requirementsSha256,result},null,2)+'\n');
