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
assert.equal(process.env.P2_INTERRUPTED_OWNED_TEST,'true');
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
const started=performance.now();
try{
 symlinkSync(join(root,'node_modules'),join(folder,'node_modules'),'dir');
 const harness=join(folder,'old-b-process.mjs'),outer=join(folder,'cluster-and-new-c-process.mjs'),actor=fileURLToPath(new URL('./owned-process.mjs',import.meta.url));
 const engine=fileURLToPath(new URL('./owned-engine.py',import.meta.url));
 variant(join(root,'ops/platform/harness/owned-p2-known-ack-loss.mjs'),[
  ["database:input.apis[service].database.database,user:target.user","database:input.apis[service].database.database,user:'frontend_test_admin'"],
  ["candidateSha256='a'.repeat(64)","candidateSha256=input.candidateSha256"],
  ["import {readFileSync,writeFileSync}","import {readFileSync,writeFileSync,mkdirSync}"],
  ["const evidenceSha256=hash(canonical({domain,effect:effects[0],firstOperationId:firstLedger[0].id}));",`const work=join(directory,'c-operator');mkdirSync(work,{mode:0o700});
  const receiverTargets=Object.fromEntries(['course','community'].map(service=>[service,{host:'127.0.0.1',port,database:input.apis[service].database.database,user:input.apis[service].database.user,serverMajor:input.postgresMajor,roleOid:input.apis[service].roleOid}]));
  const minimalJobs={frontend:{job:{target},schema:'{}'}};for(const service of ['course','community'])minimalJobs[service]={job:{target:{host:'127.0.0.1',port,database:input.apis[service].database.database,user:input.apis[service].migrationRole,serverMajor:input.postgresMajor},runtimeRole:input.apis[service].database.user},schema:'{}'};
  const causalInput={root:${JSON.stringify(root)},work,input,old:{plan:reducerPlan,before,domain,beforeSettlement,effects,firstLedger,projection,oldBackend:backend,oldPid:process.pid},candidate:input.candidate,candidateSha256,jobs:minimalJobs,owner,receiverTargets,actionId:'owned-interrupted-restoration-c'};
  const sourcePrepare=spawnSync('python3',['-B',${JSON.stringify(engine)},'prepare'],{input:JSON.stringify(causalInput),encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});if(sourcePrepare.status!==0){writeFileSync(join(work,'private-old-prepare-error'),sourcePrepare.stderr,{mode:0o600});try{const safe=JSON.parse(sourcePrepare.stderr.trim().split('\\n').at(-1));observed.sourcePrepare={kind:safe.kind,code:safe.code};}catch{}throw new Error('OWNED_ORIGINAL_CAUSAL_PREPARE_REFUSED');}
  const originalPrepared=JSON.parse(sourcePrepare.stdout);const evidenceSha256=originalPrepared.interruptedRestoration.causalReceiptSha256['settlement.json'];`],
  ["  return{version:1,status:'P2_KNOWN_ACK_WHOLE_ROUTE_PASS'",`  writeFileSync(join(directory,'interrupted-actual-domain.json'),JSON.stringify({plan:reducerPlan,before,domain,beforeSettlement,settled,effects,projection,oldBackend:backend,evidenceSha256,oldPid:process.pid}),{mode:0o600,flag:'wx'});\n  return{version:1,status:'P2_KNOWN_ACK_WHOLE_ROUTE_PASS'`],
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
    const cInput={port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit,postgresMajor,apis,candidate:ownedCandidate};
    const cChild=spawnSync(process.execPath,['--import','tsx',${JSON.stringify(actor)}],{input:JSON.stringify(cInput),encoding:'utf8',timeout:900000,
      env:{...safeEnvironment,NODE_EXTRA_CA_CERTS:certificate,P2_INTERRUPTED_OWNED_CHILD:'true'}});
    if(cChild.status!==0){process.stderr.write(cChild.stderr);process.stderr.write(JSON.stringify({status:'OWNED_C_CHILD_EXIT',exitCode:cChild.status,signal:cChild.signal,code:cChild.error?.code??null})+'\\n');throw new Error('OWNED_NEW_C_PROCESS_REFUSED');}
    const restoration=JSON.parse(cChild.stdout);assert.equal(restoration.status,'P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS');phase='actual-c-runtime-terminal-joined';
 `;
 variant(join(root,'ops/platform/test-p2-known-ack-loss-local.mjs'),[
  ["mkdirSync, symlinkSync }", "mkdirSync, symlinkSync, readdirSync, lstatSync }"],
  ["rmSync(directory,{recursive:true,force:true});", "const ownedWritable=path=>{const info=lstatSync(path);if(info.isDirectory()&&!info.isSymbolicLink()){assert.equal(info.uid,process.getuid());chmodSync(path,0o700);for(const name of readdirSync(path))ownedWritable(join(path,name));}};ownedWritable(directory);rmSync(directory,{recursive:true,force:true});"],
  [".catch(()=>{process.stderr.write(",".catch(error=>{process.stderr.write(JSON.stringify({status:'OWNED_OUTER_FAILURE_DIAGNOSTIC',kind:error.name,code:/^[A-Z0-9_-]{1,80}$/u.test(error.code??'')?error.code:null,frame:(String(error.stack).split('\\n').find(line=>line.includes('cluster-and-new-c-process.mjs:'))??'').match(/:(\\d+):(\\d+)\\)?$/u)?.slice(1)??null})+'\\n');process.stderr.write("],
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
 ],outer);
 const result=spawnSync(process.execPath,['--import','tsx',outer],{cwd:root,env:{PATH:process.env.PATH,PG_BIN:process.env.PG_BIN,OWNED_POSTGRES_MAJOR:process.env.OWNED_POSTGRES_MAJOR??'16',
  P2_KNOWN_ACK_OWNED_TEST:'true',P2_KNOWN_ACK_COURSE_SOURCE_ROOT:process.env.P2_KNOWN_ACK_COURSE_SOURCE_ROOT,P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT:process.env.P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT},encoding:'utf8',timeout:1200000});
 if(result.status!==0){process.stderr.write(result.stderr);process.exitCode=1;}else {const receipt=JSON.parse(result.stdout);receipt.restoration.elapsedSeconds=Math.round((performance.now()-started)/100)/10;
  receipt.restoration.ownedSourceSha256=Object.fromEntries(['ops/platform/p2-known-ack-interrupted-restoration.mjs','ops/platform/host/p2_known_ack_interrupted_restoration.py','ops/platform/host/p2_release_broker.py','ops/platform/host/p2_release_supervisor.py','ops/gateway/server.mjs','ops/gateway/p2-certification-fault.mjs','ops/gateway/package.json','ops/gateway/package-lock.json',...['run-owned.mjs','owned-process.mjs','owned-engine.py'].map(name=>'docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/'+name)].map(name=>[name,createHash('sha256').update(readFileSync(join(root,name))).digest('hex')]));
  receipt.restoration.gatewayDependency={package:'jose',version:'6.2.3',resolution:'ops/gateway/node_modules/jose',packageSha256:createHash('sha256').update(readFileSync(join(root,'ops/gateway/node_modules/jose/package.json'))).digest('hex')};
  process.stdout.write(JSON.stringify(receipt,null,2)+'\n');}
}finally{rmSync(folder,{recursive:true,force:true});}
