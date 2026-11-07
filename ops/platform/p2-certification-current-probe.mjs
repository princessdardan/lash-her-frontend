// Fixed bounded certification policy. Generic recovery remains closed/drained.
import {Client} from 'pg';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {frontendConnectionOptions,FRONTEND_MIGRATION_LOCK} from './frontend-migration.mjs';
import {readMigrationCatalog} from './frontend-schema.mjs';
import {assertAppliedMigrationLineage} from '../../src/lib/private-db/migration-lineage.ts';
import {verifyRecoveryRuntimeGrants,RECOVERY_HELD_LOCK} from './p2-recovery-current-probe.mjs';
import {decodeQualificationTargetJson,requireQualificationTargetProfile,STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile} from './qualification-target-profile.mjs';

const demand=(ok,checkpoint)=>{if(!ok){const error=new Error('P2_CERTIFICATION_CURRENT_REFUSED');if(checkpoint)error.checkpoint=checkpoint;throw error;}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targetHash=target=>hash({environment:'staging',...Object.fromEntries(['host','port','database','user','serverMajor'].map(key=>[key,target[key]]))});
const canonical=value=>JSON.stringify(value,(_key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))):child);
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,62}$/u.test(value);
const bodies={admit:'e8efe70da1fabe4381d640e73bc42b5e204ec5f1aa28589d09b1e73a0be21504',begin_operation:'c634f0f3f018062fb2b115f923ab8637f02a34c515e8532b41ccd912762917d3',current_policy:'1322b30139dcb101aafcbd461536c1788233da1f0ab6e9084745513a4da1694e',finish_operation:'84257c2f6b8be184397e3d326d9908f11a6e9d75facde5c7abb5bad2e9db4e1d',settle:'a6fb927fbc0df4d7262aba5c6185ebffa737d1adafcf5766080078e0d0f45fbd'};
const options=(value,target)=>({...frontendConnectionOptions(value,target),options:'-c search_path=pg_catalog,public',application_name:'lash-her-p2-bounded-certification'});

function profileFields(expectedProfile,plan,job,historicalLogins){
  const carriers=[plan,plan?.nativePlan,plan?.nativePlan?.target,job,job?.target,historicalLogins,historicalLogins?.target];
  if(expectedProfile===undefined){
    demand(plan?.version===1&&job?.version===1&&!carriers.some(row=>row&&Object.hasOwn(row,'qualificationTargetProfile')));
    return {};
  }
  const qualificationTargetProfile=requireQualificationTargetProfile(currentProfile,{qualificationTargetProfile:expectedProfile},...carriers);
  demand(plan.version===2&&plan.nativePlan.version===2&&job.version===2&&historicalLogins.version===2&&
    plan.startState==='already-closed'&&Array.isArray(job.target.approvedPendingTags)&&job.target.approvedPendingTags.length===0);
  return {qualificationTargetProfile};
}

function admissionPolicy(plan,value,initial){
  demand(['auth-preparation','browser-pending','direct-worker','native-window','fault-before-upstream','fault-drop-after-ack','known-ack-recovery','contain-native'].includes(plan.mode)&&
    ['qualified-ready','already-closed'].includes(plan.startState)&&/^[1-9][0-9]{0,17}$/u.test(plan.initialEpoch)&&/^[1-9][0-9]{0,17}$/u.test(value.epoch)&&
    typeof value.newWork==='boolean'&&typeof value.recovery==='boolean'&&
    Number.isInteger(value.active)&&value.active>=0&&Number.isInteger(value.uncertain)&&value.uncertain>=0);
  if(plan.mode==='contain-native')return;
  const closedOffset=plan.startState==='qualified-ready'?1n:0n,delta=BigInt(value.epoch)-BigInt(plan.initialEpoch);
  if(['auth-preparation','browser-pending'].includes(plan.mode)){
    demand(delta>=0n&&delta<=2n&&value.uncertain===0&&value.newWork===(delta===1n||delta===0n&&closedOffset===1n)&&value.recovery===(delta===0n&&closedOffset===1n));
    if(initial)demand(delta===0n&&(closedOffset===1n||value.active===0));return;
  }
  if(plan.mode==='direct-worker'){
    demand(plan.startState==='already-closed'&&plan.nativePlan.initialEpoch===(BigInt(plan.initialEpoch)+1n).toString()&&
      delta>=0n&&delta<=2n&&value.newWork===false&&value.recovery===(delta===1n)&&value.uncertain===0);
    if(initial)demand(delta===0n&&value.active===0);return;
  }
  demand(plan.nativePlan.initialEpoch===(BigInt(plan.initialEpoch)+closedOffset+1n).toString());
  if(initial)demand(delta===0n&&value.newWork===(closedOffset===1n)&&value.recovery===(closedOffset===1n)&&value.uncertain===0&&(closedOffset===1n||value.active===0));
  else{
    demand(delta>=0n&&delta<=closedOffset+3n&&value.newWork===(closedOffset===1n&&delta===0n)&&
      value.recovery===(closedOffset===1n&&delta===0n||delta===closedOffset+1n||delta===closedOffset+2n));
    demand(['fault-drop-after-ack','known-ack-recovery'].includes(plan.mode)?value.uncertain<=1:value.uncertain===0);
  }
}

export async function readP2CertificationCurrent(client,prepared,plan,verify,initial=false,expectedProfile){
  const {job,artifact,baseline}=prepared.migration,target=job.target,owner=prepared.plan.owner;
  const selectedProfile=profileFields(expectedProfile,plan,job,prepared.plan.historicalLogins);
  demand(name(owner.name)&&plan.sourceCommit===job.sourceCommit&&plan.targetSha256===prepared.plan.targetSha256&&plan.targetSha256===targetHash(target)&&
    artifact.sqlArtifactSha256===job.sqlArtifactSha256&&artifact.contractManifestSha256===job.contractManifestSha256,'current-target');await verify();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let checkpoint='current-transaction';
  try{
    demand((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only==='on');
    checkpoint='current-lineage-schema';const after=(await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
    demand(after.length===artifact.migrations.length&&assertAppliedMigrationLineage(artifact.expected,after)===artifact.migrations.at(-1).folderMillis&&
      isDeepStrictEqual(await readMigrationCatalog(client),baseline.catalog));
    checkpoint='current-runtime';const runtime=await verifyRecoveryRuntimeGrants(client,target,owner);
    demand(prepared.plan.producers.some(row=>row.role.name===runtime.name&&row.role.oid===runtime.oid));
    checkpoint='current-owner';const owners=(await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname=$1',[owner.name])).rows;
    demand(owners.length===1&&owners[0].oid===owner.oid&&owners[0].rolconfig===null&&owners[0].rolconnlimit===-1&&owners[0].rolvaliduntil===null&&
      ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key=>owners[0][key]===false));
    checkpoint='current-retired';const retired=prepared.plan.historicalLogins.retiredLogins;
    const logins=(await client.query('SELECT oid::text,rolname,rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[retired.map(row=>row.name)])).rows;
    demand(logins.length===retired.length&&logins.every(row=>row.rolcanlogin===false&&retired.some(expected=>expected.oid===row.oid&&expected.name===row.rolname)));
    await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
    demand((await client.query('SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE usesysid=ANY($1::oid[])',[retired.map(row=>row.oid)])).rows[0].count===0);
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    demand((await client.query("SELECT nspowner::text AS oid FROM pg_catalog.pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid===owner.oid);
    checkpoint='current-admission-routines';const routines=(await client.query(`SELECT p.proname,p.prosecdef,p.proowner::text AS owner,p.proconfig,p.prosrc,p.prokind,
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc p WHERE p.pronamespace='frontend_admission'::regnamespace ORDER BY p.proname`)).rows;
    demand(routines.length===5&&routines.every(row=>bodies[row.proname]===createHash('sha256').update(row.prosrc).digest('hex')&&row.owner===owner.oid&&row.public_execute===false&&
      (['begin_operation','finish_operation'].includes(row.proname)?row.prokind==='p'&&!row.prosecdef&&row.proconfig===null:row.prokind==='f'&&row.prosecdef&&isDeepStrictEqual(row.proconfig,['search_path=pg_catalog, frontend_admission']))));
    checkpoint='current-producers';const producers=(await client.query('SELECT producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256')).rows;
    demand(producers.length===prepared.plan.producers.length&&producers.every((row,index)=>row.producer_sha256===prepared.plan.producers[index].producerSha256&&row.source_sha===job.sourceCommit&&row.role_oid===prepared.plan.producers[index].role.oid));
    const controls=(await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows;
    const counts=(await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
    demand(controls.length===1&&controls[0].environment==='staging'&&controls[0].target_sha256===plan.targetSha256);
    checkpoint='current-admission-state';const admission={epoch:controls[0].epoch,newWork:controls[0].new_work,recovery:controls[0].recovery,...counts};admissionPolicy(plan,admission,initial);
    const unresolved=(await client.query("SELECT id::text,epoch::text,kind,producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.operations WHERE state<>'completed' ORDER BY id LIMIT 4097")).rows;
    const preNative=BigInt(admission.epoch)<=BigInt(plan.initialEpoch)+(plan.startState==='qualified-ready'?1n:0n);
    demand(unresolved.length<=4096&&(plan.mode==='contain-native'||unresolved.every(row=>row.source_sha===plan.sourceCommit&&
      (['auth-preparation','browser-pending'].includes(plan.mode)?prepared.plan.producers.some(producer=>producer.producerSha256===row.producer_sha256&&producer.role.oid===row.role_oid)&&
        BigInt(row.epoch)<=BigInt(plan.initialEpoch)+1n:
      (preNative?prepared.plan.producers.some(producer=>producer.producerSha256===row.producer_sha256&&producer.role.oid===row.role_oid)&&BigInt(row.epoch)<=BigInt(plan.initialEpoch):
        row.kind==='recovery'&&row.producer_sha256===plan.nativePlan.producer.producerSha256&&row.role_oid===plan.nativePlan.producer.role.oid&&
        BigInt(row.epoch)>=BigInt(plan.nativePlan.initialEpoch)&&BigInt(row.epoch)<=BigInt(plan.nativePlan.initialEpoch)+1n)))));
    checkpoint='current-command-witness';demand(name(target.user));await client.query(`SET LOCAL ROLE "${target.user}"`);
    const nativePlan=plan.nativePlan,ids=nativePlan.commandWitnesses.map(row=>row.commandId);
    const commandRows=(await client.query('SELECT command_id::text,user_id::text,account_version::text,action,issued_at,command FROM public.customer_account_commands WHERE command_id=ANY($1::uuid[]) ORDER BY command_id',[ids])).rows;
    const commands=commandRows.map(row=>({commandId:row.command_id,accountVersion:row.account_version,action:row.action,issuedAt:new Date(row.issued_at).toISOString(),canonicalSha256:createHash('sha256').update(canonical(row.command)).digest('hex')}));
    demand(commands.length===ids.length&&commands.every(row=>nativePlan.commandWitnesses.some(expected=>expected.commandId===row.commandId&&expected.accountVersion===row.accountVersion&&expected.action===row.action)));
    const deliveries=(await client.query('SELECT command_id::text,receiver,status,attempts,acknowledged_at,lease_until FROM public.customer_account_deliveries WHERE command_id=ANY($1::uuid[]) ORDER BY command_id,receiver',[ids])).rows;
    demand(deliveries.length===commands.length*2&&commands.every(command=>['course','community'].every(receiver=>deliveries.filter(row=>row.command_id===command.commandId&&row.receiver===receiver).length===1)));
    const orderViolations=(await client.query(`SELECT later.command_id::text AS later_command_id,prior.command_id::text AS prior_command_id,d.receiver
      FROM public.customer_account_commands later JOIN public.customer_account_deliveries d ON d.command_id=later.command_id
      JOIN public.customer_account_commands prior ON prior.user_id=later.user_id AND prior.account_version<later.account_version
      LEFT JOIN public.customer_account_deliveries pd ON pd.command_id=prior.command_id AND pd.receiver=d.receiver
      WHERE later.command_id=ANY($1::uuid[]) AND d.status='acknowledged' AND (pd.status IS DISTINCT FROM 'acknowledged' OR pd.acknowledged_at IS NULL OR pd.acknowledged_at>d.acknowledged_at) LIMIT 4097`,[ids])).rows;
    demand(orderViolations.length<=4096);await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const operations=(await client.query(`SELECT id::text,epoch::text,kind,state,producer_sha256,source_sha,database_role::text AS role_oid,completed_at,reconciliation_sha256
      FROM frontend_admission.operations WHERE epoch >= $1::bigint ORDER BY started_at,id LIMIT 4097`,[(BigInt(nativePlan.initialEpoch)+(plan.mode==='direct-worker'?0n:1n)).toString()])).rows;
    demand(operations.length<=4096);
    const witness={commands,deliveries,orderViolations,operations};
    return{version:plan.version,...selectedProfile,status:'P2_CERTIFICATION_DATABASE_CURRENT',service:'frontend',environment:'staging',releaseId:job.releaseId,certificationActionId:plan.certificationActionId,
      sourceCommit:job.sourceCommit,candidateSha256:plan.candidateSha256,targetSha256:plan.targetSha256,planSha256:plan.planSha256,
      ...Object.fromEntries(['migrationImageDigest','sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256','contractPhase','phase2ContractManifestSha256'].map(key=>[key,job[key]])),
      target:{...Object.fromEntries(['host','port','database','user','serverMajor'].map(key=>[key,target[key]])),...selectedProfile},after,journalSha256:hash(after),schemaVerified:true,runtimeRoleVerified:true,
      owner,runtime,retiredLogins:retired,oldLoginsDenied:true,oldRoleSessions:0,admission,witness,witnessSha256:hash(witness),sqlReplayed:false,trafficAuthorized:false};
  }catch(error){if(!error.checkpoint)error.checkpoint=checkpoint;throw error;}finally{await client.query('ROLLBACK');}
}

export async function withP2CertificationFrontendSession(prepared,plan,{getUrl,verifyEnvironment},task,expectedProfile){
  const job=prepared.migration.job, target=job.target;
  const selectedProfile=profileFields(expectedProfile,plan,job,prepared.plan.historicalLogins);
  const client=new Client(options(await getUrl(),target));let lost=false,locked=false,identity,marker;
  client.on('error',()=>{lost=true;});
  const verify=async()=>{
    await verifyEnvironment();demand(!lost&&client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true);
    const actual=(await client.query("SELECT pg_catalog.pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(actual.username===target.user&&actual.session_username===target.user&&actual.database===target.database&&actual.major===target.serverMajor&&(!identity||identity.pid===actual.pid));identity=actual;
    if(locked)demand((await client.query(RECOVERY_HELD_LOCK,[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true);
    if(marker)demand((await client.query(RECOVERY_HELD_LOCK,[marker])).rows[0]?.held===true);
  };
  try{
    await client.connect();await verify();locked=(await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS locked',[FRONTEND_MIGRATION_LOCK])).rows[0]?.locked===true;demand(locked);
    marker=randomBytes(32).toString('hex');await client.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))',[marker]);
    const backendStart=(await client.query('SELECT backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()')).rows[0]?.backend_start;demand(typeof backendStart==='string');
    const receipt=await readP2CertificationCurrent(client,prepared,plan,verify,true,expectedProfile);
    const result=await task({client,verify,receipt,probe:{version:plan.version,...selectedProfile,marker,backendPid:identity.pid,backendStart,job:prepared.migration.job,baseline:prepared.migration.baseline,
      owner:prepared.plan.owner,producers:prepared.plan.producers,historicalLogins:prepared.plan.historicalLogins,plan,receipt}});await verify();return result;
  }catch(error){const failure=new Error('P2_CERTIFICATION_PHYSICAL_SESSION_FAILED');if(typeof error?.checkpoint==='string'&&/^[a-z-]{1,80}$/u.test(error.checkpoint))failure.checkpoint=error.checkpoint;throw failure;}
  finally{try{if(locked)await client.query('SELECT pg_catalog.pg_advisory_unlock_all()');}catch{lost=true;}try{await client.end();}catch{lost=true;}if(lost)throw new Error('P2_CERTIFICATION_PHYSICAL_CLEANUP_UNCERTAIN');}
}

export async function observeP2CertificationPhysical(input,{getUrl},expectedProfile){
  const selectedProfile=profileFields(expectedProfile,input?.plan,input?.job,input?.historicalLogins);
  if(expectedProfile===undefined)demand(!Object.hasOwn(input,'qualificationTargetProfile'));
  else requireQualificationTargetProfile(currentProfile,input);
  const closing=input.operation==='verify-closed';
  demand(input.version===input.plan.version&&['observe','verify-schema','witness','fence','verify-closed'].includes(input.operation)&&
    (expectedProfile===undefined?!closing:input.operation!=='fence')&&/^[a-f0-9]{64}$/u.test(input.marker??'')&&Number.isSafeInteger(input.backendPid)&&typeof input.backendStart==='string');
  const client=new Client(options(await getUrl(),input.job.target));let lost=false;client.on('error',()=>{lost=true;});
  try{
    await client.connect();demand(client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true);
    const verify=async()=>{
      demand(!lost);const actual=(await client.query("SELECT current_user AS role,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
      demand(actual.role===input.job.target.user&&actual.database===input.job.target.database&&actual.major===input.job.target.serverMajor);
    };await verify();
    const owner=(await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname=$1',[input.owner.name])).rows[0];
    demand(owner?.oid===input.owner.oid&&owner.rolconfig===null&&owner.rolconnlimit===-1&&owner.rolvaliduntil===null&&
      ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key=>owner[key]===false));
    demand((await client.query("SELECT nspowner::text AS oid FROM pg_catalog.pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid===input.owner.oid);
    if(input.operation==='fence'){
      demand(name(input.owner.name));await client.query('BEGIN');
      try{await client.query(`SET LOCAL ROLE "${input.owner.name}"`);const rows=(await client.query('SELECT environment,target_sha256 FROM frontend_admission.control WHERE singleton FOR UPDATE')).rows;
        demand(rows.length===1&&rows[0].environment==='staging'&&rows[0].target_sha256===input.plan.targetSha256);
        await client.query('UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND (new_work OR recovery)');await client.query('COMMIT');
      }catch{await client.query('ROLLBACK');throw new Error('P2_CERTIFICATION_CONTAINMENT_UNKNOWN');}
      return{version:1,status:'P2_FRONTEND_ADMISSION_CLOSED',frontendAdmissionClosed:true};
    }
    const verifyParent=async()=>{
      if(closing)await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
      const parent=(await client.query('SELECT backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=$1',[input.backendPid])).rows[0];
      demand(closing?parent?.backend_start!==input.backendStart:parent?.backend_start===input.backendStart);
      const sql=closing?RECOVERY_HELD_LOCK.replace(' AND pid=pg_backend_pid()',''):RECOVERY_HELD_LOCK.replace('pid=pg_backend_pid()','pid=$2');
      for(const key of [FRONTEND_MIGRATION_LOCK,input.marker]){
        const observed=await client.query(sql,closing?[key]:[key,input.backendPid]);
        demand(observed.rows[0]?.held===!closing);
      }
    };
    await verifyParent();
    const verifyCurrent=expectedProfile===undefined?verify:async()=>{await verify();await verifyParent();};
    const artifact=await import('./frontend-migration.mjs');
    const prepared={migration:{job:input.job,artifact:artifact.frontendMigrationArtifact(),baseline:input.baseline},plan:{owner:input.owner,producers:input.producers,historicalLogins:input.historicalLogins,targetSha256:input.plan.targetSha256}};
    const current=await readP2CertificationCurrent(client,prepared,input.plan,verifyCurrent,false,expectedProfile);
    if(expectedProfile!==undefined)await verifyCurrent();
    if(closing)demand(current.admission.newWork===false&&current.admission.recovery===false&&current.admission.active===0&&current.admission.uncertain===0);
    return{version:input.version,...selectedProfile,status:closing?'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED':'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED',marker:input.marker,backendPid:input.backendPid,sourceCommit:input.job.sourceCommit,admission:current.admission,journalSha256:current.journalSha256,
      ...(expectedProfile===undefined?{}:{backendStart:input.backendStart,environment:current.environment,releaseId:current.releaseId,targetSha256:current.targetSha256}),
      witnessSha256:current.witnessSha256,...(input.operation==='witness'?{witness:current.witness}:{}),
      ...(closing?{backendAbsent:true,migrationLockReleased:true,nonceLockReleased:true}:{})};
  }finally{try{await client.end();demand(!lost);}catch{throw new Error('P2_CERTIFICATION_OBSERVER_CLEANUP_UNCERTAIN');}}
}

// The Linux guard invokes this fixed command only after independently accepting
// the physical probe, retaining its canonical flock, and reaping its mutators.
export async function containP2ProfiledCertificationAdmission(probe,{getUrl}){
  const {job,plan,owner,historicalLogins,receipt}=probe;
  const selectedProfile=profileFields(currentProfile,plan,job,historicalLogins);
  requireQualificationTargetProfile(currentProfile,probe,receipt,receipt.target);
  const target=job.target;
  demand(probe.version===2&&receipt.version===2&&receipt.status==='P2_CERTIFICATION_DATABASE_CURRENT'&&
    name(owner.name)&&/^[1-9][0-9]{0,9}$/u.test(owner.oid??'')&&isDeepStrictEqual(receipt.owner,owner)&&
    plan.sourceCommit===job.sourceCommit&&plan.originalReleaseId===job.releaseId&&
    receipt.sourceCommit===job.sourceCommit&&receipt.releaseId===job.releaseId&&
    receipt.certificationActionId===plan.certificationActionId&&receipt.planSha256===plan.planSha256&&
    receipt.candidateSha256===plan.candidateSha256&&receipt.targetSha256===plan.targetSha256&&plan.targetSha256===targetHash(target)&&
    ['host','port','database','user','serverMajor'].every(key=>receipt.target[key]===target[key])&&
    receipt.admission?.epoch===plan.initialEpoch&&receipt.admission.newWork===false&&receipt.admission.recovery===false);
  const client=new Client(options(await getUrl(),target));let lock=false,started=false,lost=false;
  client.on('error',()=>{lost=true;});
  const verify=async()=>{
    demand(!lost&&client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true);
    const identity=(await client.query("SELECT current_user AS role,session_user AS session_role,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(identity?.role===target.user&&identity.session_role===target.user&&identity.database===target.database&&identity.major===target.serverMajor);
    if(lock)demand((await client.query(RECOVERY_HELD_LOCK,[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true);
  };
  try{
    await client.connect();await verify();
    lock=(await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true;
    demand(lock,'guard-physical-lock');await verify();
    await client.query('BEGIN');started=true;
    const role=(await client.query('SELECT oid::text,rolcanlogin,rolsuper FROM pg_catalog.pg_roles WHERE rolname=$1',[owner.name])).rows[0];
    demand(role?.oid===owner.oid&&role.rolcanlogin===false&&role.rolsuper===false);
    demand((await client.query("SELECT nspowner::text AS oid FROM pg_catalog.pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid===owner.oid);
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const rows=(await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton FOR UPDATE NOWAIT')).rows;
    const row=rows[0];
    demand(rows.length===1&&row.environment==='staging'&&row.target_sha256===plan.targetSha256&&/^[1-9][0-9]{0,17}$/u.test(row.epoch??'')&&
      typeof row.new_work==='boolean'&&typeof row.recovery==='boolean'&&BigInt(row.epoch)>=BigInt(plan.initialEpoch)&&
      BigInt(row.epoch)<=BigInt(plan.initialEpoch)+4n);
    const changed=row.new_work||row.recovery;
    const epoch=changed?(await client.query('UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND epoch=$1::bigint RETURNING epoch::text',[row.epoch])).rows[0]?.epoch:row.epoch;
    demand(epoch===(BigInt(row.epoch)+(changed?1n:0n)).toString());
    await client.query('COMMIT');started=false;await verify();
    await client.query('BEGIN READ ONLY');started=true;
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const closed=(await client.query('SELECT epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton AND environment=$1 AND target_sha256=$2',['staging',plan.targetSha256])).rows;
    demand(closed.length===1&&closed[0].epoch===epoch&&closed[0].new_work===false&&closed[0].recovery===false);
    await client.query('ROLLBACK');started=false;await verify();
    return {version:2,...selectedProfile,status:'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_CLOSED',environment:'staging',
      releaseId:job.releaseId,sourceCommit:job.sourceCommit,certificationActionId:plan.certificationActionId,
      candidateSha256:plan.candidateSha256,targetSha256:plan.targetSha256,planSha256:plan.planSha256,
      epoch,frontendAdmissionClosed:true,admissionChanged:changed,sqlReplayed:false,releaseAccepted:false};
  }finally{
    if(started)try{await client.query('ROLLBACK');}catch{lost=true;}
    try{await client.end();}catch{lost=true;}
    demand(!lost,'guard-session-cleanup');
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const flags=process.argv.slice(2);demand(flags.length===0||(flags.length===1&&['--profiled-current','--profiled-current-guard-fence'].includes(flags[0])));
    const raw=readFileSync(0);demand(raw.length>0&&raw.length<=2_000_000);
    const expectedProfile=flags.length?currentProfile:undefined;
    const input=expectedProfile?decodeQualificationTargetJson(raw,'carrier'):JSON.parse(raw);
    const dependencies={getUrl:()=>process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL};
    const output=flags[0]==='--profiled-current-guard-fence'
      ?await containP2ProfiledCertificationAdmission(input,dependencies)
      :await observeP2CertificationPhysical(input,dependencies,expectedProfile);
    console.log(JSON.stringify(output));
  }
  catch{console.error('P2_CERTIFICATION_PHYSICAL_REFUSED');process.exitCode=1;}
}
