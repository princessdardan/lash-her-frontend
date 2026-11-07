import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendConnectionOptions, frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { verifyEmptyFrontendReplacement } from "./frontend-replacement-boundary.mjs";
import { createP2FrontendReplacementProbe, observeP2FrontendReplacement } from "./p2-frontend-replacement-probe.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = "P2_FRONTEND_REPLACEMENT_PHYSICAL_OBSERVATION_REFUSED";
const artifact = frontendMigrationArtifact();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function input(port = 5432, major = 16) {
  const sourceCommit = "a".repeat(40), releaseId = "owned-replacement";
  const migrationImageDigest = "sha256:" + "b".repeat(64);
  const target = { host: "127.0.0.1", port, database: "owned_replacement", user: "owned_migrator",
    runtimeRole: FRONTEND_PREPARATION_ROLES.runtime, serverMajor: major };
  const predecessorTarget = { ...target, database: "owned_previous", runtimeRole: "owned_previous_runtime" };
  const { sqlArtifactSha256, contractManifestSha256, contractPhase, phase2ContractManifestSha256 } = artifact;
  const baseline = { version: 1, serverMajor: major, sqlArtifactSha256,
    catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions", "enums",
      "sequences", "policies"].map(key => [key, []])) };
  const job = { version: 2, qualificationTargetProfile: profile, operator: "Dardan", environment: "staging", releaseId,
    sourceCommit, contractPhase, phase2ContractManifestSha256, contractManifestSha256, migrationImageDigest, sqlArtifactSha256,
    schemaBaselineSha256: digest(baseline), recoveryRef: "owned/previous",
    target: { ...target, qualificationTargetProfile: profile, allowEmptyBootstrap: true,
      approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId,
    contractPhase, phase2ContractManifestSha256, contractManifestSha256,
    integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: "ghcr.io/princessdardan/lash-her-platform-frontend-migration@" + migrationImageDigest } },
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, sqlArtifactSha256, contractManifestSha256,
      contractPhase, phase2ContractManifestSha256, schemaBaselines: { [major]: job.schemaBaselineSha256 } } };
  return { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    candidate, job, baseline, predecessorTarget, targetSha256: frontendAdmissionTargetSha256("staging", target),
    databaseOid: "42", migrationRoleOid: "43" };
}

function observerCli(raw, env = {}, args = []) {
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    fileURLToPath(new URL("./p2-frontend-replacement-probe.mjs", import.meta.url)), ...args], {
    env: { PATH: process.env.PATH, ...env }, input: typeof raw === "string" ? raw : JSON.stringify(raw),
    encoding: "utf8", timeout: 20000,
  });
}

function refused(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), refusal);
}

test("replacement observer refuses invalid operation and mismatched review bindings before credential resolution", async () => {
  for (const mutate of [
    p => { p.operation = "fence"; },
    p => { p.qualificationTargetProfile = { ...profile, id: "production" }; },
    p => { p.candidate.sources.frontend.commit = "c".repeat(40); },
    p => { p.candidate.frontendMigration.sqlArtifactSha256 = "c".repeat(64); },
    p => { p.job.target.approvedPendingTags.shift(); },
    p => { p.job.target.allowEmptyBootstrap = false; },
    p => { p.baseline.catalog.relations.push("unexpected"); },
    p => { p.targetSha256 = "c".repeat(64); },
    p => { p.predecessorTarget.database = p.job.target.database; },
    p => { p.predecessorTarget.host = "predecessor-pooler.invalid"; },
    p => { p.predecessorTarget.runtimeRole = p.job.target.user; },
    p => { p.job.target.unreviewed = true; },
    p => { p.databaseOid = "4294967296"; },
    p => { p.backendPid = 0; },
    p => { p.backendStart = "yesterday"; },
    p => { p.marker = "0".repeat(64); },
    p => { p.authorityIssued = true; },
  ]) {
    const value = { ...input(), marker: "d".repeat(64), backendPid: 42, backendStart: "2026-11-07T00:00:00.000000Z" };
    mutate(value);
    let credentialRequested = false;
    await assert.rejects(observeP2FrontendReplacement(value, { getUrl() { credentialRequested = true; } }));
    assert.equal(credentialRequested, false);
  }
  refused(observerCli('{"version":1,"version":1}'));
  refused(observerCli({}, {}, ["unreviewed"]));
});

function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, LANG: "C" } });
  assert.equal(result.status, 0, `Owned fixture command failed: ${file}\n${result.stderr ?? ""}`);
  return result.stdout;
}

async function freePort() {
  const server = createServer();
  return await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? fail(error) : done(port));
    });
  });
}

test("owned TLS PostgreSQL observes exact physical locks from a read-only connection and closes before rechecking emptiness", {
  skip: process.env.P2_FRONTEND_REPLACEMENT_PROBE_OWNED_TEST !== "true", timeout: 120000,
}, async () => {
  const bin = process.env.PG_BIN;
  assert.ok(bin && resolve(bin) === bin);
  const major = Number(command(join(bin, "postgres"), ["--version"]).match(/PostgreSQL\) (16|18)\./u)?.[1]);
  assert.ok([16, 18].includes(major));
  const directory = mkdtempSync(join(tmpdir(), "p2-replacement-probe-owned-"));
  const data = join(directory, "pgdata"), cert = join(directory, "server.crt"), key = join(directory, "server.key");
  const passwordFile = join(directory, "password"), password = randomBytes(32).toString("hex");
  const clients = [];
  let running = false;
  try {
    const port = await freePort(), value = input(port, major), { target } = value.job;
    writeFileSync(passwordFile, password + "\n", { mode: 0o600 });
    command("openssl", ["req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-keyout", key,
      "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
    chmodSync(key, 0o600);
    command(join(bin, "initdb"), ["-D", data, "-U", "owned_admin", "--auth-host=scram-sha-256", "--auth-local=trust",
      "--pwfile", passwordFile, "--no-locale"]);
    writeFileSync(join(data, "postgresql.auto.conf"), `ssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\n`);
    command(join(bin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]);
    running = true;
    const url = `postgresql://${target.user}:${password}@${target.host}:${target.port}/${target.database}?sslmode=verify-full`;
    const connect = async options => {
      const client = new Client({ ...options, ssl: { rejectUnauthorized: true, ca: readFileSync(cert, "utf8") } });
      client.on("error", () => {});
      clients.push(client);
      await client.connect();
      return client;
    };
    const admin = await connect({ host: target.host, port, database: "postgres", user: "owned_admin", password });
    await admin.query(`CREATE ROLE owned_migrator LOGIN PASSWORD '${password}'`);
    await admin.query("CREATE DATABASE owned_replacement OWNER owned_migrator");
    await admin.query("CREATE DATABASE owned_previous OWNER owned_admin");
    const migration = await connect({ ...frontendConnectionOptions(url, target), options: "-c timezone=America/Toronto" });
    await migration.query("REVOKE ALL ON DATABASE owned_replacement FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const { rows: [identity] } = await migration.query(`SELECT
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
      (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=session_user) AS "migrationRoleOid",
      (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname='owned_admin') AS admin`);
    Object.assign(value, { databaseOid: identity.databaseOid, migrationRoleOid: identity.migrationRoleOid });
    const verifySession = async () => {};
    const lock = (action, key) => migration.query(`SELECT pg_catalog.pg_advisory_${action}(pg_catalog.hashtext($1))`, [key]);
    const advisoryCount = async () => (await migration.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks
      WHERE pid=pg_backend_pid() AND locktype='advisory'`)).rows[0].n;
    await assert.rejects(createP2FrontendReplacementProbe(value, migration, verifySession), { message: refusal });
    assert.equal(await advisoryCount(), 0);
    await lock("lock", FRONTEND_MIGRATION_LOCK);
    const probe = await createP2FrontendReplacementProbe(value, migration, verifySession);
    assert.equal(await advisoryCount(), 2);

    const env = { NODE_EXTRA_CA_CERTS: cert, FRONTEND_STAGING_MIGRATION_DATABASE_URL: url };
    const result = observerCli(probe, env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: 1, qualificationTargetProfile: profile, operation: value.operation,
      status: "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", environment: "staging", releaseId: value.job.releaseId,
      sourceCommit: value.job.sourceCommit, targetSha256: value.targetSha256, databaseOid: identity.databaseOid,
      migrationRoleOid: identity.migrationRoleOid, marker: probe.marker, backendPid: probe.backendPid, backendStart: probe.backendStart,
      readOnlyVerified: true, authorityIssued: false, trafficAuthorized: false });
    assert.equal(await advisoryCount(), 2);
    const directTarget = Object.fromEntries(Object.keys(value.predecessorTarget).map(field => [field, target[field]]));
    const boundary = await verifyEmptyFrontendReplacement(migration, {
      target: directTarget, predecessorTarget: value.predecessorTarget,
      administrativeLogins: [{ name: "owned_admin", oid: identity.admin }], verifyEnvironment: async () => {}, verifySession,
    });
    assert.equal(boundary.status, "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED");
    assert.equal(boundary.authorityIssued, false);

    for (const altered of [
      { databaseOid: "1" }, { migrationRoleOid: "1" }, { backendStart: "2026-11-07T00:00:00.000000Z" },
      { marker: "f".repeat(64) }, { backendPid: probe.backendPid + 1 },
    ]) refused(observerCli({ ...probe, ...altered }, env));
    refused(observerCli(probe, { ...env, FRONTEND_STAGING_MIGRATION_DATABASE_URL: url.replace("/owned_replacement", "/owned_previous") }));
    refused(observerCli(probe, { FRONTEND_STAGING_MIGRATION_DATABASE_URL: url }));
    await migration.query("SET application_name='other-worker'");
    refused(observerCli(probe, env));
    await migration.query("RESET application_name");
    await lock("unlock", FRONTEND_MIGRATION_LOCK);
    refused(observerCli(probe, env));
    await lock("lock_shared", FRONTEND_MIGRATION_LOCK);
    refused(observerCli(probe, env));
    await lock("unlock_shared", FRONTEND_MIGRATION_LOCK);
    await lock("lock", FRONTEND_MIGRATION_LOCK);
    await lock("unlock", probe.marker);
    refused(observerCli(probe, env));
    const stale = await createP2FrontendReplacementProbe(value, migration, verifySession);
    await migration.end();
    refused(observerCli(stale, env));
  } finally {
    for (const client of clients) try { await client.end(); } catch { /* owned cleanup */ }
    if (running) command(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
