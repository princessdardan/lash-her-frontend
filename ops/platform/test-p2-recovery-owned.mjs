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
const assertOwnedEnvironment=()=>assert.deepEqual(Object.keys(process.env).filter(key=>!['PATH','HOME','LANG','TMPDIR','NODE_EXTRA_CA_CERTS','P2_RECOVERY_OWNED_TEST','P2_RECOVERY_OWNED_CONNECTIONS'].includes(key)&&!key.startsWith('LC_')&&
  // macOS inserts this CoreFoundation encoding metadata after exec; it is not
  // inherited by the Python allowlist and cannot select a loader or database.
  !(process.platform==='darwin'&&key==='__CF_USER_TEXT_ENCODING'&&/^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/iu.test(process.env[key]))),[],'ambient configuration entered owned child (names only)');
assertOwnedEnvironment();
const privateInput=JSON.parse(process.env.P2_RECOVERY_OWNED_CONNECTIONS);const serverMajor=privateInput.serverMajor;assert.ok([16,18].includes(serverMajor));
assert.equal(new URL(privateInput.frontend).hostname,'127.0.0.1');
const connect=async url=>{const client=new Client({connectionString:url,ssl:{rejectUnauthorized:true}});await client.connect();return client;};
const admin=await connect(privateInput.frontend),artifact=frontendMigrationArtifact();
let checks=0,legacyApiVerifierRefusals=0;
const privilegeFaults=[];
try{
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
  const targetSha256='a'.repeat(64),sourceCommit='b'.repeat(40),producerSha256='c'.repeat(64);
  await admin.query("INSERT INTO frontend_admission.control(singleton,environment,target_sha256) VALUES(true,'staging',$1)",[targetSha256]);
  await admin.query('INSERT INTO frontend_admission.producers VALUES($1,$2,$3,true)',[producerSha256,sourceCommit,roles.recovery_runtime]);
  const url=new URL(privateInput.frontend);url.username='recovery_creator';url.password=privateInput.password;
  const target={host:url.hostname,port:Number(url.port),database:'postgres',user:'recovery_creator',runtimeRole:'recovery_runtime',serverMajor,approvedPendingTags:artifact.migrations.map(row=>row.tag)};
  const job={environment:'staging',releaseId:'original-qualified',sourceCommit,target,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),sqlArtifactSha256:artifact.sqlArtifactSha256,migrationImageDigest:'sha256:'+'e'.repeat(64),schemaBaselineSha256:'f'.repeat(64),contractManifestSha256:artifact.contractManifestSha256};
  const plan={environment:'staging',sourceCommit,targetSha256,owner:{name:'recovery_owner',oid:roles.recovery_owner},producers:[{producerSha256,role:{name:'recovery_runtime',oid:roles.recovery_runtime}}],historicalLogins:{retiredLogins:[{name:'recovery_retired',oid:roles.recovery_retired}]}};
  const prepared={migration:{job,artifact,baseline:{catalog:await readMigrationCatalog(admin)}},plan};
  const action={recoveryActionId:'deliberate-recovery',candidateSha256:'1'.repeat(64),originalReceiptSha256:{'job-outcome.json':null}};
  const deps={getUrl:()=>url.href,verifyEnvironment:async()=>{}};
  const creatorMemberships=(await admin.query("SELECT m.admin_option,m.inherit_option,m.set_option,g.rolsuper AS grantor_super FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles g ON g.oid=m.grantor WHERE r.rolname IN ('recovery_owner','recovery_runtime') ORDER BY m.admin_option,m.roleid")).rows;
  assert.equal(creatorMemberships.length,3);assert.equal(creatorMemberships.filter(row=>row.admin_option&&row.grantor_super&&!row.inherit_option&&!row.set_option).length,2);
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
  console.log(JSON.stringify({status:'OWNED_P2_RECOVERY_DATABASE_SOURCE_CHECKS_PASS',checks,frontendMigrations:artifact.migrations.length,courseMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.course,'drizzle/meta/_journal.json'))).entries.length,communityMigrations:JSON.parse(readFileSync(join(privateInput.apiRoots.community,'drizzle/meta/_journal.json'))).entries.length,serverMajor,noSqlReplay:true,originalFrontendTerminalRecreated:false,
    skipped:0,fixtureOnly:true,providerTouched:false,privilegeFaults:privilegeFaults.map(row=>row.id).sort(),
    frontendInitialPrivilegeRefusals:privilegeFaults.filter(row=>row.id.startsWith('frontend-')&&row.initialRefused).length,
    frontendContinuousPrivilegeRefusals:privilegeFaults.filter(row=>row.id.startsWith('frontend-')&&row.continuousRefused).length,
    apiPrivilegeRefusals:privilegeFaults.filter(row=>!row.id.startsWith('frontend-')&&row.initialRefused).length,
    legacyApiVerifierRefusals,frontendCreatorPolicy:'actual-non-superuser-automatic-admin-plus-explicit-owner-set',frontendCreatorMemberships:creatorMemberships.length,frontendOperatorSearchPathPinned:true,childEnvironmentAllowlistEnforced:true}));
}finally{await admin.end();}
