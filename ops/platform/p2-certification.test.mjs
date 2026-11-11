import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,realpathSync,chmodSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeDocuments} from './harness/p2-native-unit-fixture.mjs';
import {frontendCoordinationHash as hash} from './frontend-release-inventory.mjs';
import {prepareP2BoundedCertification,P2_CERTIFICATION_READY_FILES,deriveP2CertificationNativePlan,bindP2CertificationReadyReceipts,
  p2CertificationReviewView,requireP2GuardedReceiverContracts,runP2CertificationEnvironmentLockWithFirstOwnerHandoff} from './p2-certification.mjs';
import {p2NativeHash} from './p2-lifecycle-native.mjs';
import {readKnownAckRuntimeDatabaseUrl} from './p2-known-ack-loss-probe.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile} from './qualification-target-profile.mjs';
import {phase2ContractManifestBinding} from './release.mjs';
import {frontendReleaseReceiptStore} from './frontend-release-receipts.mjs';
import {P2_FIRST_OWNER_SELECTION_HANDOFF,readP2FirstOwnerSelectionHandoff} from './p2-first-owner-identity.mjs';

test('first-owner handoff waits for environment-lock transport commit and final verification',async()=>{
  const firstOwner={nonce:'9'.repeat(32),identitySha256:'6'.repeat(64)};
  for(const failAfterHostFinish of [true,false]){
    const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-first-owner-finalize-')));chmodSync(directory,0o700);
    try{
      const store=frontendReleaseReceiptStore(directory),handoff=join(directory,P2_FIRST_OWNER_SELECTION_HANDOFF);
      let hostFinished=false,transportFinalized=false;
      const host={async finish(){await Promise.resolve();hostFinished=true;}};
      const environmentLock=async callback=>{
        const outcome=await callback();
        // The callback and host finish have succeeded. Transport commit,
        // final verification and cleanup still have to complete.
        if(failAfterHostFinish)throw new Error('owned-transport-final-verification');
        transportFinalized=true;
        return outcome;
      };
      const run=retain=>environmentLock(async()=>{
        retain(firstOwner);await host.finish();
        return {status:'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED'};
      });
      const execute=()=>runP2CertificationEnvironmentLockWithFirstOwnerHandoff(run,
        (name,value)=>store.record(name,value),true);
      if(failAfterHostFinish)await assert.rejects(execute(),/owned-transport-final-verification/u);
      else assert.deepEqual(await execute(),{status:'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED'});
      assert.equal(hostFinished,true);assert.equal(transportFinalized,!failAfterHostFinish);
      if(failAfterHostFinish){
        assert.equal(existsSync(handoff),false);assert.equal(readP2FirstOwnerSelectionHandoff(handoff),null);
      }else{
        assert.deepEqual(readP2FirstOwnerSelectionHandoff(handoff),firstOwner);
        await assert.rejects(execute());
        assert.deepEqual(readP2FirstOwnerSelectionHandoff(handoff),firstOwner);
      }
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});

test('guarded receiver qualification requires both exact sources and complete request schemas',()=>{
  const manifest=phase2ContractManifestBinding(undefined,{requireReleased:true});
  const services=['course','community'];
  const candidate={phase2ContractManifestSha256:manifest.phase2ContractManifestSha256,
    sources:Object.fromEntries(services.map(service=>[service,{commit:manifest.phase2ContractRevisions[service]}]))};
  const refused={message:'P2_CERTIFICATION_GUARDED_RECEIVER_CONTRACT_REQUIRED'};
  requireP2GuardedReceiverContracts(profile,candidate,manifest);
  assert.throws(()=>requireP2GuardedReceiverContracts(null,candidate,manifest),refused);
  assert.throws(()=>requireP2GuardedReceiverContracts(profile,{...candidate,phase2ContractManifestSha256:'sha256:'+'1'.repeat(64)},manifest),refused);
  for(const service of services){
    const foreign={...candidate,sources:{...candidate.sources,[service]:{commit:'1'.repeat(40)}}};
    assert.throws(()=>requireP2GuardedReceiverContracts(profile,foreign,manifest),refused);
    for(const mutate of [
      schema=>{schema.anyOf.push({type:'object'});},
      schema=>{delete schema.anyOf[1].required;},
      schema=>{delete schema.anyOf[1].properties.command.required;},
      schema=>{delete schema.anyOf[1].properties.expectedHead.properties.canonicalSha256.pattern;},
      schema=>{delete schema.anyOf[1].properties.command.properties.accountVersion.maximum;},
    ]){
      assert.throws(()=>requireP2GuardedReceiverContracts(profile,candidate,manifest,selected=>{
        const document=JSON.parse(readFileSync(new URL(`../../contracts/api-integration/p2-candidate/${selected}-api.json`,import.meta.url)));
        const schema=document.paths['/v1/internal/accounts/commands'].post.requestBody.content['application/json'].schema;
        if(selected===service)mutate(schema);
        return schema;
      }),refused);
    }
  }
});

function fixture(startState='already-closed',gateway=false){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-certification-plan-')));chmodSync(root,0o700);const receipts=join(root,'ready');mkdirSync(receipts,{mode:0o700});
  const {candidate,settings}=nativeDocuments(),producer=settings.producer;
  if(gateway)candidate.artifacts={gateway:{image:'ghcr.io/princessdardan/lash-her-api-gateway@sha256:'+'8'.repeat(64)}};
  const inventory={actionId:candidate.releaseId,sourceCommit:candidate.sources.frontend.commit,targetSha256:settings.targetSha256,owner:settings.owner,
    producers:[producer],runtimeProducerSha256:producer.producerSha256,certification:{featureControls:settings.featureControls}};
  const job={sourceCommit:candidate.sources.frontend.commit,target:{...settings.target,runtimeRole:producer.role.name}};
  const prepared={migration:{candidate,job},plan:inventory},configuration={'course.env':'1'.repeat(64),'community.env':'2'.repeat(64)};
  const identity={environment:'staging',releaseId:candidate.releaseId,sourceCommit:job.sourceCommit,projectId:candidate.workload.projectId};
  const writerAdmissionBinding={mode:'enforce',targetSha256:settings.targetSha256,producerSha256:producer.producerSha256,sourceCommit:job.sourceCommit,roleName:producer.role.name};
  const hashes={};
  for(const name of P2_CERTIFICATION_READY_FILES){
    const row={...identity,...(name==='frontend-build-started.json'?{}:{deploymentId:settings.deploymentId})};
    if(name==='frontend-build-outcome.json')row.status='FRONTEND_STAGED';
    if(name==='frontend-promotion-outcome.json')row.status='FRONTEND_DOMAINS_PROMOTED';
    if(name==='frontend-workload-outcome.json')Object.assign(row,{status:'FRONTEND_VERIFIED',contractPhase:'p2',phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,featureControls:settings.featureControls,writerAdmissionBinding});
    const raw=Buffer.from(JSON.stringify(row)+'\n');writeFileSync(join(receipts,name),raw,{mode:0o600});hashes[name]=hash(raw);
  }
  settings.configurationRecordSha256=hashes['frontend-workload-outcome.json'];
  const candidateBytes=Buffer.from(JSON.stringify(candidate)+'\n');
  const input={version:1,environment:'staging',certificationActionId:'bounded-certification',operatorSourceCommit:job.sourceCommit,mode:'native-window',startState,initialEpoch:'1',
    candidateSha256:hash(candidateBytes),inventorySha256:hash(inventory),configurationSha256:hash(configuration),native:settings,readyReceiptSha256:hashes};
  Object.assign(input,{runtimeInventorySha256:'3'.repeat(64),gatewayProcessSha256:'4'.repeat(64),gatewayConfigurationSha256:'5'.repeat(64),operatorSourceClosureSha256:'6'.repeat(64)});
  input.requestEvidence={kind:'operator-recorded-request-details',path:join(root,'operator-details.json')};
  return{root,receipts,prepared,input,candidateBytes,configuration,run:()=>prepareP2BoundedCertification(prepared,input,candidateBytes,{frontendReceipts:receipts,configurationSha256:configuration}),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('assessment evidence keeps the exact plan and request digests while omitting reviewed answer values',()=>{
  const assessmentAction={operation:'fail-then-pass',courseId:'course',lessonId:'lesson',grantId:'grant',quizRevision:4,
    failAnswers:[{questionId:'private-fixture-question',optionId:'private-fixture-fail'}],
    passAnswers:[{questionId:'private-fixture-question',optionId:'private-fixture-pass'}]};
  const scopedAction={stage:'lesson-assessment',actorId:'actor',windowSeconds:90,assessmentAction,
    requests:[{method:'POST',target:'/course/v1/student/lessons/lesson/quiz/attempts',bodySha256:'2'.repeat(64),uses:1}]};
  const privatePlan={mode:'interactive-browser',scopedAction};
  const plan={...privatePlan,planSha256:p2NativeHash(privatePlan)};
  const review=p2CertificationReviewView(plan);
  assert.equal(review.planSha256,plan.planSha256);
  assert.deepEqual(review.scopedAction.requests,scopedAction.requests);
  assert.deepEqual(review.scopedAction.assessmentAction,
    {operation:'fail-then-pass',courseId:'course',lessonId:'lesson',grantId:'grant',quizRevision:4,answersRedacted:true});
  assert.doesNotMatch(JSON.stringify(review),/private-fixture|failAnswers|passAnswers/u);
  assert.equal(plan.scopedAction.assessmentAction,assessmentAction);
  const other={mode:'known-ack-recovery',planSha256:'3'.repeat(64)};
  assert.equal(p2CertificationReviewView(other),other);
});

test('native parent preserves original candidate identity and derives only fixed source epochs',()=>{
  for(const startState of ['qualified-ready','already-closed']){
    const f=fixture(startState);try{
      const plan=f.run(),offset=startState==='qualified-ready'?1:0;
      assert.equal(plan.originalReleaseId,f.prepared.migration.candidate.releaseId);assert.notEqual(plan.certificationActionId,plan.originalReleaseId);
      assert.equal(plan.nativePlan.actionId,plan.originalReleaseId);assert.equal(plan.nativePlan.initialEpoch,String(2+offset));
      assert.equal(plan.frontendSqlReplay,false);assert.equal(plan.rolePreparationAllowed,false);assert.equal(plan.buildAllowed,false);assert.equal(plan.promotionAllowed,false);
      assert.equal(deriveP2CertificationNativePlan(plan,{epoch:String(1+offset),newWork:false,recovery:false,active:0,uncertain:0}).planSha256,plan.nativePlan.planSha256);
      for(const change of [{epoch:'9'},{uncertain:1},{active:1},{newWork:true}])assert.throws(()=>deriveP2CertificationNativePlan(plan,{epoch:String(1+offset),newWork:false,recovery:false,active:0,uncertain:0,...change}));
    }finally{f.cleanup();}
  }
});
test('source/raw bytes/config/inventory/producer and reader identity drift cannot qualify the parent',()=>{
  for(const change of [f=>{f.input.candidateSha256='f'.repeat(64);},f=>{f.input.inventorySha256='f'.repeat(64);},f=>{f.input.configurationSha256='f'.repeat(64);},
    f=>{f.input.operatorSourceCommit='f'.repeat(40);},f=>{f.input.native.producer={...f.input.native.producer,producerSha256:'f'.repeat(64)};},
    f=>{f.input.startState='allow-open';},f=>{f.input.certificationActionId=f.prepared.migration.candidate.releaseId;}]){
    const f=fixture();try{change(f);assert.throws(f.run);}finally{f.cleanup();}
  }
});
test('retained READY workload and original P2 identity cannot be substituted behind a hash',()=>{
  const f=fixture();try{const plan=f.run();writeFileSync(join(f.receipts,'frontend-workload-outcome.json'),'{}\n',{mode:0o600});assert.throws(()=>bindP2CertificationReadyReceipts(f.receipts,plan));}finally{f.cleanup();}
});
test('authentication is a fixed300-second separate action and browser control invents no commands',()=>{
  for(const mode of ['auth-preparation','browser-pending']){
    const f=fixture();try{
      Object.assign(f.input,{mode,browserPlanSha256:'7'.repeat(64)});f.input.native.commandWitnesses=[];delete f.input.requestEvidence;
      const plan=f.run();assert.equal(plan.maximumSeconds,mode==='auth-preparation'?300:900);
      assert.deepEqual(plan.nativePlan.commandWitnesses,[]);assert.equal(plan.nativePlan.purpose,'browser-authentication-control-only');
      assert.equal(plan.nativePlan.actionId,f.prepared.migration.candidate.releaseId);assert.equal(plan.browserPlanSha256,'7'.repeat(64));
      assert.throws(()=>deriveP2CertificationNativePlan(plan,{epoch:'1',newWork:false,recovery:false,active:0,uncertain:0}));
      f.input.browserPlanSha256=undefined;assert.throws(f.run);
    }finally{f.cleanup();}
  }
});
test('direct-worker plan is a separate closed-start one-suspension source case with no native enable',()=>{
  const f=fixture();try{
    f.input.mode='direct-worker';delete f.input.requestEvidence;f.input.native.commandWitnesses=[f.input.native.commandWitnesses[0]];
    const candidate=f.prepared.migration.candidate;
    f.input.worker={suspensionPlan:{profile:'normal-ui-suspension-pending-v1',environment:'staging',sourceCommit:candidate.sources.frontend.commit,candidateObjectSha256:p2NativeHash(candidate),
      candidateSha256:hash(f.candidateBytes),targetSha256:f.input.native.targetSha256,configurationRecordSha256:f.input.native.configurationRecordSha256,configurationSha256:p2NativeHash(f.configuration)},
      input:{version:1,actionId:f.input.certificationActionId,commandIndex:0,pendingRecordSha256:'7'.repeat(64),canonicalCommandSha256:'8'.repeat(64),gatewayProcessSha256:f.input.gatewayProcessSha256,gatewayConfigurationSha256:f.input.gatewayConfigurationSha256,denialProgramSha256:'9'.repeat(64)}};
    const plan=f.run();assert.equal(plan.workerPlan.profile,'direct-known-suspension-v1');assert.equal(plan.workerPlan.workerInvocations,1);assert.equal(plan.workerPlan.nativeInvocationQualified,false);
    assert.equal(plan.workerPlanSha256,p2NativeHash(plan.workerPlan));assert.deepEqual(plan.workerPlan.requiredPrivateInputs,['FRONTEND_STAGING_CRON_SECRET','providerContext.frontendRuntimeDatabaseUrl']);
    assert.throws(()=>deriveP2CertificationNativePlan(plan,{epoch:'1',newWork:false,recovery:false,active:0,uncertain:0}));
    f.input.startState='qualified-ready';assert.throws(f.run);
  }finally{f.cleanup();}
});
test('known-ACK replacement is a distinct upfront reviewed one-use intent bound identically by both source languages',()=>{
  const f=fixture('already-closed',true);try{
    f.input.mode='known-ack-recovery';f.input.native.commandWitnesses=[f.input.native.commandWitnesses[0]];
    f.input.fault={stageId:'known-drop-once',receiver:'course',commandIndex:0,commandSha256:'7'.repeat(64)};
    const target={host:'owned-api.invalid',port:5432,database:'owned_database',user:'owned_runtime',serverMajor:18,roleOid:'123'};
    f.input.knownAckRecovery={version:1,recoveryActionId:'reviewed-known-replacement',configurationInputDirectory:'/var/lib/lash-her/releases/staging/owned-input',receiverTargets:{course:{...target},community:{...target}}};
    const plan=f.run(),intent=plan.knownAckRecovery.intent;
    assert.equal(intent.runtimeReplacements,1);assert.equal(intent.ordinaryClosedZeroGate,false);assert.equal(intent.automaticFailureRecoveryAllowed,false);
    assert.equal(intent.sqlReplayAllowed,false);assert.equal(intent.roleChangeAllowed,false);assert.equal(intent.nativePlanSha256,plan.nativePlan.planSha256);
    assert.equal(plan.knownAckRecovery.intentSha256,p2NativeHash(intent));
    const program="import json,sys;sys.path.insert(0,sys.argv[1]);import p2_known_ack_loss as m;v=json.load(sys.stdin);print(json.dumps(m.replacement_intent(v,v['knownAckRecovery']['recoveryActionId'])))";
    const actual=JSON.parse(execFileSync('python3',['-I','-c',program,new URL('./host/',import.meta.url).pathname],{input:JSON.stringify(plan),encoding:'utf8',env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}}));
    assert.deepEqual(actual,intent);
    for(const change of [value=>{value.knownAckRecovery.recoveryActionId=value.certificationActionId;},value=>{value.knownAckRecovery.runtimeReplacements=2;},
      value=>{value.knownAckRecovery.receiverTargets.course.token='caller-selected';},value=>{value.mode='fault-drop-after-ack';}]){
      const saved=structuredClone(f.input);change(f.input);assert.throws(f.run);
      for(const key of Object.keys(f.input))delete f.input[key];Object.assign(f.input,saved);
    }
  }finally{f.cleanup();}
});
test('known-ACK private runtime reader uses the exact production staging credential binding without generic fallback',()=>{
  assert.equal(readKnownAckRuntimeDatabaseUrl({NODE_ENV:'production',DATABASE_TARGET:'staging',STAGING_DATABASE_URL:'owned-synthetic-runtime-url',DATABASE_URL:'unrelated'}),'owned-synthetic-runtime-url');
  for(const value of [{NODE_ENV:'test',DATABASE_TARGET:'staging',STAGING_DATABASE_URL:'owned'},
    {NODE_ENV:'production',DATABASE_TARGET:'production',STAGING_DATABASE_URL:'owned'},
    {NODE_ENV:'production',DATABASE_TARGET:'staging',DATABASE_URL:'generic-must-not-substitute'}])assert.throws(()=>readKnownAckRuntimeDatabaseUrl(value));
});
