import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,realpathSync,writeFileSync,chmodSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frontendMigrationArtifact,prepareFrontendMigration } from './frontend-migration.mjs';
import { frontendAdmissionTargetSha256 } from './frontend-admission-bootstrap.mjs';
import { frontendCandidateSurfaces,frontendCoordinationHash as hash,prepareFrontendReleaseInventory } from './frontend-release-inventory.mjs';
import { P2_CERTIFICATION_PROFILE } from './p2-certification-profile.mjs';
import { prepareP2PostSqlRecovery,bindOriginalRecoveryReceipts } from './p2-post-sql-recovery.mjs';

function fixture(){
  const sourceInventory={version:2,scope:'candidate-source-only',sourceManifestSha256:'1'.repeat(64),routes:[{file:'src/app/api/owned/route.ts',methods:['POST'],sourceSha256:'2'.repeat(64)}],actionModules:[],renderEntries:[],manualEntries:[],inlineActions:[],deferredSites:[],databaseConstructors:[],schedules:[]};
  const artifact=frontendMigrationArtifact(),phase2={contractPhase:artifact.contractPhase,phase2ContractManifestSha256:artifact.phase2ContractManifestSha256};
  const baseline={version:1,serverMajor:16,sqlArtifactSha256:artifact.sqlArtifactSha256,catalog:Object.fromEntries(['relations','columns','constraints','indexes','triggers','functions','enums','sequences','policies'].map(key=>[key,[]]))};
  const job={version:1,operator:'Dardan',environment:'staging',releaseId:'original-release',sourceCommit:'a'.repeat(40),...phase2,migrationImageDigest:'sha256:'+'b'.repeat(64),contractManifestSha256:artifact.contractManifestSha256,sqlArtifactSha256:artifact.sqlArtifactSha256,schemaBaselineSha256:hash(baseline),recoveryRef:'owned/recovery',target:{host:'owned.invalid',port:5432,database:'owned',user:'operator',runtimeRole:'runtime',serverMajor:16,allowEmptyBootstrap:false,approvedPendingTags:artifact.migrations.map(row=>row.tag)}};
  const candidate={version:2,...phase2,environment:'staging',releaseId:job.releaseId,integration:{state:'passed'},sourceApproval:{mode:'single-operator-dispatch',operatorGithubUserId:'8996309'},sources:{frontend:{repository:'https://github.com/princessdardan/lash-her-frontend.git',commit:job.sourceCommit,requiredChecks:'passed'}},artifacts:{frontendMigration:{image:'ghcr.io/princessdardan/lash-her-platform-frontend-migration@'+job.migrationImageDigest}},contractManifestSha256:artifact.contractManifestSha256,frontendMigration:{...phase2,sourceCommit:job.sourceCommit,sqlArtifactSha256:artifact.sqlArtifactSha256,contractManifestSha256:artifact.contractManifestSha256,schemaBaselines:{16:job.schemaBaselineSha256}}};
  const targetSha256=frontendAdmissionTargetSha256('staging',job.target),producerSha256='5'.repeat(64);
  const inventory={version:1,environment:'staging',actionId:job.releaseId,sourceCommit:job.sourceCommit,targetSha256,sourceInventorySha256:hash(sourceInventory),reviewSha256:'3'.repeat(64),adaptersSha256:'4'.repeat(64),observationBudgetSeconds:300,admissionMode:'existing',expectedEpoch:'1',owner:{name:'admission_owner',oid:'100'},producers:[{producerSha256,role:{name:'runtime',oid:'101'}}],candidateCoverage:frontendCandidateSurfaces(sourceInventory).map(row=>({surfaceSha256:row.surfaceSha256,disposition:'admitted',producerSha256,evidenceSha256:'6'.repeat(64)})),externalSurfaces:['deployment','provider','scheduler','direct-caller'].map((kind,i)=>{const identitySha256=String(i+1).repeat(64);return{kind,identitySha256,surfaceSha256:hash({kind,identitySha256})};}),historicalLogins:{version:1,environment:'staging',actionId:job.releaseId,sourceCommit:job.sourceCommit,clusterScopeSha256:'7'.repeat(64),target:{...job.target,currentRuntimeRole:'runtime',admissionOwnerRole:'admission_owner'},retiredLogins:[{name:'old_runtime',oid:'102'}]},certification:structuredClone(P2_CERTIFICATION_PROFILE),restoration:{version:1,recovery:true,newWork:true,nativeSchedulesEnabled:false,providerIngress:'keep-retired',gatewayBindingSha256:'8'.repeat(64)}};
  const migration=prepareFrontendMigration(candidate,job,baseline,artifact),plan=prepareFrontendReleaseInventory(inventory,migration,sourceInventory),prepared={migration,plan,sourceInventory};
  const candidateBytes=Buffer.from(JSON.stringify(candidate)+'\n'),original=Buffer.from(JSON.stringify({actionId:plan.actionId,sourceCommit:plan.sourceCommit,environment:'staging',targetSha256:plan.targetSha256,inventorySha256:hash(plan),adaptersSha256:plan.adaptersSha256})+'\n');
  const action={version:1,environment:'staging',recoveryActionId:'fresh-recovery',originalReleaseId:plan.actionId,sourceCommit:plan.sourceCommit,candidateSha256:hash(candidateBytes),inventorySha256:hash(plan),configurationSha256:'9'.repeat(64),frontendMode:'reuse-retained-ready',originalReceiptSha256:{'frontend-release-started.json':hash(original),'job-outcome.json':null,'database-receipt.json':null,...Object.fromEntries(['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json','frontend-promotion-started.json','frontend-workload-outcome.json'].map(name=>['vercel/'+name,hash(Buffer.from('{}'))]))}};
  return{prepared,action,candidateBytes,original};
}

test('post-SQL recovery preserves original candidate and pending chain without fabricating absent terminal',()=>{
  const f=fixture(),before=JSON.stringify(f.prepared.migration.job),checked=prepareP2PostSqlRecovery(f.prepared,f.action,f.candidateBytes);
  assert.equal(JSON.stringify(f.prepared.migration.job),before);assert.notEqual(checked.action.recoveryActionId,checked.action.originalReleaseId);
  assert.equal(checked.action.originalReceiptSha256['job-outcome.json'],null);assert.equal(checked.action.failedBuildForwardAction,'OPEN');
  assert.equal(checked.action.sqlReplayAuthorized,false);assert.ok(checked.prepared.migration.job.target.approvedPendingTags.length>0);
});

test('candidate bytes, source, original action, inventory, config and deployment retry mode are bounded',()=>{
  const f=fixture();
  for(const changes of [{recoveryActionId:'original-release'},{originalReleaseId:'other'},{sourceCommit:'b'.repeat(40)},{candidateSha256:'b'.repeat(64)},{inventorySha256:'b'.repeat(64)},{configurationSha256:'not-a-digest'},{frontendMode:'retry-build'}])assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,{...f.action,...changes},f.candidateBytes));
  assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,f.action,Buffer.from(JSON.stringify(JSON.parse(f.candidateBytes)))));
});

test('actual retained receipt hashes and actual missing terminal cannot be stale or overwritten',()=>{
  const f=fixture(),directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-recovery-original-')));chmodSync(directory,0o700);
  try{mkdirSync(join(directory,'vercel'),{mode:0o700});for(const name of Object.keys(f.action.originalReceiptSha256).filter(name=>name.startsWith('vercel/')))writeFileSync(join(directory,name),'{}',{mode:0o600});writeFileSync(join(directory,'frontend-release-started.json'),f.original,{mode:0o600});bindOriginalRecoveryReceipts(directory,f.action,f.prepared);
    writeFileSync(join(directory,'job-outcome.json'),'{}',{mode:0o600});assert.throws(()=>bindOriginalRecoveryReceipts(directory,f.action,f.prepared));
    rmSync(join(directory,'job-outcome.json'));writeFileSync(join(directory,'frontend-release-started.json'),Buffer.from('{}'),{mode:0o600});assert.throws(()=>bindOriginalRecoveryReceipts(directory,f.action,f.prepared));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
