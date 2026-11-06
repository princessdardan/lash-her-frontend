// Observation-only virgin-target collector. No role, admission, migration,
// provider, deployment or first-use authority is constructed by this module.
import {createHash,randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Client} from 'pg';
import {FRONTEND_MIGRATION_LOCK} from './frontend-migration.mjs';

const states=new WeakMap(),issuer=Symbol('observation');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codes=new Set(['P2Q_FIRST_INSTALL_REQUEST_REFUSED','P2Q_FIRST_INSTALL_PROFILE_REGISTRY_REQUIRED','P2Q_FIRST_INSTALL_SOURCE_BINDING_REQUIRED','P2Q_FIRST_INSTALL_EMPTY_JOB_REQUIRED','P2Q_FIRST_INSTALL_OBSERVATION_HANDLE_REQUIRED','P2Q_FIRST_INSTALL_TLS_TARGET_REQUIRED','P2Q_FIRST_INSTALL_OBSERVATION_CLOSED','P2Q_FIRST_INSTALL_PHYSICAL_SESSION_CHANGED','P2Q_FIRST_INSTALL_PHYSICAL_LOCK_LOST','P2Q_FIRST_INSTALL_PHYSICAL_SESSION_LOST','P2Q_FIRST_INSTALL_READ_ONLY_REQUIRED','P2Q_FIRST_INSTALL_CATALOG_OBSERVATION_REQUIRED','P2Q_FIRST_INSTALL_UNEXPECTED_DATABASE_SESSION','P2Q_FIRST_INSTALL_NONEMPTY_DATABASE','P2Q_FIRST_INSTALL_ROLE_CATALOG_BOUND','P2Q_FIRST_INSTALL_DATABASE_OBSERVATION_DRIFT','P2Q_FIRST_INSTALL_PARENT_SESSION_REQUIRED','P2Q_FIRST_INSTALL_DATABASE_IDENTITY_REQUIRED','P2Q_FIRST_INSTALL_PARENT_LOCK_REQUIRED','P2Q_FIRST_INSTALL_NONCE_LOCK_REQUIRED','P2Q_FIRST_INSTALL_NONCE_RELEASE_UNVERIFIED']);
const fail=code=>{const error=new Error(code);error.code=code;return error;};
const require=(value,code)=>{if(!value)throw fail(code);};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
const oid=value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/u.test(value);
const heldLock=`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
 AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
 AND classid=((pg_catalog.hashtext($1)::bigint >> 32) & 4294967295)::oid AND objid=(pg_catalog.hashtext($1)::bigint & 4294967295)::oid
 AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`;
const identitySql=`SELECT pg_catalog.pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,
 pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
 (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=session_user) AS role_oid,
 (SELECT backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()) AS backend_start`;
const emptySql=`SELECT
 (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) AS schemas,
 (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS relations,
 (SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS functions,
 (SELECT count(*)::int FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS types,
 (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname<>'plpgsql') AS additional_extensions,
 (SELECT count(*)::int FROM pg_catalog.pg_foreign_server) AS foreign_servers,
 (SELECT count(*)::int FROM pg_catalog.pg_user_mapping) AS user_mappings,
 (SELECT count(*)::int FROM pg_catalog.pg_publication) AS publications,
 (SELECT count(*)::int FROM pg_catalog.pg_subscription WHERE subdbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())) AS subscriptions,
 (SELECT count(*)::int FROM pg_catalog.pg_largeobject_metadata) AS large_objects,
 (SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND backend_type='client backend' AND pid<>pg_catalog.pg_backend_pid()) AS other_sessions`;
const rolesSql=`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolconnlimit,
 rolconfig IS NOT NULL AS has_settings FROM pg_catalog.pg_roles ORDER BY rolname LIMIT 4097`;

export async function prepareP2qFirstInstallObservation(request){
 require(exact(request,['qualificationTargetProfile','candidate','job','actionId'])&&typeof request.actionId==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.actionId),'P2Q_FIRST_INSTALL_REQUEST_REFUSED');
 let registry;try{registry=await import('./qualification-target-profile.mjs');}catch{throw fail('P2Q_FIRST_INSTALL_PROFILE_REGISTRY_REQUIRED');}
 const ref=registry.requireQualificationTargetProfile(request.qualificationTargetProfile,request.candidate,request.job);
 const profile=registry.resolveQualificationTargetProfile(ref);
 require(profile.kind==='isolated-allocated'&&profile.selectionPolicy==='isolated-allocated-v1'&&profile.environment==='staging','QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED');
 const {candidate,job}=request,target=job.target;
 require(candidate&&Object.getPrototypeOf(candidate)===Object.prototype&&job&&Object.getPrototypeOf(job)===Object.prototype&&
  typeof candidate.releaseId==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(candidate.releaseId)&&candidate.version===3&&candidate.environment==='staging'&&candidate.contractPhase==='p2'&&job.version===2&&job.environment==='staging'&&
  job.releaseId===candidate.releaseId&&job.sourceCommit===candidate.sources?.frontend?.commit&&/^[a-f0-9]{40}$/u.test(job.sourceCommit)&&
  job.contractPhase==='p2'&&job.phase2ContractManifestSha256===candidate.phase2ContractManifestSha256&&/^sha256:[a-f0-9]{64}$/u.test(job.phase2ContractManifestSha256),
 'P2Q_FIRST_INSTALL_SOURCE_BINDING_REQUIRED');
 require(target&&typeof target.host==='string'&&/^[a-z0-9.-]+$/u.test(target.host)&&!/pooler|pgbouncer/u.test(target.host)&&
  Number.isInteger(target.port)&&target.port>0&&target.port<65536&&[16,18].includes(target.serverMajor)&&
  ['database','user','runtimeRole'].every(key=>/^[a-z][a-z0-9_]{0,62}$/u.test(target[key]??''))&&target.user!==target.runtimeRole&&
  target.allowEmptyBootstrap===true&&Array.isArray(target.approvedPendingTags)&&target.approvedPendingTags.length>0&&
  target.approvedPendingTags.every(tag=>/^\d{4}_[a-z0-9_]+$/u.test(tag))&&new Set(target.approvedPendingTags).size===target.approvedPendingTags.length,
 'P2Q_FIRST_INSTALL_EMPTY_JOB_REQUIRED');
 return Object.freeze({version:1,service:'frontend',qualificationTargetProfile:structuredClone(ref),actionId:request.actionId,releaseId:candidate.releaseId,sourceCommit:job.sourceCommit,
  target:Object.freeze(Object.fromEntries(['host','port','database','user','serverMajor'].map(key=>[key,target[key]]))),
  observationOnly:true,firstUseAuthorized:false,migrationAuthorized:false,rolePreparationAuthorized:false});
}

class DatabaseObservation {constructor(token){require(token===issuer,'P2Q_FIRST_INSTALL_OBSERVATION_HANDLE_REQUIRED');Object.freeze(this);}}
function transport(client,target){
 require(client instanceof Client&&client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true&&
  client.connectionParameters?.host===target.host&&Number(client.connectionParameters.port)===target.port&&client.connectionParameters.database===target.database&&
  client.connectionParameters.user===target.user,'P2Q_FIRST_INSTALL_TLS_TARGET_REQUIRED');
}
async function verify(state){
 require(state.active&&!state.lost,'P2Q_FIRST_INSTALL_OBSERVATION_CLOSED');await state.verifyParent();transport(state.client,state.plan.target);
 const identity=(await state.client.query(identitySql)).rows[0];
 require(isDeepStrictEqual(identity,state.identity),'P2Q_FIRST_INSTALL_PHYSICAL_SESSION_CHANGED');
 for(const key of [FRONTEND_MIGRATION_LOCK,state.marker])require((await state.client.query(heldLock,[key])).rows[0]?.held===true,'P2Q_FIRST_INSTALL_PHYSICAL_LOCK_LOST');
 await state.verifyParent();require(!state.lost,'P2Q_FIRST_INSTALL_PHYSICAL_SESSION_LOST');
}
async function snapshot(state){
 await verify(state);let transaction=false;
 try{
  await state.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
  require((await state.client.query("SELECT pg_catalog.current_setting('transaction_read_only') AS read_only")).rows[0]?.read_only==='on','P2Q_FIRST_INSTALL_READ_ONLY_REQUIRED');
  const counts=(await state.client.query(emptySql)).rows[0],roles=(await state.client.query(rolesSql)).rows;
  require(counts&&Object.values(counts).every(value=>Number.isInteger(value)&&value>=0),'P2Q_FIRST_INSTALL_CATALOG_OBSERVATION_REQUIRED');
  require(counts.other_sessions===0,'P2Q_FIRST_INSTALL_UNEXPECTED_DATABASE_SESSION');
  require(Object.values(counts).every(value=>value===0),'P2Q_FIRST_INSTALL_NONEMPTY_DATABASE');
  require(roles.length>0&&roles.length<=4096&&roles.every(row=>oid(row.oid)),'P2Q_FIRST_INSTALL_ROLE_CATALOG_BOUND');
  await state.client.query('ROLLBACK');transaction=false;await verify(state);
  return {counts,roleCatalogSha256:digest(roles),roleCount:roles.length};
 }finally{if(transaction)try{await state.client.query('ROLLBACK');}catch{state.lost=true;}}
}
export async function readP2qFirstInstallDatabaseObservation(handle){
 const state=states.get(handle);require(state?.active,'P2Q_FIRST_INSTALL_OBSERVATION_HANDLE_REQUIRED');
 const actual=await snapshot(state);require(isDeepStrictEqual(actual,state.before),'P2Q_FIRST_INSTALL_DATABASE_OBSERVATION_DRIFT');
 return structuredClone({...state.plan,status:'P2Q_FIRST_INSTALL_DATABASE_OBSERVED_EMPTY',identity:state.identity,...actual,
  creationControlProven:false,credentialDeliveryHistoryProven:false,providerBeforeUseProven:false,hostControlProven:false,targetSelectionVerified:false});
}
export async function withP2qFirstInstallDatabaseObservation(request,{client,verifySession},task){
 const plan=await prepareP2qFirstInstallObservation(request);
 require(typeof verifySession==='function'&&typeof task==='function','P2Q_FIRST_INSTALL_PARENT_SESSION_REQUIRED');transport(client,plan.target);
 await verifySession();const identity=(await client.query(identitySql)).rows[0];
 require(identity?.username===plan.target.user&&identity.session_username===plan.target.user&&identity.database===plan.target.database&&identity.major===plan.target.serverMajor&&
  Number.isInteger(identity.pid)&&identity.pid>0&&oid(identity.role_oid)&&oid(identity.database_oid)&&typeof identity.backend_start==='string','P2Q_FIRST_INSTALL_DATABASE_IDENTITY_REQUIRED');
 require((await client.query(heldLock,[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true,'P2Q_FIRST_INSTALL_PARENT_LOCK_REQUIRED');
 const state={client,plan,identity,marker:'lash-her:p2q-first-install:'+randomBytes(32).toString('hex'),active:true,lost:false,verifyParent:verifySession};
 const lost=()=>{state.lost=true;};client.on('error',lost);let marked=false;
 try{
  marked=(await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS locked',[state.marker])).rows[0]?.locked===true;
  require(marked,'P2Q_FIRST_INSTALL_NONCE_LOCK_REQUIRED');state.before=await snapshot(state);
  const handle=new DatabaseObservation(issuer);states.set(handle,state);
  const value=await task(handle,()=>readP2qFirstInstallDatabaseObservation(handle));
  const observation=await readP2qFirstInstallDatabaseObservation(handle);return {observation,value};
 }catch(error){throw fail(codes.has(error?.code)?error.code:'P2Q_FIRST_INSTALL_DATABASE_OBSERVATION_REFUSED');}
 finally{
  state.active=false;client.removeListener('error',lost);
  if(marked&&!state.lost)try{require((await client.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS unlocked',[state.marker])).rows[0]?.unlocked===true,'P2Q_FIRST_INSTALL_NONCE_RELEASE_UNVERIFIED');}catch{state.lost=true;}
  if(state.lost)throw fail('P2Q_FIRST_INSTALL_PHYSICAL_SESSION_LOST');
 }
}
