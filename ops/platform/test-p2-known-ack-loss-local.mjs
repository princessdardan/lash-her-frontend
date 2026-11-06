// Own disposable TLS/SCRAM PG cluster; no configured/live URLs or providers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID,createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createRequire} from 'node:module';
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { frontendAdmissionTargetSha256, bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact } from "./frontend-admission-bootstrap.mjs";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";

const safeEnvironment={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const execute=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:safeEnvironment});
let phase='ownership';
async function main(){
  assert.equal(process.env.P2_KNOWN_ACK_OWNED_TEST,'true'); const binaries=process.env.PG_BIN; assert.ok(binaries?.startsWith('/'));
  const selectedMajor=process.env.OWNED_POSTGRES_MAJOR??'16';assert.ok(['16','18'].includes(selectedMajor));const postgresMajor=Number(selectedMajor);
  assert.match(execute(join(binaries,'postgres'),['--version']),new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`,'u'));
  const listener=createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-known-ack-owned-'))),data=join(directory,'data'),password=`owned-${randomUUID()}`,clients=[];chmodSync(directory,0o700);let started=false;
  try{
    phase='cluster';execute(join(binaries,'initdb'),['-D',data,'-A','trust','-U','frontend_test_admin','-E','UTF8','--locale=C']);
    const certificate=join(directory,'server.crt'),key=join(directory,'server.key');execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:api-staging.lashher.com,IP:127.0.0.1','-keyout',key,'-out',certificate]);chmodSync(key,0o600);
    writeFileSync(join(data,'postgresql.conf'),`listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data,'pg_hba.conf'),'local all all trust\nhostssl all frontend_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n');
    execute(join(binaries,'pg_ctl'),['-D',data,'-l',join(directory,'postgres.log'),'-w','start']);started=true;
    const connect=async database=>{const client=new Client({host:'127.0.0.1',port,database,user:'frontend_test_admin',password,ssl:{rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')}});clients.push(client);await client.connect();return client;};
    const setup=await connect('postgres');await setup.query('CREATE DATABASE frontend_admission_owned');
    await setup.query('CREATE ROLE admission_owner NOLOGIN NOINHERIT');await setup.query(`CREATE ROLE frontend_runtime LOGIN NOINHERIT PASSWORD '${password}'`);
    const operator=await connect('frontend_admission_owned');await operator.query('GRANT CREATE ON DATABASE frontend_admission_owned TO admission_owner');
    phase='migrations';const artifact=frontendMigrationArtifact();await operator.query('CREATE SCHEMA drizzle');await operator.query('CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text,created_at bigint)');
    for(const migration of artifact.migrations){await operator.query('BEGIN');for(const sql of migration.sql)await operator.query(sql);await operator.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',[migration.hash,migration.folderMillis]);await operator.query('COMMIT');}
    await operator.query('GRANT USAGE ON SCHEMA public TO frontend_runtime');await operator.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO frontend_runtime');await operator.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO frontend_runtime');
    phase='actual-api-sources-and-migrations';const apis={};
    for(const service of ['course','community']){
      const repository=realpathSync(process.env[`P2_KNOWN_ACK_${service.toUpperCase()}_SOURCE_ROOT`]??`/Users/dardan/workspace/lash-her-${service}-api/.worktrees/phase2-role-qualification`);
      assert.equal(execute('git',['--no-replace-objects','--no-optional-locks','-C',repository,'remote','get-url','origin']).trim(),`https://github.com/princessdardan/lash-her-${service}-api.git`);
      const commit=process.env[`P2_KNOWN_ACK_${service.toUpperCase()}_SOURCE_COMMIT`]??({course:'a447bfde20299e12afab68a3331b3792ddd07598',community:'939de65dd52f0b1a43993a25c7c428dce6e2bb43'}[service]);assert.match(commit,/^[a-f0-9]{40}$/u);
      const root=join(directory,service);mkdirSync(root);
      const archive=execFileSync('git',['--no-replace-objects','--no-optional-locks','-C',repository,'archive',commit],{maxBuffer:64*1024*1024,env:safeEnvironment});
      const extracted=spawnSync('tar',['-xf','-','-C',root],{input:archive,env:safeEnvironment});assert.equal(extracted.status,0);
      assert.deepEqual(readFileSync(join(root,'package-lock.json')),readFileSync(join(repository,'package-lock.json')));symlinkSync(join(repository,'node_modules'),join(root,'node_modules'),'dir');
      const user='known_'+service+'_runtime',database='owned_lifecycle_'+service+'_test';await setup.query(`CREATE ROLE ${user} LOGIN NOINHERIT PASSWORD '${password}';`);await setup.query(`CREATE DATABASE ${database}`);
      const client=await connect(database),require=createRequire(join(root,'package.json')),{drizzle}=require('drizzle-orm/node-postgres'),{migrate}=require('drizzle-orm/node-postgres/migrator');
      await migrate(drizzle(client),{migrationsFolder:join(root,'drizzle')});
      await client.query(`GRANT USAGE ON SCHEMA public TO ${user}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${user}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user}`);
      const migrations=(await client.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count;assert.equal(migrations,service==='course'?22:11);
      const roleOid=(await client.query('SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=$1',[user])).rows[0].oid;
      apis[service]={root,commit,archiveSha256:hash(archive),lockSha256:hash(readFileSync(join(root,'package-lock.json'))),migrations,database:{host:'127.0.0.1',port,user,password,database},roleOid};
    }
    const sourceCommit=nativeSourceCommit(),target={host:'127.0.0.1',port,database:'frontend_admission_owned',user:'frontend_test_admin',serverMajor:postgresMajor},targetSha256=frontendAdmissionTargetSha256('staging',target);
    const roles=(await operator.query("SELECT oid::text,rolname FROM pg_roles WHERE rolname IN ('admission_owner','frontend_runtime')")).rows;
    const owner={name:'admission_owner',oid:roles.find(row=>row.rolname==='admission_owner').oid},runtime={name:'frontend_runtime',oid:roles.find(row=>row.rolname==='frontend_runtime').oid};
    phase='closed-bootstrap';await bootstrapFrontendAdmission({version:1,environment:'staging',actionId:'owned-native',sourceCommit,...frontendAdmissionBootstrapArtifact(),inventorySha256:'a'.repeat(64),targetSha256,target,owner,producers:[{producerSha256:'b'.repeat(64),sourceCommit,role:runtime}]},operator,
      {confirmation:'staging/owned-native',record:async()=>{},verifySession:async()=>{assert.equal(operator.connection.stream.authorized,true);}});
    phase='actual-cron-stage';const child=spawnSync(process.execPath,['--import','tsx','--import','./scripts/register-server-only-test.mjs','ops/platform/harness/owned-p2-known-ack-loss.mjs'],{
      input:JSON.stringify({port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit,postgresMajor,apis}),encoding:'utf8',timeout:180_000,
      env:Object.fromEntries([...['PATH','HOME','LANG','TMPDIR'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]),['NODE_EXTRA_CA_CERTS',certificate],['P2_NATIVE_OWNED_CHILD','true']])});
    if(child.status!==0){const rows=child.stderr.trim().split('\n').filter(row=>row.startsWith('{'));if(rows.length){const item=JSON.parse(rows.at(-1));if(/^[a-z-]{1,80}$/u.test(item.phase??''))phase='child-'+item.phase;if(item.observed)process.stderr.write(JSON.stringify(item.observed)+'\n');}throw new Error('OWNED_KNOWN_ACK_CHILD_REFUSED');}const result=JSON.parse(child.stdout);assert.equal(result.status,'P2_KNOWN_ACK_WHOLE_ROUTE_PASS');
    return{...result,postgresMajor,migrations:{frontend:artifact.migrations.length,course:apis.course.migrations,community:apis.community.migrations},frontendSourceCommit:sourceCommit,
      apiSourceCommits:Object.fromEntries(Object.entries(apis).map(([name,value])=>[name,value.commit])),apiSourceArchives:Object.fromEntries(Object.entries(apis).map(([name,value])=>[name,{sha256:value.archiveSha256,lockSha256:value.lockSha256}])),
      fixtureSourceSha256:Object.fromEntries(['p2-known-ack-loss-probe.mjs','host/p2_known_ack_loss.py','harness/owned-p2-known-ack-loss.mjs','harness/owned-phase2-lifecycle-receiver.mjs'].map(file=>[file,hash(readFileSync(new URL('./'+file,import.meta.url)))])),
      sqlArtifactSha256:artifact.sqlArtifactSha256,fixtureOnly:true,actualVercelNativeEvidence:false,providerTouched:false};
  }finally{for(const client of clients){try{await client.end();}catch{/*Owned cleanup.*/}}if(started)execute(join(binaries,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);rmSync(directory,{recursive:true,force:true});}
}
main().then(result=>process.stdout.write(`${JSON.stringify(result,null,2)}\n`)).catch(()=>{process.stderr.write(`${JSON.stringify({status:'P2_KNOWN_ACK_WHOLE_ROUTE_FAILED',phase,providerTouched:false})}\n`);process.exitCode=1;});
