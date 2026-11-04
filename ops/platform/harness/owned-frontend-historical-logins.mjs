// Owned loopback fixture only; accepts no configured external database URL.
import assert from "node:assert/strict";
import { FRONTEND_MIGRATION_LOCK } from "../frontend-migration.mjs";
import { retireHistoricalFrontendLogins } from "../frontend-historical-logins.mjs";

export async function exerciseHistoricalFrontendLogins(connect, password, major) {
  const database = "frontend_historical_owned", legacyRole = "frontend_historical_staging_legacy";
  const operator = await connect(database), checks = [], records = [];
  await operator.query(`CREATE ROLE ${legacyRole} LOGIN NOINHERIT PASSWORD '${password}'`);
  await operator.query("CREATE TABLE public.owned_historical_work(id int PRIMARY KEY)");
  await operator.query(`GRANT USAGE ON SCHEMA public TO ${legacyRole}`);
  await operator.query(`GRANT SELECT,INSERT ON public.owned_historical_work TO ${legacyRole}`);
  assert.equal((await operator.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [FRONTEND_MIGRATION_LOCK])).rows[0].locked, true);
  const prepare = async (role = legacyRole) => ({ version: 1, environment: "staging", actionId: "owned-historical-retirement", sourceCommit: "a".repeat(40), clusterScopeSha256: "b".repeat(64),
    target: { host: "127.0.0.1", port: operator.connectionParameters.port, database, user: "frontend_test_admin", serverMajor: major,
      currentRuntimeRole: "frontend_admission_protocol", admissionOwnerRole: "frontend_admission_owner" },
    retiredLogins: [{ name: role, oid: (await operator.query("SELECT oid::text FROM pg_roles WHERE rolname=$1", [role])).rows[0].oid }] });
  const dependencies = (input, output = []) => ({ confirmation: `staging/${input.actionId}`, record(name, value) { output.push({ name, value }); } });
  const input = await prepare();
  const crossDatabase = await connect("frontend_apply", legacyRole); crossDatabase.on("error", () => {});
  await assert.rejects(retireHistoricalFrontendLogins(input, operator, dependencies(input)));
  assert.equal((await operator.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [legacyRole])).rows[0].rolcanlogin, true);
  await crossDatabase.end();
  checks.push("cross-database-session-refuses-before-cluster-wide-login-change");
  await operator.query(`GRANT ${legacyRole} TO frontend_runtime`);
  await assert.rejects(retireHistoricalFrontendLogins(input, operator, dependencies(input)));
  await operator.query(`REVOKE ${legacyRole} FROM frontend_runtime`);
  await operator.query(`ALTER TABLE public.owned_historical_work OWNER TO ${legacyRole}`);
  await assert.rejects(retireHistoricalFrontendLogins(input, operator, dependencies(input)));
  await operator.query("ALTER TABLE public.owned_historical_work OWNER TO frontend_test_admin");
  await operator.query(`GRANT SELECT,INSERT ON public.owned_historical_work TO ${legacyRole}`);
  checks.push("actual-membership-and-owned-object-refuse-before-retirement");
  const externalOwner = await connect("frontend_apply");
  await externalOwner.query("CREATE TABLE public.owned_external_legacy(id int)");
  await externalOwner.query(`ALTER TABLE public.owned_external_legacy OWNER TO ${legacyRole}`);
  await assert.rejects(retireHistoricalFrontendLogins(input, operator, dependencies(input)));
  await externalOwner.query("ALTER TABLE public.owned_external_legacy OWNER TO frontend_test_admin");
  await externalOwner.query("DROP TABLE public.owned_external_legacy");
  checks.push("owned-objects-in-another-database-refuse-without-a-legacy-session");
  const wrongOid = structuredClone(input); wrongOid.retiredLogins[0].oid = "1";
  await assert.rejects(retireHistoricalFrontendLogins(wrongOid, operator, dependencies(wrongOid)));
  checks.push("role-name-alone-cannot-substitute-another-oid");
  const idle = await connect(database, legacyRole), writer = await connect(database, legacyRole);
  idle.on("error", () => {}); writer.on("error", () => {});
  await writer.query("BEGIN"); await writer.query("INSERT INTO public.owned_historical_work VALUES(1)");
  const deps = dependencies(input, records), record = deps.record;
  deps.record = async (name, value) => {
    record(name, value);
    if (name === "historical-logins-disabled.json") {
      assert.equal((await idle.query("SELECT 1 AS alive")).rows[0].alive, 1);
      await assert.rejects(connect(database, legacyRole));
      checks.push("committed-nologin-blocks-new-logins-but-existing-session-is-still-alive");
    }
  };
  const result = await retireHistoricalFrontendLogins(input, operator, deps);
  assert.equal(result.status, "SELECTED_HISTORICAL_DATABASE_LOGINS_RETIRED");
  assert.equal(result.sessionsSelectedForTermination, 2); assert.equal(result.remainingSelectedSessions, 0);
  await assert.rejects(idle.query("SELECT 1")); await assert.rejects(writer.query("SELECT 1"));
  assert.equal((await operator.query("SELECT count(*)::int AS count FROM public.owned_historical_work")).rows[0].count, 0);
  checks.push("existing-idle-and-writing-sessions-terminate-and-open-transaction-rolls-back");
  assert.equal(result.historicalWritersFenced, false); assert.equal(result.providerEffectsDrained, false); assert.equal(result.migrationAuthorized, false);
  checks.push("database-retirement-never-claims-provider-drain-or-sql-authority");
  await assert.rejects(retireHistoricalFrontendLogins({ ...input, actionId: "owned-replay-refused" }, operator, dependencies({ ...input, actionId: "owned-replay-refused" })));
  assert.equal((await operator.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [legacyRole])).rows[0].rolcanlogin, false);
  checks.push("disabled-login-replay-refuses-without-automatic-login-restoration");
  for (const failure of ["commit", "termination"]) {
    const role = `frontend_historical_staging_${failure}`;
    await operator.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`);
    let active;
    if (failure === "termination") { active = await connect(database, role); active.on("error", () => {}); }
    const selected = await prepare(role), output = [], query = operator.query.bind(operator); let injected = 0;
    operator.query = async (sql, values) => {
      const answer = await query(sql, values);
      if ((failure === "commit" && sql === "COMMIT") || (failure === "termination" && sql.startsWith("SELECT pg_terminate_backend"))) {
        injected++; throw new Error("owned-private-marker");
      }
      return answer;
    };
    try { await assert.rejects(retireHistoricalFrontendLogins(selected, operator, dependencies(selected, output)), /^Error: FRONTEND_HISTORICAL_LOGINS_FAILED_REVIEW_REQUIRED$/u); }
    finally { operator.query = query; }
    assert.equal(injected, 1);
    assert.equal((await operator.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [role])).rows[0].rolcanlogin, false);
    assert.equal(output.at(-1).value.status, "FAILED_REQUIRES_REVIEW");
    assert.equal(JSON.stringify(output).includes("owned-private-marker"), false);
    if (active) await assert.rejects(active.query("SELECT 1"));
    checks.push(`lost-${failure}-acknowledgement-keeps-login-disabled-and-never-retries`);
  }
  const competing = await connect(database);
  assert.equal((await competing.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [FRONTEND_MIGRATION_LOCK])).rows[0].locked, false);
  await operator.query("SELECT pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
  assert.equal((await competing.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [FRONTEND_MIGRATION_LOCK])).rows[0].locked, true);
  await competing.query("SELECT pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
  checks.push("parent-physical-migration-lock-survives-success-and-failures");
  return checks;
}
