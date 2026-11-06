// Explicit disposable PG16 fixture only; no configured/live URL is accepted.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync,unlinkSync,realpathSync } from 'node:fs';
import { join,relative } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { frontendMigrationArtifact } from './frontend-migration.mjs';
import { readMigrationCatalog } from './frontend-schema.mjs';
import { withRecoveryFrontendSession, observeRecoveryPhysical,issueP2RecoveryForwardScope,readP2RecoveryForwardScope,verifyP2RecoveryForwardMutation,RECOVERY_HELD_LOCK } from './p2-recovery-current-probe.mjs';
import { observeRecoveryApiCurrent } from './p2-recovery-api-current-probe.mjs';
import { frontendCoordinationHash as hash } from './frontend-release-inventory.mjs';
import {frontendReleaseReceiptStore,readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {frontendProviderBindingsArtifact} from './frontend-provider-bindings.mjs';
import {P2_CERTIFICATION_PROFILE} from './p2-certification-profile.mjs';
const OWNED_CHILD_PHASES=new Set(['boot', 'frontend-connect', 'frontend-owner-roles', 'frontend-recovery-session', 'forward-composed-failure-control', 'forward-prior-reconciliation', 'forward-api-course-current', 'forward-api-community-current', 'forward-runtime-credential-negatives', 'forward-new-build-probe-promote', 'forward-post-build-runtime-credential-negative', 'forward-source-scope', 'forward-shared-compatible-observation', 'forward-shared-vercel-observation', 'forward-open-admission-and-receipt-negatives', 'forward-journal-preservation', 'forward-scope-expired', 'forward-result', 'current-frontend-privileges', 'current-api-privileges', 'current-result']);
let currentOwnedPhase='boot';
const ownedFixturePhase=phase=>{assert.ok(OWNED_CHILD_PHASES.has(phase));currentOwnedPhase=phase;process.stderr.write(JSON.stringify({status:'OWNED_P2_RECOVERY_PHASE',phase})+'\n');};
assert.equal(process.env.P2_RECOVERY_OWNED_TEST,'true');
ownedFixturePhase('boot');
const assertOwnedEnvironment=()=>assert.deepEqual(Object.keys(process.env).filter(key=>!['PATH','HOME','LANG','TMPDIR','NODE_EXTRA_CA_CERTS','P2_RECOVERY_OWNED_TEST','P2_RECOVERY_OWNED_CONNECTIONS'].includes(key)&&!key.startsWith('LC_')&&
  // macOS inserts this CoreFoundation encoding metadata after exec; it is not
  // inherited by the Python allowlist and cannot select a loader or database.
  !(process.platform==='darwin'&&key==='__CF_USER_TEXT_ENCODING'&&/^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/iu.test(process.env[key]))),[],'ambient configuration entered owned child (names only)');
assertOwnedEnvironment();
const privateInput=JSON.parse(process.env.P2_RECOVERY_OWNED_CONNECTIONS);const serverMajor=privateInput.serverMajor;assert.ok([16,18].includes(serverMajor));
assert.equal(new URL(privateInput.frontend).hostname,'127.0.0.1');
if(privateInput.ownedForwardIdleControl!==undefined)assert.equal(typeof privateInput.ownedForwardIdleControl,'boolean');
const connect=async (url,options={})=>{const client=new Client({connectionString:url,ssl:{rejectUnauthorized:true},...options});await client.connect();return client;};
function ownedBindings(supplied,plan){
  const identities=[...supplied.bindings.deployments.map(row=>({kind:'deployment',identity:{provider:'vercel',teamId:supplied.bindings.teamId,projectId:supplied.bindings.projectId,deploymentId:row.deploymentId}})),
      {kind:'scheduler',identity:{provider:'vercel',teamId:supplied.bindings.teamId,projectId:supplied.bindings.projectId,scheduler:'native-crons'}}];
  plan.externalSurfaces=identities.map(row=>({kind:row.kind,identitySha256:hash(row.identity),surfaceSha256:hash({kind:row.kind,identitySha256:hash(row.identity)})})).sort((a,b)=>a.surfaceSha256.localeCompare(b.surfaceSha256));
  const bindings=frontendProviderBindingsArtifact({version:1,...supplied.bindings,surfaces:identities.map(row=>({...row,surfaceSha256:plan.externalSurfaces.find(item=>item.kind===row.kind&&item.identitySha256===hash(row.identity)).surfaceSha256}))},plan);
  plan.providerBindingsSha256=hash(bindings);
  return bindings;
}

const OWNED_NODE_GUARDS=new Set(['P2_RECOVERY_CURRENT_DATABASE_REFUSED','P2_RECOVERY_RUNTIME_CREDENTIAL_REFUSED','P2_RECOVERY_RUNTIME_CREDENTIAL_CLEANUP_UNCERTAIN',
  'P2_RECOVERY_FRONTEND_SESSION_FAILED_REQUIRES_REVIEW','P2_RECOVERY_FRONTEND_RECHECK_REFUSED','P2_RECOVERY_FRONTEND_CLEANUP_UNCERTAIN','FRONTEND_PROVIDER_RUNTIME_CONTEXT_REFUSED','FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED','FRONTEND_PROVIDER_ADAPTER_REFUSED']);
const OWNED_NODE_FILES=new Set(['ops/platform/p2-recovery-current-probe.mjs','ops/platform/p2-recovery-frontend-observation.mjs','ops/platform/frontend-release-adapters.mjs','ops/platform/test-p2-recovery-owned.mjs']);
const sourceRoot=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
function ownedNodeDiagnostic(error,stage){
  const safe=key=>{try{return error?.[key];}catch{return undefined;}};
  const stack=safe('stack'),frames=[],roots=[{source:'frontend',root:sourceRoot,prefix:''}];
  if(privateInput.forwardFixture?.graph)try{roots.push({source:'frontend-fixture',root:realpathSync(privateInput.forwardFixture.graph),prefix:'ops/platform/'});}catch{ /* Unknown source paths stay unbound. */ }
  for(const line of typeof stack==='string'?stack.split('\n'):[]){
    const match=/(?:file:\/\/)?(\/[^()]+):(\d{1,7}):(\d{1,6})\)?$/u.exec(line);if(!match)continue;
    let file;try{file=realpathSync(fileURLToPath('file://'+match[1]));}catch{continue;}
    for(const{source,root,prefix}of roots){const name=prefix+relative(root,file);if(!OWNED_NODE_FILES.has(name))continue;
      const frame={source,file:name,line:Number(match[2]),column:Number(match[3])};
      if(frames.length<12&&!frames.some(row=>JSON.stringify(row)===JSON.stringify(frame)))frames.push(frame);
    }
  }
  const message=safe('message'),kind=safe('name'),checkpoint=safe('checkpoint'),system=safe('code');
  const guardCode=OWNED_NODE_GUARDS.has(message)&&frames.some(frame=>{if(frame.file==='ops/platform/test-p2-recovery-owned.mjs')return false;
    try{const line=readFileSync(join(roots.find(row=>row.source===frame.source).root,frame.source==='frontend-fixture'?frame.file.slice('ops/platform/'.length):frame.file),'utf8').split('\n')[frame.line-1];return line?.includes("'"+message+"'")||line?.includes('"'+message+'"');}catch{return false;}})?message:'unknown';
  return{status:'OWNED_P2_RECOVERY_NODE_DIAGNOSTIC',phase:currentOwnedPhase,stage,
    kind:['Error','AssertionError','TypeError','RangeError','SyntaxError'].includes(kind)?kind:'unknown',guardCode,
    systemCode:['ERR_ASSERTION','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','57P01','57P02','57P03','53300'].includes(system)?system:'unknown',
    checkpoint:['runtime-credential','runtime-physical-session','forward-brand','forward-mode'].includes(checkpoint)?checkpoint:'unknown',frames};
}
const ownedOperations=new AsyncLocalStorage(),ownedFailures=new WeakMap();
async function ownedCall(stage,task){
  const parent=ownedOperations.getStore(),operation={errors:[]};
  return ownedOperations.run(operation,async()=>{try{return await task();}catch(error){
    const records=[...operation.errors,...(ownedFailures.get(error)??[]),ownedNodeDiagnostic(error,stage)];
    const unique=records.filter((row,index)=>records.findIndex(other=>JSON.stringify(other)===JSON.stringify(row))===index).slice(-8);
    if(error&&(typeof error==='object'||typeof error==='function'))ownedFailures.set(error,unique);if(parent)parent.errors.push(...unique);throw error;
  }});
}
const ownedEmission={attempted:0,emitted:0,projectionFailures:0,uncaughtMonitor:0,origin:'none'};
function emitOwned(error,stage,records){
  ownedEmission.attempted++;
  try{for(const record of records??[ownedNodeDiagnostic(error,stage)]){writeFileSync(2,JSON.stringify(record)+'\n');ownedEmission.emitted++;}}
  catch{ownedEmission.projectionFailures++;}
}
async function ownedBoundary(task){
  try{return await task();}catch(error){
    emitOwned(error,'forward-callback',ownedFailures.get(error));throw error;
  }
}
// Monitor default termination; do not consume the exception or change exit.
process.on('uncaughtExceptionMonitor',(error,origin)=>{ownedEmission.uncaughtMonitor++;ownedEmission.origin=['uncaughtException','unhandledRejection'].includes(origin)?origin:'unknown';emitOwned(error,'uncaught-final');});
process.once('exit',code=>{if(code!==0)try{writeFileSync(2,JSON.stringify({status:'OWNED_P2_NODE_EMISSION_SUMMARY',...ownedEmission})+'\n');}catch{ /* A closed diagnostic pipe cannot change the original exit. */ }});

if(privateInput.ownedComposedDiagnosticControl!==undefined){
  const mode=privateInput.ownedComposedDiagnosticControl;assert.ok(['python-source-guard','node-pre-spawn','node-checkpoint','node-message-collision','shared-observer-guard','shared-observer-assertion'].includes(mode));
  const fixture=privateInput.forwardFixture,supplied=fixture.context,plan=structuredClone(supplied.plan),role=supplied.writerTarget.user;
  plan.producers=[{producerSha256:plan.bootstrapCompatibility.runtimeProducerSha256,role:{name:role}}];
  const bindings=ownedBindings(supplied,plan),bridge=await import(pathToFileURL(join(fixture.graph,'p2-recovery-frontend-observation.mjs')));
  let verified=0;
  const context={candidate:supplied.candidate,plan,job:{target:{runtimeRole:role}},action:{...supplied.action,forwardReason:'prior-build-canceled'},
    originalDirectory:supplied.originalDirectory,directory:privateInput.ownedComposedReceiptDirectory,bootstrapRuntimeTarget:supplied.writerTarget,
    getProviderContext:async()=>({...supplied,bindings,vercelToken:'owned-token-marker'}),
    verifyLockedSession:()=>ownedCall('composed-checkpoint',async()=>{if(mode==='node-checkpoint'&&++verified===2)await readP2RecoveryForwardScope({},context);})};
  if(mode==='node-pre-spawn')plan.producers=[];
  ownedFixturePhase('forward-composed-failure-control');
  await ownedBoundary(async()=>{
    if(mode.startsWith('shared-observer-')){
      await assert.rejects(ownedCall('expected-negative',()=>readP2RecoveryForwardScope({},context)));
      ownedFixturePhase('forward-shared-vercel-observation');
      const adapters=await import(pathToFileURL(join(fixture.graph,'frontend-release-adapters.mjs')));
      if(mode==='shared-observer-guard')context.candidate={...context.candidate,sources:{...context.candidate.sources,frontend:{...context.candidate.sources.frontend,commit:'f'.repeat(40)}}};
      await ownedCall('shared-vercel',()=>adapters.runFrontendVercelWorker('observe-vercel',context));
      assert.equal('PRIVATE_ASSERT_ACTUAL','PRIVATE_ASSERT_EXPECTED');
    }else await ownedCall('composed-source-bridge',()=>{if(mode==='node-message-collision')throw new Error('P2_RECOVERY_FRONTEND_RECHECK_REFUSED');return bridge.reconcileP2RecoveryForward(context);});
    assert.fail('controlled production bridge refusal was not enforced');
  });
}
ownedFixturePhase('frontend-connect');
const admin=await connect(privateInput.frontend),artifact=frontendMigrationArtifact();
if(privateInput.ownedLateSessionDiagnosticControl!==undefined){
  const mode=privateInput.ownedLateSessionDiagnosticControl;assert.ok(['post-callback-verifier','session-finally'].includes(mode));
  const roles=Object.fromEntries((await admin.query("SELECT rolname,oid::text FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])",[['recovery_owner','recovery_runtime','recovery_retired']])).rows.map(row=>[row.rolname,row.oid]));
  assert.equal(Object.keys(roles).length,3);
  const fixture=privateInput.forwardFixture,url=new URL(privateInput.frontend);url.username='recovery_creator';url.password=privateInput.password;
  const target={host:url.hostname,port:Number(url.port),database:'postgres',user:'recovery_creator',runtimeRole:'recovery_runtime',serverMajor,approvedPendingTags:artifact.migrations.map(row=>row.tag)};
  const targetSha256=fixture.context.plan.targetSha256,sourceCommit='a'.repeat(40);
  const job={environment:'staging',releaseId:'adapter-owned',sourceCommit,target,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'9'.repeat(64),sqlArtifactSha256:artifact.sqlArtifactSha256,migrationImageDigest:'sha256:'+'e'.repeat(64),schemaBaselineSha256:'f'.repeat(64),contractManifestSha256:artifact.contractManifestSha256};
  const plan={environment:'staging',sourceCommit,targetSha256,owner:{name:'recovery_owner',oid:roles.recovery_owner},producers:[{producerSha256:'5'.repeat(64),role:{name:'recovery_runtime',oid:roles.recovery_runtime}}],historicalLogins:{retiredLogins:[{name:'recovery_retired',oid:roles.recovery_retired}]}};
  const prepared={migration:{job,artifact,baseline:{catalog:await readMigrationCatalog(admin)}},plan};
  const action={recoveryActionId:'owned-late-'+mode,candidateSha256:'1'.repeat(64),originalReceiptSha256:{'job-outcome.json':null}};
  try{await ownedBoundary(()=>withRecoveryFrontendSession(prepared,action,{getUrl:()=>url.href,verifyEnvironment:async()=>{}},async({client})=>{
    ownedFixturePhase('forward-shared-vercel-observation');
    if(mode==='post-callback-verifier')await client.query('SELECT pg_catalog.pg_advisory_unlock_all()');
    else{const end=client.end.bind(client);client.end=async()=>{await end();process.stderr.write(JSON.stringify({status:'OWNED_LATE_SESSION_CONTROL',mode,callbackReturned:true,endCompleted:true})+'\n');throw new Error('PRIVATE_END_CANARY');};}
    process.stderr.write(JSON.stringify({status:'OWNED_LATE_SESSION_CONTROL',mode,callbackReturned:true,endCompleted:false})+'\n');
    return 'owned callback returned';
  }));assert.fail('actual late source-session refusal was not enforced');}finally{await admin.end();}
}
let checks=0,legacyApiVerifierRefusals=0;
const privilegeFaults=[];
try{
  ownedFixturePhase('frontend-owner-roles');
  await admin.query('CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)');
  for(const migration of artifact.migrations)await admin.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',[migration.hash,migration.folderMillis]);
  assert.match(privateInput.password,/^owned-[a-f0-9-]+$/u);
  await admin.query("CREATE ROLE recovery_creator LOGIN CREATEROLE NOINHERIT PASSWORD '"+privateInput.password+"'; GRANT CREATE ON DATABASE postgres TO recovery_creator; GRANT USAGE,CREATE ON SCHEMA public TO recovery_creator");
  await admin.query('SET ROLE recovery_creator');
  await admin.query("CREATE ROLE recovery_owner NOLOGIN NOINHERIT; CREATE ROLE recovery_runtime LOGIN NOINHERIT PASSWORD '"+privateInput.password+"'; GRANT recovery_owner TO recovery_creator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE");
  await admin.query('RESET ROLE');
  // These are valid provider administrative capabilities, not runtime grants.
  // Keep them enabled throughout qualification to reject accidental policy
  // additions that would prohibit the reviewed Neon provisioning principal.
  await admin.query('ALTER ROLE recovery_creator CREATEDB INHERIT REPLICATION BYPASSRLS');
  await admin.query(`CREATE SCHEMA recovery_shadow AUTHORIZATION recovery_creator;
    CREATE VIEW recovery_shadow.pg_roles AS SELECT * FROM pg_catalog.pg_roles WHERE false;
    CREATE FUNCTION recovery_shadow.hashtext(text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 0';
    ALTER ROLE recovery_creator SET search_path TO recovery_shadow,pg_catalog,public;
    ALTER DATABASE postgres SET search_path TO recovery_shadow,pg_catalog,public`);
  await admin.query("CREATE ROLE recovery_retired NOLOGIN NOINHERIT; GRANT CREATE ON DATABASE postgres TO recovery_owner; GRANT USAGE ON SCHEMA drizzle TO recovery_creator; GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO recovery_creator");
  await admin.query('CREATE SEQUENCE public.recovery_acl_probe');
  await admin.query('SET ROLE recovery_owner');await admin.query(readFileSync(new URL('./frontend-admission.sql',import.meta.url),'utf8'));await admin.query('RESET ROLE');
  await admin.query("GRANT USAGE ON SCHEMA public,frontend_admission TO recovery_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO recovery_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO recovery_runtime; GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO recovery_runtime; SET ROLE recovery_creator; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO recovery_runtime; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO recovery_runtime; RESET ROLE; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC");
  const roles=Object.fromEntries((await admin.query("SELECT rolname,oid::text FROM pg_roles WHERE rolname=ANY($1::text[])",[['recovery_owner','recovery_runtime','recovery_retired']])).rows.map(row=>[row.rolname,row.oid]));
  const fixture=privateInput.forwardFixture;
  const targetSha256=fixture?.context.plan.targetSha256??'a'.repeat(64),sourceCommit=fixture?'a'.repeat(40):'b'.repeat(40),producerSha256=fixture?'5'.repeat(64):'c'.repeat(64);
  await admin.query("INSERT INTO frontend_admission.control(singleton,environment,target_sha256) VALUES(true,'staging',$1)",[targetSha256]);
  await admin.query('INSERT INTO frontend_admission.producers VALUES($1,$2,$3,true)',[producerSha256,sourceCommit,roles.recovery_runtime]);
  const url=new URL(privateInput.frontend);url.username='recovery_creator';url.password=privateInput.password;
  const target={host:url.hostname,port:Number(url.port),database:'postgres',user:'recovery_creator',runtimeRole:'recovery_runtime',serverMajor,approvedPendingTags:artifact.migrations.map(row=>row.tag)};
  const job={environment:'staging',releaseId:fixture?'adapter-owned':'original-qualified',sourceCommit,target,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+(fixture?'9':'d').repeat(64),sqlArtifactSha256:artifact.sqlArtifactSha256,migrationImageDigest:'sha256:'+'e'.repeat(64),schemaBaselineSha256:'f'.repeat(64),contractManifestSha256:artifact.contractManifestSha256};
  const plan={environment:'staging',sourceCommit,targetSha256,owner:{name:'recovery_owner',oid:roles.recovery_owner},producers:[{producerSha256,role:{name:'recovery_runtime',oid:roles.recovery_runtime}}],historicalLogins:{retiredLogins:[{name:'recovery_retired',oid:roles.recovery_retired}]}};
  const prepared={migration:{job,artifact,baseline:{catalog:await readMigrationCatalog(admin)}},plan};
  const action={recoveryActionId:'deliberate-recovery',candidateSha256:'1'.repeat(64),originalReceiptSha256:{'job-outcome.json':null}};
  const deps={getUrl:()=>url.href,verifyEnvironment:async()=>{}};
  const creatorMemberships=(await admin.query("SELECT m.admin_option,m.inherit_option,m.set_option,g.rolsuper AS grantor_super FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles g ON g.oid=m.grantor WHERE r.rolname IN ('recovery_owner','recovery_runtime') ORDER BY m.admin_option,m.roleid")).rows;
  assert.equal(creatorMemberships.length,3);assert.equal(creatorMemberships.filter(row=>row.admin_option&&row.grantor_super&&!row.inherit_option&&!row.set_option).length,2);
  if(fixture){
    const supplied=fixture.context,candidate=supplied.candidate;
    Object.assign(plan,supplied.plan,{...plan,actionId:candidate.releaseId,certification:structuredClone(P2_CERTIFICATION_PROFILE)});
    prepared.migration.candidate=structuredClone(candidate);
    const bindings=ownedBindings(supplied,plan);
    const forwardAction={...supplied.action,candidateSha256:hash(Buffer.from(JSON.stringify(candidate)+'\n')),inventorySha256:hash(plan)};
    const store=frontendReleaseReceiptStore(supplied.directory),base={...forwardAction,targetSha256};
    const bridge=await import(pathToFileURL(join(fixture.graph,'p2-recovery-frontend-observation.mjs'))),adapters=await import(pathToFileURL(join(fixture.graph,'frontend-release-adapters.mjs')));
    let retainedScope,retainedContext,idleSessionProof,mutationRefusals=0,runtimeCredentialRefusals=0;
    await store.record('p2-recovery-started.json',{...base,status:'P2_POST_SQL_RECOVERY_STARTED'});
    ownedFixturePhase('frontend-recovery-session');
    await withRecoveryFrontendSession(prepared,forwardAction,deps,async({session,client,verify,receipt,probe})=>ownedBoundary(async()=>{
      const context={candidate,plan,job,action:forwardAction,checkpoint:'recovery',inventorySha256:forwardAction.inventorySha256,recoveryActionId:forwardAction.recoveryActionId,
        originalDirectory:supplied.originalDirectory,directory:supplied.directory,databaseClient:client,verifyLockedSession:verify,environmentSignal:new AbortController().signal,
        bootstrapRuntimeTarget:{environment:'staging',targetSha256,host:target.host,port:target.port,database:target.database,user:target.runtimeRole,serverMajor},
        getProviderContext:async()=>({bindings,vercelToken:'owned-token-marker',privateConfigurationDirectory:supplied.privateConfigurationDirectory,
          gatewayHost:supplied.gatewayHost,frontendRuntimeDatabaseUrl:supplied.frontendRuntimeDatabaseUrl}),
        verifyMutationScope:runtimeCredential=>ownedCall('mutation-checkpoint',()=>verifyP2RecoveryForwardMutation(session,context,runtimeCredential))};
      context.action.forwardPrivateConfigurationDirectory=supplied.newPrivateConfigurationDirectory;
      await store.record('p2-recovery-current-database.json',receipt);
      assert.equal((await observeRecoveryPhysical({...probe,operation:'verify-schema'},deps)).status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
      ownedFixturePhase('forward-prior-reconciliation');
      const prior=await bridge.reconcileP2RecoveryForward(context);await store.record('p2-recovery-forward-original.json',prior);
      const apiDatabases={};
      for(const service of ['course','community']){
        ownedFixturePhase(service==='course'?'forward-api-course-current':'forward-api-community-current');
        const apiRoot=privateInput.apiRoots[service],api=Object.assign({},await import(pathToFileURL(join(apiRoot,'src/db/operator-migration.ts'))),await import(pathToFileURL(join(apiRoot,'src/db/migration-lineage.ts'))),await import(pathToFileURL(join(apiRoot,'src/db/migration-schema.ts'))));
        const apiAdmin=await connect(privateInput[service]);
        try{
          const apiArtifact=api.loadMigrationArtifact(join(apiRoot,'drizzle'),'lash-her-'+service+'-api'),schemaBytes=JSON.stringify({schemaVersion:1,serverMajor,artifactSha256:apiArtifact.artifactSha256,catalog:await api.readMigrationCatalog(apiAdmin)}),connection=new URL(privateInput[service]);
          const apiJob={schemaVersion:1,kind:'operator-migration',releaseId:candidate.releaseId,operator:'Dardan',environment:'staging',sourceCommit:'2'.repeat(40),migrationImageDigest:'sha256:'+'3'.repeat(64),runtimeImageDigest:'sha256:'+'4'.repeat(64),contractSha256:'5'.repeat(64),runtimeRole:service+'_recovery_runtime',schemaBaselineSha256:hash(schemaBytes),recoveryRef:'owned/recovery',stagingVerification:null,statementTimeoutMs:10000,ddlLockTimeoutMs:1000,
            target:{schemaVersion:1,service:'lash-her-'+service+'-api',environment:'staging',host:connection.hostname,port:Number(connection.port),database:service+'_recovery_owned',user:service+'_recovery_migration',serverMajor,artifactSha256:apiArtifact.artifactSha256,approvedPendingTags:apiArtifact.entries.map(row=>row.tag),allowEmptyBootstrap:false,providerIdentityEvidenceRef:'owned/provider'}};
          apiDatabases[service]=await observeRecoveryApiCurrent({version:1,service:'lash-her-'+service+'-api',job:apiJob,schemaBytes,candidateSha256:forwardAction.candidateSha256,recoveryActionId:forwardAction.recoveryActionId},{getUrl:()=>privateInput[service],modules:async()=>({...api,prepareOperatorMigration:(job,schema,_directory,service)=>api.prepareOperatorMigration(job,schema,join(apiRoot,'drizzle'),service)})});
        }finally{await apiAdmin.end();}
      }
      await store.record('p2-recovery-api-runtime.json',{...base,status:'P2_RECOVERY_API_RUNTIME_READY',apiDatabases,containers:Array.from({length:10},(_,index)=>({name:'fixture-runtime-'+index})),sqlReplayed:false,fixtureOnly:true});
      await store.record('p2-recovery-forward-started.json',{...base,status:'P2_RECOVERY_NEW_BUILD_INTENT',reason:forwardAction.forwardReason,
        currentDatabaseReceiptSha256:hash(readFrontendReleaseEvidence(supplied.directory,'p2-recovery-current-database.json')),
        apiRuntimeReceiptSha256:hash(readFrontendReleaseEvidence(supplied.directory,'p2-recovery-api-runtime.json')),
        priorReconciliationReceiptSha256:hash(readFrontendReleaseEvidence(supplied.directory,'p2-recovery-forward-original.json')),
        expectedWriterAdmissionBinding:{mode:'enforce',targetSha256,producerSha256,sourceCommit,roleName:target.runtimeRole},featureControls:plan.certification.featureControls});
      ownedFixturePhase('forward-runtime-credential-negatives');
      const getProvider=context.getProviderContext,validProvider=await getProvider();let credentialRefusals=0;
      const runtimeRefusal=async task=>{writeFileSync(fixture.runtimeFaultFlag,'active',{mode:0o600,flag:'wx'});try{await assert.rejects(task);credentialRefusals++;}finally{unlinkSync(fixture.runtimeFaultFlag);}};
      const runtimePositive=async()=>{
        const runtime=await connect(validProvider.frontendRuntimeDatabaseUrl,{options:'-c default_transaction_read_only=on -c search_path=pg_catalog,public'});
        try{
          assert.equal(runtime.connection.stream.encrypted,true);assert.equal(runtime.connection.stream.authorized,true);await runtime.query('BEGIN READ ONLY');
          assert.deepEqual((await runtime.query('SELECT current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid')).rows,[{role:target.runtimeRole,oid:receipt.runtime.oid}]);
          assert.equal((await runtime.query(RECOVERY_HELD_LOCK.replace('pid=pg_backend_pid()','pid=$2'),[probe.marker,probe.backendPid])).rows[0].held,true);await runtime.query('ROLLBACK');
        }finally{await runtime.end();}
      };
      for(const change of [url=>{url.password='owned-wrong-password';},url=>{url.username='recovery_creator';},url=>{url.hostname='localhost';},url=>{url.pathname='/course_recovery_owned';}]){
        await runtimePositive();
        const invalid=new URL(validProvider.frontendRuntimeDatabaseUrl);change(invalid);
        context.getProviderContext=async()=>({...validProvider,frontendRuntimeDatabaseUrl:invalid.href});
        await runtimeRefusal(()=>bridge.buildP2RecoveryForward(context));
        assert.equal(existsSync(join(context.directory,'vercel')),false);
        assert.equal((await admin.query('SELECT new_work,recovery FROM frontend_admission.control WHERE singleton')).rows[0].new_work,false);
        context.getProviderContext=getProvider;await context.verifyMutationScope(validProvider.frontendRuntimeDatabaseUrl);
      }
      let reads=0;context.getProviderContext=async()=>({...validProvider,frontendRuntimeDatabaseUrl:++reads===1?validProvider.frontendRuntimeDatabaseUrl:validProvider.frontendRuntimeDatabaseUrl.replace('recovery_runtime:','recovery_creator:')});
      await runtimeRefusal(()=>bridge.buildP2RecoveryForward(context));assert.equal(existsSync(join(context.directory,'vercel')),false);
      context.getProviderContext=getProvider;await context.verifyMutationScope(validProvider.frontendRuntimeDatabaseUrl);
      const replaced=new URL(validProvider.frontendRuntimeDatabaseUrl);replaced.password='owned-stale-password';
      const mutableProvider={...validProvider,frontendRuntimeDatabaseUrl:replaced.href};
      Object.defineProperty(mutableProvider,'gatewayHost',{get(){mutableProvider.frontendRuntimeDatabaseUrl=validProvider.frontendRuntimeDatabaseUrl;return validProvider.gatewayHost;}});
      context.getProviderContext=async()=>mutableProvider;
      await runtimeRefusal(()=>bridge.buildP2RecoveryForward(context));assert.equal(existsSync(join(context.directory,'vercel')),false);
      context.getProviderContext=getProvider;await context.verifyMutationScope(validProvider.frontendRuntimeDatabaseUrl);
      writeFileSync(fixture.foreignRouteFlag,'active',{mode:0o600,flag:'wx'});
      try{
        const foreign=await connect(validProvider.frontendRuntimeDatabaseUrl);
        try{
          assert.equal(foreign.connection.stream.encrypted,true);assert.equal(foreign.connection.stream.authorized,true);
          assert.deepEqual((await foreign.query('SELECT current_user AS role,current_database() AS database')).rows,[{role:'recovery_runtime',database:'postgres'}]);
          assert.equal((await foreign.query(RECOVERY_HELD_LOCK.replace('pid=pg_backend_pid()','pid=$2'),[probe.marker,probe.backendPid])).rows[0].held,false);
        }finally{await foreign.end();}
        await runtimeRefusal(()=>bridge.buildP2RecoveryForward(context));assert.equal(existsSync(join(context.directory,'vercel')),false);
      }
      finally{unlinkSync(fixture.foreignRouteFlag);}
      await context.verifyMutationScope(validProvider.frontendRuntimeDatabaseUrl);
      await client.query('SELECT pg_advisory_unlock(hashtext($1))',[probe.marker]);
      try{await runtimeRefusal(()=>bridge.buildP2RecoveryForward(context));assert.equal(existsSync(join(context.directory,'vercel')),false);}
      finally{await client.query('SELECT pg_advisory_lock(hashtext($1))',[probe.marker]);}
      await context.verifyMutationScope(validProvider.frontendRuntimeDatabaseUrl);
      ownedFixturePhase('forward-new-build-probe-promote');
      assert.equal((await ownedCall('build-bridge',()=>bridge.buildP2RecoveryForward(context))).status,'P2_RECOVERY_NEW_BUILD_VERIFIED');
      ownedFixturePhase('forward-post-build-runtime-credential-negative');
      const anotherPassword=new URL(validProvider.frontendRuntimeDatabaseUrl);anotherPassword.password='owned-another-password';
      context.getProviderContext=async()=>({...validProvider,frontendRuntimeDatabaseUrl:anotherPassword.href});
      await runtimeRefusal(()=>context.verifyMutationScope(anotherPassword.href));context.getProviderContext=getProvider;await context.verifyMutationScope(validProvider.frontendRuntimeDatabaseUrl);runtimeCredentialRefusals=credentialRefusals;
      ownedFixturePhase('forward-source-scope');
      context.forwardRecoveryScope=await issueP2RecoveryForwardScope(session,context);retainedScope=context.forwardRecoveryScope;retainedContext=context;
      const projection=await readP2RecoveryForwardScope(context.forwardRecoveryScope,context);assert.equal(projection.mode,'reviewed-new-build');assert.equal(Object.keys(projection).length,12);
      const originals=Object.fromEntries(Object.entries(projection.originalReceiptSha256).map(([file,expected])=>[file,expected===null?null:readFileSync(join(projection.originalDirectory,file))]));
      await assert.rejects(readP2RecoveryForwardScope(structuredClone(context.forwardRecoveryScope),context));
      await assert.rejects(readP2RecoveryForwardScope({...context.forwardRecoveryScope},context));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,{...context,databaseClient:{}}));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,{...context,verifyLockedSession:async()=>{}}));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,{...context,plan:{...plan,targetSha256:'9'.repeat(64)}}));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,{...context,candidate:{...candidate,releaseId:'wrong-candidate'}}));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,{...context,bootstrapRuntimeTarget:{...context.bootstrapRuntimeTarget,user:'wrong_runtime'}}));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,{...context,directory:context.originalDirectory}));
      await assert.rejects(adapters.runFrontendVercelWorker('observe-compatible',{...context,inventorySha256:'f'.repeat(64)}));
      await assert.rejects(adapters.runFrontendVercelWorker('observe-compatible',{...context,recoveryActionId:'wrong-action'}));
      for(const operation of ['deploy-compatible','retire-deployments','suspend-schedules'])await assert.rejects(adapters.runFrontendVercelWorker(operation,context));
      ownedFixturePhase('forward-shared-compatible-observation');
      const observed=await ownedCall('shared-compatible',()=>adapters.observeCompatibleFrontend(context));assert.equal(observed.readyState,'READY');assert.equal(observed.workloadVerified,true);
      assert.equal(observed.aliasDeploymentId,observed.deploymentId);assert.equal(observed.aliasJobDeploymentId,observed.deploymentId);assert.equal(observed.aliasJobMatchesIntent,true);assert.equal(observed.nativeSchedulesEnabled,false);
      assert.deepEqual(observed.featureControls,plan.certification.featureControls);
      assert.deepEqual(observed.writerAdmissionBinding,{mode:'enforce',targetSha256,producerSha256,sourceCommit,roleName:target.runtimeRole});
      assert.equal(observed.configurationRecordSha256,observed.workloadReceiptSha256);assert.equal(observed.certificationSchedule.path,'/api/cron/account-lifecycle');
      const workload=await adapters.readCompatibleFrontendWorkloadReceipt(context,observed);assert.equal(hash(workload),observed.workloadReceiptSha256);
      assert.deepEqual(workload,readFileSync(join(context.directory,'vercel/frontend-workload-outcome.json')));
      ownedFixturePhase('forward-shared-vercel-observation');
      if(privateInput.ownedForwardIdleControl===true){
        const beforePid=(await admin.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid;
        const beforeJournal=(await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')).rows;
        await new Promise(resolve=>setTimeout(resolve,31_000));
        assert.equal((await admin.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid,beforePid);
        assert.deepEqual((await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')).rows,beforeJournal);
        assert.equal(admin.connection.stream.encrypted,true);assert.equal(admin.connection.stream.authorized,true);
        await context.verifyLockedSession();idleSessionProof={idleSeconds:31,sameBackend:true,journalUnchanged:true,tlsAuthorized:true};
      }
      const inventory=await ownedCall('shared-vercel',()=>adapters.runFrontendVercelWorker('observe-vercel',context));assert.equal(inventory.reviewedInventoryMatches,true);assert.equal(inventory.reviewedProjectMatches,true);assert.equal(inventory.aliasJobActive,false);
      assert.equal(inventory.knownTerminalActionBuilds.length,1);assert.notEqual(inventory.knownTerminalActionBuilds[0].deploymentId,observed.deploymentId);
      for(const result of [inventory,observed]){assert.equal(result.forwardRecovery.recoveryActionId,projection.recoveryActionId);assert.deepEqual(result.forwardRecovery.originalReceiptSha256,projection.originalReceiptSha256);}
      assert.equal((await ownedCall('shared-frontend',()=>bridge.observeP2RecoveryFrontend(context))).status,'P2_RECOVERY_FRONTEND_RUNTIME_VERIFIED');
      ownedFixturePhase('forward-open-admission-and-receipt-negatives');
      await admin.query('UPDATE frontend_admission.control SET recovery=true');
      await assert.rejects(context.verifyMutationScope(supplied.frontendRuntimeDatabaseUrl));mutationRefusals++;
      // The same verified receipt scope remains valid for GET after ordered
      // admission opening; it never grants another mutation or probe extension.
      assert.equal((await adapters.observeCompatibleFrontend(context)).readyState,'READY');
      await admin.query('UPDATE frontend_admission.control SET recovery=false');
      const file=join(supplied.directory,'p2-recovery-forward-outcome.json'),original=readFileSync(file);writeFileSync(file,Buffer.concat([original,Buffer.from(' ')]));
      await assert.rejects(readP2RecoveryForwardScope(context.forwardRecoveryScope,context));writeFileSync(file,original);
      for(const[file,bytes]of Object.entries(originals)){if(bytes===null)assert.equal(existsSync(join(projection.originalDirectory,file)),false);else assert.deepEqual(readFileSync(join(projection.originalDirectory,file)),bytes);}
      ownedFixturePhase('forward-journal-preservation');
      assert.equal(hash((await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows),receipt.journalSha256);
      for(const service of ['course','community']){
        const current=await connect(privateInput[service]);
        try{assert.equal(hash((await current.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows),apiDatabases[service].journalSha256);}
        finally{await current.end();}
      }
      await verify();
    }));
    ownedFixturePhase('forward-scope-expired');
    await assert.rejects(readP2RecoveryForwardScope(retainedScope,retainedContext));
    assertOwnedEnvironment();
    ownedFixturePhase('forward-result');
    console.log(JSON.stringify({status:'OWNED_P2_RECOVERY_FORWARD_SOURCE_CHECKS_PASS',serverMajor,frontendMigrations:artifact.migrations.length,
      courseMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.course,'drizzle/meta/_journal.json'))).entries.length,
      communityMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.community,'drizzle/meta/_journal.json'))).entries.length,
      checks:['actual-fe-physical-session','both-api-current-readonly','actual-tls-build-probe-promote','same-source-candidate-new-action','real-opaque-scope-shared-observer','selected-workload-bytes',
        'cloned-plain-scope-refused','wrong-client-verifier-refused','wrong-plan-candidate-target-directory-refused','wrong-inventory-action-refused','shared-mutation-operations-refused',
        'receipt-drift-refused','expired-session-refused','open-admission-mutation-refused','opened-admission-get-retained','original-terminal-retained-not-current','original-receipts-preserved',
        'actual-runtime-credential-tls-physical-binding','bad-runtime-credential-and-foreign-physical-refused'],
      ...(idleSessionProof?{idleSessionProof}:{}),mutationRefusals,runtimeCredentialRefusals,foreignRuntimeTlsAuthenticated:true,noSqlReplay:true,journalDigestsUnchanged:true,originalFrontendTerminalRecreated:false,skipped:0,fixtureOnly:true,providerTouched:false,actualRuntimeContainers:false,childEnvironmentAllowlistEnforced:true}));
  }else{
  ownedFixturePhase('current-frontend-privileges');
  const checkFrontendFault=async(id,install,remove,afterInstall=async()=>{})=>{
    const checkpoint=id==='frontend-operator-superuser'?'operator-role-policy':id==='frontend-runtime-role-settings'?'runtime-role-settings':id==='frontend-runtime-database-settings'?'selected-role-database-settings':id==='frontend-runtime-rogue-ownership'?'runtime-ownership':id==='frontend-runtime-public-schema-access'?'runtime-schema-access':/inbound|outbound|rogue-admin/u.test(id)?'role-memberships':/default/u.test(id)?'runtime-default-grants':'runtime-extra-privileges';
    await withRecoveryFrontendSession(prepared,action,deps,async({probe})=>{
      assert.equal((await observeRecoveryPhysical({...probe,operation:'verify-schema'},deps)).status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
      await admin.query(install);
      try{
        await afterInstall();
        let continuousRefused=false;
        try{await observeRecoveryPhysical({...probe,operation:'verify-schema'},deps);}catch(error){continuousRefused=error.checkpoint===checkpoint;}
        privilegeFaults.push({id,continuousRefused});
      }finally{await admin.query(remove);}
      assert.equal((await observeRecoveryPhysical({...probe,operation:'verify-schema'},deps)).status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
    });
    await admin.query(install);
    try{
      await afterInstall();
      let initialRefused=false,restorationEntered=false;
      try{await withRecoveryFrontendSession(prepared,action,deps,async()=>{restorationEntered=true;});}catch(error){initialRefused=error.checkpoint===checkpoint;}
      privilegeFaults.at(-1).initialRefused=initialRefused;privilegeFaults.at(-1).restorationEntered=restorationEntered;
      assert.deepEqual((await admin.query('SELECT new_work,recovery FROM frontend_admission.control WHERE singleton')).rows,[{new_work:false,recovery:false}]);
    }finally{await admin.query(remove);}
    await withRecoveryFrontendSession(prepared,action,deps,async({receipt})=>assert.equal(receipt.status,'P2_RECOVERY_DATABASE_CURRENT'));
    checks++;
  };
  assert.deepEqual((await admin.query("SELECT proname FROM pg_proc WHERE pronamespace='frontend_admission'::regnamespace ORDER BY proname")).rows.map(row=>row.proname),['admit','begin_operation','current_policy','finish_operation','settle']);
  await withRecoveryFrontendSession(prepared,action,deps,async({client,receipt,probe,verify})=>{
    assert.equal((await admin.query("SELECT rolconfig FROM pg_catalog.pg_roles WHERE rolname='recovery_creator'")).rows[0].rolconfig[0],'search_path=recovery_shadow, pg_catalog, public');
    assert.deepEqual((await client.query('SHOW search_path')).rows[0].search_path.split(',').map(value=>value.trim()),['pg_catalog','public']);
    assert.notEqual((await client.query("SELECT hashtext('lash-her:private-db:migrations') AS value")).rows[0].value,0);
    assert.equal(receipt.status,'P2_RECOVERY_DATABASE_CURRENT');assert.equal(receipt.originalReceiptSha256['job-outcome.json'],null);assert.equal(receipt.sqlReplayed,false);
    assert.equal((await admin.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',['lash-her:private-db:migrations'])).rows[0].locked,false);
    const actual=await observeRecoveryPhysical({...probe,operation:'verify-schema'},deps);assert.equal(actual.status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
    assert.equal(actual.admission.newWork,false);await verify();checks++;
  });
  await admin.query('CREATE ROLE recovery_rogue LOGIN NOINHERIT');
  const sequence=(await admin.query("SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.oid LIMIT 1")).rows[0].name;
  await checkFrontendFault('frontend-runtime-inbound','GRANT recovery_runtime TO recovery_rogue','REVOKE recovery_runtime FROM recovery_rogue');
  await checkFrontendFault('frontend-runtime-outbound','GRANT recovery_rogue TO recovery_runtime','REVOKE recovery_rogue FROM recovery_runtime');
  await checkFrontendFault('frontend-runtime-rogue-admin','GRANT recovery_runtime TO recovery_rogue WITH ADMIN TRUE, INHERIT FALSE, SET FALSE','REVOKE recovery_runtime FROM recovery_rogue');
  await checkFrontendFault('frontend-owner-inbound','GRANT recovery_owner TO recovery_rogue','REVOKE recovery_owner FROM recovery_rogue');
  await checkFrontendFault('frontend-owner-outbound','GRANT recovery_rogue TO recovery_owner','REVOKE recovery_rogue FROM recovery_owner');
  await checkFrontendFault('frontend-operator-superuser','ALTER ROLE recovery_creator SUPERUSER','ALTER ROLE recovery_creator NOSUPERUSER');
  await checkFrontendFault('frontend-runtime-role-settings','ALTER ROLE recovery_runtime SET search_path TO pg_catalog,public','ALTER ROLE recovery_runtime RESET ALL');
  await checkFrontendFault('frontend-runtime-database-settings','ALTER ROLE recovery_runtime IN DATABASE postgres SET search_path TO recovery_shadow,pg_catalog,public','ALTER ROLE recovery_runtime IN DATABASE postgres RESET ALL');
  await checkFrontendFault('frontend-runtime-rogue-ownership','CREATE SCHEMA recovery_runtime_rogue AUTHORIZATION recovery_runtime','DROP SCHEMA recovery_runtime_rogue');
  await checkFrontendFault('frontend-runtime-public-schema-access',`ALTER DATABASE postgres RESET search_path;
    SET ROLE recovery_creator; CREATE SCHEMA recovery_runtime; CREATE TABLE recovery_runtime.shadow_marker(marker text); INSERT INTO recovery_runtime.shadow_marker VALUES('owned-shadow');
    GRANT USAGE ON SCHEMA recovery_runtime TO PUBLIC; GRANT SELECT ON recovery_runtime.shadow_marker TO PUBLIC; RESET ROLE`,
    'DROP SCHEMA recovery_runtime CASCADE; ALTER DATABASE postgres SET search_path TO recovery_shadow,pg_catalog,public',async()=>{
      const runtimeUrl=new URL(privateInput.frontend);runtimeUrl.username='recovery_runtime';runtimeUrl.password=privateInput.password;
      const runtime=await connect(runtimeUrl.href);
      try{assert.equal((await runtime.query('SELECT current_schema() AS name')).rows[0].name,'recovery_runtime');assert.equal((await runtime.query('SELECT marker FROM shadow_marker')).rows[0].marker,'owned-shadow');}
      finally{await runtime.end();}
    });
  await checkFrontendFault('frontend-sequence-update','GRANT UPDATE ON SEQUENCE '+sequence+' TO recovery_runtime','REVOKE UPDATE ON SEQUENCE '+sequence+' FROM recovery_runtime');
  await checkFrontendFault('frontend-default-unexpected-grantee','ALTER DEFAULT PRIVILEGES FOR ROLE recovery_creator IN SCHEMA public GRANT SELECT ON TABLES TO recovery_rogue','ALTER DEFAULT PRIVILEGES FOR ROLE recovery_creator IN SCHEMA public REVOKE SELECT ON TABLES FROM recovery_rogue');
  await checkFrontendFault('frontend-global-default','ALTER DEFAULT PRIVILEGES FOR ROLE recovery_creator GRANT SELECT ON TABLES TO recovery_rogue','ALTER DEFAULT PRIVILEGES FOR ROLE recovery_creator REVOKE SELECT ON TABLES FROM recovery_rogue');
  const frontendTable=(await admin.query("SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.oid LIMIT 1")).rows[0].name;
  await checkFrontendFault('frontend-table-grant-option','GRANT SELECT ON TABLE '+frontendTable+' TO recovery_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR SELECT ON TABLE '+frontendTable+' FROM recovery_runtime');
  await checkFrontendFault('frontend-default-grant-option','ALTER DEFAULT PRIVILEGES FOR ROLE recovery_creator IN SCHEMA public GRANT SELECT ON TABLES TO recovery_runtime WITH GRANT OPTION','ALTER DEFAULT PRIVILEGES FOR ROLE recovery_creator IN SCHEMA public REVOKE GRANT OPTION FOR SELECT ON TABLES FROM recovery_runtime');
  for(const privilege of ['REFERENCES','TRIGGER']){
    await checkFrontendFault('frontend-table-'+privilege.toLowerCase(),'GRANT '+privilege+' ON TABLE '+frontendTable+' TO recovery_runtime','REVOKE '+privilege+' ON TABLE '+frontendTable+' FROM recovery_runtime');
  }
  assert.deepEqual(privilegeFaults.filter(row=>row.initialRefused!==true||row.continuousRefused!==true||row.restorationEntered!==false).map(row=>row.id),[],'frontend privilege drift entered restoration');
  const stale=structuredClone(prepared);stale.plan.owner.oid='9999999';
  await assert.rejects(withRecoveryFrontendSession(stale,action,deps,async()=>assert.fail('stale prepared owner OID accepted')));checks++;
  await admin.query('ALTER ROLE recovery_owner CREATEROLE');
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async()=>assert.fail('unexpected owner privilege accepted')));checks++;
  await admin.query('ALTER ROLE recovery_owner NOCREATEROLE');
  await admin.query('UPDATE frontend_admission.control SET recovery=true');
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async()=>assert.fail('already-open admission accepted')));checks++;
  await admin.query('UPDATE frontend_admission.control SET recovery=false');
  const bootstrap=readFileSync(new URL('./frontend-admission.sql',import.meta.url),'utf8');
  const routine=bootstrap.match(/CREATE FUNCTION frontend_admission\.current_policy[\s\S]*?\$\$;/u)[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
  await admin.query('SET ROLE recovery_owner');await admin.query(routine.replace('BEGIN','BEGIN\n--owned catalog fault'));await admin.query('RESET ROLE');
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async()=>assert.fail('changed security-definer body accepted')));checks++;
  await admin.query('SET ROLE recovery_owner');await admin.query(routine);await admin.query('RESET ROLE');
  await admin.query('ALTER ROLE recovery_retired LOGIN');
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async()=>assert.fail('old LOGIN accepted')));checks++;
  await admin.query('ALTER ROLE recovery_retired PASSWORD $1',[privateInput.password]).catch(async()=>{
    // Parameter placeholders are not legal in ALTER ROLE. Use the trusted
    // generated fixture-only password in a source-owned quoted literal.
    assert.match(privateInput.password,/^owned-[a-f0-9-]+$/u);await admin.query("ALTER ROLE recovery_retired PASSWORD '"+privateInput.password+"'");
  });
  const legacyUrl=new URL(privateInput.frontend);legacyUrl.username='recovery_retired';legacyUrl.password=privateInput.password;
  const legacy=await connect(legacyUrl.href);await admin.query('ALTER ROLE recovery_retired NOLOGIN');
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async()=>assert.fail('old active session accepted')));checks++;
  await legacy.end();await assert.rejects(connect(legacyUrl.href));checks++;
  await admin.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at=$1',[artifact.migrations.at(-1).folderMillis]);
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async()=>assert.fail('partial lineage accepted')));checks++;
  await admin.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',[artifact.migrations.at(-1).hash,artifact.migrations.at(-1).folderMillis]);
  await assert.rejects(withRecoveryFrontendSession(prepared,action,deps,async({probe,verify})=>{await admin.query('SELECT pg_terminate_backend($1)',[probe.backendPid]);await verify();}));checks++;
  ownedFixturePhase('current-api-privileges');
  for(const service of ['course','community']){
    const apiRoot=privateInput.apiRoots[service];
    const api=Object.assign({},await import(pathToFileURL(join(apiRoot,'src/db/operator-migration.ts'))),await import(pathToFileURL(join(apiRoot,'src/db/migration-lineage.ts'))),await import(pathToFileURL(join(apiRoot,'src/db/migration-schema.ts'))));
    const apiArtifact=api.loadMigrationArtifact(join(apiRoot,'drizzle'),'lash-her-'+service+'-api'),apiAdmin=await connect(privateInput[service]);
    try{
      const baseline={schemaVersion:1,serverMajor,artifactSha256:apiArtifact.artifactSha256,catalog:await api.readMigrationCatalog(apiAdmin)},schemaBytes=JSON.stringify(baseline),connection=new URL(privateInput[service]);
      const apiJob={schemaVersion:1,kind:'operator-migration',releaseId:'original-qualified',operator:'Dardan',environment:'staging',sourceCommit:'2'.repeat(40),migrationImageDigest:'sha256:'+'3'.repeat(64),runtimeImageDigest:'sha256:'+'4'.repeat(64),contractSha256:'5'.repeat(64),runtimeRole:service+'_recovery_runtime',schemaBaselineSha256:hash(schemaBytes),recoveryRef:'owned/recovery',stagingVerification:null,statementTimeoutMs:10000,ddlLockTimeoutMs:1000,
        target:{schemaVersion:1,service:'lash-her-'+service+'-api',environment:'staging',host:connection.hostname,port:Number(connection.port),database:service+'_recovery_owned',user:service+'_recovery_migration',serverMajor,artifactSha256:apiArtifact.artifactSha256,approvedPendingTags:apiArtifact.entries.map(row=>row.tag),allowEmptyBootstrap:false,providerIdentityEvidenceRef:'owned/provider'}};
      const request={version:1,service:'lash-her-'+service+'-api',job:apiJob,schemaBytes,candidateSha256:action.candidateSha256,recoveryActionId:action.recoveryActionId};
      const modules=async()=>({...api,prepareOperatorMigration:(job,schema,_directory,service)=>api.prepareOperatorMigration(job,schema,join(apiRoot,'drizzle'),service)});
      const legacyModules=async()=>({...await modules(),verifyOperatorRoles:undefined});
      const actual=await observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules});assert.equal(actual.status,'P2_RECOVERY_API_DATABASE_CURRENT');assert.deepEqual(actual.pendingTags,[]);checks++;
      await assert.rejects(observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules:legacyModules}),error=>error.checkpoint==='api-role-export');legacyApiVerifierRefusals++;checks++;
      assert.equal((await observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules})).status,'P2_RECOVERY_API_DATABASE_CURRENT');
      // Original manifest remains nonempty while current-only verification is
      // independent. Removing a committed journal row never invokes apply.
      assert.equal(request.job.target.approvedPendingTags.length,apiArtifact.entries.length);
      const privileged=await connect(privateInput[service+'Admin']);
      try{
        const runtime=apiJob.runtimeRole,migration=apiJob.target.user;
        const table=(await privileged.query("SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.oid LIMIT 1")).rows[0].name;
        const seq=(await privileged.query("SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.oid LIMIT 1")).rows[0].name;
        const faults=[
          ['runtime-inbound','GRANT '+runtime+' TO recovery_rogue','REVOKE '+runtime+' FROM recovery_rogue'],
          ['migration-inbound','GRANT '+migration+' TO recovery_rogue','REVOKE '+migration+' FROM recovery_rogue'],
          ['runtime-outbound','GRANT recovery_rogue TO '+runtime,'REVOKE recovery_rogue FROM '+runtime],
          ['sequence-update','GRANT UPDATE ON SEQUENCE '+seq+' TO '+runtime,'REVOKE UPDATE ON SEQUENCE '+seq+' FROM '+runtime],
          ...['TRIGGER','REFERENCES'].map(privilege=>['table-'+privilege.toLowerCase(),'GRANT '+privilege+' ON TABLE '+table+' TO '+runtime,'REVOKE '+privilege+' ON TABLE '+table+' FROM '+runtime]),
          ['default-unexpected-grantee','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' IN SCHEMA public GRANT SELECT ON TABLES TO recovery_rogue','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' IN SCHEMA public REVOKE SELECT ON TABLES FROM recovery_rogue'],
          ['default-sequence-update','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' IN SCHEMA public GRANT UPDATE ON SEQUENCES TO '+runtime,'ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM '+runtime],
          ['global-default','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' GRANT SELECT ON TABLES TO recovery_rogue','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' REVOKE SELECT ON TABLES FROM recovery_rogue'],
          ['table-grant-option','GRANT SELECT ON TABLE '+table+' TO '+runtime+' WITH GRANT OPTION','REVOKE GRANT OPTION FOR SELECT ON TABLE '+table+' FROM '+runtime],
          ['default-grant-option','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' IN SCHEMA public GRANT SELECT ON TABLES TO '+runtime+' WITH GRANT OPTION','ALTER DEFAULT PRIVILEGES FOR ROLE '+migration+' IN SCHEMA public REVOKE GRANT OPTION FOR SELECT ON TABLES FROM '+runtime],
        ];
        for(const[id,install,remove]of faults){
          assert.equal((await observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules})).status,'P2_RECOVERY_API_DATABASE_CURRENT');
          await privileged.query(install);
          try{let refused=false;try{await observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules});}catch(error){refused=error.checkpoint==='api-role-policy';}
            privilegeFaults.push({id:service+'-'+id,initialRefused:refused});checks++;
          }finally{await privileged.query(remove);}
          assert.equal((await observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules})).status,'P2_RECOVERY_API_DATABASE_CURRENT');
        }
        await privileged.query('DELETE FROM drizzle.__drizzle_migrations WHERE id=(SELECT max(id) FROM drizzle.__drizzle_migrations)');
        await assert.rejects(observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules}),error=>error.checkpoint==='api-lineage');checks++;
      }finally{await privileged.end();}
    }finally{await apiAdmin.end();}
  }
  assert.deepEqual(privilegeFaults.filter(row=>row.initialRefused!==true||row.continuousRefused===false||row.restorationEntered===true).map(row=>row.id),[],'unsafe privilege fault was accepted');
  assertOwnedEnvironment();
  ownedFixturePhase('current-result');
  console.log(JSON.stringify({status:'OWNED_P2_RECOVERY_DATABASE_SOURCE_CHECKS_PASS',checks,frontendMigrations:artifact.migrations.length,courseMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.course,'drizzle/meta/_journal.json'))).entries.length,communityMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.community,'drizzle/meta/_journal.json'))).entries.length,serverMajor,noSqlReplay:true,originalFrontendTerminalRecreated:false,
    skipped:0,fixtureOnly:true,providerTouched:false,privilegeFaults:privilegeFaults.map(row=>row.id).sort(),
    frontendInitialPrivilegeRefusals:privilegeFaults.filter(row=>row.id.startsWith('frontend-')&&row.initialRefused).length,
    frontendContinuousPrivilegeRefusals:privilegeFaults.filter(row=>row.id.startsWith('frontend-')&&row.continuousRefused).length,
    apiPrivilegeRefusals:privilegeFaults.filter(row=>!row.id.startsWith('frontend-')&&row.initialRefused).length,
    legacyApiVerifierRefusals,frontendCreatorPolicy:'actual-non-superuser-automatic-admin-plus-explicit-owner-set',frontendCreatorMemberships:creatorMemberships.length,frontendOperatorSearchPathPinned:true,childEnvironmentAllowlistEnforced:true}));
  }
}finally{await admin.end();}
