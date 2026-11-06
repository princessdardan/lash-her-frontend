import assert from "node:assert/strict";
import test from "node:test";
import { historicalSourceSha256 as hash } from "./frontend-historical-source.mjs";
import { observeFrontendHistoricalSourceContexts, observeFrontendHistoricalSourceIntentCounts } from "./frontend-historical-source-observer.mjs";
const commit = "b99d4f346696f897fa6a6729dfcc52d6503fe8d6";
function fixture(environment = {}) {
  const surfaceSha256 = hash("owned-original-source-surface"), configurationRecordSha256 = hash("owned-original-source-record");
  const keyCatalog = Object.keys(environment).sort(), provenance = { sourceCommit: commit, surfaceSha256, configurationRecordSha256,
    kind: "deployment", immutableReference: "owned:immutable-source-configuration", entrypoint: null, keyCatalogSha256: hash(keyCatalog) };
  const role = { key: "DATABASE_URL", name: "owned_reader", oid: "123" };
  const binding = { surfaceSha256, sourceCommit: commit, configurationRecordSha256, providerCredentials: [],
    sourceConfiguration: { ...provenance, provenanceSha256: hash(provenance), databaseRoles: keyCatalog.includes("DATABASE_URL") ? [role] : [] } };
  const original = { sourceCommit: commit, configurationRecordSha256, provenance, keyCatalog, environment };
  const calls = [], parent = { async query(sql) { calls.push(sql); return { rows: sql.includes("pg_backend_pid") ? [{ pid: 101 }] : sql.includes("pg_advisory_unlock") ? [{ unlocked: true }] : [{ count: 4 }] }; } };
  const context = { getProviderContext: async () => {}, databaseClient: parent, verifyLockedSession: async () => {},
    plan: { actionId: "owned-source-observer", sourceCommit: "a".repeat(40), targetSha256: hash("owned-target"), providerBindingsSha256: hash("owned-bindings"), historicalLogins: { retiredLogins: [role] } } };
  const bindings = { projectId: "owned-stage", surfaces: [{ surfaceSha256, kind: "deployment", identity: { provider: "vercel", projectId: "owned-stage", deploymentId: "dpl_owned" } }], historicalRuntimeBindings: [binding] };
  return { context, bindings, privateRuntime: { historicalRuntimeConfigurations: { [surfaceSha256]: original } }, original, binding, calls };
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
    const f = fixture({ APP_ENV: business, RESEND_API_KEY: "owned-original-provider-token" });
    f.original.provenance.nonSecretSelectors = { APP_ENV: business };
    f.binding.sourceConfiguration.nonSecretSelectors = { APP_ENV: business };
    f.binding.sourceConfiguration.provenanceSha256 = hash(f.original.provenance);
    f.binding.providerCredentials.push({ runtimeKey: "resendRetiredToken", providerSurfaceSha256: hash("owned-resend") });
    f.bindings.resendRetirement = { domainName: "mail.staging.lashher.com" };
    f.privateRuntime.resendRetiredToken = "owned-original-provider-token";
    const result = await observeFrontendHistoricalSourceContexts(f.context, f.bindings, f.privateRuntime);
    const credential = result.bindings[0].providerCredentialBindings[0];
    assert.equal(credential.originalCredentialEqualityVerified, true);
    assert.equal(credential.originalProviderSelectionVerified, business === "staging");
  }
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
