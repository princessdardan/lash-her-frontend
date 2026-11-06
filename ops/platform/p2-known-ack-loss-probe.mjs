// Fixed private readonly child for one known suspension. No mutation/executor.
import {Client} from 'pg';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const demand=ok=>{if(!ok)throw new Error('P2_KNOWN_ACK_READ_REFUSED');};
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value,(_key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))):child)).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,62}$/u.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const lockSql=`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=$2 AND granted AND mode='ExclusiveLock'
 AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND objsubid=1
 AND classid=((pg_catalog.hashtext($1)::bigint>>32)&4294967295)::oid AND objid=(pg_catalog.hashtext($1)::bigint&4294967295)::oid) AS held`;
const iso=value=>value===null?null:new Date(value).toISOString();
// These projections contain queue/lease/outcome metadata, never bodies, URLs,
// tokens or export data. Every fixed table is complete or the bound refuses.
const BACKEND_PROJECTIONS=Object.freeze({
  course:Object.freeze({
    control:"SELECT key,state,paused_at,resumed_at,updated_at FROM public.community_enrollment_publisher_control ORDER BY key LIMIT 1001",
    outbox:"SELECT event_id,stream_id,stream_version,canonical_digest,state,attempts_in_cycle,replay_cycle,available_at,lease_owner,lease_expires_at,last_attempt_at,delivered_at,dead_lettered_at,last_failure_code,created_at,updated_at FROM public.community_enrollment_outbox ORDER BY event_id LIMIT 1001",
    operations:"SELECT id,event_id,target_type,target_id,action,previous_state,resulting_state,created_at FROM public.community_enrollment_outbox_operations ORDER BY id LIMIT 1001",
    snapshots:"SELECT id,status,row_count,requested_at,started_at,completed_at,expires_at,failure_code,created_at,updated_at FROM public.community_enrollment_snapshots ORDER BY id LIMIT 1001",
    snapshotItems:"SELECT snapshot_id,stream_id,version,state,effective_at FROM public.community_enrollment_snapshot_items ORDER BY snapshot_id,stream_id LIMIT 1001",
    streams:"SELECT id,version,state,effective_at,created_at,updated_at FROM public.community_enrollment_streams ORDER BY id LIMIT 1001",
    media:"SELECT id,managed_by_course,provider_environment_id,is_current,status,recovery_attempts,recovery_next_attempt_at,recovery_lease_owner,recovery_lease_until,last_error_code,superseded_at,deleted_at,updated_at FROM public.video_assets ORDER BY id LIMIT 1001",
    exports:"SELECT command_id,account_version,ready_at,expires_at FROM public.account_lifecycle_exports ORDER BY command_id LIMIT 1001"
  }),
  community:Object.freeze({
    repairs:"SELECT id,stream_id,minimum_version,status,attempts,lease_owner,lease_expires_at,next_attempt_at,last_failure_code,created_at,updated_at,resolved_at FROM public.course_enrollment_repairs ORDER BY id LIMIT 1001",
    reconciliations:"SELECT id,snapshot_id,status,phase,checkpoint_stream_id,local_checkpoint_stream_id,staged_row_count,lease_owner,lease_expires_at,attempts,source_row_count,inspected_count,missing_count,repaired_count,stale_count,conflict_count,unexpected_count,failure_code,requested_at,started_at,completed_at FROM public.course_enrollment_reconciliations ORDER BY id LIMIT 1001",
    operations:"SELECT id,action,target_id,created_at FROM public.course_enrollment_operations ORDER BY id LIMIT 1001",
    projections:"SELECT stream_id,state,applied_version,highest_observed_version,status,source,source_event_id,effective_at,created_at,updated_at FROM public.course_enrollment_projections ORDER BY stream_id LIMIT 1001",
    inbox:"SELECT event_id,stream_id,stream_version,canonical_digest,event_type,state,status,occurred_at,effective_at,received_at,applied_at,quarantine_code FROM public.course_enrollment_inbox ORDER BY event_id LIMIT 1001",
    tombstones:"SELECT event_id,canonical_digest,stream_id,stream_version,status,received_at,retired_at FROM public.course_enrollment_inbox_tombstones ORDER BY event_id LIMIT 1001",
    baselines:"SELECT reconciliation_id,stream_id,version,state,effective_at,projection_status FROM public.course_enrollment_reconciliation_items ORDER BY reconciliation_id,stream_id LIMIT 1001",
    sourceItems:"SELECT reconciliation_id,stream_id,version,state,effective_at FROM public.course_enrollment_reconciliation_source_items ORDER BY reconciliation_id,stream_id LIMIT 1001",
    exports:"SELECT command_id,account_version,ready_at,expires_at FROM public.account_lifecycle_exports ORDER BY command_id LIMIT 1001"
  })
});
export async function observeKnownAckBackend(client,service,deadline){
  demand(Object.hasOwn(BACKEND_PROJECTIONS,service)&&typeof deadline==='string'&&iso(deadline)===deadline);
  const clock=(await client.query('SELECT pg_catalog.clock_timestamp() AS now')).rows[0].now;
  const end=Date.parse(deadline),now=new Date(clock).getTime();demand(end>now&&end<=now+905000);
  const rows={};for(const [key,sql]of Object.entries(BACKEND_PROJECTIONS[service])){rows[key]=(await client.query(sql)).rows;demand(rows[key].length<=1000);}
  const at=value=>value===null?null:new Date(value).getTime();
  const due=value=>value!==null&&at(value)<=end;
  let eligible;
  if(service==='course'){
    demand(rows.control.length===1&&rows.control[0].key==='publisher'&&['running','paused'].includes(rows.control[0].state));
    eligible={outbox:rows.outbox.filter(row=>row.state==='pending'||row.lease_owner!==null||row.lease_expires_at!==null).length,
      snapshots:rows.snapshots.filter(row=>['requested','building'].includes(row.status)||row.status==='expired'||row.status==='ready'&&due(row.expires_at)).length,
      media:rows.media.filter(row=>row.recovery_lease_owner!==null||row.recovery_lease_until!==null||row.managed_by_course&&row.deleted_at===null&&due(row.recovery_next_attempt_at)).length,
      exports:rows.exports.filter(row=>due(row.expires_at)).length,
      retention:rows.operations.filter(row=>at(row.created_at)<end-180*86400000).length+rows.outbox.filter(row=>row.state==='delivered'&&row.delivered_at!==null&&at(row.delivered_at)<end-180*86400000).length};
  }else{
    const latest=values=>values.length?Math.max(...values):null;
    const reconciliation=latest(rows.reconciliations.filter(row=>row.snapshot_id!==null).map(row=>at(row.requested_at)));
    const retention=latest(rows.operations.filter(row=>row.action==='retention_run').map(row=>at(row.created_at)));
    eligible={repairs:rows.repairs.filter(row=>['pending','leased'].includes(row.status)||row.lease_owner!==null||row.lease_expires_at!==null).length,
      reconciliations:rows.reconciliations.filter(row=>['requested','running'].includes(row.status)||row.lease_owner!==null||row.lease_expires_at!==null).length,
      exports:rows.exports.filter(row=>due(row.expires_at)).length,
      reconciliationSchedule:reconciliation===null||reconciliation>now||reconciliation+86400000<=end?1:0,
      retentionSchedule:retention===null||retention>now||retention+86400000<=end?1:0};
  }
  return{version:1,status:'P2_KNOWN_ACK_BACKEND_OBSERVED',deadline,eligible,rowCounts:Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,value.length])),snapshotSha256:sha(rows)};
}
export function readKnownAckRuntimeDatabaseUrl(environment=process.env){
  demand(environment.NODE_ENV==='production'&&environment.DATABASE_TARGET==='staging'&&typeof environment.STAGING_DATABASE_URL==='string'&&
    environment.STAGING_DATABASE_URL.length>0&&environment.STAGING_DATABASE_URL.length<=16384);
  return environment.STAGING_DATABASE_URL;
}
export async function observeKnownAckSql(input,{getUrl}){
  demand(input?.version===1&&['frontend','course','community'].includes(input.service)&&uuid(input.commandId)&&/^[a-f0-9]{64}$/u.test(input.commandSha256??'')&&
    /^[1-9][0-9]{0,17}$/u.test(input.accountVersion??'')&&/^[1-9][0-9]{0,17}$/u.test(input.windowEpoch??'')&&typeof getUrl==='function');
  const target=input.target;demand(target&&typeof target.host==='string'&&Number.isInteger(target.port)&&target.port>0&&target.port<=65535&&name(target.database)&&name(target.user)&&[16,18].includes(target.serverMajor));
  let url;try{url=new URL(await getUrl());}catch{throw new Error('P2_KNOWN_ACK_READ_REFUSED');}
  demand(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname===target.host&&Number(url.port||5432)===target.port&&decodeURIComponent(url.pathname)==='/'+target.database&&decodeURIComponent(url.username)===target.user&&url.password&&!url.hash&&[...url.searchParams].length===1&&url.searchParams.get('sslmode')==='verify-full');
  const client=new Client({host:target.host,port:target.port,database:target.database,user:target.user,password:decodeURIComponent(url.password),ssl:{rejectUnauthorized:true},enableChannelBinding:true,
    connectionTimeoutMillis:10000,options:'-c default_transaction_read_only=on -c search_path=pg_catalog,public',statement_timeout:10000,lock_timeout:5000,application_name:'lash-her-known-ack-readonly'});
  let lost=false;client.on('error',()=>{lost=true;});
  try{
    await client.connect();demand(client.connection.stream.encrypted===true&&client.connection.stream.authorized===true);await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try{
      const actual=(await client.query("SELECT pg_catalog.current_database() AS database,session_user AS role,current_user::regrole::oid::text AS role_oid,pg_catalog.current_setting('server_version_num')::int/10000 AS major,pg_catalog.current_setting('transaction_read_only') AS readonly")).rows[0];
      demand(actual.database===target.database&&actual.role===target.user&&actual.major===target.serverMajor&&actual.readonly==='on'&&(input.service==='frontend'||actual.role_oid===target.roleOid));
      if(input.service==='frontend'){
        demand(Number.isSafeInteger(input.backendPid)&&typeof input.backendStart==='string'&&/^[a-f0-9]{64}$/u.test(input.marker??'')&&name(input.owner?.name)&&/^[1-9][0-9]*$/u.test(input.owner.oid??''));
        demand((await client.query('SELECT backend_start::text AS value FROM pg_catalog.pg_stat_activity WHERE pid=$1',[input.backendPid])).rows[0]?.value===input.backendStart);
        for(const key of ['lash-her:private-db:migrations',input.marker])demand((await client.query(lockSql,[key,input.backendPid])).rows[0].held===true);
        const rows=(await client.query('SELECT command_id::text,user_id::text,account_version::text,action,issued_at,command FROM public.customer_account_commands WHERE command_id=$1::uuid',[input.commandId])).rows;
        demand(rows.length===1);const row=rows[0];demand(row.account_version===input.accountVersion&&row.action==='suspend'&&row.command.commandId===row.command_id&&row.command.userId===row.user_id&&String(row.command.accountVersion)===row.account_version&&row.command.action==='suspend'&&sha(row.command)===input.commandSha256);
        const user=(await client.query('SELECT status,account_version::text FROM public.customer_users WHERE id=$1::uuid',[row.user_id])).rows;demand(user.length===1&&user[0].status==='suspended'&&user[0].account_version===input.accountVersion);
        const deliveries=(await client.query('SELECT receiver,status,attempts,lease_id::text,lease_until,acknowledged_at,next_run_at<=pg_catalog.clock_timestamp() AS ready FROM public.customer_account_deliveries WHERE command_id=$1::uuid ORDER BY receiver',[input.commandId])).rows;
        demand(deliveries.length===2&&deliveries.map(value=>value.receiver).join()==='community,course');
        const outstanding=(await client.query("SELECT command_id::text,receiver,status,attempts,lease_id::text,lease_until,acknowledged_at,next_run_at<=pg_catalog.clock_timestamp() AS ready FROM public.customer_account_deliveries WHERE status<>'acknowledged' ORDER BY command_id,receiver LIMIT 3")).rows;
        const exports=(await client.query("SELECT count(*)::int AS count FROM public.customer_account_exports WHERE status IN ('pending','ready') OR (status IN ('failed','expired') AND (data IS NOT NULL OR frontend_data IS NOT NULL))")).rows[0].count;
        const later=(await client.query('SELECT count(*)::int AS count FROM public.customer_account_commands WHERE user_id=$1::uuid AND account_version>$2::bigint',[row.user_id,input.accountVersion])).rows[0].count;
        await client.query(`SET LOCAL ROLE "${input.owner.name}"`);demand((await client.query('SELECT current_user::regrole::oid::text AS oid')).rows[0].oid===input.owner.oid);
        const control=(await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows;
        const global=(await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
        const operations=(await client.query('SELECT id::text,epoch::text,kind,state,producer_sha256,source_sha,database_role::text AS role_oid,started_at,completed_at,reconciliation_sha256 FROM frontend_admission.operations WHERE epoch>=$1::bigint ORDER BY started_at,id LIMIT 5',[input.windowEpoch])).rows;
        demand(control.length===1&&control[0].environment==='staging'&&control[0].target_sha256===input.targetSha256&&operations.length<=4);
        const dates=value=>({...value,...Object.fromEntries(['lease_until','acknowledged_at','started_at','completed_at'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,iso(value[key])]))});
        return{version:1,status:'P2_KNOWN_ACK_SQL_CURRENT',service:'frontend',roleOid:actual.role_oid,commandId:input.commandId,userBindingSha256:sha(row.user_id),accountVersion:row.account_version,commandSha256:sha(row.command),
          accountStatus:user[0].status,deliveries:deliveries.map(dates),outstanding:outstanding.map(dates),exports,later,admission:{epoch:control[0].epoch,newWork:control[0].new_work,recovery:control[0].recovery,...global},operations:operations.map(dates),readOnly:true};
      }
      const backend=await observeKnownAckBackend(client,input.service,input.backendDeadline);
      const rows=(await client.query('SELECT command_id::text,user_id::text,account_version::text,action,canonical_digest,accepted_at FROM public.account_lifecycle_commands WHERE command_id=$1::uuid',[input.commandId])).rows;
      demand(rows.length<=1);
      if(!rows.length)return{version:1,status:'P2_KNOWN_ACK_SQL_CURRENT',service:input.service,roleOid:actual.role_oid,commandId:input.commandId,command:null,backend,readOnly:true};
      const row=rows[0],state=(await client.query('SELECT status,account_version::text FROM public.account_lifecycle_states WHERE user_id=$1::uuid',[row.user_id])).rows;
      demand(row.account_version===input.accountVersion&&row.action==='suspend'&&row.canonical_digest===input.commandSha256&&state.length===1&&state[0].status==='suspended'&&state[0].account_version===input.accountVersion);
      return{version:1,status:'P2_KNOWN_ACK_SQL_CURRENT',service:input.service,roleOid:actual.role_oid,commandId:input.commandId,command:{userBindingSha256:sha(row.user_id),accountVersion:row.account_version,commandSha256:row.canonical_digest,acceptedAt:iso(row.accepted_at),accountStatus:state[0].status},backend,readOnly:true};
    }finally{await client.query('ROLLBACK');}
  }catch{throw new Error('P2_KNOWN_ACK_READ_REFUSED');}finally{try{await client.end();demand(!lost);}catch{throw new Error('P2_KNOWN_ACK_READ_REFUSED');}}
}
export function knownAckProjectionEqual(first,second){return same(first,second);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const raw=readFileSync(0);demand(raw.length>0&&raw.length<=65536);const input=JSON.parse(raw);console.log(JSON.stringify(await observeKnownAckSql(input,{getUrl:()=>input.service==='frontend'?process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL:readKnownAckRuntimeDatabaseUrl()})));}
  catch{console.error('P2_KNOWN_ACK_READ_REFUSED');process.exitCode=1;}
}
