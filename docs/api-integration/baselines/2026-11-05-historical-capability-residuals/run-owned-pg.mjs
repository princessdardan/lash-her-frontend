// Fixture-only: creates and destroys its own loopback TLS/SCRAM cluster.
// It reads no supplied database URL, original deployment record or provider credential.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { historicalSourceSha256 as hash, verifiedSourceRequirements, prepareHistoricalSourceOriginalConfiguration as prepare,
  observeHistoricalSourceSqlCredentials as observe, deriveHistoricalSourceCapabilityClosures as derive, observeHistoricalSourceAlternateStores as stores } from "../../../../ops/platform/frontend-historical-source.mjs";

const repository = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/u, "");
const execute = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sourceCommit = "b99d4f346696f897fa6a6729dfcc52d6503fe8d6";
let phase = "ownership";
async function main() {
  assert.equal(process.env.FRONTEND_HISTORICAL_SOURCE_OWNED_TEST, "true");
  const binaries = process.env.PG_BIN;
  assert.ok(binaries?.startsWith("/"));
  const major = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16"); assert.ok([16, 18].includes(major));
  assert.match(execute(join(binaries, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const listener = createServer(); await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), "frontend-historical-source-owned-")), data = join(directory, "data"), password = `owned-${randomUUID()}`;
  const clients = [], checks = []; let started = false;
  const check = (name, executeCheck) => { executeCheck(); checks.push(name); };
  try {
    phase = "cluster";
    phase = "cluster-initdb"; execute(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "frontend_test_admin", "-E", "UTF8", "--locale=C"]);
    const certificate = join(directory, "server.crt"), key = join(directory, "server.key");
    phase = "cluster-openssl"; execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]);
    chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all frontend_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    phase = "cluster-start"; execute(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
    const connect = async (database, user = "frontend_test_admin") => {
      const client = new Client({ host: "127.0.0.1", port, database, user, password, ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
      clients.push(client); await client.connect(); return client;
    };
    phase = "cluster-setup-peer"; const setup = await connect("postgres");
    await setup.query(`CREATE ROLE historical_reader LOGIN NOINHERIT PASSWORD '${password}'`);
    await setup.query("ALTER ROLE historical_reader SET default_transaction_read_only=on");
    await setup.query("CREATE DATABASE frontend_historical_owned");
    const parent = await connect("frontend_historical_owned"), parentPid = (await parent.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const markers = Array.from({ length: 4 }, () => (randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn).toString());
    assert.equal(new Set(markers).size, 4);
    for (const marker of markers) await parent.query("SELECT pg_advisory_lock($1::bigint)", [marker]);
    phase = "cluster-migrations"; const journal = JSON.parse(readFileSync(new URL("../../../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const entry of journal.entries) { phase = `owned-migration-${entry.idx}`; for (const statement of readFileSync(new URL(`../../../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await parent.query(statement); }
    await parent.query("GRANT USAGE ON SCHEMA public TO historical_reader");
    await parent.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO historical_reader");
    const role = (await parent.query("SELECT oid::text AS oid FROM pg_roles WHERE rolname='historical_reader'")).rows[0];
    phase = "actual-source-prepare"; const requirements = verifiedSourceRequirements(repository, sourceCommit), keys = requirements.sqlCredentialRequirements.map(row => row.key);
    const url = `postgresql://historical_reader:${password}@127.0.0.1:${port}/frontend_historical_owned?sslmode=verify-full`;
    const environment = Object.fromEntries(keys.map(key => [key, url]));
    const keyCatalog = Object.keys(environment).sort(), surfaceSha256 = hash("owned-fixture-only-surface"), configurationRecordSha256 = hash("owned-fixture-only-original-record");
    const provenance = { surfaceSha256, sourceCommit, configurationRecordSha256, kind: "deployment", immutableReference: "owned-fixture/original-1", entrypoint: null, keyCatalogSha256: hash(keyCatalog) };
    const original = { sourceCommit, configurationRecordSha256, provenance, keyCatalog, environment };
    const binding = { surfaceSha256, sourceCommit, configurationRecordSha256,
      sourceConfiguration: { ...provenance, provenanceSha256: hash(provenance), databaseRoles: keys.map(key => ({ key, name: "historical_reader", oid: role.oid })) } };
    const clientsByKey = new Map(), physicalDatabasesByKey = new Map();
    check("pure-preflight-identifies-all-four-original-sql-keys", () => assert.deepEqual(prepare(requirements, binding, original).configuredSqlKeys, [...keys].sort()));
    for (const key of keys) { clientsByKey.set(key, await connect("frontend_historical_owned", "historical_reader")); physicalDatabasesByKey.set(key, { database: "frontend_historical_owned", major, parentPid, markers }); }
    let parentChecks = 0;
    const verifySession = async () => {
      const row = (await parent.query("SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted) AS locks")).rows[0];
      assert.equal(row.pid, parentPid); assert.equal(row.locks, 4); parentChecks++;
    };
    phase = "actual-sql-observation";
    const input = { binding, originalConfiguration: original, clientsByKey, physicalDatabasesByKey, physicalDatabase: { database: "frontend_historical_owned", major, parentPid, markers }, verifySession };
    const sql = await observe(requirements, input);
    check("all-four-actual-tls-scram-readonly-credentials-observed", () => {
      assert.equal(sql.facts.length, 4); assert.ok(sql.facts.every(row => row.disposition === "original-credential-bound-to-physical-database")); assert.ok(parentChecks >= 10);
    });
    const result = derive(requirements, binding, original, sql);
    check("source-specific-absence-produces-context-bound-closures", () => { assert.equal(result.capabilityClosures.length, 33); assert.ok(result.capabilityClosures.every(row => row.surfaceSha256 === surfaceSha256 && row.configurationRecordSha256 === configurationRecordSha256)); });
    const emptyStores = await stores(requirements, binding, original, sql);
    check("all-four-original-credentials-read-only-source-store-queries", () => { assert.equal(emptyStores.sql.length, keys.length * 5); assert.equal(emptyStores.hasRetainedGoogleState, false); });
    check("empty-configured-sql-does-not-close-historical-google-requests", () => { assert.ok(derive(requirements, binding, original, sql, emptyStores).unresolvedFrontendSqlFamilyIds.includes("google.calendar")); });
    const alternateOnly = await observe(requirements, { ...input, physicalDatabase: undefined });
    await assert.rejects(stores(requirements, binding, original, alternateOnly), /FRONTEND_HISTORICAL_SOURCE_REFUSED/u); checks.push("alternate-only-sql-peers-cannot-be-read-for-application-discovery");
    for (const kind of ["encrypted", "reference"]) {
      await parent.query("INSERT INTO booking_calendar_connections (id, provider, status, credential_ciphertext, credential_secret_ref) VALUES (gen_random_uuid(), 'google', 'revoked', $1, $2)", [kind === "encrypted" ? "owned-encrypted-fixture" : null, kind === "reference" ? "owned-secret-reference" : null]);
      const retained = await stores(requirements, binding, original, sql);
      check(`actual-${kind}-grant-survives-source-predicate`, () => {
        assert.equal(retained.hasRetainedGoogleState, true);
        assert.ok(retained.sql.filter(row => row.requirement === "google.encrypted-or-reference-grants").every(row => row.count > 0));
        assert.ok(derive(requirements, binding, original, sql, retained).unresolvedFrontendSqlFamilyIds.includes("google.oauth"));
      });
      await parent.query("DELETE FROM booking_calendar_connections");
    }
    const wrongMarkers = new Map([...physicalDatabasesByKey].map(([key, value]) => [key, { ...value, markers: ["1", "2", "3", "4"] }]));
    await assert.rejects(observe(requirements, { ...input, physicalDatabasesByKey: wrongMarkers }), /FRONTEND_HISTORICAL_SOURCE_REFUSED/u); checks.push("foreign-parent-markers-rejected");
    const wrongRole = structuredClone(binding); wrongRole.sourceConfiguration.databaseRoles[0].oid = "1";
    await assert.rejects(observe(requirements, { ...input, binding: wrongRole }), /FRONTEND_HISTORICAL_SOURCE_REFUSED/u); checks.push("wrong-actual-role-oid-rejected");
    const peer = clientsByKey.get(keys[0]), savedPassword = peer.connectionParameters.password; peer.connectionParameters.password = "different-owned-password";
    await assert.rejects(observe(requirements, input), /FRONTEND_HISTORICAL_SOURCE_REFUSED/u); peer.connectionParameters.password = savedPassword; checks.push("connected-peer-original-credential-mismatch-rejected");
    for (const client of clientsByKey.values()) await client.query("SET default_transaction_read_only=off");
    await assert.rejects(observe(requirements, input), /FRONTEND_HISTORICAL_SOURCE_REFUSED/u); checks.push("actual-writable-session-rejected");
    for (const client of clientsByKey.values()) await client.query("SET default_transaction_read_only=on");
    check("serialized-evidence-is-not-an-observer-proof", () => assert.throws(() => derive(requirements, binding, original, structuredClone(sql)), /FRONTEND_HISTORICAL_SOURCE_REFUSED/u));
    check("private-password-url-and-tokens-not-present-in-evidence", () => { const serialized = JSON.stringify({ sql, result }); assert.ok(!serialized.includes(password)); assert.ok(!serialized.includes("postgresql:")); });
    phase = "actual-source-inventory";
    const profiles = readdirSync(new URL("../../../../ops/platform/profiles/frontend-historical-sources/", import.meta.url)).map(file => {
      const source = verifiedSourceRequirements(repository, file.slice(0, -5));
      return { sourceCommit: source.sourceCommit, treeOid: source.treeOid, sourceInventorySha256: source.sourceInventorySha256, requirementsSha256: source.requirementsSha256,
        providerFamilies: source.providerFamilies.length, routes: source.entrypoints.routes.length, manual: source.entrypoints.manual.length, deferred: source.entrypoints.deferred.length,
        unknownCapabilityProviders: source.sourceReviewDisposition.unknownCapabilityProviders };
    });
    check("all-thirty-three-real-git-source-profiles-execute-without-skip", () => assert.equal(profiles.length, 33));
    return { status: "FRONTEND_HISTORICAL_SOURCE_OWNED_PASS", fixtureOnly: true, actualOriginalDeploymentConfigurationObserved: false,
      postgresMajor: major, actualTlsScramCredentialPeers: clientsByKey.size, actualParentCheckpoints: parentChecks, checks, executedChecks: checks.length, appliedOwnedMigrations: journal.entries.length, skipped: 0,
      sourceModuleSha256: hash(readFileSync(new URL("../../../../ops/platform/frontend-historical-source.mjs", import.meta.url))),
      profiles, sqlObservation: sql, sourceCapabilityResult: result, providerCalls: 0, migrationAuthorized: false };
  } finally {
    for (const client of clients) { try { await client.end(); } catch { /* Only disposable owned peers. */ } }
    if (started) execute(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
}
main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  process.stderr.write(`${JSON.stringify({ status: "FRONTEND_HISTORICAL_SOURCE_OWNED_FAILED", phase, fixtureOnly: true,
    errorKind: error.name, assertionOperator: error.operator, sqlState: /^[A-Z0-9]{5}$/u.test(error.code ?? "") ? error.code : undefined })}\n`); process.exitCode = 1;
});
