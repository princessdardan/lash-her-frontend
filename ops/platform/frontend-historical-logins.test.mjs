import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { prepareHistoricalFrontendLogins, retireHistoricalFrontendLogins } from "./frontend-historical-logins.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

const input = () => ({ version: 1, environment: "staging", actionId: "owned-historical-retirement", sourceCommit: "a".repeat(40), clusterScopeSha256: "b".repeat(64),
  target: { host: "owned.invalid", port: 5432, database: "owned", user: "operator", serverMajor: 18, currentRuntimeRole: "current_runtime", admissionOwnerRole: "admission_owner" },
  retiredLogins: [{ name: "old_runtime", oid: "123" }] });
const profiledInput = () => {
  const value = input(); value.version = 2;
  value.qualificationTargetProfile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
  value.target.qualificationTargetProfile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
  return value;
};
function fixture(value = input(), expectedQualificationTargetProfile = undefined) {
  const calls = [], records = [], state = { canLogin: true, held: true, oid: "123", members: false, owns: false, sessions: [{ pid: 42, role_oid: "123", datname: "owned", backend_start: "2026-11-03 00:00:00+00" }] };
  const client = Object.assign(new EventEmitter(), { connection: { stream: { encrypted: true, authorized: true } }, connectionParameters: { host: value.target.host, port: 5432 },
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith("SELECT pg_backend_pid")) return { rows: [{ pid: 7, username: "operator", database: "owned", major: 18, read_only: "off" }] };
      if (sql.includes("FROM pg_locks")) return { rows: [{ held: state.held }] };
      if (sql.startsWith("SELECT oid::text")) return { rows: [{ oid: state.oid, rolname: "old_runtime", rolcanlogin: state.canLogin,
        ...Object.fromEntries(["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].map(key => [key, false])) }] };
      if (sql.includes("FROM pg_auth_members")) return { rows: state.members ? [{}] : [] };
      if (sql.startsWith("SELECT 1 FROM pg_shdepend")) return { rows: state.owns ? [{}] : [] };
      if (sql.startsWith("SELECT pid,usesysid")) return { rows: structuredClone(state.sessions) };
      if (sql.startsWith("ALTER ROLE")) state.canLogin = false;
      if (sql.startsWith("SELECT pg_terminate_backend")) { state.sessions = []; return { rows: [{ terminated: true }] }; }
      return { rows: [] };
    } });
  const deps = { confirmation: `staging/${value.actionId}`, record(name, value) { records.push({ name, value }); } };
  return { value, calls, records, state, client, deps,
    run: () => retireHistoricalFrontendLogins(value, client, deps, expectedQualificationTargetProfile) };
}
const mutations = f => f.calls.filter(call => /^(ALTER ROLE|SELECT pg_terminate_backend)/u.test(call.sql));

test("plan preparation excludes unknown secret fields and refuses protected, duplicate and production scope", () => {
  const value = input(); value.password = "private-marker"; value.target.password = "private-marker";
  assert.equal(JSON.stringify(prepareHistoricalFrontendLogins(value)).includes("private-marker"), false);
  for (const mutate of [v => { v.environment = "production"; }, v => { v.retiredLogins[0].name = "operator"; },
    v => { v.retiredLogins.push(v.retiredLogins[0]); }, v => { v.retiredLogins[0].name = 'bad"role'; }, v => { v.retiredLogins[0].oid = "0"; }]) {
    const copy = input(); mutate(copy); assert.throws(() => prepareHistoricalFrontendLogins(copy));
  }
});

test("profiled plan preserves the exact source-selected profile on the plan and target", () => {
  const prepared = prepareHistoricalFrontendLogins(profiledInput(), STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.equal(prepared.version, 2);
  assert.deepEqual(prepared.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.deepEqual(prepared.target.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  const legacy = prepareHistoricalFrontendLogins(input());
  assert.equal(legacy.version, 1); assert.equal("qualificationTargetProfile" in legacy, false);
  assert.equal("qualificationTargetProfile" in legacy.target, false);
});

test("profile mismatch, downgrade and null context refuse before records, listeners or queries", async () => {
  for (const arrange of [
    value => { value.version = 1; },
    value => { delete value.target.qualificationTargetProfile; },
    value => { delete value.qualificationTargetProfile; },
  ]) {
    const value = profiledInput(); arrange(value);
    const f = fixture(value, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
    await assert.rejects(f.run());
    assert.equal(f.records.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.client.listenerCount("error"), 0);
  }
  const f = fixture(profiledInput(), null);
  await assert.rejects(f.run());
  assert.equal(f.records.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.client.listenerCount("error"), 0);
  const legacyWithProfile = input(); legacyWithProfile.target.qualificationTargetProfile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
  assert.throws(() => prepareHistoricalFrontendLogins(legacyWithProfile));
});

test("profiled retirement retains the exact profile on every durable receipt and result", async () => {
  const f = fixture(profiledInput(), STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  const result = await f.run();
  assert.equal(result.version, 2);
  assert.deepEqual(result.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.deepEqual(result.target.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  assert.equal(f.records.length > 0, true);
  for (const record of f.records) {
    assert.equal(record.value.version, 2);
    assert.deepEqual(record.value.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
    assert.deepEqual(record.value.target.qualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  }
});

test("durable intent and committed NOLOGIN precede guarded session termination without releasing parent locks", async () => {
  const f = fixture(), original = f.deps.record;
  f.deps.record = (name, value) => {
    if (name === "historical-logins-started.json") assert.equal(mutations(f).length, 0);
    if (name === "historical-logins-disabled.json") assert.equal(f.calls.at(-1).sql.startsWith("SELECT oid::text"), true);
    if (name === "historical-session-termination-started.json") assert.equal(f.calls.some(c => c.sql === "COMMIT"), true);
    original(name, value);
  };
  const result = await f.run();
  assert.equal(result.selectedLoginsDisabled, true); assert.equal(result.remainingSelectedSessions, 0);
  assert.equal(result.historicalWritersFenced, false); assert.equal(result.providerEffectsDrained, false); assert.equal(result.migrationAuthorized, false);
  assert.equal(f.calls.some(c => /advisory_unlock|\bLOGIN\b/u.test(c.sql)), false);
  const termination = f.calls.find(c => c.sql.startsWith("SELECT pg_terminate_backend"));
  assert.deepEqual(termination.args, [42, "123", "owned", "2026-11-03 00:00:00+00"]);
});

test("wrong TLS, host, lock, role OID, memberships, ownership or cross-database sessions refuse before mutations", async () => {
  for (const mutate of [f => { f.client.connection.stream.authorized = false; }, f => { f.client.connectionParameters.host = "other.invalid"; },
    f => { f.state.held = false; }, f => { f.state.oid = "999"; }, f => { f.state.members = true; }, f => { f.state.owns = true; },
    f => { f.state.sessions[0].datname = "another_database"; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run()); assert.equal(mutations(f).length, 0);
  }
});

test("missing durable intent or termination intent stops the next mutation", async () => {
  for (const rejected of ["historical-logins-started.json", "historical-session-termination-started.json"]) {
    const f = fixture(); f.deps.record = name => { if (name === rejected) throw new Error("private-marker"); };
    await assert.rejects(f.run(), /^Error: FRONTEND_HISTORICAL_LOGINS_FAILED_REVIEW_REQUIRED$/u);
    assert.equal(f.calls.some(c => c.sql.startsWith("SELECT pg_terminate_backend")), false);
    if (rejected === "historical-logins-started.json") assert.equal(mutations(f).length, 0);
    if (rejected === "historical-logins-started.json") assert.equal(f.calls.length, 0);
  }
});

test("changed role scope at the transaction boundary refuses before ALTER ROLE", async () => {
  for (const key of ["members", "owns"]) {
    const f = fixture(), query = f.client.query;
    f.client.query = async (...args) => { if (args[0] === "BEGIN") f.state[key] = true; return query(...args); };
    await assert.rejects(f.run()); assert.equal(mutations(f).length, 0);
  }
});

test("lost commit acknowledgement never terminates sessions, retries or restores LOGIN", async () => {
  const f = fixture(), query = f.client.query;
  f.client.query = async (...args) => { const result = await query(...args); if (args[0] === "COMMIT") throw new Error("private-marker"); return result; };
  await assert.rejects(f.run(), /^Error: FRONTEND_HISTORICAL_LOGINS_FAILED_REVIEW_REQUIRED$/u);
  assert.equal(f.state.canLogin, false); assert.equal(mutations(f).length, 1);
  assert.equal(f.records.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
  assert.equal(JSON.stringify(f.records).includes("private-marker"), false);
});

test("uncertain or failed termination stops once and retains disabled logins", async () => {
  for (const mode of ["throw", "false", "residual"]) {
    const f = fixture(), query = f.client.query; let signals = 0;
    f.client.query = async (...args) => {
      if (args[0].startsWith("SELECT pg_terminate_backend")) {
        signals++;
        if (mode === "throw") throw new Error("private-marker");
        return { rows: [{ terminated: mode === "residual" }] };
      }
      return query(...args);
    };
    await assert.rejects(f.run()); assert.equal(signals, 1); assert.equal(f.state.canLogin, false);
    assert.equal(f.records.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
  }
});

test("lock loss or idle socket failure after disabling prevents a later signal", async () => {
  for (const mode of ["lock", "socket"]) {
    const f = fixture(), record = f.deps.record;
    f.deps.record = (name, value) => {
      record(name, value);
      if (name === "historical-logins-disabled.json") {
        if (mode === "lock") f.state.held = false;
        else f.client.emit("error", new Error("private-marker"));
      }
    };
    await assert.rejects(f.run()); assert.equal(f.state.canLogin, false);
    assert.equal(f.calls.some(c => c.sql.startsWith("SELECT pg_terminate_backend")), false);
  }
});
