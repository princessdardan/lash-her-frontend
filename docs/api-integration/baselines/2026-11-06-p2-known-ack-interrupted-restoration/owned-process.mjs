// New process after the actual B whole-route child exited. All credentials are
// generated inside the disposable cluster and remain stdin/private files only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {Client} from 'pg';
import {frontendMigrationArtifact} from '../../../../ops/platform/frontend-migration.mjs';
import {readMigrationCatalog} from '../../../../ops/platform/frontend-schema.mjs';
import {observeRecoveryPhysical,withRecoveryFrontendSession} from '../../../../ops/platform/p2-recovery-current-probe.mjs';
import {observeRecoveryApiCurrent} from '../../../../ops/platform/p2-recovery-api-current-probe.mjs';
import {observeKnownAckSql} from '../../../../ops/platform/p2-known-ack-loss-probe.mjs';
import {prepareInterruptedKnownAckAction,runInterruptedKnownAckRestoration,interruptedKnownAckEnvironmentLock} from '../../../../ops/platform/p2-known-ack-interrupted-restoration.mjs';
const hash=raw=>createHash('sha256').update(raw).digest('hex');
let phase='owned-new-c-input';const diagnostics=[];
async function main(){
 assert.equal(process.env.P2_INTERRUPTED_OWNED_CHILD,'true');const input=JSON.parse(readFileSync(0));assert.equal(input.target.host,'127.0.0.1');
 const old=JSON.parse(readFileSync(join(input.directory,'interrupted-actual-domain.json'))),urlFor=(user,database)=>`postgresql://${user}:${input.password}@127.0.0.1:${input.port}/${database}?sslmode=verify-full`;
 try{process.kill(old.oldPid,0);assert.fail('old B child remains alive');}catch(error){assert.equal(error.code,'ESRCH');}
 const admin=new Client({connectionString:urlFor(input.target.user,input.target.database),ssl:{rejectUnauthorized:true}});await admin.connect();
 const clients=[];
 try{
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE pid=$1',[old.oldBackend.pid])).rows[0].count,0);
  const artifact=frontendMigrationArtifact(),schema={version:1,serverMajor:input.postgresMajor,catalog:await readMigrationCatalog(admin)},schemaBytes=JSON.stringify(schema);
  const runtimeRole=input.runtime.name,target={...input.target,runtimeRole,approvedPendingTags:artifact.migrations.map(row=>row.tag)};
  const candidate=input.candidate;
  const rawCandidate=Buffer.from(JSON.stringify(candidate)+'\n'),candidateSha256=hash(rawCandidate),actionId='owned-interrupted-restoration-c';
  const job={environment:'staging',releaseId:candidate.releaseId,sourceCommit:input.sourceCommit,target,contractPhase:'p2',phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,
   migrationImageDigest:'sha256:'+'2'.repeat(64),sqlArtifactSha256:artifact.sqlArtifactSha256,schemaBaselineSha256:hash(schemaBytes),contractManifestSha256:artifact.contractManifestSha256};
  const retiredOid=(await admin.query("SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname='interrupted_retired'")).rows[0].oid;
  const prepared={migration:{candidate,job,artifact,baseline:schema},plan:{sourceCommit:input.sourceCommit,targetSha256:input.targetSha256,owner:input.owner,
   producers:[{producerSha256:'b'.repeat(64),role:input.runtime}],historicalLogins:{retiredLogins:[{name:'interrupted_retired',oid:retiredOid}]}}};
  const jobs={frontend:{job,schema:schemaBytes,image:candidate.artifacts.frontendMigration.image,service:'frontend'}},apiModules={};
  phase='owned-actual-api-current-jobs';
  for(const service of ['course','community']){
   const api=input.apis[service],modules=Object.assign({},await import(pathToFileURL(join(api.root,'src/db/operator-migration.ts'))),await import(pathToFileURL(join(api.root,'src/db/migration-lineage.ts'))),await import(pathToFileURL(join(api.root,'src/db/migration-schema.ts'))));
   apiModules[service]={...modules,prepareOperatorMigration:(job,schema,_directory,name)=>modules.prepareOperatorMigration(job,schema,join(api.root,'drizzle'),name)};
   const connection=urlFor(api.migrationRole,api.database.database),client=new Client({connectionString:connection,ssl:{rejectUnauthorized:true}});await client.connect();clients.push(client);
   const migration=modules.loadMigrationArtifact(join(api.root,'drizzle'),'lash-her-'+service+'-api'),apiSchema=JSON.stringify({schemaVersion:1,serverMajor:input.postgresMajor,artifactSha256:migration.artifactSha256,catalog:await modules.readMigrationCatalog(client)});
   const apiJob={schemaVersion:1,kind:'operator-migration',releaseId:candidate.releaseId,operator:'Dardan',environment:'staging',sourceCommit:api.commit,
    migrationImageDigest:'sha256:'+(service==='course'?'3':'5').repeat(64),runtimeImageDigest:'sha256:'+(service==='course'?'4':'6').repeat(64),contractSha256:'7'.repeat(64),
    contractPhase:'p2',phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,runtimeRole:api.database.user,schemaBaselineSha256:hash(apiSchema),recoveryRef:'owned/recovery',stagingVerification:null,
    statementTimeoutMs:10000,ddlLockTimeoutMs:1000,target:{schemaVersion:1,service:'lash-her-'+service+'-api',environment:'staging',host:'127.0.0.1',port:input.port,database:api.database.database,
     user:api.migrationRole,serverMajor:input.postgresMajor,artifactSha256:migration.artifactSha256,approvedPendingTags:migration.entries.map(row=>row.tag),allowEmptyBootstrap:false,providerIdentityEvidenceRef:'owned/provider'}};
   jobs[service]={job:apiJob,schema:apiSchema,image:candidate.artifacts[service+'Migration'].image,service:'lash-her-'+service+'-api'};
   await observeRecoveryApiCurrent({version:1,service:jobs[service].service,job:apiJob,schemaBytes:apiSchema,candidateSha256,recoveryActionId:actionId},{getUrl:()=>connection,modules:async()=>apiModules[service]});
  }
  phase='owned-prepare-retained-source-fixture';
  const work=join(input.directory,'c-operator');
  const engine=fileURLToPath(new URL('./owned-engine.py',import.meta.url));
  const contextPath=join(work,'owned-context.json'),context=JSON.parse(readFileSync(contextPath));
  const initial=context.initial;
  context.fixture.jobs=jobs;context.fixture.input=input;
  initial.jobs=jobs;
  initial.historicalLogins=prepared.plan.historicalLogins;initial.producers=prepared.plan.producers;
  writeFileSync(contextPath,JSON.stringify(context),{mode:0o600});
  phase='owned-validate-public-plan-and-projected-host-root';
  const publicSelection=structuredClone(initial.interruptedRestoration);
  publicSelection.priorGatewayReference.stopReceiptDirectory='/var/lib/lash-her/releases/staging/p2-certification-'+publicSelection.originalRecoveryActionId;
  const action=prepareInterruptedKnownAckAction(candidate,rawCandidate,publicSelection,initial.configurationSha256);
  // Only the owned Linux-root filesystem projection differs; receipt bytes and
  // source capability validation remain actual fixed implementations.
  action.interruptedRestoration=initial.interruptedRestoration;
  assert.equal(action.recoveryActionId,actionId);assert.equal(action.candidateSha256,initial.candidateSha256);
  const allJournals=async()=>({frontend:hash(JSON.stringify((await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows)),
   ...Object.fromEntries(await Promise.all(clients.map(async(client,index)=>[['course','community'][index],hash(JSON.stringify((await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows))])))});
  phase='owned-actual-frontend-current-precondition';
  await withRecoveryFrontendSession(prepared,action,{getUrl:()=>urlFor(input.target.user,input.target.database),verifyEnvironment:async()=>{}},async()=>{});
  const before=await allJournals();let newBackend,requestCount=0;
  const factory=interruptedKnownAckEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key'},initial,work,{launch(_exe,_args,options){
   const child=spawn('python3',['-B',engine,'broker'],{...options,stdio:['pipe','pipe','pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
   let safeError='';child.stderr.on('data',bytes=>{safeError+=bytes.toString();if(safeError.length>8192)safeError=safeError.slice(-8192);for(const line of safeError.split('\n').slice(0,-1)){try{const item=JSON.parse(line);if(item.status==='OWNED_C_ENGINE_FAILED')diagnostics.push(item);}catch{}}safeError=safeError.split('\n').at(-1);});
   const lines=createInterface({input:child.stdio[3]});lines.on('line',async raw=>{
    const value=JSON.parse(raw);let result,error;
    try{
     requestCount++;
     if(value.operation==='physical'){
      newBackend=value.probe.backendPid;assert.notEqual(newBackend,old.oldBackend.pid);
      result=await observeRecoveryPhysical({...value.probe,operation:value.kind},{getUrl:()=>urlFor(input.target.user,input.target.database)});
     }else if(value.operation==='known-sql'){
      const payload=value.payload;
      result=await observeKnownAckSql(payload,{getUrl:()=>payload.service==='frontend'?urlFor(input.target.user,input.target.database):urlFor(input.apis[payload.service].database.user,input.apis[payload.service].database.database)});
     }else if(value.operation==='api-current'){
      const service=value.service;
      result=await observeRecoveryApiCurrent(value.payload,{getUrl:()=>urlFor(input.apis[service].migrationRole,input.apis[service].database.database),modules:async()=>apiModules[service]});
     }else if(value.operation==='native-off'){result={nativeEnabled:false};}
     else throw new Error('OWNED_UNKNOWN_RPC');
    }catch(failure){diagnostics.push({operation:value.operation,kind:failure.name,code:/^[A-Z0-9_-]{1,80}$/u.test(failure.code??'')?failure.code:'OWNED_READ_REFUSED',checkpoint:failure.checkpoint??null});error={code:/^[A-Z0-9_-]{1,80}$/u.test(failure.code??'')?failure.code:'OWNED_READ_REFUSED',checkpoint:failure.checkpoint??null};}
    child.stdio[4].write(JSON.stringify({id:value.id,result,error})+'\n');
   });return child;
  }});
  phase='actual-new-process-frontend-lease-source-authority-and-restore';
  const outcome=await runInterruptedKnownAckRestoration({prepared,action},{directory:work,getUrl:()=>urlFor(input.target.user,input.target.database),assertSource:()=>{},withEnvironmentLock:factory});
  assert.equal(outcome.originalGatewayUncertaintyPreserved,true);assert.equal(outcome.frontendReadinessVerified,false);assert.equal(outcome.trafficAuthorized,false);
  assert.deepEqual(await allJournals(),before);assert.notEqual(newBackend,old.oldBackend.pid);
  return {status:'P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS',serverMajor:input.postgresMajor,migrations:{frontend:83,course:input.apis.course.migrations,community:input.apis.community.migrations},
   actualThreeDatabases:true,actualTlsScram:true,oldProcessExited:true,oldBackendEnded:true,newFrontendBackend:true,newHostProcess:true,actualHostFlock:true,
   newSourceCapability:true,oldOneRetained:true,newZeroVerifiedInProjectedRuntime:true,allTenSourceStages:true,allThreeJournalsUnchanged:true,sqlReplayed:false,
   frontendReadinessVerified:false,trafficAuthorized:false,providerTouched:false,actualDocker:false,runtimeTransportProjected:true,requestCount,
   terminalReceiptSha256:hash(readFileSync(join(work,'p2-known-ack-interrupted-restoration-outcome.json'))),terminalReceipt:outcome};
 }finally{for(const client of clients)await client.end();await admin.end();}
}
main().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({status:'P2_INTERRUPTED_OWNED_FAILED',phase,code:error.code??error.name,checkpoint:error.checkpoint??null,diagnostics:diagnostics.slice(-8)}));process.exitCode=1;});
