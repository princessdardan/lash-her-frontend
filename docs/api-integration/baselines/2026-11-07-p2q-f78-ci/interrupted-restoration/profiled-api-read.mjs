// Real owned PG18 API current read. The migration image launcher is projected
// to the exact archived API source used by the existing three-database fixture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from 'pg';
import {checkCurrentDatabase} from './frozen-abb/ops/platform/host/database_current.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as frontendProfile} from './frozen-abb/ops/platform/qualification-target-profile.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const quote = value => '"'+value.replaceAll('"','""')+'"';
const journals = async client => sha(JSON.stringify((await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows));

async function roles(setup, connection, password, database, migration, runtime) {
  assert.match(password,/^owned-[0-9a-f-]+$/u);
  for (const name of [database,migration,runtime]) assert.match(name,/^[a-z0-9_]+$/u);
  await setup.query(`CREATE ROLE ${migration} LOGIN NOINHERIT PASSWORD '${password}'; ALTER DATABASE ${database} OWNER TO ${migration}; GRANT CONNECT ON DATABASE ${database} TO ${runtime}`);
  await connection.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${migration}; ALTER SCHEMA drizzle OWNER TO ${migration}; ALTER TABLE drizzle.__drizzle_migrations OWNER TO ${migration}`);
  const relations = (await connection.query("SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') ORDER BY c.relkind,c.relname")).rows;
  for (const row of relations) await connection.query('ALTER '+(row.relkind==='S'?'SEQUENCE':'TABLE')+' public.'+quote(row.relname)+' OWNER TO '+migration);
  for (const row of (await connection.query("SELECT p.oid::regprocedure::text AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).rows)
    await connection.query('ALTER FUNCTION '+row.name+' OWNER TO '+migration);
  for (const row of (await connection.query("SELECT t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d')")).rows)
    await connection.query('ALTER TYPE public.'+quote(row.typname)+' OWNER TO '+migration);
  await connection.query(`SET ROLE ${migration}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${runtime}; GRANT USAGE ON SCHEMA public TO ${runtime}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC; RESET ROLE`);
}

export async function runProfiledApiRead({setup, connect, operator, apis, postgresMajor, port, password, certificate, frontendMigrations}) {
  const ca=readFileSync(certificate,'utf8'), frontendJournal=await journals(operator), results={};
  for (const service of ['course','community']) {
    const api=apis[service], database=api.database.database, name='lash-her-'+service+'-api', migrationRole='lash_her_'+service+'_staging_migration';
    const admin=await connect(database);
    await roles(setup,admin,password,database,migrationRole,api.database.user);
    const originalJournal=await journals(admin);
    const load=path=>import(pathToFileURL(join(api.root,'src/db',path)));
    const migration=await load('operator-migration.ts'), lineage=await load('migration-lineage.ts'), schema=await load('migration-schema.ts'), profile=await load('qualification-target-profile.ts');
    assert.deepEqual(frontendProfile,profile.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
    const artifact=lineage.loadMigrationArtifact(join(api.root,'drizzle'),name);
    const schemaBytes=JSON.stringify({schemaVersion:1,serverMajor:postgresMajor,artifactSha256:artifact.artifactSha256,catalog:await schema.readMigrationCatalog(admin)});
    const job={schemaVersion:2,qualificationTargetProfile:frontendProfile,kind:'operator-migration',releaseId:'owned-profiled-api-check',
      operator:'Dardan',environment:'staging',sourceCommit:api.commit,migrationImageDigest:'sha256:'+'3'.repeat(64),
      runtimeImageDigest:'sha256:'+'4'.repeat(64),contractSha256:'7'.repeat(64),contractPhase:'p2',
      phase2ContractManifestSha256:'sha256:'+'6'.repeat(64),runtimeRole:api.database.user,schemaBaselineSha256:sha(schemaBytes),
      recoveryRef:'owned/recovery',stagingVerification:null,statementTimeoutMs:10000,ddlLockTimeoutMs:1000,target:{
        schemaVersion:2,qualificationTargetProfile:frontendProfile,service:name,environment:'staging',host:'127.0.0.1',port,database,
        user:migrationRole,serverMajor:postgresMajor,artifactSha256:artifact.artifactSha256,approvedPendingTags:[],
        allowEmptyBootstrap:false,providerIdentityEvidenceRef:'owned/provider'}};
    const prepared=migration.prepareOperatorMigration(JSON.stringify(job),schemaBytes,join(api.root,'drizzle'),name,frontendProfile);
    const url=new URL('postgresql://127.0.0.1:'+port+'/'+database+'?sslmode=verify-full');
    url.username=migrationRole;url.password=password;
    const connection=lineage.directMigrationConnection(url.href,prepared.target);
    const probe=async()=>{
      const client=new Client({...connection,ssl:{...connection.ssl,ca},enableChannelBinding:true,
        options:'-c default_transaction_read_only=on -c statement_timeout=10000 -c search_path=pg_catalog,public'});
      try{
        await client.connect();
        return await checkCurrentDatabase({client,prepared,assertAppliedLineage:lineage.assertAppliedLineage,
          readMigrationCatalog:schema.readMigrationCatalog,hasVerifiedMigrationTransport:lineage.hasVerifiedMigrationTransport,
          qualificationProfileModule:profile,verifyOperatorRoles:migration.verifyOperatorRoles},frontendProfile);
      }finally{await client.end();}
    };
    const original=await probe();
    assert.equal(original.appliedCount,api.migrations);assert.equal(original.version,2);
    assert.deepEqual(original.qualificationTargetProfile,frontendProfile);assert.equal(original.migrationsExecuted,false);
    assert.ok(original.checks.includes('selected-image-operator-role-policy'));
    await admin.query('ALTER ROLE '+api.database.user+' IN DATABASE '+database+' SET search_path TO pg_catalog,public');
    try { await assert.rejects(probe(),/MIGRATION_ROLE_CONFIGURATION_REFUSED/u); }
    finally { await admin.query('ALTER ROLE '+api.database.user+' IN DATABASE '+database+' RESET ALL'); }
    assert.deepEqual(await probe(),original);
    assert.equal(await journals(admin),originalJournal);
    results[service]={sourceCommit:api.commit,archiveSha256:api.archiveSha256,lockSha256:api.lockSha256,
      migrations:api.migrations,jobSha256:sha(JSON.stringify(job)),journalSha256:originalJournal,
      actualProfiledRolePolicy:true,actualRoleGucRefused:true,positiveAfterRepair:true};
  }
  assert.equal(await journals(operator),frontendJournal);
  return {version:1,status:'P2_PROFILED_C_API_CURRENT_OWNED_PASS',postgresMajor,frontendMigrations,results,
    allThreeJournalsUnchanged:true,actualPostgresTls:true,actualDocker:false,providerTouched:false,fixtureOnly:true};
}
