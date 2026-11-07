import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2_PROFILED_CURRENT_RECOVERY_OWNED_FIXTURE, withP2ProfiledCurrentRecoveryTransport } from "./p2-profiled-current-recovery-transport.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const program = String.raw`
import base64,fcntl,json,os,sys
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline());assert initial['mode']=='p2-profiled-current-recovery'
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
terminal={'status':'P2_PROFILED_CURRENT_RECOVERED_FENCED','trafficAuthorized':False,'nativeSchedulesEnabled':False}
arm=None
for raw in sys.stdin:
 p=json.loads(raw);op=p['operation'];value={'id':p['id']}
 if op=='check':value['status']='HELD'
 elif op=='profiled-current-recovery-arm':
  assert not arm;arm=p['id'];assert json.loads(base64.b64decode(p['receipt']))['status']=='DATABASE_VERIFIED'
  assert json.loads(base64.b64decode(p['continuationStarted']))['status']=='FRONTEND_CONTINUATION_STARTED'
  value.update(status='PROFILED_CURRENT_RECOVERY_ARMED')
 elif op=='profiled-current-recovery-prepare-prior-gateway':
  assert set(p)=={'id','operation'}
  value.update(status='PROFILED_CURRENT_RECOVERY_PRIOR_GATEWAY_PREPARED',receipt={'status':'PRIOR_GATEWAY_CLOSED_ZERO'})
  print(json.dumps(value),flush=True)
  if sys.argv[2]=='death':os._exit(37)
  print(json.dumps({'id':arm,'status':'PROFILED_CURRENT_RECOVERY_API_READY','receipt':{'version':2,'qualificationTargetProfile':initial['qualificationTargetProfile'],'status':'API_RUNTIME_READY','environment':'staging','releaseId':'original-release','trafficAuthorized':False}}),flush=True);continue
 elif op=='profiled-current-recovery-verify-api-current':
  value.update(status='PROFILED_CURRENT_RECOVERY_API_CURRENT_VERIFIED',receipt={'status':'CURRENT_DATABASES_READ_ONLY_VERIFIED','migrationsExecuted':False,'trafficAuthorized':False})
 elif op=='profiled-current-recovery-reconcile-frontend':
  assert p['observation']['status']=='P2_PROFILED_CURRENT_FRONTEND_CURRENT';assert p['proof']['status']=='P2_PROFILED_CURRENT_FRONTEND_VERIFIED';assert json.loads(base64.b64decode(p['workload']))['status']=='FRONTEND_VERIFIED'
  value.update(status='PROFILED_CURRENT_RECOVERY_FRONTEND_RECONCILED',receipt={'status':'GET_FIRST_UNIQUE_EFFECT_RECONCILED'})
 elif op=='profiled-current-recovery-observe-lost-build':
  assert p['observation']['status']=='P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED'
  value.update(status='PROFILED_CURRENT_RECOVERY_LOST_BUILD_OBSERVED',receipt={'status':'P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_RETAINED','observationSha256':'7'*64})
 elif op=='profiled-current-recovery-resume-api-suffix':value.update(status='PROFILED_CURRENT_RECOVERY_API_SUFFIX_RESUMED',receipt={'status':'EXACT_APPROVED_SUFFIX_RESUMED'})
 elif op=='profiled-current-recovery-runtime-restored':value.update(status='PROFILED_CURRENT_RECOVERY_RUNTIME_RESTORED',receipt={'status':'ALL_THREE_CURRENT'})
 elif op=='profiled-current-recovery-prepare-close':value.update(status='PROFILED_CURRENT_RECOVERY_CLOSE_PREPARED',receipt={'status':'CLOSE_PREPARED'})
 elif op=='profiled-current-recovery-session-closed':value.update(status='PROFILED_CURRENT_RECOVERY_SESSION_CLOSED',receipt={'version':2,'qualificationTargetProfile':initial['qualificationTargetProfile'],'status':'P2_PROFILED_CURRENT_SESSION_CLOSED','environment':'staging','releaseId':'original-release','sourceCommit':initial['sourceCommit'],'targetSha256':initial['targetSha256'],'originalBackendPid':12345,'originalBackendStart':'2026-11-06 01:02:03+00','backendAbsent':True,'migrationLockReleased':True,'nonceLockReleased':True,'admission':{'epoch':9,'newWork':False,'recovery':False,'active':0,'uncertain':0}})
 elif op=='profiled-current-recovery-finish':
  assert json.loads(base64.b64decode(p['terminal']))['phase']=='completed'
  assert json.loads(base64.b64decode(p['continuationCompleted']))['status']=='FRONTEND_CONTINUATION_COMPLETED'
  assert json.loads(base64.b64decode(p['recovery']))==terminal
  value.update(status='PROFILED_CURRENT_RECOVERY_JOINED',receipt=terminal)
 elif op=='commit':
  value.update(status='COMMITTED',receipt=terminal);print(json.dumps(value),flush=True)
  if sys.argv[2]=='ack-exit':os._exit(34)
  if sys.argv[2]=='ack-invalid':print(json.dumps({'id':999999,'status':'HELD'}),flush=True)
  if sys.argv[2]=='wait-eof':sys.stdin.read()
  break
 else:os._exit(38)
 print(json.dumps(value),flush=True)
os.close(fd)
`;

function fixture(mode = "ready", disposition = "reconcile-frontend-get-first") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2-profile-current-recovery-"))); chmodSync(directory, 0o700);
  const target = { qualificationTargetProfile: profile, approvedPendingTags: [], allowEmptyBootstrap: false };
  const job = service => ({ ...(service === "frontend" ? { version: 2 } : { schemaVersion: 2 }), qualificationTargetProfile: profile, service, environment: "staging", releaseId: "original-release", sourceCommit: "a".repeat(40), target });
  const configurationSha256 = Object.fromEntries(["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
    "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem",
    "tls/community/key.pem", "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env", "community-api.env",
    "community-worker.env", "course-media.env", "course-export-cleanup.env"].map((name, index) => [name, "abcdef"[index % 6].repeat(64)]));
  const initial = { version: 2, qualificationTargetProfile: profile, mode: "p2-profiled-current-recovery", environment: "staging",
    sourceCommit: "a".repeat(40), recoveryActionId: "recover-owned", originalReleaseId: "original-release",
    candidateSha256: "b".repeat(64), configurationSha256, targetSha256: "d".repeat(64), inventorySha256: "9".repeat(64),
    apiJobSha256: { course: "e".repeat(64), community: "f".repeat(64) }, owner: { name: "migration_owner", oid: "12345" }, disposition,
    originalReceiptSha256: Object.fromEntries(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome", "apiRuntimeOutcome",
      "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"].map((name, index) => [name, "12345678"[index].repeat(64)])),
    candidate: { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId: "original-release",
      sources: { frontend: { commit: "a".repeat(40) } }, workload: { projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" } },
    frontendJob: job("frontend"), inventory: { qualificationTargetProfile: profile }, credentials: { private: "NEVER_IN_ARGS_OR_ENV" } };
  const receipt = { version: 2, qualificationTargetProfile: profile, status: "DATABASE_VERIFIED", migrationMode: "verify-current-only", readOnlyVerified: true,
    applied: [], service: "frontend", environment: "staging", releaseId: "original-release", sourceCommit: "a".repeat(40) };
  const continuationStarted = { version: 2, qualificationTargetProfile: profile, status: "FRONTEND_CONTINUATION_STARTED", service: "frontend",
    environment: "staging", releaseId: "original-release", sourceCommit: "a".repeat(40) };
  const continuationCompleted = { ...continuationStarted, status: "FRONTEND_CONTINUATION_COMPLETED" };
  const terminal = { ...receipt, phase: "completed" };
  const workload = Buffer.from(JSON.stringify({ version: 2, qualificationTargetProfile: profile, status: "FRONTEND_VERIFIED" }));
  const originalReceiptSha256 = createHash("sha256").update(JSON.stringify(Object.fromEntries(
    Object.entries(initial.originalReceiptSha256).sort(([left], [right]) => left.localeCompare(right))))).digest("hex");
  const observation = { version: 2, qualificationTargetProfile: profile, status: "P2_PROFILED_CURRENT_FRONTEND_CURRENT", releaseId: "original-release",
    sourceCommit: "a".repeat(40), getFirst: true, newProviderPost: false, ambiguous: false, originalEffectReconciled: true,
    originalReceiptSha256, workloadReceiptSha256: createHash("sha256").update(workload).digest("hex") };
  const proof = { ...observation, status: "P2_PROFILED_CURRENT_FRONTEND_VERIFIED" };
  observation.proof = proof;
  let lostBuildObservation;
  if (disposition === "reconcile-frontend-lost-build-get-first") {
    initial.originalReceiptSha256 = Object.fromEntries(Object.entries(initial.originalReceiptSha256).slice(0, 5));
    initial.lostBuildReceiptSha256 = { deployStarted: "1".repeat(64), buildStarted: "2".repeat(64), buildIntent: "3".repeat(64) };
    const lostPinsSha = createHash("sha256").update(JSON.stringify(Object.fromEntries(
      Object.entries(initial.lostBuildReceiptSha256).sort(([left], [right]) => left.localeCompare(right))))).digest("hex");
    lostBuildObservation = { version: 2, qualificationTargetProfile: profile,
      status: "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED", environment: "staging", actionId: "original-release",
      releaseId: "original-release", sourceCommit: initial.sourceCommit, candidateSha256: initial.candidateSha256,
      configurationSha256: initial.configurationSha256, targetSha256: initial.targetSha256,
      projectId: initial.candidate.workload.projectId, deploymentId: "dpl_owned", previousDeploymentId: "dpl_previous",
      lostBuildReceiptSha256: lostPinsSha, deployStartedSha256: initial.lostBuildReceiptSha256.deployStarted,
      buildStartedSha256: initial.lostBuildReceiptSha256.buildStarted, buildIntentSha256: initial.lostBuildReceiptSha256.buildIntent,
      getFirst: true, newProviderPost: false, ambiguous: false, deploymentEffectObserved: true, frontendActionPending: true,
      originalBuildAckObserved: false, providerMutationReplayed: false, buildReadyVerified: false, workloadVerified: false,
      aliasQualificationVerified: false, promotionVerified: false, cronQualificationVerified: false,
      trafficAuthorized: false, releaseAccepted: false };
  }
  const recoveryOutcome = { status: "P2_PROFILED_CURRENT_RECOVERED_FENCED", trafficAuthorized: false, nativeSchedulesEnabled: false };
  for (const [name, value] of [["database-receipt.json", receipt], ["frontend-continuation-started.json", continuationStarted],
    ["frontend-continuation-completed.json", continuationCompleted], ["job-outcome.json", terminal], ["p2-profiled-current-recovery-held.json", recoveryOutcome]]) {
    writeFileSync(join(directory, name), JSON.stringify(value) + "\n", { mode: 0o600 });
  }
  const probe = { version: 2, qualificationTargetProfile: profile, operation: "verify-schema", marker: "7".repeat(64), backendPid: 12345,
    backendStart: "2026-11-06 01:02:03+00", job: initial.frontendJob, receipt, baseline: { catalog: {} }, targetSha256: initial.targetSha256,
    owner: initial.owner };
  const lock = join(directory, "host.lock"); let captured;
  const handle = P2_PROFILED_CURRENT_RECOVERY_OWNED_FIXTURE.environmentLock(
    { knownHosts: "/owned/known-hosts", sshKey: "/owned/key" }, initial, directory,
    (executable, args, options) => { captured = { executable, args, options }; return spawn("python3", ["-I", "-u", "-c", program, lock, mode], options); });
  return { directory, initial, receipt, continuationStarted, continuationCompleted, terminal, workload, observation, proof, lostBuildObservation,
    recoveryOutcome, probe, lock, handle,
    captured: () => captured, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("actual child pipe keeps the host flock and waits for EOF-driven child reaping before publishing success", async () => {
  const f = fixture("wait-eof");
  try {
    const result = await withP2ProfiledCurrentRecoveryTransport(f.handle, async (check, signal, host) => {
      await check(); assert.equal(signal.aborted, false);
      const contender = spawnSync("python3", ["-I", "-c", "import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)", f.lock]);
      assert.notEqual(contender.status, 0);
      await assert.rejects(host.preparePriorGateway());
      const { apiReady } = await host.armRecovery({ receipt: f.receipt, continuationStarted: f.continuationStarted, probe: f.probe });
      assert.equal(host.active(), true); await host.verifyCurrentApis(); await host.preparePriorGateway(); await apiReady;
      await host.reconcileFrontend(f.observation, f.proof, f.workload); await host.runtimeRestored(); await host.prepareClose(); await host.frontendSessionClosed();
      await host.finish({ terminal: f.terminal, continuationCompleted: f.continuationCompleted, recoveryOutcome: f.recoveryOutcome });
      return "joined";
    });
    assert.deepEqual(result, f.recoveryOutcome);
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory, "p2-profiled-current-recovery-host-outcome.json"))), f.recoveryOutcome);
    assert.equal(JSON.stringify(f.captured()).includes("NEVER_IN_ARGS_OR_ENV"), false);
    assert.equal(f.captured().executable, "/usr/bin/ssh"); assert.match(f.captured().args.at(-1), /p2_profiled_current_recovery\.py/u);
  } finally { f.cleanup(); }
});

test("lost build recovery transports only the source-observed GET-first effect and no workload proof", async () => {
  const f = fixture("wait-eof", "reconcile-frontend-lost-build-get-first");
  try {
    await withP2ProfiledCurrentRecoveryTransport(f.handle, async (_check, _signal, host) => {
      const { apiReady } = await host.armRecovery({ receipt: f.receipt, continuationStarted: f.continuationStarted, probe: f.probe });
      await host.verifyCurrentApis(); await host.preparePriorGateway(); await apiReady;
      const retained = await host.observeLostBuild(f.lostBuildObservation);
      assert.equal(retained.status, "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_RETAINED");
      await host.runtimeRestored(); await host.prepareClose(); await host.frontendSessionClosed();
      await host.finish({ terminal: f.terminal, continuationCompleted: f.continuationCompleted, recoveryOutcome: f.recoveryOutcome });
    });
    assert.equal(existsSync(join(f.directory, "p2-profiled-current-recovery-host-outcome.json")), true);
  } finally { f.cleanup(); }
});

test("a host death after the prior-gateway stage rejects the outstanding original arm request and cannot mint a terminal", async () => {
  const f = fixture("death");
  try {
    await assert.rejects(withP2ProfiledCurrentRecoveryTransport(f.handle, async (_check, signal, host) => {
      const { apiReady } = await host.armRecovery({ receipt: f.receipt, continuationStarted: f.continuationStarted, probe: f.probe });
      await host.verifyCurrentApis(); await host.preparePriorGateway(); await apiReady; assert.equal(signal.aborted, false);
    }));
    assert.equal(existsSync(join(f.directory, "p2-profiled-current-recovery-host-outcome.json")), false);
  } finally { f.cleanup(); }
});

test("a committed acknowledgement followed by a nonzero child exit publishes no local success", async () => {
  const f = fixture("ack-exit");
  try {
    await assert.rejects(withP2ProfiledCurrentRecoveryTransport(f.handle, async (_check, _signal, host) => {
      const { apiReady } = await host.armRecovery({ receipt: f.receipt, continuationStarted: f.continuationStarted, probe: f.probe });
      await host.verifyCurrentApis(); await host.preparePriorGateway(); await apiReady;
      await host.reconcileFrontend(f.observation, f.proof, f.workload); await host.runtimeRestored();
      await host.prepareClose(); await host.frontendSessionClosed();
      await host.finish({ terminal: f.terminal, continuationCompleted: f.continuationCompleted, recoveryOutcome: f.recoveryOutcome });
    }));
    assert.equal(existsSync(join(f.directory, "p2-profiled-current-recovery-host-outcome.json")), false);
  } finally { f.cleanup(); }
});

test("a protocol failure after COMMITTED remains sticky through a zero child exit", async () => {
  const f = fixture("ack-invalid");
  try {
    await assert.rejects(withP2ProfiledCurrentRecoveryTransport(f.handle, async (_check, _signal, host) => {
      const { apiReady } = await host.armRecovery({ receipt: f.receipt, continuationStarted: f.continuationStarted, probe: f.probe });
      await host.verifyCurrentApis(); await host.preparePriorGateway(); await apiReady;
      await host.reconcileFrontend(f.observation, f.proof, f.workload); await host.runtimeRestored();
      await host.prepareClose(); await host.frontendSessionClosed();
      await host.finish({ terminal: f.terminal, continuationCompleted: f.continuationCompleted, recoveryOutcome: f.recoveryOutcome });
    }));
    assert.equal(existsSync(join(f.directory, "p2-profiled-current-recovery-host-outcome.json")), false);
  } finally { f.cleanup(); }
});

test("an oversized initial packet refuses before the fixed SSH process is launched", async () => {
  const f = fixture(); let launches = 0;
  try {
    const initial = structuredClone(f.initial); initial.untrustedPadding = "x".repeat(4_000_000);
    const handle = P2_PROFILED_CURRENT_RECOVERY_OWNED_FIXTURE.environmentLock(
      { knownHosts: "/owned/known-hosts", sshKey: "/owned/key" }, initial, f.directory,
      () => { launches += 1; assert.fail("process launched"); });
    await assert.rejects(withP2ProfiledCurrentRecoveryTransport(handle, async () => {}));
    assert.equal(launches, 0);
  } finally { f.cleanup(); }
});

test("profile, current-only and distinct-action requirements are checked before process launch", () => {
  const f = fixture();
  try {
    for (const mutate of [value => { value.qualificationTargetProfile = { ...profile, sha256: "1".repeat(64) }; },
      value => { value.frontendJob.target.approvedPendingTags = ["0084_pending"]; }, value => { value.recoveryActionId = value.originalReleaseId; },
      value => { value.originalReceiptSha256 = {}; }, value => { value.disposition = "retry-sql"; }]) {
      const changed = structuredClone(f.initial); mutate(changed);
      assert.throws(() => P2_PROFILED_CURRENT_RECOVERY_OWNED_FIXTURE.environmentLock(
        { knownHosts: "x", sshKey: "y" }, changed, f.directory, () => assert.fail("process launched")));
    }
  } finally { f.cleanup(); }
});
