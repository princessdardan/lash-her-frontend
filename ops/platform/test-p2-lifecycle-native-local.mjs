// Own disposable TLS/SCRAM PG cluster; no configured/live URLs or providers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { frontendAdmissionTargetSha256, bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact } from "./frontend-admission-bootstrap.mjs";

const execute=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
let phase='ownership';
async function main(){
  assert.equal(process.env.P2_NATIVE_OWNED_TEST,'true'); const binaries=process.env.PG_BIN; assert.ok(binaries?.startsWith('/'));
  const selectedMajor=process.env.OWNED_POSTGRES_MAJOR??'16';assert.ok(['16','18'].includes(selectedMajor));const postgresMajor=Number(selectedMajor);
  assert.match(execute(join(binaries,'postgres'),['--version']),new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`,'u'));
  const listener=createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-native-owned-'))),data=join(directory,'data'),password=`owned-${randomUUID()}`,clients=[];chmodSync(directory,0o700);let started=false;
  try{
    phase='cluster';execute(join(binaries,'initdb'),['-D',data,'-A','trust','-U','frontend_test_admin','-E','UTF8','--locale=C']);
    const certificate=join(directory,'server.crt'),key=join(directory,'server.key');execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',certificate]);chmodSync(key,0o600);
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
    const sourceCommit=execute('git',['rev-parse','HEAD']).trim(),target={host:'127.0.0.1',port,database:'frontend_admission_owned',user:'frontend_test_admin',serverMajor:postgresMajor},targetSha256=frontendAdmissionTargetSha256('staging',target);
    const roles=(await operator.query("SELECT oid::text,rolname FROM pg_roles WHERE rolname IN ('admission_owner','frontend_runtime')")).rows;
    const owner={name:'admission_owner',oid:roles.find(row=>row.rolname==='admission_owner').oid},runtime={name:'frontend_runtime',oid:roles.find(row=>row.rolname==='frontend_runtime').oid};
    phase='closed-bootstrap';await bootstrapFrontendAdmission({version:1,environment:'staging',actionId:'owned-native',sourceCommit,...frontendAdmissionBootstrapArtifact(),inventorySha256:'a'.repeat(64),targetSha256,target,owner,producers:[{producerSha256:'b'.repeat(64),sourceCommit,role:runtime}]},operator,
      {confirmation:'staging/owned-native',record:async()=>{},verifySession:async()=>{assert.equal(operator.connection.stream.authorized,true);}});
    phase='actual-cron-stage';const child=spawnSync(process.execPath,['--import','tsx','--import','./scripts/register-server-only-test.mjs','ops/platform/harness/owned-p2-native-lifecycle.mjs'],{
      input:JSON.stringify({port,password,certificate,key,directory,target,targetSha256,owner,runtime,sourceCommit,postgresMajor}),encoding:'utf8',timeout:120_000,
      env:Object.fromEntries([...['PATH','HOME','LANG','TMPDIR'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]),['NODE_EXTRA_CA_CERTS',certificate],['P2_NATIVE_OWNED_CHILD','true']])});
    assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.status,'P2_LIFECYCLE_NATIVE_OWNED_PASS');
    return{...result,postgresMajor,migrations:artifact.migrations.length,sqlArtifactSha256:artifact.sqlArtifactSha256,fixtureOnly:true,actualVercelNativeEvidence:false,providerTouched:false};
  }finally{for(const client of clients){try{await client.end();}catch{/*Owned cleanup.*/}}if(started)execute(join(binaries,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);rmSync(directory,{recursive:true,force:true});}
}
main().then(result=>process.stdout.write(`${JSON.stringify(result,null,2)}\n`)).catch(()=>{process.stderr.write(`${JSON.stringify({status:'P2_LIFECYCLE_NATIVE_OWNED_FAILED',phase,providerTouched:false})}\n`);process.exitCode=1;});
