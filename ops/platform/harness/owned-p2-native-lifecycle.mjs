// Actual app GET/admission/store/HTTP receivers with an OWNED scheduler model.
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {randomUUID,createHmac} from 'node:crypto';
import {Client} from 'pg';
import {prepareP2LifecycleNativePlan,qualifyP2LifecycleNative,p2NativeHash} from '../p2-lifecycle-native.mjs';
import {nativeDocuments,nativeObservation} from './p2-native-unit-fixture.mjs';
import {changeFrontendAdmission} from '../frontend-admission.mjs';
import {withFrontendEnvironmentLock} from '../frontend-environment-lock.mjs';

let phase='ownership';
async function main(){
  assert.equal(process.env.P2_NATIVE_OWNED_CHILD,'true');const privateInput=JSON.parse(readFileSync(0,'utf8'));
  const {port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit}=privateInput;
  assert.equal(target.host,'127.0.0.1');assert.equal(target.database,'frontend_admission_owned');assert.equal(target.port,port);assert.equal(target.serverMajor,16);
  const url=`postgresql://${runtime.name}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`;
  const {VERCEL_PROJECT_BINDINGS}=await import('../../../src/lib/env/application-environment.mjs');
  Object.assign(process.env,{DATABASE_URL:url,FRONTEND_WRITER_ADMISSION_DATABASE_URL:url,FRONTEND_WRITER_ADMISSION_MODE:'enforce',FRONTEND_WRITER_ADMISSION_TARGET_JSON:JSON.stringify({...target,user:runtime.name,targetSha256,environment:'staging'}),
    FRONTEND_WRITER_PRODUCER_SHA256:'b'.repeat(64),VERCEL_GIT_COMMIT_SHA:sourceCommit,APP_ENV:'staging',VERCEL:'1',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:VERCEL_PROJECT_BINDINGS.stagingProjectId,APP_VERCEL_TEAM_ID:VERCEL_PROJECT_BINDINGS.teamId,
    CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED:'true',CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED:'true',LASH_P2_CERTIFICATION_SCHEDULES:'account-lifecycle',CRON_SECRET:`owned-${randomUUID()}`,API_GATEWAY_STAGING_ORIGIN:'https://gateway.owned.invalid',
    COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:`owned-course-${randomUUID()}`,COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:`owned-community-${randomUUID()}`,
    VERCEL_OIDC_TOKEN:`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.owned`});
  const operator=new Client({host:target.host,port,database:target.database,user:target.user,password,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});await operator.connect();
  const originalFetch=globalThis.fetch,originalInfo=console.info,requestContext=new AsyncLocalStorage();let server,closePool;
  const requests=[],receiverCalls=[],checks=[],commandList=[];let nativeEnabled=false,elapsed=0,ticks=0,receiverFailure;
  const connect=async()=>{const client=new Client({host:target.host,port,database:target.database,user:runtime.name,password,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});await client.connect();return client;};
  const record=name=>checks.push(name);
  try{
    phase='actual-source-import';const {GET}=await import('../../../src/app/api/cron/account-lifecycle/route.ts');({closePrivateDbPool:closePool}=await import('../../../src/lib/private-db/client.ts'));
    const withOwner=async task=>{await operator.query(`SET ROLE "${owner.name}"`);try{return await task();}finally{await operator.query('RESET ROLE');}};
    const producer={producerSha256:'b'.repeat(64),role:runtime};
    const customerId=randomUUID();await operator.query("INSERT INTO customer_users(id,email,status,account_version) VALUES($1,'owned-native@example.invalid','suspended',2)",[customerId]);
    for(const [index,action]of ['suspend','restore'].entries()){
      const command={version:1,commandId:randomUUID(),userId:customerId,accountVersion:index+1,action,issuedAt:new Date(Date.now()+index).toISOString()};commandList.push(command);
      await operator.query('INSERT INTO customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command) VALUES($1,$2,$3,$4,$5,$6,$7)',[command.commandId,customerId,command.accountVersion,randomUUID(),action,command.issuedAt,JSON.stringify(command)]);
      for(const receiver of ['course','community'])await operator.query("INSERT INTO customer_account_deliveries(command_id,receiver,status) VALUES($1,$2,'pending')",[command.commandId,receiver]);
    }
    let epoch=(await withOwner(()=>changeFrontendAdmission(operator,{environment:'staging',targetSha256},'1',{newWork:true,recovery:true}))).epoch;
    const docs=nativeDocuments(target);Object.assign(docs.settings,{epoch,owner,producer,targetSha256,commandWitnesses:commandList.map(row=>({commandId:row.commandId,accountVersion:String(row.accountVersion),action:row.action}))});
    const plan=prepareP2LifecycleNativePlan(docs.candidate,docs.settings);assert.equal(plan.sourceCommit,sourceCommit);
    console.info=line=>{if(typeof line==='string'&&line.includes('P2_LIFECYCLE_CRON_ADMITTED')){const request=requestContext.getStore();assert.ok(request);request.lines.push(line);}else throw Error('OWNED_UNEXPECTED_LOG');};
    server=createServer({key:readFileSync(key),cert:readFileSync(certificate)},async(req,res)=>{
      try{
        if(req.url===plan.schedule.path){const observation={id:`owned-provider-${randomUUID()}`,lines:[],startedAt:new Date().toISOString()};
          const response=await requestContext.run(observation,()=>GET(new Request(`https://owned-native.vercel.app${req.url}`,{headers:{authorization:req.headers.authorization??''}})));
          observation.completedAt=new Date().toISOString();observation.status=response.status;requests.push(observation);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}
        if(/^\/(course|community)\/v1\/internal\/accounts\/commands$/u.test(req.url)&&req.method==='POST'){
          const chunks=[];for await(const chunk of req)chunks.push(chunk);const command=JSON.parse(Buffer.concat(chunks));const receiver=req.url.split('/')[1];assert.deepEqual(command,commandList.find(row=>row.commandId===command.commandId));
          assert.equal(req.headers['x-idempotency-key'],command.commandId);assert.equal(req.headers['x-lash-workload-token'],process.env.VERCEL_OIDC_TOKEN);
          const parts=req.headers.authorization.slice(7).split('.');assert.equal(parts[2],createHmac('sha256',process.env[`${receiver.toUpperCase()}_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET`]).update(`${parts[0]}.${parts[1]}`).digest('base64url'));
          const active=await withOwner(async()=> (await operator.query("SELECT id::text,kind FROM frontend_admission.operations WHERE state='active'")).rows);assert.equal(active.length,1);assert.equal(active[0].kind,'recovery');
          const prior=receiverCalls.filter(row=>row.receiver===receiver);assert.equal(command.accountVersion,prior.length+1);receiverCalls.push({receiver,commandId:command.commandId,accountVersion:command.accountVersion,operationId:active[0].id});
          res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({commandId:command.commandId,accountVersion:command.accountVersion,status:'accepted'}));return;
        }
        throw Error('OWNED_UNEXPECTED_HTTP');
      }catch(error){receiverFailure=error;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"owned-request-failed"}');}
    });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`https://127.0.0.1:${server.address().port}`;
    globalThis.fetch=(input,options)=>{const selected=new URL(typeof input==='string'||input instanceof URL?input:input.url);assert.equal(selected.origin,'https://gateway.owned.invalid');return originalFetch(new URL(selected.pathname,origin),options);};
    const actualRequest=()=>originalFetch(origin+plan.schedule.path,{headers:{authorization:`Bearer ${process.env.CRON_SECRET}`}});
    const boundary=()=>({projectId:plan.projectId,deploymentId:plan.deploymentId,sourceCommit:plan.sourceCommit,deploymentUrl:plan.deploymentUrl,configurationRecordSha256:plan.configurationRecordSha256,
      schedule:plan.schedule,featureControls:plan.featureControls,writerAdmissionBinding:plan.writerAdmissionBinding,nativeEnabled});
    const physicalPid=(await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const verifySession=async()=>assert.equal((await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,physicalPid);
    const stageDirectory=join(directory,'native-stage');mkdirSync(stageDirectory,{mode:0o700});
    phase='actual-stage';let result;
    await withFrontendEnvironmentLock(async verifyEnvironment=>{
      await operator.query('SELECT pg_advisory_lock(hashtext($1))',['lash-her:private-db:migrations']);
      const contender=await connect();try{assert.equal((await contender.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',['lash-her:private-db:migrations'])).rows[0].locked,false);}finally{await contender.end();}record('actual-physical-release-lock-contention');
      result=await qualifyP2LifecycleNative({plan,client:operator,directory:stageDirectory,confirmation:`staging/${plan.actionId}`,verifyEnvironment,verifySession,withOwner,
        nativeControl:{observe:async()=>boundary(),observeMetadata:async()=>boundary(),setEnabled:async(_plan,enabled)=>{nativeEnabled=enabled;}},
        clock:{now:()=>elapsed,pause:async milliseconds=>{elapsed+=milliseconds;if(nativeEnabled&&ticks<2){ticks++;const response=await actualRequest();assert.equal(response.status,200);await response.arrayBuffer();}}},
        observeNativeRequests:async()=>{
          // This queued request was modeled at enable, but executes only after
          // native disable AND durable admission closure. It has no trace/row.
          const before=(await withOwner(async()=> (await operator.query('SELECT count(*)::int AS count FROM frontend_admission.operations')).rows[0])).count;
          const response=await actualRequest();assert.equal(response.status,503);await response.arrayBuffer();
          assert.equal((await withOwner(async()=> (await operator.query('SELECT count(*)::int AS count FROM frontend_admission.operations')).rows[0])).count,before);assert.equal(requests.at(-1).lines.length,0);record('actual-delayed-after-disable-request-is-fenced-after-closure-with-no-new-ledger-row-or-trace');
          return requests.map(request=>nativeObservation(plan,{id:request.lines.length?JSON.parse(request.lines[0]).operationId:randomUUID(),epoch:request.lines.length?JSON.parse(request.lines[0]).epoch:epoch},
            {providerRequestId:request.id,startedAt:request.startedAt,completedAt:request.completedAt,httpStatus:request.status,admittedLogLine:request.lines[0]??null}));
        }});
      await operator.query('SELECT pg_advisory_unlock(hashtext($1))',['lash-her:private-db:migrations']);
    },{path:join(directory,'environment.lock')});
    assert.ifError(receiverFailure);assert.equal(result.status,'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED');assert.equal(receiverCalls.length,4);assert.equal(requests.filter(row=>row.status===200).length,2);
    record('actual-exported-cron-full-runtime-admission-context-and-opaque-trace');record('actual-nonempty-and-empty-http-cron-invocations');record('actual-course-community-https-service-jwt-idempotency-and-ordered-command-effects');
    record('actual-event-uuid-source-producer-epoch-role-joins-completed-ledger');record('actual-source-admission-closure-and-global-active-uncertain-zero');
    const operations=await withOwner(async()=> (await operator.query('SELECT id::text,kind,state,epoch::text FROM frontend_admission.operations ORDER BY started_at')).rows);
    assert.equal(operations.length,2);assert.ok(operations.every(row=>row.state==='completed'&&row.kind==='recovery'&&row.epoch!==result.finalAdmission.epoch));
    const stageReceipts=readdirSync(stageDirectory).filter(name=>name.endsWith('.json')).sort().map(name=>{const bytes=readFileSync(join(stageDirectory,name));return{name,sha256:p2NativeHash(bytes),value:JSON.parse(bytes)};});
    const serialized=JSON.stringify({result,receiverCalls,operations,stageReceipts});for(const secret of [password,process.env.CRON_SECRET,process.env.COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET])assert.ok(!serialized.includes(secret));record('private-credentials-not-in-common-evidence');
    return{status:'P2_LIFECYCLE_NATIVE_OWNED_PASS',actualTlsPostgres:true,actualTlsReceivers:true,actualAppCron:true,actualRuntimeTrace:true,actualProvider:false,
      modeledProviderNativeClassification:true,executedChecks:checks.length,skipped:0,checks,result,operations,receiverCalls,stageReceipts,
      sourceModuleSha256:p2NativeHash(readFileSync(new URL('../p2-lifecycle-native.mjs',import.meta.url)))};
  }finally{console.info=originalInfo;globalThis.fetch=originalFetch;if(server)await new Promise(resolve=>server.close(resolve));await closePool?.();await operator.end();}
}
main().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(()=>{process.stderr.write(`${JSON.stringify({status:'P2_NATIVE_OWNED_CHILD_FAILED',phase})}\n`);process.exitCode=1;});
