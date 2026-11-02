// Owns a new loopback-only PostgreSQL 18 TLS/SCRAM fixture. No configured URL.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { activateCourseLogins } from "../provision-course-logins.mjs";

const { Client } = createRequire(new URL("../../../package.json", import.meta.url))("pg");
const directory = mkdtempSync(join(tmpdir(), "lash-course-login-owned-"));
const data = join(directory, "data");
const roles = ["lash_her_course_staging_migration", "lash_her_course_staging_runtime"];
const ownerPassword = `owned-owner-${randomUUID()}`, migrationPassword = `owned-migration-${randomUUID()}`, runtimePassword = `owned-runtime-quote'backslash\\-${randomUUID()}`;
const host = "ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech";
const url = (role, password) => `postgresql://${role}:${encodeURIComponent(password)}@${host}/neondb?sslmode=verify-full`;
const values = { COURSE_STAGING_ADMIN_DATABASE_URL: url("neondb_owner", ownerPassword),
  COURSE_STAGING_DATABASE_URL: url(roles[0], migrationPassword), COURSE_STAGING_RUNTIME_DATABASE_URL: url(roles[1], runtimePassword) };
const run = (command, args) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 180000 });
let owner, started = false, phase = "fixture-start";
const binaries = process.env.PG_BIN;
const checks = [];
try {
  phase = "fixture-guard";
  assert.equal(process.env.COURSE_INITIAL_LOGINS_LOCAL_TEST, "true");
  assert.equal(binaries, "/usr/lib/postgresql/18/bin");
  assert.match(run(join(binaries, "postgres"), ["--version"]), /PostgreSQL\) 18\./u);
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  phase = "fixture-initdb";
  run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "neondb_owner", "-E", "UTF8", "--locale=C"]);
  phase = "fixture-certificate";
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(directory, "server.key"), "-out", join(directory, "server.crt")]);
  chmodSync(join(directory, "server.key"), 0o600);
  writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${join(directory, "server.crt")}'\nssl_key_file='${join(directory, "server.key")}'\npassword_encryption='scram-sha-256'\n`);
  writeFileSync(join(data, "pg_hba.conf"), `hostssl all neondb_owner 127.0.0.1/32 trust\nhostssl all ${roles[0]} 127.0.0.1/32 scram-sha-256\nhostssl all ${roles[1]} 127.0.0.1/32 scram-sha-256\n`);
  phase = "fixture-pg-start";
  run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
  const ssl = { rejectUnauthorized: true, ca: readFileSync(join(directory, "server.crt"), "utf8") };
  const local = (config) => new Client({ ...config, host: "127.0.0.1", port, ssl });
  const ownerConfig = { host: "127.0.0.1", port, ssl, user: "neondb_owner", password: ownerPassword, database: "postgres", connectionTimeoutMillis: 5000 };
  phase = "fixture-bootstrap-db";
  owner = new Client(ownerConfig); await owner.connect(); await owner.query("create database neondb"); await owner.end();
  owner = new Client({ ...ownerConfig, database: "neondb" }); await owner.connect();
  await owner.query(readFileSync(new URL("../course-database-roles.sql", import.meta.url), "utf8"));
  const loginFlags = async () => (await owner.query("select rolcanlogin from pg_roles where rolname=any($1::text[]) order by rolname", [roles])).rows.map((r) => r.rolcanlogin);
  assert.deepEqual(await loginFlags(), [false, false]);
  phase = "input-refusals";
  let calls = 0;
  await assert.rejects(activateCourseLogins({ ...values, COURSE_STAGING_DATABASE_URL: values.COURSE_STAGING_DATABASE_URL.replace(host, "another.invalid") },
    { createClient: (config) => { calls++; return local(config); } }), /^Error: COURSE_LOGIN_ACTIVATION_FAILED_REVIEW_ACTUAL_STATE$/u);
  assert.equal(calls, 0); checks.push("wrong-target-refused-before-connect");
  await assert.rejects(activateCourseLogins({ ...values, COURSE_STAGING_RUNTIME_DATABASE_URL: url(roles[1], migrationPassword) },
    { createClient: (config) => { calls++; return local(config); } }));
  assert.equal(calls, 0); checks.push("shared-password-refused-before-connect");
  phase = "unverified-tls-refusal";
  await assert.rejects(activateCourseLogins(values, { createClient: (config) =>
    new Client({ ...config, host: "127.0.0.1", port, ssl: { rejectUnauthorized: false } }) }));
  assert.deepEqual(await loginFlags(), [false, false]); checks.push("unverified-tls-refused-before-role-changes");
  phase = "role-lock-contention";
  await owner.query("begin"); await owner.query("select pg_advisory_xact_lock(5494745940314423301::bigint)");
  try { await assert.rejects(activateCourseLogins(values, { createClient: local })); }
  finally { await owner.query("rollback"); }
  assert.deepEqual(await loginFlags(), [false, false]); checks.push("contended-role-lock-refused");
  phase = "populated-target-refusal";
  await owner.query("create table public.unexpected_fixture(id int)");
  await assert.rejects(activateCourseLogins(values, { createClient: local }));
  assert.deepEqual(await loginFlags(), [false, false]); await owner.query("drop table public.unexpected_fixture");
  checks.push("populated-target-refused-without-login-changes");
  phase = "runtime-privilege-refusal";
  await owner.query(`alter role ${roles[1]} createdb`);
  await assert.rejects(activateCourseLogins(values, { createClient: local }));
  assert.deepEqual(await loginFlags(), [false, false]); await owner.query(`alter role ${roles[1]} nocreatedb`);
  checks.push("runtime-privilege-drift-refused");
  phase = "atomic-rollback";
  await assert.rejects(activateCourseLogins(values, { createClient: (config) => {
    const client = local(config), query = client.query.bind(client);
    if (config.user === "neondb_owner") client.query = (sql, ...args) => {
      if (typeof sql === "string" && sql.startsWith(`ALTER ROLE "${roles[1]}"`)) return Promise.reject(new Error("synthetic private failure"));
      return query(sql, ...args);
    };
    return client;
  } }));
  assert.deepEqual(await loginFlags(), [false, false]); checks.push("second-role-failure-rolls-back-both");
  phase = "commit-failure-diagnostic";
  await assert.rejects(activateCourseLogins(values, { createClient: (config) => {
    const client = local(config), query = client.query.bind(client);
    if (config.user === "neondb_owner") client.query = (sql, ...args) => {
      if (sql === "COMMIT") return Promise.reject(Object.assign(new Error(runtimePassword), { code: "XX000" }));
      return query(sql, ...args);
    };
    return client;
  } }), (error) => error.phase === "commit" && error.sqlState === "XX000" && error.commitState === "unknown" &&
    !JSON.stringify(error).includes(runtimePassword) && !String(error).includes(runtimePassword));
  assert.deepEqual(await loginFlags(), [false, false]); checks.push("commit-error-sanitized-and-both-roles-rolled-back");
  phase = "initial-activation";
  const result = await activateCourseLogins(values, { createClient: local });
  assert.equal(result.status, "COURSE_INITIAL_LOGINS_VERIFIED"); assert.deepEqual(await loginFlags(), [true, true]);
  assert.equal(result.migrationPerformed, false); checks.push("both-distinct-scram-logins-verified-over-tls");
  checks.push("neon-compatible-password-literals-escape-quotes-and-backslashes");
  phase = "existing-login-refusal";
  await assert.rejects(activateCourseLogins(values, { createClient: local }));
  checks.push("second-activation-refused-without-password-rotation");
  for (const [index, password] of [[0, migrationPassword], [1, runtimePassword]]) {
    const client = local({ user: roles[index], password, database: "neondb", connectionTimeoutMillis: 1000 });
    try { await client.connect(); assert.equal((await client.query("select current_user")).rows[0].current_user, roles[index]); }
    finally { await client.end(); }
  }
  const wrong = local({ user: roles[1], password: migrationPassword, database: "neondb", connectionTimeoutMillis: 1000 });
  try { await assert.rejects(wrong.connect(), (error) => error.code === "28P01"); } finally { await wrong.end(); }
  checks.push("wrong-runtime-password-denied");
  assert.equal((await owner.query("select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')")).rows[0].count, 0);
  checks.push("application-schema-unchanged");
  console.log(JSON.stringify({ status: "COURSE_INITIAL_LOGIN_OWNED_POSTGRES18_PASS", checks, providerTouched: false, credentialValuesDisplayed: false }));
} catch (error) {
  const sqlState = /^[A-Z0-9]{5}$/u.test(error?.code ?? "") ? error.code : null;
  const guard = String(error?.message ?? "").match(/COURSE_ROLE_[A-Z_]+/u)?.[0] ?? null;
  const fixtureLog = started ? readFileSync(join(directory, "postgres.log"), "utf8") : "";
  const fixtureErrors = fixtureLog.split("\n").filter((line) => /FATAL|ERROR|could not|SSL/u.test(line)).slice(-8)
    .map((line) => line.replaceAll(ownerPassword, "[fixture]").replaceAll(migrationPassword, "[fixture]").replaceAll(runtimePassword, "[fixture]").slice(0, 400));
  console.error(JSON.stringify({ status: "OWNED_COURSE_LOGIN_FIXTURE_FAILED", phase, sqlState, guard,
    fixtureErrors,
    fixtureMessage: String(error?.message ?? "").replaceAll(ownerPassword, "[fixture]").replaceAll(migrationPassword, "[fixture]").replaceAll(runtimePassword, "[fixture]").slice(0, 250),
    childExitCode: Number.isInteger(error?.status) ? error.status : null,
    assertionFailure: error?.code === "ERR_ASSERTION" })); process.exitCode = 1;
} finally {
  if (owner) await owner.end().catch(() => {});
  if (started) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { console.error("Owned cluster cleanup requires review"); process.exitCode = 1; } }
  rmSync(directory, { recursive: true, force: true });
}
