// Fresh owned loopback TLS PostgreSQL only. No supplied database URL is read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash, createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { observeFrontendOperationalProviderInventory } from "./frontend-operational-provider-inventory.mjs";
import { observeFrontendGoogleDatabase, frontendGoogleSnapshotSha256 } from "./frontend-google-effects.mjs";

assert.equal(process.env.FRONTEND_PROVIDER_INVENTORY_LOCAL_TEST, "true");
assert.equal(process.versions.node.split(".")[0], "24");
const binaries = process.env.PG_BIN;
assert.ok(binaries?.startsWith("/"));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
assert.match(run(join(binaries, "postgres"), ["--version"]), /PostgreSQL\) (16|18)\./u);
const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-provider-inventory-"))), data = join(directory, "data");
let running = false, client;
try {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "provider_test", "-E", "UTF8", "--locale=C"]);
  const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]); chmodSync(key, 0o600);
  writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\n`);
  writeFileSync(join(data, "pg_hba.conf"), "hostssl all provider_test 127.0.0.1/32 trust\n");
  run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); running = true;
  client = new Client({ host: "127.0.0.1", port, user: "provider_test", database: "postgres",
    ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
  await client.connect();
  const verify = async () => { assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true); };
  const absent = await observeFrontendOperationalProviderInventory(client, verify);
  assert.equal(absent.tables.every(table => table.present === false && table.rowCount === null), true);
  const artifact = frontendMigrationArtifact();
  for (const migration of artifact.migrations) {
    await client.query("BEGIN");
    try { for (const statement of migration.sql) await client.query(statement); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  const baseline = await observeFrontendOperationalProviderInventory(client, verify);
  assert.equal(baseline.tables.every(table => table.present), true);
  const connectionId = randomUUID(), rawKey = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", rawKey, iv);
  cipher.setAAD(Buffer.from("lash-her:booking-calendar-credential:v1"));
  const encrypted = Buffer.concat([cipher.update("private-calendar-refresh-marker"), cipher.final()]);
  const ciphertext = ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
  await client.query(`INSERT INTO booking_calendar_connections(id,provider_account_id,credential_ciphertext)
    VALUES($1::uuid,'123456789',$2)`, [connectionId, ciphertext]);
  const ownerSha256 = createHash("sha256").update("123456789").digest("hex");
  const googleSnapshot = { connections: [{ connectionId, status: "reconnect_required", credentialPresent: true, ownerSha256 }], assignments: [], events: [] };
  const googleReviewed = { projectId: "lash-her-staging-20261022", databaseSnapshotSha256: frontendGoogleSnapshotSha256(googleSnapshot),
    legacyCalendarSha256: null, calendars: [], grants: [{ grantId: `connection:${connectionId}`, ownerSha256, disposition: "retire" }] };
  const googleRuntime = { googleCalendarCredentialEncryptionKey: rawKey.toString("base64") };
  const googleActual = await observeFrontendGoogleDatabase(client, googleReviewed, googleRuntime, verify);
  assert.deepEqual(googleActual.snapshot, googleSnapshot);
  assert.equal(googleActual.grants[0].refreshToken, "private-calendar-refresh-marker");
  assert.equal(JSON.stringify(googleActual.snapshot).includes("private-"), false);
  await assert.rejects(observeFrontendGoogleDatabase(client, { ...googleReviewed, databaseSnapshotSha256: "a".repeat(64) }, googleRuntime, verify),
    /FRONTEND_GOOGLE_DATABASE_BINDING_REFUSED/u);
  await assert.rejects(observeFrontendGoogleDatabase(client, googleReviewed, { googleCalendarCredentialEncryptionKey: randomBytes(32).toString("base64") }, verify),
    /FRONTEND_GOOGLE_DATABASE_BINDING_REFUSED/u);
  await client.query(`INSERT INTO highlevel_connections(location_id,credentials_ciphertext,expires_at,installed_by)
    VALUES('owned-location','private-encrypted-credential-marker',now()+interval '1 hour',$1::uuid)`, [randomUUID()]);
  const actual = await observeFrontendOperationalProviderInventory(client, verify);
  const before = baseline.tables.find(table => table.table === "highlevel_connections"), after = actual.tables.find(table => table.table === "highlevel_connections");
  assert.equal(after.rowCount, 1); assert.equal(after.credentialRecords, 1); assert.notEqual(before.rowsSha256, after.rowsSha256);
  assert.equal(JSON.stringify(actual).includes("private-"), false);
  assert.equal(JSON.stringify(actual).includes("owned-location"), false);
  assert.equal(actual.providerRetirementVerified, false); assert.equal(actual.providerEffectsReconciled, false);
  await client.query(`INSERT INTO highlevel_oauth_states(hash,actor_id,expires_at)
    SELECT i::text,$1::uuid,now()+interval '1 hour' FROM generate_series(1,4097) AS i`, [randomUUID()]);
  await assert.rejects(observeFrontendOperationalProviderInventory(client, verify), /FRONTEND_OPERATIONAL_PROVIDER_INVENTORY_REFUSED/u);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM highlevel_oauth_states")).rows[0].count, 4097);
  let calls = 0;
  await assert.rejects(observeFrontendOperationalProviderInventory(client, async () => { if (++calls === 2) throw new Error("private-lock-loss-marker"); }),
    error => error.message === "FRONTEND_OPERATIONAL_PROVIDER_INVENTORY_REFUSED");
  assert.equal((await client.query("SELECT 1 AS value")).rows[0].value, 1);
  console.log(JSON.stringify({ status: "FRONTEND_PROVIDER_INVENTORY_OWNED_POSTGRES_PASS", migrations: artifact.migrations.length,
    tables: actual.tables.length, googleCredentialAndEventQueries: 5, providerTouched: false, liveQualified: false }));
} finally {
  if (client) await client.end().catch(() => {});
  if (running) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* owned cleanup */ } }
  rmSync(directory, { recursive: true, force: true });
}
