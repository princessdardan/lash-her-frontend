import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "pg";
import { frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { validateFrontendLineageObservationRequest } from "./frontend-lineage-observation.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const source = fileURLToPath(new URL("../..", import.meta.url));
const cli = "ops/platform/frontend-lineage-observation.mjs";
const receipt = "frontend-lineage-observation.json";
const sample = {
  version: 1, qualificationTargetProfile: profile, sourceCommit: "a".repeat(40),
  target: { host: "staging.example.net", port: 5432, database: "staging", user: "migration", serverMajor: 18 },
};
const run = (program, argv, options) => execFileSync(program, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

test("frontend lineage request requires the reviewed staging profile and an exact direct target", () => {
  assert.deepEqual(validateFrontendLineageObservationRequest(sample), sample);
  for (const target of [
    { ...sample.target, host: "staging-pooler.example.net" },
    { ...sample.target, host: "pgbouncer.staging.example.net" },
    { ...sample.target, host: "postgresql://staging.example.net" },
    { ...sample.target, approvedPendingTags: [] },
    { ...sample.target, serverMajor: 17 },
  ]) assert.throws(() => validateFrontendLineageObservationRequest({ ...sample, target }));
  assert.throws(() => validateFrontendLineageObservationRequest({ ...sample, environment: "production" }));
  assert.throws(() => validateFrontendLineageObservationRequest({ ...sample, qualificationTargetProfile: { ...profile, id: "production" } }));
  assert.throws(() => validateFrontendLineageObservationRequest({ ...sample, sourceCommit: "0".repeat(40) }));
});

test("staging lineage CLI verifies the actual read-only TLS journal on a disposable PostgreSQL server", {
  skip: process.env.FRONTEND_LINEAGE_LOCAL_TEST !== "true",
  timeout: 120_000,
}, async () => {
  const pgBin = process.env.PG_BIN;
  assert.ok(pgBin?.startsWith("/"));
  const major = Number(/PostgreSQL\) (16|18)\./u.exec(run(join(pgBin, "postgres"), ["--version"]))?.[1]);
  assert.ok([16, 18].includes(major));
  const listener = createServer();
  await new Promise((done, fail) => listener.once("error", fail).listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "frontend-lineage-owned-"));
  const data = join(directory, "data"), key = join(directory, "server.key"), cert = join(directory, "server.crt");
  const database = "owned_lineage", role = "owned_migration", password = randomUUID();
  const sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: source }).trim();
  const credential = `postgresql://${role}:${password}@127.0.0.1:${port}/${database}?sslmode=verify-full`;
  const request = { ...sample, sourceCommit, target: { host: "127.0.0.1", port, database, user: role, serverMajor: major } };
  const requestFile = join(directory, "request.json");
  const artifact = frontendMigrationArtifact(source);
  let started = false, client;
  try {
    run(join(pgBin, "initdb"), ["-D", data, "-A", "trust", "-U", "lineage_owner", "-E", "UTF8", "--locale=C"]);
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert]);
    chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "hostssl all lineage_owner 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]);
    started = true;
    const config = { host: request.target.host, port, user: "lineage_owner", ssl: { rejectUnauthorized: true, ca: readFileSync(cert, "utf8") } };
    const admin = new Client({ ...config, database: "postgres" });
    await admin.connect();
    try {
      await admin.query(`create role ${role} login password '${password}'`);
      await admin.query(`create database ${database}`);
    } finally { await admin.end(); }
    client = new Client({ ...config, database });
    await client.connect();
    const invoke = (name, expected, { input = request, env = {} } = {}) => {
      const output = join(directory, name);
      mkdirSync(output, { mode: 0o700 });
      writeFileSync(requestFile, JSON.stringify(input), { mode: 0o600 });
      const result = spawnSync(process.execPath, [cli, "--inspect", requestFile, output], {
        cwd: source, encoding: "utf8", timeout: 25_000,
        env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, FRONTEND_STAGING_MIGRATION_DATABASE_URL: credential, ...env },
      });
      const diagnostic = (result.stdout ?? "") + (result.stderr ?? "");
      assert.equal(diagnostic.includes(password), false);
      if (expected === null) {
        assert.equal(result.status, 1, diagnostic);
        assert.match(result.stderr, /"status":"FRONTEND_LINEAGE_OBSERVATION_REFUSED"/u);
        assert.deepEqual(readdirSync(output), []);
        return;
      }
      assert.equal(result.status, 0, diagnostic);
      assert.deepEqual(JSON.parse(result.stdout), { status: expected, receipt, migrationAuthorized: false, trafficAuthorized: false });
      const row = JSON.parse(readFileSync(join(output, receipt), "utf8"));
      assert.equal(row.sourceCommit, sourceCommit);
      assert.equal(row.sqlArtifactSha256, artifact.sqlArtifactSha256);
      assert.deepEqual(row.target, request.target);
      assert.equal(row.expectedMigrationCount, artifact.migrations.length);
      for (const flag of ["verifiedTls", "readOnlyVerified", "migrationLockVerified", "samePhysicalSessionVerified"]) assert.equal(row[flag], true);
      for (const flag of ["applicationSqlApplied", "bootstrapAuthorized", "migrationAuthorized", "trafficAuthorized"]) assert.equal(row[flag], false);
      return row;
    };
    const missing = invoke("absent", "FRONTEND_LINEAGE_JOURNAL_ABSENT");
    assert.equal(missing.journalPresent, false);
    assert.equal(missing.lastApplied, null);
    assert.deepEqual(missing.pendingTags, artifact.migrations.map(({ tag }) => tag));
    assert.deepEqual((await client.query("select to_regclass('drizzle.__drizzle_migrations') as journal")).rows, [{ journal: null }]);
    await client.query(`create schema drizzle;
      create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint);
      grant usage on schema drizzle to ${role};
      grant select on drizzle.__drizzle_migrations to ${role}`);
    const empty = invoke("empty", "FRONTEND_LINEAGE_JOURNAL_EMPTY");
    assert.equal(empty.journalPresent, true);
    assert.equal(empty.appliedCount, 0);
    const add = ({ hash, folderMillis }) => client.query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [hash, folderMillis]);
    for (const migration of artifact.migrations.slice(0, -3)) await add(migration);
    const pending = invoke("pending", "FRONTEND_LINEAGE_PENDING");
    assert.equal(pending.appliedCount, artifact.migrations.length - 3);
    assert.equal(pending.lastApplied.tag, artifact.migrations.at(-4).tag);
    assert.deepEqual(pending.pendingTags, artifact.migrations.slice(-3).map(({ tag }) => tag));
    for (const migration of artifact.migrations.slice(-3)) await add(migration);
    const current = invoke("current", "FRONTEND_LINEAGE_CURRENT");
    assert.equal(current.appliedCount, artifact.migrations.length);
    assert.deepEqual(current.pendingTags, []);
    assert.notEqual(current.appliedPrefixSha256, pending.appliedPrefixSha256);
    await client.query("select pg_advisory_lock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    try { invoke("contended", null); }
    finally { await client.query("select pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]); }
    invoke("wrong-tls", null, { env: { NODE_EXTRA_CA_CERTS: "" } });
    invoke("wrong-credential-target", null, { env: { FRONTEND_STAGING_MIGRATION_DATABASE_URL: credential.replace("127.0.0.1", "127.0.0.2") } });
    invoke("no-ambient-fallback", null, { env: { FRONTEND_STAGING_MIGRATION_DATABASE_URL: "", DATABASE_URL: credential } });
    invoke("wrong-source", null, { input: { ...request, sourceCommit: "a".repeat(40) } });
    invoke("wrong-server-major", null, { input: { ...request, target: { ...request.target, serverMajor: major === 16 ? 18 : 16 } } });
    await client.query("update drizzle.__drizzle_migrations set hash=$1 where id=1", ["a".repeat(64)]);
    invoke("hash-drift", null);
    await client.query("update drizzle.__drizzle_migrations set hash=$1 where id=1", [artifact.migrations[0].hash]);
    await client.query("delete from drizzle.__drizzle_migrations where id=2");
    invoke("gap", null);
    await client.query("drop table drizzle.__drizzle_migrations; create view drizzle.__drizzle_migrations as select 1 as id");
    invoke("view-refused", null);
  } finally {
    await client?.end();
    if (started) run(join(pgBin, "pg_ctl"), ["-D", data, "-w", "-m", "immediate", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
