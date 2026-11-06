import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdirSync, mkdtempSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareP2LifecycleNativePlan, validateP2NativeRequestObservation, containP2LifecycleNative } from "./p2-lifecycle-native.mjs";
import { nativeDocuments, nativeModel, nativeObservation } from "./harness/p2-native-unit-fixture.mjs";

test("plan requires exact qualified P2/staging/ten-control lifecycle-only profile and explicit closed final disposition", () => {
  for (const change of [f => { f.candidate.environment = 'production'; }, f => { f.candidate.contractPhase = 'p1'; }, f => { f.candidate.workload.projectId = 'production'; },
    f => { delete f.settings.featureControls.CUSTOMER_AUTH_ENABLED; }, f => { f.settings.featureControls.CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED = false; },
    f => { f.settings.finalDisposition = 'keep-enabled'; }, f => { f.settings.windowSeconds = 181; }, f => { f.settings.commandWitnesses = []; }, f => { f.settings.targetSha256 = 'f'.repeat(64); }]) {
    const fixture = nativeDocuments(); change(fixture); assert.throws(() => prepareP2LifecycleNativePlan(fixture.candidate, fixture.settings));
  }
});
test("finite native request witnesses join exact admitted recovery operations, ordered effects, and actual source closure without a cancellation claim", async () => {
  const fixture = nativeModel();
  try {
    const result = await fixture.run();
    assert.equal(result.status, 'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED'); assert.deepEqual(fixture.state.toggles, [true,false]);
    assert.deepEqual(result.finalAdmission, { epoch: '3', newWork: false, recovery: false, active: 0, uncertain: 0 });
    assert.equal(result.nativeLedgerCorrelationVerified, true); assert.equal(result.orderedReceiverPersistenceVerified, true);
    assert.equal(result.providerQueuedInvocations, null); assert.equal(result.providerCancellationVerified, false);
    assert.equal(fixture.state.operations[0].epoch, '2'); assert.notEqual(fixture.state.operations[0].epoch, result.finalAdmission.epoch);
    const queries = fixture.state.queries; await assert.rejects(fixture.run()); assert.equal(fixture.state.queries, queries);
  } finally { fixture.cleanup(); }
});
test("extra/changed cron, runtime flags or immutable writer binding refuse before enable", async () => {
  for (const mutate of [value => { value.schedule = { path:'/api/cron/business',schedule:'* * * * *' }; }, value => { value.writerAdmissionBinding = { ...value.writerAdmissionBinding, mode:'off' }; },
    value => { value.featureControls = {}; }, value => { value.configurationRecordSha256 = 'f'.repeat(64); }]) {
    const fixture = nativeModel();
    try { const observe = fixture.input.nativeControl.observe; fixture.input.nativeControl.observe = async () => { const value = { ...await observe() }; mutate(value); return value; };
      const result = await fixture.run(); assert.equal(result.status, 'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW'); assert.deepEqual(fixture.state.toggles, []);
    } finally { fixture.cleanup(); }
  }
});
test("caller complete booleans, manual request classification and unrelated source/epoch/UUID cannot replace provider request-scoped trace evidence", async () => {
  for (const mutate of [row => { row.complete = true; }, row => { row.providerRequestTypeFilter = 'function'; }, row => { row.logScope = 'aggregate-logs'; },
    row => { const event = JSON.parse(row.admittedLogLine); event.epoch = '3'; row.admittedLogLine = JSON.stringify(event); },
    row => { const event = JSON.parse(row.admittedLogLine); event.targetSha256 = 'f'.repeat(64); row.admittedLogLine = JSON.stringify(event); },
    row => { row.admittedLogLine = JSON.stringify({ complete:true }); }]) {
    const fixture = nativeModel();
    try { fixture.tick(); const operation = { id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',epoch:'2' }; const row = nativeObservation(fixture.plan, operation); mutate(row);
      assert.throws(() => validateP2NativeRequestObservation(fixture.plan, row, '2'));
      fixture.input.observeNativeRequests = async () => [row]; const result = await fixture.run(); assert.equal(result.status, 'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW'); assert.equal(result.sourceAdmissionFenceVerified, true);
    } finally { fixture.cleanup(); }
  }
});
test("unmatched recovery operations or reordered receiver effects remain OPEN even after a clean close", async () => {
  for (const scenario of ['unmatched','ordering']) {
    const fixture = nativeModel();
    try { const observe = fixture.input.observeNativeRequests; fixture.input.observeNativeRequests = async () => {
      if (scenario === 'unmatched') return []; return observe();
    }; if (scenario === 'ordering') fixture.state.orderViolations.push({ later_command_id:fixture.plan.commandWitnesses[0].commandId,receiver:'course' });
      const result = await fixture.run(); assert.equal(result.status, 'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW'); assert.equal(result.sourceAdmissionFenceVerified, true);
    } finally { fixture.cleanup(); }
  }
});
test("active and uncertain outcomes are retained rather than settled/replayed by the qualifier", async () => {
  for (const state of ['active','uncertain']) {
    const fixture = nativeModel();
    try { const pause = fixture.input.clock.pause; fixture.input.clock.pause = async ms => { await pause(ms); if (fixture.state.operations.length) { fixture.state.operations[0].state=state; fixture.state.operations[0].completed_at=null; } };
      const result = await fixture.run(); assert.equal(result.status, 'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW'); assert.equal(result.sourceAdmissionFenceVerified, false);
      assert.equal(result.finalAdmission[state], 1); assert.equal(fixture.state.operations[0].state,state);
    } finally { fixture.cleanup(); }
  }
});
test("lost enable/disable acknowledgments are not retried and never produce qualification", async () => {
  for (const lost of [true,false]) {
    const fixture = nativeModel();
    try { const toggle = fixture.input.nativeControl.setEnabled; fixture.input.nativeControl.setEnabled = async (plan, enabled) => { await toggle(plan,enabled); if (enabled === lost) throw Error('owned-lost-toggle-ack'); };
      const result = await fixture.run(); assert.equal(result.status,'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW'); assert.deepEqual(fixture.state.toggles,[true,false]);
      assert.equal(result.finalAdmission.newWork,false); assert.equal(result.finalAdmission.recovery,false);
      const count = fixture.state.toggles.length; await assert.rejects(fixture.run()); assert.equal(fixture.state.toggles.length,count);
    } finally { fixture.cleanup(); }
  }
});
test("a delayed native request after admission closure can be observed without inventing an admitted operation or queue zero", async () => {
  const fixture = nativeModel();
  try { const observe = fixture.input.observeNativeRequests; fixture.input.observeNativeRequests = async () => {
    assert.equal(fixture.state.recovery,false); const rows = await observe(); const denied=nativeObservation(fixture.plan,fixture.state.operations[0],{providerRequestId:'owned-delayed-refusal',httpStatus:503,admittedLogLine:null}); return [...rows,denied];
  }; const result=await fixture.run(); assert.equal(result.status,'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED'); assert.equal(fixture.state.operations.length,1); assert.equal(result.providerQueuedInvocations,null);
  } finally { fixture.cleanup(); }
});
test("later receipt loss still attempts mandatory disable/admission closure and cannot return a success receipt", async () => {
  const fixture = nativeModel();
  try { const toggle=fixture.input.nativeControl.setEnabled; fixture.input.nativeControl.setEnabled=async(plan,enabled)=>{await toggle(plan,enabled);if(enabled){rmSync(fixture.input.directory,{recursive:true});mkdirSync(fixture.input.directory,{mode:0o700});
    // Occupy exclusive receipt names: subsequent retention fails, while the
    // source-owned original in-memory containment obligation remains active.
    for(const name of ['p2-native-disable-intent.json','p2-native-admission-close-intent.json','p2-native-closed-ledger-observed.json','p2-native-outcome.json'])mkdirSync(join(fixture.input.directory,name)); }};
    await assert.rejects(fixture.run()); assert.deepEqual(fixture.state.toggles,[true,false]); assert.equal(fixture.state.newWork,false); assert.equal(fixture.state.recovery,false);
  } finally { fixture.cleanup(); }
});
test("original intent with missing outcome after process death refuses automatic replay", async () => {
  const fixture=nativeModel();
  try { const first=await fixture.run(); assert.equal(first.status,'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED'); rmSync(join(fixture.input.directory,'p2-native-outcome.json'));
    const queries=fixture.state.queries; await assert.rejects(fixture.run()); assert.equal(fixture.state.queries,queries); assert.ok(existsSync(join(fixture.input.directory,'p2-native-started.json')));
    assert.ok(JSON.parse(readFileSync(join(fixture.input.directory,'p2-native-started.json'))).finalDisposition==='disabled-and-admission-closed');
  } finally {fixture.cleanup();}
});
test('actual SIGKILL after enable preserves intent; fresh explicit containment disables/closes without replay or qualification',async()=>{
  const child=fork(fileURLToPath(new URL('./harness/p2-native-death-fixture.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc']});
  let original,fixture;
  try{
    original=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned-death-child-timeout')),10000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',reject);});
    const exited=new Promise(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));child.kill('SIGKILL');assert.equal(await exited,'SIGKILL');
    assert.ok(existsSync(join(original.directory,'p2-native-started.json')));assert.ok(!existsSync(join(original.directory,'p2-native-outcome.json')));
    fixture=nativeModel({candidate:original.candidate,settings:original.settings});Object.assign(fixture.state,original.state);
    const replayDirectory=fixture.input.directory;fixture.input.directory=original.directory;await assert.rejects(fixture.run());fixture.input.directory=replayDirectory;
    const contained=await containP2LifecycleNative({...fixture.input,originalDirectory:original.directory,expectedEpoch:original.state.epoch});
    assert.equal(contained.sourceAdmissionFenceVerified,true);assert.equal(contained.nativeQualificationAccepted,false);assert.equal(contained.status,'P2_LIFECYCLE_NATIVE_CONTAINMENT_REQUIRES_REVIEW');
    assert.deepEqual(fixture.state.toggles,[false]);assert.equal(fixture.state.newWork,false);assert.equal(fixture.state.recovery,false);
  }finally{child.kill('SIGKILL');fixture?.cleanup();if(original)rmSync(original.directory,{recursive:true,force:true});}
});
test('a policy changed during operator observation invalidates the final fence instead of qualifying a stale closed snapshot',async()=>{
  const fixture=nativeModel();
  try{const observe=fixture.input.observeNativeRequests;fixture.input.observeNativeRequests=async()=>{const rows=await observe();fixture.state.epoch=String(BigInt(fixture.state.epoch)+1n);fixture.state.recovery=true;return rows;};
    const result=await fixture.run();assert.equal(result.status,'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW');assert.equal(result.sourceAdmissionFenceVerified,false);assert.equal(result.finalAdmission,null);assert.equal(result.nativeEnabled,null);assert.ok(result.failurePhases.includes('final-closed-boundary'));
  }finally{fixture.cleanup();}
});

test('delivery acknowledgements interleaved with the epoch barrier cannot count as native window effects',async()=>{
  const fixture=nativeModel();
  try{
    const query=fixture.client.query.bind(fixture.client);
    fixture.client.query=async(sql,values)=>{const result=await query(sql,values);
      if(sql.startsWith('UPDATE frontend_admission.control')&&fixture.state.epoch==='2')
        for(const row of fixture.state.deliveries)Object.assign(row,{status:'acknowledged',attempts:1,acknowledged_at:new Date(),lease_until:null});
      return result;
    };
    const result=await fixture.run();
    assert.equal(result.status,'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW');assert.equal(result.orderedReceiverPersistenceVerified,false);
    assert.deepEqual(fixture.state.toggles,[]);assert.equal(fixture.state.operations.length,0);
    const scoped=JSON.parse(readFileSync(join(fixture.input.directory,'p2-native-recovery-only-observed.json')));
    assert.ok(scoped.deliveries.every(row=>row.status==='acknowledged'));
  }finally{fixture.cleanup();}
});

test('receiver attempts must advance from the retained post-barrier snapshot, not the earlier start',async()=>{
  const fixture=nativeModel();
  try{
    const query=fixture.client.query.bind(fixture.client);
    fixture.client.query=async(sql,values)=>{const result=await query(sql,values);
      if(sql.startsWith('UPDATE frontend_admission.control')&&fixture.state.epoch==='2')for(const row of fixture.state.deliveries)row.attempts=1;
      return result;
    };
    const result=await fixture.run();
    assert.equal(result.nativeLedgerCorrelationVerified,true);assert.equal(result.sourceAdmissionFenceVerified,true);
    assert.equal(result.status,'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW');assert.equal(result.orderedReceiverPersistenceVerified,false);
  }finally{fixture.cleanup();}
});

test('a final native enable or source drift invalidates the main qualifier disabled claim',async()=>{
  for(const scenario of ['enabled','source']){
    const fixture=nativeModel();let drift=false;
    try{
      const observe=fixture.input.nativeControl.observe,requests=fixture.input.observeNativeRequests;
      fixture.input.nativeControl.observe=async()=>({...await observe(),...(drift&&scenario==='source'?{sourceCommit:'f'.repeat(40)}:{})});
      fixture.input.observeNativeRequests=async()=>{const result=await requests();drift=true;if(scenario==='enabled')fixture.state.enabled=true;return result;};
      const result=await fixture.run();assert.equal(result.status,'P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW');
      assert.equal(result.nativeEnabled,null);assert.equal(result.sourceAdmissionFenceVerified,false);assert.ok(result.failurePhases.includes('final-closed-boundary'));
    }finally{fixture.cleanup();}
  }
});

test('containment rechecks exact disabled metadata after draining and never reports a stale source fence',async()=>{
  for(const scenario of ['stable','enabled','source','deployment','url','schedule','metadata-unavailable','lost-lock']){
    const fixture=nativeModel();let directory,drift=false,metadataReads=0,pauses=0;
    try{
      assert.equal((await fixture.run()).status,'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED');
      directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-native-containment-current-')));chmodSync(directory,0o700);
      const operation={...fixture.state.operations[0],id:'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',state:'active',completed_at:null};fixture.state.operations.push(operation);
      const metadata=fixture.input.nativeControl.observeMetadata;
      fixture.input.nativeControl.observeMetadata=async()=>{
        metadataReads++;if(drift&&scenario==='metadata-unavailable')throw Error('owned-metadata-unavailable');
        return {...await metadata(),...(drift&&scenario==='source'?{sourceCommit:'f'.repeat(40)}:{}),
          ...(drift&&scenario==='deployment'?{deploymentId:'dpl_foreign'}:{}),...(drift&&scenario==='url'?{deploymentUrl:'https://foreign.vercel.app'}:{}),
          ...(drift&&scenario==='schedule'?{schedule:{path:'/api/cron/foreign',schedule:'* * * * *'}}:{})};
      };
      const input={...fixture.input,directory,originalDirectory:fixture.input.directory,expectedEpoch:fixture.state.epoch,
        verifyEnvironment:async()=>{if(drift&&scenario==='lost-lock')throw Error('owned-lock-lost');},
        clock:{now:fixture.input.clock.now,pause:async()=>{pauses++;operation.state='completed';operation.completed_at=new Date();drift=true;if(scenario==='enabled')fixture.state.enabled=true;}}};
      const result=await containP2LifecycleNative(input);
      assert.equal(pauses,1);assert.equal(result.status,'P2_LIFECYCLE_NATIVE_CONTAINMENT_REQUIRES_REVIEW');assert.equal(result.nativeQualificationAccepted,false);
      assert.equal(result.nativeEnabled,scenario==='stable'?false:null);assert.equal(result.sourceAdmissionFenceVerified,scenario==='stable');
      if(scenario!=='lost-lock')assert.ok(metadataReads>=3);
      if(scenario==='stable'){
        const final=JSON.parse(readFileSync(join(directory,'p2-native-containment-final-boundary.json')));
        assert.equal(final.native.nativeEnabled,false);assert.equal(final.native.sourceCommit,fixture.plan.sourceCommit);assert.deepEqual(final.finalAdmission,result.finalAdmission);
      }else assert.equal(existsSync(join(directory,'p2-native-containment-final-boundary.json')),false);
      assert.deepEqual(fixture.state.toggles,[true,false]);assert.equal(result.providerQueuedInvocations,null);assert.equal(result.providerCancellationVerified,false);
    }finally{fixture.cleanup();if(directory)rmSync(directory,{recursive:true,force:true});}
  }
});
