// Actual exported cron/store/dispatcher through real TLS gateway ACK loss.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer,request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {fork,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from 'pg';
import {createGateway} from '../../gateway/server.mjs';
import {createP2CertificationFault,p2GatewayProcessBinding} from '../../gateway/p2-certification-fault.mjs';
import {changeFrontendAdmission,reconcileFrontendOperation} from '../frontend-admission.mjs';
import {observeKnownAckSql,observeKnownAckBackend,readKnownAckRuntimeDatabaseUrl} from '../p2-known-ack-loss-probe.mjs';
let phase='owned-input',observed;
async function main(){
 assert.equal(process.env.P2_NATIVE_OWNED_CHILD,'true');const input=JSON.parse(readFileSync(0));const {target,port,password,runtime,owner,targetSha256,certificate,key,sourceCommit,directory}=input;
 assert.equal(target.host,'127.0.0.1');assert.equal(target.port,port);const url=`postgresql://${runtime.name}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`;
 const {VERCEL_PROJECT_BINDINGS}=await import('../../../src/lib/env/application-environment.mjs');
 Object.assign(process.env,{DATABASE_URL:url,FRONTEND_WRITER_ADMISSION_DATABASE_URL:url,FRONTEND_WRITER_ADMISSION_MODE:'enforce',FRONTEND_WRITER_ADMISSION_TARGET_JSON:JSON.stringify({...target,user:runtime.name,targetSha256,environment:'staging'}),
  FRONTEND_WRITER_PRODUCER_SHA256:'b'.repeat(64),VERCEL_GIT_COMMIT_SHA:sourceCommit,APP_ENV:'staging',VERCEL:'1',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:VERCEL_PROJECT_BINDINGS.stagingProjectId,APP_VERCEL_TEAM_ID:VERCEL_PROJECT_BINDINGS.teamId,
  CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED:'true',CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED:'true',LASH_P2_CERTIFICATION_SCHEDULES:'account-lifecycle',CRON_SECRET:'owned-'+randomUUID(),API_GATEWAY_STAGING_ORIGIN:'https://gateway.owned.invalid',
  COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:'owned-course-'+randomUUID(),COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:'owned-community-'+randomUUID(),
  VERCEL_OIDC_TOKEN:`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.owned`});
 const operator=new Client({host:target.host,port,database:target.database,user:target.user,password,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});await operator.connect();
 const fetchObservations=[],servers=[],children=[],effects=[],backendClients=[],accepted={course:new Map(),community:new Map()},originalFetch=globalThis.fetch,originalInfo=console.info,traces=[];let closePool;
 const withOwner=async task=>{await operator.query(`SET ROLE "${owner.name}"`);try{return await task();}finally{await operator.query('RESET ROLE');}};
 const ledger=()=>withOwner(async()=> (await operator.query('SELECT id::text,state,kind,epoch::text,reconciliation_sha256 FROM frontend_admission.operations ORDER BY started_at')).rows);
 try{
  phase='actual-source-route';const {GET}=await import('../../../src/app/api/cron/account-lifecycle/route.ts');({closePrivateDbPool:closePool}=await import('../../../src/lib/private-db/client.ts'));
  console.info=line=>{assert.equal(typeof line,'string');assert.equal(JSON.parse(line).status,'P2_LIFECYCLE_CRON_ADMITTED');traces.push(JSON.parse(line));};
  const customerId=randomUUID(),command={version:1,commandId:randomUUID(),userId:customerId,accountVersion:1,action:'suspend',issuedAt:new Date().toISOString()};
  await operator.query("INSERT INTO customer_users(id,email,status,account_version) VALUES($1,'owned-known-ack@example.invalid','suspended',1)",[customerId]);
  await operator.query("INSERT INTO customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command) VALUES($1,$2,1,$3,'suspend',$4,$5)",[command.commandId,customerId,randomUUID(),command.issuedAt,command]);
  for(const receiver of ['course','community'])await operator.query('INSERT INTO customer_account_deliveries(command_id,receiver) VALUES($1,$2)',[command.commandId,receiver]);
  const origins={};
  const keys=Object.fromEntries(['COURSE_LEARNER_JWT_CURRENT_SECRET','COURSE_ADMIN_JWT_CURRENT_SECRET','COMMUNITY_MEMBER_JWT_CURRENT_SECRET','COMMUNITY_ADMIN_JWT_CURRENT_SECRET','COURSE_PUBLISHER_JWT_CURRENT_SECRET'].map(name=>[name,'owned-'+randomUUID()+randomUUID()]));
  Object.assign(keys,{COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:process.env.COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET,COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:process.env.COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET});
  function actualReceiver(service){
    const api=input.apis[service],env=Object.fromEntries(['PATH','HOME','LANG','TMPDIR'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
    const child=fork(new URL('./owned-phase2-lifecycle-receiver.mjs',import.meta.url),[],{cwd:api.root,execArgv:['--import','tsx'],env:{...env,NODE_ENV:'test',NODE_NO_WARNINGS:'1',NODE_EXTRA_CA_CERTS:certificate,DOTENV_CONFIG_PATH:join(directory,'absent.env'),COURSE_ACCOUNT_LIFECYCLE_ENABLED:'true',COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED:'true',HTTP_AGGREGATE_RATE_LIMIT_PER_MINUTE:'10000',HTTP_PRINCIPAL_RATE_LIMIT_PER_MINUTE:'10000',...keys},stdio:['ignore','ignore','ignore','ipc']});
    let next=0;const pending=new Map();child.on('message',value=>{const waiter=pending.get(value.id);if(!waiter)return;pending.delete(value.id);clearTimeout(waiter.timer);if(value.error)waiter.reject(new Error('OWNED_REAL_RECEIVER_REFUSED'));else waiter.resolve(value.result);});
    child.on('exit',()=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('OWNED_RECEIVER_EXITED'));}pending.clear();});
    const request=(op,value={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('OWNED_RECEIVER_TIMEOUT'));},30000);pending.set(id,{resolve,reject,timer});child.send({id,op,...value});});
    const instance={child,request};children.push(instance);return instance;
  }
  for(const receiver of ['course','community']){
   const actual=actualReceiver(receiver),bound=await actual.request('initialize',{service:receiver,root:input.apis[receiver].root,database:input.apis[receiver].database,ca:readFileSync(certificate,'utf8'),clock:Date.now(),keys});assert.equal(bound.host,'127.0.0.1');
   const server=createServer({key:readFileSync(key),cert:readFileSync(certificate)},async(req,res)=>{
    try{assert.equal(req.method,'POST');assert.equal(req.url,'/v1/internal/accounts/commands');const chunks=[];for await(const value of req)chunks.push(value);const body=JSON.parse(Buffer.concat(chunks));assert.deepEqual(body,command);assert.equal(req.headers['x-idempotency-key'],command.commandId);
     const response=await new Promise((resolve,reject)=>{const call=httpRequest({host:'127.0.0.1',port:bound.port,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:'+bound.port}},reply=>{const bytes=[];reply.on('data',value=>bytes.push(value));reply.on('end',()=>resolve({status:reply.statusCode,headers:reply.headers,body:Buffer.concat(bytes)}));reply.on('error',reject);});call.on('error',reject);call.end(JSON.stringify(body));});
     if(response.status===200)accepted[receiver].set(command.commandId,body);res.writeHead(response.status,response.headers);res.end(response.body);
    }catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"owned-receiver-refused"}');}
   });servers.push(server);await new Promise(done=>server.listen(0,'127.0.0.1',done));origins[receiver]='https://127.0.0.1:'+server.address().port;
  }
  const admissionFile=join(directory,'gateway-admission.json'),candidateSha256='a'.repeat(64),releaseId='owned-known-ack';
  const save=recovery=>writeFileSync(admissionFile,JSON.stringify({version:1,environment:'staging',candidateSha256,releaseId,actionId:'owned-known-ack',newWork:false,recovery}));save(true);
  const canonical=value=>JSON.stringify(value,(_key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))):child);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const config={issuer:'https://oidc.vercel.com/test-team',audience:'https://vercel.com/test-team',subject:'owner:test-team:project:test-project:environment:production',ownerId:VERCEL_PROJECT_BINDINGS.teamId,projectId:VERCEL_PROJECT_BINDINGS.stagingProjectId,
   environment:'production',appEnv:'staging',publicHost:'api-staging.lashher.com',courseOrigin:origins.course,communityOrigin:origins.community,tlsKeyFile:key,tlsCertFile:certificate,upstreamCaFile:certificate,admission:{file:admissionFile,candidateSha256,releaseId}};
  const now=Date.now();let faultEnabled=true;
  const gateway=createGateway(config,{verify:async proof=>{assert.equal(proof,process.env.VERCEL_OIDC_TOKEN);return{projectId:config.projectId};},certificationFault(reviewed){
   const raw=Buffer.from(JSON.stringify(reviewed)),processBinding=p2GatewayProcessBinding({bootId:'00000000-0000-4000-8000-000000000005',pid:1,startTicks:'123'});
   const lease={version:1,environment:'staging',profile:'lifecycle-known-command-v1',stageId:'owned-known-ack',releaseId,candidateSha256,configurationSha256:'b'.repeat(64),gatewayConfigurationSha256:hash(raw),gatewayProcessSha256:processBinding,gatewayImageSha256:'c'.repeat(64),
    sourceWitnessSha256:hash(canonical(command)),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+120000).toISOString(),maxMatches:1,mode:'drop-after-ack',receiver:'course',record:{commandId:command.commandId,accountVersion:1,canonicalSha256:hash(canonical(command))}};
   return createP2CertificationFault({...reviewed,admission:{...reviewed.admission,file:'/admission/state.json'}},{readLease:()=>faultEnabled?Buffer.from(JSON.stringify(lease)):null,readGateway:()=>raw,processBinding:()=>processBinding,emit:value=>effects.push(value)});
  }});servers.push(gateway.server);await new Promise(done=>gateway.server.listen(0,'127.0.0.1',done));
  globalThis.fetch=(value,options={})=>{const selected=new URL(typeof value==='string'||value instanceof URL?value:value.url);assert.equal(selected.origin,'https://gateway.owned.invalid');const headers=Object.fromEntries(new Headers(options.headers));headers.host='api-staging.lashher.com';return new Promise((resolve,reject)=>{
   const req=httpsRequest({hostname:'127.0.0.1',port:gateway.server.address().port,path:selected.pathname,method:options.method,servername:'api-staging.lashher.com',ca:readFileSync(certificate),headers,signal:options.signal},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const body=Buffer.concat(chunks);let code;try{code=JSON.parse(body)?.error?.code;}catch{}fetchObservations.push({status:res.statusCode,code});resolve(new Response(body,{status:res.statusCode,headers:res.headers}));});
   });req.on('error',reject);req.end(options.body);
  });};
  await operator.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))',['lash-her:private-db:migrations']);
  const journal=hash(JSON.stringify((await operator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows));
  const allJournals=async()=>{
   const result={frontend:hash(JSON.stringify((await operator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows))};
   for(const service of ['course','community']){
    const client=new Client({host:target.host,port,database:input.apis[service].database.database,user:target.user,password,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});
    try{await client.connect();result[service]=hash(JSON.stringify((await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows));}
    finally{await client.end();}
   }
   return result;
  };
  const journalsBefore=await allJournals();
  let opened=await withOwner(()=>changeFrontendAdmission(operator,{environment:'staging',targetSha256},'1',{newWork:false,recovery:true}));
  const marker=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');await operator.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))',[marker]);
  const backend=(await operator.query('SELECT pg_catalog.pg_backend_pid() AS pid,backend_start::text AS started FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()')).rows[0];
  const backendDeadline=new Date(Date.now()+900000).toISOString(),backendFaults=[];
  phase='actual-backend-readonly-eligibility';
  const databases={},models={};
  for(const service of ['course','community']){
   const api=input.apis[service],require=createRequire(join(api.root,'package.json')),{drizzle}=require('drizzle-orm/node-postgres');
   const client=new Client({...api.database,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});await client.connect();backendClients.push(client);databases[service]=client;models[service]=drizzle(client);
  }
  const load=(service,file)=>import(pathToFileURL(join(input.apis[service].root,file)).href);
  phase='backend-missing-evidence-refusal';
  // An empty database has no scheduler/control evidence and is ineligible.
  await assert.rejects(observeKnownAckBackend(databases.course,'course',backendDeadline));
  const emptyCommunity=await observeKnownAckBackend(databases.community,'community',backendDeadline);
  assert.equal(emptyCommunity.eligible.reconciliationSchedule,1);assert.equal(emptyCommunity.eligible.retentionSchedule,1);
  backendFaults.push({name:'missing-scheduler-receipts',service:'community',backend:emptyCommunity});
  phase='backend-actual-source-scheduler-baseline';
  const publisher=(await load('course','src/integrations/community/persistence/drizzle-publisher.repository.ts')).createDrizzleCommunityEnrollmentPublisherRepository(models.course);
  await publisher.getControl();
  phase='backend-source-snapshot-repository';
  const entitlement=(await load('course','src/entitlements/entitlement.repository.ts')).createDrizzleEntitlementCommandRepository(models.course);
  const snapshots=(await load('course','src/integrations/community/community-read.repository.ts')).createDrizzleCommunityReadRepository(models.course,entitlement);
  const store=new (await load('community','src/integrations/course/reconciliation/drizzle-reconciliation-store.ts')).DrizzleReconciliationStore(models.community);
  phase='backend-source-coordinator-construction';
  const coordinator=(await load('community','src/integrations/course/reconciliation/reconciliation.ts')).createReconciliationCoordinator({store,snapshots:{
   createSnapshot:async idempotencyKey=>{const value=await snapshots.requestSnapshot({idempotencyKey});return{...value.snapshot,idempotentReplay:value.isReplay};},
   getSnapshot:snapshotId=>snapshots.getSnapshot(snapshotId),getSnapshotItems:value=>snapshots.listSnapshotItems(value)
  }});
  phase='backend-source-schedule-request';await coordinator.requestScheduled();
  phase='backend-source-snapshot-build';assert.equal((await snapshots.buildNextSnapshot()).status,'ready');
  phase='backend-source-schedule-completion';let scheduleOutcome='waiting';
  for(let step=0;step<10&&scheduleOutcome==='waiting';step++)scheduleOutcome=await coordinator.advance();
  assert.equal(scheduleOutcome,'completed');
  phase='backend-actual-source-retention-baseline';
  const retention=(await load('community','src/ops/retention.ts')).createCompletedEnrollmentRetention(models.community);
  await retention.run({now:new Date(Date.now()-86400000+300000),operatorId:'owned-source-retention',reason:'owned_due_scheduler_receipt'});
  await databases.community.query('BEGIN');
  try{
   // Retain the actual source-created old start receipt while modeling loss of
   // its latest completion row. Never update immutable operational evidence.
   await databases.community.query("DELETE FROM course_enrollment_operations WHERE action='retention_run' AND details->>'outcome'='completed'");
   const dueRetention=await observeKnownAckBackend(databases.community,'community',backendDeadline);assert.equal(dueRetention.eligible.retentionSchedule,1);
   backendFaults.push({name:'community-retention-schedule-horizon',service:'community',backend:dueRetention});
  }finally{await databases.community.query('ROLLBACK');}
  await retention.run({now:new Date(),operatorId:'owned-source-retention',reason:'owned_scheduler_baseline'});
  const backendBefore={};for(const service of ['course','community']){
   backendBefore[service]=await observeKnownAckBackend(databases[service],service,backendDeadline);assert.ok(Object.values(backendBefore[service].eligible).every(value=>value===0));
  }
  const fault=async(name,service,mutate,eligible)=>{
   phase='backend-'+name;
   const client=databases[service];assert.deepEqual(await observeKnownAckBackend(client,service,backendDeadline),backendBefore[service]);await client.query('BEGIN');
   try{await mutate(client);let actual=null;
    if(eligible===null)await assert.rejects(observeKnownAckBackend(client,service,backendDeadline));
    else{actual=await observeKnownAckBackend(client,service,backendDeadline);if(eligible)assert.ok(actual.eligible[eligible]>0);else{assert.ok(Object.values(actual.eligible).every(value=>value===0));assert.notEqual(actual.snapshotSha256,backendBefore[service].snapshotSha256);}}
    backendFaults.push({name,service,backend:actual});
   }finally{await client.query('ROLLBACK');}
   assert.deepEqual(await observeKnownAckBackend(client,service,backendDeadline),backendBefore[service]);
  };
  await fault('missing-course-control','course',client=>client.query('DELETE FROM community_enrollment_publisher_control'),null);
  await fault('projection-completeness-bound','course',client=>client.query("INSERT INTO community_enrollment_outbox_operations(target_type,target_id,action,operator_id,reason,previous_state,resulting_state) SELECT 'publisher','publisher','status_inspect','owned','owned','running','running' FROM pg_catalog.generate_series(1,1001)"),null);
  const seedOutbox=async(client,state='pending',leased=false)=>{
   const user=randomUUID(),course=randomUUID(),stream=randomUUID(),event=randomUUID();
   await client.query('INSERT INTO users(id) VALUES($1)',[user]);await client.query("INSERT INTO courses(id,slug,title) VALUES($1,$2,'Owned')",[course,'owned-'+course]);
   await client.query("INSERT INTO community_enrollment_streams(id,user_id,course_id,state,effective_at) VALUES($1,$2,$3,'active',now())",[stream,user,course]);
   await client.query("INSERT INTO community_enrollment_outbox(event_id,stream_id,stream_version,canonical_body,canonical_digest,state,available_at,delivered_at,lease_owner,lease_expires_at) VALUES($1,$2,1,'{}',$3,$4,now()+interval '2 hours',CASE WHEN $4='delivered' THEN now() ELSE NULL END,$5,CASE WHEN $5::text IS NOT NULL THEN now()+interval '2 hours' ELSE NULL END)",[event,stream,'a'.repeat(64),state,leased?'owned-lease':null]);
  };
  await fault('future-course-outbox','course',client=>seedOutbox(client),'outbox');
  await fault('course-outbox-lease','course',client=>seedOutbox(client,'delivered',true),'outbox');
  await fault('completed-course-effect-projection','course',client=>seedOutbox(client,'delivered'),false);
  await fault('course-snapshot-work','course',client=>client.query("UPDATE community_enrollment_snapshots SET status='requested'"),'snapshots');
  await fault('course-snapshot-expiry-horizon','course',client=>client.query("UPDATE community_enrollment_snapshots SET expires_at=now()+interval '5 minutes'"),'snapshots');
  await fault('course-retention-horizon','course',client=>client.query("INSERT INTO community_enrollment_outbox_operations(target_type,target_id,action,operator_id,reason,previous_state,resulting_state,created_at) VALUES('publisher','publisher','status_inspect','owned','owned','running','running',now()-interval '180 days')"),'retention');
  await fault('course-media-horizon','course',async client=>{
   const course=randomUUID(),lessonModule=randomUUID(),lesson=randomUUID();
   await client.query("INSERT INTO courses(id,slug,title) VALUES($1,$2,'Owned')",[course,'owned-'+course]);
   await client.query("INSERT INTO modules(id,course_id,slug,title,position) VALUES($1,$2,'owned','Owned',1)",[lessonModule,course]);
   await client.query("INSERT INTO lessons(id,module_id,slug,title,position) VALUES($1,$2,'owned','Owned',1)",[lesson,lessonModule]);
   await client.query("INSERT INTO video_assets(lesson_id,managed_by_course,provider_environment_id,status,recovery_next_attempt_at) VALUES($1,true,'owned','ready',now()+interval '5 minutes')",[lesson]);
  },'media');
  for(const service of ['course','community'])await fault(service+'-export-expiry-horizon',service,async client=>{
   const id=randomUUID(),user=randomUUID();await client.query("INSERT INTO account_lifecycle_commands(command_id,user_id,account_version,action,canonical_digest,issued_at,accepted_at) VALUES($1,$2,1,'export',$3,now(),now())",[id,user,'a'.repeat(64)]);
   await client.query("INSERT INTO account_lifecycle_exports(command_id,user_id,account_version,data,ready_at,expires_at) VALUES($1,$2,1,'{}',now()-interval '24 hours'+interval '5 minutes',now()+interval '5 minutes')",[id,user]);
  },'exports');
  await fault('future-community-repair','community',client=>client.query("INSERT INTO course_enrollment_repairs(stream_id,minimum_version,next_attempt_at) VALUES($1,1,now()+interval '2 hours')",[randomUUID()]),'repairs');
  await fault('completed-community-effect-projection','community',client=>client.query("INSERT INTO course_enrollment_projections(stream_id,user_id,course_id,state,applied_version,highest_observed_version,status,source,effective_at) VALUES($1,$2,$3,'active',1,1,'current','event',now())",[randomUUID(),randomUUID(),randomUUID()]),false);
  await fault('community-reconciliation-work','community',client=>client.query("UPDATE course_enrollment_reconciliations SET status='running'"),'reconciliations');
  await fault('community-reconciliation-schedule-horizon','community',client=>client.query("UPDATE course_enrollment_reconciliations SET requested_at=now()-interval '24 hours'+interval '5 minutes'"),'reconciliationSchedule');
  const projection={version:1,commandId:command.commandId,commandSha256:hash(canonical(command)),accountVersion:'1',windowEpoch:opened.epoch,backendDeadline};
  const readAll=async()=>{
   const frontend={...projection,service:'frontend',target,owner,marker,backendPid:backend.pid,backendStart:backend.started,targetSha256};
   const front=await observeKnownAckSql(frontend,{getUrl:()=>`postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`});
   const receipts={frontend:front};
   for(const service of ['course','community']){const api=input.apis[service],selected={...projection,service,target:{...api.database,serverMajor:input.postgresMajor,roleOid:api.roleOid}};delete selected.target.password;
    receipts[service]=await observeKnownAckSql(selected,{getUrl:()=>readKnownAckRuntimeDatabaseUrl({NODE_ENV:'production',DATABASE_TARGET:'staging',
      STAGING_DATABASE_URL:`postgresql://${api.database.user}:${password}@127.0.0.1:${port}/${api.database.database}?sslmode=verify-full`,DATABASE_URL:'unrelated-generic-binding'})});
   }
   assert.deepEqual(await observeKnownAckSql(frontend,{getUrl:()=>`postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`}),front);return receipts;
  };
  const before=await readAll();assert.equal(before.frontend.outstanding.length,2);assert.equal(before.frontend.exports,0);assert.equal(before.course.command,null);assert.equal(before.community.command,null);
  assert.equal((await ledger()).length,0);assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:0});
  const nativeInitialEpoch=opened.epoch;
  opened=await withOwner(()=>changeFrontendAdmission(operator,{environment:'staging',targetSha256},opened.epoch,{newWork:false,recovery:true}));
  projection.windowEpoch=opened.epoch;
  phase='actual-first-whole-route-drop';const first=await GET(new Request('https://owned-known-ack.vercel.app/api/cron/account-lifecycle',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}));await first.arrayBuffer();await pause(50);
  const firstLedger=await ledger(),firstDeliveries=(await operator.query('SELECT receiver,status,attempts,lease_id::text,lease_until FROM customer_account_deliveries ORDER BY receiver')).rows;
  observed={http:first.status,ledgerStates:firstLedger.map(row=>row.state),effectCount:effects.length,gatewayUncertain:gateway.admissionState().uncertain,courseAccepted:accepted.course.size,communityAccepted:accepted.community.size,gatewayCounters:gateway.counters,fetchObservations};assert.equal(first.status,503);assert.equal(firstLedger.length,1);assert.equal(first.headers.get('x-request-id'),firstLedger[0].id);assert.equal(effects.length,1);assert.equal(effects[0].upstreamReceiptVerified,true);
  const firstState=firstLedger[0].state;assert.equal(firstState,'uncertain');assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:1});assert.equal(accepted.course.size,1);
  phase='actual-normal-replay';faultEnabled=false;
  const deadline=performance.now()+120000;
  while((await operator.query("SELECT count(*)::int AS count FROM customer_account_deliveries WHERE status='pending' AND next_run_at<=pg_catalog.clock_timestamp()")).rows[0].count===0){assert.ok(performance.now()<deadline);await pause(100);}
  const second=await GET(new Request('https://owned-known-ack.vercel.app/api/cron/account-lifecycle',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}));await second.arrayBuffer();await pause(50);
  const finalLedger=await ledger(),finalDeliveries=(await operator.query('SELECT receiver,status,attempts,lease_id::text,lease_until FROM customer_account_deliveries ORDER BY receiver')).rows;
  assert.equal(second.status,200);assert.equal(finalLedger.length,2);assert.equal(second.headers.get('x-request-id'),finalLedger[1].id);assert.equal(finalLedger[1].state,'completed');assert.equal(finalLedger[0].state,firstState);
  assert.ok(finalDeliveries.every(row=>row.status==='acknowledged'&&row.lease_id===null&&row.lease_until===null));assert.equal(accepted.course.size,1);assert.equal(accepted.community.size,1);
  phase='actual-canonical-three-database-domain-proof';const domain=await readAll();
  assert.equal(domain.frontend.outstanding.length,0);assert.equal(domain.frontend.admission.uncertain,1);
  for(const service of ['course','community']){assert.equal(domain[service].command.commandSha256,projection.commandSha256);assert.equal(domain[service].command.userBindingSha256,domain.frontend.userBindingSha256);assert.equal(domain[service].command.accountStatus,'suspended');assert.equal(domain[service].command.accountVersion,'1');}
  phase='source-known-ack-domain-reducer';
  const reducerProgram=String.raw`
import copy,json,sys
sys.path.insert(0,sys.argv[1])
import p2_known_ack_loss as source
value=json.load(sys.stdin);plan=value['plan'];before=value['before'];domain=value['domain'];gateway=value['gateway'];effects=value['effects']
source.validate_baseline(plan,before)
assert source.validate_domain(plan,before,domain,gateway,effects)=={'operationId':value['operationId']}
backend_faults=0
for item in value['backendFaults']:
    actual=copy.deepcopy(before);actual[item['service']]['backend']=item['backend']
    try:source.validate_backend_idle(actual,before)
    except ValueError:backend_faults+=1
    else:raise AssertionError('backend fault accepted '+item['name'])
assert backend_faults==len(value['backendFaults']) and backend_faults>=14
faults=0
for kind in ('other-work','later-version','extra-effect','producer','command','missing-ack','extra-attempt','canonical-receiver','global-unknown','gateway-unknown','extra-prior-completed'):
    actual=copy.deepcopy(domain);observed=copy.deepcopy(gateway);injected=copy.deepcopy(effects)
    if kind=='other-work':actual['frontend']['exports']=1
    elif kind=='later-version':actual['frontend']['later']=1
    elif kind=='extra-effect':injected+=injected
    elif kind=='producer':actual['frontend']['operations'][0]['producer_sha256']='f'*64
    elif kind=='command':actual['frontend']['commandSha256']='f'*64
    elif kind=='missing-ack':actual['frontend']['deliveries'][0]['acknowledged_at']=None
    elif kind=='extra-attempt':actual['frontend']['deliveries'][0]['attempts']+=1
    elif kind=='canonical-receiver':actual['course']['command']['commandSha256']='f'*64
    elif kind=='global-unknown':actual['frontend']['admission']['uncertain']=2
    elif kind=='gateway-unknown':observed['admission']['uncertain']['recovery']=2
    elif kind=='extra-prior-completed':
        extra=copy.deepcopy(actual['frontend']['operations'][1]);extra['id']='00000000-0000-4000-8000-000000000098';actual['frontend']['operations'].append(extra)
    try:source.validate_domain(plan,before,actual,observed,injected)
    except ValueError:faults+=1
    else:raise AssertionError('owned reducer accepted '+kind)
assert faults==11
try:source.require_known_ack_loss_authorization({'status':'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED'},object(),'owned-replacement')
except ValueError:pass
else:raise AssertionError('plain receipt issued replacement authority')
print(json.dumps({'status':'P2_KNOWN_ACK_SOURCE_DOMAIN_REDUCER_PASS','faultRefusals':faults,'backendFaultRefusals':backend_faults,'plainReceiptAuthorityRefused':True,'authorityIssued':False}))
`;
  const reducerPlan={commandSha256:projection.commandSha256,receiver:'course',nativePlan:{initialEpoch:nativeInitialEpoch,sourceCommit,producer:{producerSha256:'b'.repeat(64),role:{oid:runtime.oid}},commandWitnesses:[{commandId:command.commandId,accountVersion:'1',action:'suspend'}]}};
  const reducer=spawnSync('python3',['-I','-c',reducerProgram,fileURLToPath(new URL('../host/',import.meta.url))],{input:JSON.stringify({plan:reducerPlan,before,domain,backendFaults,gateway:{admission:gateway.admissionState()},effects,operationId:firstLedger[0].id}),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}});
  assert.equal(reducer.status,0);const reducerResult=JSON.parse(reducer.stdout);assert.equal(reducerResult.status,'P2_KNOWN_ACK_SOURCE_DOMAIN_REDUCER_PASS');
  phase='actual-domain-fault-refusal';let canonicalFaultRefusals=0,immutableReceiptRewriteRefusals=0;
  for(const service of ['course','community']){
   const api=input.apis[service],client=new Client({...api.database,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});await client.connect();
   try{
    phase='receipt-immutability-'+service;await assert.rejects(client.query('UPDATE account_lifecycle_commands SET canonical_digest=$1 WHERE command_id=$2',['f'.repeat(64),command.commandId]),error=>error.code===({course:'23514',community:'P0001'}[service]));immutableReceiptRewriteRefusals++;
    assert.deepEqual(await readAll(),domain);
    phase='canonical-binding-'+service;const selected={...projection,commandSha256:'f'.repeat(64),service,target:{...api.database,serverMajor:input.postgresMajor,roleOid:api.roleOid}};delete selected.target.password;
    await assert.rejects(observeKnownAckSql(selected,{getUrl:()=>`postgresql://${api.database.user}:${password}@127.0.0.1:${port}/${api.database.database}?sslmode=verify-full`}));canonicalFaultRefusals++;
    assert.deepEqual(await readAll(),domain);
    assert.equal((await ledger()).filter(row=>row.state==='uncertain').length,1);assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:1});
   }finally{await client.end();}
  }
  assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:1});assert.deepEqual(gateway.admissionState().active,{newWork:0,recovery:0});
  const closed=await withOwner(()=>changeFrontendAdmission(operator,{environment:'staging',targetSha256},opened.epoch,{newWork:false,recovery:false}));save(false);
  const beforeSettlement=await readAll();
  phase='specific-frontend-operation-reconciliation';const evidenceSha256=hash(canonical({domain,effect:effects[0],firstOperationId:firstLedger[0].id}));
  await withOwner(()=>reconcileFrontendOperation(operator,{environment:'staging',targetSha256},closed.epoch,firstLedger[0].id,evidenceSha256));
  const settled=await readAll();assert.equal(settled.frontend.admission.active,0);assert.equal(settled.frontend.admission.uncertain,0);assert.equal(settled.frontend.operations.find(row=>row.id===firstLedger[0].id).reconciliation_sha256,evidenceSha256);
  assert.deepEqual(settled.course,domain.course);assert.deepEqual(settled.community,domain.community);assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:1});
  const settlementProgram=String.raw`
import copy,json,sys
sys.path.insert(0,sys.argv[1])
import p2_known_ack_loss as source
value=json.load(sys.stdin)
source.validate_settled(value['plan'],value['before'],value['after'],value['operationId'],value['receiptSha256'])
bad=copy.deepcopy(value['after']);extra=copy.deepcopy(bad['frontend']['operations'][1]);extra['id']='00000000-0000-4000-8000-000000000099';bad['frontend']['operations'].append(extra)
try:source.validate_settled(value['plan'],value['before'],bad,value['operationId'],value['receiptSha256'])
except ValueError:pass
else:raise AssertionError('new completed operation was hidden by global zero')
print(json.dumps({'status':'P2_KNOWN_ACK_SPECIFIC_SETTLEMENT_REDUCER_PASS','extraCompletedOperationRefused':True,'authorityIssued':False}))
`;
  const settlementResult=spawnSync('python3',['-I','-c',settlementProgram,fileURLToPath(new URL('../host/',import.meta.url))],{input:JSON.stringify({plan:reducerPlan,before:beforeSettlement,after:settled,operationId:firstLedger[0].id,receiptSha256:evidenceSha256}),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}});
  assert.equal(settlementResult.status,0);const settlementProof=JSON.parse(settlementResult.stdout);assert.equal(settlementProof.status,'P2_KNOWN_ACK_SPECIFIC_SETTLEMENT_REDUCER_PASS');
  assert.equal(hash(JSON.stringify((await operator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows)),journal);
  const journalsAfter=await allJournals();assert.deepEqual(journalsAfter,journalsBefore);
  return{version:1,status:'P2_KNOWN_ACK_WHOLE_ROUTE_PASS',actualAppCron:true,actualDispatcher:true,actualTlsGateway:true,actualTlsReceivers:true,actualCanonicalApiReceivers:true,actualThreeDatabaseDomainProof:true,actualTlsPostgres:true,actualProvider:false,modeledOidc:true,
   firstHttpStatus:first.status,firstFrontendLedgerState:firstState,firstFrontendUncertain:firstLedger.filter(row=>row.state==='uncertain').length,firstGatewayUncertain:1,firstDeliveries,
   replayHttpStatus:second.status,finalFrontendUncertain:finalLedger.filter(row=>row.state==='uncertain').length,finalGatewayUncertain:1,finalDeliveries,sourceTraceMatchesOperation:traces.length===2&&traces.every((row,index)=>row.operationId===finalLedger[index].id),
   settledFrontendUncertain:settled.frontend.admission.uncertain,specificFrontendOperationReconciled:true,gatewayCounterReset:false,domainProofSha256:hash(canonical(domain)),
   canonicalFaultRefusals,immutableReceiptRewriteRefusals,sourceDomainReducer:reducerResult,sourceSettlementReducer:settlementProof,
   backendEligibility:{actualReadOnlyProjections:true,sourceSchedulerBaseline:true,sourceRetentionBaseline:true,faultRefusals:backendFaults.length,
    faultNames:backendFaults.map(value=>value.name),entireParentHorizonSeconds:900,liveWorkerProcesses:false},
   journalSha256Before:journalsBefore,journalSha256After:journalsAfter,allThreeJournalsUnchanged:true,
   noSqlReplay:true,noRoleChange:true,noRuntimeRestart:true,fixtureOnly:true};
 }finally{console.info=originalInfo;globalThis.fetch=originalFetch;for(const server of servers){server.closeAllConnections();await new Promise(done=>server.close(done));}for(const receiver of children){try{await receiver.request('stop');}catch{receiver.child.kill('SIGKILL');}}for(const client of backendClients)await client.end();await closePool?.();await operator.end();}
}
main().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error(JSON.stringify({status:'P2_KNOWN_ACK_WHOLE_ROUTE_FAILED',phase,observed}));process.exitCode=1;});
