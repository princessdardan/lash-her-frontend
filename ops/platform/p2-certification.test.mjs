import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,realpathSync,chmodSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeDocuments} from './harness/p2-native-unit-fixture.mjs';
import {frontendCoordinationHash as hash} from './frontend-release-inventory.mjs';
import {prepareP2BoundedCertification,P2_CERTIFICATION_READY_FILES,deriveP2CertificationNativePlan,bindP2CertificationReadyReceipts} from './p2-certification.mjs';

function fixture(startState='already-closed'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-certification-plan-')));chmodSync(root,0o700);const receipts=join(root,'ready');mkdirSync(receipts,{mode:0o700});
  const {candidate,settings}=nativeDocuments(),producer=settings.producer;
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
