// Explicit disposable PG16 fixture only; no configured/live URL is accepted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { frontendMigrationArtifact } from './frontend-migration.mjs';
import { readMigrationCatalog } from './frontend-schema.mjs';
import { withRecoveryFrontendSession, observeRecoveryPhysical } from './p2-recovery-current-probe.mjs';
import { observeRecoveryApiCurrent } from './p2-recovery-api-current-probe.mjs';
import { frontendCoordinationHash as hash } from './frontend-release-inventory.mjs';
assert.equal(process.env.P2_RECOVERY_OWNED_TEST,'true');
const privateInput=JSON.parse(process.env.P2_RECOVERY_OWNED_CONNECTIONS);const serverMajor=privateInput.serverMajor;assert.ok([16,18].includes(serverMajor));
assert.equal(new URL(privateInput.frontend).hostname,'127.0.0.1');
const connect=async url=>{const client=new Client({connectionString:url,ssl:{rejectUnauthorized:true}});await client.connect();return client;};
const admin=await connect(privateInput.frontend),artifact=frontendMigrationArtifact();
let checks=0;
try{
  await admin.query('CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)');
  for(const migration of artifact.migrations)await admin.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',[migration.hash,migration.folderMillis]);
  await admin.query("CREATE ROLE recovery_owner NOLOGIN NOINHERIT; CREATE ROLE recovery_runtime LOGIN NOINHERIT; CREATE ROLE recovery_retired LOGIN NOINHERIT; GRANT CREATE ON DATABASE postgres TO recovery_owner");
  await admin.query('SET ROLE recovery_owner');await admin.query(readFileSync(new URL('./frontend-admission.sql',import.meta.url),'utf8'));await admin.query('RESET ROLE');
  await admin.query("GRANT USAGE ON SCHEMA public,frontend_admission TO recovery_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO recovery_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO recovery_runtime; GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO recovery_runtime; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO recovery_runtime; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO recovery_runtime; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC; ALTER ROLE recovery_retired NOLOGIN");
  const roles=Object.fromEntries((await admin.query("SELECT rolname,oid::text FROM pg_roles WHERE rolname=ANY($1::text[])",[['recovery_owner','recovery_runtime','recovery_retired']])).rows.map(row=>[row.rolname,row.oid]));
  const targetSha256='a'.repeat(64),sourceCommit='b'.repeat(40),producerSha256='c'.repeat(64);
  await admin.query("INSERT INTO frontend_admission.control(singleton,environment,target_sha256) VALUES(true,'staging',$1)",[targetSha256]);
  await admin.query('INSERT INTO frontend_admission.producers VALUES($1,$2,$3,true)',[producerSha256,sourceCommit,roles.recovery_runtime]);
  const url=new URL(privateInput.frontend),target={host:url.hostname,port:Number(url.port),database:'postgres',user:decodeURIComponent(url.username),runtimeRole:'recovery_runtime',serverMajor,approvedPendingTags:artifact.migrations.map(row=>row.tag)};
  const job={environment:'staging',releaseId:'original-qualified',sourceCommit,target,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),sqlArtifactSha256:artifact.sqlArtifactSha256,migrationImageDigest:'sha256:'+'e'.repeat(64),schemaBaselineSha256:'f'.repeat(64),contractManifestSha256:artifact.contractManifestSha256};
  const plan={environment:'staging',sourceCommit,targetSha256,owner:{name:'recovery_owner',oid:roles.recovery_owner},producers:[{producerSha256,role:{name:'recovery_runtime',oid:roles.recovery_runtime}}],historicalLogins:{retiredLogins:[{name:'recovery_retired',oid:roles.recovery_retired}]}};
  const prepared={migration:{job,artifact,baseline:{catalog:await readMigrationCatalog(admin)}},plan};
  const action={recoveryActionId:'deliberate-recovery',candidateSha256:'1'.repeat(64),originalReceiptSha256:{'job-outcome.json':null}};
  const deps={getUrl:()=>privateInput.frontend,verifyEnvironment:async()=>{}};
  assert.deepEqual((await admin.query("SELECT proname FROM pg_proc WHERE pronamespace='frontend_admission'::regnamespace ORDER BY proname")).rows.map(row=>row.proname),['admit','begin_operation','current_policy','finish_operation','settle']);
  await withRecoveryFrontendSession(prepared,action,deps,async({receipt,probe,verify})=>{
    assert.equal(receipt.status,'P2_RECOVERY_DATABASE_CURRENT');assert.equal(receipt.originalReceiptSha256['job-outcome.json'],null);assert.equal(receipt.sqlReplayed,false);
    assert.equal((await admin.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',['lash-her:private-db:migrations'])).rows[0].locked,false);
    const actual=await observeRecoveryPhysical({...probe,operation:'verify-schema'},deps);assert.equal(actual.status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
    assert.equal(actual.admission.newWork,false);await verify();checks++;
  });
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
      const actual=await observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules});assert.equal(actual.status,'P2_RECOVERY_API_DATABASE_CURRENT');assert.deepEqual(actual.pendingTags,[]);checks++;
      // Original manifest remains nonempty while current-only verification is
      // independent. Removing a committed journal row never invokes apply.
      assert.equal(request.job.target.approvedPendingTags.length,apiArtifact.entries.length);
      const privileged=await connect(privateInput[service+'Admin']);
      try{
        await privileged.query('DELETE FROM drizzle.__drizzle_migrations WHERE id=(SELECT max(id) FROM drizzle.__drizzle_migrations)');
        await assert.rejects(observeRecoveryApiCurrent(request,{getUrl:()=>privateInput[service],modules}));checks++;
      }finally{await privileged.end();}
    }finally{await apiAdmin.end();}
  }
  console.log(JSON.stringify({status:'OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS',checks,frontendMigrations:artifact.migrations.length,courseMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.course,'drizzle/meta/_journal.json'))).entries.length,communityMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.community,'drizzle/meta/_journal.json'))).entries.length,serverMajor,noSqlReplay:true,originalFrontendTerminalRecreated:false}));
}finally{await admin.end();}
