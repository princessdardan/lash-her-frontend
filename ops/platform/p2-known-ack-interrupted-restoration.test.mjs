import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MODE,STATUS,TERMINAL,CAUSAL_FILES,REPLACEMENT_FILES,prepareInterruptedKnownAckAction,interruptedKnownAckEnvironmentLock} from './p2-known-ack-interrupted-restoration.mjs';
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
