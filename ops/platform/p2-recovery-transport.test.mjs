import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { p2RecoveryEnvironmentLock } from './p2-recovery-transport.mjs';
const program=String.raw`
import fcntl,json,os,sys
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline());assert initial['mode']=='p2-post-sql-recovery'
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
receipt={'status':'P2_STAGING_RECOVERY_RESTORATION_VERIFIED','sqlReplayed':False}
for raw in sys.stdin:
 p=json.loads(raw);op=p['operation'];v={'id':p['id']}
 if op=='check':v['status']='HELD'
 elif op=='arm-recovery':v['status']='RECOVERY_ARMED'
 elif op=='start-api':
  assert json.loads(__import__('base64').b64decode(p['receipt']))['status']=='P2_RECOVERY_DATABASE_CURRENT'
  if sys.argv[2]=='death':os._exit(31)
  v.update(status='API_READY',receipt={'status':'P2_RECOVERY_API_RUNTIME_READY'})
 elif op=='frontend-verified':v['status']='FRONTEND_VERIFIED'
 elif op=='recovery-gateway-stage':v['status']='GATEWAY_STAGE_VERIFIED'
 elif op=='observe-gateway':v.update(status='GATEWAY_OBSERVED',gateway={})
 elif op=='prepare-close':v['status']='FRONTEND_CLOSE_PREPARED'
 elif op=='finish':
  data=json.loads(__import__('base64').b64decode(p['recovery']));assert data['originalFrontendTerminalRecreated'] is False
  v.update(status='P2_RECOVERY_JOINED',receipt=receipt)
 elif op=='commit':
  v.update(status='COMMITTED',receipt=receipt);print(json.dumps(v),flush=True);break
 else:os._exit(32)
 print(json.dumps(v),flush=True)
os.close(fd)
`;
function fixture(mode='ready'){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-recovery-pipe-'))),original=join(directory,'original'),work=join(directory,'fresh');
 mkdirSync(original,{mode:0o700});mkdirSync(join(original,'vercel'),{mode:0o700});mkdirSync(work,{mode:0o700});
 writeFileSync(join(original,'vercel/frontend-workload-outcome.json'),'{}',{mode:0o600});
 const receipt={status:'P2_RECOVERY_DATABASE_CURRENT',originalReceiptSha256:{'job-outcome.json':null}},outcome={status:'P2_STAGING_RECOVERY_RESTORATION_VERIFIED',originalFrontendTerminalRecreated:false};
 writeFileSync(join(work,'p2-recovery-current-database.json'),JSON.stringify(receipt),{mode:0o600});writeFileSync(join(work,'p2-recovery-outcome.json'),JSON.stringify(outcome),{mode:0o600});
 const initial={environment:'staging',sourceCommit:'a'.repeat(40),mode:'p2-post-sql-recovery',recoveryActionId:'fresh-recovery',credentials:{privateMarker:'private-never-in-arguments-or-env'}};
 const lock=join(directory,'actual-host-lock');let captured;
 const factory=p2RecoveryEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key',originalDirectory:original},initial,work,{launch(executable,args,options){captured={executable,args,options};return spawn('python3',['-I','-u','-c',program,lock,mode],options);}});
 return{directory,original,work,receipt,outcome,lock,factory,getCaptured:()=>captured,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('retained READY recovery uses actual inherited pipe/flock without needing or creating old terminal',async()=>{
 const f=fixture();try{
  await f.factory(async(verify,_signal,host)=>{
   await verify();const contender=spawnSync('python3',['-I','-c',"import os,fcntl,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",f.lock]);assert.notEqual(contender.status,0);
   await host.armRecovery({receipt:f.receipt,probe:{}});await host.restoreCurrent({receipt:f.receipt,probe:{}});await host.frontendVerified({});await host.restoreGatewayStage('recovery',{newWork:false,recovery:true});await host.restoreGatewayStage('new-work',{newWork:true,recovery:true});await host.prepareClose(verify);await host.finish(f.outcome,verify);
  });
  assert.equal(existsSync(join(f.original,'job-outcome.json')),false);assert.equal(JSON.parse(readFileSync(join(f.work,'p2-host-recovery-outcome.json'))).sqlReplayed,false);
  assert.equal(JSON.stringify(f.getCaptured()).includes('private-never-in-arguments-or-env'),false);
 }finally{f.cleanup();}
});
test('remote process death aborts recovery before frontend/promotion/admission work',async()=>{
 const f=fixture('death');let afterApi=false;try{await assert.rejects(f.factory(async(_verify,_signal,host)=>{await host.armRecovery({receipt:f.receipt,probe:{}});await host.restoreCurrent({receipt:f.receipt,probe:{}});afterApi=true;}));assert.equal(afterApi,false);assert.equal(existsSync(join(f.work,'p2-host-recovery-outcome.json')),false);}finally{f.cleanup();}
});
