// New process after the actual B whole-route child exited. All credentials are
// generated inside the disposable cluster and remain stdin/private files only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {Client} from 'pg';
import {frontendMigrationArtifact} from '../../../../ops/platform/frontend-migration.mjs';
import {readMigrationCatalog} from '../../../../ops/platform/frontend-schema.mjs';
import {observeRecoveryPhysical,withRecoveryFrontendSession} from '../../../../ops/platform/p2-recovery-current-probe.mjs';
import {observeRecoveryApiCurrent} from '../../../../ops/platform/p2-recovery-api-current-probe.mjs';
import {observeKnownAckSql} from '../../../../ops/platform/p2-known-ack-loss-probe.mjs';
import {CAUSAL_FILES,prepareInterruptedKnownAckAction,runInterruptedKnownAckRestoration,interruptedKnownAckEnvironmentLock} from '../../../../ops/platform/p2-known-ack-interrupted-restoration.mjs';
const hash=raw=>createHash('sha256').update(raw).digest('hex');
let phase='owned-new-c-input';const diagnostics=[];
export async function ownedApiCurrent(input,candidate,candidateSha256,actionId){
 const jobs={},apiModules={},clients=[],proofs={};
 const urlFor=(user,database)=>`postgresql://${user}:${input.password}@127.0.0.1:${input.port}/${database}?sslmode=verify-full`;
 try{
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
   proofs[service]=await observeRecoveryApiCurrent({version:1,service:jobs[service].service,job:apiJob,schemaBytes:apiSchema,candidateSha256,recoveryActionId:actionId},{getUrl:()=>connection,modules:async()=>apiModules[service]});
  }
  return {jobs,apiModules,clients,proofs};
 }catch(error){for(const client of clients)await client.end();throw error;}
}
async function main(){
 assert.equal(process.env.P2_INTERRUPTED_OWNED_CHILD,'true');const input=JSON.parse(readFileSync(0));const faultMode=input.faultMode??'none';assert.ok(['none','original-bytes','original-config-drift','missing-lineage','pending-lineage','backend-effect','active-backend-loss','active-guard-loss'].includes(faultMode));assert.equal(input.target.host,'127.0.0.1');
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
  const boundApi=await ownedApiCurrent(input,candidate,candidateSha256,actionId);Object.assign(jobs,boundApi.jobs);Object.assign(apiModules,boundApi.apiModules);clients.push(...boundApi.clients);
  phase='owned-prepare-retained-source-fixture';
  const work=join(input.directory,'c-operator');
  const engine=fileURLToPath(new URL('./owned-engine.py',import.meta.url));
  const contextPath=join(work,'owned-context.json'),context=JSON.parse(readFileSync(contextPath));
  const initial=context.initial;
  const originalCausalReceiptSha256=structuredClone(old.originalCausalReceiptSha256);
  assert.deepEqual(Object.keys(originalCausalReceiptSha256).sort(),[...CAUSAL_FILES].sort());
  const verifyOriginalCausal=()=>{for(const name of CAUSAL_FILES)assert.equal(hash(readFileSync(join(context.root,'p2-known-ack-loss-'+initial.interruptedRestoration.originalCertificationActionId,name))),originalCausalReceiptSha256[name]);};
  verifyOriginalCausal();
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
  const before=await allJournals();let newBackend,requestCount=0,injected=false;
  initial.ownedFaultMode=faultMode;
  const sourceRoot=context.root,lineage=join(sourceRoot,'.p2-gateway-lineage.json');
  if(faultMode==='original-bytes'){const file=join(sourceRoot,'p2-known-ack-loss-'+initial.interruptedRestoration.originalCertificationActionId,'domain.json');writeFileSync(file,Buffer.concat([readFileSync(file),Buffer.from('\n')]));}
  if(faultMode==='original-config-drift'){
   const file=join(initial.configuration,'course-api.env');writeFileSync(file,Buffer.concat([readFileSync(file),Buffer.from('OWNED_HARMLESS_CONFIG_DRIFT=1\n')]));
   initial.configurationSha256['course-api.env']=hash(readFileSync(file));action.configurationSha256=hash(JSON.stringify(initial.configurationSha256));
   context.models['course-api']=[];writeFileSync(contextPath,JSON.stringify(context),{mode:0o600});
  }
  if(faultMode==='missing-lineage')unlinkSync(lineage);
  if(faultMode==='pending-lineage'){const value=JSON.parse(readFileSync(lineage));value.state='replacement-in-progress';delete value.stopReceiptDirectory;delete value.stopReceiptSha256;value.expectedCandidateSha256=initial.candidateSha256;writeFileSync(lineage,JSON.stringify(value),{mode:0o600});}
  if(faultMode==='backend-effect')await clients[0].query("INSERT INTO account_lifecycle_states(user_id,account_version,status,updated_at) VALUES($1,1,'suspended',now())",[randomUUID()]);

  const factory=interruptedKnownAckEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key'},initial,work,{launch(_exe,_args,options){
   const child=spawn('python3',['-B',engine,'broker'],{...options,stdio:['pipe','pipe','pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
   let safeError='';child.stderr.on('data',bytes=>{safeError+=bytes.toString();if(safeError.length>8192)safeError=safeError.slice(-8192);for(const line of safeError.split('\n').slice(0,-1)){try{const item=JSON.parse(line);if(item.status==='OWNED_C_ENGINE_FAILED')diagnostics.push(item);}catch{}}safeError=safeError.split('\n').at(-1);});
   const lines=createInterface({input:child.stdio[3]});lines.on('line',async raw=>{
    const value=JSON.parse(raw);let result,error;
    try{
     requestCount++;
     if(value.operation==='physical'){
      newBackend=value.probe.backendPid;if(faultMode==='active-backend-loss'&&value.progress?.upCommands===1&&!injected){injected=true;await admin.query('SELECT pg_catalog.pg_terminate_backend($1)',[newBackend]);}assert.notEqual(newBackend,old.oldBackend.pid);
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
  let outcome,failure;try{outcome=await runInterruptedKnownAckRestoration({prepared,action},{directory:work,getUrl:()=>urlFor(input.target.user,input.target.database),assertSource:()=>{},withEnvironmentLock:factory});}catch(error){failure=error;}
  if(faultMode!=='none'){
   assert.ok(failure);const report=JSON.parse(readFileSync(join(work,'owned-loss-result.json')));
   assert.equal(report.upCommands,faultMode.startsWith('active-')?1:0);assert.equal(report.Cterminal,false);assert.equal(report.Bterminal,false);assert.equal(report.oldOneRetained,true);assert.deepEqual(await allJournals(),before);
   const expected={'original-bytes':'P2_INTERRUPTED_ORIGINAL_RECEIPT_CHANGED','original-config-drift':'P2_INTERRUPTED_ORIGINAL_CONFIGURATION_REQUIRED','missing-lineage':'PRIOR_GATEWAY_LATEST_STOP_LINEAGE_REQUIRED','pending-lineage':'PRIOR_GATEWAY_LATEST_STOP_LINEAGE_REQUIRED','backend-effect':'P2_KNOWN_ACK_BACKEND_PROJECTION_CHANGED'}[faultMode];
   if(expected)assert.ok(diagnostics.some(value=>value.code===expected||value.trace?.some(row=>row.code===expected)));
   if(faultMode==='active-guard-loss'){assert.equal(report.actualGuardWriterExited,true);assert.equal(report.nativeDisabled,true);assert.equal(report.runtimeStopped,true);assert.deepEqual(report.cleanedNamespaces,['certification','recovery']);}
   if(faultMode==='active-backend-loss'){assert.equal(injected,true);assert.equal(report.runtimeStopped,true);}
   return{status:'P2_INTERRUPTED_NEGATIVE_OWNED_PASS',case:faultMode,actualThreeDatabases:true,actualTlsScram:true,newHostProcess:true,newFrontendBackend:!!newBackend,actualHostFlock:true,...report,allThreeJournalsUnchanged:true,providerTouched:false,actualDocker:false,runtimeTransportProjected:true,frontendReadinessVerified:false,trafficAuthorized:false};
  }
  if(failure)throw failure;
  verifyOriginalCausal();assert.deepEqual(outcome.originalCausalReceiptSha256,originalCausalReceiptSha256);
  assert.equal(outcome.originalGatewayUncertaintyPreserved,true);assert.equal(outcome.frontendReadinessVerified,false);assert.equal(outcome.trafficAuthorized,false);
  assert.deepEqual(await allJournals(),before);assert.notEqual(newBackend,old.oldBackend.pid);
  return {status:'P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS',serverMajor:input.postgresMajor,migrations:{frontend:83,course:input.apis.course.migrations,community:input.apis.community.migrations},
   actualThreeDatabases:true,actualTlsScram:true,oldProcessExited:true,oldBackendEnded:true,newFrontendBackend:true,newHostProcess:true,actualHostFlock:true,
   newSourceCapability:true,oldOneRetained:true,newZeroVerifiedInProjectedRuntime:true,allTenSourceStages:true,allThreeJournalsUnchanged:true,sqlReplayed:false,
   frontendReadinessVerified:false,trafficAuthorized:false,providerTouched:false,actualDocker:false,runtimeTransportProjected:true,requestCount,
   originalCausalReceiptSha256,terminalReceiptSha256:hash(readFileSync(join(work,'p2-known-ack-interrupted-restoration-outcome.json'))),terminalReceipt:outcome};
 }finally{for(const client of clients)await client.end();await admin.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({status:'P2_INTERRUPTED_OWNED_FAILED',phase,code:error.code??error.name,checkpoint:error.checkpoint??null,diagnostics:diagnostics.slice(-8)}));process.exitCode=1;});
