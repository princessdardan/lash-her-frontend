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
import { observeFrontendCrmShippingDatabase, frontendCrmShippingSnapshotSha256 } from "./frontend-crm-shipping-effects.mjs";
import { historicalSourceSha256 as sourceHash, verifiedSourceRequirements } from "./frontend-historical-source.mjs";
import { observeFrontendHistoricalSourceContexts } from "./frontend-historical-source-observer.mjs";
import { observeFrontendScopedProviderDatabase } from "./frontend-provider-effect-scopes.mjs";
import { observeHistoricalFrontendCapabilityBindings, observeHistoricalFrontendDatabaseFence } from "./frontend-historical-capabilities.mjs";

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
  writeFileSync(join(data, "pg_hba.conf"), "hostssl all provider_test 127.0.0.1/32 trust\nhostssl all provider_retired 127.0.0.1/32 scram-sha-256\n");
  run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); running = true;
  client = new Client({ host: "127.0.0.1", port, user: "provider_test", database: "postgres",
    ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
  await client.connect();
  const verify = async () => { assert.equal(client.connection.stream.encrypted, true); assert.equal(client.connection.stream.authorized, true); };
  await client.query("CREATE ROLE provider_retired LOGIN NOINHERIT PASSWORD 'owned-capability-fixture-password'");
  const retiredOid = (await client.query("SELECT oid::text FROM pg_roles WHERE rolname='provider_retired'")).rows[0].oid;
  const capabilityPlan = { actionId: "owned-capability", sourceCommit: "a".repeat(40), targetSha256: "b".repeat(64),
    historicalLogins: { target: { host: "127.0.0.1", port, database: "postgres", serverMajor: Number(run(join(binaries, "postgres"), ["--version"]).match(/PostgreSQL\) (\d+)/u)[1]) } } };
  const capabilityBindings = { surfaces: [{ kind: "deployment", surfaceSha256: "c".repeat(64) }], historicalRuntimeBindings: [{
    surfaceSha256: "c".repeat(64), sourceCommit: capabilityPlan.sourceCommit, configurationRecordSha256: "d".repeat(64),
    databaseRole: { name: "provider_retired", oid: retiredOid }, providerCredentials: [{ runtimeKey: "chitchatsRetiredToken", providerSurfaceSha256: "e".repeat(64) }] }] };
  const privateCapabilities = { chitchatsRetiredToken: "owned-provider-token", historicalRuntimeConfigurations: { ["c".repeat(64)]: {
    sourceCommit: capabilityPlan.sourceCommit, configurationRecordSha256: "d".repeat(64),
    databaseUrl: `postgresql://provider_retired:owned-capability-fixture-password@127.0.0.1:${port}/postgres?sslmode=verify-full`,
    providerCredentials: { chitchatsRetiredToken: "owned-provider-token" } } } };
  const observedCapabilities = await observeHistoricalFrontendCapabilityBindings({ plan: capabilityPlan, databaseClient: client, verifyLockedSession: verify },
    capabilityBindings, privateCapabilities, { createClient: options => new Client({ ...options, ssl: { ...options.ssl, ca: readFileSync(certificate, "utf8") } }) });
  assert.equal(observedCapabilities.bindings[0].samePhysicalDatabaseVerified, true);
  assert.equal(observedCapabilities.rawInvocationCount, null);
  assert.equal(JSON.stringify(observedCapabilities).includes("owned-provider-token"), false);
  assert.equal(JSON.stringify(observedCapabilities).includes("owned-capability-fixture-password"), false);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()")).rows[0].count, 0);
  const mismatch = structuredClone(privateCapabilities); mismatch.historicalRuntimeConfigurations["c".repeat(64)].providerCredentials.chitchatsRetiredToken = "different-token";
  await assert.rejects(observeHistoricalFrontendCapabilityBindings({ plan: capabilityPlan, databaseClient: client, verifyLockedSession: verify }, capabilityBindings, mismatch),
    /FRONTEND_HISTORICAL_CAPABILITY_BINDING_REFUSED/u);
  const absent = await observeFrontendOperationalProviderInventory(client, verify);
  assert.equal(absent.tables.every(table => table.present === false && table.rowCount === null), true);
  const artifact = frontendMigrationArtifact();
  for (const migration of artifact.migrations) {
    await client.query("BEGIN");
    try { for (const statement of migration.sql) await client.query(statement); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO provider_retired");
  const historicalSource = verifiedSourceRequirements(realpathSync(new URL("../..", import.meta.url).pathname), "b99d4f346696f897fa6a6729dfcc52d6503fe8d6");
  const sourceKeys = historicalSource.sqlCredentialRequirements.map(row => row.key);
  const sourceEnvironment = Object.fromEntries(sourceKeys.map(key => [key, privateCapabilities.historicalRuntimeConfigurations["c".repeat(64)].databaseUrl]));
  const sourceCatalog = Object.keys(sourceEnvironment).sort(), sourceSurface = sourceHash("owned-fixed-source-wrapper");
  const sourceProvenance = { surfaceSha256: sourceSurface, sourceCommit: historicalSource.sourceCommit,
    configurationRecordSha256: sourceHash("owned-fixed-original-record"), kind: "deployment", immutableReference: "owned:source-wrapper-original",
    entrypoint: null, keyCatalogSha256: sourceHash(sourceCatalog) };
  const sourceBinding = { surfaceSha256: sourceSurface, sourceCommit: historicalSource.sourceCommit, configurationRecordSha256: sourceProvenance.configurationRecordSha256,
    providerCredentials: [], sourceConfiguration: { ...sourceProvenance, provenanceSha256: sourceHash(sourceProvenance),
      databaseRoles: sourceKeys.map(key => ({ key, name: "provider_retired", oid: retiredOid })) } };
  const sourceBindings = { projectId: "owned-stage", surfaces: [{ surfaceSha256: sourceSurface, kind: "deployment", identity: { projectId: "owned-stage", deploymentId: "dpl_owned" } }], historicalRuntimeBindings: [sourceBinding] };
  const sourcePrivate = { historicalRuntimeConfigurations: { [sourceSurface]: { sourceCommit: historicalSource.sourceCommit,
    configurationRecordSha256: sourceProvenance.configurationRecordSha256, provenance: sourceProvenance, keyCatalog: sourceCatalog, environment: sourceEnvironment } } };
  const sourceContext = { plan: { ...capabilityPlan, providerBindingsSha256: sourceHash("owned-bindings"), historicalLogins: {
    ...capabilityPlan.historicalLogins, retiredLogins: [{ name: "provider_retired", oid: retiredOid }] } },
    databaseClient: client, verifyLockedSession: verify, getProviderContext: async () => {} };
  const sourceResult = await observeFrontendHistoricalSourceContexts(sourceContext, sourceBindings, sourcePrivate,
    { createClient: options => new Client({ ...options, ssl: { ...options.ssl, ca: readFileSync(certificate, "utf8") } }) });
  assert.equal(sourceResult.bindings[0].sqlPhysicalBindings.length, 4);
  assert.ok(sourceResult.bindings[0].sqlPhysicalBindings.every(row => row.sameSelectedPhysicalDatabase === true));
  assert.equal(JSON.stringify(sourceResult).includes("owned-capability-fixture-password"), false);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()")).rows[0].count, 0);
  const safeMaps = Object.fromEntries(["booking", "contact_popup", "course_signup", "general_inquiry", "sanity_backfill", "training_contact"].map(key => [key, []]));
  const scopedReviewed = { resendMarketing: { environment: "staging", sourceCommit: historicalSource.sourceCommit, surfaceSha256: sourceSurface,
    configurationSha256: sourceProvenance.configurationRecordSha256, sourceInventorySha256: historicalSource.sourceInventorySha256,
    requirementsSha256: historicalSource.requirementsSha256, databaseSnapshotSha256: "a".repeat(64), segmentIdsBySource: safeMaps, topicIdsBySource: safeMaps } };
  const actualScope = await observeFrontendScopedProviderDatabase(client, "resend", scopedReviewed, verify);
  assert.equal(Object.keys(actualScope.normalizedSnapshot).length, 6);
  assert.ok(Object.values(actualScope.normalizedSnapshot).every(rows => rows.length === 0));
  await client.query("CREATE DATABASE owned_alternate_metadata");
  const alternatePrivate = structuredClone(sourcePrivate), alternateBinding = structuredClone(sourceBinding);
  const alternateOriginal = alternatePrivate.historicalRuntimeConfigurations[sourceSurface];
  alternateOriginal.environment.TEST_DATABASE_URL = alternateOriginal.environment.TEST_DATABASE_URL.replace("/postgres?", "/owned_alternate_metadata?");
  alternateOriginal.configurationRecordSha256 = sourceHash("owned-alternate-original-record");
  alternateOriginal.provenance.configurationRecordSha256 = alternateOriginal.configurationRecordSha256;
  alternateBinding.configurationRecordSha256 = alternateOriginal.configurationRecordSha256;
  alternateBinding.sourceConfiguration.provenanceSha256 = sourceHash(alternateOriginal.provenance);
  const alternateResult = await observeFrontendHistoricalSourceContexts({ ...sourceContext, getProviderContext: async () => {} },
    { ...sourceBindings, historicalRuntimeBindings: [alternateBinding] }, alternatePrivate,
    { createClient: options => new Client({ ...options, ssl: { ...options.ssl, ca: readFileSync(certificate, "utf8") } }) });
  assert.equal(alternateResult.bindings[0].sqlPhysicalBindings.filter(row => row.sameSelectedPhysicalDatabase === false).length, 1);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='lash-her-original-source-metadata'")).rows[0].count, 0);
  await client.query("CREATE ROLE provider_admission_owner NOLOGIN NOINHERIT");
  await client.query("GRANT CREATE ON DATABASE postgres TO provider_admission_owner");
  await client.query("SET ROLE provider_admission_owner");
  try {
    await client.query(readFileSync(new URL("./frontend-admission.sql", import.meta.url), "utf8"));
    await client.query("INSERT INTO frontend_admission.control(environment,target_sha256) VALUES('staging',$1)", [capabilityPlan.targetSha256]);
  } finally { await client.query("RESET ROLE"); }
  capabilityPlan.owner = { name: "provider_admission_owner", oid: (await client.query("SELECT oid::text FROM pg_roles WHERE rolname='provider_admission_owner'")).rows[0].oid };
  capabilityPlan.historicalLogins.retiredLogins = [{ name: "provider_retired", oid: retiredOid }];
  await client.query("ALTER ROLE provider_retired NOLOGIN");
  const actualDatabaseFence = await observeHistoricalFrontendDatabaseFence({ plan: capabilityPlan, databaseClient: client, verifyLockedSession: verify });
  assert.equal(actualDatabaseFence.retiredLoginsDenied, true);
  assert.equal(actualDatabaseFence.retiredRolesDedicated, true);
  assert.equal(actualDatabaseFence.selectedSessions, 0);
  assert.deepEqual(actualDatabaseFence.admission, { newWork: false, recovery: false, active: 0, uncertain: 0 });
  await client.query("INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role) VALUES($1,$2,$3::oid)",
    ["f".repeat(64), capabilityPlan.sourceCommit, retiredOid]);
  await client.query("INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state) VALUES($1::uuid,$2,$3,$4::oid,1,'recovery','uncertain')",
    [randomUUID(), "f".repeat(64), capabilityPlan.sourceCommit, retiredOid]);
  const uncertainDatabaseFence = await observeHistoricalFrontendDatabaseFence({ plan: capabilityPlan, databaseClient: client, verifyLockedSession: verify });
  assert.equal(uncertainDatabaseFence.admission.uncertain, 1);
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
  const crmReviewed = { environment: "staging", locationId: "owned-location", databaseSnapshotSha256: "a".repeat(64) };
  const crmBefore = await observeFrontendCrmShippingDatabase(client, "highlevel", crmReviewed, verify, false);
  assert.equal(Object.keys(crmBefore).length, 6);
  assert.equal(crmBefore.connections.length, 1);
  assert.equal(crmBefore.connections[0].credentials_revoked, false);
  assert.equal(JSON.stringify(crmBefore).includes("private-encrypted"), false);
  crmReviewed.databaseSnapshotSha256 = frontendCrmShippingSnapshotSha256(crmBefore);
  assert.deepEqual(await observeFrontendCrmShippingDatabase(client, "highlevel", crmReviewed, verify), crmBefore);
  const shippingReviewed = { environment: "staging", databaseSnapshotSha256: frontendCrmShippingSnapshotSha256({ shipments: [], jobs: [] }) };
  assert.deepEqual(await observeFrontendCrmShippingDatabase(client, "chitchats", shippingReviewed, verify), { shipments: [], jobs: [] });
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
    tables: actual.tables.length, originalSourceSqlPeers: 4, alternateMetadataPeers: 1, scopedResendQueries: 6, googleCredentialAndEventQueries: 5, crmShippingQueries: 8, providerTouched: false, liveQualified: false }));
} finally {
  if (client) await client.end().catch(() => {});
  if (running) { try { run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* owned cleanup */ } }
  rmSync(directory, { recursive: true, force: true });
}
