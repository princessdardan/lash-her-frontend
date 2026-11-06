// Actual exported cron/store/dispatcher through real TLS gateway ACK loss.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer,request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {fork} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from 'pg';
import {createGateway} from '../../gateway/server.mjs';
import {createP2CertificationFault,p2GatewayProcessBinding} from '../../gateway/p2-certification-fault.mjs';
import {changeFrontendAdmission,reconcileFrontendOperation} from '../frontend-admission.mjs';
import {observeKnownAckSql} from '../p2-known-ack-loss-probe.mjs';
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
 const fetchObservations=[],servers=[],children=[],effects=[],accepted={course:new Map(),community:new Map()},originalFetch=globalThis.fetch,originalInfo=console.info,traces=[];let closePool;
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
  const opened=await withOwner(()=>changeFrontendAdmission(operator,{environment:'staging',targetSha256},'1',{newWork:false,recovery:true}));
  const marker=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');await operator.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))',[marker]);
  const backend=(await operator.query('SELECT pg_catalog.pg_backend_pid() AS pid,backend_start::text AS started FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()')).rows[0];
  const projection={version:1,commandId:command.commandId,commandSha256:hash(canonical(command)),accountVersion:'1',windowEpoch:opened.epoch};
  const readAll=async()=>{
   const frontend={...projection,service:'frontend',target,owner,marker,backendPid:backend.pid,backendStart:backend.started,targetSha256};
   const front=await observeKnownAckSql(frontend,{getUrl:()=>`postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`});
   const receipts={frontend:front};
   for(const service of ['course','community']){const api=input.apis[service],selected={...projection,service,target:{...api.database,serverMajor:input.postgresMajor,roleOid:api.roleOid}};delete selected.target.password;
    receipts[service]=await observeKnownAckSql(selected,{getUrl:()=>`postgresql://${api.database.user}:${password}@127.0.0.1:${port}/${api.database.database}?sslmode=verify-full`});
   }
   assert.deepEqual(await observeKnownAckSql(frontend,{getUrl:()=>`postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`}),front);return receipts;
  };
  const before=await readAll();assert.equal(before.frontend.outstanding.length,2);assert.equal(before.frontend.exports,0);assert.equal(before.course.command,null);assert.equal(before.community.command,null);
  assert.equal((await ledger()).length,0);assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:0});
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
  phase='specific-frontend-operation-reconciliation';const evidenceSha256=hash(canonical({domain,effect:effects[0],firstOperationId:firstLedger[0].id}));
  await withOwner(()=>reconcileFrontendOperation(operator,{environment:'staging',targetSha256},closed.epoch,firstLedger[0].id,evidenceSha256));
  const settled=await readAll();assert.equal(settled.frontend.admission.active,0);assert.equal(settled.frontend.admission.uncertain,0);assert.equal(settled.frontend.operations.find(row=>row.id===firstLedger[0].id).reconciliation_sha256,evidenceSha256);
  assert.deepEqual(settled.course,domain.course);assert.deepEqual(settled.community,domain.community);assert.deepEqual(gateway.admissionState().uncertain,{newWork:0,recovery:1});
  assert.equal(hash(JSON.stringify((await operator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows)),journal);
  return{version:1,status:'P2_KNOWN_ACK_WHOLE_ROUTE_PASS',actualAppCron:true,actualDispatcher:true,actualTlsGateway:true,actualTlsReceivers:true,actualCanonicalApiReceivers:true,actualThreeDatabaseDomainProof:true,actualTlsPostgres:true,actualProvider:false,modeledOidc:true,
   firstHttpStatus:first.status,firstFrontendLedgerState:firstState,firstFrontendUncertain:firstLedger.filter(row=>row.state==='uncertain').length,firstGatewayUncertain:1,firstDeliveries,
   replayHttpStatus:second.status,finalFrontendUncertain:finalLedger.filter(row=>row.state==='uncertain').length,finalGatewayUncertain:1,finalDeliveries,sourceTraceMatchesOperation:traces.length===2&&traces.every((row,index)=>row.operationId===finalLedger[index].id),
   settledFrontendUncertain:settled.frontend.admission.uncertain,specificFrontendOperationReconciled:true,gatewayCounterReset:false,domainProofSha256:hash(canonical(domain)),
   canonicalFaultRefusals,immutableReceiptRewriteRefusals,
   noSqlReplay:true,noRoleChange:true,noRuntimeRestart:true,fixtureOnly:true};
 }finally{console.info=originalInfo;globalThis.fetch=originalFetch;for(const server of servers){server.closeAllConnections();await new Promise(done=>server.close(done));}for(const receiver of children){try{await receiver.request('stop');}catch{receiver.child.kill('SIGKILL');}}await closePool?.();await operator.end();}
}
main().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error(JSON.stringify({status:'P2_KNOWN_ACK_WHOLE_ROUTE_FAILED',phase,observed}));process.exitCode=1;});
