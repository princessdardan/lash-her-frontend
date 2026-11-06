import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  historicalSourceSha256 as hash, verifiedSourceRequirements,
  verifyHistoricalFrontendSourceProfile, prepareHistoricalSourceOriginalConfiguration as prepare,
  historicalSourceOriginalValueKeys,
  historicalSourceSqlCredentialQueryPlan, observeHistoricalSourceSqlCredentials as observe,
  deriveHistoricalSourceCapabilityClosures as derive, historicalSourceAlternateStoreQueryPlan as storePlan, observeHistoricalSourceAlternateStores as stores,
} from "./frontend-historical-source.mjs";

const repository = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const c07 = "b99d4f346696f897fa6a6729dfcc52d6503fe8d6";
const directory = new URL("./profiles/frontend-historical-sources/", import.meta.url);
const requirements = verifiedSourceRequirements(repository, c07);
const profile = () => JSON.parse(readFileSync(new URL(`${c07}.json`, directory), "utf8"));
const rejected = /FRONTEND_HISTORICAL_SOURCE_REFUSED/u;
const keys = ["BACKUP_RESTORE_DATABASE_URL", "DATABASE_URL", "STAGING_DATABASE_URL", "TEST_DATABASE_URL"];
const database = { database: "frontend_historical_owned", major: 16, parentPid: 101, markers: ["1001", "1002", "1003", "1004"] };

function originalFixture(environment = {}, options = {}) {
  const keyCatalog = [...(options.keyCatalog ?? Object.keys(environment))].sort(), sourceCommit = options.sourceCommit ?? c07;
  const provenance = { sourceCommit, surfaceSha256: hash(options.surface ?? "owned-surface"), configurationRecordSha256: hash(options.record ?? "owned-original-record"),
    kind: options.kind ?? "deployment", immutableReference: "owned-fixture/original-record-1", entrypoint: options.entrypoint ?? null, keyCatalogSha256: hash(keyCatalog),
    ...(options.selector ? { nonSecretSelectors: { APP_ENV: options.selector } } : {}) };
  const databaseRoles = keys.filter(key => keyCatalog.includes(key)).map(key => ({ key, name: "owned_reader", oid: "16385" }));
  const original = { sourceCommit, configurationRecordSha256: provenance.configurationRecordSha256, provenance, keyCatalog, environment: {} };
  const binding = { surfaceSha256: provenance.surfaceSha256, sourceCommit, configurationRecordSha256: provenance.configurationRecordSha256,
    providerCredentials: options.providerCredentials ?? [], sourceConfiguration: { ...provenance, provenanceSha256: hash(provenance), databaseRoles } };
  const source = verifiedSourceRequirements(repository, sourceCommit), required = historicalSourceOriginalValueKeys(source, binding, original);
  original.environment = Object.fromEntries(required.filter(key => Object.hasOwn(environment, key)).map(key => [key, environment[key]]));
  return { original, binding, requiredValueKeys: required };
}
function sqlPeer(changes = {}) {
  return { connection: { stream: { encrypted: true, authorized: true } },
    connectionParameters: { host: "127.0.0.1", port: 5432, database: database.database, user: "owned_reader", password: "owned-synthetic-password" },
    async query(query) { return { rows: query.includes("current_user") ? [{ database: database.database, username: "owned_reader", session_username: "owned_reader", role_oid: "16385", major: 16, read_only: "on" }] : [{ count: 4 }] }; }, ...changes };
}
const ownedUrl = "postgresql://owned_reader:owned-synthetic-password@127.0.0.1:5432/frontend_historical_owned";
const collect = (fixture, clientsByKey = new Map(), extra = {}) => observe(requirements, { binding: fixture.binding, originalConfiguration: fixture.original,
  clientsByKey, physicalDatabase: database, verifySession: async () => {}, ...extra });
const closureIds = (source, family) => [...new Set([...source.sqlCredentialRequirements, ...family.configurationConditions, ...family.sqlIntentRequirements, ...family.untrackedPotentialRequests].map(row => row.requirementId))].sort();

test("every checked retained staging/preview profile verifies its actual complete selected Git tree and blobs", () => {
  const files = readdirSync(directory).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 33);
  for (const file of files) {
    const source = verifiedSourceRequirements(repository, file.slice(0, -5));
    assert.equal(source.status, "FRONTEND_HISTORICAL_SOURCE_VERIFIED");
    assert.equal(source.providerFamilies.length, 36);
    assert.ok(source.entrypoints.routes.length >= 40);
    assert.ok(source.entrypoints.routes.every(route => route.methods.length > 0));
    assert.ok(source.entrypoints.manual.length > 0 && source.entrypoints.deferred.length > 0);
    assert.equal(source.sourceAdmission, "not-qualified-by-current-candidate");
    assert.ok(Object.isFrozen(source.providerFamilies[0]));
  }
});

test("the C07 inventory retains real transient/lost-ack sites and independently inventoried entrypoint classes", () => {
  const inventory = profile().inventory;
  for (const [suffix, line] of [["shipping/flat-rate-refresh.ts", 133], ["shipping/operation-worker.ts", 247], ["shipping/operation-worker.ts", 703],
    ["service-card-on-file.ts", 758], ["service-card-on-file.ts", 886], ["square-invoice/handler.ts", 210], ["square-invoice/handler.ts", 226]])
    assert.ok(inventory.providerPaths.some(site => site.file.endsWith(suffix) && site.lineStart === line), `${suffix}:${line}`);
  for (const kind of ["routes", "manual", "schedules", "deferred", "actions", "renders", "sql"]) assert.ok(inventory.entrypoints[kind].length > 0, kind);
  assert.ok(inventory.absentConfigurations.includes("vercel.json"));
  assert.deepEqual(requirements.sqlCredentialRequirements.map(row => row.key), keys);
  assert.ok(requirements.providerFamilies.find(row => row.familyId === "resend.events").untrackedPotentialRequests.length);
  assert.ok(!JSON.stringify(requirements).includes("resend_webhook_receipts"));
  assert.ok(!requirements.providerFamilies.find(row => row.familyId === "square.payments").sqlIntentRequirements[0].tables.includes("training_enrollments"));
  assert.equal(requirements.sdkDependencies.find(row => row.name === "resend").version, "6.12.3");
});

test("unreviewed source, shortened refs and source/profile omissions cannot be self-approved", () => {
  for (const source of [c07.slice(0, 7), "HEAD", "0".repeat(40), null]) assert.throws(() => verifiedSourceRequirements(repository, source), rejected);
  for (const mutate of [p => p.inventory.sourceFiles.pop(), p => p.inventory.entrypoints.routes.pop(), p => p.providerFamilies.pop(),
    p => p.providerFamilies[0].untrackedPotentialRequests.splice(0), p => p.sqlCredentialRequirements.pop(),
    p => p.providerFamilies[0].configurationConditions[0].requiredCredentialPaths.splice(0), p => { p.treeOid = "0".repeat(40); }]) {
    const changed = profile(); mutate(changed);
    changed.sourceInventorySha256 = hash(changed.inventory);
    assert.throws(() => verifyHistoricalFrontendSourceProfile(repository, c07, changed), rejected);
  }
});

test("different preview source receives facts and unresolved capabilities rather than inherited C07 guard assumptions", async () => {
  const preview = readdirSync(directory).map(file => JSON.parse(readFileSync(new URL(file, directory), "utf8")))
    .find(row => row.sourceReviewDisposition.unknownCapabilityProviders.length > 0);
  assert.ok(preview);
  const source = verifiedSourceRequirements(repository, preview.sourceCommit), fixture = originalFixture({}, { sourceCommit: preview.sourceCommit });
  const sql = await observe(source, { binding: fixture.binding, originalConfiguration: fixture.original, clientsByKey: new Map(),
    physicalDatabasesByKey: new Map(), verifySession: async () => {} });
  const result = derive(source, fixture.binding, fixture.original, sql);
  for (const family of source.providerFamilies.filter(row => preview.sourceReviewDisposition.unknownCapabilityProviders.includes(row.provider))) {
    assert.equal(family.sourceDisposition, "reachable");
    if (!preview.sourceReviewDisposition.auditedPrivateSqlPredicateFamilies.includes(family.familyId)) assert.ok(result.unresolvedFrontendSqlFamilyIds.includes(family.familyId));
    assert.ok(family.untrackedPotentialRequests.length > 0);
  }
});

test("pure original-config preflight binds source/surface/provenance/full sorted catalog and exact partial values before any connection", () => {
  const fixture = originalFixture({ DATABASE_URL: ownedUrl });
  assert.deepEqual(prepare(requirements, fixture.binding, fixture.original), { version: 1, sourceCommit: c07, surfaceSha256: fixture.binding.surfaceSha256,
    configurationRecordSha256: fixture.binding.configurationRecordSha256, provenanceSha256: fixture.binding.sourceConfiguration.provenanceSha256,
    configuredSqlKeys: ["DATABASE_URL"], requiredValueKeys: ["DATABASE_URL"], databaseRoles: fixture.binding.sourceConfiguration.databaseRoles });
  for (const mutate of [f => { f.binding.surfaceSha256 = hash("other"); }, f => { f.original.sourceCommit = "0".repeat(40); },
    f => { f.original.environment.EXTRA_KEY = "extra"; }, f => { f.original.keyCatalog.push("MISSING_KEY"); },
    f => { f.binding.sourceConfiguration.databaseRoles = []; }, f => { f.binding.sourceConfiguration.databaseRoles.push({ ...f.binding.sourceConfiguration.databaseRoles[0] }); },
    f => { f.original.provenance.immutableReference = "currentenv"; }, f => { f.binding.sourceConfiguration.entrypoint = "scripts/unreviewed.ts"; }]) {
    const changed = structuredClone(fixture); mutate(changed); assert.throws(() => prepare(requirements, changed.binding, changed.original), rejected);
  }
  assert.throws(() => prepare(structuredClone(requirements), fixture.binding, fixture.original), rejected);
});

test("the 228-name C07 catalog needs only the exact 14 source-selected values", () => {
  const catalogs = JSON.parse(readFileSync(new URL("../../docs/api-integration/baselines/2026-11-06-vercel-deployment-key-catalogs/key-name-sets.json", import.meta.url), "utf8"));
  const keyCatalog = Object.values(catalogs.sets).find(keys => keys.length === 228); assert.ok(keyCatalog);
  const providerCredentials = ["squareRetiredToken", "resendRetiredToken", "chitchatsRetiredToken", "googleIdentityRetiredSecret", "googleCalendarRetiredSecret", "highlevelRetiredToken"]
    .map((runtimeKey, index) => ({ runtimeKey, providerSurfaceSha256: String(index + 1).repeat(64) }));
  const values = { DATABASE_URL: ownedUrl, KV_REST_API_URL: "https://owned-redis.invalid/", KV_REST_API_TOKEN: "owned-redis-token",
    VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", SQUARE_ACCESS_TOKEN: "owned-square-token", SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_LOCATION_ID: "owned-location", SQUARE_APPLICATION_ID: "owned-application", RESEND_API_KEY: "owned-resend-token",
    AUTH_GOOGLE_SECRET: "owned-identity-secret", AUTH_GOOGLE_ID: "owned-identity-client", GOOGLE_CLIENT_SECRET: "owned-calendar-secret",
    GOOGLE_CLIENT_ID: "owned-calendar-client" };
  const fixture = originalFixture(values, { keyCatalog, selector: "staging", providerCredentials });
  assert.equal(fixture.original.keyCatalog.length, 228); assert.deepEqual(fixture.requiredValueKeys, Object.keys(values).sort());
  assert.equal(Object.keys(fixture.original.environment).length, 14);
  assert.deepEqual(prepare(requirements, fixture.binding, fixture.original).requiredValueKeys, Object.keys(values).sort());
  const extra = structuredClone(fixture); extra.original.environment.AUTH_SECRET = "must-not-be-collected";
  assert.throws(() => prepare(requirements, extra.binding, extra.original), rejected);
});

test("catalog-present required values refuse when omitted while presence-only keys remain unresolved without values", async () => {
  for (const fixture of [
    originalFixture({}, { keyCatalog: ["DATABASE_URL"] }),
    originalFixture({}, { keyCatalog: ["KV_REST_API_TOKEN", "KV_REST_API_URL"] }),
    originalFixture({}, { keyCatalog: ["RESEND_API_KEY"], providerCredentials: [{ runtimeKey: "resendRetiredToken", providerSurfaceSha256: "1".repeat(64) }] }),
    originalFixture({ SQUARE_ACCESS_TOKEN: "owned" }, { keyCatalog: ["APP_ENV", "SQUARE_ACCESS_TOKEN", "SQUARE_APPLICATION_ID", "SQUARE_ENVIRONMENT", "SQUARE_LOCATION_ID"], selector: "staging",
      providerCredentials: [{ runtimeKey: "squareRetiredToken", providerSurfaceSha256: "2".repeat(64) }] }),
  ]) assert.throws(() => prepare(requirements, fixture.binding, fixture.original), rejected);
  const presenceOnly = originalFixture({}, { keyCatalog: ["AUTH_SECRET", "SANITY_WEBHOOK_SECRET"] });
  assert.deepEqual(presenceOnly.original.environment, {});
  const sql = await collect(presenceOnly), result = derive(requirements, presenceOnly.binding, presenceOnly.original, sql);
  for (const family of ["google.identity", "google.oauth", "sanity.callbacks"])
    assert.ok(result.unresolvedFrontendSqlFamilyIds.includes(family), family);
  assert.ok(result.unresolvedExternalCapabilityFamilyIds.includes("sanity.editorial"));
  assert.ok(result.unresolvedFamilyIds.includes("sanity.editorial"));
});

test("actual reducer pipeline closes an absent original capability with exact requirement and context bindings", async () => {
  const fixture = originalFixture(); let checkpoints = 0;
  const sql = await collect(fixture, new Map(), { verifySession: async () => { checkpoints++; } });
  assert.equal(checkpoints, 2); assert.equal(sql.facts.length, 4);
  assert.ok(sql.facts.every(row => row.disposition === "absent-from-immutable-original-key-catalog"));
  const result = derive(requirements, fixture.binding, fixture.original, sql);
  assert.equal(result.capabilityClosures.length, 36);
  for (const closure of result.capabilityClosures) {
    assert.deepEqual(closure.requirementIds, closureIds(requirements, requirements.providerFamilies.find(row => row.familyId === closure.familyId)));
    assert.equal(closure.surfaceSha256, fixture.binding.surfaceSha256);
    assert.equal(closure.configurationRecordSha256, fixture.binding.configurationRecordSha256);
    assert.equal(closure.provenanceSha256, fixture.binding.sourceConfiguration.provenanceSha256);
    assert.ok(closure.evidenceIds.every(id => /^[a-f0-9]{64}$/u.test(id)));
  }
  assert.deepEqual(result.unresolvedFrontendSqlFamilyIds, []);
  assert.deepEqual(result.unresolvedExternalCapabilityFamilyIds, ["mux.studio", "sanity.editorial"]);
  assert.deepEqual(result.unresolvedFamilyIds, result.unresolvedExternalCapabilityFamilyIds);
  assert.equal(result.capabilityClosures.find(r => r.familyId === "mux.studio").externalProviderCapability, "not-declared-absent");
});

test("configured SQL key needs the actual TLS credential/role/database/readonly session and four parent-held markers", async () => {
  const fixture = originalFixture({ DATABASE_URL: ownedUrl });
  const result = await collect(fixture, new Map([["DATABASE_URL", sqlPeer()]]));
  assert.equal(result.facts.find(row => row.key === "DATABASE_URL").disposition, "original-credential-bound-to-physical-database");
  for (const mutate of [peer => { peer.connection.stream.encrypted = false; }, peer => { peer.connection.stream.authorized = false; },
    peer => { peer.connectionParameters.password = "other-password"; }, peer => { peer.connectionParameters.host = "other.invalid"; },
    peer => { peer.connectionParameters.port = 5433; },
    peer => { peer.query = async query => ({ rows: query.includes("current_user") ? [{ database: database.database, username: "owned_reader", session_username: "other", role_oid: "16385", major: 16, read_only: "on" }] : [{ count: 4 }] }); },
    peer => { peer.query = async query => ({ rows: query.includes("current_user") ? [{ database: database.database, username: "owned_reader", session_username: "owned_reader", role_oid: "999", major: 16, read_only: "on" }] : [{ count: 4 }] }); },
    peer => { const read = peer.query; peer.query = async query => { const result = await read(query); if (query.includes("current_user")) result.rows[0].read_only = "off"; return result; }; },
    peer => { const read = peer.query; peer.query = async query => query.includes("pg_locks") ? { rows: [{ count: 3 }] } : read(query); }]) {
    const peer = sqlPeer(); mutate(peer); await assert.rejects(collect(fixture, new Map([["DATABASE_URL", peer]])), rejected);
  }
  await assert.rejects(collect(fixture), rejected);
  await assert.rejects(collect(fixture, new Map([["DATABASE_URL", sqlPeer()], ["TEST_DATABASE_URL", sqlPeer()]])), rejected);
  await assert.rejects(collect(originalFixture({ DATABASE_URL: "" }), new Map([["DATABASE_URL", sqlPeer()]])), rejected);
});

test("the fixed query plan cannot be replaced by caller SQL or boolean/serialized evidence", async () => {
  assert.equal(historicalSourceSqlCredentialQueryPlan(requirements).credentials.length, 4);
  const fixture = originalFixture(), sql = await collect(fixture);
  for (const supplied of [{ complete: true }, structuredClone(sql), { ...sql, facts: [] }, null])
    assert.throws(() => derive(requirements, fixture.binding, fixture.original, supplied), rejected);
  assert.throws(() => historicalSourceSqlCredentialQueryPlan(structuredClone(requirements)), rejected);
});

test("same source on a different surface/configuration cannot reuse a previous SQL capability proof", async () => {
  const fixture = originalFixture(), sql = await collect(fixture);
  for (const options of [{ surface: "other" }, { record: "other" }]) {
    const other = originalFixture({}, options);
    assert.throws(() => derive(requirements, other.binding, other.original, sql), rejected);
  }
});

test("post-observation private configuration or role changes invalidate the proof without emitting credential hashes", async () => {
  const fixture = originalFixture({ DATABASE_URL: ownedUrl, SQUARE_ACCESS_TOKEN: "owned-synthetic-token" });
  const sql = await collect(fixture, new Map([["DATABASE_URL", sqlPeer()]]));
  assert.doesNotMatch(JSON.stringify(sql), /owned-synthetic-password|owned-synthetic-token|postgresql:/u);
  fixture.original.environment.DATABASE_URL = "changed";
  assert.throws(() => derive(requirements, fixture.binding, fixture.original, sql), rejected);
  fixture.original.environment.DATABASE_URL = ownedUrl;
  fixture.binding.sourceConfiguration.databaseRoles[0].oid = "12345";
  assert.throws(() => derive(requirements, fixture.binding, fixture.original, sql), rejected);
});

test("present empty/masked credentials remain potential capabilities and different SQL never implies provider absence", async () => {
  for (const token of ["", "[masked]", "owned-synthetic-token"]) {
    const fixture = originalFixture({ DATABASE_URL: ownedUrl, SQUARE_ACCESS_TOKEN: token, CHITCHATS_ACCESS_TOKEN: token,
      RESEND_API_KEY: token, HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY: token, HIGHLEVEL_LOCATION_ID: "owned-location", HIGHLEVEL_CLIENT_ID: "owned-client", HIGHLEVEL_CLIENT_SECRET: token });
    const sql = await collect(fixture, new Map([["DATABASE_URL", sqlPeer()]]));
    const result = derive(requirements, fixture.binding, fixture.original, sql);
    for (const family of ["square.customers", "chitchats.drafts", "resend.events", "highlevel.contacts", "highlevel.webhooks"])
      assert.ok(result.unresolvedFrontendSqlFamilyIds.includes(family), family);
  }
});

test("manual template mutation scope and original staging broadcast guard use checked source and bound original selectors", async () => {
  for (const [options, environment, templatesClosed, broadcastsClosed] of [
    [{}, { RESEND_API_KEY: "owned-synthetic-token", APP_ENV: "staging" }, true, false],
    [{ selector: "staging" }, { RESEND_API_KEY: "owned-synthetic-token", APP_ENV: "staging" }, true, true],
    [{ selector: "production" }, { RESEND_API_KEY: "owned-synthetic-token", APP_ENV: "production" }, true, false],
    [{ kind: "direct-caller", entrypoint: "scripts/seed-resend-templates.ts", selector: "staging" }, { RESEND_API_KEY: "owned-synthetic-token", APP_ENV: "staging" }, false, false],
  ]) {
    const fixture = originalFixture(environment, options), sql = await collect(fixture);
    const result = derive(requirements, fixture.binding, fixture.original, sql), closed = familyId => result.capabilityClosures.some(row => row.familyId === familyId);
    assert.equal(closed("resend.templates"), templatesClosed); assert.equal(closed("resend.broadcasts"), broadcastsClosed);
    assert.equal(closed("resend.events"), false);
  }
  const invalid = originalFixture({ APP_ENV: "production" }, { selector: "staging" });
  invalid.original.provenance.nonSecretSelectors.APP_ENV = "production";
  assert.throws(() => prepare(requirements, invalid.binding, invalid.original), rejected);
  assert.throws(() => originalFixture({}, { kind: "direct-caller", entrypoint: "ops/unknown.mjs" }), rejected);
});


test("all 33 exact reviewed sources carry six bounded private-SQL predicates or actual Mux plugin absence", async () => {
  for (const file of readdirSync(directory)) {
    const source = verifiedSourceRequirements(repository, file.slice(0, -5)), fixture = originalFixture({}, { sourceCommit: source.sourceCommit });
    const sql = await observe(source, { binding: fixture.binding, originalConfiguration: fixture.original, clientsByKey: new Map(), physicalDatabasesByKey: new Map(), verifySession: async () => {} });
    const result = derive(source, fixture.binding, fixture.original, sql);
    for (const familyId of ["google.identity", "google.oauth", "google.calendar", "sanity.editorial", "sanity.callbacks", "mux.studio"])
      assert.ok(result.capabilityClosures.some(r => r.familyId === familyId), `${source.sourceCommit}:${familyId}`);
    assert.deepEqual(source.sqlCredentialRequirements.map(r => r.key), keys);
    assert.ok(source.sdkDependencies.some(r => r.name === "@auth/core" && r.version === "0.41.3"));
  }
});

test("every accepted signing-secret alias blocks Google identity/OAuth absence, including retained or masked values", async () => {
  for (const key of ["AUTH_SECRET", "NEXTAUTH_SECRET", "AUTH_SECRET_1", "AUTH_SECRET_2", "AUTH_SECRET_3"]) for (const value of ["", "[masked]", "owned-signing-fixture"]) {
    const fixture = originalFixture({ [key]: value }), sql = await collect(fixture), result = derive(requirements, fixture.binding, fixture.original, sql);
    for (const family of ["google.identity", "google.oauth"]) assert.ok(result.unresolvedFrontendSqlFamilyIds.includes(family), `${key}:${family}`);
  }
});

test("SQL grants and either original legacy Redis credential independently prevent Calendar/OAuth absence", async () => {
  for (const key of keys) {
    const fixture = originalFixture({ [key]: ownedUrl }), sql = await collect(fixture, new Map([[key, sqlPeer()]]));
    const result = derive(requirements, fixture.binding, fixture.original, sql);
    for (const family of ["google.oauth", "google.calendar"]) assert.ok(result.unresolvedFrontendSqlFamilyIds.includes(family), `${key}:${family}`);
  }
  for (const key of ["KV_REST_API_URL", "KV_REST_API_TOKEN"]) for (const value of ["", "[masked]", "owned-fixture"]) {
    const fixture = originalFixture({ [key]: value }), sql = await collect(fixture), result = derive(requirements, fixture.binding, fixture.original, sql);
    assert.ok(result.unresolvedFrontendSqlFamilyIds.includes("google.oauth")); assert.ok(result.unresolvedFrontendSqlFamilyIds.includes("google.calendar"));
    await assert.rejects(stores(requirements, fixture.binding, fixture.original, sql), rejected);
  }
});

test("signed Sanity ingress stays unresolved for every retained key; Studio/Mux public scope never claims credential retirement", async () => {
  for (const value of ["", "[masked]", "owned-hook-fixture"]) {
    const fixture = originalFixture({ SANITY_WEBHOOK_SECRET: value, DATABASE_URL: ownedUrl }), sql = await collect(fixture, new Map([["DATABASE_URL", sqlPeer()]]));
    const result = derive(requirements, fixture.binding, fixture.original, sql);
    assert.ok(result.unresolvedFrontendSqlFamilyIds.includes("sanity.callbacks")); assert.ok(result.unresolvedFrontendSqlFamilyIds.includes("sanity.editorial"));
    const mux = result.capabilityClosures.find(r => r.familyId === "mux.studio");
    assert.equal(mux.effectScope, "frontend-private-sql-and-protected-continuations"); assert.equal(mux.externalProviderCapability, "not-declared-absent");
  }
});

test("source-owned alternate store observer returns no secret values and cannot accept forged, foreign or serialized facts", async () => {
  const fixture = originalFixture(), sql = await collect(fixture), result = await stores(requirements, fixture.binding, fixture.original, sql);
  assert.equal(result.hasRetainedGoogleState, false); assert.equal(result.redis.disposition, "absent-from-immutable-original-key-catalog");
  assert.equal(derive(requirements, fixture.binding, fixture.original, sql, result).capabilityClosures.length, 36);
  for (const value of [structuredClone(result), { ...result, hasRetainedGoogleState: false }, { complete: true }])
    assert.throws(() => derive(requirements, fixture.binding, fixture.original, sql, value), rejected);
  await assert.rejects(stores(structuredClone(requirements), fixture.binding, fixture.original, sql), rejected);
  const other = originalFixture({}, { surface: "foreign-store" });
  await assert.rejects(stores(requirements, other.binding, other.original, sql), rejected);
  assert.throws(() => storePlan(structuredClone(requirements)), rejected);
  assert.ok(storePlan(requirements).sql.every(r => /^SELECT count\(\*\)/u.test(r.query)));
});

test("retained actual encrypted/secret-ref grant, event and checkout rows cannot be discarded by a source closure", async () => {
  for (const retained of storePlan(requirements).sql) {
    const fixture = originalFixture({ DATABASE_URL: ownedUrl }), peer = sqlPeer(), read = peer.query;
    peer.query = async query => storePlan(requirements).sql.some(r => r.query === query) ? { rows: [{ count: query === retained.query ? 1 : 0 }] } : read(query);
    const sql = await collect(fixture, new Map([["DATABASE_URL", peer]])), observed = await stores(requirements, fixture.binding, fixture.original, sql);
    assert.equal(observed.hasRetainedGoogleState, true);
    const result = derive(requirements, fixture.binding, fixture.original, sql, observed);
    for (const family of ["google.identity", "google.oauth", "google.calendar"]) assert.ok(result.unresolvedFrontendSqlFamilyIds.includes(family));
    assert.equal(observed.configuredStoreEmptyDisposition, "unresolved-historical-accepted-request-completeness");
  }
});

test("empty configured store is observation only and changing SQL/markers/private source state refuses a proof", async () => {
  const fixture = originalFixture({ DATABASE_URL: ownedUrl }), peer = sqlPeer(), read = peer.query;
  peer.query = async query => storePlan(requirements).sql.some(r => r.query === query) ? { rows: [{ count: 0 }] } : read(query);
  const sql = await collect(fixture, new Map([["DATABASE_URL", peer]])), observed = await stores(requirements, fixture.binding, fixture.original, sql);
  assert.equal(observed.hasRetainedGoogleState, false);
  assert.ok(derive(requirements, fixture.binding, fixture.original, sql, observed).unresolvedFrontendSqlFamilyIds.includes("google.calendar"));
  let count = 0; peer.query = async query => storePlan(requirements).sql.some(r => r.query === query) ? { rows: [{ count: ++count }] } : read(query);
  await assert.rejects(stores(requirements, fixture.binding, fixture.original, sql), rejected);
  peer.connection.stream.authorized = false;
  await assert.rejects(stores(requirements, fixture.binding, fixture.original, sql), rejected);
});


test("only the four exact source-reviewed unrelated direct callers can narrow the six deployed families", async () => {
  const environment = { AUTH_SECRET: "owned-existing-jwt-signing", KV_REST_API_URL: "[masked]", KV_REST_API_TOKEN: "[masked]", SANITY_WEBHOOK_SECRET: "owned-existing-hook" };
  for (const entrypoint of requirements.manualCredentialProfiles) {
    const fixture = originalFixture(environment, { kind: "direct-caller", entrypoint });
    const sql = await collect(fixture), result = derive(requirements, fixture.binding, fixture.original, sql);
    for (const familyId of ["google.identity", "google.oauth", "google.calendar", "sanity.editorial", "sanity.callbacks", "mux.studio"])
      assert.ok(result.capabilityClosures.some(row => row.familyId === familyId), entrypoint + ":" + familyId);
  }
  for (const entrypoint of ["scripts/backfill-product-stock.ts", "scripts/migrate-strapi-to-sanity.ts", "src/lib/booking/google-calendar.ts"])
    assert.throws(() => { const f = originalFixture(environment, { kind: "direct-caller", entrypoint }); prepare(requirements, f.binding, f.original); }, rejected);
});


test("private-SQL closures retain required external residuals and cannot qualify global provider retirement", async () => {
  for (const file of readdirSync(directory)) {
    const source = verifiedSourceRequirements(repository, file.slice(0, -5)), fixture = originalFixture({}, { sourceCommit: source.sourceCommit });
    const sql = await observe(source, { binding: fixture.binding, originalConfiguration: fixture.original, clientsByKey: new Map(), physicalDatabasesByKey: new Map(), verifySession: async () => {} });
    const result = derive(source, fixture.binding, fixture.original, sql);
    const external = source.providerFamilies.filter(f => ["sanity.editorial", "mux.studio"].includes(f.familyId) && f.sourceDisposition === "reachable").map(f => f.familyId).sort();
    assert.deepEqual(result.unresolvedExternalCapabilityFamilyIds, external);
    assert.deepEqual(result.unresolvedFamilyIds, [...new Set([...result.unresolvedFrontendSqlFamilyIds, ...external])].sort());
    assert.ok(result.unresolvedFamilyIds.length > 0, "the broad residual channel cannot report complete provider retirement");
    for (const id of external) {
      assert.ok(!result.unresolvedFrontendSqlFamilyIds.includes(id));
      const scoped = result.capabilityClosures.find(row => row.familyId === id);
      assert.equal(scoped.effectScope, "frontend-private-sql-and-protected-continuations");
      assert.equal(scoped.externalProviderCapability, "not-declared-absent");
      assert.ok(result.unresolvedFamilyIds.includes(id), "a scoped closure cannot suppress external uncertainty");
    }
  }
  const fixture = originalFixture({ SANITY_WEBHOOK_SECRET: "owned-retained-secret", DATABASE_URL: ownedUrl });
  const sql = await collect(fixture, new Map([["DATABASE_URL", sqlPeer()]])), result = derive(requirements, fixture.binding, fixture.original, sql);
  assert.ok(result.unresolvedFrontendSqlFamilyIds.includes("sanity.callbacks"), "signed SQL callbacks remain a hard barrier requirement");
  assert.ok(result.unresolvedFrontendSqlFamilyIds.includes("sanity.editorial"));
  assert.deepEqual(result.unresolvedExternalCapabilityFamilyIds, ["mux.studio", "sanity.editorial"]);
});
