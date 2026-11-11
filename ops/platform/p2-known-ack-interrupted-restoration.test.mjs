import assert from 'node:assert/strict';
import test from 'node:test';
import {fork,spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MODE,PROFILED_MODE,STATUS,TERMINAL,CAUSAL_FILES,REPLACEMENT_FILES,prepareInterruptedKnownAckAction,interruptedKnownAckEnvironmentLock} from './p2-known-ack-interrupted-restoration.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile} from './qualification-target-profile.mjs';
import {p2NativeHash} from './p2-lifecycle-native.mjs';
const rawReceipt=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const receiptSha256=raw=>createHash('sha256').update(raw).digest('hex');
function fixture(){
 const candidate={version:2,environment:'staging',contractPhase:'p2',releaseId:'original-candidate'},bytes=Buffer.from(JSON.stringify(candidate)+'\n');
 const configuration=Object.fromEntries(Array.from({length:19},(_,i)=>['owned-file-'+i,'a'.repeat(64)]));
 const selection={version:1,mode:MODE,restorationActionId:'restoration-c',originalCertificationActionId:'certification-b',originalRecoveryActionId:'replacement-b',
  originalOperatorSourceCommit:'b'.repeat(40),causalReceiptSha256:Object.fromEntries(CAUSAL_FILES.map(name=>[name,'a'.repeat(64)])),
  replacementReceiptSha256:Object.fromEntries(REPLACEMENT_FILES.map(name=>[name,name==='known-ack-replacement-intent.json'?'b'.repeat(64):null])),
  priorGatewayReference:{kind:'stopped-current-candidate',stopReceiptDirectory:'/var/lib/lash-her/releases/staging/p2-certification-replacement-b',stopReceiptSha256:'c'.repeat(64)}};
 return{candidate,bytes,configuration,selection,run(){return prepareInterruptedKnownAckAction(candidate,bytes,selection,configuration);}};
}
test('new action binds exact original bytes while preserving old-one and fenced-only semantics',()=>{
 const f=fixture(),plan=f.run();assert.equal(plan.mode,MODE);assert.notEqual(plan.restorationActionId,plan.originalReleaseId);assert.equal(plan.runtimeServices,10);assert.equal(plan.runtimeStages,5);
 assert.deepEqual(plan.originalGatewayUncertainty,{newWork:0,recovery:1});assert.equal(plan.frontendReadinessVerified,false);assert.equal(plan.trafficAuthorized,false);
 for(const key of ['sqlReplayAllowed','rolePreparationAllowed','loginChangeAllowed','frontendBuildAllowed','frontendPromotionAllowed','admissionOpeningAllowed','ordinaryClosedZeroGate'])assert.equal(plan[key],false);
 const noNewline=prepareInterruptedKnownAckAction(f.candidate,Buffer.from(JSON.stringify(f.candidate)),f.selection,f.configuration);assert.notEqual(noNewline.candidateSha256,plan.candidateSha256);
});
test('JSON authority/counter/container overrides and old action IDs are refused',()=>{
 for(const mutate of [f=>{f.selection.allowCounter=1;},f=>{f.selection.containerIds=['owned'];},f=>{f.selection.authorization={status:'authorized'};},
   f=>{f.selection.restorationActionId=f.candidate.releaseId;},f=>{f.selection.restorationActionId=f.selection.originalRecoveryActionId;},f=>{f.candidate.environment='production';f.bytes=Buffer.from(JSON.stringify(f.candidate));},
   f=>{f.selection.priorGatewayReference.kind='allow-old-one';},f=>{delete f.selection.causalReceiptSha256['domain.json'];},f=>{f.selection.replacementReceiptSha256['extra.json']='f'.repeat(64);}]){
  const f=fixture();mutate(f);assert.throws(()=>f.run());
 }
});
test('partial original stage prefix is evidence while gaps and complete replacements use no C path',()=>{
 const f=fixture();for(let i=0;i<3;i++){f.selection.replacementReceiptSha256[`known-ack-stage-${i}-intent.json`]='a'.repeat(64);f.selection.replacementReceiptSha256[`known-ack-stage-${i}-observed.json`]='b'.repeat(64);}
 f.selection.replacementReceiptSha256['known-ack-stage-3-intent.json']='c'.repeat(64);f.run();
 f.selection.replacementReceiptSha256['known-ack-stage-4-intent.json']='c'.repeat(64);assert.throws(()=>f.run());
 f.selection.replacementReceiptSha256['known-ack-stage-3-observed.json']='b'.repeat(64);f.selection.replacementReceiptSha256['known-ack-stage-4-observed.json']='b'.repeat(64);assert.throws(()=>f.run());
});
const program=String.raw`
import fcntl,json,os,sys,base64
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline());assert initial['mode']=='known-ack-interrupted-restoration'
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
receipt={'status':'P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED','trafficAuthorized':False,'frontendReadinessVerified':False}
seen=[]
for raw in sys.stdin:
 value=json.loads(raw);op=value['operation'];seen.append(op);reply={'id':value['id']}
 if op=='check':reply['status']='HELD'
 elif op=='arm-interrupted-restoration':reply.update(status='INTERRUPTED_RESTORATION_ARMED',receipt={'status':'P2_INTERRUPTED_FRESH_CURRENT_READY'})
 elif op=='prepare-interrupted-restoration':
  assert set(value)=={'id','operation'}
  reply.update(status='INTERRUPTED_RESTORATION_PREPARED',receipt={'status':'P2_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED'})
 elif op=='restore-runtime':
  assert seen.count(op)==1 and 'prepare-interrupted-restoration' in seen
  if sys.argv[2]=='death':os._exit(31)
  reply.update(status='INTERRUPTED_RUNTIME_READY',receipt=receipt)
 elif op=='prepare-close':reply.update(status='INTERRUPTED_CLOSE_PREPARED',receipt=receipt)
 elif op=='finish':
  assert json.loads(base64.b64decode(value['restoration']))==receipt
  reply.update(status='INTERRUPTED_RESTORATION_JOINED',receipt=receipt)
 elif op=='commit':
  reply.update(status='COMMITTED',receipt=receipt);print(json.dumps(reply),flush=True);break
 else:os._exit(32)
 print(json.dumps(reply),flush=True)
os.close(fd)
`;
function transport(mode='ready'){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-interrupted-pipe-'))),lock=join(directory,'host-lock'),receipt={status:'P2_RECOVERY_DATABASE_CURRENT'};
 const outcome={status:STATUS,trafficAuthorized:false,frontendReadinessVerified:false};writeFileSync(join(directory,'p2-recovery-current-database.json'),JSON.stringify(receipt),{mode:0o600});
 writeFileSync(join(directory,TERMINAL),JSON.stringify(outcome),{mode:0o600});
 let captured;
 const run=interruptedKnownAckEnvironmentLock({knownHosts:'/owned/known-hosts',sshKey:'/owned/key'},{mode:MODE,environment:'staging',sourceCommit:'a'.repeat(40),credentials:{private:'NEVER_IN_ARG_OR_ENV'}},directory,
 {launch(executable,args,options){captured={executable,args,options};return spawn('python3',['-I','-u','-c',program,lock,mode],options);}});
 return{directory,lock,receipt,outcome,run,captured:()=>captured,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('new host process holds actual flock and permits one explicit restore with fenced terminal',async()=>{
 const f=transport();try{
  const result=await f.run(async(verify,_signal,host)=>{await verify();
   const contender=spawnSync('python3',['-I','-c','import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)',f.lock]);assert.notEqual(contender.status,0);
   await host.arm({receipt:f.receipt,probe:{}});await host.prepare();assert.deepEqual(await host.restore(),f.outcome);await assert.rejects(host.restore());return host.prepareClose();
  });assert.deepEqual(result,f.outcome);assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'p2-host-interrupted-restoration-outcome.json'))),f.outcome);
  assert.equal(JSON.stringify(f.captured()).includes('NEVER_IN_ARG_OR_ENV'),false);
 }finally{f.cleanup();}
});
test('wrong ordering and host death cannot commit a C terminal or replay restoration',async()=>{
 for(const mode of ['ordering','death']){const f=transport(mode);try{
  await assert.rejects(f.run(async(_verify,_signal,host)=>{if(mode==='ordering')return host.restore();await host.arm({receipt:f.receipt,probe:{}});await host.prepare();return host.restore();}));
  assert.equal(existsSync(join(f.directory,'p2-host-interrupted-restoration-outcome.json')),false);
 }finally{f.cleanup();}}
});

// The owned child has a real POSIX lock. Its provider, runtime, and FE close
// receipts are protocol projections; the physical FE proof has a separate PG fixture.
const profiledProgram=String.raw`
import base64,fcntl,json,os,sys,time
lock,held,scenario=sys.argv[1:]
fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline());plan=initial['reviewedPlan'];frontend=plan['frontendPlan']
base={'version':2,'qualificationTargetProfile':initial['qualificationTargetProfile']}
assert initial['mode']=='p2-profiled-known-ack-interrupted-restoration'
assert initial['credentials']=={'private':'OWNED_PRIVATE_CANARY'}
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
if scenario=='oversized':
 print('x'*4_000_000,flush=True);sys.exit(40)
databases={name:{'jobSha256':pin,'receiptSha256':'9'*64,'image':initial['candidate']['artifacts'][name+'Migration']['image']} for name,pin in initial['apiJobSha256'].items()}
zero={'newWork':0,'recovery':0}
def gateway(running, identifier, uncertain):
 return {'process':{'running':running,'pid':12 if running else 0,'containerId':identifier},'admission':{'newWork':False,'recovery':False,'active':zero.copy(),'uncertain':uncertain}}
services=['community-api','course-api','community-tls','course-tls','course-snapshot','community-worker','course-media','course-export-cleanup','course-publisher','gateway']
restored={**base,'status':'P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED','environment':'staging','releaseId':plan['originalReleaseId'],
 'candidateSha256':plan['candidateSha256'],'restorationActionId':plan['restorationActionId'],'recoveryActionId':plan['restorationActionId'],
 'contractPhase':'p2','phase2ContractManifestSha256':frontend['phase2ContractManifestSha256'],'frontier':plan['requestedFrontier'],
 'frontendJournalSha256':'8'*64,'readinessReceiptSha256':'7'*64,'nativeDisabled':True,'runtimeReplacements':1,
 'apiDatabases':databases,'currentApiDatabasesAfter':databases.copy(),'containers':[{'service':service,'containerId':format(i+1,'064x')[:64]} for i,service in enumerate(services)],
 'boundaryChecks':['public-tls-missing-workload-denied','public-metrics-hidden','private-course-tls-catalog','private-application-credential-required','private-community-peer-denied'],
 'stoppedGateway':gateway(False,'f'*64,{'newWork':0,'recovery':1 if plan['requestedFrontier']=='original-stopped-one' else 0}),
 'newGateway':gateway(True,format(10,'064x'),zero.copy())}
restored.update({name:False for name in ('sqlReplayed','migrationsExecuted','rolePreparationRepeated','frontendSqlApplied','newWorkOpened','recoveryOpened','trafficAuthorized')})
replacement_fields=('replacementRelease','originalReleaseReceiptSha256','originalReleasePlanSha256')
if 'replacementRelease' in plan:
 assert all(plan[key]==frontend[key] for key in replacement_fields)
 assert json.loads(base64.b64decode(initial['originalReleaseReceipt']))['frontendSqlApplied'] is True
 assert initial['frontendJob']['target']['allowEmptyBootstrap'] is True
 restored.update({key:plan[key] for key in replacement_fields})
mutations={'foreign-runtime-profile':lambda:restored.update(version=1),'changed-journal':lambda:restored.update(frontendJournalSha256='0'*64),
 'changed-api':lambda:restored['currentApiDatabasesAfter'].update(course={**databases['course'],'receiptSha256':'0'*64}),
 'open-gateway':lambda:restored['newGateway']['admission'].update(recovery=True),
 'wrong-frontier-count':lambda:restored['stoppedGateway']['admission']['uncertain'].update(recovery=2),
 'duplicate-service':lambda:restored['containers'][0].update(service='gateway'),
 'changed-replacement-terminal':lambda:restored.update(originalReleaseReceiptSha256='0'*64),
 'missing-replacement-terminal':lambda:restored.pop('replacementRelease')}
if scenario in mutations:mutations[scenario]()
steps=['arm-interrupted-restoration','prepare-interrupted-restoration','restore-runtime','prepare-close','finish','commit'];seen=[];heartbeat_during_restore=False
for raw in sys.stdin:
 frame=json.loads(raw);op=frame['operation'];reply={'id':frame['id']}
 if op=='check':
  assert set(frame)=={'id','operation'}
  if len(seen)==3:heartbeat_during_restore=True
  reply['status']='HELD'
 else:
  assert op==steps[len(seen)];seen.append(op)
  if op=='arm-interrupted-restoration':
   assert set(frame)=={'id','operation','receipt','probe'}
   assert base64.b64decode(frame['receipt']).endswith(b'\n') and json.loads(base64.b64decode(frame['receipt']))==frame['probe']['receipt']
   reply.update(status='INTERRUPTED_RESTORATION_ARMED',receipt={**base,'status':'P2_PROFILED_INTERRUPTED_FRESH_CURRENT_READY',
    'restorationActionId':plan['restorationActionId'],'candidateSha256':plan['candidateSha256'],'authorityIssued':False,
    'apiDatabases':{} if scenario=='wrong-arm-api' else databases})
  elif op=='prepare-interrupted-restoration':
   assert set(frame)=={'id','operation'} and os.path.exists(held)
   reply.update(status='INTERRUPTED_RESTORATION_PREPARED',receipt={**base,'status':'P2_PROFILED_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED','authoritySha256':'6'*64})
  elif op=='restore-runtime':
   assert set(frame)=={'id','operation'} and os.path.exists(held)
   if scenario=='heartbeat':time.sleep(1.2)
   reply.update(status='INTERRUPTED_RUNTIME_READY',receipt=restored)
  elif op=='prepare-close':
   assert set(frame)=={'id','operation'} and os.path.exists(held)
   reply.update(status='INTERRUPTED_CLOSE_PREPARED',receipt=restored if scenario!='changed-close' else {**restored,'trafficAuthorized':True})
  elif op=='finish':
   assert set(frame)=={'id','operation','restoration'}
   assert not os.path.exists(held) and json.loads(base64.b64decode(frame['restoration']))==restored
   if scenario=='no-independent-close':os._exit(43)
   reply.update(status='INTERRUPTED_RESTORATION_JOINED',receipt=restored if scenario!='changed-join' else {**restored,'runtimeReplacements':2})
  elif op=='commit':
   assert set(frame)=={'id','operation'}
   assert scenario!='heartbeat' or heartbeat_during_restore
   reply.update(status='COMMITTED',receipt=restored);print(json.dumps(reply),flush=True)
   if scenario=='ack-exit-nonzero':os._exit(44)
   if scenario=='ack-exit-zero':break
   if scenario=='ack-trailing-frame':print(json.dumps({'id':99999,'status':'HELD'}),flush=True)
   if scenario=='ack-partial-frame':sys.stdout.write('{');sys.stdout.flush()
   sys.stdin.read();break
 print(json.dumps(reply),flush=True)
os.close(fd)
`;

async function projectedProfiledLock(){
 const source=new URL('./p2-known-ack-interrupted-restoration.mjs',import.meta.url),projection=new URL(source);
 projection.search='?owned-profiled-transport';
 const hook=registerHooks({load(url,context,next){
  if(url!==projection.href)return next(url,context);
  return{format:'module',shortCircuit:true,source:readFileSync(source,'utf8')+'\nexport {withProfiledInterruptedEnvironmentLock};'};
 }});
 try{return (await import(projection.href)).withProfiledInterruptedEnvironmentLock;}finally{hook.deregister();}
}

function replacementDescriptor(){
 return {version:1,kind:'frontend-replacement',qualificationTargetProfile:profile,reviewedPlanSha256:'1'.repeat(64),
  runtimeReviewSha256:'2'.repeat(64),postflightSha256:'3'.repeat(64),frontendSessionClosedSha256:'4'.repeat(64),
  frontendDatabaseReceiptSha256:'5'.repeat(64),databaseOid:'412',migrationRoleOid:'413',predecessorRuntimeRole:'owned_prior',
  administrativeLogins:[{name:'owned_admin',oid:'415'}]};
}

function profiledFixture(run,scenario='ready',frontier='original-stopped-one',replacing=false){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-profiled-interrupted-pipe-'))),lock=join(directory,'host-lock'),held=join(directory,'frontend-session-model');
 const base={version:2,qualificationTargetProfile:profile},actionId='restoration-owned-c',sourceCommit='a'.repeat(40),operatorSourceCommit='b'.repeat(40);
 const targetSha256='c'.repeat(64),candidateSha256='d'.repeat(64),releaseId='candidate-owned';
 const frontendPlan={...base,mode:PROFILED_MODE,certificationActionId:actionId,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'e'.repeat(64)};
 const initial={...base,environment:'staging',mode:PROFILED_MODE,sourceCommit:operatorSourceCommit,confirmation:'staging/'+actionId,
  restorationActionId:actionId,recoveryActionId:actionId,targetSha256,candidateSha256,credentials:{private:'OWNED_PRIVATE_CANARY'},
  frontendJob:{...base,sourceCommit,releaseId,target:{qualificationTargetProfile:profile,allowEmptyBootstrap:false,approvedPendingTags:[]}},
  inventory:{...base},owner:{name:'owned',oid:'123'},frontendBaseline:{catalog:{}},apiJobSha256:{course:'1'.repeat(64),community:'2'.repeat(64)},
  candidate:{...base,version:3,releaseId,sources:{frontend:{commit:sourceCommit}},frontendMigration:{qualificationTargetProfile:profile},
   artifacts:{courseMigration:{image:'owned-course'},communityMigration:{image:'owned-community'}}},
  reviewedPlan:{...base,mode:PROFILED_MODE,restorationActionId:actionId,originalReleaseId:releaseId,sourceCommit,operatorSourceCommit,
   candidateSha256,targetSha256,requestedFrontier:frontier,frontendPlan}};
 const receipt={...base,status:'P2_CERTIFICATION_DATABASE_CURRENT',journalSha256:'8'.repeat(64)};
 const probe={...base,plan:frontendPlan,job:initial.frontendJob,baseline:initial.frontendBaseline,owner:initial.owner,receipt};
 if(replacing){
  const replacementRelease=replacementDescriptor(),runtime={name:'owned_runtime',oid:'414'},producerSha256='6'.repeat(64);
  const configurationSha256={'gateway.json':'7'.repeat(64)};
  const terminalRaw=rawReceipt({...base,status:'P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION',environment:'staging',releaseId,sourceCommit,
   targetSha256,candidateSha256,contractPhase:frontendPlan.contractPhase,phase2ContractManifestSha256:frontendPlan.phase2ContractManifestSha256,
   ...Object.fromEntries(['reviewedPlanSha256','runtimeReviewSha256','postflightSha256','frontendSessionClosedSha256','frontendDatabaseReceiptSha256']
    .map(key=>[key,replacementRelease[key]])),configurationSha256,owner:initial.owner,runtime,producerSha256,
   migrationMode:'apply-forward',frontendSqlApplied:true,frontendSqlReplayed:false,frontendSessionClosed:true,trafficAuthorized:false,releaseAccepted:false});
  const provenance={replacementRelease,originalReleaseReceiptSha256:receiptSha256(terminalRaw),originalReleasePlanSha256:replacementRelease.reviewedPlanSha256};
  Object.assign(frontendPlan,provenance);Object.assign(initial.reviewedPlan,provenance,{configurationSha256});
  initial.originalReleaseReceipt=terminalRaw.toString('base64');
  Object.assign(initial.inventory,{replacementRelease,producers:[{role:runtime,producerSha256}]});
  Object.assign(initial.frontendJob.target,{allowEmptyBootstrap:true,approvedPendingTags:['0001_fixture'],runtimeRole:runtime.name});
  Object.assign(receipt,{replacementRelease,effectiveLoginBoundaryVerified:true,predecessorRuntimeRoleAbsent:true});
  Object.assign(probe,{replacementRelease,producers:initial.inventory.producers});
 }
 const prepared=join(directory,'p2-profiled-interrupted-close-prepared.json'),terminal=join(directory,'p2-profiled-interrupted-host-outcome.json');
 let launched;
 const launch=(executable,args,options)=>{launched={executable,args,options};return spawn('python3',['-I','-u','-c',profiledProgram,lock,held,scenario],options);};
 const execute=task=>run({knownHosts:'/owned/known-hosts',sshKey:'/owned/key'},initial,directory,task,launch);
 async function restore(verify,_signal,host){
  writeFileSync(held,'projection',{mode:0o600});
  writeFileSync(join(directory,'p2-profiled-interrupted-frontend-current.json'),JSON.stringify(receipt)+'\n',{mode:0o600});
  try{
   await verify();
   const contender=spawnSync('python3',['-I','-c','import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)',lock]);
   assert.notEqual(contender.status,0);
   await host.arm({receipt,probe});await host.prepare();await host.restore();await host.prepareClose();
   assert.equal(existsSync(prepared),true);assert.equal(existsSync(terminal),false);
  }finally{unlinkSync(held);}
 }
 return{initial,probe,receipt,prepared,terminal,restore,execute,launched:()=>launched,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

test('profiled transport accepts each stopped frontier only after a close join and zero child exit',async()=>{
 const run=await projectedProfiledLock();
 for(const [frontier,scenario] of [['original-stopped-one','heartbeat'],['replacement-stopped-zero','ack-exit-zero']]){
  const fixture=profiledFixture(run,scenario,frontier);
  try{
   const result=await fixture.execute(fixture.restore);
   assert.equal(result.frontier,frontier);
   assert.deepEqual(JSON.parse(readFileSync(fixture.terminal)),result);
   assert.deepEqual(readFileSync(fixture.prepared),readFileSync(fixture.terminal));
   assert.equal(fixture.launched().executable,'/usr/bin/ssh');
   assert.equal(fixture.launched().args.at(-1),"'sudo' '-n' '/usr/bin/python3' '-I' '-u' '/opt/lash-her/operators/"+
    fixture.initial.sourceCommit+"/ops/platform/host/p2_profiled_known_ack_restoration_parent.py' '--supervisor-profiled-current'");
   assert.equal(JSON.stringify(fixture.launched()).includes('OWNED_PRIVATE_CANARY'),false);
  }finally{fixture.cleanup();}
 }
});

test('profiled transport rejects prelaunch mode and bounds violations without opening SSH',async()=>{
 const run=await projectedProfiledLock();
 for(const mutate of [initial=>{initial.mode=MODE;},initial=>{delete initial.reviewedPlan.frontendPlan.qualificationTargetProfile;},
  initial=>{initial.confirmation='staging/original-b';},initial=>{initial.privateOversize='x'.repeat(4_000_000);}]){
  const fixture=profiledFixture(run);try{
   mutate(fixture.initial);await assert.rejects(fixture.execute(()=>assert.fail('must not invoke the held task')));
   assert.equal(fixture.launched(),undefined);
  }finally{fixture.cleanup();}
 }
});

test('profiled transport refuses a wrong order, changed proofs, or an unbounded response before commit',async()=>{
 const run=await projectedProfiledLock();
 for(const scenario of ['ordering','wrong-arm-api','foreign-runtime-profile','changed-journal','changed-api','open-gateway',
  'wrong-frontier-count','duplicate-service','changed-close','oversized']){
  const fixture=profiledFixture(run,scenario);try{
   const task=scenario==='ordering'?(_verify,_signal,host)=>host.restore():fixture.restore;
   await assert.rejects(fixture.execute(task));assert.equal(existsSync(fixture.terminal),false,scenario);
  }finally{fixture.cleanup();}
 }
});

test('profiled close preparation remains only evidence if independent close, commit stream, or child exit fails',async()=>{
 const run=await projectedProfiledLock();
 for(const scenario of ['no-independent-close','changed-join','ack-exit-nonzero','ack-trailing-frame','ack-partial-frame']){
  const fixture=profiledFixture(run,scenario);try{
   await assert.rejects(fixture.execute(fixture.restore));
   assert.equal(existsSync(fixture.prepared),true,scenario);assert.equal(existsSync(fixture.terminal),false,scenario);
  }finally{fixture.cleanup();}
 }
});

test('replacement transport retains the original terminal provenance through a fenced restore',async()=>{
 const run=await projectedProfiledLock(),fixture=profiledFixture(run,'ack-exit-zero','replacement-stopped-zero',true);
 try{
  const result=await fixture.execute(fixture.restore);
  for(const key of ['replacementRelease','originalReleaseReceiptSha256','originalReleasePlanSha256'])
   assert.deepEqual(result[key],fixture.initial.reviewedPlan[key]);
  assert.equal(result.frontendSqlApplied,false);
  assert.equal(result.sqlReplayed,false);
  assert.equal(result.trafficAuthorized,false);
  assert.deepEqual(JSON.parse(readFileSync(fixture.terminal)),result);
 }finally{fixture.cleanup();}
});

test('replacement transport refuses mixed provenance, unbound login proof and changed terminal',async()=>{
 const run=await projectedProfiledLock();
 for(const mutate of [initial=>{delete initial.originalReleaseReceipt;},initial=>{initial.originalReleaseReceipt+='\n';},
  initial=>{initial.reviewedPlan.frontendPlan.originalReleasePlanSha256='9'.repeat(64);},
  initial=>{initial.inventory.historicalLogins={};},initial=>{initial.frontendJob.target.allowEmptyBootstrap=false;},
  initial=>{delete initial.inventory.replacementRelease;},initial=>{delete initial.reviewedPlan.originalReleaseReceiptSha256;},
  initial=>{initial.replacementRelease=initial.reviewedPlan.replacementRelease;},
 ]){
  const fixture=profiledFixture(run,'ready','original-stopped-one',true);try{
   mutate(fixture.initial);
   await assert.rejects(fixture.execute(()=>assert.fail('replacement must refuse before launch')));
   assert.equal(fixture.launched(),undefined);
  }finally{fixture.cleanup();}
 }
 for(const scenario of ['changed-replacement-terminal','missing-replacement-terminal','missing-login-proof']){
  const fixture=profiledFixture(run,scenario,'original-stopped-one',true);try{
   if(scenario==='missing-login-proof')delete fixture.receipt.effectiveLoginBoundaryVerified;
   await assert.rejects(fixture.execute(fixture.restore));
   assert.equal(existsSync(fixture.terminal),false);
  }finally{fixture.cleanup();}
 }
});

test('owned failure metadata excludes messages, values, raw URLs and non-source frames and bounds causes',async()=>{
 const {ownedFailureDiagnostic,ownedEngineDiagnostic,validateOwnedDiagnostic}=await import('../../docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs');
 const context={sourceRoot:'/reviewed',dependencyRoot:'/dependencies',sourceFiles:['src/known.ts'],packages:['jose'],phases:['c-original-api-current'],sourceCodes:['P2_SOURCE_CONTENT_CHANGED'],generatedFiles:{'/owned/old-b-process.mjs':'owned-fixture/old-b-process.mjs'}};
 const canary='PRIVATE_PASSWORD_URL_SQL_ACTUAL_EXPECTED_CANARY',error=new Error(canary);
 Object.assign(error,{code:'ERR_MODULE_NOT_FOUND',url:'file:///reviewed/src/known.ts?password='+canary,actual:canary,expected:canary});
 error.stack='Error: '+canary+'\n at hidden (/private/'+canary+':9:1)\n at source (file:///reviewed/src/known.ts:42:7)';
 let value=error;for(let index=0;index<5;index++){value.cause=new Error(canary);Object.assign(value.cause,{name:canary,code:canary,path:'/private/'+canary});value=value.cause;}
 const safe=ownedFailureDiagnostic(error,'c-original-api-current',context);
 assert.equal(JSON.stringify(safe).includes(canary),false);assert.equal(JSON.stringify(safe).includes('/reviewed'),false);
 assert.equal(safe.error.module,'src/known.ts');assert.deepEqual(safe.error.frames,[{file:'src/known.ts',line:42,column:7}]);assert.equal(safe.error.code,'ERR_MODULE_NOT_FOUND');
 assert.equal(safe.causes.length,3);assert.equal(safe.causeLimitReached,true);assert.equal(safe.causes[0].kind,'Unknown');assert.equal(validateOwnedDiagnostic(safe,context),safe);
 for(const change of [v=>{v.error.message=canary;},v=>{v.error.kind=canary;},v=>{v.error.code=canary;},v=>{v.error.frames[0].file='/private/'+canary;},v=>{v.causes.push(v.causes[0]);}]){const bad=structuredClone(safe);change(bad);assert.equal(validateOwnedDiagnostic(bad,context),null);}
 const unknown=ownedFailureDiagnostic(Object.assign(new Error(canary),{name:canary,code:canary,url:'https://user:'+canary+'@private.invalid/'}),canary,context);
 assert.equal(unknown.phase,'unknown');assert.equal(unknown.error.code,null);assert.equal(unknown.error.module,null);assert.equal(JSON.stringify(unknown).includes(canary),false);
 const engineContext={...context,sourceFiles:[...context.sourceFiles,'ops/platform/host/p2_known_ack_interrupted_restoration.py']};
 const engine=ownedEngineDiagnostic(JSON.stringify({status:'OWNED_C_ENGINE_FAILED',kind:'ValueError',code:'P2_SOURCE_CONTENT_CHANGED',trace:[canary],stage:canary,frames:[null,{file:'p2_known_ack_interrupted_restoration.py',line:99},{file:canary,line:4}]}),'c-original-api-current',engineContext);
 assert.equal(JSON.stringify(engine).includes(canary),false);assert.equal(engine.error.code,'P2_SOURCE_CONTENT_CHANGED');assert.equal(validateOwnedDiagnostic(engine,engineContext),engine);
});

test('owned engine projects exact archived v1 source within its existing bounds',()=>{
 const root=new URL('../../',import.meta.url);
 const result=spawnSync('python3',['-B','-c',String.raw`
import hashlib, runpy, subprocess, tempfile
from pathlib import Path
root = Path.cwd()
engine = runpy.run_path(str(root / 'docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py'))
git = ['git', '--no-replace-objects', '-c', f'safe.directory={root}']
commit = subprocess.check_output([*git, 'rev-parse', '--verify', 'HEAD^{commit}'], text=True).strip()
with tempfile.TemporaryDirectory() as directory:
    source = Path(directory)
    manifest = engine['archive_operator_sources'](str(root), commit, source)
    assert engine['REQUIRED'] <= manifest.keys()
    assert engine['PROFILED_CURRENT_SOURCE_ONLY'].isdisjoint(manifest)
    assert engine['LEGACY_FIXTURE_EVIDENCE_ONLY'].isdisjoint(manifest)
    assert engine['INTERRUPTED_RESTORATION_UNRELATED_HARNESS'].isdisjoint(manifest)
    assert not (source / 'ops/platform/host/p2_certification_parent_test.py').exists()
    assert not (source / 'ops/platform/prepare-p2-identity-probe-fixtures.test.mjs').exists()
    assert not (source / 'ops/platform/harness/owned-frontend-identity-admission.mjs').exists()
    assert len(manifest) <= 512 and sum((source / name).stat().st_size for name in manifest) <= 41_000_000
    retained = 'ops/platform/host/p2_release_supervisor.py'
    committed = subprocess.check_output([*git, 'cat-file', 'blob', f'{commit}:{retained}'])
    assert manifest[retained] == hashlib.sha256(committed).hexdigest()
`],{cwd:root,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH}});
 assert.equal(result.status,0,result.error?.message??result.stderr);
});

test('actual failing original child reaches outer private capture through fixed catch and cleanup',async()=>{
 const {ownedDiagnosticSource,ownedDiagnosticContext}=await import('../../docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs');
 const {fileURLToPath,pathToFileURL}=await import('node:url'),paths=await import('node:path'),fs=await import('node:fs'),vm=await import('node:vm'),{createRequire}=await import('node:module'),{createHash}=await import('node:crypto');
 const root=fileURLToPath(new URL('../../',import.meta.url)),entry=join(root,'docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs');
 const context=ownedDiagnosticContext(root),source=ownedDiagnosticSource(context),canary='CHILD_PRIVATE_MESSAGE_PAYLOAD_CANARY';
 const childProgram=`let phase='c-original-api-current',observed,cEngineDiagnostic=null;const error=Object.assign(new Error(${JSON.stringify(canary)}),{code:'ERR_MODULE_NOT_FOUND',url:${JSON.stringify(pathToFileURL(join(root,'src/lib/private-db/client.ts')).href)}});Promise.reject(error)${source.harnessCatch}`;
 const inner=spawnSync(process.execPath,['--input-type=module','-e',childProgram],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(inner.status,1);assert.equal(inner.stdout,'');assert.equal(inner.stderr.includes(canary),false);
 const original=JSON.parse(inner.stderr);assert.equal(original.diagnostic.error.code,'ERR_MODULE_NOT_FOUND');assert.equal(original.diagnostic.error.module,'src/lib/private-db/client.ts');
 const parentProgram=`import {readFileSync} from 'node:fs';const item=JSON.parse(readFileSync(0,'utf8'));${source.parentForward}process.exitCode=1;`;
 const parent=spawnSync(process.execPath,['--input-type=module','-e',parentProgram],{input:inner.stderr,encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(parent.status,1);assert.equal(parent.stdout,'');assert.deepEqual(JSON.parse(parent.stderr),original.diagnostic);assert.equal(parent.stderr.includes(canary),false);
 // Execute the actual fixture entry's source-generation/failure/cleanup path.
 // Only the PostgreSQL outer launch is substituted by the real failed child
 // result above; no test selector, provider transport or production input exists.
 const captures=[];let folder,launched=false;
 let program=readFileSync(entry,'utf8').replace(/^import .*;$/gmu,'').replace(/^export /gmu,'').replaceAll('import.meta.url','FAKE_META_URL');
 const fakeProcess={argv:[process.execPath,entry],execPath:process.execPath,env:{P2_INTERRUPTED_OWNED_TEST:'true',PATH:process.env.PATH},stderr:{write:value=>captures.push(value)},stdout:{write:()=>assert.fail('failure must not emit success')},exit:()=>assert.fail('unexpected ownership/argument refusal')};
 vm.runInNewContext(program,{URL,Buffer,performance,FAKE_META_URL:pathToFileURL(entry).href,process:fakeProcess,assert,readFileSync:fs.readFileSync,writeFileSync:fs.writeFileSync,realpathSync:fs.realpathSync,symlinkSync:fs.symlinkSync,rmSync:fs.rmSync,
  mkdtempSync:value=>(folder=fs.realpathSync(fs.mkdtempSync(value))),spawnSync(file,args,options){if(file==='git'||args[0]==='--check')return spawnSync(file,args,options);assert.equal(args[0],'--import');assert.equal(args[1],'tsx');assert.equal(paths.basename(args[2]),'cluster-and-new-c-process.mjs');assert.equal(options.env.TMPDIR,folder);assert.equal(fs.realpathSync(options.env.TMPDIR),folder);launched=true;return parent;},
  join:paths.join,dirname:paths.dirname,resolve:paths.resolve,tmpdir,createRequire,createHash,pathToFileURL,fileURLToPath},{timeout:10000});
 assert.equal(launched,true);assert.equal(fakeProcess.exitCode,1);assert.equal(existsSync(folder),false);assert.equal(captures.join(''),parent.stderr);assert.equal(captures.join('').includes(canary),false);
});

// Exercise the unchanged receiver guard through its real child IPC. Failure
// payloads remain private; no database or provider setup is reached.
test('actual receiver refuses Linux tmp roots and preserves its supported private/var boundary',async()=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-c-receiver-root-')));
 const receiver=new URL('./harness/owned-phase2-lifecycle-receiver.mjs',import.meta.url);
 async function classify(root){
  const child=fork(receiver,[],{cwd:directory,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1'}});
  try{
   const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('OWNED_RECEIVER_GUARD_TIMEOUT')),5000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('OWNED_RECEIVER_GUARD_EXIT'));});
    child.send({id:1,op:'initialize',root,database:{host:'127.0.0.1',database:'owned_lifecycle_course_test'},clock:0,service:'course',keys:{}});});
   assert.equal(typeof result.error,'string');return result.error.includes('input.root.startsWith')?'root-guard':'later-owned-dependency';
  }finally{if(child.exitCode===null){const exit=new Promise(done=>child.once('exit',done));child.kill('SIGKILL');await exit;}}
 }
 try{
  assert.equal(await classify('/tmp/p2-c-no-dependencies-'+process.pid),'root-guard');
  assert.equal(await classify('/var/tmp/p2-c-no-dependencies-'+process.pid),'later-owned-dependency');
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('generated C child keeps its source-owned temp root through the actual TSX cache path',async()=>{
 const {fileURLToPath,pathToFileURL}=await import('node:url'),paths=await import('node:path'),fs=await import('node:fs'),vm=await import('node:vm'),{createRequire}=await import('node:module'),{createHash}=await import('node:crypto');
 const root=fileURLToPath(new URL('../../',import.meta.url)),entry=join(root,'docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs');
 const originalEnvironment=readFileSync(join(root,'ops/platform/test-p2-known-ack-loss-local.mjs'),'utf8').match(/^const safeEnvironment=.*;$/mu)?.[0];assert.ok(originalEnvironment);
 const safeEnvironment=Function('process',originalEnvironment+'return safeEnvironment;')(process);
 let folder,launched=false;
 const program=readFileSync(entry,'utf8').replace(/^import .*;$/gmu,'').replace(/^export /gmu,'').replaceAll('import.meta.url','FAKE_META_URL');
 const fakeProcess={argv:[process.execPath,entry],execPath:process.execPath,env:{P2_INTERRUPTED_OWNED_TEST:'true',PATH:process.env.PATH,TMPDIR:'AMBIENT_TEMP_CANARY',VERCEL_TOKEN:'AMBIENT_SECRET_CANARY'},stderr:{write:()=>{}},stdout:{write:()=>assert.fail('projected outer failure must emit no success')},exit:()=>assert.fail('unexpected ownership/argument refusal')};
 vm.runInNewContext(program,{URL,Buffer,performance,FAKE_META_URL:pathToFileURL(entry).href,process:fakeProcess,assert,readFileSync:fs.readFileSync,writeFileSync:fs.writeFileSync,realpathSync:fs.realpathSync,symlinkSync:fs.symlinkSync,rmSync:fs.rmSync,
  mkdtempSync:value=>(folder=fs.realpathSync(fs.mkdtempSync(value))),spawnSync(file,args,options){
   if(file==='git'||args[0]==='--check')return spawnSync(file,args,options);
   assert.equal(paths.basename(args[2]),'cluster-and-new-c-process.mjs');
   const outer=readFileSync(args[2],'utf8'),start=outer.indexOf('const cChild=spawnSync('),end=outer.indexOf(');\n    if(cChild.status',start);assert.ok(start>=0&&end>start);
   const childEntry=join(folder,'cache-probe.ts'),preload=join(folder,'missing-default-temp.mjs');
   writeFileSync(childEntry,"import {tmpdir} from 'node:os';const actual:number=1;process.stdout.write(JSON.stringify({temporaryRoot:tmpdir(),actual}));",{mode:0o600});
   // Model Linux's missing /tmp only at the actual dependency mkdir call.
   // The real TSX import/transform runs; no shared temp directory is modified.
   writeFileSync(preload,"import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.mkdirSync,blocked='/tmp/tsx-'+process.geteuid();fs.mkdirSync=function(path,...args){if(String(path)===blocked)throw Object.assign(new Error('OWNED_MISSING_DEFAULT_TEMP'),{code:'ENOENT'});return Reflect.apply(original,this,[path,...args]);};syncBuiltinESMExports();",{mode:0o600});
   Function('spawnSync','process','cInput','safeEnvironment','certificate',outer.slice(start,end+2))((exe,argv,selected)=>{
    launched=true;assert.equal(exe,process.execPath);assert.deepEqual(argv.slice(0,2),['--import','tsx']);assert.equal(paths.basename(argv[2]),'owned-process.mjs');
    const probe=environment=>spawnSync(exe,['--import',preload,'--import','tsx',childEntry],{cwd:root,encoding:'utf8',env:environment,timeout:10000});
    const original={...selected.env};delete original.TMPDIR;const refused=probe(original);assert.equal(refused.status,1);assert.match(refused.stderr,/ENOENT/u);assert.equal(refused.stdout,'');
    const actual=probe(selected.env);assert.equal(actual.status,0);assert.equal(actual.stderr,'');assert.deepEqual(JSON.parse(actual.stdout),{temporaryRoot:folder,actual:1});
    assert.equal(selected.env.TMPDIR,folder);assert.equal(realpathSync(selected.env.TMPDIR),folder);assert.equal(JSON.stringify(selected.env).includes('AMBIENT_TEMP_CANARY'),false);assert.equal(JSON.stringify(selected.env).includes('AMBIENT_SECRET_CANARY'),false);
    return actual;
   },process,{},safeEnvironment,undefined);
   return {status:1,stdout:'',stderr:''};
  },join:paths.join,dirname:paths.dirname,resolve:paths.resolve,tmpdir,createRequire,createHash,pathToFileURL,fileURLToPath},{timeout:30000});
 assert.equal(launched,true);assert.equal(fakeProcess.exitCode,1);assert.equal(existsSync(folder),false);
});

async function projectedReplacementPlanner(select){
 const source=new URL('./p2-known-ack-interrupted-restoration.mjs',import.meta.url),projection=new URL(source);
 projection.search='?owned-replacement-planner';
 const reader=new URL('./p2-certification-replacement-release.mjs',import.meta.url),stub=new URL(reader);
 stub.search='?owned-replacement-reader';
 const key=Symbol.for('p2-interrupted-owned-replacement-reader');
 globalThis[key]=select;
 const hook=registerHooks({
  resolve(specifier,context,next){
   const resolved=next(specifier,context);
   return context.parentURL===projection.href&&resolved.url===reader.href?{url:stub.href,shortCircuit:true}:resolved;
  },
  load(url,context,next){
   if(url===projection.href)return{format:'module',shortCircuit:true,source:readFileSync(source,'utf8')+'\nexport {profiledInterruptedHostPacket};'};
   if(url===stub.href)return{format:'module',shortCircuit:true,source:
    `export {validP2CertificationReplacementDescriptor} from ${JSON.stringify(reader.href)};
      export const prepareP2CertificationReplacementRelease=(settings,selection)=>globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})](settings,selection);`};
   return next(url,context);
  },
 });
 try{return await import(projection.href);}finally{hook.deregister();}
}

test('replacement interrupted planner joins retained certification and exact original host packet',async t=>{
 const results=realpathSync(mkdtempSync(join(tmpdir(),'p2-interrupted-replacement-plan-')));
 t.after(()=>{delete globalThis[Symbol.for('p2-interrupted-owned-replacement-reader')];rmSync(results,{recursive:true,force:true});});
 const base={version:2,qualificationTargetProfile:profile},environment='staging',releaseId='owned-frontend-replacement',sourceCommit='a'.repeat(40);
 const targetSha256='b'.repeat(64),candidateSha256='c'.repeat(64),inventorySha256='d'.repeat(64),apiJobSha256={course:'e'.repeat(64),community:'f'.repeat(64)};
 const configurationSha256={'gateway.json':'6'.repeat(64)},originalCertificationActionId='owned-cert-b',originalRecoveryActionId='owned-known-b';
 const restorationActionId='owned-restore-c', operatorSourceCommit='7'.repeat(40);
 const replacementRelease=replacementDescriptor();
 const originalReleaseReceipt=rawReceipt({...base,status:'P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION',releaseId,sourceCommit});
 const provenance={replacementRelease,originalReleaseReceiptSha256:receiptSha256(originalReleaseReceipt),
  originalReleasePlanSha256:replacementRelease.reviewedPlanSha256};
 const hostRoot='/var/lib/lash-her/releases/staging/owned-replacement';
 const host={machineId:'8'.repeat(32),bundle:hostRoot+'/bundle',results:hostRoot+'/results',
  configuration:hostRoot+'/results/runtime-profiled-frontend-replacement-'+releaseId+'/configuration'};
 const releaseSettings={arm:{results,knownHosts:join(results,'known-hosts'),sshKey:join(results,'ssh-key')},providerContext:join(results,'provider.json')};
 const replacementSelection={terminalFile:join(results,'owned-terminal.json'),terminalSha256:provenance.originalReleaseReceiptSha256};
 const receiverTargets=Object.fromEntries(['course','community'].map(service=>[service,{host:service+'.invalid',port:5432,database:service,
  user:service+'_runtime',serverMajor:18,roleOid:service==='course'?'421':'422'}]));
 const apiJobs=Object.fromEntries(Object.entries(receiverTargets).map(([service,{host,port,database,user,serverMajor}])=>
  [service,{target:{host,port,database,serverMajor},runtimeRole:user}]));
 const frontendTarget={qualificationTargetProfile:profile,host:'frontend.invalid',port:5432,database:'frontend',user:'owned_migration',serverMajor:18};
 const job={...base,sourceCommit,releaseId,target:{...frontendTarget,allowEmptyBootstrap:true,approvedPendingTags:['0001_fixture']}};
 const producer={producerSha256:'2'.repeat(64),role:{name:'owned_runtime',oid:'418'}};
 const inventory={...base,owner:{name:'owned_owner',oid:'416'},producers:[producer],replacementRelease};
 const contractPhase='p2',phase2ContractManifestSha256='sha256:'+'9'.repeat(64);
 const original={migration:{candidate:{...base,version:3,releaseId,environment,contractPhase,sources:{frontend:{commit:sourceCommit}}},job,baseline:{catalog:{}}},
  plan:{...base,releaseId,sourceCommit,targetSha256,candidateSha256,inventorySha256,apiJobSha256,configurationSha256,contractPhase,phase2ContractManifestSha256},
  inventory,apiJobs};
 const normalized={original,host,profiledRelease:{replacementRelease,receiptSha256:provenance.originalReleaseReceiptSha256,
  planSha256:provenance.originalReleasePlanSha256},originalReleaseReceipt};
 const {prepareProfiledInterruptedKnownAckOperator:prepare,profiledInterruptedHostPacket:packetFor}=await projectedReplacementPlanner((settings,selection)=>{
  assert.deepEqual(settings,releaseSettings);assert.deepEqual(selection,replacementSelection);return normalized;
 });
 const native={...base,target:frontendTarget,targetSha256,owner:inventory.owner,producer,initialEpoch:'4',commandWitnesses:[{action:'suspend'}]};
 const nativePlan={...native,planSha256:p2NativeHash(native)};
 const configurationInputDirectory=hostRoot+'/owned-original-recovery-config';
 const intent={...base,...provenance,receiverTargetsSha256:p2NativeHash(receiverTargets),configurationInputDirectory};
 const body={...base,...provenance,mode:'known-ack-recovery',environment,startState:'already-closed',certificationActionId:originalCertificationActionId,
  originalReleaseId:releaseId,operatorSourceCommit:sourceCommit,sourceCommit,targetSha256,candidateSha256,inventorySha256,
  configurationCanonicalSha256:p2NativeHash(configurationSha256),apiJobSha256,nativePlan,knownAckReceiverTargets:receiverTargets,
  knownAckConfigurationInputDirectory:configurationInputDirectory,knownAckRecovery:{...base,recoveryActionId:originalRecoveryActionId,intent,intentSha256:p2NativeHash(intent)}};
 const retained=join(results,originalCertificationActionId);
 mkdirSync(retained,{mode:0o700});
 const retain=body=>{
  const bytes=rawReceipt({...body,planSha256:p2NativeHash(body)});
  writeFileSync(join(retained,'p2-certification-started.json'),bytes,{mode:0o600});
  return bytes;
 };
 const settings={...base,environment,operatorSourceCommit,releaseSettings,replacementRelease:replacementSelection,receiverTargets,
  operationId:'00000000-0000-4000-8000-000000000001',interruptedRestoration:{...base,mode:PROFILED_MODE,restorationActionId,
   originalCertificationActionId,originalRecoveryActionId,originalOperatorSourceCommit:sourceCommit,
   causalReceiptSha256:Object.fromEntries([...CAUSAL_FILES,'reconciliation-observed.json'].map(name=>[name,'a'.repeat(64)])),
   replacementReceiptSha256:Object.fromEntries(REPLACEMENT_FILES.map(name=>[name,name==='known-ack-replacement-intent.json'?'b'.repeat(64):null])),
   priorGatewayReference:{kind:'stopped-current-candidate',stopReceiptDirectory:join(host.results,'p2-profiled-current-certification-'+originalCertificationActionId),
    stopReceiptSha256:'c'.repeat(64)}}};
 const certificationRaw=retain(body),prepared=prepare(settings),packet=packetFor(prepared,{files:[{path:'owned',sha256:'d'.repeat(64)}]});
 for(const [key,value] of Object.entries(provenance)){
  assert.deepEqual(prepared.plan[key],value);
  assert.deepEqual(prepared.plan.frontendPlan[key],value);
  assert.equal(Object.hasOwn(packet,key),false);
 }
 assert.deepEqual(Buffer.from(packet.originalReleaseReceipt,'base64'),originalReleaseReceipt);
 assert.deepEqual(Buffer.from(packet.originalCertificationPlan,'base64'),certificationRaw);
 assert.deepEqual(packet.frontendJob,job);
 assert.equal(packet.configuration,configurationInputDirectory);
 assert.equal(packet.hostMachineId,host.machineId);
 assert.equal(prepared.plan.frontendSqlApplied,false);
 for(const mutate of [
  selected=>{delete selected.replacementRelease;},selected=>{selected.originalReleaseReceiptSha256='e'.repeat(64);},
  selected=>{selected.originalReleasePlanSha256='e'.repeat(64);},selected=>{selected.knownAckRecovery.intent.replacementRelease.databaseOid='419';},
  selected=>{delete selected.knownAckRecovery.intent.originalReleasePlanSha256;},
  selected=>{selected.knownAckRecovery.intent.configurationInputDirectory=host.configuration;},
 ]){
  const invalid=structuredClone(body);mutate(invalid);
  invalid.knownAckRecovery.intentSha256=p2NativeHash(invalid.knownAckRecovery.intent);
  retain(invalid);assert.throws(()=>prepare(settings));
 }
});
