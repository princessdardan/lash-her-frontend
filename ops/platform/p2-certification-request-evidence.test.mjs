import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,chmodSync,realpathSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareP2LifecycleNativePlan,p2NativeHash} from './p2-lifecycle-native.mjs';
import {nativeDocuments,nativeObservation} from './harness/p2-native-unit-fixture.mjs';
import {collectP2CertificationRequestDetails} from './p2-certification-request-evidence.mjs';

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-certification-request-')));chmodSync(root,0o700);
  const directory=join(root,'receipts');mkdirSync(directory,{mode:0o700});
  const documents=nativeDocuments(),plan=prepareP2LifecycleNativePlan(documents.candidate,documents.settings),path=join(root,'operator-details.json');
  const body={version:1,kind:'operator-recorded-request-details',reviewerGithubUserId:'8996309',certificationActionId:'distinct-certification',
    nativePlanSha256:plan.planSha256,windowEpoch:'2',recordedAt:'2026-11-06T12:00:00.000Z',observations:[nativeObservation(plan,{id:plan.commandWitnesses[0].commandId,epoch:'2'})]};
  const save=()=>writeFileSync(path,JSON.stringify(body,null,2)+'\n',{mode:0o600});save();
  return{root,directory,path,body,plan,save,run:()=>collectP2CertificationRequestDetails(plan,'2',{kind:body.kind,path},{directory,certificationActionId:'distinct-certification'}),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('operator request details retain exact original bytes and explicit finite provenance',()=>{
  const f=fixture();try{
    const bytes=readFileSync(f.path),actual=f.run();assert.equal(actual.length,1);
    const proof=JSON.parse(readFileSync(join(f.directory,'native-request-evidence/p2-native-request-evidence-provenance.json')));
    assert.equal(proof.automaticProviderEvidence,false);assert.equal(proof.providerInventoryComplete,false);assert.equal(proof.providerCancellationVerified,false);
    assert.equal(proof.artifactSha256,p2NativeHash(bytes));assert.deepEqual(readFileSync(join(f.directory,'native-request-evidence',proof.artifactReceipt)),bytes);
  }finally{f.cleanup();}
});
test('unsupported automatic collector and caller completion booleans cannot replace request details',()=>{
  for(const change of [f=>{f.body.kind='automatic-provider-request-details';},f=>{f.body.complete=true;},f=>{f.body.observations[0].complete=true;}]){
    const f=fixture();try{change(f);f.save();assert.throws(f.run);assert.deepEqual(readdirSync(f.directory),[]);}finally{f.cleanup();}
  }
});
test('wrong action, plan, epoch, reviewer, duplicated IDs and private fields refuse before retention',()=>{
  for(const change of [f=>{f.body.certificationActionId='another-certification';},f=>{f.body.nativePlanSha256='f'.repeat(64);},f=>{f.body.windowEpoch='3';},
    f=>{f.body.reviewerGithubUserId='other';},f=>{f.body.observations.push(f.body.observations[0]);},f=>{f.body.observations[0].secret='never-retain';}]){
    const f=fixture();try{change(f);f.save();assert.throws(f.run);assert.deepEqual(readdirSync(f.directory),[]);}finally{f.cleanup();}
  }
});
