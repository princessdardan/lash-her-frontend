import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {prepareP2qFirstInstallObservation,withP2qFirstInstallDatabaseObservation,readP2qFirstInstallDatabaseObservation} from './p2q-first-install.mjs';
import {ownedP2qObservationFixture} from './test-p2q-first-install-local.mjs';
const current={version:1,id:'staging-current',sha256:'ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba'};
function request(ref){return {qualificationTargetProfile:ref,actionId:'owned-observe',candidate:{version:3,environment:'staging',releaseId:'owned',sources:{frontend:{commit:'b'.repeat(40)}},qualificationTargetProfile:ref,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64)},
 job:{version:2,environment:'staging',releaseId:'owned',sourceCommit:'b'.repeat(40),qualificationTargetProfile:ref,contractPhase:'p2',phase2ContractManifestSha256:'sha256:'+'d'.repeat(64),target:{host:'127.0.0.1',port:5432,database:'owned',user:'owned_admin',runtimeRole:'owned_runtime',serverMajor:18,allowEmptyBootstrap:true,approvedPendingTags:['0000_owned']}}};}
test('public current and unregistered first-install requests refuse before client or parent work',async()=>{
 for(const ref of [current,{version:1,id:'p2q-20261106',sha256:'a'.repeat(64)}]){
  let calls=0;const client={query(){calls++;throw new Error('must not query');}};
  await assert.rejects(withP2qFirstInstallDatabaseObservation(request(ref),{client,verifySession:()=>{calls++;}},()=>{calls++;}));assert.equal(calls,0);
 }
});
test('JSON fresh/zero/authority flags and forged observation handles cannot select a path',async()=>{
 for(const field of ['fresh','firstUseAuthorized','allowAbsentGateway','activeExecutions'])await assert.rejects(prepareP2qFirstInstallObservation({...request(current),[field]:true}),{code:'P2Q_FIRST_INSTALL_REQUEST_REFUSED'});
 await assert.rejects(readP2qFirstInstallDatabaseObservation({observationOnly:true,firstUseAuthorized:false}),{code:'P2Q_FIRST_INSTALL_OBSERVATION_HANDLE_REQUIRED'});
});
test('owned fixture resolver only models selection and emits no install permission',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'p2q-first-install-pure-'));
 try{
  const ref=ownedP2qObservationFixture(directory),collector=await import(pathToFileURL(join(directory,'p2q-first-install.mjs')).href),input=request(ref);
  const plan=await collector.prepareP2qFirstInstallObservation(input);assert.equal(plan.observationOnly,true);
  for(const key of ['firstUseAuthorized','migrationAuthorized','rolePreparationAuthorized'])assert.equal(plan[key],false);
  for(const mutate of [v=>{v.job.version=1;},v=>{v.candidate.version=2;},v=>{v.job.target.allowEmptyBootstrap=false;},v=>{v.job.qualificationTargetProfile={...ref,sha256:'f'.repeat(64)};}]){const bad=structuredClone(input);mutate(bad);await assert.rejects(collector.prepareP2qFirstInstallObservation(bad));}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('resolved current policy still refuses before transport in the private interface fixture',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'p2q-current-policy-pure-'));
 try{
  const ref=ownedP2qObservationFixture(directory,{version:1,id:'owned-current',kind:'existing-staging',selectionPolicy:'existing-staging-v1',environment:'staging'}),collector=await import(pathToFileURL(join(directory,'p2q-first-install.mjs')).href);
  let calls=0;await assert.rejects(collector.withP2qFirstInstallDatabaseObservation(request(ref),{client:{query(){calls++;}},verifySession:()=>{calls++;}},()=>{calls++;}),{code:'QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED'});assert.equal(calls,0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
