// Explicit owned core-catalog observation fixture. No complete emptiness or first-use authority.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,chmodSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from 'pg';
import {frontendMigrationArtifact,FRONTEND_MIGRATION_LOCK} from './frontend-migration.mjs';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);

export function ownedP2qObservationFixture(directory,profile={version:1,id:'owned-first-install',kind:'isolated-allocated',selectionPolicy:'isolated-allocated-v1',environment:'staging'}){
 const ref={version:1,id:profile.id,sha256:hash(canonical(profile))};
 const js=`const ref=${JSON.stringify(ref)},profile=${JSON.stringify(profile)};export function requireQualificationTargetProfile(expected,...carriers){if(JSON.stringify(expected)!==JSON.stringify(ref)||carriers.some(value=>JSON.stringify(value.qualificationTargetProfile)!==JSON.stringify(ref)))throw Object.assign(new Error('QUALIFICATION_TARGET_PROFILE_UNKNOWN'),{code:'QUALIFICATION_TARGET_PROFILE_UNKNOWN'});return structuredClone(ref);}export function resolveQualificationTargetProfile(value){requireQualificationTargetProfile(value);return structuredClone(profile);}`;
 writeFileSync(join(directory,'qualification-target-profile.mjs'),js,{mode:0o600});
 writeFileSync(join(directory,'qualification_target_profile.py'),`import copy\nREF=${JSON.stringify(ref)}\nPROFILE=${JSON.stringify(profile)}\ndef require_qualification_target_profile(expected,*carriers):\n if expected!=REF or any(value.get('qualificationTargetProfile')!=REF for value in carriers):raise ValueError('QUALIFICATION_TARGET_PROFILE_UNKNOWN')\n return copy.deepcopy(REF)\ndef resolve_qualification_target_profile(value):\n require_qualification_target_profile(value)\n return copy.deepcopy(PROFILE)\n`,{mode:0o600});
 let source=readFileSync(join(root,'ops/platform/p2q-first-install.mjs'),'utf8');
 const before="from './frontend-migration.mjs'";assert.equal(source.split(before).length,2);source=source.replace(before,'from '+JSON.stringify(pathToFileURL(join(root,'ops/platform/frontend-migration.mjs')).href));
 writeFileSync(join(directory,'p2q-first-install.mjs'),source,{mode:0o600});
 symlinkSync(join(root,'node_modules'),join(directory,'node_modules'),'dir');
 return ref;
}

function fixedExec(file,args,options={}){
 const result=spawnSync(file,args,{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'},...options});
 if(result.status!==0||result.error)throw new Error('P2Q_OWNED_FIXED_CHILD_REFUSED');return result.stdout;
}
export async function runOwnedP2qFirstInstall(){
 assert.equal(process.env.P2Q_FIRST_INSTALL_OWNED_TEST,'true');assert.equal(process.argv.length,2);assert.equal(process.versions.node.split('.')[0],'24');
 const binaries=process.env.PG_BIN;assert.ok(binaries&&resolve(binaries)===binaries);
 const version=fixedExec(join(binaries,'postgres'),['--version']);assert.match(version,/PostgreSQL\) 18\./u);
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2q-first-install-owned-'))),data=join(directory,'data'),socket=join(directory,'socket'),checks=[];
 mkdirSync(socket,{mode:0o700});let started=false,client,guard;
 const password=randomBytes(32).toString('hex'),pwfile=join(directory,'password');writeFileSync(pwfile,password+'\n',{mode:0o600});
 const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
 const certificate=join(directory,'server.crt'),key=join(directory,'server.key');
 let phase='owned-cluster';
 try{
  phase='owned-tls';fixedExec('openssl',['req','-new','-x509','-nodes','-newkey','rsa:2048','-days','1','-keyout',key,'-out',certificate,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);chmodSync(key,0o600);
  phase='owned-initdb';fixedExec(join(binaries,'initdb'),['-D',data,'-U','p2q_owned_admin','--auth-host=scram-sha-256','--auth-local=trust','--pwfile',pwfile]);
  writeFileSync(join(data,'postgresql.auto.conf'),`ssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\n`,{mode:0o600});
  phase='owned-start-server';fixedExec(join(binaries,'pg_ctl'),['-D',data,'-l',join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${socket}`,'-w','start']);started=true;
  const connect=async(database='p2q_frontend',ssl={rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')})=>{const value=new Client({host:'127.0.0.1',port,database,user:'p2q_owned_admin',password,ssl});value.on('error',()=>{});await value.connect();return value;};
  phase='owned-create-database';const setup=await connect('postgres');await setup.query('CREATE DATABASE p2q_frontend');await setup.end();
  phase='owned-profile-source';const fixture=join(directory,'fixture');mkdirSync(fixture,{mode:0o700});const ref=ownedP2qObservationFixture(fixture);
  const collector=await import(pathToFileURL(join(fixture,'p2q-first-install.mjs')).href);
  const sourceCommit=fixedExec('git',['--no-replace-objects','-c','safe.directory='+root,'-C',root,'rev-parse','HEAD']).trim();
  const artifact=frontendMigrationArtifact(),request={qualificationTargetProfile:ref,actionId:'owned-preuse-observation',candidate:{version:3,environment:'staging',contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),releaseId:'owned-first-install',sources:{frontend:{commit:sourceCommit}},qualificationTargetProfile:ref},
   job:{version:2,environment:'staging',releaseId:'owned-first-install',sourceCommit,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),qualificationTargetProfile:ref,
    target:{host:'127.0.0.1',port,database:'p2q_frontend',user:'p2q_owned_admin',runtimeRole:'p2q_owned_runtime',serverMajor:18,allowEmptyBootstrap:true,approvedPendingTags:artifact.migrations.map(row=>row.tag)}}};
  const hostRoot=join(directory,'host-root'),hostLock=join(directory,'host.lock'),machine=join(directory,'machine-id'),dockerState=join(directory,'docker.json'),docker=join(directory,'docker-fixture');
  mkdirSync(hostRoot,{mode:0o700});writeFileSync(machine,'1'.repeat(32)+'\n');writeFileSync(dockerState,JSON.stringify({daemon:'owned-daemon',containers:[]}));
  writeFileSync(docker,`#!/usr/bin/env python3\nimport json,sys\nv=json.load(open(${JSON.stringify(dockerState)}))\nsys.stdout.write(json.dumps(v['daemon'])+'\\n' if sys.argv[1]=='info' else ''.join(value+'\\n' for value in v['containers']))\n`,{mode:0o700});
  let hostSource=readFileSync(join(root,'ops/platform/host/p2q_first_install.py'),'utf8');
  for(const [from,to]of [["LOCK_PATH=Path('/run/lock/lash-her-release.lock')",`LOCK_PATH=Path(${JSON.stringify(hostLock)})`],["STAGING_ROOT=Path('/var/lib/lash-her/releases/staging')",`STAGING_ROOT=Path(${JSON.stringify(hostRoot)})`],["MACHINE_ID=Path('/etc/machine-id')",`MACHINE_ID=Path(${JSON.stringify(machine)})`],["DOCKER='/usr/bin/docker'",`DOCKER=${JSON.stringify(docker)}`]]){assert.equal(hostSource.split(from).length,2);hostSource=hostSource.replace(from,to);}
  const hostProgram=join(fixture,'p2q_first_install.py');writeFileSync(hostProgram,hostSource,{mode:0o600});
  const hostRequest={version:1,operation:'observe',qualificationTargetProfile:ref,candidate:request.candidate,job:request.job,actionId:request.actionId};
  async function startGuard(){
   const child=spawn('python3',['-I','-u',hostProgram],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C',PYTHONDONTWRITEBYTECODE:'1'}});let waiter,buffer=[],ended=false;
   const lines=createInterface({input:child.stdout});lines.on('line',line=>{if(waiter){const current=waiter;waiter=undefined;clearTimeout(current.timer);current.resolve(JSON.parse(line));}else buffer.push(line);});
   child.stdin.on('error',()=>{});child.on('exit',()=>{ended=true;if(waiter){clearTimeout(waiter.timer);waiter.reject(new Error('OWNED_HOST_GUARD_LOST'));waiter=undefined;}});
   const next=()=>new Promise((resolve,reject)=>{if(ended)return reject(new Error('OWNED_HOST_GUARD_LOST'));if(buffer.length)return resolve(JSON.parse(buffer.shift()));const timer=setTimeout(()=>{waiter=undefined;reject(new Error('OWNED_HOST_GUARD_TIMEOUT'));},10000);waiter={resolve,reject,timer};});
   child.stdin.write(JSON.stringify(hostRequest)+'\n');const observed=await next();assert.equal(observed.firstUseAuthorized,false);
   return {child,observed,check:async()=>{const promise=next();child.stdin.write('{"operation":"check"}\n');const current=await promise;assert.deepEqual(current,observed);},close:async()=>{if(!ended){child.stdin.end();await new Promise(done=>child.once('exit',done));}lines.close();}};
  }
  phase='owned-host-start';guard=await startGuard();client=await connect();const lock=async()=>assert.equal((await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',[FRONTEND_MIGRATION_LOCK])).rows[0].held,true);await lock();
  const collect=task=>collector.withP2qFirstInstallDatabaseObservation(request,{client,verifySession:()=>guard.check()},task);
  phase='actual-core-catalog-observation';let escaped;
  const first=await collect(async(handle,verify)=>{escaped=handle;const value=await verify();assert.equal(value.firstUseAuthorized,false);await assert.rejects(collector.readP2qFirstInstallDatabaseObservation({...handle}));return null;});
  assert.equal(first.observation.firstUseAuthorized,false);assert.equal(first.observation.creationControlProven,false);await assert.rejects(collector.readP2qFirstInstallDatabaseObservation(escaped));checks.push('actual-tls-core-catalog-role-backend-and-source-nonce-observation-with-no-authority');
  const assertScoped=observation=>{
   assert.equal(observation.status,'P2Q_FIRST_INSTALL_CORE_CATALOG_OBSERVED_ZERO');assert.equal(observation.catalogObservationScope,'frontend-core-counts-v1');
   for(const key of ['firstUseAuthorized','migrationAuthorized','rolePreparationAuthorized','completeDatabaseEmptyProven','creationControlProven','credentialDeliveryHistoryProven','providerBeforeUseProven','hostControlProven','targetSelectionVerified'])assert.equal(observation[key],false);
   for(const name of ['pg_collation','pg_db_role_setting','pg_auth_members','pg_default_acl','pg_cast','pg_ts_config'])assert.ok(observation.unobservedCatalogClasses.includes(name));
   assert.deepEqual(observation.counts,first.observation.counts);assert.equal(observation.roleCatalogSha256,first.observation.roleCatalogSha256);
  };
  assertScoped(first.observation);
  phase='unobserved-collation-control';
  await client.query('CREATE COLLATION public.owned_unobserved FROM pg_catalog."C"');
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_catalog.pg_collation WHERE collname='owned_unobserved'")).rows[0].count,1);
  assertScoped((await collect(async()=>null)).observation);await client.query('DROP COLLATION public.owned_unobserved');
  checks.push('actual-custom-collation-unobserved-with-complete-emptiness-unproven-and-no-authority');
  phase='unobserved-database-role-setting-control';
  await client.query('ALTER ROLE p2q_owned_admin IN DATABASE p2q_frontend SET search_path = public, pg_catalog');
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_catalog.pg_db_role_setting WHERE setrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='p2q_owned_admin') AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname='p2q_frontend')")).rows[0].count,1);
  assertScoped((await collect(async()=>null)).observation);await client.query('ALTER ROLE p2q_owned_admin IN DATABASE p2q_frontend RESET ALL');
  checks.push('actual-database-role-setting-unobserved-with-complete-emptiness-unproven-and-no-authority');
  const peer=await connect();assert.equal((await peer.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',[FRONTEND_MIGRATION_LOCK])).rows[0].held,false);await peer.end();checks.push('actual-parent-physical-lock-contention');
  phase='catalog-faults';
  for(const sql of ['CREATE TABLE public.owned_foreign(id int)','CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id int)','CREATE SCHEMA owned_foreign; CREATE FUNCTION owned_foreign.f() RETURNS int LANGUAGE sql AS $$SELECT 1$$']){
   await client.query(sql);await assert.rejects(collect(async()=>null));await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS owned_foreign CASCADE; DROP TABLE IF EXISTS public.owned_foreign');await collect(async()=>null);
  }checks.push('foreign-table-journal-schema-and-function-refuse-and-repair');
  const extra=await connect();await assert.rejects(collect(async()=>null));await extra.end();await collect(async()=>null);checks.push('actual-unregistered-session-refuses-and-repair');
  await assert.rejects(collect(async(_handle,verify)=>{await client.query('CREATE ROLE owned_drift NOLOGIN');await verify();}));await client.query('DROP ROLE owned_drift');await collect(async()=>null);checks.push('actual-global-role-catalog-drift-refuses');
  await assert.rejects(collect(async(_handle,verify)=>{await client.query('SELECT pg_catalog.pg_advisory_unlock_all()');await verify();}));await lock();await collect(async()=>null);checks.push('actual-global-and-nonce-lock-loss-refuses');
  const unsafe=await connect('p2q_frontend',{rejectUnauthorized:false});await assert.rejects(collector.withP2qFirstInstallDatabaseObservation(request,{client:unsafe,verifySession:()=>guard.check()},async()=>null));await unsafe.end();checks.push('unverified-tls-refuses');
  phase='backend-loss';
  const admin=await connect('postgres');await assert.rejects(collect(async(_handle,verify)=>{const pid=(await client.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid;await admin.query('SELECT pg_catalog.pg_terminate_backend($1)',[pid]);await verify();}));await admin.end();await client.end();client=await connect();await lock();await collect(async()=>null);checks.push('actual-frontend-backend-death-refuses-with-no-authority');
  phase='host-process-loss';
  await assert.rejects(collect(async(_handle,verify)=>{const exited=new Promise(done=>guard.child.once('exit',done));guard.child.kill('SIGKILL');await exited;await verify();}));await guard.close();guard=await startGuard();await collect(async()=>null);checks.push('actual-host-guard-process-death-refuses-with-no-authority');
  const before=(await client.query("SELECT pg_catalog.to_regnamespace('drizzle') IS NULL AS no_journal,pg_catalog.to_regnamespace('frontend_admission') IS NULL AS no_admission")).rows[0];assert.deepEqual(before,{no_journal:true,no_admission:true});
  return {version:1,status:'P2Q_FIRST_INSTALL_COLLECTORS_OWNED_PASS',postgresMajor:18,checks,executedChecks:checks.length,skipped:0,fixtureOnly:true,actualTlsPostgres:true,actualPhysicalDatabaseLocks:true,actualHostProcessFlock:true,
   fixtureRegistryProjected:true,dockerMetadataProjected:true,actualDocker:false,providerTouched:false,firstUseAuthorityMinted:false,productionFirstInstallEligible:false,migrationExecuted:false,rolePreparationExecuted:false,admissionInstalled:false,
   originalObservedCatalogStatePreserved:true,frontendPendingMigrationCount:artifact.migrations.length,observation:first.observation,sourceCommit,sourceSha256:Object.fromEntries(['ops/platform/p2q-first-install.mjs','ops/platform/host/p2q_first_install.py','ops/platform/test-p2q-first-install-local.mjs'].map(name=>[name,hash(readFileSync(join(root,name)))]))};
 }catch(error){throw Object.assign(new Error('P2Q_FIRST_INSTALL_OWNED_FAILED'),{phase,kind:['Error','AssertionError','TypeError','SyntaxError','ValueError'].includes(error?.name)?error.name:'Unknown',frame:(String(error?.stack).split('\n').find(line=>line.includes('test-p2q-first-install-local.mjs:'))??'').match(/:(\d+):(\d+)\)?$/u)?.slice(1)??null,code:typeof error?.code==='string'&&error.code.startsWith('P2Q_')?error.code:'UNKNOWN'});}
 finally{if(client)try{await client.end();}catch{/*Owned cleanup.*/}if(guard)await guard.close();if(started)fixedExec(join(binaries,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runOwnedP2qFirstInstall().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({status:'P2Q_FIRST_INSTALL_OWNED_FAILED',phase:error.phase??'owned-setup',kind:error.kind??'Unknown',frame:error.frame??null,code:error.code??'UNKNOWN',firstUseAuthorityMinted:false})+'\n');process.exitCode=1;});
