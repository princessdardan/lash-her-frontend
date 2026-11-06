// Explicit owned PostgreSQL 16/18 fixture. No external database or provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { observeP2SuspensionPending, p2SuspensionEvidenceSha256 } from "./p2-lifecycle-pending-probe.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
let phase = "owned-preflight";
async function main() {
  assert.equal(process.env.P2_LIFECYCLE_PENDING_OWNED_TEST, "true"); assert.equal(process.versions.node.split(".")[0], "24");
  const pgBin = process.env.PG_BIN, major = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16");
  assert.ok(pgBin?.startsWith("/") && [16, 18].includes(major)); assert.match(run(join(pgBin, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const directory = mkdtempSync(join(tmpdir(), "p2-pending-owned-")); chmodSync(directory, 0o700);
  const data = join(directory, "data"), cert = join(directory, "server.crt"), key = join(directory, "server.key"), checks = [], clients = [];
  let started = false;
  try {
    const socket = createServer(); await new Promise((done, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", done); });
    const port = socket.address().port; await new Promise(done => socket.close(done));
    const env = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" };
    run(join(pgBin, "initdb"), ["-D", data, "-A", "trust", "-U", "owned_pending_admin", "-E", "UTF8", "--locale=C"], { env });
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { env }); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "hostssl all owned_pending_admin 127.0.0.1/32 trust\n");
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"], { env }); started = true;
    const target = { host: "localhost", port, user: "owned_pending_admin", database: "owned_suspension_pending", serverMajor: major };
    const connect = async database => {
      const client = new Client({ ...target, database, ssl: { rejectUnauthorized: true, ca: readFileSync(cert, "utf8"), servername: "localhost" }, options: "-c search_path=public" });
      clients.push(client); await client.connect(); assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true); return client;
    };
    const control = await connect("postgres"); await control.query(`CREATE DATABASE ${target.database}`);
    const client = await connect(target.database), artifact = frontendMigrationArtifact(root);
    phase = "actual-source-migrations";
    assert.equal(artifact.migrations.length, 83);
    for (const migration of artifact.migrations) { await client.query("BEGIN"); try { for (const sql of migration.sql) await client.query(sql); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } }
    const userId = randomUUID(), adminId = randomUUID(), commandId = randomUUID(), at = new Date(Date.now() - 1000).toISOString();
    await client.query("INSERT INTO public.admin_users(id,provider_user_id,email,email_normalized,role,status) VALUES($1,$2,'owned-owner@example.invalid','owned-owner@example.invalid','owner','active')", [adminId, randomUUID()]);
    await client.query("INSERT INTO public.customer_users(id,email,status,account_version) VALUES($1,'owned-pending@example.invalid','suspended',1)", [userId]);
    const command = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt: at };
    await client.query("INSERT INTO public.customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command,requested_by_admin_id) VALUES($1,$2,1,$3,'suspend',$4,$5,$6)", [commandId, userId, randomUUID(), at, command, adminId]);
    for (const receiver of ["course", "community"]) await client.query("INSERT INTO public.customer_account_deliveries(command_id,receiver) VALUES($1,$2)", [commandId, receiver]);
    const selection = { userId, commandId, accountVersion: 1, requestId: randomUUID(), responseObservedAt: at, controlledDenialObservedAt: at };
    const backend = (await client.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid;
    const dependencies = { verifyEnvironment: async () => {}, verifySession: async () => assert.equal((await client.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid, backend) };
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", ["lash-her:private-db:migrations"]);
    const contender = await connect(target.database);
    assert.equal((await contender.query("SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held", ["lash-her:private-db:migrations"])).rows[0].held, false);
    checks.push("actual-tls-physical-backend-and-exclusive-lock-contention");
    phase = "fixed-pending-observer";
    const positive = await observeP2SuspensionPending(client, target, selection, dependencies);
    assert.equal(positive.command.commandId, commandId); assert.equal(positive.requestedByAdminId, adminId);
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
    checks.push("actual83-migrations-canonical-command-owner-attribution-and-two-pending-zero-attempts");
    const fault = async (sql, args, repair) => {
      await client.query(sql, args); await assert.rejects(observeP2SuspensionPending(client, target, selection, dependencies)); await repair();
      assert.equal((await observeP2SuspensionPending(client, target, selection, dependencies)).status, positive.status);
    };
    await fault("UPDATE public.customer_account_deliveries SET attempts=1 WHERE command_id=$1 AND receiver='course'", [commandId], () => client.query("UPDATE public.customer_account_deliveries SET attempts=0 WHERE command_id=$1", [commandId]));
    checks.push("actual-worker-attempt-before-recorder-refused-and-repair-positive");
    await fault("UPDATE public.customer_account_deliveries SET lease_id=$2,lease_until=pg_catalog.clock_timestamp()+interval '90 seconds' WHERE command_id=$1 AND receiver='community'", [commandId, randomUUID()],
      () => client.query("UPDATE public.customer_account_deliveries SET lease_id=NULL,lease_until=NULL WHERE command_id=$1", [commandId]));
    checks.push("actual-inflight-delivery-refused-and-repair-positive");
    await fault("UPDATE public.customer_account_deliveries SET status='acknowledged',attempts=1,acknowledged_at=pg_catalog.clock_timestamp() WHERE command_id=$1 AND receiver='course'", [commandId],
      () => client.query("UPDATE public.customer_account_deliveries SET status='pending',attempts=0,acknowledged_at=NULL WHERE command_id=$1", [commandId]));
    checks.push("actual-already-acknowledged-delivery-refused-and-repair-positive");
    await fault("UPDATE public.admin_users SET role='admin' WHERE id=$1", [adminId], () => client.query("UPDATE public.admin_users SET role='owner' WHERE id=$1", [adminId]));
    checks.push("actual-nonowner-attribution-refused-and-repair-positive");
    await assert.rejects(observeP2SuspensionPending(client, { ...target, user: "foreign_operator" }, selection, dependencies));
    checks.push("actual-wrong-session-identity-refused");
    await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", ["lash-her:private-db:migrations"]);
    await assert.rejects(observeP2SuspensionPending(client, target, selection, dependencies));
    checks.push("actual-missing-physical-lock-refused");
    return { version: 1, status: "P2_LIFECYCLE_PENDING_OWNED_PASS", postgresMajor: major, frontendMigrations: 83, checks, skipped: 0,
      actualTlsPostgres: true, actualPendingSelect: true, controlledTokenExpiryQualified: false, browserQualified: false,
      hostDockerPathQualified: false, fixtureOnly: true, providerTouched: false, releaseAccepted: false,
      sourceSha256: p2SuspensionEvidenceSha256(readFileSync(new URL("./p2-lifecycle-pending-probe.mjs", import.meta.url))) };
  } finally {
    for (const client of clients.reverse()) try { await client.end(); } catch {}
    if (started) try { run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}
main().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(JSON.stringify({ status: "P2_LIFECYCLE_PENDING_OWNED_FAILED", phase,
  code: error?.code ?? error?.name ?? "Error", providerTouched: false })); process.exitCode = 1; });
