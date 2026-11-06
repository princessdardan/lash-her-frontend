import assert from 'node:assert/strict';
import test from 'node:test';
import * as file from 'node:fs';
import fsMutable from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import httpsMutable from 'node:https';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {prepareP2qFirstInstallObservation,withP2qFirstInstallDatabaseObservation,readP2qFirstInstallDatabaseObservation} from './p2q-first-install.mjs';
import {ownedP2qObservationFixture} from './test-p2q-first-install-local.mjs';
const current={version:1,id:'staging-current',sha256:'ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba'};
function request(ref){return {qualificationTargetProfile:ref,actionId:'owned-observe',candidate:{version:3,environment:'staging',releaseId:'owned',sources:{frontend:{commit:'b'.repeat(40)}},qualificationTargetProfile:ref,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64)},
 job:{version:2,environment:'staging',releaseId:'owned',sourceCommit:'b'.repeat(40),qualificationTargetProfile:ref,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),target:{host:'127.0.0.1',port:5432,database:'owned',user:'owned_admin',runtimeRole:'owned_runtime',serverMajor:18,allowEmptyBootstrap:true,approvedPendingTags:['0000_owned']}}};}
test('public current and unregistered first-install requests refuse before client or parent work',async()=>{
 for(const [ref,code] of [[current,'QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED'],[{version:1,id:'p2q-20261106',sha256:'a'.repeat(64)},'QUALIFICATION_TARGET_PROFILE_UNKNOWN']]){
  let calls=0;const client={query(){calls++;throw new Error('must not query');}};
  await assert.rejects(withP2qFirstInstallDatabaseObservation(request(ref),{client,verifySession:()=>{calls++;}},()=>{calls++;}),{code});assert.equal(calls,0);
 }
});
test('JSON fresh/zero/authority flags and forged observation handles cannot select a path',async()=>{
 for(const field of ['fresh','firstUseAuthorized','allowAbsentGateway','activeExecutions'])await assert.rejects(prepareP2qFirstInstallObservation({...request(current),[field]:true}),{code:'P2Q_FIRST_INSTALL_REQUEST_REFUSED'});
 await assert.rejects(readP2qFirstInstallDatabaseObservation({observationOnly:true,firstUseAuthorized:false}),{code:'P2Q_FIRST_INSTALL_OBSERVATION_HANDLE_REQUIRED'});
});
test('owned fixture resolver only models selection and emits no install permission',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'p2q-first-install-pure-'));
 try{
  const ref=ownedP2qObservationFixture(directory),collector=await import(pathToFileURL(join(directory,'p2q-first-install.mjs')).href),input=request(ref);
  const plan=await collector.prepareP2qFirstInstallObservation(input);assert.equal(plan.observationOnly,true);
  for(const key of ['firstUseAuthorized','migrationAuthorized','rolePreparationAuthorized','completeDatabaseEmptyProven'])assert.equal(plan[key],false);
  assert.equal(plan.catalogObservationScope,'frontend-core-counts-v1');assert.ok(plan.unobservedCatalogClasses.includes('pg_db_role_setting'));assert.ok(plan.unobservedCatalogClasses.includes('pg_auth_members'));
  for(const mutate of [v=>{v.actionId=true;},v=>{v.candidate.releaseId=v.job.releaseId={password:'NEVER_OUTPUT'};},v=>{v.job.version=1;},v=>{v.candidate.version=2;},v=>{v.job.target.allowEmptyBootstrap=false;},v=>{v.job.qualificationTargetProfile={...ref,sha256:'f'.repeat(64)};}]){const bad=structuredClone(input);mutate(bad);await assert.rejects(collector.prepareP2qFirstInstallObservation(bad));}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('resolved current policy still refuses before transport in the private interface fixture',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'p2q-current-policy-pure-'));
 try{
  const ref=ownedP2qObservationFixture(directory,{version:1,id:'owned-current',kind:'existing-staging',selectionPolicy:'existing-staging-v1',environment:'staging'}),collector=await import(pathToFileURL(join(directory,'p2q-first-install.mjs')).href);
  let calls=0;await assert.rejects(collector.withP2qFirstInstallDatabaseObservation(request(ref),{client:{query(){calls++;}},verifySession:()=>{calls++;}},()=>{calls++;}),{code:'QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED'});assert.equal(calls,0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

// Google cases below execute an exact-source PRIVATE projection: operator UID,
// temp ancestor and CLI/HTTPS observations are models, never production cases.
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const googleProgram=new URL('./p2q-google-project-allocation.mjs',import.meta.url);
async function googleFixture(){
 const root=mkdtempSync(join(tmpdir(),'p2q-google-owned-'));file.chmodSync(root,0o700);
 const cases=join(root,'cases'),handoff=join(root,'handoff');file.mkdirSync(cases,{mode:0o700});file.mkdirSync(handoff,{mode:0o700});
 const source=file.readFileSync(googleProgram,'utf8');
 const projected=source.replace("import {P2Q_GOOGLE_PROJECT_CAPTURE_CASES} from './source-policy.mjs';","const P2Q_GOOGLE_PROJECT_CAPTURE_CASES=Object.freeze({});")
  .replace("const OWNER_UID=0,CASE_ROOT='/var/lib/lash-her/p2q/google-projects';",`const OWNER_UID=${process.getuid()},CASE_ROOT=${JSON.stringify(cases)};`)
  .replace("privatePath(path);let current='/';\n  for(const part of path.split('/').filter(Boolean))",`privatePath(path);demand(path===${JSON.stringify(root)}||path.startsWith(${JSON.stringify(root+'/')}),'PRIVATE_DIRECTORY_REQUIRED');let current=${JSON.stringify(root)};\n  for(const part of relative(current,path).split('/').filter(Boolean))`)
  .replace("'/run/lash-her-p2q-private/'",JSON.stringify(handoff+'/'));
 const path=join(root,'producer.mjs');file.writeFileSync(path,projected+'\nexport const ownedPrivate={casePlan,PrivateCase,execute,cleanAmbient,route,cliArgs,childEnvironment,request,physicalTree,verifyToolchain,readFile,writeFile,parse,principalClaim,claimMayClose,UMASK_WRAPPER};\n');
 const api=(await import(pathToFileURL(path).href)).ownedPrivate;
 const principalPath=join(handoff,'principal.json'),principal='new-owner@example.test';
 const bytes=Buffer.from(JSON.stringify({version:1,principal})+'\n');file.writeFileSync(principalPath,bytes,{mode:0o600});
 const plan={version:1,actionId:'owned-google',programSha256:'a'.repeat(64),project:{projectId:'new-owned-project',displayName:'Owned Project',labels:{purpose:'owned'},parent:null},
  principal:{path:principalPath,sha256:hash(bytes)},bootstrapQuotaProject:null,caseRoot:cases,
  toolchain:{sdk:{root:join(root,'sdk'),device:'1',inode:'1',closureSha256:'b'.repeat(64),approvedSymlinks:{}},
   python:{root:join(root,'python'),device:'1',inode:'2',closureSha256:'c'.repeat(64),approvedSymlinks:{},executable:join(root,'python/bin/python3')},launcher:{relativePath:'bin/gcloud',sha256:'d'.repeat(64)}}};
 return {root,cases,plan:api.casePlan(plan,plan.actionId),principal,api,close:()=>rmSync(root,{recursive:true,force:true})};
}
function googleModel(fixture,options={}){
 const {plan,principal}=fixture,events=[],clock='2026-11-06T12:00:00.000Z';let revoked=false,searches=0,operations=0,created=false;
 const current={name:'projects/123456789012',projectId:plan.project.projectId,displayName:plan.project.displayName,state:'ACTIVE',labels:plan.project.labels,createTime:clock,...(plan.project.parent===null?{}:{parent:plan.project.parent})};
 const operation={name:'operations/cp.123456789012',done:false};
 const raw=(status,value)=>({status,raw:Buffer.from(JSON.stringify(value))});
 const rt={now:()=>clock,wait:async()=>{events.push(['wait']);},verify:async()=>{events.push(['verify']);return {sourceCommit:'e'.repeat(40),sourceClosureSha256:'f'.repeat(64),sourceFiles:512};},
  principal:()=>principal,command:async(kind,expected)=>{events.push(['cli',kind]);assert.equal(expected,principal);
   if(kind==='login')return Buffer.alloc(0);
   if(kind==='list')return Buffer.from(JSON.stringify(revoked?[]:options.accounts??[{account:principal,status:'ACTIVE'}]));
   if(kind==='token')return Buffer.from('owned-not-a-real-access-token-0000\n');
   if(kind==='revoke'){if(options.cleanupFails)throw Error('PRIVATE_CREDENTIAL_CANARY');revoked=true;return Buffer.alloc(0);}throw Error('unexpected CLI');},
  http:async(kind,name,token,body)=>{assert.equal(token,'owned-not-a-real-access-token-0000');const [method,path]=fixture.api.route(kind,name);events.push(['http',kind,method,path]);
   if(kind==='preflight')return raw(options.existing?200:404,options.existing?current:{error:{code:404}});
   if(kind==='search'){searches++;return raw(200,{projects:options.reconcileFound||created&&options.postCreateFound?[current]:[]});}
   if(kind==='create'){
    assert.equal(file.existsSync(join(fixture.cases,plan.actionId,'create-intent.json')),true);
    assert.equal(file.existsSync(join(fixture.cases,plan.actionId,'create-started.json')),true);
    const start=JSON.parse(file.readFileSync(join(fixture.cases,plan.actionId,'create-started.json')));
    assert.equal(start.intentSha256,hash(file.readFileSync(join(fixture.cases,plan.actionId,'create-intent.json'))));
    assert.deepEqual(body,{projectId:plan.project.projectId,displayName:plan.project.displayName,labels:plan.project.labels});
    created=true;if(options.lostAck){const e=Error('PRIVATE_RESPONSE_CANARY');e.code='P2Q_GOOGLE_HTTP_UNCERTAIN';throw e;}
    return raw(options.alreadyExists?409:200,options.alreadyExists?{error:{code:409,status:'ALREADY_EXISTS'}}:options.createResponse??operation);
   }
   if(kind==='operation'){operations++;return raw(200,options.operationResponse??{...operation,done:true,response:{'@type':'type.googleapis.com/google.cloud.resourcemanager.v3.Project',...current}});}
   if(kind==='project')return raw(200,options.projectResponse??current);
   if(kind==='iam'){assert.deepEqual(body,{options:{requestedPolicyVersion:3}});return raw(200,options.iam??{version:3,bindings:[{role:'roles/owner',members:['user:'+principal]}]});}
   throw Error('unexpected HTTPS');}};
 return {rt,events,current,get searches(){return searches;},get operations(){return operations;}};
}
function publicGoogleSafe(result){
 for(const key of ['allocationAuthorityIssued','firstUseAuthorized','administrativeBoundaryComplete','recoveryBoundaryComplete','profileRegistered','oauthClientCreated'])assert.equal(result[key],false);
 const common=JSON.stringify(result);for(const canary of ['owned-not-a-real-access-token','new-owner@example.test','PRIVATE_CREDENTIAL_CANARY','PRIVATE_RESPONSE_CANARY','PRIVATE_FSYNC_CANARY','roles/owner'])assert.equal(common.includes(canary),false);
}
test('Google public empty registry and fresh import refuse before filesystem/child/network/credential IO',async()=>{
 const program=`import fs from 'node:fs';import cp from 'node:child_process';import https from 'node:https';import{syncBuiltinESMExports}from'node:module';import{fileURLToPath}from'node:url';
 const url=${JSON.stringify(googleProgram.href)},policy=new URL('./source-policy.mjs',url).href,allowed=[url,policy].map(fileURLToPath);let effects=0;const fds=new Set();
 const deny=()=>{effects++;throw Error('NO_IO');};for(const k of ['openSync','readSync','readFileSync']){const original=fs[k];fs[k]=function(p,...a){const path=p instanceof URL?fileURLToPath(p):p;
 if(k==='openSync'&&allowed.includes(path)){const fd=original.call(this,p,...a);fds.add(fd);return fd;}if(k==='readSync'&&fds.has(p)||k==='readFileSync'&&allowed.includes(path))return original.call(this,p,...a);return deny();};}
 cp.spawn=deny;cp.execFileSync=deny;https.request=deny;syncBuiltinESMExports();const api=await import(url);
 for(const fn of [api.allocateP2qGoogleProject,api.reconcileP2qGoogleProject])for(const x of ['missing',null,new Proxy({},{get:deny})])try{await fn(x);process.exit(2);}catch(e){if(e.code!=='P2Q_GOOGLE_CASE_UNREGISTERED')throw e;}
 if(effects!==0)process.exit(3);process.stdout.write(JSON.stringify({fixtureOnly:true,effects,authorityIssued:false}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{fixtureOnly:true,effects:0,authorityIssued:false});
});
test('Google private protocol creates once after durable intent and captures original ACK/current/IAM without authority',async()=>{
 const f=await googleFixture();try{const store=new f.api.PrivateCase(f.plan,'create'),model=googleModel(f);
  const result=await f.api.execute(f.plan,'create',store,model.rt);publicGoogleSafe(result);
  assert.equal(result.status,'P2Q_GOOGLE_ORIGINAL_CREATE_OBSERVED');assert.equal(result.originalCreationAcknowledged,true);assert.equal(result.creationPostCount,1);assert.equal(result.readPostCount,1);
  assert.equal(result.credentialCleanupVerified,true);assert.equal(result.custodyIncomplete,false);
  assert.deepEqual(model.events.filter(x=>x[0]==='http').map(x=>x.slice(1,3)),[['preflight','GET'],['search','GET'],['create','POST'],['operation','GET'],['project','GET'],['iam','POST'],['project','GET']]);
  const response=join(store.path,'responses','002-create.raw');assert.equal(file.statSync(response).mode&0o777,0o600);assert.equal(JSON.parse(file.readFileSync(response)).name,'operations/cp.123456789012');
  assert.equal(file.existsSync(join(store.path,'config')),false);assert.throws(()=>new f.api.PrivateCase(f.plan,'create'),{code:'P2Q_GOOGLE_CASE_ALREADY_BURNED'});
 }finally{f.close();}
});
test('Google lost ACK is never re-POSTed; GET-only reconciliation distinguishes current evidence and timeout UNKNOWN',async()=>{
 for(const found of [false,true]){const f=await googleFixture();try{
  const first=googleModel(f,{lostAck:true});const lost=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),first.rt);publicGoogleSafe(lost);
  assert.equal(lost.creationPostCount,1);assert.equal(lost.originalCreationAcknowledged,false);assert.equal(lost.requiresOwnerReview,true);
  const next=googleModel(f,{reconcileFound:found});const result=await f.api.execute(f.plan,'reconcile',new f.api.PrivateCase(f.plan,'reconcile'),next.rt);publicGoogleSafe(result);
  assert.equal(result.creationPostCount,0);assert.equal(next.events.some(x=>x[0]==='http'&&x[1]==='create'),false);assert.equal(result.originalCreationAcknowledged,false);
  assert.equal(result.status,found?'P2Q_GOOGLE_RECONCILED_CURRENT_NOT_ORIGINAL_CREATION':'P2Q_GOOGLE_REQUIRES_REVIEW');
  assert.equal(result.code,'P2Q_GOOGLE_OBSERVATION_UNKNOWN');assert.equal(result.requiresOwnerReview,true);if(!found)assert.equal(next.searches,12);
 }finally{f.close();}}
});
test('Google same-process lost ACK can GET current state while retaining UNKNOWN creation outcome',async()=>{
 const f=await googleFixture();try{const model=googleModel(f,{lostAck:true,postCreateFound:true});
  const result=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),model.rt);publicGoogleSafe(result);
  assert.equal(result.status,'P2Q_GOOGLE_RECONCILED_CURRENT_NOT_ORIGINAL_CREATION');assert.equal(result.creationOutcome,'UNKNOWN');
  assert.equal(result.creationPostCount,1);assert.equal(result.code,'P2Q_GOOGLE_HTTP_UNCERTAIN');assert.equal(result.requiresOwnerReview,true);
  assert.equal(model.events.filter(x=>x[0]==='http'&&x[1]==='create').length,1);
 }finally{f.close();}
});
test('Google preflight existing/wrong or multiple principals and source drift permit zero creation',async()=>{
 const variants=[{existing:true},{accounts:[{account:'wrong@example.test',status:'ACTIVE'}]},
  {accounts:[{account:'new-owner@example.test',status:'ACTIVE'},{account:'old@example.test',status:'INACTIVE'}]}];
 for(const variant of variants){const f=await googleFixture();try{const model=googleModel(f,variant),result=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),model.rt);
  publicGoogleSafe(result);assert.equal(result.creationPostCount,0);assert.equal(result.requiresOwnerReview,true);
  if(variant.accounts){assert.equal(model.events.some(x=>x[0]==='cli'&&x[1]==='revoke'),false);assert.equal(result.custodyIncomplete,true);}
 }finally{f.close();}}
 const f=await googleFixture();try{const model=googleModel(f);model.rt.verify=async()=>{throw Error('PRIVATE_SOURCE');};const result=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),model.rt);
  assert.equal(result.creationPostCount,0);assert.equal(model.events.length,0);publicGoogleSafe(result);
 }finally{f.close();}
});
test('Google ALREADY_EXISTS, foreign operation/project/parent/owner and operation errors require review without retries',async()=>{
 for(const build of [()=>({alreadyExists:true}),()=>({createResponse:{name:'https://wrong.example/operation'}}),
  ()=>({operationResponse:{name:'operations/foreign',done:true}}),()=>({operationResponse:{name:'operations/cp.123456789012',done:true,error:{code:7,message:'PRIVATE_RESPONSE_CANARY'}}}),
  m=>({projectResponse:{...m.current,name:'projects/999999999999'}}),m=>({projectResponse:{...m.current,parent:'organizations/123'}}),
  ()=>({iam:{version:3,bindings:[{role:'roles/owner',members:['user:wrong@example.test']}]}})]){
  const f=await googleFixture();try{const model=googleModel(f);const options=build(model),bad=googleModel(f,options);
   const result=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),bad.rt);publicGoogleSafe(result);
   assert.equal(result.requiresOwnerReview,true);assert.equal(result.creationPostCount,1);assert.notEqual(result.code,null);
  }finally{f.close();}
 }
});
test('Google clean child environment rejects ambient auth/ADC/impersonation/Python/browser/proxy overrides',async()=>{
 const f=await googleFixture();try{
  for(const key of ['CLOUDSDK_CONFIG','CLOUDSDK_AUTH_ACCESS_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','GCLOUD_PROJECT','CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT','PYTHONPATH','VIRTUAL_ENV','BROWSER','NODE_TLS_REJECT_UNAUTHORIZED','HTTPS_PROXY'])
   assert.throws(()=>f.api.cleanAmbient({[key]:'PRIVATE_CREDENTIAL_CANARY'}),{code:'P2Q_GOOGLE_AMBIENT_OVERRIDE_REFUSED'});
  f.api.cleanAmbient({PATH:'ambient-not-forwarded',HOME:'ambient-not-forwarded'});const store=new f.api.PrivateCase(f.plan,'create'),env=f.api.childEnvironment(f.plan,store);
  assert.equal(Object.hasOwn(env,'HOME'),false);assert.equal(Object.hasOwn(env,'GOOGLE_APPLICATION_CREDENTIALS'),false);assert.equal(env.CLOUDSDK_CONFIG,join(store.path,'config'));
  assert.equal(Object.hasOwn(env,'CLOUDSDK_PYTHON_SITEPACKAGES'),false);assert.equal(Object.hasOwn(env,'VIRTUAL_ENV'),false);assert.equal(env.CLOUDSDK_PYTHON_ARGS,'-B -s');
  assert.throws(()=>f.api.cleanAmbient({CLOUDSDK_PYTHON_SITEPACKAGES:'0'}),{code:'P2Q_GOOGLE_AMBIENT_OVERRIDE_REFUSED'});
  assert.deepEqual(f.api.cliArgs('login',f.principal),['auth','login',f.principal,'--no-launch-browser','--brief','--verbosity=none']);
  assert.deepEqual(f.api.cliArgs('token',f.principal),['auth','print-access-token',f.principal,'--verbosity=none']);
  assert.deepEqual(f.api.cliArgs('revoke',f.principal),['auth','revoke',f.principal,'--quiet','--verbosity=none']);
  for(const kind of ['delete','patch','retry'])assert.throws(()=>f.api.route(kind,'projects/123'));
 }finally{f.close();}
});
test('Google raw truncation/symlink and cleanup uncertainty retain private evidence',async()=>{
 const f=await googleFixture();try{
  const store=new f.api.PrivateCase(f.plan,'create'),model=googleModel(f,{cleanupFails:true}),result=await f.api.execute(f.plan,'create',store,model.rt);
  publicGoogleSafe(result);assert.equal(result.custodyIncomplete,true);assert.equal(result.requiresOwnerReview,true);assert.equal(file.existsSync(join(store.path,'config')),true);
  const response=join(store.path,'responses','002-create.raw');file.truncateSync(response,3);assert.throws(()=>store.readResponse('create'),{code:'P2Q_GOOGLE_RESPONSE_REFUSED'});
  file.symlinkSync('case.json',join(store.path,'symlink.json'));assert.throws(()=>store.write('symlink.json',Buffer.from('{}')),{code:'P2Q_GOOGLE_PRIVATE_WRITE_FAILED'});
 }finally{f.close();}
});
test('Google actual file-write/fsync faults preserve burn and never replay CREATE',async()=>{
 for(const phase of ['intent-fsync','burn-fsync','raw-partial','raw-fsync','raw-loss']){
  const f=await googleFixture(),original={openSync:fsMutable.openSync,writeSync:fsMutable.writeSync,fsyncSync:fsMutable.fsyncSync};
  try{const store=new f.api.PrivateCase(f.plan,'create'),model=googleModel(f),paths=new Map();let partial=false;
   fsMutable.openSync=function(path,...args){const fd=original.openSync.call(this,path,...args);paths.set(fd,String(path));return fd;};
   fsMutable.writeSync=function(fd,buffer,offset,length,...args){if(phase==='raw-partial'&&paths.get(fd)?.endsWith('002-create.raw')){
    if(partial)return 0;partial=true;return original.writeSync.call(this,fd,buffer,offset,3,...args);}
    return original.writeSync.call(this,fd,buffer,offset,length,...args);};
   fsMutable.fsyncSync=function(fd){const path=paths.get(fd)??'';
    if(phase==='intent-fsync'&&path.endsWith('create-intent.json')||phase==='burn-fsync'&&path.endsWith('create-started.json')||phase==='raw-fsync'&&path.endsWith('002-create.raw'))throw Error('PRIVATE_FSYNC_CANARY');
    const value=original.fsyncSync.call(this,fd);if(phase==='raw-loss'&&path.endsWith('002-create.raw'))fsMutable.unlinkSync(path);return value;};
   syncBuiltinESMExports();const result=await f.api.execute(f.plan,'create',store,model.rt);publicGoogleSafe(result);
   assert.equal(result.code,'P2Q_GOOGLE_PRIVATE_WRITE_FAILED');assert.equal(result.creationPostCount,phase.startsWith('raw-')?1:0);assert.equal(result.originalCreationAcknowledged,false);
   assert.throws(()=>new f.api.PrivateCase(f.plan,'create'),{code:'P2Q_GOOGLE_CASE_ALREADY_BURNED'});
  }finally{Object.assign(fsMutable,original);syncBuiltinESMExports();f.close();}
 }
});
test('Google principal claims serialize cases and never expire or clear an unknown holder',async()=>{
 const f=await googleFixture();try{const release=f.api.principalClaim(f.plan,f.principal);
  assert.throws(()=>f.api.principalClaim({...f.plan,actionId:'different-case'},f.principal),{code:'P2Q_GOOGLE_PRINCIPAL_CLAIM_REQUIRES_REVIEW'});
  assert.throws(()=>f.api.principalClaim(f.plan,f.principal),{code:'P2Q_GOOGLE_PRINCIPAL_CLAIM_REQUIRES_REVIEW'});
  release();const next=f.api.principalClaim(f.plan,f.principal);next();
 }finally{f.close();}
});
test('Google tool closure pins only exact internal vendor symlinks and actual target bytes',async()=>{
 const f=await googleFixture();try{const root=join(f.root,'sdk');file.mkdirSync(root,{mode:0o700});file.mkdirSync(join(root,'real'),{mode:0o700});
  file.writeFileSync(join(root,'real','module.py'),'owned source',{mode:0o600});file.symlinkSync('real',join(root,'docs'));
  const links={docs:'real'},first=f.api.physicalTree(root,links);assert.match(first,/^[a-f0-9]{64}$/u);
  assert.throws(()=>f.api.physicalTree(root,{}));assert.throws(()=>f.api.physicalTree(root,{docs:'elsewhere'}));
  file.writeFileSync(join(root,'real','module.py'),'changed source');assert.notEqual(f.api.physicalTree(root,links),first);
  file.unlinkSync(join(root,'docs'));file.symlinkSync('../handoff',join(root,'docs'));assert.throws(()=>f.api.physicalTree(root,{docs:'../handoff'}));
  file.unlinkSync(join(root,'docs'));file.symlinkSync('missing',join(root,'docs'));assert.throws(()=>f.api.physicalTree(root,{docs:'missing'}));
  file.unlinkSync(join(root,'docs'));file.symlinkSync('loop',join(root,'docs'));file.symlinkSync('docs',join(root,'loop'));assert.throws(()=>f.api.physicalTree(root,{docs:'loop',loop:'docs'}));
 }finally{f.close();}
});
test('Google private HTTPS adapter fixes host/TLS/routes/body and refuses incomplete or oversized responses',async()=>{
 const f=await googleFixture(),original=httpsMutable.request;try{
  for(const kind of ['create','iam','operation','incomplete','oversized']){let options,posted=Buffer.alloc(0),timeout;
   httpsMutable.request=(selected,callback)=>{options=selected;const req=new EventEmitter();req.setTimeout=ms=>{timeout=ms;};req.write=b=>{posted=Buffer.concat([posted,b]);};req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.complete=kind!=='incomplete';res.destroy=()=>res.emit('aborted');callback(res);
     res.emit('data',kind==='oversized'?Buffer.alloc(262145):Buffer.from('{"projectId":"new-owned-project"}'));res.emit('end');});return req;};
   syncBuiltinESMExports();const operation=kind==='iam'?'iam':kind==='operation'?'operation':'create',name=operation==='iam'?'projects/123456789012':operation==='operation'?'operations/cp.owned':null;
   const body=operation==='iam'?{options:{requestedPolicyVersion:3}}:operation==='create'?{projectId:f.plan.project.projectId}:undefined;
   const pending=f.api.request(f.plan,operation,name,'owned-not-a-real-access-token-0000',body);
   if(['incomplete','oversized'].includes(kind))await assert.rejects(pending,{code:'P2Q_GOOGLE_HTTP_UNCERTAIN'});else assert.equal((await pending).status,200);
   assert.equal(options.hostname,'cloudresourcemanager.googleapis.com');assert.equal(options.port,443);assert.equal(options.protocol,'https:');
   assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal(options.minVersion,'TLSv1.2');assert.equal(timeout,15000);
   assert.equal(options.method,operation==='operation'?'GET':'POST');assert.equal(Object.hasOwn(options.headers,'X-Goog-User-Project'),false);
   if(body)assert.deepEqual(JSON.parse(posted),body);else assert.equal(posted.length,0);
  }
 }finally{httpsMutable.request=original;syncBuiltinESMExports();f.close();}
});
test('Google reconciliation preserves exact original source, plan and raw ACK context',async()=>{
 for(const mutation of ['source','plan','ack']){const f=await googleFixture();try{
  const result=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),googleModel(f).rt);assert.equal(result.code,null);
  const path=join(f.cases,f.plan.actionId);if(mutation==='source'){const name=join(path,'source.json'),value=JSON.parse(file.readFileSync(name));value.sourceCommit='0'.repeat(40);file.writeFileSync(name,JSON.stringify(value));}
  if(mutation==='ack'){const name=join(path,'responses','002-create.raw'),value=JSON.parse(file.readFileSync(name));value.name='operations/foreign';file.writeFileSync(name,JSON.stringify(value));}
  if(mutation==='plan')assert.throws(()=>new f.api.PrivateCase({...f.plan,bootstrapQuotaProject:'different-quota'},'reconcile'),{code:'P2Q_GOOGLE_ORIGINAL_INTENT_REQUIRED'});
  else{const model=googleModel(f),next=await f.api.execute(f.plan,'reconcile',new f.api.PrivateCase(f.plan,'reconcile'),model.rt);publicGoogleSafe(next);
   assert.equal(next.requiresOwnerReview,true);assert.equal(next.creationPostCount,0);assert.equal(model.events.some(x=>x[0]==='http'),false);}
 }finally{f.close();}}
});
test('Google acknowledged operation can be reobserved without creation; complete ACK retained on operation error',async()=>{
 const f=await googleFixture();try{
  await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),googleModel(f).rt);
  const model=googleModel(f),result=await f.api.execute(f.plan,'reconcile',new f.api.PrivateCase(f.plan,'reconcile'),model.rt);publicGoogleSafe(result);
  assert.equal(result.creationPostCount,0);assert.equal(result.originalCreationAcknowledged,true);assert.equal(result.status,'P2Q_GOOGLE_ORIGINAL_CREATE_OBSERVED');
 }finally{f.close();}
 const failed=await googleFixture();try{const store=new failed.api.PrivateCase(failed.plan,'create');
  const result=await failed.api.execute(failed.plan,'create',store,googleModel(failed,{createResponse:{name:'operations/cp.owned',done:true,error:{code:7,message:'PRIVATE_RESPONSE_CANARY'}}}).rt);
  publicGoogleSafe(result);assert.equal(result.code,'P2Q_GOOGLE_OPERATION_ERROR');assert.equal(result.originalCreationAcknowledged,true);
  assert.equal(JSON.parse(file.readFileSync(join(store.path,'create-ack.json'))).operationName,'operations/cp.owned');
 }finally{failed.close();}
});
test('Google exact child umask wrapper creates0600/0700 without changing Node umask or invoking SDK',async()=>{
 const f=await googleFixture();try{const launcher=join(f.root,'owned-writer.sh'),output=join(f.root,'owned-file'),directory=join(f.root,'owned-directory');
  file.writeFileSync(launcher,'#!/bin/sh\nprintf owned > "$1"\n/bin/mkdir "$2"\n',{mode:0o700});const before=process.umask();
  const result=spawnSync('python3',['-I','-B','-S','-c',f.api.UMASK_WRAPPER,launcher,output,directory],{env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');assert.equal(process.umask(),before);
  assert.equal(file.statSync(output).mode&0o777,0o600);assert.equal(file.statSync(directory).mode&0o777,0o700);
 }finally{f.close();}
});
test('Google private root permission drift and response-parent symlink refuse before write',async()=>{
 const f=await googleFixture();try{const store=new f.api.PrivateCase(f.plan,'create');file.chmodSync(f.cases,0o755);
  assert.throws(()=>store.verify(),{code:'P2Q_GOOGLE_PRIVATE_DIRECTORY_REQUIRED'});file.chmodSync(f.cases,0o700);
  file.rmdirSync(join(store.path,'responses'));const alternate=join(f.root,'alternate');file.mkdirSync(alternate,{mode:0o700});file.symlinkSync(alternate,join(store.path,'responses'));
  assert.throws(()=>store.response('project',200,Buffer.from('{}')));assert.deepEqual(file.readdirSync(alternate),[]);
 }finally{f.close();}
});
test('Google missing original ACK stays review-required and cannot release the principal claim',async()=>{
 const f=await googleFixture();try{const original=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),googleModel(f).rt);
  assert.equal(f.api.claimMayClose(original),true);file.unlinkSync(join(f.cases,f.plan.actionId,'create-ack.json'));
  const result=await f.api.execute(f.plan,'reconcile',new f.api.PrivateCase(f.plan,'reconcile'),googleModel(f,{reconcileFound:true}).rt);publicGoogleSafe(result);
  assert.equal(result.creationOutcome,'UNKNOWN');assert.equal(result.code,'P2Q_GOOGLE_OBSERVATION_UNKNOWN');assert.equal(result.requiresOwnerReview,true);
  assert.equal(result.originalCreationAcknowledged,false);assert.equal(f.api.claimMayClose(result),false);
 }finally{f.close();}
});
test('Google source drift during CREATE token command is refused before HTTP or attempt marking',async()=>{
 const f=await googleFixture();try{const store=new f.api.PrivateCase(f.plan,'create'),model=googleModel(f),command=model.rt.command,verify=model.rt.verify;let drift=false;
  model.rt.command=async(kind,expected)=>{const raw=await command(kind,expected);if(kind==='token'&&model.events.some(x=>x[0]==='http'&&x[1]==='search'))drift=true;return raw;};
  model.rt.verify=async()=>{if(drift){const e=Error('PRIVATE_SOURCE_CANARY');e.code='P2Q_GOOGLE_SOURCE_REQUIRED';throw e;}return verify();};
  const result=await f.api.execute(f.plan,'create',store,model.rt);publicGoogleSafe(result);assert.equal(drift,true);
  assert.equal(result.code,'P2Q_GOOGLE_SOURCE_REQUIRED');assert.equal(result.creationPostCount,0);assert.equal(result.creationPostAttempted,false);
  assert.equal(model.events.some(x=>x[0]==='http'&&x[1]==='create'),false);assert.equal(file.existsSync(join(store.path,'create-started.json')),true);
 }finally{f.close();}
});
test('Google cleanup drift after identity read prevents SDK revoke and retains credential custody',async()=>{
 const f=await googleFixture();try{const model=googleModel(f),verify=model.rt.verify,command=model.rt.command;let drift=false;
  model.rt.command=async(kind,expected)=>{const raw=await command(kind,expected);
   if(kind==='list'&&model.events.filter(x=>x[0]==='http'&&x[1]==='project').length===2)drift=true;return raw;};
  model.rt.verify=async()=>{if(drift){const e=Error('PRIVATE_TOOLCHAIN_CANARY');e.code='P2Q_GOOGLE_TOOLCHAIN_REQUIRED';throw e;}return verify();};
  const store=new f.api.PrivateCase(f.plan,'create'),result=await f.api.execute(f.plan,'create',store,model.rt);publicGoogleSafe(result);
  assert.equal(drift,true);assert.equal(model.events.some(x=>x[0]==='cli'&&x[1]==='revoke'),false);
  assert.equal(result.custodyIncomplete,true);assert.equal(result.requiresOwnerReview,true);assert.equal(f.api.claimMayClose(result),false);assert.equal(file.existsSync(join(store.path,'config')),true);
 }finally{f.close();}
});
