// Source-owned current-only verifier. Never invokes a migration/apply runner.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from './frontend-migration.mjs';
import { assertAppliedMigrationLineage } from '../../src/lib/private-db/migration-lineage.ts';
import { readMigrationCatalog } from './frontend-schema.mjs';

const require = (ok,checkpoint) => { if (!ok) { const error=new Error('P2_RECOVERY_CURRENT_DATABASE_REFUSED');if(checkpoint)error.checkpoint=checkpoint;throw error;} };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rawHash=value=>createHash('sha256').update(value).digest('hex');
const recoverySessions=new WeakMap(),forwardScopes=new WeakMap();
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
// Catalog builtins resolve first; public visibility preserves original baseline
// regtype/expression rendering. No operator-selected schema is searched.
const recoveryConnectionOptions=(value,target)=>{const connection=frontendConnectionOptions(value,target);return {...connection,options:[connection.options,'-c search_path=pg_catalog,public'].filter(Boolean).join(' ')};};
export const RECOVERY_LOCK_APPLICATION = 'lash-her-p2-post-sql-recovery';
// Exact bootstrap source body hashes; migration images do not ship its SQL.
export const RECOVERY_ADMISSION_SOURCE_SHA256 = "b8ec48242871a6e44fef415b127709e9b107a60751e47bc0fa328b99244ab6ab";
const expectedRoutineBodies = Object.freeze({"admit": "e8efe70da1fabe4381d640e73bc42b5e204ec5f1aa28589d09b1e73a0be21504", "begin_operation": "c634f0f3f018062fb2b115f923ab8637f02a34c515e8532b41ccd912762917d3", "current_policy": "1322b30139dcb101aafcbd461536c1788233da1f0ab6e9084745513a4da1694e", "finish_operation": "84257c2f6b8be184397e3d326d9908f11a6e9d75facde5c7abb5bad2e9db4e1d", "settle": "a6fb927fbc0df4d7262aba5c6185ebffa737d1adafcf5766080078e0d0f45fbd"});
export const RECOVERY_HELD_LOCK = `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((hashtext($1)::bigint>>32)&4294967295)::oid
 AND objid=(hashtext($1)::bigint&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`;

const forwardRootFiles=['p2-recovery-started.json','p2-recovery-current-database.json','p2-recovery-api-runtime.json','p2-recovery-forward-original.json','p2-recovery-forward-started.json','p2-recovery-forward-outcome.json'];
const forwardVercelFiles=['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json','frontend-workload-outcome.json','frontend-promotion-started.json','frontend-promotion-outcome.json'];
async function forwardSession(session,context){
  const record=recoverySessions.get(session);require(record,'forward-session');
  const {target}=record.prepared.migration.job,plan=record.prepared.plan;
  const runtimeTarget={environment:plan.environment,targetSha256:plan.targetSha256,host:target.host,port:target.port,database:target.database,user:target.runtimeRole,serverMajor:target.serverMajor};
  require(context.databaseClient===record.client && context.verifyLockedSession===record.verify &&
    isDeepStrictEqual(context.candidate,record.candidate) && isDeepStrictEqual(context.plan,record.plan) &&
    isDeepStrictEqual(context.bootstrapRuntimeTarget,runtimeTarget),'forward-context');
  await record.verify();return record;
}
async function forwardReceipts(projection,record){
  // Lazy operator-only dependency: original migration images run only the
  // self-contained observer and do not need the operator receipt module.
  const {frontendPrivateReceiptDirectory,readFrontendReleaseEvidence}=await import('./frontend-release-receipts.mjs');
  const {join}=await import('node:path');
  const {lstatSync}=await import('node:fs');
  frontendPrivateReceiptDirectory(projection.directory);frontendPrivateReceiptDirectory(projection.originalDirectory);
  require(projection.directory!==projection.originalDirectory,'forward-directories');
  for(const [file,expected]of Object.entries(projection.originalReceiptSha256)){
    require(/^(?:vercel\/)?[a-z0-9][a-z0-9.-]{0,180}\.json$/u.test(file),'forward-original-path');
    const parts=file.split('/'),parent=parts.length===2?join(projection.originalDirectory,parts[0]):projection.originalDirectory;
    if(expected===null)require(lstatSync(join(parent,parts.at(-1)),{throwIfNoEntry:false})===undefined,'forward-original-absence');
    else require(rawHash(readFrontendReleaseEvidence(parent,parts.at(-1)))===expected,'forward-original-drift');
  }
  const newReceiptSha256={},documents={};
  for(const file of forwardRootFiles){const bytes=readFrontendReleaseEvidence(projection.directory,file);newReceiptSha256[file]=rawHash(bytes);documents[file]=JSON.parse(bytes);}
  for(const file of forwardVercelFiles){const bytes=readFrontendReleaseEvidence(join(projection.directory,'vercel'),file);newReceiptSha256['vercel/'+file]=rawHash(bytes);documents[file]=JSON.parse(bytes);}
  const start=documents['p2-recovery-forward-started.json'],outcome=documents['p2-recovery-forward-outcome.json'],original=documents['p2-recovery-forward-original.json'];
  const identity=value=>value.recoveryActionId===projection.recoveryActionId && value.originalReleaseId===projection.originalReleaseId &&
    value.candidateSha256===projection.candidateSha256 && value.sourceCommit===projection.sourceCommit && value.targetSha256===projection.targetSha256 &&
    value.inventorySha256===projection.inventorySha256 && value.configurationSha256===projection.configurationSha256 && isDeepStrictEqual(value.originalReceiptSha256,projection.originalReceiptSha256);
  require(identity(start)&&identity(outcome)&&identity(original)&&start.status==='P2_RECOVERY_NEW_BUILD_INTENT'&&
    outcome.status==='P2_RECOVERY_NEW_BUILD_VERIFIED'&&original.status==='P2_RECOVERY_FORWARD_ORIGINAL_RECONCILED'&&
    start.reason===record.action.forwardReason&&original.reason===start.reason&&outcome.reason===start.reason,'forward-root-chain');
  require(isDeepStrictEqual(documents['p2-recovery-current-database.json'],record.receipt) &&
    start.currentDatabaseReceiptSha256===newReceiptSha256['p2-recovery-current-database.json'] &&
    start.apiRuntimeReceiptSha256===newReceiptSha256['p2-recovery-api-runtime.json'] &&
    start.priorReconciliationReceiptSha256===newReceiptSha256['p2-recovery-forward-original.json'] &&
    outcome.intentSha256===newReceiptSha256['p2-recovery-forward-started.json'],'forward-proof-chain');
  const api=documents['p2-recovery-api-runtime.json'];
  require(api.status==='P2_RECOVERY_API_RUNTIME_READY'&&api.recoveryActionId===projection.recoveryActionId&&api.candidateSha256===projection.candidateSha256&&api.sqlReplayed===false&&
    api.apiDatabases?.course?.status==='P2_RECOVERY_API_DATABASE_CURRENT'&&api.apiDatabases.community?.status==='P2_RECOVERY_API_DATABASE_CURRENT'&&api.containers?.length===10,'forward-api-current');
  for(const file of forwardVercelFiles)require(outcome.receiptSha256?.['vercel/'+file]===newReceiptSha256['vercel/'+file],'forward-provider-receipts');
  require(/^dpl_[A-Za-z0-9]+$/u.test(outcome.deploymentId??'')&&forwardVercelFiles.every(file=>{
    const value=documents[file];return value.environment==='staging'&&value.projectId===record.candidate.workload.projectId&&value.sourceCommit===projection.sourceCommit&&value.releaseId===projection.originalReleaseId&&
      (file==='frontend-build-started.json'||value.deploymentId===outcome.deploymentId);
  })&&documents['frontend-build-outcome.json'].status==='FRONTEND_STAGED'&&documents['frontend-workload-outcome.json'].status==='FRONTEND_VERIFIED'&&
    documents['frontend-promotion-outcome.json'].status==='FRONTEND_DOMAINS_PROMOTED','forward-provider-chain');
  return newReceiptSha256;
}

export async function issueP2RecoveryForwardScope(session,context){
  const record=await forwardSession(session,context),action=record.action;
  require(action.frontendMode==='reviewed-new-build'&&['prior-build-failed','prior-build-canceled','retained-ready-probe-expired'].includes(action.forwardReason),'forward-mode');
  const projection={version:1,mode:'reviewed-new-build',recoveryActionId:action.recoveryActionId,originalReleaseId:action.originalReleaseId,
    candidateSha256:action.candidateSha256,sourceCommit:action.sourceCommit,targetSha256:record.plan.targetSha256,inventorySha256:action.inventorySha256,
    configurationSha256:action.configurationSha256,originalDirectory:context.originalDirectory,directory:context.directory,originalReceiptSha256:structuredClone(action.originalReceiptSha256)};
  const receipts=await forwardReceipts(projection,record),scope=Object.freeze({});
  forwardScopes.set(scope,{session,projection,receipts,environmentSignal:context.environmentSignal});return scope;
}

export async function readP2RecoveryForwardScope(scope,context){
  const selected=forwardScopes.get(scope);require(selected,'forward-brand');
  const record=await forwardSession(selected.session,context);
  require(context.directory===selected.projection.directory&&context.originalDirectory===selected.projection.originalDirectory&&context.environmentSignal===selected.environmentSignal,'forward-path-binding');
  require(isDeepStrictEqual(await forwardReceipts(selected.projection,record),selected.receipts),'forward-receipt-drift');
  return structuredClone(selected.projection);
}

async function verifyForwardRuntimeCredential(record,context,value){
  let runtime,lost=false;
  try{
    require(typeof value==='string'&&value.length>0&&value===(await context.getProviderContext()).frontendRuntimeDatabaseUrl&&
      (record.runtimeCredential===undefined||record.runtimeCredential===value),'runtime-credential');
    const target={...record.prepared.migration.job.target,user:record.prepared.migration.job.target.runtimeRole,approvedPendingTags:[]};
    runtime=new Client({...recoveryConnectionOptions(value,target),application_name:'lash-her-p2-recovery-runtime-credential',options:'-c default_transaction_read_only=on -c search_path=pg_catalog,public'});
    runtime.on('error',()=>{lost=true;});await runtime.connect();
    require(runtime.connection?.stream?.encrypted===true&&runtime.connection.stream.authorized===true,'runtime-credential');
    await runtime.query('BEGIN READ ONLY');
    const actual=(await runtime.query(`SELECT current_user AS username,pg_catalog.current_database() AS database,
      pg_catalog.current_setting('server_version_num')::int/10000 AS major,pg_catalog.current_setting('transaction_read_only') AS readonly,
      (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS role_oid,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid`)).rows[0];
    require(actual?.username===target.user&&actual.database===target.database&&actual.major===target.serverMajor&&actual.readonly==='on'&&
      actual.role_oid===record.receipt.runtime.oid&&actual.database_oid===record.physical.databaseOid,'runtime-credential');
    for(const key of [FRONTEND_MIGRATION_LOCK,record.physical.marker]){
      const held=await runtime.query(RECOVERY_HELD_LOCK.replace('pid=pg_backend_pid()','pid=$2'),[key,record.physical.pid]);
      require(held.rows[0]?.held===true,'runtime-physical-session');
    }
    await runtime.query('ROLLBACK');await record.verify();require(!lost,'runtime-credential');record.runtimeCredential=value;
  }catch{throw new Error('P2_RECOVERY_RUNTIME_CREDENTIAL_REFUSED');}
  finally{if(runtime)try{await runtime.end();require(!lost);}catch{throw new Error('P2_RECOVERY_RUNTIME_CREDENTIAL_CLEANUP_UNCERTAIN');}}
}

export async function verifyP2RecoveryForwardMutation(session,context,runtimeCredential){
  const record=await forwardSession(session,context);require(record.action.frontendMode==='reviewed-new-build','forward-session');
  const actual=await readRecoveryFrontendCurrent(record.client,record.prepared,record.action,record.verify);
  require(actual.admissionEpoch===record.receipt.admissionEpoch,'forward-admission-drift');await record.verify();
  await verifyForwardRuntimeCredential(record,context,runtimeCredential);
}

async function verifyRecoveryMemberships(client, runtimeOid, owner) {
  require(owner && /^[1-9][0-9]*$/u.test(owner.oid));
  const operator = (await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0];
  // The reviewed Neon target is a non-superuser provisioner. Its other admin
  // attributes (including replication/RLS powers) are provider policy, not the
  // restricted owner/runtime policy; do not invent static false requirements.
  require(operator?.rolcanlogin===true && operator.rolcreaterole===true && operator.rolsuper===false,'operator-role-policy');
  const rows = (await client.query(`SELECT m.roleid::text,m.member::text,m.grantor::text,m.admin_option,m.inherit_option,m.set_option,g.rolsuper AS grantor_super
    FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor WHERE m.roleid=ANY($1::oid[]) OR m.member=ANY($1::oid[])
    ORDER BY m.roleid,m.member,m.grantor`, [[owner.oid,runtimeOid]])).rows;
  // Exact frontend-role-preparation policy, bound to the authenticated original
  // operator. Only its explicit owner SET grant and PG16+ creator administration
  // survive. No selected role has an outbound membership or another member.
  const creators=rows.filter(row=>row.admin_option===true),ownerSet=rows.filter(row=>row.admin_option===false);
  require(rows.length===3 && creators.length===2 &&
    creators.every(row=>row.member===operator.oid && [owner.oid,runtimeOid].includes(row.roleid) && row.grantor_super===true && row.inherit_option===false && row.set_option===false) &&
    new Set(creators.map(row=>row.roleid)).size===creators.length && ownerSet.length===1 && ownerSet[0].roleid===owner.oid &&
    ownerSet[0].member===operator.oid && ownerSet[0].grantor===operator.oid && ownerSet[0].inherit_option===false && ownerSet[0].set_option===true,'role-memberships');
}

export async function verifyRecoveryRuntimeGrants(client, target, owner) {
  let checkpoint='runtime-role-flags';
  try {
  const roles = (await client.query(`SELECT oid::text,rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil,
    pg_has_role($1,$2,'MEMBER') AS migration_member,has_schema_privilege($1,'public','CREATE') AS ddl
    FROM pg_roles WHERE rolname=$1`, [target.runtimeRole, target.user])).rows;
  require(roles.length === 1 && roles[0].rolcanlogin === true && ['rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','migration_member','ddl'].every(key => roles[0][key] === false));
  require(roles[0].rolconfig===null && roles[0].rolconnlimit===-1 && roles[0].rolvaliduntil===null,'runtime-role-settings');
  checkpoint='role-memberships';await verifyRecoveryMemberships(client,roles[0].oid,owner);
  require((await client.query('SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=ANY($1::oid[]) LIMIT 1',[[owner.oid,roles[0].oid]])).rows.length===0,'selected-role-database-settings');
  checkpoint='runtime-ownership';require((await client.query(`SELECT 1 WHERE has_database_privilege($1,current_database(),'CREATE') OR
    EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1::regrole AND deptype='o') OR
    EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role($1,datdba,'MEMBER')) OR
    EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('public','drizzle','frontend_admission') AND pg_has_role($1,nspowner,'MEMBER')) OR
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND pg_has_role($1,relowner,'MEMBER'))`, [target.runtimeRole])).rows.length === 0);
  require((await client.query(`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
    AND nspname NOT IN ('public','frontend_admission') AND pg_catalog.has_schema_privilege($1,oid,'USAGE') LIMIT 1`,[target.runtimeRole])).rows.length===0,'runtime-schema-access');
  checkpoint='runtime-table-dml';require((await client.query(`SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND
    EXISTS(SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE NOT has_table_privilege($1,c.oid,p))`, [target.runtimeRole])).rows.length === 0);
  checkpoint='runtime-sequence-dml';require((await client.query(`SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND
    EXISTS(SELECT 1 FROM unnest(ARRAY['SELECT','USAGE']) p WHERE NOT has_sequence_privilege($1,c.oid,p))`, [target.runtimeRole])).rows.length === 0);
  require((await client.query("SELECT has_schema_privilege($1,'drizzle','USAGE') AS journal_access", [target.runtimeRole])).rows[0]?.journal_access === false);
  checkpoint='runtime-extra-privileges';require((await client.query(`SELECT 1 FROM pg_auth_members WHERE member=$1::oid UNION ALL
    SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND
      (EXISTS(SELECT 1 FROM unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege($2,c.oid,p)) OR
       EXISTS(SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege($2,c.oid,p||' WITH GRANT OPTION')) OR
       CASE WHEN current_setting('server_version_num')::int>=170000 THEN has_table_privilege($2,c.oid,'MAINTAIN') ELSE false END) UNION ALL
    SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND
      (has_sequence_privilege($2,c.oid,'UPDATE') OR EXISTS(SELECT 1 FROM unnest(ARRAY['SELECT','USAGE','UPDATE']) p WHERE has_sequence_privilege($2,c.oid,p||' WITH GRANT OPTION')))`, [roles[0].oid,target.runtimeRole])).rows.length===0);
  checkpoint='runtime-default-grants';const defaults = (await client.query(`SELECT d.defaclobjtype AS kind,n.nspname AS schema,a.grantee::text,a.grantor::text,a.privilege_type AS privilege,a.is_grantable FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=session_user::regrole
    ORDER BY kind,privilege,grantee`, [])).rows;
  const operatorOid=(await client.query('SELECT session_user::regrole::oid::text AS oid')).rows[0].oid;
  require(defaults.length===6 && defaults.every(row=>row.schema==='public' && row.grantee===roles[0].oid && row.grantor===operatorOid && !row.is_grantable) &&
    isDeepStrictEqual(defaults.map(row=>row.kind+':'+row.privilege).sort(),['r:SELECT','r:INSERT','r:UPDATE','r:DELETE','S:SELECT','S:USAGE'].sort()));
  require((await client.query(`SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole<>session_user::regrole AND a.grantee=ANY($1::oid[])`, [[owner.oid,roles[0].oid]])).rows.length===0);
  checkpoint='selected-direct-acl';const directAcl=(await client.query(`WITH entries AS (
    SELECT 'database' AS kind,d.datname AS scope,d.datdba::text AS owner,a.* FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
    UNION ALL SELECT 'schema',n.nspname,n.nspowner::text,a.* FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
    UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END,n.nspname,c.relowner::text,a.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
    UNION ALL SELECT 'column',n.nspname,c.relowner::text,a.* FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(t.attacl) a
    UNION ALL SELECT 'routine',n.nspname,p.proowner::text,a.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
    UNION ALL SELECT 'type',n.nspname,t.typowner::text,a.* FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace CROSS JOIN LATERAL aclexplode(t.typacl) a
  ) SELECT kind,scope,owner,grantee::text,privilege_type,is_grantable FROM entries WHERE grantee=ANY($1::oid[])`, [[owner.oid,roles[0].oid]])).rows;
  require(directAcl.every(row=>!row.is_grantable && (row.grantee===owner.oid ?
    row.kind==='database' ? row.scope===target.database && row.privilege_type==='CREATE' :
      row.scope==='frontend_admission' && row.owner===owner.oid && ['schema','table','sequence','routine'].includes(row.kind) :
    row.kind==='database' ? row.scope===target.database && row.privilege_type==='CONNECT' :
      row.kind==='schema' ? ['public','frontend_admission'].includes(row.scope) && row.privilege_type==='USAGE' :
        row.scope==='frontend_admission' ? row.kind==='routine' && row.privilege_type==='EXECUTE' :
          row.scope==='public' && (row.kind==='table' ? ['SELECT','INSERT','UPDATE','DELETE'].includes(row.privilege_type) :
            row.kind==='sequence' && ['SELECT','USAGE'].includes(row.privilege_type)))));
  require((await client.query(`SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[]) AND deptype IN ('a','i')
    AND ((dbid<>0 AND dbid<>(SELECT oid FROM pg_database WHERE datname=current_database())) OR
      classid NOT IN ('pg_database'::regclass,'pg_namespace'::regclass,'pg_class'::regclass,'pg_proc'::regclass,'pg_default_acl'::regclass)) LIMIT 1`, [[owner.oid,roles[0].oid]])).rows.length===0);
  checkpoint='runtime-admission-privileges';const admission = (await client.query(`SELECT has_schema_privilege($1,'frontend_admission','USAGE') AS usage,
    has_schema_privilege($1,'frontend_admission','CREATE') AS ddl,
    EXISTS(SELECT 1 FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE c.relnamespace='frontend_admission'::regnamespace AND c.relkind='r' AND has_table_privilege($1,c.oid,p)) AS direct_tables`, [target.runtimeRole])).rows[0];
  require(admission?.usage === true && admission.ddl === false && admission.direct_tables === false);
  checkpoint='runtime-admission-functions';const functions = (await client.query(`SELECT p.proname,p.prokind,p.prosrc,p.proowner::text AS owner,p.prosecdef,p.proconfig,
    has_function_privilege($1,p.oid,'EXECUTE') AS executable FROM pg_proc p WHERE p.pronamespace='frontend_admission'::regnamespace ORDER BY p.proname`, [target.runtimeRole])).rows;
  require(owner && functions.length === 5 && functions.map(row => row.proname).join(',') === 'admit,begin_operation,current_policy,finish_operation,settle','admission-function-identities');
  require(functions.every(row => row.owner === owner.oid),'admission-function-owners');
  require(functions.every(row => row.executable === true),'admission-function-execution-grants');
  require(functions.every(row => row.prokind === 'p' ? row.prosecdef === false && row.proconfig === null :
    row.prosecdef === true && row.proconfig?.includes('search_path=pg_catalog, frontend_admission')),'admission-function-security');
  require(functions.every(row => createHash('sha256').update(row.prosrc).digest('hex') === expectedRoutineBodies[row.proname]),'admission-function-source');
  return { name: roles[0].rolname, oid: roles[0].oid };
  } catch(error) { error.checkpoint ??= checkpoint; throw error; }
}

export async function readRecoveryFrontendCurrent(client, prepared, action, verifySession) {
  const { migration, plan } = prepared, { target } = migration.job;
  require(name(plan.owner.name)); await verifySession();
  await client.query('BEGIN READ ONLY');
  let phase='current-lineage';
  try {
    require((await client.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only === 'on');
    const after = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
    require(after.length === migration.artifact.migrations.length && assertAppliedMigrationLineage(migration.artifact.expected, after) === migration.artifact.migrations.at(-1).folderMillis);
    phase='schema-catalog';require(isDeepStrictEqual(await readMigrationCatalog(client), migration.baseline.catalog));
    phase='runtime-grants';const runtime = await verifyRecoveryRuntimeGrants(client, target, plan.owner);
    require(plan.producers.some(producer => producer.role.name === runtime.name && producer.role.oid === runtime.oid));
    phase='retired-logins-and-sessions';const retired = plan.historicalLogins.retiredLogins;
    const old = (await client.query('SELECT oid::text,rolname,rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [retired.map(row => row.name)])).rows;
    require(old.length === retired.length && old.every(row => !row.rolcanlogin && retired.some(expected => expected.name === row.rolname && expected.oid === row.oid)));
    await client.query('SELECT pg_stat_clear_snapshot()');
    require((await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usesysid=ANY($1::oid[])', [retired.map(row => row.oid)])).rows[0]?.count === 0);
    phase='admission-owner';const owners = (await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_roles WHERE rolname=$1', [plan.owner.name])).rows;
    require(owners.length === 1 && owners[0].oid === plan.owner.oid && owners[0].rolconfig===null && owners[0].rolconnlimit===-1 && owners[0].rolvaliduntil===null && ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key => owners[0][key] === false));
    await client.query(`SET LOCAL ROLE "${plan.owner.name}"`);
    require((await client.query("SELECT nspowner::text AS oid FROM pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid === plan.owner.oid);
    phase='admission-ledger';const controls = (await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows;
    require(controls.length === 1 && controls[0].environment === 'staging' && controls[0].target_sha256 === plan.targetSha256 && controls[0].new_work === false && controls[0].recovery === false);
    require((await client.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state<>'completed'")).rows[0]?.count === 0);
    const producers = (await client.query('SELECT producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256')).rows;
    require(producers.length === plan.producers.length && producers.every((row, i) => row.producer_sha256 === plan.producers[i].producerSha256 && row.source_sha === plan.sourceCommit && row.role_oid === plan.producers[i].role.oid));
    return { version: 1, status: 'P2_RECOVERY_DATABASE_CURRENT', migrationMode: 'recovery-current-only', service: 'frontend', environment: 'staging',
      releaseId: migration.job.releaseId, recoveryActionId: action.recoveryActionId, sourceCommit: migration.job.sourceCommit,
      candidateSha256: action.candidateSha256, originalReceiptSha256: action.originalReceiptSha256,
      ...Object.fromEntries(['migrationImageDigest','sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256','contractPhase','phase2ContractManifestSha256'].map(key => [key,migration.job[key]])),
      target: Object.fromEntries(['host','port','database','user','serverMajor'].map(key => [key,target[key]])), after,
      journalSha256: hash(after), schemaVerified: true, runtimeRoleVerified: true, owner: plan.owner, runtime, admissionEpoch: controls[0].epoch,
      oldLoginsDenied: true, oldRoleSessions: 0, retiredLogins: structuredClone(retired), producers: structuredClone(plan.producers), sqlReplayed: false, originalFrontendTerminalRecreated: false, trafficAuthorized: false };
  } catch(error) { error.checkpoint ??= phase; throw error; } finally { await client.query('ROLLBACK'); }
}

export async function withRecoveryFrontendSession(prepared, action, dependencies, task) {
  const target = prepared.migration.job.target;
  const client = (dependencies.createClient ?? (options => new Client(options)))({ ...recoveryConnectionOptions(await dependencies.getUrl(), target),application_name: RECOVERY_LOCK_APPLICATION });
  let lost = false, locked = false, identity,session;
  client.on('error', () => { lost = true; });
  const verify = async () => {
    await dependencies.verifyEnvironment(); require(!lost && client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    const actual = (await client.query('SELECT pg_backend_pid() AS pid,current_user AS username,current_database() AS database,current_setting(\'server_version_num\')::int/10000 AS major,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid')).rows[0];
    require(actual.username === target.user && actual.database === target.database && actual.major === target.serverMajor && (!identity || actual.pid === identity.pid)); identity = actual;
    if (locked) require((await client.query(RECOVERY_HELD_LOCK, [FRONTEND_MIGRATION_LOCK])).rows[0]?.held === true);
    require(!lost);
  };
  try {
    await client.connect(); await verify();
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [FRONTEND_MIGRATION_LOCK])).rows[0]?.locked === true; require(locked);
    const marker = randomBytes(32).toString('hex'); await client.query('SELECT pg_advisory_lock(hashtext($1))', [marker]);
    const backendStart = (await client.query('SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0]?.backend_start; require(typeof backendStart === 'string');
    const receipt = await readRecoveryFrontendCurrent(client, prepared, action, verify);
    session=Object.freeze({});recoverySessions.set(session,{client,verify,prepared,action:structuredClone(action),receipt:structuredClone(receipt),candidate:structuredClone(prepared.migration.candidate),plan:structuredClone(prepared.plan),physical:{pid:identity.pid,databaseOid:identity.database_oid,marker}});
    const result = await task({ client, verify, receipt,session, probe: { version: 1, marker, backendPid: identity.pid, backendStart, applicationName: RECOVERY_LOCK_APPLICATION,
      job: prepared.migration.job, baseline: prepared.migration.baseline, targetSha256: prepared.plan.targetSha256, owner: prepared.plan.owner, receipt } });
    await verify(); return result;
  } catch(error) { const safe=new Error('P2_RECOVERY_FRONTEND_SESSION_FAILED_REQUIRES_REVIEW');if(/^[a-z-]{1,60}$/u.test(error?.checkpoint??''))safe.checkpoint=error.checkpoint;throw safe; }
  finally {
    if(session)recoverySessions.delete(session);
    try { if (locked) await client.query('SELECT pg_advisory_unlock_all()'); } catch { lost = true; }
    try { await client.end(); } catch { lost = true; }
    if (lost) throw new Error('P2_RECOVERY_FRONTEND_CLEANUP_UNCERTAIN');
  }
}

// Image-side independent observer of the *new* physical recovery session.
export async function observeRecoveryPhysical(input, { getUrl, createClient = options => new Client(options) }) {
  require(input?.version === 1 && ['observe','verify-schema','fence'].includes(input.operation) && /^[a-f0-9]{64}$/u.test(input.marker ?? '') &&
    Number.isSafeInteger(input.backendPid) && typeof input.backendStart === 'string' && input.job?.environment === 'staging' &&
    input.receipt?.status === 'P2_RECOVERY_DATABASE_CURRENT' && input.receipt.sourceCommit === input.job.sourceCommit &&
    input.receipt.sqlArtifactSha256 === input.job.sqlArtifactSha256 && name(input.owner?.name));
  const client = createClient(recoveryConnectionOptions(await getUrl(), input.job.target));
  let lost = false, admission; client.on('error', () => { lost = true; });
  try {
    await client.connect(); require(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    const identity = (await client.query("SELECT current_user AS username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major")).rows[0];
    require(identity.username === input.job.target.user && identity.database === input.job.target.database && identity.major === input.job.target.serverMajor);
    const owner = (await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_roles WHERE rolname=$1', [input.owner.name])).rows;
    require(owner.length === 1 && owner[0].oid === input.owner.oid && owner[0].rolconfig===null && owner[0].rolconnlimit===-1 && owner[0].rolvaliduntil===null && ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key => owner[0][key] === false));
    if (input.operation === 'fence') {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE "${input.owner.name}"`);
        const control = (await client.query('SELECT environment,target_sha256 FROM frontend_admission.control WHERE singleton FOR UPDATE')).rows;
        require(control.length === 1 && control[0].environment === 'staging' && control[0].target_sha256 === input.targetSha256);
        await client.query('UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND (new_work OR recovery)');
        const after = (await client.query('SELECT new_work,recovery FROM frontend_admission.control WHERE singleton')).rows[0]; require(after?.new_work === false && after.recovery === false);
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK'); throw new Error('P2_RECOVERY_FENCE_UNCERTAIN'); }
      return { status: 'P2_FRONTEND_ADMISSION_CLOSED', targetSha256: input.targetSha256 };
    }
    await client.query('BEGIN READ ONLY');
    try {
      const original = (await client.query('SELECT backend_start::text,usename,datname,application_name FROM pg_stat_activity WHERE pid=$1', [input.backendPid])).rows;
      require(original.length === 1 && original[0].backend_start === input.backendStart && original[0].usename === input.job.target.user && original[0].datname === input.job.target.database && original[0].application_name === RECOVERY_LOCK_APPLICATION);
      for (const lock of [FRONTEND_MIGRATION_LOCK,input.marker]) {
        const actual = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=((hashtext($2)::bigint>>32)&4294967295)::oid AND objid=(hashtext($2)::bigint&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`, [input.backendPid,lock])).rows[0]; require(actual?.held === true);
      }
      const journal = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
      require(isDeepStrictEqual(journal,input.receipt.after));
      if (input.operation === 'verify-schema') require(isDeepStrictEqual(await readMigrationCatalog(client), input.baseline.catalog));
      const runtime = await verifyRecoveryRuntimeGrants(client,input.job.target,input.owner); require(isDeepStrictEqual(runtime,input.receipt.runtime));
      const retired = input.receipt.retiredLogins; require(Array.isArray(retired));
      const old = (await client.query('SELECT oid::text,rolname,rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[retired.map(row=>row.name)])).rows;
      require(old.length===retired.length&&old.every(row=>row.rolcanlogin===false&&retired.some(expected=>expected.name===row.rolname&&expected.oid===row.oid)));
      await client.query('SELECT pg_stat_clear_snapshot()');
      require((await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usesysid=ANY($1::oid[])',[retired.map(row=>row.oid)])).rows[0]?.count===0);
      await client.query(`SET LOCAL ROLE "${input.owner.name}"`);
      const controls = (await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows;
      require(controls.length === 1 && controls[0].environment === 'staging' && controls[0].target_sha256 === input.targetSha256);
      const counts = (await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
      admission = { epoch: controls[0].epoch, newWork: controls[0].new_work, recovery: controls[0].recovery, ...counts };
    } finally { await client.query('ROLLBACK'); }
    require(!lost); return { status: 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED', marker: input.marker, backendPid: input.backendPid, sourceCommit: input.job.sourceCommit, recoveryActionId: input.receipt.recoveryActionId, admission };
  } finally { await client.end(); require(!lost); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const bytes = readFileSync(0); require(bytes.length > 0 && bytes.length <= 2_000_000);
    console.log(JSON.stringify(await observeRecoveryPhysical(JSON.parse(bytes), { getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL })));
  } catch { console.error('P2_RECOVERY_PHYSICAL_OBSERVATION_REFUSED'); process.exitCode = 1; }
}
