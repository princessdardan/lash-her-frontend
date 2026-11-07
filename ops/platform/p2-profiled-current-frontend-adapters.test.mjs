import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deployProfiledCurrentFrontend, observeProfiledCurrentFrontend,
  readProfiledCurrentWorkloadReceipt } from "./p2-profiled-current-frontend-adapters.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const names = ["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem", "tls/gateway/ca.pem",
  "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem", "tls/community/key.pem",
  "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env", "community-api.env",
  "community-worker.env", "course-media.env", "course-export-cleanup.env"];

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "profiled-current-adapter-")));
  const sourceCommit = "a".repeat(40), producer = "b".repeat(64), targetSha256 = "c".repeat(64);
  const target = { qualificationTargetProfile: profile, host: "db.example.com", port: 5432, database: "frontend", user: "operator",
    runtimeRole: "frontend_runtime", serverMajor: 18, allowEmptyBootstrap: false, approvedPendingTags: [] };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId: "owned-release",
    contractPhase: "p2", phase2ContractManifestSha256: `sha256:${"d".repeat(64)}`,
    sources: { frontend: { qualificationTargetProfile: profile, repository: "https://github.com/princessdardan/lash-her-frontend.git",
      commit: sourceCommit, requiredChecks: "passed" } }, workload: { qualificationTargetProfile: profile,
      projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", environment: "production" },
    frontendMigration: { qualificationTargetProfile: profile } };
  const plan = { version: 2, qualificationTargetProfile: profile, environment: "staging", actionId: candidate.releaseId,
    sourceCommit, targetSha256, runtimeProducerSha256: producer, certification: structuredClone(P2_CERTIFICATION_PROFILE) };
  const job = { version: 2, qualificationTargetProfile: profile, environment: "staging", releaseId: candidate.releaseId,
    sourceCommit, target };
  const bootstrapRuntimeTarget = { qualificationTargetProfile: profile, environment: "staging", targetSha256,
    host: target.host, port: target.port, database: target.database, user: target.runtimeRole, serverMajor: target.serverMajor };
  let queries = 0, providers = 0;
  const databaseClient = { async query(sql) {
    queries++;
    if (sql.includes("SELECT environment,target_sha256")) return { rows: [{ environment: "staging", target_sha256: targetSha256,
      epoch: "7", new_work: false, recovery: false }] };
    if (sql.includes("count(*) FILTER")) return { rows: [{ active: 0, uncertain: 0 }] };
    return { rows: [] };
  } };
  const context = { qualificationTargetProfile: profile, plan, inventorySha256: sha(JSON.stringify(plan)), candidate,
    candidateSha256: "e".repeat(64), job, configurationSha256: Object.fromEntries(names.map((name, index) => [name, String(index % 9 + 1).repeat(64)])),
    directory, getProviderContext() { providers++; return {}; }, verifyLockedSession: async () => {},
    environmentSignal: new AbortController().signal, databaseClient, bootstrapRuntimeTarget,
    admissionObservation: { epoch: "7", newWork: false, recovery: false, active: 0, uncertain: 0, ledgerDrained: true } };
  return { context, cleanup: () => rmSync(directory, { recursive: true, force: true }), counts: () => ({ queries, providers }) };
}

test("profile, candidate, configuration and runtime faults refuse before database/provider reads", async () => {
  for (const mutate of [value => { value.candidate.version = 2; }, value => { delete value.job.target.qualificationTargetProfile; },
    value => { delete value.configurationSha256["runtime.json"]; }, value => { value.bootstrapRuntimeTarget.user = "other_runtime"; }]) {
    const f = fixture(); try {
      mutate(f.context); await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
      assert.deepEqual(f.counts(), { queries: 0, providers: 0 });
    } finally { f.cleanup(); }
  }
});

test("accessor carriers refuse without invoking the accessor", async () => {
  const f = fixture(); let touched = false;
  try {
    Object.defineProperty(f.context.candidate, "version", { enumerable: true, get() { touched = true; return 3; } });
    await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
    assert.equal(touched, false); assert.deepEqual(f.counts(), { queries: 0, providers: 0 });
  } finally { f.cleanup(); }
});

test("private provider wrapper is checked after an actual closed-ledger read", async () => {
  const f = fixture(); let tokenRead = false;
  try {
    f.context.getProviderContext = () => {
      const value = { version: 1, qualificationTargetProfile: profile, frontendRuntimeDatabaseUrl: "postgresql://private", bindings: {} };
      Object.defineProperty(value, "vercelToken", { enumerable: true, get() { tokenRead = true; return "private"; } }); return value;
    };
    await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
    assert.ok(f.counts().queries >= 4, JSON.stringify(f.counts())); assert.equal(tokenRead, false);
  } finally { f.cleanup(); }
});

test("recovery preserves the exact 19-file configuration map across the retained workload read", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "profiled-current-recovery-"))), vercel = join(directory, "vercel");
  try {
    mkdirSync(vercel, { mode: 0o700 }); const workload = Buffer.from('{"status":"FRONTEND_VERIFIED"}\n');
    writeFileSync(join(vercel, "frontend-workload-outcome.json"), workload, { mode: 0o600 });
    const configurationSha256 = Object.fromEntries(names.map((name, index) => [name, String(index % 9 + 1).repeat(64)]));
    const pins = Object.fromEntries(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome",
      "apiRuntimeOutcome", "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"]
      .map((name, index) => [name, String(index + 1).repeat(64)]));
    const sourceCommit = "a".repeat(40), target = { qualificationTargetProfile: profile, approvedPendingTags: [], allowEmptyBootstrap: false,
      runtimeRole: "frontend_runtime" };
    const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId: "owned-release",
      contractPhase: "p2", phase2ContractManifestSha256: `sha256:${"d".repeat(64)}`,
      sources: { frontend: { commit: sourceCommit, repository: "https://github.com/princessdardan/lash-her-frontend.git", requiredChecks: "passed" } },
      workload: { projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", environment: "production" },
      frontendMigration: { qualificationTargetProfile: profile } };
    const job = { version: 2, qualificationTargetProfile: profile, environment: "staging", releaseId: "owned-release", sourceCommit, target };
    const plan = { version: 2, qualificationTargetProfile: profile, mode: "p2-profiled-current-recovery", environment: "staging",
      disposition: "reconcile-frontend-get-first", originalReleaseId: "owned-release", sourceCommit, candidateSha256: "e".repeat(64),
      configurationSha256, targetSha256: "f".repeat(64), originalReceiptSha256: pins };
    const context = { plan, migration: { qualificationTargetProfile: profile, candidate, job }, originalReceiptSha256: pins,
      providerContext: { version: 2, qualificationTargetProfile: profile, vercelToken: "private", originalDirectory: directory, bindings: {} },
      verifyEnvironment: async () => {}, verifySession: async () => {} };
    const canonicalPins = JSON.stringify(Object.fromEntries(Object.entries(pins).sort(([left], [right]) => left.localeCompare(right))));
    const observation = { version: 2, qualificationTargetProfile: profile, status: "P2_PROFILED_CURRENT_FRONTEND_CURRENT",
      workloadReceiptSha256: sha(workload), originalReceiptSha256: sha(canonicalPins), configurationSha256: structuredClone(configurationSha256) };
    assert.deepEqual(await readProfiledCurrentWorkloadReceipt(context, observation), workload);
    delete context.plan.configurationSha256["runtime.json"];
    await assert.rejects(readProfiledCurrentWorkloadReceipt(context, observation), /REVIEW_REQUIRED/u);
  } finally { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); }
});

test("actual child checkpoint protocol rechecks the admission ledger and reaps the worker", async () => {
  const f = fixture(), bin = join(f.context.directory, "bin"); mkdirSync(bin, { mode: 0o700 });
  const executable = join(bin, "python3"), previousPath = process.env.PATH;
  const program = String.raw`#!/usr/bin/python3
import json,sys
p=json.loads(sys.stdin.readline())
print(json.dumps({'type':'checkpoint','id':1}),flush=True)
assert json.loads(sys.stdin.readline())=={'type':'continue','id':1}
w='f'*64
r={'version':2,'qualificationTargetProfile':p['qualificationTargetProfile'],'status':'P2_PROFILED_CURRENT_FRONTEND_VERIFIED',
'environment':'staging','actionId':p['candidate']['releaseId'],'releaseId':p['candidate']['releaseId'],
'sourceCommit':p['plan']['sourceCommit'],'targetSha256':p['plan']['targetSha256'],'candidateSha256':p['candidateSha256'],
'configurationSha256':p['configurationSha256'],'contractPhase':'p2','phase2ContractManifestSha256':p['candidate']['phase2ContractManifestSha256'],
'projectId':p['candidate']['workload']['projectId'],'deploymentId':'dpl_Owned123','readyState':'READY','aliasJobState':'succeeded',
'aliasDeploymentId':'dpl_Owned123','aliasJobDeploymentId':'dpl_Owned123','aliasJobMatchesIntent':True,'aliasJobType':'promote',
'nativeSchedulesEnabled':False,'admissionNewWork':False,'admissionRecovery':False,'workloadVerified':True,'workloadReceiptSha256':w,
'configurationRecordSha256':w,'featureControls':p['expectedFeatureControls'],'writerAdmissionBinding':p['writerAdmissionBinding'],
'certificationSchedule':{'path':'/api/cron/account-lifecycle','schedule':'* * * * *','deploymentId':'dpl_Owned123','nativeEnabled':False,'definitionsSha256':'1'*64},
'frontendSqlApplied':False,'historicalProviderClosureClaimed':False,'oldP200Qualified':False,'trafficAuthorized':False,'releaseAccepted':False}
print(json.dumps({'type':'result','value':r}),flush=True)
`;
  try {
    writeFileSync(executable, program, { mode: 0o700 }); process.env.PATH = `${bin}:${previousPath}`;
    f.context.getProviderContext = async () => ({ version: 2, qualificationTargetProfile: profile, vercelToken: "private",
      frontendRuntimeDatabaseUrl: "postgresql://frontend_runtime:private@db.example.com/frontend?sslmode=verify-full", bindings: {} });
    const result = await deployProfiledCurrentFrontend(f.context);
    assert.equal(result.status, "P2_PROFILED_CURRENT_FRONTEND_VERIFIED");
    assert.ok(f.counts().queries >= 16);
  } finally { process.env.PATH = previousPath; f.cleanup(); }
});

test("lost-build disposition uses the fixed child operation and cannot become a workload proof", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "profiled-current-lost-build-"))), bin = join(directory, "bin");
  mkdirSync(bin, { mode: 0o700 }); const executable = join(bin, "python3"), previousPath = process.env.PATH;
  const sourceCommit = "a".repeat(40), targetSha256 = "b".repeat(64);
  const configurationSha256 = Object.fromEntries(names.map((name, index) => [name, String(index % 9 + 1).repeat(64)]));
  const pins = { deployStarted: "1".repeat(64), buildStarted: "2".repeat(64), buildIntent: "3".repeat(64) };
  const target = { qualificationTargetProfile: profile, approvedPendingTags: [], allowEmptyBootstrap: false,
    runtimeRole: "frontend_runtime" };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId: "owned-release",
    contractPhase: "p2", phase2ContractManifestSha256: `sha256:${"d".repeat(64)}`,
    sources: { frontend: { qualificationTargetProfile: profile, commit: sourceCommit,
      repository: "https://github.com/princessdardan/lash-her-frontend.git", requiredChecks: "passed" } },
    workload: { qualificationTargetProfile: profile, projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", environment: "production" },
    frontendMigration: { qualificationTargetProfile: profile } };
  const job = { version: 2, qualificationTargetProfile: profile, environment: "staging", releaseId: "owned-release",
    sourceCommit, target };
  const plan = { version: 2, qualificationTargetProfile: profile, mode: "p2-profiled-current-recovery", environment: "staging",
    disposition: "reconcile-frontend-lost-build-get-first", originalReleaseId: "owned-release", sourceCommit,
    candidateSha256: "e".repeat(64), configurationSha256, targetSha256, lostBuildReceiptSha256: pins };
  let environmentChecks = 0, sessionChecks = 0;
  const context = { plan, migration: { qualificationTargetProfile: profile, candidate, job }, lostBuildReceiptSha256: pins,
    providerContext: { version: 2, qualificationTargetProfile: profile, vercelToken: "private",
      originalDirectory: directory, bindings: {} }, environmentSignal: new AbortController().signal,
    verifyEnvironment: async () => { environmentChecks++; }, verifySession: async () => { sessionChecks++; } };
  const program = String.raw`#!/usr/bin/python3
import hashlib,json,sys
p=json.loads(sys.stdin.readline());assert p['operation']=='recovery-observe-lost-build';assert p['version']==2
print(json.dumps({'type':'checkpoint','id':1}),flush=True)
assert json.loads(sys.stdin.readline())=={'type':'continue','id':1}
pins=p['lostBuildReceiptSha256'];joined=hashlib.sha256(json.dumps(dict(sorted(pins.items())),separators=(',',':')).encode()).hexdigest()
r={'version':2,'qualificationTargetProfile':p['qualificationTargetProfile'],'status':'P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED',
'environment':'staging','actionId':p['candidate']['releaseId'],'releaseId':p['candidate']['releaseId'],'sourceCommit':p['plan']['sourceCommit'],
'candidateSha256':p['plan']['candidateSha256'],'configurationSha256':p['plan']['configurationSha256'],'targetSha256':p['plan']['targetSha256'],
'projectId':p['candidate']['workload']['projectId'],'deploymentId':'dpl_Owned123','previousDeploymentId':'dpl_Previous123',
'lostBuildReceiptSha256':joined,'deployStartedSha256':pins['deployStarted'],'buildStartedSha256':pins['buildStarted'],
'buildIntentSha256':pins['buildIntent'],'getFirst':True,'newProviderPost':False,'ambiguous':False,'deploymentEffectObserved':True,
'frontendActionPending':True,'originalBuildAckObserved':False,'providerMutationReplayed':False,'buildReadyVerified':False,
'workloadVerified':False,'aliasQualificationVerified':False,'promotionVerified':False,'cronQualificationVerified':False,
'trafficAuthorized':False,'releaseAccepted':False}
print(json.dumps({'type':'result','value':r}),flush=True)
`;
  try {
    writeFileSync(executable, program, { mode: 0o700 }); process.env.PATH = `${bin}:${previousPath}`;
    const result = await observeProfiledCurrentFrontend(context);
    assert.equal(result.status, "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED");
    assert.equal(result.frontendActionPending, true); assert.equal(result.originalBuildAckObserved, false);
    assert.ok(Buffer.isBuffer(result.evidence) && sha(result.evidence) === result.evidenceSha256);
    assert.ok(environmentChecks >= 3 && sessionChecks >= 3);
    await assert.rejects(readProfiledCurrentWorkloadReceipt(context, result), /REVIEW_REQUIRED/u);
    writeFileSync(executable, program.replace("'deploymentId':'dpl_Owned123'", "'deploymentId':'dpl_Previous123'"), { mode: 0o700 });
    await assert.rejects(observeProfiledCurrentFrontend(context), /REVIEW_REQUIRED/u);
  } finally { process.env.PATH = previousPath; chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); }
});
