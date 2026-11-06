// Owned integration: actual frontend cron/admission and both pinned receivers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact, frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), execute = (file, args, options = {}) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let phase = "owned-preflight", childFailure;
async function main() {
  assert.equal(process.env.P2_LIFECYCLE_WORKER_OWNED_TEST, "true"); assert.equal(process.versions.node.split(".")[0], "24");
  const major = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16"), bin = process.env.PG_BIN;
  assert.ok([16,18].includes(major) && bin?.startsWith("/")); assert.match(execute(join(bin, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const sources = { frontend: root, course: resolve(process.env.P2_COURSE_SOURCE_ROOT ?? "/Users/dardan/workspace/lash-her-course-api/.worktrees/phase2-course"),
    community: resolve(process.env.P2_COMMUNITY_SOURCE_ROOT ?? "/Users/dardan/workspace/lash-her-community-api/.worktrees/phase2-community") };
  const pins = { course: "0bb054d5a04db71c481a8b3d182db6df19782cdc", community: "8594d953a5c0e0849e7a2e5e0de21f03537c4dc4" };
  for (const service of ["course", "community"]) assert.equal(execute("git", ["rev-parse", "HEAD"], { cwd: sources[service] }).trim(), pins[service]);
  const directory = mkdtempSync(join(tmpdir(), "p2-worker-owned-")); chmodSync(directory, 0o700);
  const data = join(directory, "data"), cert = join(directory, "server.crt"), key = join(directory, "server.key"), password = randomBytes(32).toString("hex"), clients = [];
  let started = false;
  try {
    const socket = createServer(); await new Promise((done, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", done); }); const port = socket.address().port; await new Promise(done => socket.close(done));
    execute(join(bin, "initdb"), ["-D", data, "-A", "trust", "-U", "frontend_test_admin", "-E", "UTF8", "--locale=C"]);
    execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:course-tls,DNS:community-tls,IP:127.0.0.1", "-keyout", key, "-out", cert]); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "hostssl all frontend_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    execute(join(bin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
    const ca = readFileSync(cert, "utf8"), connect = async database => { const client = new Client({ host: "127.0.0.1", port, database, user: "frontend_test_admin",
      ssl: { rejectUnauthorized: true, ca }, options: "-c search_path=public" }); clients.push(client); await client.connect(); return client; };
    const setup = await connect("postgres"); await setup.query("CREATE ROLE admission_owner NOLOGIN NOINHERIT");
    const databases = {}, migrations = {}, roles = {};
    for (const service of ["frontend", "course", "community"]) {
      const database = "owned_worker_" + service, runtimeRole = "worker_" + service + "_runtime";
      await setup.query(`CREATE DATABASE ${database}`); await setup.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT PASSWORD '${password}'`);
      const client = await connect(database); phase = "migrate-" + service;
      if (service === "frontend") {
        const artifact = frontendMigrationArtifact(root); assert.equal(artifact.migrations.length, 83);
        await client.query("CREATE SCHEMA drizzle"); await client.query("CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text,created_at bigint)");
        for (const migration of artifact.migrations) { await client.query("BEGIN"); for (const sql of migration.sql) await client.query(sql);
          await client.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [migration.hash, migration.folderMillis]); await client.query("COMMIT"); }
      } else {
        const require = createRequire(join(sources[service], "package.json")), { drizzle } = require("drizzle-orm/node-postgres"), { migrate } = require("drizzle-orm/node-postgres/migrator");
        await migrate(drizzle(client), { migrationsFolder: join(sources[service], "drizzle") });
      }
      await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`); await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
      migrations[service] = Number((await client.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations")).rows[0].count);
      roles[service] = { name: runtimeRole, oid: (await setup.query("SELECT oid::text FROM pg_roles WHERE rolname=$1", [runtimeRole])).rows[0].oid };
      databases[service] = { host: "127.0.0.1", port, database, user: runtimeRole, password };
    }
    assert.deepEqual(migrations, { frontend: 83, course: 22, community: 11 });
    const operator = await connect(databases.frontend.database); await operator.query(`GRANT CREATE ON DATABASE ${databases.frontend.database} TO admission_owner`);
    const owner = { name: "admission_owner", oid: (await setup.query("SELECT oid::text FROM pg_roles WHERE rolname='admission_owner'")).rows[0].oid };
    const target = { host: "127.0.0.1", port, database: databases.frontend.database, user: "frontend_test_admin", serverMajor: major }, targetSha256 = frontendAdmissionTargetSha256("staging", target), sourceCommit = nativeSourceCommit();
    phase = "admission-bootstrap";
    await bootstrapFrontendAdmission({ version: 1, environment: "staging", actionId: "owned-worker", sourceCommit, ...frontendAdmissionBootstrapArtifact(), inventorySha256: "a".repeat(64),
      targetSha256, target, owner, producers: [{ producerSha256: "b".repeat(64), sourceCommit, role: roles.frontend }] }, operator,
    { confirmation: "staging/owned-worker", record: async () => {}, verifySession: async () => assert.equal(operator.connection.stream.authorized, true) });
    phase = "actual-cron-receivers-and-guard";
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/register-server-only-test.mjs", "ops/platform/harness/owned-p2-lifecycle-worker.mjs"],
      { cwd: root, encoding: "utf8", timeout: 180000, input: JSON.stringify({ sources, databases, migrations, roles, owner, target, targetSha256, sourceCommit, major, certificate: cert, key }),
        env: Object.fromEntries([...Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "LANG", "TMPDIR"].includes(key)), ["NODE_EXTRA_CA_CERTS", cert], ["P2_WORKER_OWNED_CHILD", "true"]]) });
    if (child.status !== 0) {
      const last = child.stderr.trim().split("\n").at(-1);
      try { const parsed = JSON.parse(last); if (parsed.status === "P2_WORKER_OWNED_CHILD_FAILED" && /^[a-z0-9-]{1,100}$/u.test(parsed.phase)) childFailure = parsed; } catch {}
    }
    assert.equal(child.status, 0); const result = JSON.parse(child.stdout); assert.equal(result.status, "P2_LIFECYCLE_WORKER_OWNED_PASS");
    return { ...result, postgresMajor: major, migrations, sourceCommits: { frontend: sourceCommit, ...pins },
      sourceSha256: Object.fromEntries(["p2-lifecycle-worker-evidence.mjs", "p2-lifecycle-receiver-denial.mjs", "host/p2_lifecycle_worker_evidence.py",
        "harness/owned-p2-lifecycle-worker.mjs", "test-p2-lifecycle-worker-local.mjs"].map(file => [file, createHash("sha256").update(readFileSync(join(root, "ops/platform", file))).digest("hex")])),
      fixtureOnly: true, actualGatewayDocker: false, actualWorkloadOidc: false, actualNativeProvider: false, actualBrowser: false, providerTouched: false };
  } finally { for (const client of clients.reverse()) try { await client.end(); } catch {} if (started) try { execute(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch {} rmSync(directory, { recursive: true, force: true }); }
}
main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(JSON.stringify({ status: "P2_LIFECYCLE_WORKER_OWNED_FAILED", phase,
  code: error?.code ?? error?.name ?? "Error", ...(childFailure ? { childFailure } : {}), providerTouched: false })); process.exitCode = 1; });
