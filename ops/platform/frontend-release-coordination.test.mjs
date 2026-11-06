import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { frontendMigrationArtifact, prepareFrontendMigration } from "./frontend-migration.mjs";
import { bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact, frontendAdmissionTargetSha256, prepareFrontendAdmissionBootstrap } from "./frontend-admission-bootstrap.mjs";
import { frontendCandidateSurfaces, frontendCoordinationHash as hash, prepareFrontendReleaseInventory, prepareFrontendReleaseRoleTemplate, validateFrontendFenceObservation } from "./frontend-release-inventory.mjs";
import { frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { loadFrontendReleaseAdapters } from "./frontend-release-coordinator.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";

const directory = () => realpathSync(mkdtempSync(join(tmpdir(), "frontend-release-test-")));
const source = { version: 2, scope: "candidate-source-only", sourceManifestSha256: "1".repeat(64),
  routes: [{ file: "src/app/api/owned/route.ts", methods: ["POST"], sourceSha256: "2".repeat(64) }],
  actionModules: [], renderEntries: [{ file: "src/app/admin/page.tsx", exports: ["default"], runtime: "server", sourceSha256: "8".repeat(64) }],
  manualEntries: [{ file: "scripts/owned.ts", exports: [], sourceSha256: "7".repeat(64) }],
  inlineActions: [], deferredSites: [], databaseConstructors: [], schedules: [{ path: "/api/owned", schedule: "* * * * *" }] };
function fixture() {
  const artifact = frontendMigrationArtifact();
  const baseline = { version: 1, serverMajor: 18, sqlArtifactSha256: artifact.sqlArtifactSha256,
    catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums", "sequences", "policies"].map(key => [key, []])) };
  const job = { version: 1, operator: "Dardan", environment: "staging", releaseId: "owned-release", sourceCommit: "a".repeat(40),
    migrationImageDigest: `sha256:${"b".repeat(64)}`, contractManifestSha256: artifact.contractManifestSha256,
    sqlArtifactSha256: artifact.sqlArtifactSha256, schemaBaselineSha256: hash(baseline), recoveryRef: "owned/recovery",
    target: { host: "owned.invalid", port: 5432, database: "owned", user: "operator", runtimeRole: "runtime", serverMajor: 18,
      allowEmptyBootstrap: true, approvedPendingTags: artifact.migrations.map(m => m.tag) } };
  const candidate = { version: 2, environment: "staging", releaseId: job.releaseId, integration: { state: "passed" },
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: job.sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${job.migrationImageDigest}` } },
    contractManifestSha256: artifact.contractManifestSha256, frontendMigration: { sourceCommit: job.sourceCommit, sqlArtifactSha256: artifact.sqlArtifactSha256,
      contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { 18: job.schemaBaselineSha256 } } };
  const phase2 = { contractPhase: artifact.contractPhase, phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
  for (const value of [candidate, candidate.frontendMigration, job]) Object.assign(value, phase2);
  const inventory = { version: 1, environment: "staging", actionId: job.releaseId, sourceCommit: job.sourceCommit,
    targetSha256: frontendAdmissionTargetSha256("staging", job.target), sourceInventorySha256: hash(source), reviewSha256: "3".repeat(64), adaptersSha256: "4".repeat(64),
    observationBudgetSeconds: 300, admissionMode: "bootstrap", bootstrapSqlSha256: frontendAdmissionBootstrapArtifact().sqlSha256,
    bootstrapCompatibility: { version: 1, schemaCatalogSha256: hash(baseline.catalog), appliedLineageSha256: hash([]), appliedCount: 0,
      validationEvidenceSha256: "9".repeat(64), runtimeProducerSha256: "5".repeat(64), recoveryAfterCompatibleBuild: false },
    expectedEpoch: "1", owner: { name: "admission_owner", oid: "100" },
    producers: [{ producerSha256: "5".repeat(64), role: { name: "runtime", oid: "101" } }],
    candidateCoverage: frontendCandidateSurfaces(source).map(row => ({ surfaceSha256: row.surfaceSha256, disposition: "admitted", producerSha256: "5".repeat(64), evidenceSha256: "6".repeat(64) })),
    externalSurfaces: ["deployment", "provider", "scheduler", "direct-caller"].map((kind, i) => {
      const identitySha256 = String(i + 1).repeat(64); return { kind, identitySha256, surfaceSha256: hash({ kind, identitySha256 }) };
    }), historicalLogins: { version: 1, environment: "staging", actionId: job.releaseId, sourceCommit: job.sourceCommit, clusterScopeSha256: "7".repeat(64),
      target: { ...job.target, currentRuntimeRole: "runtime", admissionOwnerRole: "admission_owner" }, retiredLogins: [{ name: "old_runtime", oid: "102" }] } };
  const migration = prepareFrontendMigration(candidate, job, baseline, artifact);
  const plan = prepareFrontendReleaseInventory(inventory, migration, source);
  const bootstrap = { version: 1, environment: "staging", actionId: plan.actionId, sourceCommit: plan.sourceCommit, ...frontendAdmissionBootstrapArtifact(),
    inventorySha256: hash(plan), targetSha256: plan.targetSha256, target: job.target, owner: plan.owner,
    producers: plan.producers.map(p => ({ ...p, sourceCommit: plan.sourceCommit })) };
  return { source, artifact, migration, inventory, plan, bootstrap };
}

test("pure inventory requires complete exact-source coverage, all external surface classes and exact protected targets", () => {
  const f = fixture();
  for (const change of [i => { i.environment = "production"; }, i => { i.targetSha256 = "f".repeat(64); },
    i => { i.sourceCommit = "f".repeat(40); }, i => { i.candidateCoverage.pop(); }, i => { i.candidateCoverage[1] = i.candidateCoverage[0]; },
    i => { i.externalSurfaces.pop(); }, i => { i.adaptersSha256 = "0".repeat(64); }, i => { i.observationBudgetSeconds = 301; },
    i => { delete i.bootstrapCompatibility; }, i => { i.bootstrapCompatibility.runtimeProducerSha256 = "f".repeat(64); },
    i => { i.bootstrapCompatibility.appliedLineageSha256 = "0".repeat(64); }, i => { i.bootstrapCompatibility.recoveryAfterCompatibleBuild = "true"; },
    i => { i.historicalLogins.target.user = "other"; }, i => { i.candidateCoverage[0].producerSha256 = "f".repeat(64); }]) {
    const inventory = structuredClone(f.inventory); change(inventory);
    assert.throws(() => prepareFrontendReleaseInventory(inventory, f.migration, f.source));
  }
  const changedSource = structuredClone(f.source); changedSource.routes[0].sourceSha256 = "f".repeat(64);
  assert.throws(() => prepareFrontendReleaseInventory(f.inventory, f.migration, changedSource));
  for (const key of ["renderEntries", "manualEntries"]) {
    const incomplete = structuredClone(f.source); delete incomplete[key];
    assert.throws(() => frontendCandidateSurfaces(incomplete));
    const omitted = structuredClone(f.source); omitted[key] = [];
    assert.throws(() => prepareFrontendReleaseInventory(f.inventory, f.migration, omitted));
  }
  assert.throws(() => frontendCandidateSurfaces({ ...f.source, version: 1 }));
  const input = structuredClone(f.inventory); input.password = "private-marker"; input.externalSurfaces[0].password = "private-marker";
  assert.equal(JSON.stringify(prepareFrontendReleaseInventory(input, f.migration, f.source)).includes("private-marker"), false);
});

test("desired role templates contain no invented OIDs and cannot execute as observed inventories", () => {
  const f = fixture(), input = structuredClone(f.inventory);
  delete input.owner.oid; for (const producer of input.producers) delete producer.role.oid;
  const template = prepareFrontendReleaseRoleTemplate(input, f.migration, f.source);
  assert.deepEqual(template.owner, { name: "admission_owner" });
  assert.deepEqual(template.producers[0].role, { name: "runtime" });
  assert.equal(template.roleBindings, "desired-names-only");
  assert.throws(() => prepareFrontendReleaseInventory(template, f.migration, f.source));
  assert.throws(() => prepareFrontendReleaseRoleTemplate(f.inventory, f.migration, f.source));
  const incomplete = structuredClone(input); incomplete.candidateCoverage.pop();
  assert.throws(() => prepareFrontendReleaseRoleTemplate(incomplete, f.migration, f.source));
});

test("bootstrap preparation binds the selected SQL, owner/OIDs, target and source without copying secrets", () => {
  const f = fixture();
  for (const change of [b => { b.owner.name = "runtime"; }, b => { b.producers[0].role.name = "operator"; },
    b => { b.sqlSha256 = "f".repeat(64); }, b => { b.target.host = "owned-pooler.invalid"; },
    b => { b.producers.push(b.producers[0]); }, b => { b.producers[0].role.oid = b.owner.oid; }]) {
    const copy = structuredClone(f.bootstrap); change(copy); assert.throws(() => prepareFrontendAdmissionBootstrap(copy));
  }
  const copy = structuredClone(f.bootstrap); copy.password = "private-marker"; copy.producers[0].password = "private-marker";
  assert.equal(JSON.stringify(prepareFrontendAdmissionBootstrap(copy)).includes("private-marker"), false);
});

function bootstrapRunner() {
  const f = fixture(), calls = [], records = [], state = { installed: false, commits: 0, oid: "101", canLogin: true, existing: false, privileges: false };
  const client = Object.assign(new EventEmitter(), { connection: { stream: { encrypted: true, authorized: true } },
    connectionParameters: { host: "owned.invalid", port: 5432 },
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith("SELECT current_user")) return { rows: [{ username: "operator", session_username: "operator", database: "owned", major: 18, read_only: "off" }] };
      if (sql.startsWith("SELECT oid::text,rolname")) return { rows: [{ oid: "100", rolname: "admission_owner", rolcanlogin: false }, { oid: state.oid, rolname: "runtime", rolcanlogin: state.canLogin }].map(role => ({ ...role,
        ...Object.fromEntries(["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].map(key => [key, false])) })) };
      if (sql.includes("FROM pg_auth_members")) return { rows: [] };
      if (sql.startsWith("SELECT pg_has_role")) return { rows: [{ owner_member: state.privileges, operator_member: false, database_create: false, public_create: false }] };
      if (sql.startsWith("SELECT to_regnamespace")) return { rows: [{ present: state.existing }] };
      if (sql.startsWith("-- Bootstrap artifact")) state.installed = true;
      if (sql === "COMMIT") state.commits++;
      if (sql.startsWith("SELECT nspowner")) return { rows: [{ owner_oid: "100" }] };
      if (sql.startsWith("SELECT environment")) return { rows: [{ environment: "staging", target_sha256: f.plan.targetSha256, epoch: "1", new_work: false, recovery: false }] };
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: 0 }] };
      if (sql.startsWith("SELECT producer_sha256")) return { rows: [{ producer_sha256: f.plan.producers[0].producerSha256, source_sha: f.plan.sourceCommit, role_oid: state.oid, enabled: true }] };
      if (sql.startsWith("SELECT has_schema_privilege")) return { rows: [{ usage: true, ddl: false, tables: false, missing_execute: false }] };
      return { rows: [] };
    } });
  const dependencies = { confirmation: `staging/${f.plan.actionId}`, record(name, value) { records.push({ name, value }); }, verifySession: async () => {} };
  return { ...f, client, calls, records, state, dependencies, run: () => bootstrapFrontendAdmission(f.bootstrap, client, dependencies) };
}

test("bootstrap installs only the independent ledger in one transaction with both controls closed", async () => {
  const f = bootstrapRunner(); const outcome = await f.run();
  assert.equal(f.state.commits, 1); assert.equal(outcome.newWork, false); assert.equal(outcome.recovery, false);
  assert.equal(outcome.migrationAuthorized, false); assert.equal(outcome.trafficAuthorized, false);
  assert.equal(f.calls.some(c => /drizzle|ALTER ROLE|LOGIN|public\./u.test(c.sql)), false);
  assert.equal(f.calls.filter(c => c.sql.startsWith("GRANT EXECUTE")).length, 1);
});

test("bootstrap intent/target/role refusal happens before installation and never resumes an existing schema", async () => {
  for (const change of [f => { f.dependencies.record = () => { throw new Error("private-marker"); }; },
    f => { f.client.connection.stream.authorized = false; }, f => { f.state.oid = "999"; },
    f => { f.state.canLogin = false; }, f => { f.state.existing = true; }, f => { f.state.privileges = true; }]) {
    const f = bootstrapRunner(); change(f); await assert.rejects(f.run(), /FRONTEND_ADMISSION_BOOTSTRAP_FAILED_REVIEW_REQUIRED/u);
    assert.equal(f.state.installed, false); assert.equal(f.state.commits, 0);
    assert.equal(JSON.stringify(f.records).includes("private-marker"), false);
  }
});

test("lost bootstrap commit acknowledgement preserves the installed schema without retry or reopening", async () => {
  const f = bootstrapRunner(), query = f.client.query;
  f.client.query = async (...args) => { const result = await query(...args); if (args[0] === "COMMIT") throw new Error("private-marker"); return result; };
  await assert.rejects(f.run(), /FRONTEND_ADMISSION_BOOTSTRAP_FAILED_REVIEW_REQUIRED/u);
  assert.equal(f.state.installed, true); assert.equal(f.state.commits, 1);
  assert.equal(f.records.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
  assert.equal(f.calls.filter(c => c.sql.startsWith("-- Bootstrap artifact")).length, 1);
});

function observation(plan, nonce) {
  return { version: 1, nonce, actionId: plan.actionId, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256, inventorySha256: hash(plan),
    surfaces: plan.externalSurfaces.map(surface => {
      const observation = Buffer.from(JSON.stringify({ surfaceSha256: surface.surfaceSha256, credentialState: "retired" }));
      const reconciliation = Buffer.from(JSON.stringify({ surfaceSha256: surface.surfaceSha256, effects: "reconciled" }));
      const evidence = Buffer.from(JSON.stringify({ version: 1, nonce, actionId: plan.actionId, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256,
        ...surface, activeExecutions: 0, uncertainEffects: 0, observationSha256: hash(observation), reconciliationSha256: hash(reconciliation),
        state: surface.kind === "provider" ? "credentials-retired-and-effects-reconciled" : surface.kind === "scheduler" ? "disabled-and-running-executions-reconciled" : "retired-and-effects-reconciled" }));
      return { surfaceSha256: surface.surfaceSha256, evidence, evidenceSha256: hash(evidence), observation, reconciliation };
    }) };
}

test("external fence checks require retained exact bytes for every surface and fresh action/target/nonce", async () => {
  const { plan } = fixture(), nonce = "e".repeat(64), retained = [];
  const result = await validateFrontendFenceObservation(plan, nonce, observation(plan, nonce), (name, bytes) => { retained.push({ name, bytes }); });
  assert.equal(result.surfaces.length, plan.externalSurfaces.length); assert.equal(retained.length, plan.externalSurfaces.length * 3);
  for (const change of [o => { o.nonce = "f".repeat(64); }, o => { o.targetSha256 = "f".repeat(64); }, o => { o.surfaces.pop(); },
    o => { o.surfaces[0].evidenceSha256 = "f".repeat(64); }, o => { o.surfaces[0].evidence = Buffer.from("{}"); o.surfaces[0].evidenceSha256 = hash(o.surfaces[0].evidence); },
    o => { const evidence = JSON.parse(o.surfaces[0].evidence.toString()); evidence.uncertainEffects = 1;
      o.surfaces[0].evidence = Buffer.from(JSON.stringify(evidence)); o.surfaces[0].evidenceSha256 = hash(o.surfaces[0].evidence); }]) {
    const observed = observation(plan, nonce); change(observed);
    await assert.rejects(validateFrontendFenceObservation(plan, nonce, observed, () => {}));
  }
  await assert.rejects(validateFrontendFenceObservation(plan, nonce, observation(plan, nonce), () => { throw new Error("storage refused"); }));
  await assert.rejects(validateFrontendFenceObservation(plan, nonce, { historicalWritersFenced: true }, () => {}));
});

test("native flock serializes with other contenders, stays held through asynchronous continuation and refuses inode replacement", async () => {
  const dir = directory(), path = join(dir, "environment.lock");
  try {
    await withFrontendEnvironmentLock(async verify => {
      await verify(); await assert.rejects(withFrontendEnvironmentLock(() => assert.fail("contender entered"), { path }));
      await new Promise(resolve => setTimeout(resolve, 10)); await verify();
    }, { path });
    await withFrontendEnvironmentLock(async verify => { await verify(); }, { path });
    await assert.rejects(withFrontendEnvironmentLock(async verify => {
      rmSync(path); writeFileSync(path, "", { mode: 0o600 }); await verify();
    }, { path }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("private receipt store preserves original exact evidence, rejects reuse/symlinks and cannot write inside checkout", () => {
  const dir = directory(), link = join(dir, "linked.json");
  try {
    const store = frontendReleaseReceiptStore(dir);
    store.record("started.json", { trafficAuthorized: false });
    const bytes = readFrontendReleaseEvidence(dir, "started.json");
    assert.equal(JSON.parse(bytes).trafficAuthorized, false);
    assert.throws(() => store.record("started.json", { trafficAuthorized: true }));
    assert.deepEqual(readFrontendReleaseEvidence(dir, "started.json"), bytes);
    assert.throws(() => frontendReleaseReceiptStore(dir));
    symlinkSync(join(dir, "started.json"), link); assert.throws(() => readFrontendReleaseEvidence(dir, "linked.json"));
    assert.throws(() => frontendReleaseReceiptStore(resolve(fileURLToPath(new URL("../..", import.meta.url)))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unbound fixed adapter hash refuses rather than converting component receipts into SQL authority", async () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  await assert.rejects(loadFrontendReleaseAdapters(root, "a".repeat(64)));
});
