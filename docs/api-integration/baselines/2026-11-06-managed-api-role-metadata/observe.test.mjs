import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { rootCertificates } from "node:tls";
import { Client } from "pg";
import { CONTEXTS, SQL, STARTUP_OPTIONS, parseGroup, sanitizeMetadata, identityDiagnostic, checkIdentity } from "./observe.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
function group(context = CONTEXTS[0], overrides = {}) {
  const url = new URL(`postgresql://${context.runtimeRole}:synthetic-fixture-only@${context.host}:5432/neondb?sslmode=require`);
  for (const [key, value] of Object.entries(overrides)) url[key] = value;
  const rawFiles = Object.fromEntries(context.files.map(name => [name, Buffer.from(`DATABASE_TARGET=staging\nSTAGING_DATABASE_URL=${url.href}\n`)]));
  const hashes = Object.fromEntries(Object.entries(rawFiles).map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]));
  return { context, rawFiles, hashes };
}
const parse = fixture => parseGroup(fixture.context, fixture.rawFiles, fixture.hashes);
const code = expected => error => error.publicCode === expected && error.message === "MANAGED_API_METADATA_REFUSED";

test("only the two fixed accepted direct credential groups parse", () => {
  for (const context of CONTEXTS) {
    const result = parse(group(context));
    assert.equal(result.host, context.host); assert.equal(result.database, "neondb");
    assert.equal(result.user, context.runtimeRole); assert.equal(result.password.length, 22);
    assert.deepEqual(Object.keys(result).sort(), ["database", "host", "password", "port", "user"]);
  }
  const f = group(); f.context = { ...f.context };
  assert.throws(() => parse(f), code("FIXED_CREDENTIAL_GROUP_REQUIRED"));
});

test("modified or incomplete accepted file groups refuse before any connection", () => {
  const changed = group(); changed.rawFiles[changed.context.files[0]] = Buffer.from("changed");
  assert.throws(() => parse(changed), code("ACCEPTED_RUNTIME_BYTES_CHANGED"));
  const missing = group(); delete missing.rawFiles[missing.context.files[0]];
  assert.throws(() => parse(missing), code("FIXED_CREDENTIAL_GROUP_REQUIRED"));
  const disagree = group(); disagree.rawFiles[disagree.context.files[0]] = Buffer.from(`DATABASE_TARGET=staging\nSTAGING_DATABASE_URL=postgresql://other\n`);
  disagree.hashes[disagree.context.files[0]] = createHash("sha256").update(disagree.rawFiles[disagree.context.files[0]]).digest("hex");
  assert.throws(() => parse(disagree), code("CREDENTIAL_GROUP_DISAGREES"));
});

test("pooler selector requires explicit review and cannot silently become a direct connection", () => {
  assert.throws(() => parse(group(CONTEXTS[0], { hostname: CONTEXTS[0].host.replace(".", "-pooler.") })), code("POOLER_SELECTOR_REQUIRES_EXPLICIT_REVIEW"));
});

test("foreign host, role, database, port and TLS query substitutions refuse", () => {
  for (const overrides of [{ hostname: "foreign.invalid" }, { username: "neondb_owner" }, { pathname: "/other" }, { port: "6432" }, { hash: "fragment" }]) {
    assert.throws(() => parse(group(CONTEXTS[0], overrides)), code("FIXED_RUNTIME_SELECTOR_REQUIRED"));
  }
  for (const search of ["?sslmode=disable", "?sslmode=require&sslmode=require", "?sslmode=require&sslrootcert=other"])
    assert.throws(() => parse(group(CONTEXTS[0], { search })), code("RUNTIME_TLS_SELECTOR_REFUSED"));
});

test("raw parser refuses duplicate keys, assignments containing controls and foreign environment", () => {
  for (const suffix of ["DATABASE_TARGET=staging\n", "INVALID=embedded\u0000value\n"] ) {
    const f = group(); for (const name of f.context.files) { f.rawFiles[name] = Buffer.concat([f.rawFiles[name], Buffer.from(suffix)]); f.hashes[name] = createHash("sha256").update(f.rawFiles[name]).digest("hex"); }
    assert.throws(() => parse(f), code("RAW_RUNTIME_FORMAT_REQUIRED"));
  }
  const f = group(); for (const name of f.context.files) { f.rawFiles[name] = Buffer.from(f.rawFiles[name].toString().replace("DATABASE_TARGET=staging", "DATABASE_TARGET=production")); f.hashes[name] = createHash("sha256").update(f.rawFiles[name]).digest("hex"); }
  assert.throws(() => parse(f), code("STAGING_RUNTIME_REQUIRED"));
});

test("unallowlisted role names are removed without losing OID relationships", () => {
  const original = { roles: [{ role_oid: "1234", role_name: "private-person@example.invalid" }, { role_oid: "1235", role_name: "ordinary_unreviewed_name" }, { role_oid: "1236", role_name: CONTEXTS[0].runtimeRole }],
    schemas: [{ owner_oid: "1234", owner_name: "private-person@example.invalid", schema_name: "public" }, { owner_oid: "1235", owner_name: "ordinary_unreviewed_name", schema_name: "unsafe.schema" }],
    identity: { database_owner_name: "private-person@example.invalid", authenticated_role: CONTEXTS[0].runtimeRole },
    databaseRoleSettings: [{ role_scope_oid: "1234", setting_names: ["search_path", "statement_timeout", "value=must-not-appear"] }] };
  const clean = sanitizeMetadata(original); const serialized = JSON.stringify(clean);
  for (const absent of ["private-person", "ordinary_unreviewed_name", "unsafe.schema", "value=must-not-appear"]) assert.equal(serialized.includes(absent), false);
  assert.equal(clean.roles[0].role_oid, "1234"); assert.equal(clean.roles[0].role_name, null); assert.equal(clean.roles[2].role_name, CONTEXTS[0].runtimeRole);
  assert.equal(clean.schemas[0].owner_oid, "1234"); assert.equal(clean.redactions.roleNames, 5); assert.equal(clean.redactions.identifiers, 2);
  assert.equal(original.roles[0].role_name, "private-person@example.invalid");
});

test("default CLI is plan-only even when no private credential context is provided", () => {
  const child = spawnSync(process.execPath, [join(directory, "observe.mjs")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  assert.equal(child.status, 0); assert.equal(child.stderr, ""); const result = JSON.parse(child.stdout);
  assert.equal(result.status, "P2_MANAGED_API_METADATA_PLAN"); assert.equal(result.connectionsOpened, 0); assert.equal(result.contexts.length, 2);
  const denied = spawnSync(process.execPath, [join(directory, "observe.mjs"), "--apply"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  assert.equal(denied.status, 1); assert.equal(JSON.parse(denied.stdout).status, "P2_MANAGED_API_METADATA_REFUSED");
});

test("literal SQL closure contains catalog reads only and startup settings precede the first query", () => {
  assert.equal(Object.keys(SQL).length, 6);
  for (const sql of Object.values(SQL)) {
    assert.match(sql, /^(?:SELECT|WITH RECURSIVE)\b/u);
    const statementTokens = sql.replace(/'(?:''|[^'])*'/gu, "''");
    assert.doesNotMatch(statementTokens, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|SET ROLE|BEGIN|COMMIT|ROLLBACK|pg_advisory|__drizzle|password|rolpassword)\b/iu);
    assert.doesNotMatch(sql, /::(?:text|oid|integer|int4|regrole)\b/u);
    assert.doesNotMatch(sql, /\b(?:FROM|JOIN)\s+(?!pg_catalog\.|relevant\b|LATERAL\b)/iu);
  }
  assert.match(STARTUP_OPTIONS, /^-c search_path=pg_catalog,public -c default_transaction_read_only=on /u);
  assert.match(SQL.databaseRoleSettings, /split_part\(config.setting, '=', 1\)/u);
});

test("observer identity accepts authorized client TLS independently of backend metadata and refuses every required mismatch", () => {
  const context = CONTEXTS[0];
  const row = { database_name: context.database, authenticated_role: context.runtimeRole, session_role: context.runtimeRole, server_major: 18,
    read_only: "on", session_search_path: "pg_catalog,public", server_reports_tls: true, backend_pid: 123 };
  const client = { connection: { stream: { encrypted: true, authorized: true, getProtocol: () => "TLSv1.3" } },
    connectionParameters: { host: context.host, port: context.port, ssl: { ca: [...rootCertificates], servername: context.host, rejectUnauthorized: true } } };
  assert.equal(checkIdentity([row], context, client), row);
  for (const [field, value, failed] of [["database_name", "private-db", "database"], ["authenticated_role", "private-person@example.invalid", "authenticatedRole"],
    ["session_role", "private-session", "sessionRole"], ["server_major", 19, "serverMajor"], ["read_only", "off", "readOnly"],
    ["session_search_path", "private-setting-value", "searchPath"], ["backend_pid", 0, "positiveBackendPid"]]) {
    const modified = { ...row, [field]: value }, diagnostic = identityDiagnostic([modified], context, client);
    assert.deepEqual(Object.entries(diagnostic.matches).filter(([, matched]) => !matched).map(([name]) => name), [failed]);
    assert.throws(() => checkIdentity([modified], context, client), code("EXACT_READONLY_IDENTITY_REQUIRED"));
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-db|private-person|private-session|private-setting-value/u);
  }
  const serverTlsFalse = identityDiagnostic([{ ...row, server_reports_tls: false }], context, client);
  assert.equal(serverTlsFalse.observed.backendReportsTls, false); assert.equal(serverTlsFalse.matches.clientAuthorized, true);
  assert.equal(checkIdentity([{ ...row, server_reports_tls: false }], context, client).server_reports_tls, false);
  assert.deepEqual(serverTlsFalse.observed, { serverMajor: 18, transactionReadOnly: "on", clientTlsProtocol: "TLSv1.3", backendReportsTls: false, backendTlsProtocol: null });
  for (const [container, field] of [[client.connection.stream, "encrypted"], [client.connection.stream, "authorized"]]) {
    container[field] = false; assert.throws(() => checkIdentity([row], context, client), code("EXACT_READONLY_IDENTITY_REQUIRED")); container[field] = true;
  }
  client.connectionParameters.host = "foreign.invalid"; assert.throws(() => checkIdentity([row], context, client), code("EXACT_READONLY_IDENTITY_REQUIRED")); client.connectionParameters.host = context.host;
  client.connectionParameters.port = "5432"; assert.throws(() => checkIdentity([row], context, client), code("EXACT_READONLY_IDENTITY_REQUIRED")); client.connectionParameters.port = context.port;
  const acceptedSsl = client.connectionParameters.ssl;
  for (const changedSsl of [{ ...acceptedSsl, ca: [] }, { ...acceptedSsl, servername: "foreign.invalid" }, { ...acceptedSsl, rejectUnauthorized: false }, false]) {
    client.connectionParameters.ssl = changedSsl; assert.throws(() => checkIdentity([row], context, client), code("EXACT_READONLY_IDENTITY_REQUIRED"));
  }
  client.connectionParameters.ssl = acceptedSsl;
  assert.throws(() => checkIdentity([], context, client), code("IDENTITY_ROW_REQUIRED"));
});

test("all six literal metadata queries execute twice against an actual owned PG16 cluster", { skip: process.env.OWNED_METADATA_SQL_TEST !== "true" && "set OWNED_METADATA_SQL_TEST=true and fixed PG_BIN to run the owned cluster" }, async () => {
  const binaries = process.env.PG_BIN; assert.equal(binaries, "/opt/homebrew/opt/postgresql@16/bin");
  const run = (name, args) => execFileSync(join(binaries, name), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  assert.match(run("postgres", ["--version"]), /PostgreSQL\) 16\./u);
  const listener = createServer(); await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "p2-api-metadata-owned-"))); chmodSync(temporary, 0o700); const data = join(temporary, "data"); let started = false, client;
  try {
    run("initdb", ["-D", data, "-A", "trust", "-U", "owned_metadata", "-E", "UTF8", "--locale=C"]);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
    run("pg_ctl", ["-D", data, "-l", join(temporary, "postgres.log"), "-w", "start"]); started = true;
    client = new Client({ host: "127.0.0.1", port, database: "postgres", user: "owned_metadata", password: "fixture-only", ssl: false, options: STARTUP_OPTIONS });
    await client.connect(); const observations = [];
    for (let iteration = 0; iteration < 2; iteration++) {
      const result = {}; result.identity = (await client.query(SQL.identity)).rows;
      assert.equal(result.identity[0].read_only, "on"); assert.equal(result.identity[0].session_search_path, "pg_catalog,public");
      const diagnostic = identityDiagnostic(result.identity, CONTEXTS[0], client);
      assert.equal(diagnostic.observed.serverMajor, 16); assert.equal(diagnostic.observed.transactionReadOnly, "on");
      assert.equal(diagnostic.matches.serverMajor, false); assert.equal(diagnostic.matches.clientEncrypted, false);
      result.roles = (await client.query(SQL.roles, [["owned_metadata", "pg_database_owner"]])).rows; const oids = result.roles.map(row => row.role_oid);
      for (const [name, parameters] of [["memberships", [oids]], ["schemas", []], ["schemaAcl", []], ["databaseRoleSettings", [oids]]]) result[name] = (await client.query(SQL[name], parameters)).rows;
      observations.push(result);
    }
    assert.deepEqual(observations[0], observations[1]); assert.ok(observations[0].schemas.some(row => row.schema_name === "public"));
    assert.ok(observations[0].schemaAcl.some(row => row.grantee_public === true));
  } finally {
    if (client) await client.end(); if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(temporary, { recursive: true, force: true });
  }
});
