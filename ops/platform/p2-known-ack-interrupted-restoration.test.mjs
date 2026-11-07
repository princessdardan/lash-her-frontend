import assert from 'node:assert/strict';
import test from 'node:test';
import {fork,spawn,spawnSync} from 'node:child_process';
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
