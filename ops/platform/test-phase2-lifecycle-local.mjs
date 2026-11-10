// Owns every process, source snapshot and TLS/SCRAM database. No external
// connection string, provider token, deployment operation or shared DB is used.
// Node24: PHASE2_LIFECYCLE_LOCAL_TEST=true PG_BIN=/absolute/postgresql16/bin
//   node ops/platform/test-phase2-lifecycle-local.mjs
// Override PHASE2_{FRONTEND,COURSE,COMMUNITY}_SOURCE_COMMIT to replay a receipt.
// Course b21e25cf900458eb6cbbd993582d7e1bbac36c4b reproduces the missing
// final paid-grant revocation event with the historical expiry fixture.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { P2_LIFECYCLE_OWNED_FINAL_API_REVISIONS as pins } from "./p2-lifecycle-owned-source-manifest.mjs";

const frontendRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const driverRoot = join(frontendRoot, "ops/platform/harness");
const hash = value => createHash("sha256").update(value).digest("hex");
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const canonical = name => `https://github.com/princessdardan/lash-her-${name === "frontend" ? "frontend" : `${name}-api`}.git`;
let phase = "preflight";
async function main() {
  assert.equal(process.env.PHASE2_LIFECYCLE_LOCAL_TEST, "true", "Explicit owned-only opt-in required");
  assert.equal(process.versions.node.split(".")[0], "24", "Node24 required");
  const binaries = process.env.PG_BIN; assert.ok(binaries?.startsWith("/"));
  assert.match(run(join(binaries, "postgres"), ["--version"]), /PostgreSQL\) 16\./u);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase2-lifecycle-owned-")));
  chmodSync(directory, 0o700);
  const sources = {}, clients = [], children = [];
  const data = join(directory, "data"), certificate = join(directory, "server.crt"), key = join(directory, "server.key");
  let running = false;
  try {
    phase = "source-snapshots";
    for (const [name, source] of Object.entries({ frontend: frontendRoot, course: process.env.PHASE2_COURSE_SOURCE_ROOT ?? "/private/tmp/lash-phase2-course", community: process.env.PHASE2_COMMUNITY_SOURCE_ROOT ?? "/private/tmp/lash-phase2-community" })) {
      const root = realpathSync(source); assert.equal(run("git", ["remote", "get-url", "origin"], { cwd: root }).trim(), canonical(name));
      const commit = name === "frontend" ? process.env.PHASE2_FRONTEND_SOURCE_COMMIT ?? run("git", ["rev-parse", "HEAD"], { cwd: root }).trim() : process.env[`PHASE2_${name.toUpperCase()}_SOURCE_COMMIT`] ?? pins[name];
      assert.match(commit, /^[a-f0-9]{40}$/u);
      const archive = join(directory, `${name}.tar`);
      run("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: root });
      const snapshot = join(directory, name); mkdirSync(snapshot);
      run("tar", ["-xf", archive, "-C", snapshot]);
      const archiveHash = createHash("sha256");
      for await (const chunk of createReadStream(archive)) archiveHash.update(chunk);
      assert.ok(existsSync(join(root, "node_modules/tsx")), "Install pinned source dependencies before owned qualification");
      symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
      assert.equal(hash(readFileSync(join(root, "package-lock.json"))), hash(readFileSync(join(snapshot, "package-lock.json"))), "Installed checkout lockfile must match the source pin");
      sources[name] = { root: snapshot, commit, archiveSha256: archiveHash.digest("hex"), lockSha256: hash(readFileSync(join(snapshot, "package-lock.json"))) };
    }
    const apiArtifacts = {};
    for (const name of ["course", "community"]) {
      const path = name === "course" ? "openapi/course-api.json" : "openapi/community-api.json";
      const actual = readFileSync(join(sources[name].root, path));
      const consumed = readFileSync(join(sources.frontend.root, `contracts/api-integration/p2-candidate/${name}-api.json`));
      const sourceDocument = JSON.parse(actual), consumerDocument = JSON.parse(consumed);
      const subset = ["/v1/internal/accounts/commands", "/v1/internal/accounts/exports/{commandId}"];
      for (const endpoint of subset) assert.deepEqual(consumerDocument.paths[endpoint], sourceDocument.paths[endpoint], "Lifecycle operations must match reviewed source and consumed artifacts");
      apiArtifacts[name] = { sourceSha256: hash(actual), frontendCandidateSha256: hash(consumed), lifecycleOperationsSha256: hash(JSON.stringify(subset.map(endpoint => sourceDocument.paths[endpoint]))) };
    }
    phase = "owned-tls-scram-cluster";
    const probe = createServer(); await new Promise((done, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", done); });
    const port = probe.address().port; await new Promise(done => probe.close(done));
    const clean = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" };
    run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "lifecycle_test_admin", "-E", "UTF8", "--locale=C"], { env: clean });
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate], { env: clean }); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all lifecycle_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"], { env: clean }); running = true;
    const ca = readFileSync(certificate, "utf8");
    const connect = async config => { const client = new Client({ ...config, ssl: { rejectUnauthorized: true, ca }, enableChannelBinding: true }); clients.push(client); client.on("error", () => {}); await client.connect(); assert.equal(client.connection.stream.authorized, true); return client; };
    const admin = await connect({ host: "127.0.0.1", port, user: "lifecycle_test_admin", database: "postgres" });
    const databases = {}, migrations = {};
    for (const name of ["frontend", "course", "community"]) {
      const database = `owned_lifecycle_${name}_test`, user = `lifecycle_${name}_runtime`, password = randomBytes(32).toString("hex");
      await admin.query(`create role ${user} login noinherit password '${password}'`);
      await admin.query(`create database ${database}`); await admin.query(`revoke connect on database ${database} from public`); await admin.query(`grant connect on database ${database} to ${user}`);
      const config = { host: "127.0.0.1", port, database, user, password };
      const owner = await connect({ ...config, user: "lifecycle_test_admin" });
      const require = createRequire(join(sources[name].root, "package.json"));
      const { drizzle } = require("drizzle-orm/node-postgres"), { migrate } = require("drizzle-orm/node-postgres/migrator");
      if (name === "frontend") {
        // The reviewed frontend operator executes migrations separately. One
        // transaction across its whole history cannot use newly added enum
        // values in later files, and does not match that release boundary.
        const { frontendMigrationArtifact } = await import(pathToFileURL(join(sources.frontend.root, "ops/platform/frontend-migration.mjs")).href);
        const artifact = frontendMigrationArtifact(sources.frontend.root);
        await owner.query("create schema drizzle");
        await owner.query("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
        for (const migration of artifact.migrations) {
          await owner.query("begin");
          try {
            for (const statement of migration.sql) await owner.query(statement);
            await owner.query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
            await owner.query("commit");
          } catch (error) { await owner.query("rollback"); throw error; }
        }
      } else await migrate(drizzle(owner), { migrationsFolder: join(sources[name].root, "drizzle") });
      await owner.query(`grant usage on schema public to ${user}`);
      await owner.query(`grant select,insert,update,delete on all tables in schema public to ${user}`);
      await owner.query(`grant usage,select on all sequences in schema public to ${user}`);
      const receipt = await owner.query('select hash,created_at::text from drizzle.__drizzle_migrations order by created_at');
      migrations[name] = { count: receipt.rowCount, appliedSha256: hash(JSON.stringify(receipt.rows)), journalSha256: hash(readFileSync(join(sources[name].root, "drizzle/meta/_journal.json"))) };
      databases[name] = config;
    }
    phase = "runtime-tls-scram-refusal-probes";
    const wrong = new Client({ ...databases.frontend, password: "owned-deliberately-wrong-password", ssl: { rejectUnauthorized: true, ca } });
    await assert.rejects(wrong.connect(), error => error.code === "28P01"); await wrong.end();
    const plaintext = new Client({ ...databases.frontend, ssl: false });
    await assert.rejects(plaintext.connect(), error => error.code === "28000"); await plaintext.end();
    phase = "owned-frontend-admission";
    const owner = await connect({ ...databases.frontend, user: "lifecycle_test_admin" });
    await admin.query("create role lifecycle_admission_owner nologin noinherit");
    await owner.query("grant create on database owned_lifecycle_frontend_test to lifecycle_admission_owner");
    const target = { environment: "staging", host: "127.0.0.1", port, database: databases.frontend.database, user: databases.frontend.user, serverMajor: 16, targetSha256: hash(`owned-lifecycle-target:${port}:${sources.frontend.commit}`) };
    const producerSha256 = hash(`owned-lifecycle-producer:${sources.frontend.commit}`);
    await owner.query("begin");
    try {
      await owner.query("set local role lifecycle_admission_owner");
      await owner.query(readFileSync(join(sources.frontend.root, "ops/platform/frontend-admission.sql"), "utf8"));
      await owner.query("insert into frontend_admission.control(environment,target_sha256,new_work,recovery) values('staging',$1,true,true)", [target.targetSha256]);
      await owner.query("insert into frontend_admission.producers(producer_sha256,source_sha,database_role,enabled) values($1,$2,$3::regrole::oid,true)", [producerSha256, sources.frontend.commit, databases.frontend.user]);
      await owner.query(`grant usage on schema frontend_admission to ${databases.frontend.user}`);
      await owner.query(`grant execute on all routines in schema frontend_admission to ${databases.frontend.user}`);
      await owner.query("commit");
    } catch (error) { await owner.query("rollback"); throw error; }
    const syntheticKeys = Object.fromEntries(["COURSE_LEARNER_JWT_CURRENT_SECRET", "COURSE_ADMIN_JWT_CURRENT_SECRET", "COMMUNITY_MEMBER_JWT_CURRENT_SECRET", "COMMUNITY_ADMIN_JWT_CURRENT_SECRET", "COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COURSE_PUBLISHER_JWT_CURRENT_SECRET"].map(name => [name, randomBytes(40).toString("hex")]));
    const clock = Date.now();
    function startChild(file, root, env) {
      const child = fork(join(driverRoot, file), [], { cwd: root, execArgv: ["--import", "tsx"], env: { ...clean, NODE_ENV: "test", NODE_NO_WARNINGS: "1", NODE_EXTRA_CA_CERTS: certificate, DOTENV_CONFIG_PATH: join(directory, "nonexistent.env"), ...env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child); child.stdout.resume(); child.stderr.resume();
      let next = 0; const pending = new Map();
      child.on("message", message => { if (message.control) return; const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result); });
      child.on("exit", code => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Owned child exited (${code})`)); } pending.clear(); });
      return { child, request(op, value = {}) { const id = ++next; return new Promise((done, fail) => { const timer = setTimeout(() => { pending.delete(id); fail(new Error(`Owned child operation timed out: ${op}`)); }, 60_000); pending.set(id, { resolve: done, reject: fail, timer }); child.send({ id, op, ...value }); }); } };
    }
    phase = "actual-api-receivers";
    const receivers = {};
    for (const name of ["course", "community"]) {
      const env = { COURSE_ACCOUNT_LIFECYCLE_ENABLED: "true", COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED: "true", HTTP_AGGREGATE_RATE_LIMIT_PER_MINUTE: "10000", HTTP_PRINCIPAL_RATE_LIMIT_PER_MINUTE: "10000", ...syntheticKeys };
      const process = startChild("owned-phase2-lifecycle-receiver.mjs", sources[name].root, env);
      const result = await process.request("initialize", { service: name, root: sources[name].root, database: databases[name], ca, clock, keys: syntheticKeys });
      assert.equal(result.host, "127.0.0.1"); receivers[name] = { ...process, endpoint: `http://127.0.0.1:${result.port}` };
    }
    phase = "real-frontend-to-both-api-journey";
    const frontend = startChild("owned-phase2-lifecycle-frontend.mjs", sources.frontend.root, { ...syntheticKeys });
    // Clock control is private process IPC, never a production API route.
    frontend.child.on("message", async message => {
      if (!["clock", "receiver_cleanup"].includes(message.control)) return;
      try { const result = await Promise.all(Object.values(receivers).map(receiver => receiver.request(message.control === "clock" ? "clock" : "cleanup", message.control === "clock" ? { clock: message.clock } : {}))); frontend.child.send({ control: message.control, id: message.id, result }); }
      catch { frontend.child.send({ control: message.control, id: message.id, error: true }); }
    });
    const result = await frontend.request("journey", { root: sources.frontend.root, courseRoot: sources.course.root, databases, ca, clock, keys: syntheticKeys, target, producerSha256, sourceCommit: sources.frontend.commit, receivers: Object.fromEntries(Object.entries(receivers).map(([name, receiver]) => [name, receiver.endpoint])) });
    phase = "receiver-expired-export-cleanup";
    for (const receiver of Object.values(receivers)) assert.equal((await receiver.request("cleanup")).expired, 0);
    const ledger = await owner.query("select state,count(*)::integer as count from frontend_admission.operations group by state order by state");
    assert.ok(ledger.rows.some(row => row.state === "uncertain" && row.count >= 1), "Unknown delivery effects must remain visible to release coordination");
    assert.equal(ledger.rows.some(row => row.state === "active"), false);
    const evidence = { version: 1, status: result.findings.length ? "PHASE2_LIFECYCLE_OWNED_POSTGRES_FAILED" : "PHASE2_LIFECYCLE_OWNED_POSTGRES_PASS", postgresMajor: 16, tlsVerified: true, runtimeAuthentication: "SCRAM-SHA-256", harnessFiles: Object.fromEntries(["test-phase2-lifecycle-local.mjs", "harness/owned-phase2-lifecycle-frontend.mjs", "harness/owned-phase2-lifecycle-receiver.mjs"].map(file => [file, hash(readFileSync(join(frontendRoot, "ops/platform", file)))])), sourcePins: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { commit: source.commit, archiveSha256: source.archiveSha256, lockSha256: source.lockSha256 }])), apiArtifacts, contractQualification: "Actual typed lifecycle command/export operations match source artifacts; learning prerequisites use actual API routes", migrations, admission: ledger.rows, checks: ["runtime-wrong-password-and-plaintext-refused-before-business-work", ...result.checks], findings: result.findings, providerTouched: false, liveCertification: false, productionActivation: false };
    console.log(JSON.stringify(evidence));
    if (result.findings.length) process.exitCode = 1;
  } finally {
    for (const child of children.reverse()) { if (child.connected) { try { child.send({ id: 0, op: "stop" }); } catch {} } }
    await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(done => { const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000); child.once("exit", () => { clearTimeout(timer); done(); }); })));
    for (const client of clients.reverse()) { try { await client.end(); } catch {} }
    if (running) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify({ status: "PHASE2_LIFECYCLE_OWNED_POSTGRES_FAILED", phase, reason: error instanceof Error ? error.message.slice(0, 250) : "UnknownError", providerTouched: false })); process.exitCode = 1; }
}
