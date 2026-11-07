import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {p2CertificationEnvironmentLock,readP2CertificationAuthenticationStage,readP2CertificationSuspensionStage,readP2CertificationWorkerStage,readP2CertificationKnownAckStage,readP2CertificationInteractiveStage} from './p2-certification-transport.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile} from './qualification-target-profile.mjs';
const program=String.raw`
import base64,fcntl,json,os,sys
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline());assert initial['mode'] in ('p2-bounded-certification','p2-bounded-certification-profiled-current')
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
terminal={'status':'P2_BOUNDED_CERTIFICATION_CONTAINED','sqlReplayed':False,'runtimeReplaced':False}
if initial['mode'].endswith('profiled-current'):
 terminal.update(status='P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',version=2,qualificationTargetProfile=initial['qualificationTargetProfile'],
  planSha256=initial['certificationPlan']['planSha256'])
for raw in sys.stdin:
 p=json.loads(raw);op=p['operation'];value={'id':p['id']}
 if op=='check':value['status']='HELD'
 elif op=='arm-certification':
  assert json.loads(base64.b64decode(p['receipt']))['status']=='P2_CERTIFICATION_DATABASE_CURRENT'
  if sys.argv[2]=='death':os._exit(31)
  value.update(status='CERTIFICATION_ARMED',receipt={'status':'P2_CERTIFICATION_CURRENT_READY'})
 elif op=='certification-gateway-stage':value.update(status='CERTIFICATION_GATEWAY_OBSERVED',receipt={'gateway':{'newWork':p['stage']=='browser','recovery':False}})
 elif op=='certification-prepare-close':value.update(status='CERTIFICATION_CLOSE_PREPARED',receipt=terminal)
 elif op=='finish':
  assert json.loads(base64.b64decode(p['certification']))==terminal
  value.update(status='P2_CERTIFICATION_JOINED',receipt=terminal)
 elif op=='commit':
  value.update(status='COMMITTED',receipt=terminal);print(json.dumps(value),flush=True)
  if sys.argv[2]=='bad-reap':os._exit(33)
  break
 else:os._exit(32)
 print(json.dumps(value),flush=True)
os.close(fd)
`;
function fixture(mode='ready',profiled=false){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-certification-pipe-')));chmodSync(directory,0o700);
 const receipt={status:'P2_CERTIFICATION_DATABASE_CURRENT'},outcome={status:'P2_BOUNDED_CERTIFICATION_CONTAINED',sqlReplayed:false,runtimeReplaced:false};
 const planSha256='c'.repeat(64);
 if(profiled)Object.assign(outcome,{status:'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',version:2,qualificationTargetProfile:profile,planSha256});
 writeFileSync(join(directory,'p2-certification-current-database.json'),JSON.stringify(receipt),{mode:0o600});
 writeFileSync(join(directory,profiled?'p2-certification-close-prepared.json':'p2-certification-outcome.json'),JSON.stringify(outcome),{mode:0o600});
 const initial={environment:'staging',sourceCommit:'a'.repeat(40),mode:'p2-bounded-certification',certificationActionId:'bounded-case',nativePlan:{planSha256:'b'.repeat(64)},
  certificationPlan:{mode:'auth-preparation'},browserPlan:{},credentials:{privateMarker:'fixture-private-stdin-only'}};
 if(profiled)Object.assign(initial,{mode:'p2-bounded-certification-profiled-current',version:2,qualificationTargetProfile:profile,
  certificationPlan:{mode:'contain-native',version:2,qualificationTargetProfile:profile,certificationActionId:initial.certificationActionId,
    nativePlan:{version:2,qualificationTargetProfile:profile,planSha256:'b'.repeat(64)},planSha256}});
 const lock=join(directory,'actual.lock');let captured;
 const factory=p2CertificationEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key'},initial,directory,{expectedProfile:profiled?profile:undefined,launch(executable,args,options){captured={executable,args,options};return spawn('python3',['-I','-u','-c',program,lock,mode],options);}});
 return{directory,receipt,outcome,factory,lock,getCaptured:()=>captured,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('actual child pipe/flock joins only exact certification terminal and keeps credentials in stdin',async()=>{
 const f=fixture();try{
  const actual=await f.factory(async(verify,_signal,host)=>{
   await verify();const other=spawnSync('python3',['-I','-c',"import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",f.lock]);assert.notEqual(other.status,0);
   await host.arm({receipt:f.receipt,probe:{}});await host.gatewayStage('browser');
   await assert.rejects(host.authenticationStage({},{}));await assert.rejects(host.suspensionEvidenceStage({},{}));
   await assert.rejects(host.workerEvidenceStage({}));
   await assert.rejects(host.knownAckStage({}));
   await assert.rejects(host.interactiveStage({}));
   assert.throws(()=>readP2CertificationAuthenticationStage({status:'P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD'},{}));
   assert.throws(()=>readP2CertificationSuspensionStage({captureControlled:async()=>({})},{}));
   assert.throws(()=>readP2CertificationWorkerStage({invokeDirect:async()=>({status:'P2_DIRECT_WORKER_HTTP_OBSERVED'})},{}));
   assert.throws(()=>readP2CertificationKnownAckStage({replace:async()=>({status:'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED'})},{}));
   assert.throws(()=>readP2CertificationInteractiveStage({installPermit:async()=>({})},{}));
   await host.prepareClose({status:'P2_TEST_FIXTURE'});await host.finish(f.outcome);return'joined';
  });
  assert.equal(actual,'joined');assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'p2-host-certification-outcome.json'))),f.outcome);
  assert.equal(JSON.stringify(f.getCaptured()).includes('fixture-private-stdin-only'),false);
  assert.equal(f.getCaptured().executable,'/usr/bin/ssh');assert.ok(f.getCaptured().args.some(value=>value.includes('p2_certification_parent.py')));
 }finally{f.cleanup();}
});

const interactiveProgram=String.raw`
import base64,hashlib,json,sys,time
from datetime import datetime,timezone
initial=json.loads(sys.stdin.readline())
plan=initial['certificationPlan'];binding=initial['interactiveController'];profile=initial['qualificationTargetProfile']
action=plan['scopedAction'];stage=action['stage'];epoch=str(int(plan['initialEpoch'])+1);behavior=sys.argv[1]
initial_time=int(time.time());expires=initial_time+120
def iso(seconds):return datetime.fromtimestamp(seconds,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def send(value):print(json.dumps(value),flush=True)
def status(disposition):return f'P2_INTERACTIVE_{stage.upper()}_{disposition}'
send({'id':0,'status':'LOCKED'})
phase='new';terminal={'status':'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED','version':2,'qualificationTargetProfile':profile,'planSha256':plan['planSha256'],'sqlReplayed':False,'runtimeReplaced':False}
base={'version':2,'qualificationTargetProfile':profile,'certificationActionId':initial['certificationActionId'],'planSha256':plan['planSha256'],'stage':stage}
fence={'gatewayAdmissionClosed':True,'gatewayActive':0,'gatewayUncertain':0}
for raw in sys.stdin:
 p=json.loads(raw);op=p['operation'];value={'id':p['id']}
 if op=='check':value['status']='HELD'
 elif op=='arm-certification':value.update(status='CERTIFICATION_ARMED',receipt={'status':'P2_CERTIFICATION_CURRENT_READY'})
 elif op.startswith('interactive-'):
  assert p['controllerChallenge']==binding['challenge']
  assert set(p)=={'id','operation','controllerChallenge'}|({'caseEvidence'} if op=='interactive-retain' else set())
  value['status']='CERTIFICATION_INTERACTIVE_OBSERVED'
  if op=='interactive-prepare':
   assert phase=='new';phase='prepared'
   value['receipt']={**base,'status':status('PREPARED'),'ingressSha256':'d'*64}
  elif op=='interactive-open':
   assert phase=='prepared';phase='opened'
   value['receipt']={**base,'status':status('OPENED'),'epoch':epoch,'expiresAt':iso(expires),'gatewayScoped':False}
  elif op=='interactive-permit':
   assert phase=='opened';phase='issued'
   selector='f'*64
   if stage=='identity':
    kind=action['identityActor']['actorKind']
    if behavior=='wrong-selector':kind='customer' if kind=='admin' else 'admin'
    selector=digest(['identity',kind])
   cookie='.'.join(('v2',epoch,stage,str(initial_time),str(expires),'e'*32,selector,'a'*64))
   value.update(status='CERTIFICATION_INTERACTIVE_PRIVATE',permit={'stage':stage,'epoch':epoch,'expires':expires,'cookie':cookie})
  elif op=='interactive-fence':
   assert phase in ('opened','issued');phase='fenced'
   value['receipt']={**base,**fence,'status':status('FENCED')}
  elif op=='interactive-retain':
   assert phase=='fenced';phase='retained'
   evidence=p['caseEvidence']
   if stage=='identity':
    actor=action['identityActor']
    assert set(evidence)=={'browserIdentity','identityWitness'}
    assert evidence['browserIdentity']=={**actor,'sessionVerified':True}
    joined={**actor,'context':'owner' if actor['actorKind']=='admin' else 'learner',
     'browserIdentitySha256':digest(evidence['browserIdentity']),'identityWitnessSha256':digest(evidence['identityWitness'])}
    if behavior=='wrong-join':joined['identityWitnessSha256']='0'*64
   else:
    assert set(evidence)=={'browserResponse','lifecycleWitness'}
    joined={'browserResponseSha256':digest(evidence['browserResponse']),'lifecycleWitnessSha256':digest(evidence['lifecycleWitness']),
     'actorId':action['actorId'],**action['frontendAction']}
   value['receipt']={**base,**fence,**joined,'status':status('JOINED'),
    'browserProgramSha256':binding['browserProgramSha256'],
    'frontendAdmission':{'epoch':str(int(epoch)+1),'newWork':False,'recovery':False,'active':0,'uncertain':0},'frontendOperationCount':1}
  else:raise AssertionError('unexpected interactive operation')
 elif op=='certification-prepare-close':
  assert phase=='retained' and p['caseOutcome']['status']==status('JOINED')
  value.update(status='CERTIFICATION_CLOSE_PREPARED',receipt=terminal)
 elif op=='finish':
  assert phase=='retained' and json.loads(base64.b64decode(p['certification']))==terminal
  value.update(status='P2_CERTIFICATION_JOINED',receipt=terminal)
 elif op=='commit':
  send({'id':p['id'],'status':'COMMITTED','receipt':terminal})
  break
 else:raise AssertionError('unexpected operation')
 send(value)
`;

const interactiveHarness=String.raw`
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import * as childProcess from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const fixture=JSON.parse(readFileSync(0));
const {default:defaultChild,spawn:realSpawn,...childExports}=childProcess;
const program=fixture.program,directory=fixture.directory,profile=fixture.profile;
const sourceCommit='a'.repeat(40),planSha256='c'.repeat(64),actionId='interactive-case';
const actor='12345678-1234-4123-8123-000000000001',target='12345678-1234-4123-8123-000000000002';
const commandId='12345678-1234-4123-8123-000000000003',requestId='12345678-1234-4123-8123-000000000004';
const {certificationStage,actorKind,behavior}=fixture;
const identity=certificationStage==='identity',context=actorKind==='admin'?'owner':'learner';
const status=disposition=>'P2_INTERACTIVE_'+certificationStage.toUpperCase()+'_'+disposition;
const installFailure=['install-failure','wrong-selector'].includes(behavior);
const selection={actorKind,userId:actorKind==='admin'?target:actor,operation:actorKind==='admin'?'suspend':'delete'};
const identityActor={actorKind,actorId:actor};
const scopedAction={stage:certificationStage,actorId:identity?null:actor,requests:[],windowSeconds:120,
  ...(identity?{identityActor}:{frontendAction:selection})};
const plan={mode:'interactive-browser',version:2,environment:'staging',qualificationTargetProfile:profile,certificationActionId:actionId,
  initialEpoch:'7',maximumSeconds:300,sourceCommit,operatorSourceCommit:sourceCommit,planSha256,
  nativePlan:{version:2,qualificationTargetProfile:profile,planSha256:'b'.repeat(64)},
  scopedAction};
const binding={challenge:'5'.repeat(64),bindingSha256:planSha256,browserProgramSha256:'7'.repeat(64)};
const initial={version:2,qualificationTargetProfile:profile,environment:'staging',sourceCommit,certificationActionId:actionId,
  mode:'p2-bounded-certification-profiled-current',certificationPlan:plan,interactiveController:binding};
const receipt={status:'P2_CERTIFICATION_DATABASE_CURRENT'};
const outcome={status:'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',sqlReplayed:false,runtimeReplaced:false,
  version:2,qualificationTargetProfile:profile,planSha256};
const fenced={status:status('FENCED'),version:2,qualificationTargetProfile:profile,certificationActionId:actionId,planSha256,
  stage:certificationStage,gatewayAdmissionClosed:true,gatewayActive:0,gatewayUncertain:0};
let privatePacket,alive=true,installCount=0;
const browser={
 async installPermit(permit,actualContext){
  assert.equal(actualContext,context);installCount++;
  assert.ok(permit.cookie.startsWith('v2.8.'+certificationStage+'.')&&permit.cookie.endsWith('a'.repeat(64)));
  privatePacket=permit;
  if(behavior==='install-failure'){alive=false;throw new Error(permit.cookie);}
  return {type:'interactive-permit-installed',challenge:binding.challenge,bindingSha256:planSha256,stage:certificationStage,
    epoch:'8',context,expires:permit.expires};
 },
};
let starts=0;const writes=[];
const spawn=(executable,args,options)=>{
 starts++;assert.equal(executable,'/usr/bin/ssh');assert.ok(args.some(value=>value.includes('--supervisor-profiled-current')));
 const child=realSpawn('python3',['-I','-u','-c',program,behavior],options);
 const write=child.stdin.write.bind(child.stdin);child.stdin.write=(value,...rest)=>{writes.push(JSON.parse(value));return write(value,...rest);};
 return child;
};
mock.module('node:child_process',{exports:{...childExports,spawn,default:{...defaultChild,spawn}}});
mock.module(fixture.browserUrl,{exports:{readP2InteractiveBrowserControllerBinding(selected,controller){
  assert.ok(alive&&selected===plan&&controller===browser);return binding;
}}});
const {p2CertificationEnvironmentLock,readP2CertificationInteractiveStage}=await import(fixture.transportUrl);
const start=(input=initial)=>p2CertificationEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key'},input,directory,{expectedProfile:profile});
for(const changed of [
 {...initial,interactiveController:{...binding,cookie:'fixture-forbidden'}},
 {...initial,interactiveController:{...binding,bindingSha256:'0'.repeat(64)}},
 {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,stage:identity?'lifecycle':'identity'}}},
 ...(identity?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,actorId:actor}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityActor:{...identityActor,actorKind:'editor'}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityActor:{...identityActor,actorId:'00000000-0000-0000-0000-000000000000'}}}},
 ]:[]),
]) assert.throws(()=>start(changed),{message:'P2_CERTIFICATION_TRANSPORT_REFUSED'});
assert.equal(starts,0);
writeFileSync(join(directory,'p2-certification-current-database.json'),JSON.stringify(receipt),{mode:0o600});
writeFileSync(join(directory,'p2-certification-close-prepared.json'),JSON.stringify(outcome),{mode:0o600});
const response={method:'POST',pathname:'/api/admin/customer-accounts/'+target+'/commands',status:202,requestId,
  body:{commandId,action:'suspend',accountVersion:2,status:'pending'}};
const witness={version:1,status:'P2_INTERACTIVE_LIFECYCLE_CASE_OBSERVED',actorId:actor,...selection,requestId,httpStatus:202,
 baselineSha256:'3'.repeat(64),frontendStatus:'suspended',accountVersion:2,sessionsBefore:1,sessionsAfter:0,learningUpdates:false,commandId,
 deliveries:['course','community'].map(receiver=>({receiver,status:'pending',attempts:0})),pendingOrDeliveringCount:2,
 observedAt:new Date().toISOString(),readOnly:true};
const evidence=identity?{browserIdentity:{...identityActor,sessionVerified:true},
 identityWitness:{...identityActor,actorActive:true,...(context==='owner'?{ownerMappingVerified:true}:{liveSessionCount:1})}}
 :{browserResponse:response,lifecycleWitness:witness};
const invalidEvidence=identity?{...evidence,identityWitness:{...evidence.identityWitness,actorId:target}}
 :{...evidence,browserResponse:{...response,unexpected:'fixture-forbidden'}};
let handle;
const result=start()(async(_verify,_signal,host)=>{
 await assert.rejects(host.interactiveStage(browser));
 await host.arm({receipt,probe:{}});
 handle=await host.interactiveStage(browser);
 assert.deepEqual(Object.keys(handle),[]);
 assert.throws(()=>readP2CertificationInteractiveStage(handle,{...plan}));
 const stage=readP2CertificationInteractiveStage(handle,plan);
 await assert.rejects(host.interactiveStage(browser));
 await assert.rejects(host.gatewayStage('browser'));
 await assert.rejects(host.nativeControl.setEnabled(plan.nativePlan,true));
 await assert.rejects(host.prepareClose({status:status('JOINED')}));
 await assert.rejects(stage.installPermit());
 assert.equal((await stage.prepare()).status,status('PREPARED'));
 await assert.rejects(stage.prepare());
 assert.equal((await stage.open()).status,status('OPENED'));
 if(installFailure){
  await assert.rejects(stage.installPermit(),{message:'P2_CERTIFICATION_INTERACTIVE_PERMIT_INSTALL_FAILED'});
  await assert.rejects(stage.installPermit());
  assert.deepEqual(await stage.fence(),fenced);
  await assert.rejects(stage.retain(evidence));
  throw new Error('fixture-stop-after-fence');
 }
 const ack=await stage.installPermit();
 assert.deepEqual(Object.keys(ack).sort(),['bindingSha256','challenge','context','epoch','expires','stage','type']);
 assert.equal(ack.context,context);
 await assert.rejects(stage.installPermit());
 await assert.rejects(stage.retain(evidence));
 assert.deepEqual(await stage.fence(),fenced);
 await assert.rejects(stage.fence());
 await assert.rejects(stage.retain(invalidEvidence));
 if(behavior==='wrong-join'){
  await assert.rejects(stage.retain(evidence),{message:'P2_CERTIFICATION_TRANSPORT_REFUSED'});
  await assert.rejects(stage.retain(evidence));
  throw new Error('fixture-stop-after-mismatched-join');
 }
 const retained=await stage.retain(evidence);
 assert.equal(retained.status,status('JOINED'));
 if(identity) assert.equal(retained.context,context);
 await assert.rejects(stage.retain(evidence));
 await assert.rejects(host.prepareClose({...retained,actorId:target}));
 await host.prepareClose(retained);await host.finish(outcome);
 return 'fixture-joined';
});
if(behavior!=='joined'){
 await assert.rejects(result,{message:'P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW'});
 assert.equal(existsSync(join(directory,'p2-host-certification-outcome.json')),false);
}else{
 assert.equal(await result,'fixture-joined');
 assert.deepEqual(JSON.parse(readFileSync(join(directory,'p2-host-certification-outcome.json'))),outcome);
}
assert.equal(starts,1);assert.equal(installCount,behavior==='wrong-selector'?0:1);
if(privatePacket) assert.ok(!Object.hasOwn(privatePacket,'cookie'));
assert.throws(()=>readP2CertificationInteractiveStage(handle,plan));
assert.deepEqual(writes.filter(row=>row.operation?.startsWith('interactive-')).map(row=>row.operation),
 ['interactive-prepare','interactive-open','interactive-permit','interactive-fence',...(installFailure?[]:['interactive-retain'])]);
assert.ok(!JSON.stringify(writes).includes('v2.8.')&&!JSON.stringify(writes).includes('fixture-forbidden'));
`;

for(const [certificationStage,actorKind,behavior] of [
 ['lifecycle','admin','joined'],
 ['lifecycle','customer','install-failure'],
 ['identity','admin','joined'],
 ['identity','customer','joined'],
 ['identity','customer','wrong-selector'],
 ['identity','admin','wrong-join'],
]){
 test(`fixed interactive transport handles ${certificationStage} ${actorKind} ${behavior} over the guarded pipe`,()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-interactive-wire-')));chmodSync(directory,0o700);
  try{
   // Subprocess-local imports project the source-owned recorder and fixed SSH
   // launch onto a synthetic recorder and actual Python pipes. The transport
   // runs with its ordinary launch argument and retains no test-only bypass.
   const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',interactiveHarness],{
    input:JSON.stringify({certificationStage,actorKind,behavior,directory,profile,program:interactiveProgram,
      transportUrl:new URL('./p2-certification-transport.mjs',import.meta.url).href,
      browserUrl:new URL('./p2-lifecycle-suspension-evidence.mjs',import.meta.url).href}),encoding:'utf8',timeout:20_000,
   });
   assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
   assert.equal(result.stdout,'');
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
}
test('actual remote process death aborts before case mutation and retains no success receipt',async()=>{
 const f=fixture('death');let continued=false;try{await assert.rejects(f.factory(async(_verify,signal,host)=>{await host.arm({receipt:f.receipt,probe:{}});continued=true;assert.equal(signal.aborted,false);}));
  assert.equal(continued,false);assert.equal(existsSync(join(f.directory,'p2-host-certification-outcome.json')),false);
 }finally{f.cleanup();}
});

test('profiled transport selects only the fixed host entry and retains success after a zero exit',async()=>{
 for(const behavior of ['ready','bad-reap']){
  const f=fixture(behavior,true);
  try{
   const outcome=f.factory(async(_verify,_signal,host)=>{
    assert.equal(host.mode,'p2-bounded-certification-profiled-current');
    await host.arm({receipt:f.receipt,probe:{}});
    await host.prepareClose({status:'P2_OWNED_FIXTURE'});await host.finish(f.outcome);
   });
   if(behavior==='ready'){
    await outcome;assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'p2-host-certification-outcome.json'))),f.outcome);
   }else{
    await assert.rejects(outcome);assert.equal(existsSync(join(f.directory,'p2-host-certification-outcome.json')),false);
   }
   assert.ok(f.getCaptured().args.some(value=>value.includes('--supervisor-profiled-current')));
   assert.equal(JSON.stringify(f.getCaptured()).includes('fixture-private-stdin-only'),false);
  }finally{f.cleanup();}
 }
});
