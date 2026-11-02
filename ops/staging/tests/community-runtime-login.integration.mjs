// A new loopback-only owned PostgreSQL18 cluster; no provider URLs are accepted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { configureCommunityRuntimeLogin } from "../provision-community-runtime-login.mjs";

const { Client, escapeLiteral } = createRequire(new URL("../../../package.json", import.meta.url))("pg");
const directory = mkdtempSync(join(tmpdir(), "lash-community-login-owned-"));
const data = join(directory, "data"), role = "lash_her_community_staging_runtime";
const ownerPassword = `owned-owner-${randomUUID()}`, oldPassword = `owned-old-${randomUUID()}`;
const newPassword = `owned-new-quote'backslash\\-${randomUUID()}`;
const host = "ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech";
const url = (user, password) => `postgresql://${user}:${encodeURIComponent(password)}@${host}/neondb?sslmode=verify-full`;
const values = { COMMUNITY_STAGING_DATABASE_URL: url("neondb_owner", ownerPassword), COMMUNITY_STAGING_RUNTIME_DATABASE_URL: url(role, newPassword) };
const run = (command, args) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 180000 });
const binaries = process.env.PG_BIN, checks = [];
let owner, started = false, phase = "fixture-guard";
try {
  assert.equal(process.env.COMMUNITY_RUNTIME_CREDENTIAL_LOCAL_TEST, "true");
  assert.equal(binaries, "/usr/lib/postgresql/18/bin");
  assert.match(run(join(binaries, "postgres"), ["--version"]), /PostgreSQL\) 18\./u);
  const probe = createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  phase = "fixture-initdb";
  run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "neondb_owner", "-E", "UTF8", "--locale=C"]);
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", join(directory, "server.key"), "-out", join(directory, "server.crt")]); chmodSync(join(directory, "server.key"), 0o600);
  writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${join(directory, "server.crt")}'\nssl_key_file='${join(directory, "server.key")}'\npassword_encryption='scram-sha-256'\n`);
  writeFileSync(join(data, "pg_hba.conf"), `hostssl all neondb_owner 127.0.0.1/32 trust\nhostssl all ${role} 127.0.0.1/32 scram-sha-256\n`);
  run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
  const ssl = { rejectUnauthorized: true, ca: readFileSync(join(directory, "server.crt"), "utf8") };
  const local = (config) => new Client({ ...config, host: "127.0.0.1", port, ssl });
  const ownerConfig = { host: "127.0.0.1", port, ssl, user: "neondb_owner", password: ownerPassword, database: "postgres", connectionTimeoutMillis: 5000 };
  owner = new Client(ownerConfig); await owner.connect(); await owner.query("create database neondb"); await owner.end();
  owner = new Client({ ...ownerConfig, database: "neondb" }); await owner.connect();
  await owner.query("CREATE ROLE neon_superuser NOLOGIN");
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD ${escapeLiteral(oldPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await owner.query(`GRANT ${role} TO neondb_owner WITH ADMIN OPTION`);
  const login = async (password) => {
    const client = local({ user: role, password, database: "neondb", connectionTimeoutMillis: 1000 });
    try { await client.connect(); assert.equal((await client.query("select current_user")).rows[0].current_user, role); }
    finally { await client.end(); }
  };
  const apply = (overrides = {}) => configureCommunityRuntimeLogin(values, { setPassword: true, createClient: local, ...overrides });
  phase = "input-refusals"; let calls = 0;
  for (const changed of [
    { COMMUNITY_STAGING_RUNTIME_DATABASE_URL: values.COMMUNITY_STAGING_RUNTIME_DATABASE_URL.replace(host, "another.invalid") },
    { COMMUNITY_STAGING_RUNTIME_DATABASE_URL: url(role, ownerPassword) },
    { COMMUNITY_STAGING_RUNTIME_DATABASE_URL: values.COMMUNITY_STAGING_RUNTIME_DATABASE_URL.replace("verify-full", "require") },
  ]) await assert.rejects(configureCommunityRuntimeLogin({ ...values, ...changed }, { setPassword: true, createClient: (config) => { calls++; return local(config); } }));
  assert.equal(calls, 0); checks.push("wrong-target-shared-password-and-weaker-tls-refused-before-connect");
  phase = "tls-refusal";
  await assert.rejects(apply({ createClient: (config) => new Client({ ...config, host: "127.0.0.1", port, ssl: { rejectUnauthorized: false } }) }));
  await login(oldPassword); checks.push("unverified-tls-does-not-change-password");
  phase = "verify-wrong-password";
  await assert.rejects(configureCommunityRuntimeLogin(values, { createClient: local }));
  await login(oldPassword); checks.push("verification-never-sets-a-password");
  phase = "lock-contention";
  await owner.query("begin"); await owner.query("select pg_advisory_xact_lock(5494745940314423301::bigint)");
  try { await assert.rejects(apply()); } finally { await owner.query("rollback"); }
  await login(oldPassword); checks.push("contended-role-lock-refused");
  phase = "populated-refusal";
  await owner.query("create table public.owned_fixture(id int)");
  try { await assert.rejects(apply()); } finally { await owner.query("drop table public.owned_fixture"); }
  await login(oldPassword); checks.push("populated-target-refuses-password-change");
  phase = "privilege-refusal";
  await owner.query(`alter role ${role} createdb`);
  try { await assert.rejects(apply()); } finally { await owner.query(`alter role ${role} nocreatedb`); }
  await login(oldPassword); checks.push("elevated-runtime-role-refused");
  phase = "active-client-refusal";
  const active = local({ user: role, password: oldPassword, database: "neondb" }); await active.connect();
  try { await assert.rejects(apply()); } finally { await active.end(); }
  await login(oldPassword); checks.push("active-runtime-client-refuses-password-change");
  phase = "atomic-rollback";
  await assert.rejects(apply({ createClient: (config) => {
    const client = local(config), query = client.query.bind(client);
    if (config.user === "neondb_owner") client.query = (sql, ...args) => typeof sql === "string" && sql.startsWith("ALTER ROLE") ? Promise.reject(new Error(newPassword)) : query(sql, ...args);
    return client;
  } }));
  await login(oldPassword); checks.push("role-write-failure-preserves-old-credential");
  phase = "commit-failure";
  await assert.rejects(apply({ createClient: (config) => {
    const client = local(config), query = client.query.bind(client);
    if (config.user === "neondb_owner") client.query = (sql, ...args) => sql === "COMMIT" ? Promise.reject(Object.assign(new Error(newPassword), { code: "XX000" })) : query(sql, ...args);
    return client;
  } }), (error) => error.phase === "commit" && error.sqlState === "XX000" && error.commitState === "unknown" && !JSON.stringify(error).includes(newPassword) && !String(error).includes(newPassword));
  await login(oldPassword); checks.push("commit-error-is-sanitized-uncertain-and-not-retried");
  phase = "handoff-apply";
  const result = await apply(); assert.equal(result.status, "COMMUNITY_RUNTIME_LOGIN_VERIFIED"); assert.equal(result.passwordConfigured, true);
  await login(newPassword); await assert.rejects(login(oldPassword), (error) => error.code === "28P01");
  checks.push("new-scram-password-with-quotes-and-backslashes-authenticates-old-password-denied");
  phase = "verification-only"; let writes = 0;
  const verified = await configureCommunityRuntimeLogin(values, { createClient: (config) => {
    const client = local(config), query = client.query.bind(client);
    client.query = (sql, ...args) => { if (typeof sql === "string" && /^(?:ALTER|CREATE|GRANT|REVOKE)/u.test(sql)) writes++; return query(sql, ...args); };
    return client;
  } });
  assert.equal(verified.passwordConfigured, false); assert.equal(writes, 0); checks.push("existing-credential-verified-read-only-without-rotation");
  phase = "lost-commit-acknowledgement"; let commits = 0;
  await assert.rejects(apply({ createClient: (config) => {
    const client = local(config), query = client.query.bind(client);
    if (config.user === "neondb_owner") client.query = async (sql, ...args) => {
      const result = await query(sql, ...args);
      if (sql === "COMMIT") { commits++; throw Object.assign(new Error(newPassword), { code: "08006" }); }
      return result;
    };
    return client;
  } }), (error) => error.phase === "commit" && error.commitState === "unknown" && !String(error).includes(newPassword));
  assert.equal(commits, 1);
  assert.equal((await configureCommunityRuntimeLogin(values, { createClient: local })).passwordConfigured, false);
  checks.push("lost-commit-acknowledgement-reconciled-by-read-only-verification-without-retry");
  assert.equal((await owner.query("select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')")).rows[0].count, 0);
  assert.equal((await owner.query("select has_schema_privilege($1,'public','CREATE') as allowed", [role])).rows[0].allowed, false);
  checks.push("schema-and-runtime-create-privileges-unchanged");
  console.log(JSON.stringify({ status: "COMMUNITY_RUNTIME_CREDENTIAL_OWNED_POSTGRES18_PASS", checks, providerTouched: false, credentialValuesDisplayed: false }));
} catch (error) {
  console.error(JSON.stringify({ status: "COMMUNITY_RUNTIME_CREDENTIAL_OWNED_FIXTURE_FAILED", phase,
    sqlState: /^[A-Z0-9]{5}$/u.test(error?.code ?? "") ? error.code : null, assertionFailure: error?.code === "ERR_ASSERTION" })); process.exitCode = 1;
} finally {
  if (owner) await owner.end().catch(() => {});
  if (started) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { console.error("Owned cluster cleanup requires review"); process.exitCode = 1; } }
  rmSync(directory, { recursive: true, force: true });
}
