// Database-side component only. No credential acquisition, live CLI, provider
// fence, operation-drain assertion, migration authorization or automatic LOGIN.
import { FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";

const demand = (ok) => { if (!ok) throw new Error("FRONTEND_HISTORICAL_LOGIN_FENCE_REFUSED"); };
const name = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const sha = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const heldLock = `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
  AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
  AND objid=(hashtext($1)::bigint & 4294967295)::oid AND objsubid=1
  AND mode='ExclusiveLock' AND granted) AS held`;
const rolesSql = `SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
  FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`;
const sessionsSql = `SELECT pid,usesysid::text AS role_oid,datname,backend_start::text AS backend_start
  FROM pg_stat_activity WHERE usesysid=ANY($1::oid[]) ORDER BY pid`;

export function prepareHistoricalFrontendLogins(input) {
  demand(input?.version === 1 && input.environment === "staging" &&
    typeof input.actionId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) &&
    sha(input.sourceCommit, 40) && sha(input.clusterScopeSha256, 64));
  const target = input.target;
  demand(typeof target?.host === "string" && /^[a-z0-9.-]+$/u.test(target.host) && !/pooler|pgbouncer/u.test(target.host) &&
    name(target.database) && name(target.user) && name(target.currentRuntimeRole) && name(target.admissionOwnerRole) &&
    new Set([target.user, target.currentRuntimeRole, target.admissionOwnerRole]).size === 3 &&
    Number.isInteger(target.port) && target.port > 0 && target.port < 65536 && [16, 18].includes(target.serverMajor));
  demand(Array.isArray(input.retiredLogins) && input.retiredLogins.length > 0 && input.retiredLogins.length <= 32 &&
    input.retiredLogins.every(role => name(role?.name) && typeof role.oid === "string" && /^[1-9][0-9]{0,9}$/u.test(role.oid) && Number(role.oid) <= 4294967295 &&
      ![target.user, target.currentRuntimeRole, target.admissionOwnerRole].includes(role.name)) &&
    new Set(input.retiredLogins.map(role => role.name)).size === input.retiredLogins.length &&
    new Set(input.retiredLogins.map(role => role.oid)).size === input.retiredLogins.length);
  // Pick known fields only: receipt data must never copy arbitrary input secrets.
  return { version: 1, environment: input.environment, actionId: input.actionId, sourceCommit: input.sourceCommit,
    clusterScopeSha256: input.clusterScopeSha256,
    target: Object.fromEntries(["host", "port", "database", "user", "serverMajor", "currentRuntimeRole", "admissionOwnerRole"].map(key => [key, target[key]])),
    retiredLogins: input.retiredLogins.map(({ name, oid }) => ({ name, oid })).sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function retireHistoricalFrontendLogins(input, client, dependencies) {
  const plan = prepareHistoricalFrontendLogins(input), target = plan.target;
  demand(dependencies?.confirmation === `staging/${plan.actionId}` && typeof dependencies.record === "function");
  const base = { ...plan, historicalWritersFenced: false, providerEffectsDrained: false, migrationAuthorized: false };
  const names = plan.retiredLogins.map(role => role.name), oids = plan.retiredLogins.map(role => role.oid);
  let phase = "durable-intent", identityPid, connectionLost = false, intentRecorded = false;
  const onError = () => { connectionLost = true; };
  client.on("error", onError);
  const verifySession = async () => {
    demand(!connectionLost && client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true &&
      client.connectionParameters?.host === target.host && Number(client.connectionParameters.port) === target.port);
    const row = (await client.query(`SELECT pg_backend_pid() AS pid,current_user AS username,current_database() AS database,
      current_setting('server_version_num')::int/10000 AS major,current_setting('transaction_read_only') AS read_only`)).rows[0];
    demand(row?.username === target.user && row.database === target.database && row.major === target.serverMajor && row.read_only === "off" &&
      (identityPid === undefined || row.pid === identityPid));
    identityPid = row.pid;
    demand((await client.query(heldLock, [FRONTEND_MIGRATION_LOCK])).rows[0]?.held === true && !connectionLost);
  };
  const readRoles = async (canLogin) => {
    const rows = (await client.query(rolesSql, [names])).rows;
    demand(rows.length === plan.retiredLogins.length && rows.every(role => plan.retiredLogins.some(expected =>
      role.rolname === expected.name && role.oid === expected.oid) && role.rolcanlogin === canLogin &&
      ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].every(key => role[key] === false)));
  };
  const readDedicatedRoles = async () => {
    await readRoles(true);
    demand((await client.query(`SELECT 1 FROM pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[]) LIMIT 1`, [oids])).rows.length === 0);
    demand((await client.query(`SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
      AND refobjid=ANY($1::oid[]) AND deptype='o' LIMIT 1`, [oids])).rows.length === 0);
  };
  const sessions = async () => {
    // Clear PostgreSQL's transaction-local statistics snapshot before each read.
    await client.query("SELECT pg_stat_clear_snapshot()");
    const rows = (await client.query(sessionsSql, [oids])).rows;
    demand(rows.length <= 256 && rows.every(row => row.datname === target.database && row.pid !== identityPid &&
      oids.includes(row.role_oid) && Number.isInteger(row.pid) && typeof row.backend_start === "string"));
    return rows;
  };
  try {
    await dependencies.record("historical-logins-started.json", { ...base, status: "HISTORICAL_DATABASE_LOGIN_RETIREMENT_STARTED" });
    intentRecorded = true;
    phase = "session-preflight";
    await verifySession();
    await readDedicatedRoles();
    await sessions(); // A selected role active in another database refuses before mutation.
    await verifySession();
    phase = "disable-logins";
    await client.query("BEGIN");
    try {
      // Recheck OIDs/privileges immediately before changing the reviewed names.
      await readDedicatedRoles();
      for (const role of plan.retiredLogins) {
        await verifySession();
        await client.query(`ALTER ROLE "${role.name}" NOLOGIN`);
      }
      await client.query("COMMIT");
    } catch { try { await client.query("ROLLBACK"); } catch { /* outcome remains uncertain */ } throw new Error("LOGIN_CHANGE_UNVERIFIED"); }
    await verifySession();
    await readRoles(false);
    await dependencies.record("historical-logins-disabled.json", { ...base, status: "SELECTED_HISTORICAL_LOGINS_DISABLED" });
    phase = "terminate-sessions";
    const observed = await sessions();
    // Bound work and record every selected PID before any signal. backend_start
    // plus role OID/database guard against terminating a recycled PID.
    demand(observed.length <= 256);
    await dependencies.record("historical-session-termination-started.json", { ...base, status: "HISTORICAL_SESSION_TERMINATION_STARTED", sessions: observed });
    for (const row of observed) {
      await verifySession();
      const result = await client.query(`SELECT pg_terminate_backend(pid,1000) AS terminated FROM pg_stat_activity
        WHERE pid=$1 AND usesysid=$2::oid AND datname=$3 AND backend_start=$4::timestamptz`,
      [row.pid, row.role_oid, target.database, row.backend_start]);
      demand(result.rows.length === 0 || result.rows.length === 1 && result.rows[0].terminated === true);
    }
    phase = "postflight";
    await verifySession(); await readRoles(false);
    demand((await sessions()).length === 0);
    const result = { ...base, status: "SELECTED_HISTORICAL_DATABASE_LOGINS_RETIRED", selectedLoginsDisabled: true,
      remainingSelectedSessions: 0, sessionsSelectedForTermination: observed.length };
    await dependencies.record("historical-logins-outcome.json", result);
    return result;
  } catch {
    try { if (intentRecorded) await dependencies.record("historical-logins-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase }); }
    catch { /* unavailable/existing receipts never authorize retry or overwrite */ }
    throw new Error("FRONTEND_HISTORICAL_LOGINS_FAILED_REVIEW_REQUIRED");
  } finally {
    // The parent owns the connection, locks and subsequent error handling.
    // A failed socket may emit again before the parent closes it.
    if (!connectionLost) client.removeListener("error", onError);
  }
}
