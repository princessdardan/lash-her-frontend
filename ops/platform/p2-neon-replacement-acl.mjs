// One-time, source-pinned managed Neon ACL correction. This component can only
// revoke PUBLIC CONNECT and TEMPORARY on the reviewed empty replacement
// database. It cannot run application SQL, prepare roles or authorize release.
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";
import { frontendReleaseReceiptStore } from "./frontend-release-receipts.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { verifyEmptyFrontendReplacement } from "./frontend-replacement-boundary.mjs";
import { replacementCatalogCount, replacementCatalogCountsSql, selectManagedNeonCatalog,
  verifyManagedNeonCatalog } from "./frontend-managed-neon-catalog.mjs";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_MANAGED_NEON_REPLACEMENT_ACL_REFUSED";
const actionId = "p2-neon-replacement-public-acl-2026-11-09";
const operation = "apply-managed-neon-replacement-public-acl";
const catalog = Object.freeze({ id: "staging-neon-replacement-2026-11-09",
  sha256: "a2215d75c64cce39711c4e616974a6a5f97d6ea273479f1868db4c746269a715" });
const statement = "REVOKE CONNECT, TEMPORARY ON DATABASE neondb FROM PUBLIC";
const inputFields = ["version", "operation", "environment", "actionId", "sourceCommit", "managedCatalog", "provider",
  "target", "predecessorTarget", "databaseOid", "migrationRoleOid", "administrativeLogins"];
const targetFields = ["host", "port", "database", "user", "runtimeRole", "serverMajor"];
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const demand = condition => { if (!condition) throw new Error(refusal); };
const hash = value => createHash("sha256").update(value).digest("hex");
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const role = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const byName = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
const validTarget = value => exact(value, targetFields) && typeof value.host === "string" && value.host.length <= 253 &&
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u.test(value.host) && !/pooler|pgbouncer/u.test(value.host) &&
  Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 &&
  [value.database, value.user, value.runtimeRole].every(role) && value.user !== value.runtimeRole &&
  [16, 18].includes(value.serverMajor);

export const P2_MANAGED_NEON_REPLACEMENT_ACL_ACTION = actionId;
export const P2_MANAGED_NEON_REPLACEMENT_ACL_CATALOG = catalog;
export const P2_MANAGED_NEON_REPLACEMENT_ACL_SQL = statement;

function selectInput(input) {
  demand(exact(input, inputFields) && input.version === 1 && input.operation === operation && input.environment === "staging" &&
    input.actionId === actionId && typeof input.sourceCommit === "string" && /^(?!0+$)[a-f0-9]{40}$/u.test(input.sourceCommit) &&
    exact(input.managedCatalog, ["id", "sha256"]) && isDeepStrictEqual(input.managedCatalog, catalog) &&
    validTarget(input.target) && validTarget(input.predecessorTarget) &&
    input.target.database === "neondb" && input.target.user === "neondb_owner" && input.target.serverMajor === 18 &&
    ["host", "port", "database"].some(key => input.target[key] !== input.predecessorTarget[key]) &&
    input.target.user !== input.predecessorTarget.runtimeRole && oid(input.databaseOid) && oid(input.migrationRoleOid) &&
    Array.isArray(input.administrativeLogins) && input.administrativeLogins.every(login =>
      exact(login, ["name", "oid"]) && role(login.name) && oid(login.oid) &&
      login.name !== input.target.user && login.name !== input.predecessorTarget.runtimeRole &&
      !Object.values(FRONTEND_PREPARATION_ROLES).includes(login.name)));
  const selected = selectManagedNeonCatalog(input.managedCatalog, { provider: input.provider, target: input.target,
    databaseOid: input.databaseOid, migrationRoleOid: input.migrationRoleOid,
    administrativeLogins: input.administrativeLogins });
  return { input: structuredClone(input), selected };
}

export function prepareP2ManagedNeonReplacementAcl(input) {
  try {
    const { input: reviewed } = selectInput(input);
    const confirmation = `staging/${actionId}/${reviewed.sourceCommit}/${catalog.sha256}`;
    return Object.freeze({ version: 1, status: "P2_MANAGED_NEON_REPLACEMENT_ACL_PREPARED", environment: "staging",
      actionId, sourceCommit: reviewed.sourceCommit, managedCatalog: catalog, provider: Object.freeze({ ...reviewed.provider }),
      target: Object.freeze({ ...reviewed.target }), predecessorTarget: Object.freeze({ ...reviewed.predecessorTarget }),
      databaseOid: reviewed.databaseOid, migrationRoleOid: reviewed.migrationRoleOid,
      administrativeLogins: Object.freeze(reviewed.administrativeLogins.map(value => Object.freeze({ ...value })).sort(byName)),
      statement, statementSha256: hash(statement), ownerConfirmation: confirmation,
      mutationScope: "revoke-public-connect-and-temporary-only", applicationSqlAuthorized: false,
      rolePreparationAuthorized: false, releaseAuthorized: false, automaticRetryAllowed: false });
  } catch {
    throw new Error(refusal);
  }
}

async function readPhysicalSession(client, input) {
  const parameters = client.connectionParameters, stream = client.connection?.stream;
  demand(stream?.encrypted === true && stream.authorized === true && parameters?.ssl?.rejectUnauthorized === true &&
    parameters.ssl.checkServerIdentity === undefined && parameters.host === input.target.host &&
    parameters.port === input.target.port && parameters.database === input.target.database && parameters.user === input.target.user);
  const { rows } = await client.query(`SELECT pg_catalog.pg_backend_pid() AS pid,
    pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
    current_user AS username,session_user AS session_username,
    pg_catalog.current_database() AS database,d.oid::text AS database_oid,r.oid::text AS role_oid,
    d.datdba=r.oid AS owns_database,pg_catalog.current_setting('server_version_num')::int/10000 AS major,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
      AND database=d.oid AND classid=((pg_catalog.hashtext($1)::bigint>>32)&4294967295)::oid
      AND objid=(pg_catalog.hashtext($1)::bigint&4294967295)::oid AND objsubid=1
      AND mode='ExclusiveLock' AND granted) AS migration_lock
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=session_user
    JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_catalog.pg_backend_pid()
    WHERE d.datname=pg_catalog.current_database()`, [FRONTEND_MIGRATION_LOCK]);
  const row = rows[0];
  demand(rows.length === 1 && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.backend_start === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.backend_start) &&
    row.username === input.target.user && row.session_username === input.target.user &&
    row.database === input.target.database && row.database_oid === input.databaseOid && row.role_oid === input.migrationRoleOid &&
    row.owns_database === true && row.major === input.target.serverMajor && row.read_only === "off" && row.migration_lock === true);
  return Object.freeze({ pid: row.pid, backendStart: row.backend_start, databaseOid: row.database_oid, roleOid: row.role_oid });
}

async function verifyPreAcl(client, input, selection, verifyEnvironment, verifySession, verifyCatalog, inWriteTransaction = false) {
  await verifyEnvironment();
  await verifySession();
  if (!inWriteTransaction) await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const forbidden = [...new Set([input.predecessorTarget.runtimeRole, input.target.runtimeRole,
      ...Object.values(FRONTEND_PREPARATION_ROLES)])];
    const access = (await client.query(`SELECT
      pg_catalog.has_database_privilege('public',$1::oid,'CONNECT') AS public_connect,
      pg_catalog.has_database_privilege('public',$1::oid,'TEMP') AS public_temp,
      pg_catalog.has_database_privilege('public',$1::oid,'CREATE') AS public_create,
      pg_catalog.has_schema_privilege('public','public','CREATE') AS public_schema_create,
      EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=ANY($2::text[])) AS previous_or_fixed_role,
      EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid AND backend_type='client backend'
        AND pid<>pg_catalog.pg_backend_pid()) AS other_client`, [input.databaseOid, forbidden])).rows[0];
    demand(access?.public_connect === true && access.public_temp === true && access.public_create === false &&
      access.public_schema_create === false && access.previous_or_fixed_role === false && access.other_client === false);
    const logins = (await client.query(`SELECT rolname AS name,oid::text AS oid FROM pg_catalog.pg_roles
      WHERE rolcanlogin AND pg_catalog.has_database_privilege(oid,$1::oid,'CONNECT') LIMIT 34`,
    [input.databaseOid])).rows.sort(byName);
    const expectedLogins = [...input.administrativeLogins, { name: input.target.user, oid: input.migrationRoleOid }].sort(byName);
    demand(isDeepStrictEqual(logins, expectedLogins));
    const { rows } = await client.query(replacementCatalogCountsSql,
      [input.databaseOid, expectedLogins.map(login => login.oid)]);
    demand(rows.length === 1 && Object.keys(rows[0]).length === replacementCatalogCount &&
      isDeepStrictEqual(rows[0], selection.expectedCatalogCounts));
    await verifyCatalog(client, selection, { databaseAcl: "before" });
  } finally {
    if (!inWriteTransaction) {
      const rollback = await client.query("ROLLBACK");
      demand(rollback.command === "ROLLBACK");
    }
  }
  await verifySession();
  await verifyEnvironment();
}

async function verifyPostAclInTransaction(client, input, selection, verifySession, verifyCatalog) {
  await verifySession();
  const access = (await client.query(`SELECT
    pg_catalog.has_database_privilege('public',$1::oid,'CONNECT') AS public_connect,
    pg_catalog.has_database_privilege('public',$1::oid,'TEMP') AS public_temp,
    pg_catalog.has_database_privilege('public',$1::oid,'CREATE') AS public_create,
    pg_catalog.has_schema_privilege('public','public','CREATE') AS public_schema_create`, [input.databaseOid])).rows[0];
  demand(access?.public_connect === false && access.public_temp === false && access.public_create === false &&
    access.public_schema_create === false);
  await verifyCatalog(client, selection, { databaseAcl: "after" });
  await verifySession();
}

export async function applyP2ManagedNeonReplacementAcl(input, confirmation, dependencies = {}) {
  let store, intent;
  try {
    const plan = prepareP2ManagedNeonReplacementAcl(input);
    demand(confirmation === plan.ownerConfirmation && typeof dependencies.getUrl === "function");
    const checkSource = dependencies.assertSource ?? (commit => assertSourceCheckout(root, commit));
    const withLock = dependencies.withEnvironmentLock ?? withFrontendEnvironmentLock;
    const createClient = dependencies.createClient ?? (options => new Client(options));
    const verifyBoundary = dependencies.verifyBoundary ?? verifyEmptyFrontendReplacement;
    const verifyCatalog = dependencies.verifyCatalog ?? verifyManagedNeonCatalog;
    demand(typeof checkSource === "function" && typeof withLock === "function" && typeof createClient === "function" &&
      typeof verifyBoundary === "function" && typeof verifyCatalog === "function");
    checkSource(plan.sourceCommit);
    store = frontendReleaseReceiptStore(dependencies.results);
    const result = await withLock(async (verifyEnvironment, signal) => {
      demand(typeof verifyEnvironment === "function" && signal instanceof AbortSignal && !signal.aborted);
      const connection = frontendConnectionOptions(await dependencies.getUrl(), plan.target);
      const client = createClient({ ...connection, application_name: "lash-her-p2-managed-neon-replacement-acl",
        query_timeout: 15_000, statement_timeout: 15_000, lock_timeout: 5_000 });
      demand(client instanceof Client);
      let locked = false, lost = false, outcome, failed = false;
      client.on("error", () => { lost = true; });
      const stop = () => { lost = true; client.connection?.stream?.destroy(); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        await client.connect();
        await verifyEnvironment();
        const { rows: [lock] } = await client.query("SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held",
          [FRONTEND_MIGRATION_LOCK]);
        locked = lock?.held === true;
        demand(locked && !lost && !signal.aborted);
        const connectionStream = client.connection?.stream;
        demand(connectionStream);
        const originalIdentity = await readPhysicalSession(client, plan);
        const verifySession = async () => {
          const current = await readPhysicalSession(client, plan);
          demand(isDeepStrictEqual(current, originalIdentity) && client.connection?.stream === connectionStream);
        };
        const selection = selectManagedNeonCatalog(plan.managedCatalog, { provider: plan.provider, target: plan.target,
          databaseOid: plan.databaseOid, migrationRoleOid: plan.migrationRoleOid,
          administrativeLogins: plan.administrativeLogins });
        await verifyPreAcl(client, plan, selection, verifyEnvironment, verifySession, verifyCatalog);
        const binding = { version: 1, environment: "staging", actionId, sourceCommit: plan.sourceCommit,
          managedCatalog: plan.managedCatalog, target: plan.target, databaseOid: plan.databaseOid,
          migrationRoleOid: plan.migrationRoleOid, statementSha256: plan.statementSha256,
          backendPid: originalIdentity.pid, backendStart: originalIdentity.backendStart,
          releaseAuthorized: false, automaticRetryAllowed: false };
        store.record("acl-intent.json", { ...binding, status: "P2_MANAGED_NEON_REPLACEMENT_ACL_INTENT",
          observedAt: new Date().toISOString() });
        intent = binding;
        let transactionOpen = false;
        try {
          const begin = await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
          transactionOpen = begin.command === "BEGIN";
          demand(transactionOpen && !lost && !signal.aborted);
          await verifyPreAcl(client, plan, selection, verifyEnvironment, verifySession, verifyCatalog, true);
          const mutation = await client.query(statement);
          demand(mutation.command === "REVOKE" && !lost && !signal.aborted);
          await verifyPostAclInTransaction(client, plan, selection, verifySession, verifyCatalog);
          await verifyEnvironment();
          const commit = await client.query("COMMIT");
          transactionOpen = false;
          demand(commit.command === "COMMIT" && !lost && !signal.aborted);
        } catch {
          if (transactionOpen && !lost) {
            try {
              const rollback = await client.query("ROLLBACK");
              demand(rollback.command === "ROLLBACK");
              transactionOpen = false;
            } catch { lost = true; }
          }
          throw new Error(refusal);
        }
        await verifySession();
        const boundary = await verifyBoundary(client, { target: plan.target, predecessorTarget: plan.predecessorTarget,
          administrativeLogins: plan.administrativeLogins, verifyEnvironment, verifySession,
          managedCatalog: plan.managedCatalog, provider: plan.provider });
        demand(boundary?.catalogScope === "postgresql-18-managed-neon-replacement-v1" &&
          boundary.databaseOid === plan.databaseOid && boundary.migrationRoleOid === plan.migrationRoleOid &&
          isDeepStrictEqual(boundary.managedCatalog, plan.managedCatalog) && boundary.authorityIssued === false);
        outcome = { ...binding, status: "P2_MANAGED_NEON_REPLACEMENT_ACL_APPLIED",
          beforeAclSha256: hash(JSON.stringify(selection.databaseAclBefore)),
          afterAclSha256: hash(JSON.stringify(selection.databaseAclAfter)), boundarySha256: hash(JSON.stringify(boundary)),
          publicConnectRevoked: true, publicTemporaryRevoked: true, rolesAndGrantsUnchanged: true,
          migrationLockHeldThroughout: true, applicationSqlExecuted: false, rolesPrepared: false,
          observedAt: new Date().toISOString() };
      } catch { failed = true; }
      finally {
        try {
          if (locked && !lost) {
            const { rows: [release] } = await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS released",
              [FRONTEND_MIGRATION_LOCK]);
            demand(release?.released === true);
          }
        } catch { failed = true; }
        try { await client.end(); } catch { failed = true; }
        signal.removeEventListener("abort", stop);
      }
      demand(!failed && !lost && outcome);
      await verifyEnvironment();
      return outcome;
    });
    store.record("acl-outcome.json", result);
    return result;
  } catch {
    if (intent) {
      try {
        store.record("acl-outcome.json", { ...intent, status: "P2_MANAGED_NEON_REPLACEMENT_ACL_FAILED_REVIEW_REQUIRED",
          observedAt: new Date().toISOString() });
      } catch { /* The exclusive intent remains evidence when the terminal write fails. */ }
    }
    throw new Error(refusal);
  }
}

async function readPacket() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    demand(length <= 32_768);
    chunks.push(chunk);
  }
  demand(length > 0);
  return decodeQualificationTargetJson(Buffer.concat(chunks), "carrier");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    demand(process.versions.node.split(".")[0] === "24");
    const packet = await readPacket();
    if (process.argv.length === 3 && process.argv[2] === "--plan") {
      console.log(JSON.stringify(prepareP2ManagedNeonReplacementAcl(packet)));
    } else {
      const [mode, flag, confirmation, resultsFlag, results] = process.argv.slice(2);
      demand(process.argv.length === 7 && mode === "--apply" && flag === "--confirm" && resultsFlag === "--results");
      console.log(JSON.stringify(await applyP2ManagedNeonReplacementAcl(packet, confirmation,
        { results, getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL })));
    }
  } catch {
    console.error(JSON.stringify({ status: "P2_MANAGED_NEON_REPLACEMENT_ACL_FAILED_REVIEW_REQUIRED",
      automaticRetryAllowed: false }));
    process.exitCode = 1;
  }
}
