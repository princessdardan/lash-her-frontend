import assert from 'node:assert/strict';
import * as file from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const googleProgram=pathToFileURL("/Users/dardan/workspace/lash-her-frontend/.worktrees/p2q-google-project-allocation/ops/platform/p2q-google-project-allocation.mjs");
const hash=raw=>createHash('sha256').update(raw).digest('hex');
async function googleFixture(){
 const root=mkdtempSync(join(tmpdir(),'p2q-google-owned-'));file.chmodSync(root,0o700);
 const cases=join(root,'cases'),handoff=join(root,'handoff');file.mkdirSync(cases,{mode:0o700});file.mkdirSync(handoff,{mode:0o700});
 const source=file.readFileSync(googleProgram,'utf8');
 const projected=source.replace("import {P2Q_GOOGLE_PROJECT_CAPTURE_CASES} from './source-policy.mjs';","const P2Q_GOOGLE_PROJECT_CAPTURE_CASES=Object.freeze({});")
  .replace("const OWNER_UID=0,CASE_ROOT='/var/lib/lash-her/p2q/google-projects';",`const OWNER_UID=${process.getuid()},CASE_ROOT=${JSON.stringify(cases)};`)
  .replace("privatePath(path);let current='/';\n  for(const part of path.split('/').filter(Boolean))",`privatePath(path);demand(path===${JSON.stringify(root)}||path.startsWith(${JSON.stringify(root+'/')}),'PRIVATE_DIRECTORY_REQUIRED');let current=${JSON.stringify(root)};\n  for(const part of relative(current,path).split('/').filter(Boolean))`)
  .replace("'/run/lash-her-p2q-private/'",JSON.stringify(handoff+'/'));
 const path=join(root,'producer.mjs');file.writeFileSync(path,projected+'\nexport const ownedPrivate={casePlan,PrivateCase,execute,cleanAmbient,route,cliArgs,childEnvironment,request,physicalTree,verifyToolchain,readFile,writeFile,parse,principalClaim,UMASK_WRAPPER};\n');
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

const report={version:1,sourceCommit:'fbb41ae95e3d6904a36084afaa43a63e74f115c7',projectionOnly:true,providerCalls:false};
const f=await googleFixture();try {
 const first=await f.api.execute(f.plan,'create',new f.api.PrivateCase(f.plan,'create'),googleModel(f).rt);assert.equal(first.code,null);
 file.unlinkSync(join(f.cases,f.plan.actionId,'create-ack.json'));
 const result=await f.api.execute(f.plan,'reconcile',new f.api.PrivateCase(f.plan,'reconcile'),googleModel(f,{reconcileFound:true}).rt);
 report.missingOriginalAck={status:result.status,creationOutcome:result.creationOutcome,originalCreationAcknowledged:result.originalCreationAcknowledged,requiresOwnerReview:result.requiresOwnerReview,code:result.code,cleanup:result.credentialCleanupVerified,runReleasePredicate:result.code===null&&result.credentialCleanupVerified};
} finally { f.close(); }
const g=await googleFixture();try {
 const model=googleModel(g), originalCommand=model.rt.command, originalVerify=model.rt.verify;let drift=false;
 model.rt.verify=async()=>{if(drift){const error=Error('P2Q_GOOGLE_SOURCE_REQUIRED');error.code=error.message;throw error;}return originalVerify();};
 model.rt.command=async(kind,...args)=>{const result=await originalCommand(kind,...args);if(kind==='token'&&file.existsSync(join(g.cases,g.plan.actionId,'create-started.json')))drift=true;return result;};
 const result=await g.api.execute(g.plan,'create',new g.api.PrivateCase(g.plan,'create'),model.rt);
 report.driftBeforeCreate={code:result.code,creationPostCount:result.creationPostCount,sourceDriftBeforeHttpObserved:drift,createHttpCalls:model.events.filter(x=>x[0]==='http'&&x[1]==='create').length,credentialCleanupVerified:result.credentialCleanupVerified};
} finally {g.close();}
process.stdout.write(JSON.stringify(report,null,2)+'\n');
