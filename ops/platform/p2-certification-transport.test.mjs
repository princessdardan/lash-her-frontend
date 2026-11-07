import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {p2CertificationEnvironmentLock,readP2CertificationAuthenticationStage,readP2CertificationSuspensionStage,readP2CertificationWorkerStage,readP2CertificationKnownAckStage} from './p2-certification-transport.mjs';
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
   assert.throws(()=>readP2CertificationAuthenticationStage({status:'P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD'},{}));
   assert.throws(()=>readP2CertificationSuspensionStage({captureControlled:async()=>({})},{}));
   assert.throws(()=>readP2CertificationWorkerStage({invokeDirect:async()=>({status:'P2_DIRECT_WORKER_HTTP_OBSERVED'})},{}));
   assert.throws(()=>readP2CertificationKnownAckStage({replace:async()=>({status:'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED'})},{}));
   await host.prepareClose({status:'P2_TEST_FIXTURE'});await host.finish(f.outcome);return'joined';
  });
  assert.equal(actual,'joined');assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'p2-host-certification-outcome.json'))),f.outcome);
  assert.equal(JSON.stringify(f.getCaptured()).includes('fixture-private-stdin-only'),false);
  assert.equal(f.getCaptured().executable,'/usr/bin/ssh');assert.ok(f.getCaptured().args.some(value=>value.includes('p2_certification_parent.py')));
 }finally{f.cleanup();}
});
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
