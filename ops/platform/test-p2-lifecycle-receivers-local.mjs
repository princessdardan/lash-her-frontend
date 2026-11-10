// Disposable PostgreSQL proof only. No external URL, provider or live service.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { p2LifecyclePersistenceTargetSha256 } from "./p2-lifecycle-persistence-probe.mjs";
import { readP2LifecycleOwnedContractSelection, verifyP2LifecycleOwnedSourceManifest } from "./p2-lifecycle-owned-source-manifest.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let phase = "preflight";
let failurePostgresMajor = 16;
const POSTGRES18_MODE = "--postgres18-manifest";
async function readManifest() {
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 512_000, "Source manifest too large"); chunks.push(chunk); }
  assert.ok(size > 0, "Source manifest required"); return Buffer.concat(chunks);
}

async function main() {
  assert.equal(process.env.P2_LIFECYCLE_RECEIVER_OWNED_TEST, "true", "Explicit owned test opt-in required");
  assert.equal(process.versions.node.split(".")[0], "24", "Node 24 required");
  const containerMode = process.argv.length === 3 && process.argv[2] === POSTGRES18_MODE;
  assert.equal(process.argv.length, containerMode ? 3 : 2, "Fixed owned mode required");
  const profiledMode = process.env.P2_LIFECYCLE_RECEIVER_PROFILED_OWNED_TEST === "true";
  assert.ok(!profiledMode || !containerMode, "Profiled wire fixture requires the native source tree for host composition");
  const postgresMajor = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16");
  assert.equal(postgresMajor, containerMode ? 18 : 16, "Selected PostgreSQL major required");
  failurePostgresMajor = postgresMajor;
  const pgBin = process.env.PG_BIN; assert.ok(pgBin?.startsWith("/"));
  if (containerMode) assert.equal(pgBin, "/usr/lib/postgresql/18/bin", "Fixed PostgreSQL 18 binary directory required");
  assert.match(run(join(pgBin, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`, "u"));
  const sources = containerMode ? { frontend: "/source", course: "/exact-sources/lash-her-course-api", community: "/exact-sources/lash-her-community-api" }
    : { frontend: root, course: resolve(process.env.P2_COURSE_SOURCE_ROOT ?? "/Users/dardan/workspace/lash-her-course-api/.worktrees/phase2-course"),
      community: resolve(process.env.P2_COMMUNITY_SOURCE_ROOT ?? "/Users/dardan/workspace/lash-her-community-api/.worktrees/phase2-community") };
  let commits, sourceManifestSha256 = null;
  if (containerMode) {
    phase = "exact-source-manifest";
    const verified = verifyP2LifecycleOwnedSourceManifest(await readManifest(), sources);
    commits = Object.fromEntries(Object.entries(verified.manifest.sources).map(([name, source]) => [name, source.revision]));
    sourceManifestSha256 = verified.sourceManifestSha256;
  } else {
    commits = Object.fromEntries(Object.entries(sources).map(([name, source]) => {
      const git = (...args) => run("git", ["--no-replace-objects", "--no-optional-locks", ...args], { cwd: source }).trim();
      assert.equal(git("remote", "get-url", "origin"),
        `https://github.com/princessdardan/lash-her-${name === "frontend" ? "frontend" : name + "-api"}.git`);
      if (name !== "frontend") assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", `${name} source must be clean`);
      return [name, git("rev-parse", "--verify", "HEAD^{commit}")];
    }));
    readP2LifecycleOwnedContractSelection(root, { course: commits.course, community: commits.community });
  }
  assert.match(commits.frontend, /^[a-f0-9]{40}$/u);

  const directory = mkdtempSync(join(tmpdir(), "p2-lifecycle-receivers-")); chmodSync(directory, 0o700);
  const data = join(directory, "data"), certificate = join(directory, "server.crt"), key = join(directory, "server.key");
  const clients = []; let running = false;
  try {
    phase = "owned-tls-cluster";
    const probe = createServer(); await new Promise((done, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", done); });
    const port = probe.address().port; await new Promise(done => probe.close(done));
    const clean = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" };
    run(join(pgBin, "initdb"), ["-D", data, "-A", "trust", "-U", "receiver_admin", "-E", "UTF8", "--locale=C"], { env: clean });
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:course-tls,DNS:community-tls,IP:127.0.0.1", "-keyout", key, "-out", certificate], { env: clean }); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all receiver_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"], { env: clean }); running = true;
    const ca = readFileSync(certificate, "utf8");
    const connect = async (options, readRuntime = false) => { const client = new Client({ ...options, ssl: { rejectUnauthorized: true, ca, servername: "localhost" }, enableChannelBinding: true,
      options: `-c search_path=${readRuntime ? "pg_catalog,public" : "public,pg_catalog"}` }); clients.push(client); client.on("error", () => {}); await client.connect(); assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true); return client; };
    const control = await connect({ host: "localhost", port, user: "receiver_admin", database: "postgres" });
    const admin = {}, runtime = {}, targets = {}, migrations = {}, databases = {};
    for (const name of ["frontend", "course", "community"]) {
      phase = `prepare-${name}-database`;
      const database = `owned_receiver_${name}`, role = `owned_${name}_runtime`, password = randomBytes(32).toString("hex");
      await control.query(`create role ${role} login noinherit password '${password}'`); await control.query(`create database ${database}`);
      await control.query(`revoke connect on database ${database} from public`); await control.query(`grant connect on database ${database} to ${role}`);
      admin[name] = await connect({ host: "localhost", port, user: "receiver_admin", database });
      const require = createRequire(join(sources[name], "package.json"));
      const { drizzle } = require("drizzle-orm/node-postgres"), { migrate } = require("drizzle-orm/node-postgres/migrator");
      phase = `migrate-${name}-database`;
      if (name === "frontend") {
        const { frontendMigrationArtifact } = await import(pathToFileURL(join(sources.frontend, "ops/platform/frontend-migration.mjs")).href);
        const artifact = frontendMigrationArtifact(sources.frontend); await admin[name].query("create schema drizzle");
        await admin[name].query("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
        for (const migration of artifact.migrations) { phase = `migrate-frontend-${migration.tag}`; await admin[name].query("begin"); try { for (const statement of migration.sql) await admin[name].query(statement);
          await admin[name].query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); await admin[name].query("commit"); }
        catch (error) { await admin[name].query("rollback"); throw error; } }
      } else await migrate(drizzle(admin[name]), { migrationsFolder: join(sources[name], "drizzle") });
      await admin[name].query(`grant usage on schema public to ${role}`); await admin[name].query(`grant select,insert,update,delete on all tables in schema public to ${role}`);
      await admin[name].query(`grant usage,select on all sequences in schema public to ${role}`);
      databases[name] = { host: "localhost", port, user: role, password, database };
      phase = `verify-${name}-runtime`;
      runtime[name] = await connect({ host: "localhost", port, user: role, password, database }, true);
      const identity = (await runtime[name].query("select current_user::regrole::oid::text as oid")).rows[0];
      const observedTarget = { host: "localhost", port, database, runtimeRole: role, runtimeRoleOid: identity.oid, serverMajor: postgresMajor };
      targets[name] = { targetSha256: p2LifecyclePersistenceTargetSha256(name, observedTarget), ...observedTarget };
      migrations[name] = Number((await admin[name].query("select count(*)::int as count from drizzle.__drizzle_migrations")).rows[0].count);
    }
    assert.deepEqual(migrations, { frontend: 83, course: 22, community: 11 });
    phase = "actual-three-domain-observer";
    const plan = { candidateSha256: hash("owned-candidate"), configurationSha256: hash("owned-configuration"), sources: commits, targets };
    const keys = Object.fromEntries(["course", "community"].map(name => [name, randomBytes(40).toString("hex")]));
    const require = createRequire(join(root, "package.json"));
    const child = fork(join(root, "ops/platform/harness/owned-p2-lifecycle-receivers.mjs"), [], { cwd: root,
      execArgv: ["--import", require.resolve("tsx")],
      env: { ...clean, NODE_ENV: "test", DOTENV_CONFIG_QUIET: "true", DOTENV_CONFIG_PATH: join(directory, "no-dotenv-file"),
        ...(profiledMode && { P2_LIFECYCLE_RECEIVER_PROFILED_OWNED_TEST: "true" }) },
      stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let diagnostic = "";
    child.stdout.on("data", () => {}); child.stderr.on("data", value => { if (diagnostic.length < 1000) diagnostic += value.toString(); });
    let result;
    try {
      result = await new Promise((done, fail) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("OWNED_CHILD_TIMEOUT")); }, 60000);
        child.once("error", error => { clearTimeout(timer); fail(error); });
        child.once("message", value => { clearTimeout(timer); if (value.failure) { const error = new Error(value.failure.message); error.check = value.failure.check; fail(error); } else done(value.result); });
        child.once("exit", code => { if (code !== 0) { clearTimeout(timer); fail(new Error("OWNED_CHILD_FAILED:" + diagnostic.slice(0, 400))); } });
        child.send({ sources, databases, plan, keys, ca, httpsCertificate: readFileSync(certificate, "utf8"), httpsKey: readFileSync(key, "utf8") });
      });
    } finally {
      if (child.exitCode === null) await new Promise(done => { const timer = setTimeout(() => child.kill("SIGKILL"), 5000); child.once("exit", () => { clearTimeout(timer); done(); }); });
    }
    assert.equal(Object.hasOwn(result, "profiledWire"), profiledMode);
    if (profiledMode) {
      assert.equal(result.profiledWire.cases.length, 6);
      assert.equal(result.profiledWire.responseLoss.actualPostCount, 1);
    }
    const receipt = { version: 1, status: `P2_LIFECYCLE_RECEIVER_OWNED_POSTGRES${postgresMajor}_PASS`, postgresMajor, frontendMigrations: 83,
      courseMigrations: 22, communityMigrations: 11, sourceCommits: commits, checks: result.checks, httpCaseCount: result.httpCaseCount, skipped: 0, domainStatePreserving: true, globallyReadOnly: false,
      quotaWritesObserved: result.quotaWritesObserved, deployedFutureGapQualified: false, hostDockerPathQualified: false,
      fixtureOnly: true, providerTouched: false, liveCertification: false,
      ...(profiledMode && { profiledWire: result.profiledWire }),
      ...(containerMode ? { sourceMode: "parent-issued-manifest-and-mounted-readback", sourceManifestSha256 } : {}),
      sourceSha256: Object.fromEntries(["p2-lifecycle-state-witness.mjs", "p2-lifecycle-persistence-probe.mjs", "p2-lifecycle-receiver-post.mjs",
        ...(profiledMode ? ["host/p2_lifecycle_receiver_negative.py", "qualification-target-profile.mjs"] : []),
        ...(containerMode ? ["p2-lifecycle-owned-source-manifest.mjs"] : []), "p2-lifecycle-receiver-negatives.mjs",
        "harness/owned-p2-lifecycle-receivers.mjs", "test-p2-lifecycle-receivers-local.mjs"]
        .map(name => [name, hash(readFileSync(join(root, "ops/platform", name)))])) };
    console.log(JSON.stringify(receipt));
  } finally {
    for (const client of clients.reverse()) { try { await client.end(); } catch {} }
    if (running) { try { run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) { console.error(JSON.stringify({ status: `P2_LIFECYCLE_RECEIVER_OWNED_POSTGRES${failurePostgresMajor}_FAILED`, phase, code: error?.code ?? error?.name ?? "Error",
  ...(typeof error?.constraint === "string" ? { constraint: error.constraint } : {}), ...(typeof error?.table === "string" ? { table: error.table } : {}),
  ...(typeof error?.check === "string" ? { check: error.check } : {}),
  diagnostic: String(error?.message ?? "failure").replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "{email}").slice(0, 180), providerTouched: false })); process.exitCode = 1; }
