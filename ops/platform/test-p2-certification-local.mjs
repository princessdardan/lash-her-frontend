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
import {runP2InteractiveFrontendCase} from './p2-certification.mjs';
import {frontendAdmissionTargetSha256} from './frontend-admission-bootstrap.mjs';
import {changeFrontendAdmission,closeFrontendInteractiveAdmission,openFrontendInteractiveAdmission,prepareFrontendInteractiveProducer,reconcileFrontendOperation,
  restoreFencedFrontendInteractiveProducers,runFrontendWriterOperation} from './frontend-admission.mjs';
import {withP2CertificationFrontendSession,observeP2CertificationPhysical,readP2CertificationCurrent,containP2ProfiledCertificationAdmission,
  withP2ProfiledInterruptedFrontendSession,observeP2ProfiledInterruptedFrontendPhysical} from './p2-certification-current-probe.mjs';
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
    const known={...plan,mode:'known-ack-recovery'},uncertainId=randomUUID(),replayId=randomUUID(),extraId=randomUUID();
    const settlementBytes=Buffer.from(JSON.stringify({version:2,operationId:uncertainId,epoch:'4'})+'\n');
    const evidence=createHash('sha256').update(settlementBytes).digest('hex');
    let originalProbe;
    await withP2CertificationFrontendSession(prepared,known,deps,async({client,verify,probe})=>{
      originalProbe=probe;
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
    checks.push('actual-known-ack-epochs-exact-uncertainty-and-specific-operation-settlement');
    const selectedProfile={qualificationTargetProfile:profile};
    const profileTarget={...target,...selectedProfile,approvedPendingTags:[],allowEmptyBootstrap:false};
    const currentJob={...job,version:2,...selectedProfile,target:profileTarget};
    const profiled={migration:{...prepared.migration,job:currentJob},plan:{...prepared.plan,
      historicalLogins:{...prepared.plan.historicalLogins,version:2,...selectedProfile,target:profileTarget}}};
    phase='actual-child-profiled-interrupted-fresh-read-only-session';
    await proveProfiledInterruptedFrontend({admin,profiled,plan,nativePlan,job,owner,profileTarget,selectedProfile,deps,
      uncertainId,replayId,evidence,originalProbe,producerSha256,roleOid:roles.cert_runtime,journal});
    checks.push('actual-profiled-interrupted-fresh-locks-specific-settlement-and-independent-closure');
    await admin.query('DELETE FROM frontend_admission.operations WHERE id=ANY($1::uuid[])',[[uncertainId,replayId]]);
    await admin.query('UPDATE frontend_admission.control SET epoch=1,new_work=false,recovery=false');
    await admin.query('UPDATE frontend_admission.control SET new_work=true,recovery=true,epoch=2');
    assert.equal((await observeP2CertificationPhysical({...sourceProbe,operation:'fence'},deps)).frontendAdmissionClosed,true);
    assert.deepEqual((await admin.query('SELECT new_work,recovery FROM frontend_admission.control')).rows,[{new_work:false,recovery:false}]);
    checks.push('independent-fence-after-parent-session-loss-and-without-native-credential');
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
      await assert.rejects(observeP2CertificationPhysical({...probe,operation:'verify-closed'},deps,profile));
      await assert.rejects(observeP2CertificationPhysical({...probe,marker:'f'.repeat(64),operation:'observe'},deps,profile));
      await assert.rejects(containP2ProfiledCertificationAdmission(probe,deps),error=>error.checkpoint==='guard-physical-lock');
      return probe;
    },profile);
    const lateProof=await observeP2CertificationPhysical({...guardProbe,operation:'verify-closed'},deps,profile);
    assert.equal(lateProof.status,'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED');
    assert.equal(lateProof.backendPid,guardProbe.backendPid);
    assert.equal(lateProof.backendStart,guardProbe.backendStart);
    assert.equal(lateProof.backendAbsent&&lateProof.migrationLockReleased&&lateProof.nonceLockReleased,true);
    assert.deepEqual(lateProof.admission,{epoch:'3',newWork:false,recovery:false,active:0,uncertain:0});
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
    phase='actual-child-scoped-certification-epochs';
    const scoped={...profiledPlan,mode:'export-cleanup',startState:'already-closed',initialEpoch:'5',
      nativePlan:{...profiledPlan.nativePlan,purpose:'scoped-certification-control-only',initialEpoch:'5',commandWitnesses:[]}};
    await withP2CertificationFrontendSession(profiled,scoped,deps,async({client,verify,probe})=>{
      const policy={environment:'staging',targetSha256};
      const witness=()=>observeP2CertificationPhysical({...probe,operation:'witness'},deps,profile);
      const change=async(epoch,flags)=>{
        await client.query('SET ROLE cert_owner');
        try{return await changeFrontendAdmission(client,policy,epoch,flags);}
        finally{await client.query('RESET ROLE');}
      };
      assert.deepEqual((await witness()).admission,{epoch:'5',newWork:false,recovery:false,active:0,uncertain:0});
      assert.equal((await change('5',{newWork:false,recovery:true})).epoch,'6');
      assert.deepEqual((await witness()).admission,{epoch:'6',newWork:false,recovery:true,active:0,uncertain:0});
      const operationId=randomUUID();
      await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state,completed_at)
        VALUES($1,$2,$3,$4,6,'recovery','completed',pg_catalog.clock_timestamp())`,[operationId,producerSha256,sourceCommit,roles.cert_runtime]);
      assert.equal((await change('6',{newWork:false,recovery:false})).epoch,'7');
      const joined=await witness();
      assert.deepEqual(joined.admission,{epoch:'7',newWork:false,recovery:false,active:0,uncertain:0});
      assert.deepEqual(joined.witness.operations.map(row=>row.id),[operationId]);
      assert.match(JSON.parse(JSON.stringify(joined)).witness.operations[0].completed_at,/^\d{4}-\d{2}-\d{2}T/u);
      await verify();
    },profile);
    for(const mode of ['mux-callback-recovery','lifecycle-persistence']){
      const closed={...scoped,mode,initialEpoch:'7',nativePlan:{...scoped.nativePlan,initialEpoch:'7'}};
      await withP2CertificationFrontendSession(profiled,closed,deps,async({client,verify})=>{
        const read=()=>readP2CertificationCurrent(client,profiled,closed,verify,false,profile);
        assert.deepEqual((await read()).admission,{epoch:'7',newWork:false,recovery:false,active:0,uncertain:0});
        await admin.query('UPDATE frontend_admission.control SET epoch=8,recovery=true');
        await assert.rejects(read(),{checkpoint:'current-admission-state'});
        await admin.query('UPDATE frontend_admission.control SET epoch=7,recovery=false');
      },profile);
    }
    checks.push('actual-profiled-scoped-export-ledger-and-read-only-epoch-fences');
    phase='actual-child-interactive-producer-swap';
    await proveInteractiveProducerSwap({admin,profiled,scoped,deps,url,targetSha256,sourceCommit,producerSha256,roleOid:roles.cert_runtime});
    checks.push('actual-interactive-producer-swap-same-role-denial-drain-and-independent-fence-recovery');
    checks.push('actual-interactive-physical-window-witness-and-independent-closure');
    checks.push('actual-composed-lifecycle-preference-and-clean-fences','actual-composed-browser-loss-and-ledger-uncertainty');
    checks.push('actual-composed-owner-identity-held-mapping-and-clean-fences');
    assert.equal(hash((await admin.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows),journal);
    return{version:1,status:'P2_CERTIFICATION_CURRENT_OWNED_PASS',serverMajor:input.major,frontendMigrations:83,checks,skipped:0,actualTlsPostgres:true,noSqlReplay:true,providerTouched:false,
      actualHostDocker:false,browserQualified:false,nativeInvocationQualified:false,fixtureOnly:true};
  }finally{await admin.end();}
}

async function proveInteractiveProducerSwap({admin,profiled,scoped,deps,url,targetSha256,sourceCommit,producerSha256,roleOid}){
  const policy={environment:'staging',targetSha256,runtimeRole:'cert_runtime'};
  const producer=producerSha256=>({producerSha256,role:{name:'cert_runtime',oid:roleOid}});
  const interactiveSha256=createHash('sha256').update(`lash-her:p2q:interactive-producer:v1\n${sourceCommit}\n${targetSha256}`).digest('hex');
  const runtimeProducer=producer(producerSha256),secondary=producer('d'.repeat(64)),interactive=producer(interactiveSha256),unexpected='f'.repeat(64);
  const ordinaryProducers=[runtimeProducer,secondary];
  const reviewed={sourceCommit,ordinaryProducers,runtimeProducer,interactiveProducer:interactive};
  await admin.query('INSERT INTO frontend_admission.producers VALUES($1,$3,$4,true),($2,$3,$4,false)',
    [secondary.producerSha256,unexpected,sourceCommit,roleOid]);
  const current={...profiled,plan:{...profiled.plan,producers:ordinaryProducers}};
  const {releaseId,phase2ContractManifestSha256}=profiled.migration.job;
  const actionPlan=(initialEpoch,certificationActionId)=>({...scoped,mode:'interactive-browser',environment:'staging',contractPhase:'p2',
    operatorSourceCommit:sourceCommit,originalReleaseId:releaseId,phase2ContractManifestSha256,certificationActionId,initialEpoch,
    nativePlan:{...scoped.nativePlan,initialEpoch,actionId:releaseId,phase2ContractManifestSha256,sourceCommit,targetSha256,producer:runtimeProducer}});
  const runtimeUrl=new URL(url);runtimeUrl.username='cert_runtime';
  const runtime=new Client({connectionString:runtimeUrl.href,ssl:{rejectUnauthorized:true}});
  const peer=new Client({connectionString:runtimeUrl.href,ssl:{rejectUnauthorized:true}});
  const actual=async()=>({
    control:(await admin.query('SELECT epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows[0],
    enabled:(await admin.query('SELECT producer_sha256 FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256')).rows.map(row=>row.producer_sha256),
  });
  const withOwner=async(client,work)=>{
    await client.query('SET ROLE cert_owner');
    try{return await work();}
    finally{await client.query('RESET ROLE');}
  };
  const run=(connection,selected,kind,epoch,id,work)=>runFrontendWriterOperation(connection,policy,
    {id,kind,epoch,producerSha256:selected,sourceSha:sourceCommit},work);
  const witness=probe=>observeP2CertificationPhysical({...probe,operation:'witness'},deps,profile);
  const verifyClosed=probe=>observeP2CertificationPhysical({...probe,operation:'verify-closed'},deps,profile);
  const activeId=randomUUID(),uncertainId=randomUUID(),evidence='a'.repeat(64);
  try{
    await runtime.connect();await peer.connect();
    const initial=actionPlan('7','interactive-first');
    const rejectedProbe=await withP2CertificationFrontendSession(current,initial,deps,async({client,verify,probe,receipt})=>{
      const heldOwner=async(work)=>{
        await verify();
        try{return await withOwner(client,work);}
        finally{await verify();}
      };
      const open=epoch=>heldOwner(()=>openFrontendInteractiveAdmission(client,policy,epoch,reviewed));
      const close=epoch=>heldOwner(()=>closeFrontendInteractiveAdmission(client,policy,epoch,reviewed));
      const prepare=(epoch,selection=reviewed)=>heldOwner(()=>prepareFrontendInteractiveProducer(client,policy,epoch,selection));
      const denied=(connection,selected,kind,epoch)=>assert.rejects(
        run(connection,selected,kind,epoch,randomUUID(),()=>assert.fail('denied producer reached an effect')),
        {message:'FRONTEND_ADMISSION_REFUSED'});
      const starting=await actual();
      assert.deepEqual(receipt.admission,{epoch:'7',newWork:false,recovery:false,active:0,uncertain:0});
      assert.deepEqual((await witness(probe)).witness.operations,[]);
      const registration={epoch:'7',newWork:false,recovery:false,producerSha256:interactiveSha256};
      const readRegistered=async()=>(await admin.query('SELECT source_sha,database_role::text AS role_oid,enabled FROM frontend_admission.producers WHERE producer_sha256=$1',
        [interactiveSha256])).rows;
      assert.deepEqual(await readRegistered(),[]);
      await assert.rejects(open('7'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
      await assert.rejects(prepare('7',{...reviewed,interactiveProducer:producer(unexpected)}),{message:'FRONTEND_ADMISSION_REFUSED'});
      assert.deepEqual(await prepare('7'),{...registration,registered:true});
      assert.deepEqual(await prepare('7'),{...registration,registered:false});
      const selectedRow={source_sha:sourceCommit,role_oid:roleOid,enabled:false};
      assert.deepEqual(await readRegistered(),[selectedRow]);
      for(const [change,repair] of [
        ["source_sha=repeat('a',40)",`source_sha='${sourceCommit}'`],
        ["database_role='cert_owner'::regrole::oid",`database_role=${roleOid}::oid`],
        ['enabled=true','enabled=false'],
      ]){
        const alter=assignment=>admin.query(`UPDATE frontend_admission.producers SET ${assignment} WHERE producer_sha256=$1`,[interactiveSha256]);
        await alter(change);
        const changed=await readRegistered();
        try{
          await assert.rejects(prepare('7'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
          await assert.rejects(witness(probe),{checkpoint:'current-interactive-producers'});
          assert.deepEqual(await readRegistered(),changed);
        }finally{await alter(repair);}
      }
      assert.deepEqual(await readRegistered(),[selectedRow]);
      await admin.query('UPDATE frontend_admission.producers SET enabled=true WHERE producer_sha256=$1',[unexpected]);
      try{await assert.rejects(open('7'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});}
      finally{await admin.query('UPDATE frontend_admission.producers SET enabled=false WHERE producer_sha256=$1',[unexpected]);}
      await admin.query('BEGIN');
      try{
        await admin.query('LOCK TABLE frontend_admission.producers IN ROW EXCLUSIVE MODE');
        await assert.rejects(open('7'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
      }finally{await admin.query('ROLLBACK');}
      assert.deepEqual(await actual(),starting);
      assert.deepEqual(await open('7'),{epoch:'8',newWork:true,recovery:true});
      assert.deepEqual(await actual(),{control:{epoch:'8',new_work:true,recovery:true},enabled:[interactive.producerSha256]});
      assert.deepEqual((await witness(probe)).admission,{epoch:'8',newWork:true,recovery:true,active:0,uncertain:0});
      await assert.rejects(prepare('8'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
      for(const entry of ordinaryProducers)for(const kind of ['new-work','recovery']){
        await denied(peer,entry.producerSha256,kind,'8');
      }
      await denied(peer,interactive.producerSha256,'new-work','7');
      await admin.query('UPDATE frontend_admission.producers SET enabled=true WHERE producer_sha256=$1',[unexpected]);
      try{await assert.rejects(witness(probe),{checkpoint:'current-interactive-producers'});}
      finally{await admin.query('UPDATE frontend_admission.producers SET enabled=false WHERE producer_sha256=$1',[unexpected]);}
      for(const [selected,source,role,epoch] of [
        [producerSha256,sourceCommit,roleOid,'8'],
        [interactiveSha256,'a'.repeat(40),roleOid,'8'],
        [interactiveSha256,sourceCommit,profiled.plan.owner.oid,'8'],
        [interactiveSha256,sourceCommit,roleOid,'9'],
      ]){
        const id=randomUUID();
        await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state,completed_at)
          VALUES($1,$2,$3,$4,$5,'recovery','completed',pg_catalog.clock_timestamp())`,[id,selected,source,role,epoch]);
        try{await assert.rejects(witness(probe),{checkpoint:'current-interactive-operations'});}
        finally{await admin.query('DELETE FROM frontend_admission.operations WHERE id=$1',[id]);}
      }
      let entered,finish;
      const started=new Promise(resolve=>{entered=resolve;});
      const stop=new Promise(resolve=>{finish=resolve;});
      const operation=run(runtime,interactive.producerSha256,'new-work','8',activeId,async()=>{entered();await stop;return 'finished';});
      try{
        await Promise.race([started,operation]);
        await assert.rejects(run(peer,interactive.producerSha256,'recovery','8',uncertainId,async()=>{throw Error('owned uncertainty');}),
          {message:'FRONTEND_OPERATION_OUTCOME_REQUIRES_REVIEW'});
        const live=await witness(probe);
        assert.deepEqual(live.admission,{epoch:'8',newWork:true,recovery:true,active:1,uncertain:1});
        assert.deepEqual(live.witness.operations.map(row=>[row.id,row.kind,row.state]),
          [[activeId,'new-work','active'],[uncertainId,'recovery','uncertain']]);
        assert.deepEqual(await close('8'),{epoch:'9',newWork:false,recovery:false,active:1,uncertain:1,ledgerDrained:false});
        assert.deepEqual(await actual(),{control:{epoch:'9',new_work:false,recovery:false},enabled:starting.enabled});
        const closed=await witness(probe);
        assert.deepEqual(closed.admission,{epoch:'9',newWork:false,recovery:false,active:1,uncertain:1});
        assert.deepEqual(closed.witness.operations,live.witness.operations);
        await denied(peer,interactive.producerSha256,'recovery','9');
        await denied(peer,producerSha256,'new-work','9');
        await assert.rejects(open('9'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
        await assert.rejects(prepare('9'),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
      }finally{finish();await operation;}
      assert.equal((await admin.query('SELECT state FROM frontend_admission.operations WHERE id=$1',[activeId])).rows[0].state,'completed');
      return probe;
    },profile);
    await assert.rejects(verifyClosed(rejectedProbe),{checkpoint:'current-admission-closure'});
    await withOwner(admin,()=>reconcileFrontendOperation(admin,policy,'9',uncertainId,evidence));
    await assert.rejects(verifyClosed(rejectedProbe),{checkpoint:'current-admission-closure'});

    const cleanProbe=await withP2CertificationFrontendSession(current,actionPlan('9','interactive-clean'),deps,async({client,probe})=>{
      assert.equal((await withOwner(client,()=>openFrontendInteractiveAdmission(client,policy,'9',reviewed))).epoch,'10');
      const id=randomUUID();
      assert.equal(await run(runtime,interactiveSha256,'recovery','10',id,async()=>true),true);
      assert.deepEqual(await withOwner(client,()=>closeFrontendInteractiveAdmission(client,policy,'10',reviewed)),
        {epoch:'11',newWork:false,recovery:false,active:0,uncertain:0,ledgerDrained:true});
      const closed=await witness(probe);
      assert.deepEqual(closed.admission,{epoch:'11',newWork:false,recovery:false,active:0,uncertain:0});
      assert.deepEqual(closed.witness.operations.map(row=>[row.id,row.kind,row.state]),[[id,'recovery','completed']]);
      await assert.rejects(verifyClosed(probe));
      return probe;
    },profile);
    const final=await verifyClosed(cleanProbe);
    assert.equal(final.status,'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED');
    assert.equal(final.admission.epoch,'11');
    assert.equal(final.backendAbsent&&final.migrationLockReleased&&final.nonceLockReleased,true);

    const interruptedProbe=await withP2CertificationFrontendSession(current,actionPlan('11','interactive-interrupted'),deps,async({client,probe})=>{
      assert.equal((await withOwner(client,()=>openFrontendInteractiveAdmission(client,policy,'11',reviewed))).epoch,'12');
      await assert.rejects(containP2ProfiledCertificationAdmission(probe,deps),{checkpoint:'guard-physical-lock'});
      return probe;
    },profile);
    const fenced=await containP2ProfiledCertificationAdmission(interruptedProbe,deps);
    assert.equal(fenced.epoch,'13');
    assert.equal(fenced.frontendAdmissionClosed&&fenced.admissionChanged,true);
    assert.deepEqual(await actual(),{control:{epoch:'13',new_work:false,recovery:false},enabled:[interactiveSha256]});
    await assert.rejects(verifyClosed(interruptedProbe),{checkpoint:'current-interactive-producers'});
    assert.equal((await containP2ProfiledCertificationAdmission(interruptedProbe,deps)).admissionChanged,false);
    await admin.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))',['lash-her:private-db:migrations']);
    try{
      await withOwner(admin,async()=>{
        await assert.rejects(closeFrontendInteractiveAdmission(admin,policy,'12',reviewed),{message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
        assert.deepEqual(await restoreFencedFrontendInteractiveProducers(admin,policy,'13',reviewed),
          {epoch:'14',newWork:false,recovery:false,active:0,uncertain:0,ledgerDrained:true});
        await assert.rejects(restoreFencedFrontendInteractiveProducers(admin,policy,'14',reviewed),
          {message:'FRONTEND_ADMISSION_FAILED_REVIEW_REQUIRED'});
      });
    }finally{await admin.query('SELECT pg_catalog.pg_advisory_unlock_all()');}
    assert.deepEqual(await actual(),{control:{epoch:'14',new_work:false,recovery:false},enabled:ordinaryProducers.map(row=>row.producerSha256)});

    const actorId=randomUUID(),subject='owned-identity-subject',challenge='b'.repeat(64);
    await admin.query(`INSERT INTO public.admin_users(id,provider_user_id,email,email_normalized,role)
      VALUES($1,$2,'owned-identity-owner@example.invalid','owned-identity-owner@example.invalid','owner')`,[actorId,subject]);
    const identity={...actionPlan('14','owned-composed-identity'),maximumSeconds:300,scopedAction:{stage:'identity',actorId:null,requests:[],
      windowSeconds:60,identityActor:{actorKind:'admin',actorId}}};
    const identityProbe=await withP2CertificationFrontendSession(current,identity,deps,async({client,verify,probe})=>{
      const stage={
        async prepare(){return{status:'P2_INTERACTIVE_IDENTITY_PREPARED'};},
        async open(){return{status:'P2_INTERACTIVE_IDENTITY_OPENED'};},
        async installPermit(){return{context:'owner',epoch:'15',stage:'identity'};},
        async fence(){assert.equal((await witness(probe)).admission.epoch,'15');return{status:'P2_INTERACTIVE_IDENTITY_FENCED'};},
        async retain({browserIdentity,identityWitness}){
          assert.deepEqual(browserIdentity,{actorKind:'admin',actorId,sessionVerified:true});
          assert.deepEqual(identityWitness,{actorKind:'admin',actorId,actorActive:true,ownerMappingVerified:true});
          const retained=await witness(probe);
          assert.deepEqual(retained.admission,{epoch:'16',newWork:false,recovery:false,active:0,uncertain:0});
          assert.deepEqual(retained.witness.operations.map(row=>[row.kind,row.state]),[['new-work','completed']]);
          return{status:'P2_INTERACTIVE_IDENTITY_JOINED'};
        },
      };
      const controller={
        async open(context){assert.equal(context,'owner');},
        async captureIdentity(context,digest){
          assert.equal(context,'owner');
          assert.equal(digest,createHash('sha256').update(JSON.stringify(['p2q-interactive-owner-v1',challenge,actorId,subject])).digest('hex'));
          await run(runtime,interactiveSha256,'new-work','15',randomUUID(),async()=>{});
          return{actorKind:'admin',actorId,sessionVerified:true};
        },
        async close(){assert.fail('successful identity keeps its authenticated context');},
      };
      const joined=await runP2InteractiveFrontendCase(identity,{stage,controller,client,controllerChallenge:challenge,
        withOwner:work=>withOwner(client,work),verifyEnvironment:deps.verifyEnvironment,verifySession:verify,
        target:current.migration.job.target,ordinaryProducers});
      assert.equal(joined.status,'P2_INTERACTIVE_IDENTITY_JOINED');
      return probe;
    },profile);
    assert.equal((await verifyClosed(identityProbe)).admission.epoch,'16');

    const customerId=randomUUID();
    await admin.query("INSERT INTO public.customer_users(id,email) VALUES($1,'owned-interactive-coordinator@example.invalid')",[customerId]);
    await admin.query("INSERT INTO public.customer_sessions(token_hash,user_id,expires) VALUES($1,$2,pg_catalog.clock_timestamp()+interval '1 hour')",
      [randomUUID(),customerId]);
    for(const [epoch,operation,scenario] of [
      ['16','preferences-on','success'],['18','preferences-off','browser-loss'],['20','preferences-on','uncertain-write'],
    ]){
      const plan={...actionPlan(epoch,'owned-composed-'+scenario),maximumSeconds:300,scopedAction:{
        stage:'lifecycle',actorId:customerId,requests:[],windowSeconds:60,frontendAction:{actorKind:'customer',userId:customerId,operation}}};
      const opened=(BigInt(epoch)+1n).toString(),closed=(BigInt(epoch)+2n).toString(),events=[],records={};
      const completedProbe=await withP2CertificationFrontendSession(current,plan,deps,async({client,verify,probe})=>{
        let recovery,releaseRecovery;
        const stage={
          async prepare(){events.push('prepare');return{status:'P2_INTERACTIVE_LIFECYCLE_PREPARED'};},
          async open(){events.push('gateway-open');assert.equal((await witness(probe)).admission.epoch,epoch);return{status:'P2_INTERACTIVE_LIFECYCLE_OPENED'};},
          async installPermit(){events.push('permit');assert.equal((await witness(probe)).admission.epoch,opened);
            return{context:'learner',epoch:opened,stage:'lifecycle'};},
          async fence(){events.push('gateway-fence');assert.equal((await witness(probe)).admission.epoch,opened);
            return{status:'P2_INTERACTIVE_LIFECYCLE_FENCED'};},
          async retain({browserResponse,lifecycleWitness}){
            events.push('retain');assert.equal((await witness(probe)).admission.epoch,closed);
            assert.equal(browserResponse.requestId,lifecycleWitness.requestId);
            assert.equal(lifecycleWitness.learningUpdates,true);
            return{status:'P2_INTERACTIVE_LIFECYCLE_JOINED'};
          },
        };
        const controller={
          async open(context){events.push('browser-open');assert.equal(context,'learner');},
          async captureLifecycleResponse(context){
            events.push('browser-capture');assert.equal(context,'learner');
            if(scenario==='success'){
              let admitted;
              const started=new Promise(resolve=>{admitted=resolve;});
              const stopped=new Promise(resolve=>{releaseRecovery=resolve;});
              recovery=run(peer,interactiveSha256,'recovery',opened,randomUUID(),async()=>{admitted();await stopped;});
              await Promise.race([started,recovery]);
            }
            await run(runtime,interactiveSha256,'new-work',opened,randomUUID(),async()=>{
              await runtime.query(`INSERT INTO public.customer_account_preferences(user_id,learning_updates) VALUES($1,$2)
                ON CONFLICT(user_id) DO UPDATE SET learning_updates=excluded.learning_updates`,[customerId,operation==='preferences-on']);
              if(scenario==='uncertain-write')throw new Error('owned uncertain result after commit');
            });
            if(scenario==='browser-loss')throw new Error('OWNED_BROWSER_RESPONSE_LOST');
            return{method:'POST',pathname:'/api/account/preferences',status:200,requestId:randomUUID(),body:{saved:true}};
          },
          async close(){events.push('browser-close');},
        };
        const execution=runP2InteractiveFrontendCase(plan,{stage,controller,client,
          withOwner:work=>withOwner(client,work),verifyEnvironment:deps.verifyEnvironment,verifySession:verify,
          target:current.migration.job.target,ordinaryProducers,record:(name,receipt)=>{
            records[name]=receipt;
            if(name==='p2-interactive-lifecycle-frontend-closed.json')releaseRecovery?.();
          }});
        try{
          if(scenario==='success')assert.equal((await execution).status,'P2_INTERACTIVE_LIFECYCLE_JOINED');
          else await assert.rejects(execution,{message:scenario==='browser-loss'?'OWNED_BROWSER_RESPONSE_LOST':'P2_INTERACTIVE_LIFECYCLE_CLOSURE_REQUIRES_REVIEW'});
        }finally{releaseRecovery?.();await recovery;}
        const actualClosed=await witness(probe);
        assert.deepEqual(actualClosed.admission,{epoch:closed,newWork:false,recovery:false,active:0,uncertain:scenario==='uncertain-write'?1:0});
        assert.equal(actualClosed.witness.operations.length,scenario==='success'?2:1);
        assert.ok(actualClosed.witness.operations.every(row=>row.state===(scenario==='uncertain-write'?'uncertain':'completed')));
        assert.equal((await admin.query('SELECT learning_updates FROM public.customer_account_preferences WHERE user_id=$1',[customerId])).rows[0].learning_updates,operation==='preferences-on');
        assert.equal(records['p2-interactive-lifecycle-frontend-closed.json'].ledgerDrained,scenario==='browser-loss');
        if(scenario==='success')assert.equal(records['p2-interactive-lifecycle-frontend-drained.json'].ledgerDrained,true);
        assert.deepEqual(events,['prepare','gateway-open','permit','browser-open','browser-capture','gateway-fence',
          scenario==='success'?'retain':'browser-close']);
        return probe;
      },profile);
      if(scenario==='uncertain-write')await assert.rejects(verifyClosed(completedProbe),{checkpoint:'current-admission-closure'});
      else assert.equal((await verifyClosed(completedProbe)).admission.epoch,closed);
    }
  }finally{await Promise.all([runtime.end(),peer.end()]);}
}

async function proveProfiledInterruptedFrontend({admin,profiled,plan,nativePlan,job,owner,profileTarget,selectedProfile,deps,
  uncertainId,replayId,evidence,originalProbe,producerSha256,roleOid,journal}){
  const commandId=randomUUID(),userId=randomUUID(),issuedAt=new Date().toISOString();
  const command={version:1,commandId,userId,accountVersion:1,action:'suspend',issuedAt};
  await admin.query("INSERT INTO public.customer_users(id,email,status,account_version) VALUES($1,'owned-profiled-c@example.invalid','suspended',1)",[userId]);
  await admin.query(`INSERT INTO public.customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command)
    VALUES($1,$2,1,$3,'suspend',$4,$5)`,[commandId,userId,randomUUID(),issuedAt,command]);
  await admin.query(`INSERT INTO public.customer_account_deliveries(command_id,receiver,status,attempts,acknowledged_at)
    VALUES($1,'course','acknowledged',2,$2),($1,'community','acknowledged',1,$2)`,[commandId,issuedAt]);
  const original={...nativePlan,version:2,...selectedProfile,owner,target:profileTarget,targetSha256:plan.targetSha256,
    sourceCommit:job.sourceCommit,actionId:job.releaseId,phase2ContractManifestSha256:job.phase2ContractManifestSha256,
    planSha256:'9'.repeat(64),commandWitnesses:[{commandId,accountVersion:'1',action:'suspend'}]};
  const interrupted={...plan,version:2,...selectedProfile,mode:'p2-profiled-known-ack-interrupted-restoration',environment:'staging',
    certificationActionId:'owned-fresh-c',originalCertificationActionId:plan.certificationActionId,originalReleaseId:job.releaseId,
    initialEpoch:'4',contractPhase:'p2',phase2ContractManifestSha256:job.phase2ContractManifestSha256,nativePlan:original,
    operationId:uncertainId,reconciliationSha256:evidence,configurationCanonicalSha256:'8'.repeat(64),planSha256:'7'.repeat(64)};
  const forbidden={...deps,getUrl:()=>assert.fail('credential requested for the wrong source context')};
  const refused=({checkpoint})=>['current-source-context','current-interrupted-plan'].includes(checkpoint);
  await assert.rejects(withP2CertificationFrontendSession(profiled,interrupted,forbidden,()=>assert.fail(),profile),refused);
  await assert.rejects(withP2ProfiledInterruptedFrontendSession(profiled,{...interrupted,mode:'native-window'},forbidden,()=>assert.fail()),refused);
  await assert.rejects(withP2ProfiledInterruptedFrontendSession(profiled,{...interrupted,certificationActionId:plan.certificationActionId},
    forbidden,()=>assert.fail()),refused);
  await assert.rejects(withP2ProfiledInterruptedFrontendSession(profiled,{...interrupted,reconciliationSha256:'a'.repeat(64)},deps,()=>assert.fail()),
    error=>error.checkpoint==='current-interrupted-settlement');
  let retainedRead;
  const probe=await withP2ProfiledInterruptedFrontendSession(profiled,interrupted,deps,async context=>{
    assert.deepEqual(Object.keys(context).sort(),['probe','readCurrent','receipt','verify']);
    const {probe,receipt,verify,readCurrent}=context;
    retainedRead=readCurrent;
    assert.notEqual(probe.marker,originalProbe.marker);
    assert.notDeepEqual([probe.backendPid,probe.backendStart],[originalProbe.backendPid,originalProbe.backendStart]);
    assert.equal(receipt.status,'P2_CERTIFICATION_DATABASE_CURRENT');
    assert.equal(receipt.certificationActionId,interrupted.certificationActionId);
    assert.deepEqual(receipt.qualificationTargetProfile,profile);
    assert.equal(receipt.journalSha256,journal);
    assert.deepEqual(receipt.admission,{epoch:'4',newWork:false,recovery:false,active:0,uncertain:0});
    assert.equal(receipt.witness.operations.find(row=>row.id===uncertainId).reconciliation_sha256,evidence);
    assert.equal(receipt.witness.operations.find(row=>row.id===replayId).reconciliation_sha256,null);
    for(const key of ['lash-her:private-db:migrations',probe.marker])
      assert.equal((await admin.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',[key])).rows[0].held,false);
    const observe=operation=>observeP2ProfiledInterruptedFrontendPhysical({...probe,operation},deps);
    assert.equal((await observe('verify-schema')).witnessSha256,receipt.witnessSha256);
    assert.equal((await observe('witness')).witness.operations.length,2);
    await assert.rejects(observe('verify-closed'));
    await assert.rejects(observe('fence'));
    await assert.rejects(observeP2CertificationPhysical({...probe,operation:'observe'},forbidden,profile),refused);
    await assert.rejects(containP2ProfiledCertificationAdmission(probe,forbidden),refused);

    await admin.query('UPDATE frontend_admission.operations SET reconciliation_sha256=$1 WHERE id=$2',['a'.repeat(64),uncertainId]);
    await assert.rejects(readCurrent(),error=>error.checkpoint==='current-interrupted-settlement');
    await admin.query('UPDATE frontend_admission.operations SET reconciliation_sha256=$1 WHERE id=$2',[evidence,uncertainId]);
    await admin.query("UPDATE frontend_admission.operations SET completed_at=completed_at+interval '1 second' WHERE id=$1",[replayId]);
    await assert.rejects(observe('observe'),error=>error.checkpoint==='current-interrupted-witness-changed');
    await admin.query("UPDATE frontend_admission.operations SET completed_at=completed_at-interval '1 second' WHERE id=$1",[replayId]);
    const foreign=randomUUID();
    await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state)
      VALUES($1,$2,$3,$4,1,'recovery','active')`,[foreign,producerSha256,job.sourceCommit,roleOid]);
    await assert.rejects(observe('observe'),error=>error.checkpoint==='current-interrupted-closed');
    await admin.query('DELETE FROM frontend_admission.operations WHERE id=$1',[foreign]);
    await admin.query("UPDATE public.customer_account_deliveries SET lease_id=$1 WHERE command_id=$2 AND receiver='course'",[randomUUID(),commandId]);
    await assert.rejects(readCurrent(),error=>error.checkpoint==='current-interrupted-deliveries');
    await admin.query('UPDATE public.customer_account_deliveries SET lease_id=NULL WHERE command_id=$1',[commandId]);
    await verify();assert.equal((await readCurrent()).witnessSha256,receipt.witnessSha256);
    return probe;
  });
  await assert.rejects(retainedRead(),error=>error.checkpoint==='current-interrupted-session-closed');
  await assert.rejects(observeP2ProfiledInterruptedFrontendPhysical({...probe,operation:'observe'},deps));
  const close=()=>observeP2ProfiledInterruptedFrontendPhysical({...probe,operation:'verify-closed'},deps);
  const held=(await admin.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',[probe.marker])).rows[0].held;
  assert.equal(held,true);
  try{await assert.rejects(close());}
  finally{await admin.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))',[probe.marker]);}
  await admin.query('UPDATE frontend_admission.operations SET reconciliation_sha256=$1 WHERE id=$2',['a'.repeat(64),uncertainId]);
  try{await assert.rejects(close(),error=>error.checkpoint==='current-interrupted-settlement');}
  finally{await admin.query('UPDATE frontend_admission.operations SET reconciliation_sha256=$1 WHERE id=$2',[evidence,uncertainId]);}
  const late=await close();
  assert.equal(late.status,'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED');
  assert.equal(late.backendAbsent&&late.migrationLockReleased&&late.nonceLockReleased,true);
  assert.equal(late.witnessSha256,probe.receipt.witnessSha256);
  assert.equal(late.journalSha256,journal);
  const env=Object.fromEntries(['PATH','HOME','LANG','TMPDIR','NODE_EXTRA_CA_CERTS'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
  const fixed=new URL('./p2-certification-current-probe.mjs',import.meta.url).pathname;
  const child=spawnSync(process.execPath,['--experimental-strip-types',fixed,'--profiled-known-ack-interrupted'],{encoding:'utf8',timeout:20_000,
    input:JSON.stringify({...probe,operation:'verify-closed'}),env:{...env,FRONTEND_STAGING_MIGRATION_DATABASE_URL:deps.getUrl()}});
  assert.equal(child.status,0);
  assert.deepEqual(JSON.parse(child.stdout),late);
  // The source command has an immutable trigger. The outer fixture disposes
  // this entire cluster after verification, preserving the command until then.
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
