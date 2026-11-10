import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { verifyEmptyFrontendReplacement } from "./frontend-replacement-boundary.mjs";

const refusal = checkpoint => ({ message: "FRONTEND_REPLACEMENT_BOUNDARY_REFUSED", checkpoint });
const target = { host: "127.0.0.1", port: 5432, database: "owned_replacement",
  user: "owned_migrator", runtimeRole: FRONTEND_PREPARATION_ROLES.runtime, serverMajor: 18 };
const predecessorTarget = { ...target, database: "owned_previous", runtimeRole: "owned_previous_runtime" };
const request = { target, predecessorTarget, administrativeLogins: [], verifyEnvironment: async () => {}, verifySession: async () => {} };

test("replacement request rejects same endpoint, pooling and unreviewed admin shapes before observing", async () => {
  await assert.rejects(verifyEmptyFrontendReplacement(null, { ...request, predecessorTarget: { ...predecessorTarget, database: target.database } }), refusal("input"));
  await assert.rejects(verifyEmptyFrontendReplacement(null, { ...request, target: { ...target, host: "example-pooler.invalid" } }), refusal("input"));
  await assert.rejects(verifyEmptyFrontendReplacement(null, { ...request, administrativeLogins: [{ name: predecessorTarget.runtimeRole, oid: "12" }] }), refusal("input"));
  await assert.rejects(verifyEmptyFrontendReplacement(null, { ...request, administrativeLogins: [{ name: "owner", oid: "12", credential: "extra" }] }), refusal("input"));
  await assert.rejects(verifyEmptyFrontendReplacement(null, { ...request, managedCatalog: { id: "reviewed" } }), refusal("input"));
  await assert.rejects(verifyEmptyFrontendReplacement(null, { ...request, provider: { kind: "neon" } }), refusal("input"));
  await assert.rejects(verifyEmptyFrontendReplacement({}, request), refusal("tls-target"));
});

function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" } });
  assert.equal(result.status, 0, `Owned fixture command failed: ${file}\n${result.stderr ?? ""}`);
  return result.stdout;
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()));
  return port;
}

test("owned TLS PostgreSQL checks empty replacement, access and standalone objects on the held backend", {
  skip: process.env.FRONTEND_REPLACEMENT_OWNED_TEST !== "true", timeout: 120000,
}, async () => {
  const binaries = process.env.PG_BIN;
  assert.ok(binaries && resolve(binaries) === binaries);
  const major = Number(command(join(binaries, "postgres"), ["--version"]).match(/PostgreSQL\) (16|18)\./u)?.[1]);
  assert.ok([16, 18].includes(major));
  const directory = mkdtempSync(join(tmpdir(), "frontend-replacement-owned-"));
  const data = join(directory, "pgdata"), cert = join(directory, "server.crt"), key = join(directory, "server.key");
  const passwordFile = join(directory, "password"), password = randomBytes(32).toString("hex");
  const connections = [];
  let started = false;
  try {
    const port = await freePort();
    const actualTarget = { ...target, port, serverMajor: major }, previous = { ...predecessorTarget, port, serverMajor: major };
    writeFileSync(passwordFile, password + "\n", { mode: 0o600 });
    command("openssl", ["req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1",
      "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
    chmodSync(key, 0o600);
    command(join(binaries, "initdb"), ["-D", data, "-U", "owned_admin", "--auth-host=scram-sha-256",
      "--auth-local=trust", "--pwfile", passwordFile]);
    writeFileSync(join(data, "postgresql.auto.conf"),
      `ssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\nmax_prepared_transactions=5\n`, { mode: 0o600 });
    command(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"),
      "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]);
    started = true;
    async function connect(database, user, ssl = { ca: readFileSync(cert, "utf8"), rejectUnauthorized: true }) {
      const client = new Client({ host: "127.0.0.1", port, database, user, password, ssl });
      client.on("error", () => {});
      connections.push(client);
      await client.connect();
      return client;
    }
    const admin = await connect("postgres", "owned_admin");
    await admin.query(`CREATE ROLE owned_migrator LOGIN PASSWORD '${password}'`);
    await admin.query("CREATE DATABASE owned_replacement OWNER owned_migrator");
    const client = await connect(actualTarget.database, actualTarget.user);
    const { oid } = (await admin.query("SELECT oid::text FROM pg_roles WHERE rolname='owned_admin'")).rows[0];
    const options = { ...request, target: actualTarget, predecessorTarget: previous, administrativeLogins: [{ name: "owned_admin", oid }] };
    const inspect = (overrides = {}) => verifyEmptyFrontendReplacement(client, { ...options, ...overrides });
    const lock = () => client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    await assert.rejects(inspect(), refusal("migration-lock"));
    await lock();
    await assert.rejects(inspect(), refusal("database-access"));
    await client.query("REVOKE ALL ON DATABASE owned_replacement FROM PUBLIC");
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const result = await inspect();
    assert.equal(result.status, "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED");
    assert.equal(result.completeDatabaseEmptyProven, false);
    assert.equal(result.authorityIssued, false);
    assert.equal(result.readOnlyVerified, true);
    assert.equal(result.catalogScope, "postgresql-16-18-stock-replacement-v1");
    assert.equal(Object.hasOwn(result, "managedCatalog"), false);
    assert.equal(Object.hasOwn(result, "catalogCounts"), false);
    assert.ok(Object.values(result.zeroCatalogCounts).every(value => value === 0));
    assert.deepEqual(result.administrativeLogins, [{ name: "owned_admin", oid }]);
    await assert.rejects(inspect({ administrativeLogins: [] }), refusal("effective-login-access"));
    await assert.rejects(inspect({ administrativeLogins: [{ name: "owned_admin", oid: "123" }] }), refusal("effective-login-access"));

    await admin.query("CREATE ROLE owned_previous_runtime NOLOGIN");
    await assert.rejects(inspect(), refusal("database-access"));
    await admin.query("DROP ROLE owned_previous_runtime");
    await admin.query(`CREATE ROLE ${FRONTEND_PREPARATION_ROLES.owner} NOLOGIN`);
    await assert.rejects(inspect(), refusal("database-access"));
    await admin.query(`DROP ROLE ${FRONTEND_PREPARATION_ROLES.owner}`);
    await admin.query("CREATE ROLE owned_extra LOGIN; CREATE ROLE owned_group NOLOGIN; GRANT owned_group TO owned_extra; GRANT CONNECT ON DATABASE owned_replacement TO owned_group");
    await assert.rejects(inspect(), refusal("effective-login-access"));
    await admin.query("REVOKE CONNECT ON DATABASE owned_replacement FROM owned_group; DROP ROLE owned_extra,owned_group");

    for (const [create, remove] of [
      ["CREATE TABLE public.drift(id integer)", "DROP TABLE public.drift"],
      ['CREATE COLLATION public.drift FROM pg_catalog."C"', "DROP COLLATION public.drift"],
      ["CREATE TEXT SEARCH CONFIGURATION public.drift (COPY=pg_catalog.english)", "DROP TEXT SEARCH CONFIGURATION public.drift"],
      ["ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC", "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC"],
      ["ALTER ROLE owned_migrator IN DATABASE owned_replacement SET search_path = public, pg_catalog",
        "ALTER ROLE owned_migrator IN DATABASE owned_replacement RESET ALL"],
    ]) {
      await client.query(create);
      await assert.rejects(inspect(), refusal("catalog-scope"));
      await client.query(remove);
      await inspect();
    }
    await client.query("BEGIN; PREPARE TRANSACTION 'owned_replacement_drift'");
    await assert.rejects(inspect(), refusal("catalog-scope"));
    await client.query("ROLLBACK PREPARED 'owned_replacement_drift'");

    const other = await connect(actualTarget.database, actualTarget.user);
    await assert.rejects(inspect(), refusal("database-access"));
    await other.end();
    await client.query("BEGIN");
    await assert.rejects(inspect(), refusal("transaction-boundary"));
    assert.equal((await client.query("SELECT pg_catalog.current_setting('transaction_read_only') AS mode")).rows[0].mode, "off");
    await client.query("ROLLBACK");

    let verifyCount = 0;
    await assert.rejects(inspect({ verifyEnvironment: async () => {
      if (++verifyCount === 2) await client.query("CREATE COLLATION public.drift FROM pg_catalog.\"C\"");
    } }), refusal("catalog-scope"));
    await client.query("DROP COLLATION public.drift");
    const untrusted = await connect(actualTarget.database, actualTarget.user, { rejectUnauthorized: false });
    await assert.rejects(verifyEmptyFrontendReplacement(untrusted, options), refusal("tls-target"));
    await untrusted.end();
    await inspect();
    const unlocked = await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS unlocked", [FRONTEND_MIGRATION_LOCK]);
    assert.equal(unlocked.rows[0].unlocked, true);
  } finally {
    await Promise.allSettled(connections.map(client => client.end()));
    if (started) command(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
