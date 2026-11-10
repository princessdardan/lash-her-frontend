import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Client } from "pg";
import { validateP2ReceiverDenialInput, observeCourseSuspensionDenial, observeCommunitySuspensionDenial } from "./p2-lifecycle-receiver-denial.mjs";
import { createP2LifecycleWorkerPrivateResolvers, prepareP2LifecycleWorkerEvidencePlan, preflightP2DirectLifecycleWorker,
  readP2LifecycleWorkerCronSecret, readP2LifecycleWorkerRuntimeUrl, readP2DirectWorkerSourceArtifact } from "./p2-lifecycle-worker-evidence.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";

function input() { return { version: 1, mode: "course-http", environment: "staging", bindingSha256: "a".repeat(64), subject: randomUUID(), courseId: randomUUID(),
  currentKey: "OWNED-SYNTHETIC-CURRENT-KEY-NEVER-LIVE".repeat(2), gatewayCaSha256: "b".repeat(64), runtimeEnvironment: null, target: null }; }
test("private denial profile cannot select a URL, SQL, token, command or Community HTTP feature", () => {
  validateP2ReceiverDenialInput(input());
  for (const change of [row => { row.url = "https://foreign.invalid"; }, row => { row.sql = "SELECT 1"; }, row => { row.token = "arbitrary"; },
    row => { row.mode = "community-http"; }, row => { row.environment = "production"; }]) {
    const value = input(); change(value); assert.throws(() => validateP2ReceiverDenialInput(value));
  }
});
test("source private resolvers read only approved runtime inputs and foreign handles refuse", async () => {
  const original = process.env.FRONTEND_STAGING_CRON_SECRET; let reads = 0;
  const handle = createP2LifecycleWorkerPrivateResolvers(async () => { reads++; return { frontendRuntimeDatabaseUrl: "OWNED-PRIVATE-RUNTIME-URL" }; });
  assert.equal(reads, 0); assert.throws(() => readP2LifecycleWorkerCronSecret({}));
  process.env.FRONTEND_STAGING_CRON_SECRET = "OWNED-SYNTHETIC-CRON-SECRET";
  try {
    assert.equal(readP2LifecycleWorkerCronSecret(handle), "OWNED-SYNTHETIC-CRON-SECRET");
    assert.equal(await readP2LifecycleWorkerRuntimeUrl(handle), "OWNED-PRIVATE-RUNTIME-URL"); assert.equal(reads, 1);
    assert.equal(JSON.stringify(handle).includes(process.env.FRONTEND_STAGING_CRON_SECRET), false);
    assert.throws(() => readP2DirectWorkerSourceArtifact({}, { recordSha256: "a".repeat(64) }));
  } finally { if (original === undefined) delete process.env.FRONTEND_STAGING_CRON_SECRET; else process.env.FRONTEND_STAGING_CRON_SECRET = original; }
});
test("profiled direct-worker plan joins the original current native and suspension plans but has no apply authority", async () => {
  const sourceCommit = nativeSourceCommit(), candidateObjectSha256 = "a".repeat(64), targetSha256 = "b".repeat(64), configurationRecordSha256 = "c".repeat(64);
  const command = { commandId: randomUUID(), accountVersion: "1", action: "suspend" };
  const nativePlan = { version: 2, qualificationTargetProfile: current, environment: "staging", actionId: "owned-release", planSha256: "d".repeat(64),
    sourceCommit, candidateSha256: candidateObjectSha256, targetSha256, configurationRecordSha256,
    target: { qualificationTargetProfile: current, host: "localhost", port: 5432, database: "owned_frontend", user: "owned_runtime", serverMajor: 18 }, commandWitnesses: [command] };
  const suspensionPlan = { version: 2, qualificationTargetProfile: current, environment: "staging", profile: "normal-ui-suspension-pending-v1",
    releaseId: nativePlan.actionId, sourceCommit, candidateSha256: "e".repeat(64), candidateObjectSha256, targetSha256,
    configurationRecordSha256, configurationSha256: "f".repeat(64) };
  const selected = { version: 2, qualificationTargetProfile: current, actionId: "owned-certification", commandIndex: 0,
    pendingRecordSha256: "1".repeat(64), canonicalCommandSha256: "2".repeat(64), gatewayProcessSha256: "3".repeat(64),
    gatewayConfigurationSha256: "4".repeat(64), denialProgramSha256: "5".repeat(64) };
  const plan = prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, selected, current);
  assert.equal(plan.version, 2); assert.deepEqual(plan.qualificationTargetProfile, current);
  assert.equal(plan.profile, "direct-known-suspension-v1"); assert.equal(plan.candidateObjectSha256, candidateObjectSha256);
  assert.equal(Object.hasOwn(plan, "receiverNegatives"), false);
  const receiverNegatives = { profile: "suspended-head-negatives-v2" };
  const withNegatives = prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, { ...selected, receiverNegatives }, current);
  assert.equal(withNegatives.receiverNegatives.profile, receiverNegatives.profile);
  assert.match(withNegatives.receiverNegatives.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.match(withNegatives.receiverNegatives.hostSourceSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan,
    { ...selected, receiverNegatives: { ...receiverNegatives, case: "future-gap" } }, current));
  const resolvers = createP2LifecycleWorkerPrivateResolvers(async () => ({ frontendRuntimeDatabaseUrl: "owned" }));
  const client = new Client({ host: nativePlan.target.host, port: nativePlan.target.port });
  client.connection.stream = { encrypted: true, authorized: true };
  let verified = false;
  await assert.rejects(preflightP2DirectLifecycleWorker(plan, {}, resolvers, client,
    { verifyEnvironment: async () => { verified = true; throw new Error("OWNED_PROFILED_PLAN_REGISTERED"); }, verifySession: async () => {} }),
    /OWNED_PROFILED_PLAN_REGISTERED/u);
  assert.equal(verified, true);
  for (const mutate of [value => { delete value.nativePlan.target.qualificationTargetProfile; },
    value => { value.nativePlan.actionId = "different-release"; }, value => { delete value.suspensionPlan.qualificationTargetProfile; },
    value => { value.input.version = 1; }]) {
    const value = structuredClone({ nativePlan, suspensionPlan, input: selected }); mutate(value);
    assert.throws(() => prepareP2LifecycleWorkerEvidencePlan(value.nativePlan, value.suspensionPlan, value.input, current));
  }
  assert.throws(() => prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, selected));
});
test("profiled worker joins all six host cases before retaining source and stops on response loss", () => {
  const program = String.raw`
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mock} from 'node:test';
import {Client} from 'pg';
import {nativeDocuments} from './ops/platform/harness/p2-native-unit-fixture.mjs';
import {p2NativeHash,prepareP2LifecycleNativePlan} from './ops/platform/p2-lifecycle-native.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile} from './ops/platform/qualification-target-profile.mjs';
const transport = new URL('./ops/platform/p2-certification-transport.mjs', 'file://' + process.cwd() + '/').href;
let expectedHandle, stage;
mock.module(transport,{exports:{readP2CertificationWorkerStage(handle){assert.equal(handle,expectedHandle);return stage;}}});
const worker = await import('./ops/platform/p2-lifecycle-worker-evidence.mjs');
const profileFields={version:2,qualificationTargetProfile:profile};
const source = nativeDocuments();
Object.assign(source.candidate,profileFields,{version:3});
for(const carrier of [source.candidate.workload,source.candidate.sources.frontend,source.settings.target])carrier.qualificationTargetProfile=profile;
Object.assign(source.settings,profileFields,{epoch:'2'});
const native=prepareP2LifecycleNativePlan(source.candidate,source.settings,profile);
const suspend={...profileFields,profile:'normal-ui-suspension-pending-v1',environment:'staging',releaseId:native.actionId,
 sourceCommit:native.sourceCommit,candidateObjectSha256:native.candidateSha256,candidateSha256:'e'.repeat(64),targetSha256:native.targetSha256,
 configurationRecordSha256:native.configurationRecordSha256,configurationSha256:'f'.repeat(64)};
const selection={...profileFields,actionId:'owned-worker',commandIndex:0,pendingRecordSha256:'1'.repeat(64),canonicalCommandSha256:'2'.repeat(64),
 gatewayProcessSha256:'3'.repeat(64),gatewayConfigurationSha256:'4'.repeat(64),denialProgramSha256:'5'.repeat(64),
 receiverNegatives:{profile:'suspended-head-negatives-v2'}};
const services=['course','community'], caseNames=['exact-replay','changed-replay','stale-restore'];
const command=native.commandWitnesses[0], at=new Date().toISOString(), witnessSha='6'.repeat(64), retainedSha='7'.repeat(64);
for(const failure of [null,'lost-response','mismatched-terminal']){
 const plan=worker.prepareP2LifecycleWorkerEvidencePlan(native,suspend,selection,profile), bindingSha256=p2NativeHash(plan);
 const fields={...profileFields,bindingSha256,releaseAccepted:false}, phase=[];
 const operation={id:randomUUID(),producer_sha256:native.producer.producerSha256,source_sha:native.sourceCommit,role_oid:native.producer.role.oid,
  epoch:'2',kind:'recovery',state:'completed',started_at:at,completed_at:at,reconciliation_sha256:null};
 let epoch='1', recovery=false, delivered=false, count=0;
 const client=new Client({host:native.target.host,port:native.target.port});
 client.connection.stream={encrypted:true,authorized:true};
 client.query=async sql=>{
  if(sql.includes('pg_backend_pid() AS pid'))return {rows:[{pid:1,held:true,role:native.target.user,session_role:native.target.user,
   database:native.target.database,major:native.target.serverMajor}]};
  if(sql.includes('schema_owner_oid'))return {rows:[{username:native.owner.name,role_oid:native.owner.oid,schema_owner_oid:native.owner.oid}]};
  if(sql.includes('frontend_admission.control'))return {rows:[{environment:'staging',target_sha256:native.targetSha256,epoch,new_work:false,recovery}]};
  if(sql.includes('frontend_admission.producers'))return {rows:[{source_sha:native.sourceCommit,role_oid:native.producer.role.oid,enabled:true}]};
  if(sql.includes('count(*) FILTER'))return {rows:[{active:0,uncertain:0}]};
  if(sql.includes('operations WHERE epoch'))return {rows:delivered?[operation]:[]};
  if(sql.includes('SELECT command_id::text,account_version'))return {rows:[{command_id:command.commandId,account_version:command.accountVersion,action:'suspend'}]};
  if(sql.includes('SELECT command_id::text,receiver'))return {rows:services.map(receiver=>({command_id:command.commandId,receiver,
   status:delivered?'acknowledged':'pending',attempts:delivered?1:0,acknowledged_at:delivered?at:null,lease_id:null,lease_until:null,ready:true}))};
  if(sql.includes('SELECT count(*)::int AS count'))return {rows:[{count:0}]};
  assert.match(sql,/^(BEGIN|ROLLBACK|SET LOCAL ROLE|SELECT later.command_id)/u);
  return {rows:[]};
 };
 const cases=services.flatMap(service=>caseNames.map((name,index)=>({...fields,status:'P2_DIRECT_WORKER_RECEIVER_NEGATIVE_CASE_OBSERVED',
  service,case:name,httpStatus:index===0?200:409,result:['duplicate','idempotency_conflict','account_version_conflict'][index],
  beforeWitnessSha256:witnessSha,afterWitnessSha256:witnessSha,privateRecordSha256:'8'.repeat(64),
  accountAndDomainStateUnchanged:true,quotaWritesExcluded:true,globallyReadOnly:false})));
 const summary={...fields,status:'P2_DIRECT_WORKER_RECEIVER_NEGATIVES_JOINED',positiveWitnessSha256:witnessSha,cases,
  openCases:services.map(service=>({service,case:'future-gap',status:'OPEN',reason:'current-quiescence-not-positively-proved'})),
  domainStatePreserving:true,quotaWritesExcluded:true,globallyReadOnly:false,oidcVerified:false,privateRecordSha256:retainedSha};
 const denial={version:1,status:'P2_LIFECYCLE_RECEIVER_DENIAL_OBSERVED',denialStatusCode:403,accountRestrictionVerified:true};
 const resolver=worker.createP2LifecycleWorkerPrivateResolvers(()=>({frontendRuntimeDatabaseUrl:'owned-private-only'}));
 expectedHandle={};
 stage={
  async preflightCredential(handle){assert.equal(handle,resolver);return {...fields,status:'P2_DIRECT_WORKER_CREDENTIAL_VERIFIED_CLOSED',
   invalidStatus:401,validClosedStatus:503,operationIdIssued:false,credentialBytesRetained:false,credentialHashesOutput:false};},
  async invokeDirect(handle){assert.equal(handle,resolver);delivered=true;return {...fields,status:'P2_DIRECT_WORKER_HTTP_OBSERVED',httpStatus:200,
   operationId:operation.id,invocationClass:'direct-source-authenticated-cron',nativeInvocationQualified:false,workerInvokedAt:at,credentialBytesRetained:false};},
  async observeLifecycleWitness(handle){assert.equal(handle,resolver);phase.push('witness');return {...fields,status:'P2_DIRECT_WORKER_BOTH_ACK_WITNESSED',
   privateRecordSha256:witnessSha,receiverAcknowledgedCount:2,pendingOrDeliveringCount:0,readOnly:true};},
  async observeReceiverDenials(){phase.push('denials');return {...fields,status:'P2_DIRECT_WORKER_RECEIVERS_DENIED',
   course:{...denial,evidenceClass:'actual-protected-course-http',httpStatus:403},
   community:{...denial,evidenceClass:'deployed-private-community-account-access-guard',httpStatus:null}};},
  async observeNextReceiverNegative(handle){assert.equal(handle,resolver);phase.push('next');const row=cases[count++];
   if(failure==='lost-response')throw Error('owned receiver response lost');return row;},
  async joinedReceiverNegatives(){phase.push('join');return failure==='mismatched-terminal'?{...summary,positiveWitnessSha256:'9'.repeat(64)}:summary;},
  async finalClosedReadback(){phase.push('closed');return {...fields,status:'P2_DIRECT_WORKER_FINAL_CLOSED',frontendAdmissionClosed:true,
   gatewayAdmissionClosed:true,nativeEnabled:false,active:0,uncertain:0};},
 };
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'owned-s12-node-'))), noop=async()=>{};
 const dependencies={directory,verifyEnvironment:noop,verifySession:noop,withOwner:task=>task()};
 try{
  const credential=await worker.preflightP2DirectLifecycleWorker(plan,expectedHandle,resolver,client,dependencies);
  epoch='2';recovery=true;
  const invocation=await worker.invokeP2DirectLifecycleWorker(plan,credential,client,dependencies);
  epoch='3';recovery=false;
  const finish=()=>worker.joinP2DirectLifecycleWorker(plan,invocation,client,dependencies);
  if(failure){
   await assert.rejects(finish());await assert.rejects(finish());
   assert.equal(existsSync(join(directory,'p2-lifecycle-worker-source.json')),false);
   assert.equal(count,failure==='lost-response'?1:6);assert.equal(phase.includes('closed'),false);
  }else{
   const retained=worker.readP2DirectWorkerSourceArtifact(plan,await finish());
   assert.deepEqual(retained.record.receiverNegatives,summary);
   assert.deepEqual(phase,['witness','denials',...Array(6).fill('next'),'join','closed']);
   assert.equal(retained.bytes.includes('owned-private-only'),false);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
}
`;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", program],
    { encoding: "utf8", timeout: 20_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
test("Course403 must be the exact account restriction, never generic403/401/429/503", async () => {
  const { createHash } = await import("node:crypto"), ca = Buffer.from("OWNED-UNIT-CA");
  const selected = { ...input(), gatewayCaSha256: createHash("sha256").update(ca).digest("hex") };
  for (const [status, code, message, passes] of [[403, "FORBIDDEN", "Account access is unavailable", true], [403, "FORBIDDEN", "Other refusal", false],
    [401, "UNAUTHORIZED", "Unauthorized", false], [429, "RATE_LIMITED", "Rate limited", false], [503, "UNAVAILABLE", "Unavailable", false]]) {
    const request = (options, receive) => {
      assert.equal(options.hostname, "course-tls"); assert.equal(options.port, 8443); assert.equal(options.method, "GET"); assert.equal(options.rejectUnauthorized, true);
      const outgoing = new EventEmitter(); outgoing.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = status; response.headers = { "cache-control": "private, no-store", "x-request-id": "owned-request" };
        receive(response); response.emit("data", Buffer.from(JSON.stringify({ error: { code, message } }))); response.emit("end");
      }); return outgoing;
    };
    if (passes) { const result = await observeCourseSuspensionDenial(selected, { ca, request }); assert.equal(result.evidenceClass, "actual-protected-course-http"); assert.equal(result.httpStatus, 403); }
    else await assert.rejects(observeCourseSuspensionDenial(selected, { ca, request }));
  }
});
test("Community requires actualproduction runtime configuration before any private module load", async () => {
  const selected = { ...input(), mode: "community-private-guard", gatewayCaSha256: null, runtimeEnvironment: { DATABASE_TARGET: "staging" },
    target: { host: "localhost", port: 5432, database: "owned", runtimeRole: "owned_runtime", runtimeRoleOid: "123", serverMajor: 16 } };
  let loaded = false;
  await assert.rejects(observeCommunitySuspensionDenial(selected, { environment: { NODE_ENV: "test", DATABASE_TARGET: "staging" }, load: async () => { loaded = true; } }));
  assert.equal(loaded, false);
});
