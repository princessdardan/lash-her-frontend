import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { Client } from "pg";
import { frontendConnectionOptions, frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { frontendAdmissionTargetSha256, FRONTEND_PREPARATION_ROLES } from "./frontend-admission-bootstrap.mjs";
import { openOwnedFrontendReplacementCluster } from "./harness/owned-frontend-replacement-cluster.mjs";
import { deployProfiledCurrentFrontend, observeProfiledCurrentFrontend,
  readProfiledCurrentWorkloadReceipt, deployProfiledReplacementFrontend, observeProfiledReplacementFrontend,
  readProfiledReplacementWorkloadReceipt, readProfiledReplacementPromotionReceipt } from "./p2-profiled-current-frontend-adapters.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { P2_PROFILED_CURRENT_LOCK_APPLICATION } from "./p2-profiled-current-probe.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const names = ["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem", "tls/gateway/ca.pem",
  "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem", "tls/community/key.pem",
  "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env", "community-api.env",
  "community-worker.env", "course-media.env", "course-export-cleanup.env"];

const runtimeUrl = "postgresql://frontend_runtime:private@db.example.com/frontend?sslmode=verify-full";
const runtimeOid = "17001", databaseOid = "17002", heldPid = 1000;
const privateProvider = frontendRuntimeDatabaseUrl => ({ version: 2, qualificationTargetProfile: profile,
  vercelToken: "private", frontendRuntimeDatabaseUrl, bindings: {} });

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
    sourceCommit, targetSha256, expectedEpoch: "7", runtimeProducerSha256: producer, owner: { name: "admission_owner", oid: "17003" },
    producers: [{ producerSha256: producer, role: { name: target.runtimeRole, oid: runtimeOid } }],
    historicalLogins: { retiredLogins: [] }, certification: structuredClone(P2_CERTIFICATION_PROFILE) };
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
    if (sql.includes("pg_stat_activity")) return { rows: [{ count: 0 }] };
    if (sql.includes("FROM frontend_admission.producers")) return { rows: [{ producer_sha256: producer, source_sha: sourceCommit, role_oid: runtimeOid }] };
    if (sql.includes("AS migration_lock")) return { rows: [{ pid: heldPid, username: target.user, login: target.user,
      database: target.database, database_oid: databaseOid, major: target.serverMajor, read_only: "on", runtime_oid: runtimeOid, migration_lock: true }] };
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

const verifiedWorker = String.raw`#!/usr/bin/python3
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

async function withWorker(directory, program, run) {
  const bin = join(directory, "bin"), previousPath = process.env.PATH;
  mkdirSync(bin, { mode: 0o700 });
  try {
    writeFileSync(join(bin, "python3"), program, { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath}`;
    return await run();
  } finally { process.env.PATH = previousPath; }
}

function mockRuntime(t, readIdentity) {
  t.mock.method(Client.prototype, "connect", async function () {
    assert.equal(this.connectionParameters.ssl.rejectUnauthorized, true);
    assert.match(this.connectionParameters.options, /default_transaction_read_only=on/u);
    Object.assign(this.connection.stream, { encrypted: true, authorized: true });
  });
  t.mock.method(Client.prototype, "query", async function (sql, values) {
    assert.match(sql, /FROM pg_catalog.pg_database/u);
    assert.deepEqual(values, ["frontend_runtime", heldPid, FRONTEND_MIGRATION_LOCK]);
    return { rows: [readIdentity()] };
  });
  t.mock.method(Client.prototype, "end", async () => {});
}

const runtimeIdentity = () => ({ pid: heldPid + 1, username: "frontend_runtime", login: "frontend_runtime", database: "frontend",
  database_oid: databaseOid, major: 18, read_only: "on", runtime_oid: runtimeOid, migration_lock: true });

function replacementFixture(t) {
  const f = fixture(), { context } = f, { plan, job, candidate } = context;
  const roles = FRONTEND_PREPARATION_ROLES;
  const artifact = frontendMigrationArtifact();
  const { sqlArtifactSha256, contractManifestSha256, contractPhase, phase2ContractManifestSha256 } = artifact;
  const contracts = { contractManifestSha256, contractPhase, phase2ContractManifestSha256 };
  const baseline = { version: 1, serverMajor: job.target.serverMajor, sqlArtifactSha256,
    catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions",
      "enums", "sequences", "policies"].map(key => [key, []])) };
  const schemaBaselineSha256 = sha(JSON.stringify(baseline)), migrationImageDigest = "sha256:" + "b".repeat(64);
  Object.assign(job.target, { runtimeRole: roles.runtime, allowEmptyBootstrap: true,
    approvedPendingTags: artifact.migrations.map(({ tag }) => tag) });
  Object.assign(job, { ...contracts, operator: "Dardan", migrationImageDigest, sqlArtifactSha256, schemaBaselineSha256,
    recoveryRef: "owned/previous" });
  Object.assign(candidate, contracts, { integration: { state: "passed" },
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    artifacts: { frontendMigration: { image: "ghcr.io/princessdardan/lash-her-platform-frontend-migration@" + migrationImageDigest } } });
  Object.assign(candidate.frontendMigration, contracts, { sqlArtifactSha256, sourceCommit: job.sourceCommit,
    schemaBaselines: { [job.target.serverMajor]: schemaBaselineSha256 } });
  const targetSha256 = frontendAdmissionTargetSha256("staging", job.target);
  const gatewayObservation = { owned: true };
  Object.assign(plan, { targetSha256, expectedEpoch: "1", configurationSha256: context.configurationSha256,
    predecessorDeploymentId: "dpl_reviewedPredecessor",
    owner: { name: roles.owner, oid: plan.owner.oid }, restoration: { gatewayBindingSha256: sha(JSON.stringify(gatewayObservation)) } });
  plan.producers[0].role.name = roles.runtime;
  delete plan.historicalLogins;
  Object.assign(context.bootstrapRuntimeTarget, { targetSha256, user: roles.runtime });
  Object.assign(context, { inventorySha256: sha(JSON.stringify(plan)),
    admissionObservation: { epoch: "1", newWork: false, recovery: false, operations: 0 },
    replacementProbe: { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
      candidate, job, baseline, predecessorTarget: { host: "prior.example.com", port: job.target.port, database: "previous",
        user: job.target.user, runtimeRole: "previous_runtime", serverMajor: job.target.serverMajor },
      targetSha256, databaseOid, migrationRoleOid: "17004", marker: "d".repeat(64),
      backendPid: heldPid, backendStart: "2026-11-09T12:00:00.000000Z" },
    replacementProvenance: Object.fromEntries(["postflightSha256", "reviewedPlanSha256", "runtimeReviewSha256",
      "runtimeOutcomeSha256", "migrationOutcomeSha256"].map((key, index) => [key, String(index + 1).repeat(64)])) });
  const provider = { version: 2, qualificationTargetProfile: profile, vercelToken: "private", bindings: { gatewayObservation } };
  let providerReads = 0, lockReads = 0, activeRows = [], observedOid = databaseOid, observedLocks = 2, actualRuntime = runtimeOid;
  context.getProviderContext = () => { providerReads++; return provider; };
  const minted = runtimeUrl.replace("frontend_runtime:", roles.runtime + ":");
  Object.defineProperty(context, "frontendRuntimeDatabaseUrl", { value: minted, configurable: true });
  const migration = new Client(frontendConnectionOptions(runtimeUrl.replace("frontend_runtime:", "operator:"), job.target));
  Object.assign(migration.connection.stream, { encrypted: true, authorized: true });
  context.databaseClient = migration;
  t.mock.method(Client.prototype, "connect", async function () {
    assert.equal(this.connectionParameters.user, roles.runtime);
    assert.match(this.connectionParameters.options, /default_transaction_read_only=on/u);
    Object.assign(this.connection.stream, { encrypted: true, authorized: true });
  });
  t.mock.method(Client.prototype, "query", async function (sql) {
    if (this !== migration) return { rows: [{ ...runtimeIdentity(), username: roles.runtime, login: roles.runtime, runtime_oid: actualRuntime }] };
    if (sql.includes("pg_stat_activity")) {
      lockReads++;
      return { rows: [{ role: job.target.user, login: job.target.user, database: job.target.database, major: job.target.serverMajor,
        pid: heldPid, current_pid: heldPid, backend_start: context.replacementProbe.backendStart, application_name: P2_PROFILED_CURRENT_LOCK_APPLICATION,
        usename: job.target.user, role_oid: context.replacementProbe.migrationRoleOid, datname: job.target.database,
        database_oid: observedOid, locks: observedLocks }] };
    }
    if (sql.includes("nspowner")) return { rows: [{ oid: plan.owner.oid }] };
    if (sql.includes("FROM frontend_admission.control")) return { rows: [{ singleton: true, environment: "staging",
      target_sha256: targetSha256, epoch: "1", new_work: false, recovery: false }] };
    if (sql.includes("FROM frontend_admission.producers")) return { rows: [{ producer_sha256: plan.runtimeProducerSha256,
      source_sha: job.sourceCommit, role_oid: runtimeOid, enabled: true }] };
    if (sql.includes("FROM frontend_admission.operations")) return { rows: activeRows };
    return { rows: [] };
  });
  t.mock.method(Client.prototype, "end", async () => {});
  return { ...f, provider, minted, counts: () => ({ providerReads, lockReads }),
    drift(value) {
      ({ observedOid = databaseOid, observedLocks = 2, actualRuntime = runtimeOid, activeRows = [] } = value);
    } };
}

const replacementWorker = verifiedWorker.replace("print(json.dumps({'type':'result','value':r}),flush=True)", String.raw`
import hashlib,pathlib
assert p['operation'] in ('replacement-deploy','replacement-observe')
assert p['job']['target']['allowEmptyBootstrap'] is True and p['job']['target']['approvedPendingTags']
assert p['plan']['predecessorDeploymentId']=='dpl_reviewedPredecessor'
assert ('frontendRuntimeDatabaseUrl' in p)==(p['operation']=='replacement-deploy')
selected=p['plan'].get('initializeStagingCronSecret') is True
assert ('stagingCronSecret' in p)==(p['operation']=='replacement-deploy' and selected)
if p['operation']=='replacement-deploy':
 assert p['frontendRuntimeDatabaseUrl'].startswith('postgresql://lash_her_frontend_staging_runtime_p2:')
 if selected: assert p['stagingCronSecret']=='owned-staging-cron-secret-'+('x'*32)
folder=pathlib.Path(p['directory'])/'vercel'
workload=hashlib.sha256((folder/'frontend-workload-outcome.json').read_bytes()).hexdigest()
promotion=hashlib.sha256((folder/'frontend-promotion-outcome.json').read_bytes()).hexdigest()
r.update(p['replacementProvenance'])
r.update(status='P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED',frontendSqlApplied=True,frontendSqlReplayed=False,
         workloadReceiptSha256=workload,configurationRecordSha256=workload,frontendPromotionReceiptSha256=promotion)
print(json.dumps({'type':'result','value':r}),flush=True)
`);

test("replacement worker preserves apply-forward identity, held locks, and raw workload and promotion receipts", async t => {
  const f = replacementFixture(t);
  try {
    f.context.plan.initializeStagingCronSecret = true;
    f.context.inventorySha256 = sha(JSON.stringify(f.context.plan));
    const stagingCronSecret = "owned-staging-cron-secret-" + "x".repeat(32);
    Object.defineProperty(f.context, "stagingCronSecret", { value: stagingCronSecret, configurable: true });
    const directory = join(f.context.directory, "vercel");
    mkdirSync(directory, { mode: 0o700 });
    const workload = Buffer.from('{"fixture":"workload"}\n'), promotion = Buffer.from('{"fixture":"promotion"}\n');
    writeFileSync(join(directory, "frontend-workload-outcome.json"), workload, { mode: 0o600 });
    writeFileSync(join(directory, "frontend-promotion-outcome.json"), promotion, { mode: 0o600 });
    await withWorker(f.context.directory, replacementWorker, async () => {
      const deployed = await deployProfiledReplacementFrontend(f.context);
      assert.equal(deployed.status, "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED");
      assert.equal(deployed.frontendSqlApplied, true);
      assert.equal(deployed.frontendSqlReplayed, false);
      assert.equal(deployed.evidenceSha256, sha(deployed.evidence));
      assert.ok(!deployed.evidence.includes(f.minted));
      assert.ok(!deployed.evidence.includes(stagingCronSecret));
      for (const [name, value] of Object.entries(f.context.replacementProvenance)) assert.equal(deployed[name], value);
      delete f.context.frontendRuntimeDatabaseUrl;
      delete f.context.stagingCronSecret;
      const observed = await observeProfiledReplacementFrontend(f.context);
      assert.deepEqual(observed, deployed);
      assert.deepEqual(readProfiledReplacementWorkloadReceipt(f.context, observed), workload);
      assert.deepEqual(readProfiledReplacementPromotionReceipt(f.context, observed), promotion);
      writeFileSync(join(directory, "frontend-promotion-outcome.json"), Buffer.from("{}\n"));
      assert.throws(() => readProfiledReplacementPromotionReceipt(f.context, observed), /REVIEW_REQUIRED/u);
      assert.deepEqual(f.counts(), { providerReads: 2, lockReads: 16 });
    });
  } finally { f.cleanup(); }
});

test("replacement worker refuses current-only inputs, wrong provenance, physical drift, provider credentials and runtime role drift", async t => {
  const f = replacementFixture(t);
  try {
    const { context } = f, marker = join(context.directory, "worker-started");
    await withWorker(context.directory, `#!/usr/bin/python3\nopen(${JSON.stringify(marker)}, 'w').close()\nraise SystemExit(1)\n`, async () => {
      await assert.rejects(deployProfiledCurrentFrontend(context), /REVIEW_REQUIRED/u);
      await assert.rejects(deployProfiledReplacementFrontend({ ...context, replacementProvenance: {} }), /REVIEW_REQUIRED/u);
      Object.defineProperty(context, "stagingCronSecret", { value: "owned-staging-cron-secret-" + "x".repeat(32), configurable: true });
      await assert.rejects(deployProfiledReplacementFrontend(context), /REVIEW_REQUIRED/u);
      delete context.stagingCronSecret;
      context.plan.initializeStagingCronSecret = true;
      context.inventorySha256 = sha(JSON.stringify(context.plan));
      await assert.rejects(deployProfiledReplacementFrontend(context), /REVIEW_REQUIRED/u);
      context.plan.initializeStagingCronSecret = false;
      context.inventorySha256 = sha(JSON.stringify(context.plan));
      await assert.rejects(deployProfiledReplacementFrontend(context), /REVIEW_REQUIRED/u);
      delete context.plan.initializeStagingCronSecret;
      context.inventorySha256 = sha(JSON.stringify(context.plan));
      const { predecessorDeploymentId, ...unboundPlan } = context.plan;
      assert.equal(predecessorDeploymentId, "dpl_reviewedPredecessor");
      await assert.rejects(deployProfiledReplacementFrontend({ ...context, plan: unboundPlan,
        inventorySha256: sha(JSON.stringify(unboundPlan)) }), /REVIEW_REQUIRED/u);
      for (const drift of [{ observedOid: "99" }, { observedLocks: 1 }, { activeRows: [{ "?column?": 1 }] }, { actualRuntime: "99" }]) {
        f.drift(drift);
        await assert.rejects(deployProfiledReplacementFrontend(context), /REVIEW_REQUIRED/u);
      }
      assert.equal(f.counts().providerReads, 0);
      f.drift({});
      const getProviderContext = context.getProviderContext;
      context.getProviderContext = () => ({ ...f.provider, frontendRuntimeDatabaseUrl: f.minted });
      await assert.rejects(deployProfiledReplacementFrontend(context), /REVIEW_REQUIRED/u);
      context.getProviderContext = getProviderContext;
      Object.defineProperty(context, "frontendRuntimeDatabaseUrl", { value: f.minted, enumerable: true });
      await assert.rejects(deployProfiledReplacementFrontend(context), /REVIEW_REQUIRED/u);
      assert.throws(() => readFileSync(marker), { code: "ENOENT" });
    });
  } finally { f.cleanup(); }
});

test("actual child checkpoint protocol rechecks the admission ledger and reaps the worker", async t => {
  const f = fixture();
  try {
    mockRuntime(t, runtimeIdentity);
    f.context.getProviderContext = async () => privateProvider(runtimeUrl);
    await withWorker(f.context.directory, verifiedWorker, async () => {
      const result = await deployProfiledCurrentFrontend(f.context);
      assert.equal(result.status, "P2_PROFILED_CURRENT_FRONTEND_VERIFIED");
      assert.ok(f.counts().queries >= 16);
    });
  } finally { f.cleanup(); }
});

test("worker never starts for a wrong URL target or an independent database binding mismatch", async t => {
  const f = fixture(); let actual = runtimeIdentity();
  try {
    mockRuntime(t, () => actual);
    const marker = join(f.context.directory, "worker-started");
    const refuseIfSpawned = `#!/usr/bin/python3
open(${JSON.stringify(marker)}, 'w').close()
raise SystemExit(1)
`;
    await withWorker(f.context.directory, refuseIfSpawned, async () => {
      for (const value of [runtimeUrl.replace("db.example.com", "old.example.com"), runtimeUrl.replace("/frontend?", "/other?"),
        runtimeUrl.replace("frontend_runtime:", "operator:"), runtimeUrl.replace("verify-full", "require")]) {
        f.context.getProviderContext = async () => privateProvider(value);
        await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
      }
      f.context.getProviderContext = async () => privateProvider(runtimeUrl);
      for (const drift of [{ database_oid: "99" }, { runtime_oid: "99" }, { read_only: "off" }, { migration_lock: false }, { pid: heldPid }]) {
        actual = { ...runtimeIdentity(), ...drift };
        await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
      }
      assert.throws(() => readFileSync(marker), { code: "ENOENT" });
    });
  } finally { f.cleanup(); }
});

test("owned TLS PostgreSQL joins a real read-only migration lock and runtime login before provider effects", {
  skip: process.env.P2_PROFILED_CURRENT_OWNED_TEST !== "true", timeout: 90_000,
}, async () => {
  const f = fixture(), directory = f.context.directory, key = join(directory, "server.key"), cert = join(directory, "server.crt");
  const pgBin = process.env.PG_BIN, major = Number(process.env.OWNED_POSTGRES_MAJOR), originalCa = getCACertificates("default");
  assert.ok(pgBin?.startsWith("/") && [16, 18].includes(major));
  let cluster, setup, migration;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    chmodSync(key, 0o600);
    setDefaultCACertificates([...originalCa, readFileSync(cert, "utf8")]);
    const data = join(directory, "cluster"); mkdirSync(data, { mode: 0o700 });
    cluster = await openOwnedFrontendReplacementCluster(data, pgBin, "owned_frontend_admin", key, cert);
    setup = await cluster.connect("postgres");
    const password = randomUUID(), runtimePassword = randomUUID(), { job, plan, bootstrapRuntimeTarget } = f.context;
    const database = { host: "127.0.0.1", port: cluster.port, database: "postgres", serverMajor: major };
    Object.assign(job.target, database);
    Object.assign(bootstrapRuntimeTarget, database);
    await setup.query(`CREATE ROLE operator LOGIN NOINHERIT PASSWORD '${password}';
      CREATE ROLE frontend_runtime LOGIN PASSWORD '${runtimePassword}'; CREATE ROLE admission_owner NOLOGIN;
      GRANT admission_owner TO operator;
      CREATE SCHEMA frontend_admission AUTHORIZATION admission_owner; SET ROLE admission_owner;
      CREATE TABLE frontend_admission.control(singleton boolean, environment text, target_sha256 text, epoch integer, new_work boolean, recovery boolean);
      CREATE TABLE frontend_admission.operations(state text);
      CREATE TABLE frontend_admission.producers(producer_sha256 text, source_sha text, database_role oid, enabled boolean); RESET ROLE;`);
    const roles = (await setup.query("SELECT rolname,oid::text FROM pg_roles WHERE rolname IN ('admission_owner','frontend_runtime')")).rows;
    const oids = Object.fromEntries(roles.map(row => [row.rolname, row.oid]));
    plan.owner.oid = oids.admission_owner; plan.producers[0].role.oid = oids.frontend_runtime;
    f.context.inventorySha256 = sha(JSON.stringify(plan));
    await setup.query("INSERT INTO frontend_admission.control VALUES(true,'staging',$1,7,false,false)", [plan.targetSha256]);
    await setup.query("INSERT INTO frontend_admission.producers VALUES($1,$2,$3,true)", [plan.runtimeProducerSha256, plan.sourceCommit, oids.frontend_runtime]);
    const suffix = `@${database.host}:${database.port}/${database.database}?sslmode=verify-full`;
    migration = new Client(frontendConnectionOptions(`postgresql://operator:${password}${suffix}`, job.target));
    await migration.connect();
    await migration.query("SELECT pg_advisory_lock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    f.context.databaseClient = migration;
    f.context.getProviderContext = async () => privateProvider(`postgresql://frontend_runtime:${runtimePassword}${suffix}`);
    await withWorker(directory, verifiedWorker, async () => {
      assert.equal((await migration.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
      assert.equal((await deployProfiledCurrentFrontend(f.context)).status, "P2_PROFILED_CURRENT_FRONTEND_VERIFIED");
      f.context.getProviderContext = async () => privateProvider(`postgresql://frontend_runtime:invalid${suffix}`);
      await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
      f.context.getProviderContext = async () => privateProvider(`postgresql://frontend_runtime:${runtimePassword}${suffix}`);
      await migration.query("SELECT pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
      await assert.rejects(deployProfiledCurrentFrontend(f.context), /REVIEW_REQUIRED/u);
    });
  } finally {
    try { await migration?.end(); await setup?.end(); }
    finally { await cluster?.stop(); setDefaultCACertificates(originalCa); f.cleanup(); }
  }
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
