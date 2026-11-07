// Explicit disposable PostgreSQL/TLS certification scope qualification only.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {chmodSync,mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {Client} from 'pg';
import {frontendMigrationArtifact} from './frontend-migration.mjs';
import {readMigrationCatalog} from './frontend-schema.mjs';
import {frontendAdmissionTargetSha256} from './frontend-admission-bootstrap.mjs';
import {reconcileFrontendOperation} from './frontend-admission.mjs';
import {withP2CertificationFrontendSession,observeP2CertificationPhysical,readP2CertificationCurrent,containP2ProfiledCertificationAdmission} from './p2-certification-current-probe.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile} from './qualification-target-profile.mjs';
const run=(program,args,options={})=>execFileSync(program,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'},...options});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let phase='owned-preflight';
async function child(){
  const input=JSON.parse(readFileSync(0));assert.equal(new URL(input.url).hostname,'127.0.0.1');
  const admin=new Client({connectionString:input.url,ssl:{rejectUnauthorized:true}});await admin.connect();
  const checks=[];let sourceProbe;
  try{
    phase='actual-child-source';const artifact=frontendMigrationArtifact();assert.equal(artifact.migrations.length,83);
    await admin.query('CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)');
    for(const row of artifact.migrations)await admin.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',[row.hash,row.folderMillis]);
    assert.match(input.password,/^owned-[a-f0-9-]+$/u);
    phase='actual-child-role-policy';await admin.query(`CREATE ROLE cert_creator LOGIN CREATEROLE NOINHERIT PASSWORD '${input.password}'; GRANT CREATE ON DATABASE postgres TO cert_creator; GRANT USAGE,CREATE ON SCHEMA public TO cert_creator; SET ROLE cert_creator;
      CREATE ROLE cert_owner NOLOGIN NOINHERIT; CREATE ROLE cert_runtime LOGIN NOINHERIT PASSWORD '${input.password}'; GRANT cert_owner TO cert_creator WITH INHERIT FALSE,SET TRUE,ADMIN FALSE; RESET ROLE;
      CREATE ROLE cert_retired NOLOGIN NOINHERIT; GRANT CREATE ON DATABASE postgres TO cert_owner; GRANT USAGE ON SCHEMA drizzle TO cert_creator; GRANT SELECT ON ALL TABLES IN SCHEMA drizzle,public TO cert_creator;
      SET ROLE cert_owner`);
    phase='actual-child-admission-schema';await admin.query(readFileSync(new URL('./frontend-admission.sql',import.meta.url),'utf8'));await admin.query('RESET ROLE');
    await admin.query(`GRANT USAGE ON SCHEMA public,frontend_admission TO cert_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO cert_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cert_runtime;
      GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO cert_runtime; SET ROLE cert_creator; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO cert_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO cert_runtime; RESET ROLE; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC`);
    const roles=Object.fromEntries((await admin.query("SELECT rolname,oid::text FROM pg_catalog.pg_roles WHERE rolname IN ('cert_owner','cert_runtime','cert_retired')")).rows.map(row=>[row.rolname,row.oid]));
    const url=new URL(input.url);url.username='cert_creator';url.password=input.password;
    const target={host:url.hostname,port:Number(url.port),database:'postgres',user:'cert_creator',runtimeRole:'cert_runtime',serverMajor:input.major,approvedPendingTags:artifact.migrations.map(row=>row.tag)};
    const targetSha256=frontendAdmissionTargetSha256('staging',target),sourceCommit='b'.repeat(40),producerSha256='c'.repeat(64),owner={name:'cert_owner',oid:roles.cert_owner};
    await admin.query("INSERT INTO frontend_admission.control(singleton,environment,target_sha256) VALUES(true,'staging',$1)",[targetSha256]);
    await admin.query('INSERT INTO frontend_admission.producers VALUES($1,$2,$3,true)',[producerSha256,sourceCommit,roles.cert_runtime]);
    const job={version:1,environment:'staging',releaseId:'original-qualified',sourceCommit,target,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),sqlArtifactSha256:artifact.sqlArtifactSha256,
      migrationImageDigest:'sha256:'+'e'.repeat(64),schemaBaselineSha256:'f'.repeat(64),contractManifestSha256:artifact.contractManifestSha256};
    const prepared={migration:{job,artifact,baseline:{catalog:await readMigrationCatalog(admin)}},plan:{targetSha256,owner,producers:[{producerSha256,role:{name:'cert_runtime',oid:roles.cert_runtime}}],historicalLogins:{retiredLogins:[{name:'cert_retired',oid:roles.cert_retired}]}}};
    const nativePlan={initialEpoch:'2',commandWitnesses:[],producer:{producerSha256,role:{name:'cert_runtime',oid:roles.cert_runtime}}};
    const plan={version:1,mode:'native-window',startState:'already-closed',initialEpoch:'1',sourceCommit,targetSha256,certificationActionId:'owned-certification',candidateSha256:'1'.repeat(64),planSha256:'2'.repeat(64),nativePlan};
    const deps={getUrl:()=>url.href,verifyEnvironment:async()=>{}};
    const current=()=>withP2CertificationFrontendSession(prepared,plan,deps,async({receipt,probe,verify,client})=>{
      assert.equal(receipt.status,'P2_CERTIFICATION_DATABASE_CURRENT');assert.equal(receipt.after.length,83);await verify();
      assert.equal((await observeP2CertificationPhysical({...probe,operation:'verify-schema'},deps)).status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');return{probe,client};
    });
    phase='actual-child-initial-current';await current();checks.push('actual83-current-lineage-schema-prepared-roles-and-old-login-denial');
    const journal=hash((await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows);
    await withP2CertificationFrontendSession(prepared,plan,deps,async({probe,client,verify})=>{
      sourceProbe=probe;assert.equal((await admin.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',['lash-her:private-db:migrations'])).rows[0].held,false);
      assert.deepEqual((await client.query('SHOW search_path')).rows[0],{search_path:'pg_catalog,public'});
      await assert.rejects(observeP2CertificationPhysical({...probe,marker:'f'.repeat(64),operation:'observe'},deps));
      await assert.rejects(observeP2CertificationPhysical({...probe,backendStart:'2000-01-01 00:00:00+00',operation:'observe'},deps));
      for(const [epoch,newWork,recovery] of [['2',false,true],['3',false,true],['4',false,false]]){
        await admin.query('UPDATE frontend_admission.control SET epoch=$1,new_work=$2,recovery=$3',[epoch,newWork,recovery]);
        assert.equal((await readP2CertificationCurrent(client,prepared,plan,verify)).admission.epoch,epoch);
      }
      await admin.query('UPDATE frontend_admission.control SET epoch=5');await assert.rejects(readP2CertificationCurrent(client,prepared,plan,verify));
      await admin.query('UPDATE frontend_admission.control SET epoch=4');
    });
    await assert.rejects(observeP2CertificationPhysical({...sourceProbe,operation:'observe'},deps));checks.push('actual-exclusive-global-and-random-lock-session-lifetime-and-fixed-native-epochs');
    await admin.query('UPDATE frontend_admission.control SET epoch=1,new_work=false,recovery=false');
    for(const [id,install,repair] of [
      ['runtime-inbound',`CREATE ROLE cert_rogue NOLOGIN; GRANT cert_runtime TO cert_rogue`,`REVOKE cert_runtime FROM cert_rogue; DROP ROLE cert_rogue`],
      ['runtime-database-setting',`ALTER ROLE cert_runtime IN DATABASE postgres SET search_path TO pg_catalog,public`,`ALTER ROLE cert_runtime IN DATABASE postgres RESET ALL`],
      ['runtime-public-shadow-schema',`CREATE SCHEMA cert_runtime; GRANT USAGE ON SCHEMA cert_runtime TO PUBLIC`,`DROP SCHEMA cert_runtime`],
    ]){
      await current();await withP2CertificationFrontendSession(prepared,plan,deps,async({probe})=>{
        await admin.query(install);try{await assert.rejects(observeP2CertificationPhysical({...probe,operation:'verify-schema'},deps));}finally{await admin.query(repair);}
        assert.equal((await observeP2CertificationPhysical({...probe,operation:'verify-schema'},deps)).status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
      });
      await admin.query(install);try{await assert.rejects(current());}finally{await admin.query(repair);}await current();checks.push('initial-and-continuous-'+id+'-refusal-and-repair');
    }
    for(const mode of ['auth-preparation','browser-pending']){
      const selected={...plan,mode,nativePlan:{...nativePlan,initialEpoch:'1'}},opened={...deps};
      await withP2CertificationFrontendSession(prepared,selected,opened,async({client,verify,probe})=>{
        for(const [epoch,newWork] of [['2',true],['3',false]]){await admin.query('UPDATE frontend_admission.control SET epoch=$1,new_work=$2,recovery=false',[epoch,newWork]);
          assert.equal((await readP2CertificationCurrent(client,prepared,selected,verify)).admission.epoch,epoch);}
        await admin.query('UPDATE frontend_admission.control SET epoch=4');await assert.rejects(observeP2CertificationPhysical({...probe,operation:'observe'},opened));
        await admin.query('UPDATE frontend_admission.control SET epoch=3');
      });
      await admin.query('UPDATE frontend_admission.control SET epoch=1,new_work=false,recovery=false');checks.push('actual-fixed-'+mode+'-open-close-epochs-only');
    }
    phase='actual-child-direct-worker-window';
    const direct={...plan,mode:'direct-worker'},operationId=randomUUID();
    await withP2CertificationFrontendSession(prepared,direct,deps,async({client,verify,probe})=>{
      await admin.query('UPDATE frontend_admission.control SET epoch=2,new_work=false,recovery=true');
      // Fixture-only catalog row: the actual whole HTTP/dispatcher/three-DB
      // worker is qualified separately. This proves the parent's exact window.
      await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state,completed_at)
        VALUES($1,$2,$3,$4,2,'recovery','completed',pg_catalog.clock_timestamp())`,[operationId,producerSha256,sourceCommit,roles.cert_runtime]);
      for(const [epoch,recovery] of [['2',true],['3',false]]){
        await admin.query('UPDATE frontend_admission.control SET epoch=$1,recovery=$2',[epoch,recovery]);
        const actual=await readP2CertificationCurrent(client,prepared,direct,verify);
        assert.equal(actual.admission.epoch,epoch);assert.equal(actual.admission.recovery,recovery);
        assert.deepEqual(actual.witness.operations.map(row=>row.id),[operationId]);
        assert.equal(actual.witness.operations[0].epoch,'2');assert.equal(actual.witness.operations[0].state,'completed');
        const independent=await observeP2CertificationPhysical({...probe,operation:'witness'},deps);
        assert.deepEqual(independent.witness.operations.map(row=>row.id),[operationId]);
      }
      await admin.query('UPDATE frontend_admission.control SET epoch=4');
      await assert.rejects(observeP2CertificationPhysical({...probe,operation:'observe'},deps));
      await admin.query('UPDATE frontend_admission.control SET epoch=3');
      await admin.query("UPDATE frontend_admission.operations SET state='uncertain',completed_at=NULL WHERE id=$1",[operationId]);
      await assert.rejects(readP2CertificationCurrent(client,prepared,direct,verify));
      await admin.query("UPDATE frontend_admission.operations SET state='completed',completed_at=pg_catalog.clock_timestamp() WHERE id=$1",[operationId]);
      assert.equal((await readP2CertificationCurrent(client,prepared,direct,verify)).admission.uncertain,0);
    });
    await admin.query('DELETE FROM frontend_admission.operations WHERE id=$1',[operationId]);
    await admin.query('UPDATE frontend_admission.control SET epoch=1,new_work=false,recovery=false');
    checks.push('actual-fixed-direct-worker-epoch-original-operation-window-and-uncertainty-refusal');
    phase='actual-child-known-ack-specific-settlement';
    const known={...plan,mode:'known-ack-recovery'},uncertainId=randomUUID(),replayId=randomUUID(),extraId=randomUUID(),evidence='d'.repeat(64);
    await withP2CertificationFrontendSession(prepared,known,deps,async({client,verify,probe})=>{
      await admin.query('UPDATE frontend_admission.control SET epoch=2,new_work=false,recovery=true');
      await readP2CertificationCurrent(client,prepared,known,verify);
      await admin.query('UPDATE frontend_admission.control SET epoch=3');
      for(const [id,state] of [[uncertainId,'uncertain'],[replayId,'completed']])await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state,completed_at)
        VALUES($1,$2,$3,$4,3,'recovery',$5,CASE WHEN $5='completed' THEN pg_catalog.clock_timestamp() ELSE NULL END)`,[id,producerSha256,sourceCommit,roles.cert_runtime,state]);
      assert.equal((await readP2CertificationCurrent(client,prepared,known,verify)).admission.uncertain,1);
      assert.equal((await observeP2CertificationPhysical({...probe,operation:'witness'},deps)).witness.operations.length,2);
      await admin.query('UPDATE frontend_admission.operations SET source_sha=$1 WHERE id=$2',['f'.repeat(40),uncertainId]);
      await assert.rejects(readP2CertificationCurrent(client,prepared,known,verify));
      await admin.query('UPDATE frontend_admission.operations SET source_sha=$1 WHERE id=$2',[sourceCommit,uncertainId]);
      await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state)
        VALUES($1,$2,$3,$4,3,'recovery','uncertain')`,[extraId,producerSha256,sourceCommit,roles.cert_runtime]);
      await assert.rejects(observeP2CertificationPhysical({...probe,operation:'observe'},deps));
      await admin.query('DELETE FROM frontend_admission.operations WHERE id=$1',[extraId]);
      await admin.query('UPDATE frontend_admission.control SET epoch=4,new_work=false,recovery=false');
      await client.query('SET ROLE cert_owner');
      try{
        await assert.rejects(reconcileFrontendOperation(client,{environment:'staging',targetSha256},'3',uncertainId,evidence));
        await reconcileFrontendOperation(client,{environment:'staging',targetSha256},'4',uncertainId,evidence);
      }finally{await client.query('RESET ROLE');}
      const actual=await readP2CertificationCurrent(client,prepared,known,verify);
      assert.equal(actual.admission.uncertain,0);assert.equal(actual.admission.active,0);assert.equal(actual.admission.epoch,'4');
      assert.equal(actual.witness.operations.find(row=>row.id===uncertainId).reconciliation_sha256,evidence);
      assert.equal((await observeP2CertificationPhysical({...probe,operation:'witness'},deps)).admission.uncertain,0);
    });
    await admin.query('DELETE FROM frontend_admission.operations WHERE id=ANY($1::uuid[])',[[uncertainId,replayId]]);
    await admin.query('UPDATE frontend_admission.control SET epoch=1,new_work=false,recovery=false');
    checks.push('actual-known-ack-epochs-exact-uncertainty-and-specific-operation-settlement');
    await admin.query('UPDATE frontend_admission.control SET new_work=true,recovery=true,epoch=2');
    assert.equal((await observeP2CertificationPhysical({...sourceProbe,operation:'fence'},deps)).frontendAdmissionClosed,true);
    assert.deepEqual((await admin.query('SELECT new_work,recovery FROM frontend_admission.control')).rows,[{new_work:false,recovery:false}]);
    checks.push('independent-fence-after-parent-session-loss-and-without-native-credential');
    const selectedProfile={qualificationTargetProfile:profile};
    const profileTarget={...target,...selectedProfile,approvedPendingTags:[]};
    const currentJob={...job,version:2,...selectedProfile,target:profileTarget};
    const profiled={migration:{...prepared.migration,job:currentJob},plan:{...prepared.plan,
      historicalLogins:{...prepared.plan.historicalLogins,version:2,...selectedProfile,target:profileTarget}}};
    const profiledPlan={...plan,version:2,...selectedProfile,originalReleaseId:job.releaseId,initialEpoch:'3',
      nativePlan:{...nativePlan,version:2,...selectedProfile,target:profileTarget,initialEpoch:'4'}};
    const guardProbe=await withP2CertificationFrontendSession(profiled,profiledPlan,deps,async({probe,receipt})=>{
      assert.equal(receipt.version,2);assert.deepEqual(receipt.qualificationTargetProfile,profile);
      assert.equal(receipt.sqlReplayed,false);
      const observed=await observeP2CertificationPhysical({...probe,operation:'witness'},deps,profile);
      assert.equal(observed.version,2);assert.deepEqual(observed.qualificationTargetProfile,profile);
      assert.equal(observed.journalSha256,receipt.journalSha256);
      assert.equal(observed.backendStart,probe.backendStart);assert.equal(observed.environment,'staging');
      assert.equal(observed.releaseId,receipt.releaseId);assert.equal(observed.targetSha256,receipt.targetSha256);
      await assert.rejects(observeP2CertificationPhysical({...probe,operation:'observe'},deps));
      await assert.rejects(observeP2CertificationPhysical({...probe,operation:'fence'},deps,profile));
      await assert.rejects(observeP2CertificationPhysical({...probe,marker:'f'.repeat(64),operation:'observe'},deps,profile));
      await assert.rejects(containP2ProfiledCertificationAdmission(probe,deps),error=>error.checkpoint==='guard-physical-lock');
      return probe;
    },profile);
    await assert.rejects(withP2CertificationFrontendSession(profiled,profiledPlan,deps,async({client,probe,verify})=>{
      assert.equal((await client.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS unlocked',[probe.marker])).rows[0].unlocked,true);
      await assert.rejects(verify);
      await assert.rejects(observeP2CertificationPhysical({...probe,operation:'observe'},deps,profile));
    },profile));
    checks.push('actual-profiled-current-certification-lock-readback-and-fence-refusal');
    await admin.query('UPDATE frontend_admission.control SET epoch=4,new_work=true,recovery=false');
    const guardClosed=await containP2ProfiledCertificationAdmission(guardProbe,deps);
    assert.equal(guardClosed.frontendAdmissionClosed,true);assert.equal(guardClosed.admissionChanged,true);
    assert.equal(guardClosed.epoch,'5');
    assert.equal((await containP2ProfiledCertificationAdmission(guardProbe,deps)).admissionChanged,false);
    assert.deepEqual((await admin.query('SELECT new_work,recovery FROM frontend_admission.control')).rows,[{new_work:false,recovery:false}]);
    checks.push('actual-profiled-guard-fence-with-exclusive-lock-and-idempotent-readback');
    assert.equal(hash((await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows),journal);
    return{version:1,status:'P2_CERTIFICATION_CURRENT_OWNED_PASS',serverMajor:input.major,frontendMigrations:83,checks,skipped:0,actualTlsPostgres:true,noSqlReplay:true,providerTouched:false,
      actualHostDocker:false,browserQualified:false,nativeInvocationQualified:false,fixtureOnly:true};
  }finally{await admin.end();}
}
async function outer(){
  assert.equal(process.env.P2_CERTIFICATION_OWNED_TEST,'true');assert.equal(process.versions.node.split('.')[0],'24');
  const bin=process.env.PG_BIN,major=Number(process.env.OWNED_POSTGRES_MAJOR??'16');assert.ok(bin?.startsWith('/')&&[16,18].includes(major));assert.match(run(join(bin,'postgres'),['--version']),new RegExp(`PostgreSQL\\) ${major}\\.`,'u'));
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-certification-owned-')));chmodSync(directory,0o700);const data=join(directory,'data'),cert=join(directory,'server.crt'),key=join(directory,'server.key'),password='owned-'+randomUUID();let started=false,client;
  try{
    const listener=createServer();await new Promise((done,fail)=>{listener.once('error',fail);listener.listen(0,'127.0.0.1',done);});const port=listener.address().port;await new Promise(done=>listener.close(done));
    run(join(bin,'initdb'),['-D',data,'-U','cert_provider_fixture','-A','trust','--locale=C','-E','UTF8']);
    run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert]);chmodSync(key,0o600);
    writeFileSync(join(data,'postgresql.conf'),`listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data,'pg_hba.conf'),'hostssl all cert_provider_fixture 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n');
    run(join(bin,'pg_ctl'),['-D',data,'-l',join(directory,'postgres.log'),'-w','start']);started=true;
    client=new Client({host:'127.0.0.1',port,user:'cert_provider_fixture',database:'postgres',ssl:{rejectUnauthorized:true,ca:readFileSync(cert,'utf8')}});await client.connect();
    phase='source-migrations';for(const row of frontendMigrationArtifact().migrations){await client.query('BEGIN');for(const sql of row.sql)await client.query(sql);await client.query('COMMIT');}await client.end();client=undefined;
    phase='actual-current-and-physical-session';const url=`postgresql://cert_provider_fixture@127.0.0.1:${port}/postgres?sslmode=verify-full`;
    const env=Object.fromEntries(['PATH','HOME','LANG','TMPDIR'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
    const result=spawnSync(process.execPath,['--experimental-strip-types',new URL(import.meta.url).pathname],{input:JSON.stringify({url,password,major}),encoding:'utf8',timeout:120_000,
      env:{...env,NODE_EXTRA_CA_CERTS:cert,P2_CERTIFICATION_OWNED_CHILD:'true'}});
    if(result.status!==0){process.stderr.write(result.stderr);throw new Error('OWNED_CERTIFICATION_CHILD_REFUSED');}return JSON.parse(result.stdout);
  }finally{if(client)await client.end();if(started)run(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);rmSync(directory,{recursive:true,force:true});}
}
(process.env.P2_CERTIFICATION_OWNED_CHILD==='true'?child():outer()).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({status:'P2_CERTIFICATION_CURRENT_OWNED_FAILED',phase,code:error?.code??error?.name??'Error',checkpoint:error?.checkpoint??null,providerTouched:false}));process.exitCode=1;});
