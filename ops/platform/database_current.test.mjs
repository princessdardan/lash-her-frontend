import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkCurrentDatabase } from "./host/database_current.mjs";
import * as qualificationProfileModule from "./qualification-target-profile.mjs";

function fixture() {
  const prepared = { manifest: { environment: "staging", runtimeRole: "lash_her_course_staging_runtime", schemaBaselineSha256: "a".repeat(64) },
    target: { environment: "staging", user: "lash_her_course_staging_migration", host: "fixture.test", port: 5432, database: "fixture", serverMajor: 18 },
    artifact: { service: "course-api", artifactSha256: "b".repeat(64) }, baseline: { catalog: { relations: [{ relname: "courses" }] } } };
  const identity = { database: "fixture", role: prepared.target.user, version: "180000", read_only: "on" };
  const roles = [prepared.target.user, prepared.manifest.runtimeRole].map((rolname, index) => ({ rolname, rolsuper: false, rolcreatedb: false,
    rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true, memberships: 0,
    database_connect: true, schema_usage: true, database_create: index === 0, schema_create: index === 0 }));
  const defaults = [{ kind: "r", count: 4 }, { kind: "S", count: 2 }];
  const grants = { runtime_dml: true, journal_isolated: true };
  const queries = [];
  const state = { identity, roles, defaults, grants, pending: [], catalog: structuredClone(prepared.baseline.catalog), failRollback: false, transport: true };
  const client = { async query(sql) {
    queries.push(sql);
    if (sql === "ROLLBACK" && state.failRollback) throw new Error("Rollback failed");
    if (sql.startsWith("SELECT current_database")) return { rows: [state.identity] };
    if (sql.startsWith("SELECT hash")) return { rows: [{ hash: "fixture", created_at: "1" }] };
    if (sql.startsWith("SELECT rolname")) return { rows: state.roles };
    if (sql.startsWith("SELECT d.defaclobjtype")) return { rows: state.defaults };
    if (sql.startsWith("SELECT bool_and")) return { rows: [state.grants] };
    return { rows: [] };
  } };
  return { prepared, client, queries, state,
    hasVerifiedMigrationTransport(actual, host) { assert.equal(actual, client); assert.equal(host, prepared.target.host); return state.transport; },
    async readMigrationCatalog(read) { await read.query("SELECT fixture_catalog"); return state.catalog; },
    assertAppliedLineage() { return state.pending; } };
}

test("current database verification uses one read-only snapshot without migrations or journal writes", async () => {
  const f = fixture();
  const result = await checkCurrentDatabase(f);
  assert.equal(result.status, "CURRENT_API_DATABASE_READ_ONLY_PASS");
  assert.equal(result.appliedCount, 1); assert.deepEqual(result.pendingTags, []);
  assert.equal(result.migrationsExecuted, false);
  assert.deepEqual(f.queries.slice(0, 2), ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", "SET LOCAL statement_timeout = '10s'"]);
  assert.equal(f.queries.at(-1), "ROLLBACK");
  assert.equal(f.queries.filter((q) => q.startsWith("BEGIN")).length, 1);
  assert.ok(f.queries.every((q) => /^(SELECT|BEGIN TRANSACTION|SET LOCAL|ROLLBACK)\b/u.test(q)));
  assert.equal(Object.hasOwn(result, "contractPhase"), false);
  assert.equal(Object.hasOwn(result, "phase2ContractManifestSha256"), false);
});

test("profiled read-only leaf joins explicit source context before TLS/SQL without adopting legacy input", async () => {
  const expected = qualificationProfileModule.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
  const f = fixture(); f.qualificationProfileModule = qualificationProfileModule;
  for (const value of [f.prepared.manifest, f.prepared.target]) Object.assign(value, { schemaVersion: 2, qualificationTargetProfile: expected });
  const result = await checkCurrentDatabase(f, expected);
  assert.equal(result.version, 2); assert.deepEqual(result.qualificationTargetProfile, expected);
  assert.equal(result.migrationsExecuted, false);
  const mutations = [g => { delete g.prepared.target.qualificationTargetProfile; },
    g => { g.prepared.manifest.schemaVersion = 1; }, g => { g.prepared.target.schemaVersion = 1; },
    g => { g.prepared.target.qualificationTargetProfile = { ...expected, sha256: "a".repeat(64) }; }];
  for (const mutate of mutations) {
    const g = fixture(); g.qualificationProfileModule = qualificationProfileModule;
    for (const value of [g.prepared.manifest, g.prepared.target]) Object.assign(value, { schemaVersion: 2, qualificationTargetProfile: expected });
    mutate(g); await assert.rejects(checkCurrentDatabase(g, expected)); assert.deepEqual(g.queries, []);
  }
  const legacy = fixture(); legacy.qualificationProfileModule = qualificationProfileModule;
  await assert.rejects(checkCurrentDatabase(legacy, expected), /REQUIRED/u); assert.deepEqual(legacy.queries, []);
  const profiled = fixture(); profiled.prepared.manifest.qualificationTargetProfile = expected;
  await assert.rejects(checkCurrentDatabase(profiled), /POLICY_REFUSED/u); assert.deepEqual(profiled.queries, []);
});

test("unknown or malformed expected context refuses before any transport callback", async () => {
  for (const expected of [null, { ...qualificationProfileModule.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, id: "p2q-20261106" }]) {
    const f = fixture(); f.qualificationProfileModule = qualificationProfileModule;
    f.hasVerifiedMigrationTransport = () => assert.fail("transport callback invoked");
    await assert.rejects(checkCurrentDatabase(f, expected)); assert.deepEqual(f.queries, []);
  }
});

test("production profiled main has one fixed selected-image module before manifest or private input reads", () => {
  const source = readFileSync(new URL("./host/database_current.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("export async function main"));
  const selectedModule = 'await import("/app/dist-migration/src/db/qualification-target-profile.js")';
  assert.equal(main.split(selectedModule).length, 2);
  assert.ok(main.indexOf(selectedModule) < main.indexOf("const manifestBytes"));
  assert.ok(main.indexOf("resolveQualificationTargetProfile(expected)") < main.indexOf("const manifestBytes"));
  assert.ok(main.includes('prepareOperatorMigration(manifestBytes, baselineBytes, "/app/drizzle", service, expected)'));
  assert.ok(main.includes('decodeQualificationTargetJson(rawCredential, "private-packet")'));
  assert.ok(!main.includes("options.") && !main.includes("process.env.QUALIFICATION_TARGET_PROFILE"));
});

test("current P2 database verification binds both fields and rejects partial or malformed bindings before SQL", async () => {
  const f = fixture(); Object.assign(f.prepared.manifest, { contractPhase: "p2", phase2ContractManifestSha256: `sha256:${"d".repeat(64)}` });
  const result = await checkCurrentDatabase(f);
  assert.equal(result.contractPhase, "p2"); assert.equal(result.phase2ContractManifestSha256, f.prepared.manifest.phase2ContractManifestSha256);
  for (const fields of [{ contractPhase: "p2" }, { phase2ContractManifestSha256: `sha256:${"d".repeat(64)}` },
    { contractPhase: "p1", phase2ContractManifestSha256: `sha256:${"d".repeat(64)}` },
    ...["d".repeat(64), `sha256:${"0".repeat(64)}`, `sha256:${"D".repeat(64)}`].map(phase2ContractManifestSha256 => ({ contractPhase: "p2", phase2ContractManifestSha256 }))]) {
    const invalid = fixture(); Object.assign(invalid.prepared.manifest, fields);
    await assert.rejects(checkCurrentDatabase(invalid), /PHASE2_BINDING_REQUIRED/u); assert.deepEqual(invalid.queries, []);
  }
});

test("production and non-dedicated identities stop before database access", async () => {
  for (const change of [f => { f.prepared.manifest.environment = "production"; }, f => { f.prepared.target.environment = "production"; },
    f => { f.prepared.target.user = "neondb_owner"; }, f => { f.prepared.manifest.runtimeRole = f.prepared.target.user; }]) {
    const f = fixture(); change(f); await assert.rejects(checkCurrentDatabase(f)); assert.deepEqual(f.queries, []);
  }
});

test("unenforced read-only and wrong server/role/database refuse with rollback; TLS must be authenticated first", async () => {
  const transport = fixture(); transport.state.transport = false;
  await assert.rejects(checkCurrentDatabase(transport), /AUTHENTICATED_TLS_CHANNEL/u); assert.deepEqual(transport.queries, []);
  const closing = fixture(); closing.readMigrationCatalog = async (read) => { await read.query("SELECT fixture_catalog"); closing.state.transport = false; return closing.state.catalog; };
  await assert.rejects(checkCurrentDatabase(closing), /AUTHENTICATED_TLS_CHANNEL/u); assert.equal(closing.queries.at(-1), "ROLLBACK");
  for (const change of [i => { i.read_only = "off"; }, i => { i.database = "other"; },
    i => { i.role = "neondb_owner"; }, i => { i.version = "170000"; }, i => { i.version = undefined; }]) {
    const f = fixture(); change(f.state.identity); await assert.rejects(checkCurrentDatabase(f)); assert.equal(f.queries.at(-1), "ROLLBACK");
    assert.ok(!f.queries.some(q => q.startsWith("SELECT hash")));
  }
});

test("missing lineage, pending SQL and exact schema drift cannot qualify a restore", async () => {
  const pending = fixture(); pending.state.pending = [{ tag: "unapplied" }]; await assert.rejects(checkCurrentDatabase(pending), /COMPLETE_LINEAGE/u);
  const edited = fixture(); edited.assertAppliedLineage = () => { throw new Error("Edited journal hash"); };
  await assert.rejects(checkCurrentDatabase(edited)); assert.equal(edited.queries.at(-1), "ROLLBACK");
  const drift = fixture(); drift.state.catalog.relations.push({ relname: "unexpected" }); await assert.rejects(checkCurrentDatabase(drift), /SCHEMA_CATALOG/u);
});

test("role separation, login, default grants and runtime journal boundaries are mandatory", async () => {
  const mutations = [s => { s.roles.pop(); }, s => { s.roles[1].rolname = s.roles[0].rolname; },
    ...["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].map(key => s => { s.roles[1][key] = true; }),
    s => { s.roles[1].rolcanlogin = false; }, s => { s.roles[1].memberships = 1; }, s => { s.roles[1].database_create = true; },
    s => { s.roles[1].schema_create = true; }, s => { s.defaults.pop(); }, s => { s.defaults[0].count = 3; },
    s => { s.grants.runtime_dml = false; }, s => { s.grants.journal_isolated = false; }];
  for (const mutate of mutations) { const f = fixture(); mutate(f.state); await assert.rejects(checkCurrentDatabase(f)); assert.equal(f.queries.at(-1), "ROLLBACK"); }
});

test("catalog reader cannot turn the read adapter into a write path", async () => {
  const f = fixture(); f.readMigrationCatalog = read => read.query("DELETE FROM courses");
  await assert.rejects(checkCurrentDatabase(f), /SELECT_ONLY/u);
  assert.ok(!f.queries.some(q => q.startsWith("DELETE"))); assert.equal(f.queries.at(-1), "ROLLBACK");
});

test("query and rollback errors prevent successful results", async () => {
  const f = fixture(); f.readMigrationCatalog = () => { throw new Error("Database failure"); };
  await assert.rejects(checkCurrentDatabase(f)); assert.equal(f.queries.at(-1), "ROLLBACK");
  const rollback = fixture(); rollback.state.failRollback = true; await assert.rejects(checkCurrentDatabase(rollback));
});
