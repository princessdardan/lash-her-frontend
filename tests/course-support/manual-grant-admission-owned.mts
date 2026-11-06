// Disposable loopback TLS/SCRAM admission fixture. No configured DB URL is read.
// Course/provider replies are modeled here; the browser fixture runs real Course.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { changeFrontendAdmission } from "../../ops/platform/frontend-admission.mjs";
import { createWriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { body, fixture } from "./manual-grant-fixture";

const bins = process.env.PG_BIN;
if (!bins?.startsWith("/") || process.env.P2Q_MANUAL_GRANT_OWNED !== "true") throw new Error("OWNED_MANUAL_GRANT_CONFIGURATION_REQUIRED");
const safe = { NODE_ENV: "test" as const, ...Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])) };
const execute = (name: string, args: string[]) => execFileSync(name, args, { env: safe, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const major = Number(/PostgreSQL\) (16|18)\./u.exec(execute(join(bins, "postgres"), ["--version"]))?.[1]);
assert.ok([16, 18].includes(major));
const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
const directory = mkdtempSync(join(tmpdir(), "p2q-grant-admission-")), data = join(directory, "data");
const password = `owned-${randomUUID()}`, sourceSha = "c".repeat(40), producerSha256 = "b".repeat(64), targetSha256 = "a".repeat(64);
let started = false, owner: Client | undefined, admin: Client | undefined;
let summary: Record<string, unknown> | undefined;
try {
  execute(join(bins, "initdb"), ["-D", data, "-A", "trust", "-U", "p2q_test_admin", "-E", "UTF8", "--locale=C"]);
  const certificate = join(directory, "server.crt"), key = join(directory, "server.key");
  execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]);
  chmodSync(key, 0o600);
  writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
  writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all p2q_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
  execute(join(bins, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
  const tls = { rejectUnauthorized: true as const, ca: readFileSync(certificate, "utf8") };
  const base = { host: "127.0.0.1", port, ssl: tls, password, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 1000 };
  admin = new Client({ ...base, database: "postgres", user: "p2q_test_admin" }); await admin.connect();
  await admin.query("CREATE DATABASE p2q_grant_owned");
  await admin.query("CREATE ROLE p2q_admission_owner NOLOGIN NOINHERIT");
  await admin.query(`CREATE ROLE p2q_grant_runtime LOGIN NOINHERIT PASSWORD '${password}'`);
  owner = new Client({ ...base, database: "p2q_grant_owned", user: "p2q_test_admin" }); await owner.connect();
  await owner.query("GRANT CREATE ON DATABASE p2q_grant_owned TO p2q_admission_owner");
  await owner.query("BEGIN"); await owner.query("SET LOCAL ROLE p2q_admission_owner");
  await owner.query(readFileSync(new URL("../../ops/platform/frontend-admission.sql", import.meta.url), "utf8"));
  await owner.query("INSERT INTO frontend_admission.control(environment,target_sha256) VALUES('staging',$1)", [targetSha256]);
  await owner.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role,enabled) VALUES($1,$2,'p2q_grant_runtime'::regrole::oid,true)", [producerSha256, sourceSha]);
  await owner.query("GRANT USAGE ON SCHEMA frontend_admission TO p2q_grant_runtime");
  await owner.query("GRANT EXECUTE ON ALL ROUTINES IN SCHEMA frontend_admission TO p2q_grant_runtime"); await owner.query("COMMIT");
  const run = createWriterAdmissionRunner({ getConfiguration: () => ({ target: { environment: "staging", host: "127.0.0.1", port, database: "p2q_grant_owned", user: "p2q_grant_runtime", serverMajor: major as 16 | 18, targetSha256 },
    sourceSha, producerSha256, connection: { ...base, database: "p2q_grant_owned", user: "p2q_grant_runtime", enableChannelBinding: true, application_name: "owned-manual-grant" } }) });
  const closed = fixture(run); assert.equal((await closed.call(body())).status, 503); assert.equal(closed.state.calls, 0);
  await changeFrontendAdmission(owner, { environment: "staging", targetSha256 }, "1", { newWork: true, recovery: false });
  const confirmed = fixture(run); assert.equal((await confirmed.call(body())).status, 200);
  let rows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  assert.deepEqual(rows, [{ state: "completed" }]); assert.equal(confirmed.state.post, 1);
  const unknown = fixture(run), attempt = body(); unknown.state.lostAck = true;
  assert.equal((await unknown.call(attempt)).status, 503);
  rows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  assert.deepEqual(rows.map(row => row.state), ["completed", "uncertain"]);
  unknown.state.lostAck = false; assert.equal((await unknown.call(attempt, "GET")).status, 200); assert.equal(unknown.state.post, 1);
  rows = (await owner.query("SELECT state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  assert.deepEqual(rows.map(row => row.state), ["completed", "uncertain", "completed"], "read reconciliation does not clear original uncertainty");
  assert.equal((await owner.query("SELECT bool_and(ssl) AS tls FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0].tls, true);
  summary = { status: "OWNED_MANUAL_GRANT_ADMISSION_PASS", postgresMajor: major, checks: ["closed-before-auth-or-provider", "whole-operation-single-completed-ledger", "lost-ack-sticky-uncertain", "GET-readback-no-POST-or-counter-clear", "verified-TLS-SCRAM-role"], providerReplies: "modeled", liveActions: false };
} finally {
  await owner?.end(); await admin?.end();
  if (started) execute(join(bins, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify(summary) + "\n");
