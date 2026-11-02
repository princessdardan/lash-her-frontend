import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { frontendMigrationArtifact, prepareFrontendMigration, prepareFrontendMigrationJob, frontendConnectionOptions, runFrontendMigration, writeFrontendReceipt } from "./frontend-migration.mjs";

function fixture() {
  const artifact = frontendMigrationArtifact();
  const candidate = { version: 2, environment: "staging", releaseId: "frontend-fixture", integration: { state: "passed" },
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@sha256:${"b".repeat(64)}` } },
    contractManifestSha256: artifact.contractManifestSha256,
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: "a".repeat(40), requiredChecks: "passed" } } };
  const baseline = { version: 1, serverMajor: 18, sqlArtifactSha256: artifact.sqlArtifactSha256,
    catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums", "sequences", "policies"].map((name) => [name, []])) };
  const job = { version: 1, operator: "Dardan", environment: "staging", releaseId: candidate.releaseId, sourceCommit: "a".repeat(40),
    migrationImageDigest: `sha256:${"b".repeat(64)}`,
    contractManifestSha256: candidate.contractManifestSha256, sqlArtifactSha256: artifact.sqlArtifactSha256,
    schemaBaselineSha256: createHash("sha256").update(JSON.stringify(baseline)).digest("hex"), recoveryRef: "owned/recovery",
    target: { host: "127.0.0.1", port: 5432, database: "frontend_owned", user: "frontend_migration", runtimeRole: "frontend_runtime", serverMajor: 18,
      allowEmptyBootstrap: true, approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  candidate.frontendMigration = { sourceCommit: job.sourceCommit, sqlArtifactSha256: artifact.sqlArtifactSha256,
    contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { 18: job.schemaBaselineSha256 } };
  return { artifact, candidate, job, baseline };
}

function runner(f, overrides = {}) {
  const records = [], calls = [], state = { locked: false, ended: false, created: false };
  const client = { connection: { stream: { encrypted: true, authorized: true } },
    connect: async () => {}, end: async () => { state.ended = true; },
    query: async (sql) => {
      calls.push(sql);
      let rows = [];
      if (sql.startsWith("select pg_backend_pid")) rows = [{ pid: 123, current_user: f.job.target.user, database: f.job.target.database, major: 18 }];
      else if (sql.startsWith("select pg_try_advisory_lock")) { state.locked = true; rows = [{ locked: true }]; }
      else if (sql.startsWith("select pg_advisory_unlock")) state.locked = false;
      else if (sql.startsWith("select to_regclass")) rows = [{ present: false }];
      else if (sql.startsWith("select count(*)")) rows = [{ count: 0 }];
      else if (sql.includes("from pg_roles")) rows = [Object.fromEntries(["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "migration_member", "ddl"].map((name) => [name, false]))];
      else if (sql.startsWith("select hash, created_at")) rows = f.artifact.migrations.map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis }));
      else if (sql.includes("as journal_access")) rows = [{ journal_access: false }];
      else if (sql.includes("from pg_default_acl")) rows = [...["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => ({ kind: "r", privilege })), ...["SELECT", "USAGE"].map((privilege) => ({ kind: "S", privilege }))];
      return { rows };
    } };
  const dependencies = { confirmation: `staging/${f.job.releaseId}`, assertSource: () => {},
    getUrl: () => "postgresql://frontend_migration:owned-private-marker@127.0.0.1:5432/frontend_owned?sslmode=verify-full",
    createClient: () => { state.created = true; return client; }, record: (name, value) => {
      if (name === "database-receipt.json") assert.equal(state.locked && !state.ended, true);
      if (name === "job-outcome.json") assert.equal((!state.created || state.ended) && !state.locked, true);
      records.push({ name, value });
    }, ...overrides };
  return { dependencies, client, calls, records, state, run: () => runFrontendMigration(prepareFrontendMigration(f.candidate, f.job, f.baseline, f.artifact), dependencies) };
}

test("frontend preparation binds exact source, target and reviewed SQL/schema without credentials", () => {
  const f = fixture(), prepared = prepareFrontendMigration(f.candidate, f.job, f.baseline, f.artifact);
  assert.equal(prepared.artifact.migrations.length, f.artifact.manifest.entries.length);
  assert.equal(prepared.job.sourceCommit, f.candidate.sources.frontend.commit);
  for (const mutate of [(x) => x.job.sourceCommit = "b".repeat(40), (x) => x.job.target.host = "wrong-pooler.example.invalid",
    (x) => x.job.sqlArtifactSha256 = "0".repeat(64), (x) => x.baseline.catalog.functions = undefined,
    (x) => x.job.target.user = x.job.target.runtimeRole]) {
    const copy = structuredClone(f); mutate(copy);
    assert.throws(() => prepareFrontendMigration(copy.candidate, copy.job, copy.baseline, copy.artifact));
  }
});

test("frontend credential parsing requires exact identity and explicit verified TLS", () => {
  const f = fixture(), valid = "postgresql://frontend_migration:owned-private-marker@127.0.0.1:5432/frontend_owned?sslmode=verify-full";
  assert.equal(frontendConnectionOptions(valid, f.job.target).ssl.rejectUnauthorized, true);
  for (const value of [valid.replace("verify-full", "require"), valid.replace("frontend_migration", "frontend_runtime"), valid.replace("frontend_owned?", "other?"), valid + "&sslmode=disable", undefined]) {
    assert.throws(() => frontendConnectionOptions(value, f.job.target), (error) => !error.message.includes("owned-private-marker"));
  }
});

test("frontend job assembly derives reviewed bindings without copying credentials", () => {
  const f = fixture();
  const exported = { status: "FRONTEND_MIGRATION_OWNED_POSTGRES_PASS", providerTouched: false, postgresMajor: 18, schemaBaseline: f.baseline };
  const prepared = prepareFrontendMigrationJob(f.candidate, { ...f.job.target, recoveryRef: f.job.recoveryRef, password: "must-not-copy" }, exported);
  assert.equal(prepared.job.sqlArtifactSha256, f.artifact.sqlArtifactSha256);
  assert.equal(prepared.job.schemaBaselineSha256, f.job.schemaBaselineSha256);
  assert.ok(!JSON.stringify(prepared).includes("must-not-copy"));
});

test("frontend confirmation and source qualification precede credential acquisition", async () => {
  const f = fixture(); let acquired = false;
  const unconfirmed = runner(f, { confirmation: "production/other", getUrl: () => { acquired = true; } });
  await assert.rejects(unconfirmed.run()); assert.equal(acquired, false);
  const dirty = runner(f, { assertSource: () => { throw new Error("dirty"); }, getUrl: () => { acquired = true; } });
  await assert.rejects(dirty.run()); assert.equal(acquired, false);
  assert.equal(dirty.records.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
});

test("frontend apply uses one locked session, records before unlock and separates terminal completion", async () => {
  const f = fixture(), r = runner(f); const result = await r.run();
  assert.equal(result.status, "DATABASE_VERIFIED"); assert.equal(result.trafficAuthorized, false);
  assert.equal(r.records[0].value.schemaVerified, true);
  assert.equal(r.records[0].value.applied.length, f.artifact.migrations.length);
  assert.ok(!JSON.stringify(r.records).includes("owned-private-marker"));
  assert.equal(r.calls.filter((sql) => sql === "begin").length, f.artifact.migrations.length);
});

test("frontend lock contention, pending mismatch and apply errors stop without successful database receipt", async () => {
  for (const mode of ["contention", "pending", "apply"]) {
    const f = fixture(); if (mode === "pending") f.job.target.approvedPendingTags = [];
    const r = runner(f), original = r.client.query;
    r.client.query = async (sql) => {
      if (mode === "contention" && sql.startsWith("select pg_try_advisory_lock")) return { rows: [{ locked: false }] };
      if (mode === "apply" && sql === f.artifact.migrations[0].sql[0]) throw new Error("owned-private-marker");
      return original(sql);
    };
    await assert.rejects(r.run(), (error) => !error.message.includes("owned-private-marker"));
    assert.equal(r.records.some((record) => record.name === "database-receipt.json"), false);
    assert.equal(r.records.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
    if (mode !== "apply") assert.equal(r.calls.some((sql) => sql.startsWith("create schema")), false);
  }
});

test("frontend postflight schema/default-grant failures and disconnect failure cannot qualify completion", async () => {
  for (const mode of ["schema", "grants", "cleanup"]) {
    const f = fixture(), r = runner(f), original = r.client.query;
    r.client.query = async (sql) => {
      if (mode === "schema" && sql.includes("p.proname")) return { rows: [{ unexpected: true }] };
      if (mode === "grants" && sql.includes("from pg_default_acl")) return { rows: [] };
      return original(sql);
    };
    if (mode === "cleanup") r.client.end = async () => { r.state.ended = true; throw new Error("cleanup"); };
    await assert.rejects(r.run()); assert.equal(r.records.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
    assert.equal(r.records.some((record) => record.name === "database-receipt.json"), mode === "cleanup");
  }
});

test("frontend production refuses missing or failed staging migration evidence", () => {
  const f = fixture(); f.candidate.environment = f.job.environment = "production";
  assert.throws(() => prepareFrontendMigration(f.candidate, f.job, f.baseline, f.artifact));
  const binding = { version: 1, service: "frontend", environment: "staging", releaseId: "prior-staging", sourceCommit: f.job.sourceCommit,
    migrationImageDigest: f.job.migrationImageDigest,
    target: { host: "staging.example.invalid", database: "staging" }, sqlArtifactSha256: f.job.sqlArtifactSha256,
    contractManifestSha256: f.job.contractManifestSha256, schemaBaselineSha256: f.job.schemaBaselineSha256 };
  f.job.stagingVerification = { database: { ...binding, status: "DATABASE_VERIFIED", schemaVerified: true, runtimeRoleVerified: true },
    terminal: { ...binding, status: "DATABASE_VERIFIED" } };
  assert.doesNotThrow(() => prepareFrontendMigration(f.candidate, f.job, f.baseline, f.artifact));
  f.job.stagingVerification.terminal.releaseId = "substituted";
  assert.throws(() => prepareFrontendMigration(f.candidate, f.job, f.baseline, f.artifact));
  f.job.stagingVerification.terminal.releaseId = binding.releaseId;
  f.job.stagingVerification.terminal.failureCode = "cleanup";
  assert.throws(() => prepareFrontendMigration(f.candidate, f.job, f.baseline, f.artifact));
});

test("frontend receipts are exclusive and contain complete parseable JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "frontend-receipt-"));
  try {
    writeFrontendReceipt(directory, "outcome.json", { status: "first" });
    assert.throws(() => writeFrontendReceipt(directory, "outcome.json", { status: "second" }));
    assert.equal(JSON.parse(readFileSync(join(directory, "outcome.json"), "utf8")).status, "first");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy frontend migration writes refuse release targets and remote local-label bypasses", () => {
  for (const target of ["staging", "production", "local"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-private-db.ts"], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/dev/null", DATABASE_URL: "postgresql://owner:owned-private-marker@remote.example.invalid/neondb?sslmode=verify-full",
        PRIVATE_DB_MIGRATION_TARGET: target, PRIVATE_DB_MIGRATION_HOST: "remote.example.invalid", PRIVATE_DB_MIGRATION_CONFIRM: "production" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, target === "local" ? /Local migrations require an isolated loopback database/u : /Release targets require the reviewed operator/u);
    assert.ok(!result.stderr.includes("owned-private-marker"));
  }
});
