// Explicit owned-fixture extension. B production/harness files remain untouched.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)));
// Failure-only metadata. This projection never returns messages, raw stacks,
// arguments, environment values, SQL, file contents, URLs or actual/expected.
export function ownedFailureDiagnostic(error,phase,context){
 const kinds=['Error','AssertionError','TypeError','SyntaxError','ReferenceError','RangeError','EvalError','URIError','AggregateError','ValueError','OSError','FileNotFoundError','PermissionError','TimeoutExpired','CalledProcessError','Unknown'];
 const codes=['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_PACKAGE_IMPORT_NOT_DEFINED','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_DIR_IMPORT','ERR_REQUIRE_ESM','ERR_ASSERTION','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE','ERR_INVALID_URL','ERR_WORKER_OUT_OF_MEMORY','ENOENT','ENOTDIR','EACCES','EPERM','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTEMPTY','EPIPE'];
 const read=(value,key)=>{try{return value?.[key];}catch{return undefined;}};
 const moduleId=value=>{
  if(typeof value!=='string'||value.length>2048)return null;
  let path=value;try{if(path.startsWith('file:')){const url=new URL(path);if(url.protocol!=='file:'||url.username||url.password||url.host)return null;path=decodeURIComponent(url.pathname);}}catch{return null;}
  if(context.generatedFiles?.[path])return context.generatedFiles[path];
  if(path.startsWith(context.sourceRoot+'/')){const relative=path.slice(context.sourceRoot.length+1);if(context.sourceFiles.includes(relative))return relative;}
  if(path.startsWith(context.dependencyRoot+'/')){const relative=path.slice(context.dependencyRoot.length+1),parts=relative.split('/'),name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];if(context.packages.includes(name))return 'dependency:'+name;}
  return null;
 };
 const describe=value=>{
  const name=read(value,'name'),code=read(value,'code')??read(value,'message'),frames=[];
  const stack=read(value,'stack');if(typeof stack==='string')for(const line of stack.slice(0,16000).split('\n').slice(1,33)){
   const found=line.match(/^\s+at (?:.*?\()?((?:file:\/\/|\/)[^\s)]+):(\d{1,7}):(\d{1,7})\)?$/u);if(!found)continue;
   const file=moduleId(found[1]),lineNumber=Number(found[2]),column=Number(found[3]);if(file&&lineNumber>0&&column>0)frames.push({file,line:lineNumber,column});if(frames.length===4)break;
  }
  return {kind:kinds.includes(name)?name:'Unknown',code:codes.includes(code)||context.sourceCodes.includes(code)?code:null,module:moduleId(read(value,'url'))??moduleId(read(value,'path')),frames};
 };
 const causes=[];let next=read(error,'cause');for(let index=0;index<3&&next&&typeof next==='object';index++){causes.push(describe(next));next=read(next,'cause');}
 return {version:1,status:'P2_INTERRUPTED_OWNED_DIAGNOSTIC',phase:context.phases.includes(phase)?phase:'unknown',error:describe(error),causes,causeLimitReached:!!next};
}

export function ownedDiagnosticContext(sourceRoot=root,generatedDirectory){
 sourceRoot=resolve(sourceRoot);
 let files=[];try{const result=spawnSync('git',['--no-replace-objects','--no-optional-locks','-c','safe.directory='+sourceRoot,'-C',sourceRoot,'ls-tree','-r','--name-only','HEAD'],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,env:{PATH:process.env.PATH}});if(result.status===0)files=result.stdout.split('\n').filter(name=>/^(?:src|ops|scripts|docs)\/[A-Za-z0-9_./@()[\]-]+\.(?:[cm]?[jt]sx?|py)$/u.test(name));}catch{/*Missing metadata remains unknown.*/}
 let dependencyRoot=join(sourceRoot,'node_modules'),packages=[];try{dependencyRoot=realpathSync(dependencyRoot);const metadata=JSON.parse(readFileSync(join(sourceRoot,'package.json')));packages=[...Object.keys(metadata.dependencies??{}),...Object.keys(metadata.devDependencies??{})];}catch{/*Unresolved dependencies remain unknown.*/}
 const context={sourceRoot,dependencyRoot,sourceFiles:files,packages,
  phases:['c-original-observer-import','c-original-api-current','c-original-configuration','c-original-configuration-readback','c-original-causal-prepare','c-original-causal-readback'],sourceCodes:[],generatedFiles:{}};
 for(const name of ['ops/platform/test-p2-known-ack-loss-local.mjs','ops/platform/harness/owned-p2-known-ack-loss.mjs','docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs']){
  try{const text=readFileSync(join(sourceRoot,name),'utf8');for(const match of text.matchAll(/phase='([a-z-]{1,80})'/gu))context.phases.push(match[1]);}catch{/*Unobserved phases remain unknown.*/}
 }
 context.phases=[...new Set(context.phases.flatMap(value=>[value,'child-'+value]))];
 for(const name of ['ops/platform/host/p2_known_ack_interrupted_restoration.py','ops/platform/host/p2_known_ack_loss.py','ops/platform/host/p2_release_broker.py','ops/platform/host/p2_release_scope.py','ops/platform/host/p2_recovery_scope.py','ops/platform/host/p2_prior_gateway.py','ops/platform/host/migrate.py']){
  try{const text=readFileSync(join(sourceRoot,name),'utf8');for(const match of text.matchAll(/['"]((?:P2_|FRONTEND_|MIGRATION_)[A-Z0-9_]{1,99})['"]/gu))context.sourceCodes.push(match[1]);}catch{/*Unobserved source codes remain unknown.*/}
 }
 context.sourceCodes=[...new Set(context.sourceCodes)];
 if(generatedDirectory)for(const name of ['old-b-process.mjs','cluster-and-new-c-process.mjs'])context.generatedFiles[join(generatedDirectory,name)]='owned-fixture/'+name;
 return context;
}

export function validateOwnedDiagnostic(value,context){
 const keys=(object,names)=>object&&typeof object==='object'&&!Array.isArray(object)&&JSON.stringify(Object.keys(object).sort())===JSON.stringify([...names].sort());
 const validModule=file=>file===null||context.sourceFiles.includes(file)||Object.values(context.generatedFiles).includes(file)||context.packages.some(name=>file==='dependency:'+name);
 const safeCodes=new Set([...context.sourceCodes,'ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_PACKAGE_IMPORT_NOT_DEFINED','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_DIR_IMPORT','ERR_REQUIRE_ESM','ERR_ASSERTION','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE','ERR_INVALID_URL','ERR_WORKER_OUT_OF_MEMORY','ENOENT','ENOTDIR','EACCES','EPERM','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTEMPTY','EPIPE']);
 const kinds=['Error','AssertionError','TypeError','SyntaxError','ReferenceError','RangeError','EvalError','URIError','AggregateError','ValueError','OSError','FileNotFoundError','PermissionError','TimeoutExpired','CalledProcessError','Unknown'];
 const error=item=>keys(item,['kind','code','module','frames'])&&kinds.includes(item.kind)&&(item.code===null||safeCodes.has(item.code))&&validModule(item.module)&&Array.isArray(item.frames)&&item.frames.length<=4&&item.frames.every(frame=>keys(frame,['file','line','column'])&&frame.file!==null&&validModule(frame.file)&&Number.isInteger(frame.line)&&frame.line>0&&frame.line<10000000&&(frame.column===null||Number.isInteger(frame.column)&&frame.column>0&&frame.column<10000000));
 return keys(value,['version','status','phase','error','causes','causeLimitReached'])&&value.version===1&&value.status==='P2_INTERRUPTED_OWNED_DIAGNOSTIC'&&(value.phase==='unknown'||context.phases.includes(value.phase))&&error(value.error)&&Array.isArray(value.causes)&&value.causes.length<=3&&value.causes.every(error)&&typeof value.causeLimitReached==='boolean'?value:null;
}

export function ownedEngineDiagnostic(raw,phase,context){
 if(typeof raw!=='string'||raw.length>65536)return null;
 const line=raw.trim().split('\n').at(-1);let value;try{value=JSON.parse(line);}catch{return null;}
 if(value?.status!=='OWNED_C_ENGINE_FAILED')return null;
 const names={'owned-engine.py':'docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py','p2_known_ack_interrupted_restoration.py':'ops/platform/host/p2_known_ack_interrupted_restoration.py'};
 const kinds=['AssertionError','ValueError','OSError','FileNotFoundError','PermissionError','TimeoutExpired','CalledProcessError','TypeError','KeyError','Unknown'];
 const kind=kinds.includes(value.kind)&&value.kind!=='KeyError'?value.kind:'Unknown';
 const frames=Array.isArray(value.frames)?value.frames.slice(-4).filter(frame=>frame&&typeof frame==='object'&&names[frame.file]&&Number.isInteger(frame.line)&&frame.line>0&&frame.line<10000000).map(frame=>({file:names[frame.file],line:frame.line,column:null})):[];
 return {version:1,status:'P2_INTERRUPTED_OWNED_DIAGNOSTIC',phase:context.phases.includes(phase)?phase:'unknown',error:{kind,code:context.sourceCodes.includes(value.code)?value.code:null,module:null,frames},causes:[],causeLimitReached:false};
}

export function ownedDiagnosticSource(context){
 const fixed=JSON.stringify(context);
 return {
  harnessCatch:`.catch(error=>{console.error(JSON.stringify({status:'P2_KNOWN_ACK_WHOLE_ROUTE_FAILED',phase,observed,diagnostic:(${ownedFailureDiagnostic.toString()})(error,phase,${fixed}),engineDiagnostic:cEngineDiagnostic}));process.exitCode=1;});`,
  parentForward:`for(const record of [item.diagnostic,item.engineDiagnostic]){const safe=(${validateOwnedDiagnostic.toString()})(record,${fixed});if(safe)process.stderr.write(JSON.stringify(safe)+'\\n');}if(item.observed)process.stderr.write(JSON.stringify(item.observed)+'\\n');`,
  outerCatch:`.catch(error=>{process.stderr.write(JSON.stringify((${ownedFailureDiagnostic.toString()})(error,phase,${fixed}))+'\\n');process.stderr.write(`
 };
}

export function runOwnedFixture(){
const refuse=code=>{process.stderr.write(JSON.stringify({version:1,status:'P2_INTERRUPTED_OWNED_REFUSED',code})+'\n');process.exit(1);};
if(process.env.P2_INTERRUPTED_OWNED_TEST!=='true')refuse('P2_INTERRUPTED_OWNED_SCOPE_REQUIRED');
if(!(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--negative-cases'))refuse('P2_INTERRUPTED_OWNED_ARGUMENTS_REFUSED');
const gatewayRequire=createRequire(join(root,'ops/gateway/package.json'));
const gatewayJose=gatewayRequire.resolve('jose');
assert.equal(realpathSync(gatewayJose).startsWith(realpathSync(join(root,'ops/gateway/node_modules/jose'))+'/'),true);
assert.equal(JSON.parse(readFileSync(join(root,'ops/gateway/node_modules/jose/package.json'))).version,'6.2.3');
const folder=realpathSync(mkdtempSync(join(tmpdir(),'p2-interrupted-owned-driver-')));
function variant(source,changes,destination){
 const original=readFileSync(source,'utf8');let raw=original;
 for(const [before,after]of changes){assert.equal(raw.split(before).length,2);raw=raw.replace(before,after);}
 raw=raw.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/gu,(_all,q,path)=>`from ${q}${pathToFileURL(resolve(dirname(source),path)).href}${q}`)
  .replace(/import\((['"])(\.{1,2}\/[^'"]+)\1\)/gu,(_all,q,path)=>`import(${q}${pathToFileURL(resolve(dirname(source),path)).href}${q})`)
  .replaceAll('import.meta.url',JSON.stringify(pathToFileURL(source).href));
 writeFileSync(destination,raw,{mode:0o600,flag:'wx'});
 const checked=spawnSync(process.execPath,['--check',destination],{encoding:'utf8'});if(checked.status!==0){writeFileSync(join(folder,'private-generated-syntax.stderr'),checked.stderr,{mode:0o600});throw new Error('OWNED_GENERATED_FIXTURE_SYNTAX_REFUSED');}
}
const negativeCases=['original-bytes','original-config-drift','missing-lineage','pending-lineage','backend-effect','active-backend-loss','active-guard-loss'];
const negativeOnly=process.argv[2]==='--negative-cases',started=performance.now();
const diagnosticContext=ownedDiagnosticContext(root,folder),diagnosticSource=ownedDiagnosticSource(diagnosticContext);
try{
 symlinkSync(join(root,'node_modules'),join(folder,'node_modules'),'dir');
 const harness=join(folder,'old-b-process.mjs'),outer=join(folder,'cluster-and-new-c-process.mjs'),actor=fileURLToPath(new URL('./owned-process.mjs',import.meta.url));
 const engine=fileURLToPath(new URL('./owned-engine.py',import.meta.url));
 variant(join(root,'ops/platform/harness/owned-p2-known-ack-loss.mjs'),[
  ["const now=Date.now();let faultEnabled=true;",`const work=join(directory,'c-operator');mkdirSync(work,{mode:0o700});
  phase='c-original-observer-import';const {ownedApiCurrent}=await import(${JSON.stringify(pathToFileURL(actor).href)});
  phase='c-original-api-current';const originalApi=await ownedApiCurrent(input,input.candidate,input.candidateSha256,'owned-b-certification');
  const receiverTargets=Object.fromEntries(['course','community'].map(service=>[service,{host:'127.0.0.1',port,database:input.apis[service].database.database,user:input.apis[service].database.user,serverMajor:input.postgresMajor,roleOid:input.apis[service].roleOid}]));
  const minimalJobs={frontend:{job:{target},schema:'{}'},...originalApi.jobs};
  const rootGateway={...config,admission:{...config.admission,file:'/admission/state.json'}};
  phase='c-original-configuration';const preparedConfiguration=spawnSync('python3',['-B',${JSON.stringify(engine)},'configuration'],{input:JSON.stringify({root:${JSON.stringify(root)},work,input,candidate:input.candidate,candidateSha256:input.candidateSha256,jobs:minimalJobs,receiverTargets,oldPid:process.pid,apiProofs:originalApi.proofs,actionId:'owned-interrupted-restoration-c',gatewayConfiguration:Buffer.from(JSON.stringify(rootGateway)).toString('base64')}),encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
  for(const client of originalApi.clients)await client.end();if(preparedConfiguration.status!==0)cEngineDiagnostic=(${ownedEngineDiagnostic.toString()})(preparedConfiguration.stderr,phase,${JSON.stringify(diagnosticContext)});assert.equal(preparedConfiguration.status,0);phase='c-original-configuration-readback';const originalConfiguration=JSON.parse(preparedConfiguration.stdout);
  const now=Date.now();let faultEnabled=true;`],
  ["const raw=Buffer.from(JSON.stringify(reviewed)),processBinding=", "const raw=Buffer.from(JSON.stringify(rootGateway)),processBinding="],
  ["return createP2CertificationFault({...reviewed", `const faultDirectory=join(work,'root','p2-certification-owned-b-certification','fault');mkdirSync(faultDirectory,{mode:0o700});
   const leaseRaw=Buffer.from(canonical(lease)+'\\n'),leaseSha256=hash(leaseRaw);
   writeFileSync(join(faultDirectory,'fault-arm-intent.json'),canonical({version:1,stageId:lease.stageId,leaseSha256,lease})+'\\n',{mode:0o600,flag:'wx'});
   writeFileSync(join(faultDirectory,'fault-arm-observed.json'),canonical({version:1,status:'P2_FAULT_LEASE_ARMED',stageId:lease.stageId,leaseSha256,expiresAt:lease.expiresAt,maxMatches:1,gatewayProcessSha256:lease.gatewayProcessSha256})+'\\n',{mode:0o600,flag:'wx'});
   return createP2CertificationFault({...reviewed`],
  ["readLease:()=>faultEnabled?Buffer.from(JSON.stringify(lease)):null", "readLease:()=>faultEnabled?leaseRaw:null"],
  ["configurationSha256:'b'.repeat(64)","configurationSha256:originalConfiguration.configurationCanonicalSha256"],
  ["gatewayImageSha256:'c'.repeat(64)","gatewayImageSha256:input.candidate.artifacts.gateway.image.split(':').at(-1)"],

  ["database:input.apis[service].database.database,user:target.user","database:input.apis[service].database.database,user:'frontend_test_admin'"],
  ["candidateSha256='a'.repeat(64)","candidateSha256=input.candidateSha256"],
  ["import {readFileSync,writeFileSync}","import {readFileSync,writeFileSync,mkdirSync}"],
  ["const evidenceSha256=hash(canonical({domain,effect:effects[0],firstOperationId:firstLedger[0].id}));",`  const causalInput={root:${JSON.stringify(root)},work,input,old:{plan:reducerPlan,before,domain,beforeSettlement,effects,firstLedger,projection,oldBackend:backend,oldPid:process.pid},candidate:input.candidate,candidateSha256,jobs:minimalJobs,owner,receiverTargets,actionId:'owned-interrupted-restoration-c'};
  phase='c-original-causal-prepare';const sourcePrepare=spawnSync('python3',['-B',${JSON.stringify(engine)},'prepare'],{input:JSON.stringify(causalInput),encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});if(sourcePrepare.status!==0){writeFileSync(join(work,'private-old-prepare-error'),sourcePrepare.stderr,{mode:0o600});cEngineDiagnostic=(${ownedEngineDiagnostic.toString()})(sourcePrepare.stderr,phase,${JSON.stringify(diagnosticContext)});throw new Error('OWNED_ORIGINAL_CAUSAL_PREPARE_REFUSED');}
  phase='c-original-causal-readback';const originalPrepared=JSON.parse(sourcePrepare.stdout);const evidenceSha256=originalPrepared.interruptedRestoration.causalReceiptSha256['settlement.json'];`],
  ["  return{version:1,status:'P2_KNOWN_ACK_WHOLE_ROUTE_PASS'",`  writeFileSync(join(directory,'interrupted-actual-domain.json'),JSON.stringify({plan:reducerPlan,before,domain,beforeSettlement,settled,effects,projection,oldBackend:backend,evidenceSha256,oldPid:process.pid,originalCausalReceiptSha256:originalPrepared.interruptedRestoration.causalReceiptSha256}),{mode:0o600,flag:'wx'});\n  return{version:1,status:'P2_KNOWN_ACK_WHOLE_ROUTE_PASS'`],
  ["let phase='owned-input',observed;","let phase='owned-input',observed,cEngineDiagnostic=null;"],
  [".catch(()=>{console.error(JSON.stringify({status:'P2_KNOWN_ACK_WHOLE_ROUTE_FAILED',phase,observed}));process.exitCode=1;});",diagnosticSource.harnessCatch],
 ],harness);
 const setup=`
    // Owned setup precedes the original B operation and all journal baselines.
    await operator.query('GRANT CONNECT ON DATABASE frontend_admission_owned TO frontend_runtime; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO frontend_runtime; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO frontend_runtime; CREATE ROLE interrupted_retired NOLOGIN NOINHERIT');
    for(const service of ['course','community']){
      const api=apis[service],migration='interrupted_'+service+'_migration';
      await setup.query(\`CREATE ROLE \${migration} LOGIN NOINHERIT PASSWORD '\${password}'; ALTER DATABASE \${api.database.database} OWNER TO \${migration}; GRANT CONNECT ON DATABASE \${api.database.database} TO \${api.database.user}\`);
      const client=await connect(api.database.database);
      await client.query(\`GRANT USAGE,CREATE ON SCHEMA public TO \${migration}; ALTER SCHEMA drizzle OWNER TO \${migration}; ALTER TABLE drizzle.__drizzle_migrations OWNER TO \${migration}\`);
      const relations=(await client.query("SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') ORDER BY c.relkind,c.relname")).rows;
      for(const row of relations)await client.query('ALTER '+(row.relkind==='S'?'SEQUENCE':'TABLE')+' public."'+row.relname.replaceAll('"','""')+'" OWNER TO '+migration);
      const functions=(await client.query("SELECT p.oid::regprocedure::text AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).rows;
      for(const row of functions)await client.query('ALTER FUNCTION '+row.name+' OWNER TO '+migration);
      const types=(await client.query("SELECT t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d')")).rows;
      for(const row of types)await client.query('ALTER TYPE public."'+row.typname.replaceAll('"','""')+'" OWNER TO '+migration);
      await client.query(\`SET ROLE \${migration}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO \${api.database.user}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO \${api.database.user}; GRANT USAGE ON SCHEMA public TO \${api.database.user}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO \${api.database.user}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO \${api.database.user}; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC; RESET ROLE\`);
      api.migrationRole=migration;
    }
 `;
 const cRun=`
    // The old B child has exited; its FE session and actual TLS gateway died.
    const cInput={port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit,postgresMajor,apis,candidate:ownedCandidate,faultMode:process.env.P2_INTERRUPTED_OWNED_FAULT??'none'};
    const cChild=spawnSync(process.execPath,['--import','tsx',${JSON.stringify(actor)}],{input:JSON.stringify(cInput),encoding:'utf8',timeout:900000,
      env:{...safeEnvironment,TMPDIR:${JSON.stringify(folder)},NODE_EXTRA_CA_CERTS:certificate,P2_INTERRUPTED_OWNED_CHILD:'true'}});
    if(cChild.status!==0){process.stderr.write(cChild.stderr);process.stderr.write(JSON.stringify({status:'OWNED_C_CHILD_EXIT',exitCode:cChild.status,signal:cChild.signal,code:cChild.error?.code??null})+'\\n');throw new Error('OWNED_NEW_C_PROCESS_REFUSED');}
    const restoration=JSON.parse(cChild.stdout);assert.equal(restoration.status,cInput.faultMode==='none'?'P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS':'P2_INTERRUPTED_NEGATIVE_OWNED_PASS');phase=cInput.faultMode==='none'?'actual-c-runtime-terminal-joined':'actual-c-negative-qualified';
 `;
 variant(join(root,'ops/platform/test-p2-known-ack-loss-local.mjs'),[
  ["mkdirSync, symlinkSync }", "mkdirSync, symlinkSync, readdirSync, lstatSync }"],
  ["rmSync(directory,{recursive:true,force:true});", "const ownedWritable=path=>{const info=lstatSync(path);if(info.isDirectory()&&!info.isSymbolicLink()){assert.equal(info.uid,process.getuid());chmodSync(path,0o700);for(const name of readdirSync(path))ownedWritable(join(path,name));}};ownedWritable(directory);rmSync(directory,{recursive:true,force:true});"],
  [".catch(()=>{process.stderr.write(",diagnosticSource.outerCatch],
  ["    await setup.query('CREATE ROLE admission_owner NOLOGIN NOINHERIT');await setup.query(`CREATE ROLE frontend_runtime LOGIN NOINHERIT PASSWORD '${password}'`);", "    await setup.query(`CREATE ROLE interrupted_frontend_migration LOGIN CREATEROLE NOINHERIT PASSWORD '${password}'; ALTER DATABASE frontend_admission_owned OWNER TO interrupted_frontend_migration; SET ROLE interrupted_frontend_migration; CREATE ROLE admission_owner NOLOGIN NOINHERIT; CREATE ROLE frontend_runtime LOGIN NOINHERIT PASSWORD '${password}'; GRANT admission_owner TO interrupted_frontend_migration WITH ADMIN FALSE, INHERIT FALSE, SET TRUE; RESET ROLE`);"],
  ["const operator=await connect('frontend_admission_owned');", "const operator=new Client({host:'127.0.0.1',port,database:'frontend_admission_owned',user:'interrupted_frontend_migration',password,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});clients.push(operator);await operator.connect();"],
  ["user:'frontend_test_admin',serverMajor:postgresMajor},targetSha256", "user:'interrupted_frontend_migration',serverMajor:postgresMajor},targetSha256"],
  ["['--no-replace-objects','--no-optional-locks','-C',repository,'remote'","['--no-replace-objects','--no-optional-locks','-c','safe.directory='+repository,'-C',repository,'remote'"],
  ["['--no-replace-objects','--no-optional-locks','-C',repository,'archive'","['--no-replace-objects','--no-optional-locks','-c','safe.directory='+repository,'-C',repository,'archive'"],
  ["    const sourceCommit=nativeSourceCommit(),target=",setup+"\n    const sourceCommit=nativeSourceCommit(),target="],
  ["'ops/platform/harness/owned-p2-known-ack-loss.mjs'",JSON.stringify(harness)],
  ["    phase='actual-cron-stage';const child=spawnSync",`    const ownedCandidate={version:2,environment:'staging',contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),releaseId:'owned-known-ack',workload:{projectId:'prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',environment:'production'},sources:{frontend:{commit:sourceCommit,repository:'https://github.com/princessdardan/lash-her-frontend.git',requiredChecks:'passed'}},artifacts:{},runtime:{composeSha256:'sha256:'+hash(readFileSync(${JSON.stringify(join(root,'ops/platform/compose.yaml'))}))}};
    ['gateway','frontendMigration','courseMigration','courseRuntime','communityMigration','communityRuntime'].forEach((name,index)=>ownedCandidate.artifacts[name]={image:'ghcr.io/princessdardan/owned-'+name.toLowerCase()+'@sha256:'+String(index+1).repeat(64)});
    phase='actual-cron-stage';const child=spawnSync`],
  ["JSON.stringify({port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit,postgresMajor,apis})","JSON.stringify({port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit,postgresMajor,apis,candidate:ownedCandidate,candidateSha256:hash(Buffer.from(JSON.stringify(ownedCandidate)+'\\n'))})"],
  ["    return{...result,postgresMajor",cRun+"\n    return{...result,restoration,postgresMajor"],
  ["if(child.status!==0){const rows=",`if(child.status!==0){writeFileSync(${JSON.stringify(join(folder,'private-inner.stderr'))},child.stderr,{mode:0o600});const rows=`],
  ["if(item.observed)process.stderr.write(JSON.stringify(item.observed)+'\\n');",diagnosticSource.parentForward],
 ],outer);
 const outputs=[];for(const mode of negativeOnly?negativeCases:['none']){
  const result=spawnSync(process.execPath,['--import','tsx',outer],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:folder,PG_BIN:process.env.PG_BIN,OWNED_POSTGRES_MAJOR:process.env.OWNED_POSTGRES_MAJOR??'16',
  P2_KNOWN_ACK_OWNED_TEST:'true',P2_INTERRUPTED_OWNED_FAULT:mode,P2_KNOWN_ACK_COURSE_SOURCE_ROOT:process.env.P2_KNOWN_ACK_COURSE_SOURCE_ROOT,P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT:process.env.P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT},encoding:'utf8',timeout:1200000});
 if(result.status!==0){process.stderr.write(result.stderr);process.exitCode=1;break;}else {const receipt=JSON.parse(result.stdout);receipt.restoration.elapsedSeconds=Math.round((performance.now()-started)/100)/10;
  receipt.restoration.ownedSourceSha256=Object.fromEntries(['ops/platform/p2-known-ack-interrupted-restoration.mjs','ops/platform/host/p2_known_ack_interrupted_restoration.py','ops/platform/host/p2_release_broker.py','ops/platform/host/p2_release_supervisor.py','ops/gateway/server.mjs','ops/gateway/p2-certification-fault.mjs','ops/gateway/package.json','ops/gateway/package-lock.json',...['run-owned.mjs','owned-process.mjs','owned-engine.py'].map(name=>'docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/'+name)].map(name=>[name,createHash('sha256').update(readFileSync(join(root,name))).digest('hex')]));
  receipt.restoration.gatewayDependency={package:'jose',version:'6.2.3',resolution:'ops/gateway/node_modules/jose',packageSha256:createHash('sha256').update(readFileSync(join(root,'ops/gateway/node_modules/jose/package.json'))).digest('hex')};
  outputs.push(receipt);}
 }
 if(!process.exitCode)process.stdout.write(JSON.stringify(negativeOnly?{version:1,status:'P2_INTERRUPTED_NEGATIVES_OWNED_PASS',serverMajor:Number(process.env.OWNED_POSTGRES_MAJOR??'16'),cases:outputs.map(value=>value.restoration),elapsedSeconds:Math.round((performance.now()-started)/100)/10}:outputs[0],null,2)+'\n');
}finally{rmSync(folder,{recursive:true,force:true});}

}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runOwnedFixture();
