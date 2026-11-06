import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { historicalSourceSha256 as hash, historicalSourceOriginalValueKeys, verifiedSourceRequirements } from "./frontend-historical-source.mjs";
import { observeFrontendHistoricalSourceContexts, observeFrontendHistoricalSourceIntentCounts } from "./frontend-historical-source-observer.mjs";
const commit = "b99d4f346696f897fa6a6729dfcc52d6503fe8d6";
const repository = realpathSync(fileURLToPath(new URL("../..", import.meta.url))), requirements = verifiedSourceRequirements(repository, commit);
function fixture(environment = {}, options = {}) {
  const surfaceSha256 = hash("owned-original-source-surface"), configurationRecordSha256 = hash("owned-original-source-record");
  const keyCatalog = [...(options.keyCatalog ?? Object.keys(environment))].sort(), provenance = { sourceCommit: commit, surfaceSha256, configurationRecordSha256,
    kind: "deployment", immutableReference: "owned:immutable-source-configuration", entrypoint: null, keyCatalogSha256: hash(keyCatalog),
    ...(options.selector ? { nonSecretSelectors: { APP_ENV: options.selector } } : {}) };
  const role = { key: "DATABASE_URL", name: "owned_reader", oid: "123" };
  const binding = { surfaceSha256, sourceCommit: commit, configurationRecordSha256, providerCredentials: options.providerCredentials ?? [],
    sourceConfiguration: { ...provenance, provenanceSha256: hash(provenance), databaseRoles: keyCatalog.includes("DATABASE_URL") ? [role] : [] } };
  const original = { sourceCommit: commit, configurationRecordSha256, provenance, keyCatalog, environment: {} };
  const requiredValueKeys = historicalSourceOriginalValueKeys(requirements, binding, original);
  original.environment = Object.fromEntries(requiredValueKeys.filter(key => Object.hasOwn(environment, key)).map(key => [key, environment[key]]));
  const calls = [], parent = { async query(sql) { calls.push(sql); return { rows: sql.includes("pg_backend_pid") ? [{ pid: 101 }] : sql.includes("pg_advisory_unlock") ? [{ unlocked: true }] : [{ count: 4 }] }; } };
  const context = { getProviderContext: async () => {}, databaseClient: parent, verifyLockedSession: async () => {},
    plan: { actionId: "owned-source-observer", sourceCommit: "a".repeat(40), targetSha256: hash("owned-target"), providerBindingsSha256: hash("owned-bindings"), historicalLogins: { retiredLogins: [role] } } };
  const bindings = { projectId: "owned-stage", surfaces: [{ surfaceSha256, kind: "deployment", identity: { provider: "vercel", projectId: "owned-stage", deploymentId: "dpl_owned" } }], historicalRuntimeBindings: [binding] };
  return { context, bindings, privateRuntime: { historicalRuntimeConfigurations: { [surfaceSha256]: original } }, original, binding, calls, requiredValueKeys };
}

test("actual checked C07 source and immutable empty original catalog produce only source-owned per-surface closures", async () => {
  const f = fixture(); let connections = 0;
  const result = await observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime, { createClient() { connections++; throw Error("unexpected"); } });
  assert.equal(connections, 0); assert.equal(result.bindings.length, 1);
  const row = result.bindings[0];
  assert.equal(row.sqlEvidence.facts.length, 4);
  assert.equal(row.requirements.sourceCommit, commit);
  assert.equal(row.requirements.surfaceSha256, f.binding.surfaceSha256);
  assert.equal(row.requirements.capabilityClosures.every(closure => closure.surfaceSha256 === f.binding.surfaceSha256), true);
  assert.equal(f.calls.filter(sql => sql.includes("pg_advisory_lock(")).length, 4);
  assert.equal(f.calls.filter(sql => sql.includes("pg_advisory_unlock(")).length, 4);
});

test("present empty original SQL key and substituted immutable values refuse before any claimed closure", async () => {
  const f = fixture({ DATABASE_URL: "" }); let connections = 0;
  await assert.rejects(observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime, { createClient() { connections++; } }));
  assert.equal(connections, 0);
  const g = fixture({ APP_ENV: "staging" });
  await observeFrontendHistoricalSourceContexts(g.context, g.bindings, g.privateRuntime);
  g.original.environment.APP_ENV = "production";
  await assert.rejects(observeFrontendHistoricalSourceContexts(g.context, g.bindings, g.privateRuntime));
});

test("foreign-preview capability selection uses reviewed original staging selectors as well as private credential equality", async () => {
  for (const business of ["staging", "production"]) {
    const f = fixture({ RESEND_API_KEY: "owned-original-provider-token" }, { keyCatalog: ["APP_ENV", "RESEND_API_KEY"], selector: business,
      providerCredentials: [{ runtimeKey: "resendRetiredToken", providerSurfaceSha256: hash("owned-resend") }] });
    f.bindings.resendRetirement = { domainName: "mail.staging.lashher.com" };
    f.privateRuntime.resendRetiredToken = "owned-original-provider-token";
    const result = await observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime);
    const credential = result.bindings[0].providerCredentialBindings[0];
    assert.equal(credential.originalCredentialEqualityVerified, true);
    assert.equal(credential.originalProviderSelectionVerified, business === "staging");
  }
});

test("catalog-present missing provider values refuse while catalog absence remains an explicit false binding", async () => {
  const row = { runtimeKey: "resendRetiredToken", providerSurfaceSha256: hash("owned-resend") };
  const missing = fixture({}, { keyCatalog: ["APP_ENV", "RESEND_API_KEY"], selector: "staging", providerCredentials: [row] });
  let connections = 0;
  await assert.rejects(observeFrontendHistoricalSourceContexts(missing.context, missing.bindings, missing.privateRuntime, { createClient() { connections++; } }));
  assert.equal(connections, 0); assert.equal(missing.calls.length, 0);
  const absent = fixture({}, { keyCatalog: ["APP_ENV"], selector: "staging", providerCredentials: [row] });
  absent.bindings.resendRetirement = { domainName: "mail.staging.lashher.com" }; absent.privateRuntime.resendRetiredToken = "owned-current-token";
  const result = await observeFrontendHistoricalSourceContexts(absent.context, absent.bindings, absent.privateRuntime);
  const credential = result.bindings[0].providerCredentialBindings[0];
  assert.equal(credential.originalCredentialEqualityVerified, false); assert.equal(credential.originalProviderSelectionVerified, true);
});

test("only source-selected values are pinned and changing one invalidates a repeated observation", async () => {
  const row = { runtimeKey: "resendRetiredToken", providerSurfaceSha256: hash("owned-resend") };
  const f = fixture({ RESEND_API_KEY: "owned-original-provider-token" }, { keyCatalog: ["APP_ENV", "AUTH_SECRET", "RESEND_API_KEY", "SANITY_WEBHOOK_SECRET"],
    selector: "staging", providerCredentials: [row] });
  f.bindings.resendRetirement = { domainName: "mail.staging.lashher.com" }; f.privateRuntime.resendRetiredToken = "owned-original-provider-token";
  assert.deepEqual(f.requiredValueKeys, ["RESEND_API_KEY"]); await observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime);
  f.original.environment.RESEND_API_KEY = "changed";
  await assert.rejects(observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime));
});

test("fixed source intent tables are read only with bounded counts, and absent tables remain unknown", async () => {
  const queries = [], context = { verifyLockedSession: async () => {}, databaseClient: { async query(sql) {
    queries.push(sql); return { rows: sql.includes("to_regclass") ? [{ present: false }] : [] };
  } } };
  const before = { bindings: [{ requirements: { providerFamilies: [{ sqlIntentRequirements: [{ tables: ["owned_intents"] }] }] } }] };
  assert.deepEqual(await observeFrontendHistoricalSourceIntentCounts(context, before), { owned_intents: null });
  assert.equal(queries[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); assert.equal(queries.at(-1), "ROLLBACK");
  before.bindings[0].requirements.providerFamilies[0].sqlIntentRequirements[0].tables = ["orders;DELETE"];
  await assert.rejects(observeFrontendHistoricalSourceIntentCounts(context, before));
});

test("actual C07 observer cannot give the HighLevel helper zero from outbound-only exclusions", async () => {
  const f = fixture({ DATABASE_URL: "postgresql://owned_reader:owned-password@127.0.0.1:5432/owned_frontend?sslmode=verify-full" },
    { keyCatalog: ["AUTH_SECRET", "DATABASE_URL"] });
  let ended = 0;
  const result = await observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime, { createClient() {
    return { connection: { stream: { encrypted: true, authorized: true } },
      connectionParameters: { host: "127.0.0.1", port: 5432, database: "owned_frontend", user: "owned_reader", password: "owned-password" },
      on() {}, async connect() {}, async end() { ended++; }, async query(sql) {
        return { rows: sql.includes("current_user") ? [{ database: "owned_frontend", username: "owned_reader", session_username: "owned_reader", role_oid: "123", major: 16, read_only: "on" }] :
          [{ count: sql.includes("pg_locks") ? 4 : 0 }] };
      } };
  } });
  assert.equal(ended, 1);
  const row = result.bindings[0];
  assert.deepEqual(f.requiredValueKeys, ["DATABASE_URL"], "signing and HighLevel keys stay names-only");
  assert.equal(row.requirements.unresolvedFrontendSqlFamilyIds.filter(id => id.startsWith("highlevel.")).length, 7);
  assert.deepEqual(row.outboundCredentialExclusions, row.requirements.outboundCredentialExclusions);
  const code = `import sys,json
sys.path.insert(0,sys.argv[1])
import frontend_highlevel_history as h
s=json.load(sys.stdin)
rows={name:([{'contacts':0,'effects':0,'connections':0,'webhooks':0}] if name=='historyGlobalScope' else []) for name in h.COLUMNS}
try:
 result=h.observe_scoped_effects(None,{'environment':'staging','sourceBindingSha256':s['configurationRecordSha256'],'historicalSourceCommit':s['sourceCommit'],'historyDatabaseSnapshotSha256':h.sha256(rows)},rows,s)
 print(json.dumps({'zero':result.get('activeExecutions')==0 and result.get('uncertainEffects')==0}))
except ValueError as error:
 print(json.dumps({'zero':False,'refusal':str(error)}))
`;
  const helper = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("./host/", import.meta.url))],
    { input: JSON.stringify(row.requirements), encoding: "utf8", env: Object.fromEntries(["PATH", "HOME", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  assert.equal(helper.status, 0);
  assert.deepEqual(JSON.parse(helper.stdout), { zero: false, refusal: "HIGHLEVEL_HISTORY_ACTUAL_PRINCIPAL_REQUIRED" });
});
