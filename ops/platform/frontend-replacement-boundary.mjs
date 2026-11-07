import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";

const targetFields = ["host", "port", "database", "user", "runtimeRole", "serverMajor"];
const roleName = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
class BoundaryRefusal extends Error {
  constructor(checkpoint) {
    super("FRONTEND_REPLACEMENT_BOUNDARY_REFUSED");
    this.checkpoint = checkpoint;
  }
}
const refuse = checkpoint => new BoundaryRefusal(checkpoint);
const demand = (condition, checkpoint) => { if (!condition) throw refuse(checkpoint); };

function validateTarget(value) {
  return exact(value, targetFields) && typeof value.host === "string" && value.host.length <= 253 &&
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u.test(value.host) && !/pooler|pgbouncer/u.test(value.host) &&
    Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 &&
    [value.database, value.user, value.runtimeRole].every(roleName) && value.user !== value.runtimeRole &&
    [16, 18].includes(value.serverMajor);
}

const identitySql = `SELECT a.pid,a.backend_start::text AS backend_start,
  current_user AS username,session_user AS session_username,d.datname AS database,d.oid::text AS database_oid,
  r.oid::text AS role_oid,d.datdba=r.oid AS owns_database,
  pg_catalog.current_setting('server_version_num')::int/10000 AS major,
  pg_catalog.current_setting('transaction_read_only') AS read_only,
  pg_catalog.current_setting('transaction_isolation') AS isolation,
  EXISTS(SELECT 1 FROM pg_catalog.pg_locks
    WHERE locktype='advisory' AND pid=a.pid AND database=d.oid
      AND classid=((pg_catalog.hashtext($1)::bigint >> 32) & 4294967295)::oid
      AND objid=(pg_catalog.hashtext($1)::bigint & 4294967295)::oid
      AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS migration_lock
  FROM pg_catalog.pg_stat_activity a
  JOIN pg_catalog.pg_database d ON d.oid=a.datid
  JOIN pg_catalog.pg_roles r ON r.rolname=session_user
  WHERE a.pid=pg_catalog.pg_backend_pid()`;

const accessSql = `SELECT
  pg_catalog.has_database_privilege('public',$1::oid,'CONNECT') AS public_connect,
  pg_catalog.has_database_privilege('public',$1::oid,'TEMP') AS public_temp,
  pg_catalog.has_database_privilege('public',$1::oid,'CREATE') AS public_create,
  pg_catalog.has_schema_privilege('public','public','CREATE') AS public_schema_create,
  EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=ANY($2::text[])) AS previous_or_fixed_role,
  EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
    WHERE datid=$1::oid AND backend_type='client backend' AND pid<>pg_catalog.pg_backend_pid()) AS other_client`;
const loginSql = `SELECT rolname AS name,oid::text AS oid FROM pg_catalog.pg_roles
  WHERE rolcanlogin AND pg_catalog.has_database_privilege(oid,$1::oid,'CONNECT')
  LIMIT 34`;

// These PostgreSQL 16/18 catalogs have normal OIDs for objects created after
// initdb. Count them even in a built-in namespace, alongside objects without
// an OID or without a dependency on another non-pinned object.
const normalOidCatalogs = [
  "pg_am", "pg_cast", "pg_class", "pg_collation", "pg_constraint", "pg_conversion",
  "pg_language", "pg_namespace", "pg_opclass", "pg_operator", "pg_opfamily",
  "pg_proc", "pg_rewrite", "pg_statistic_ext", "pg_trigger", "pg_ts_config",
  "pg_ts_dict", "pg_ts_parser", "pg_ts_template", "pg_type",
];
const emptyCatalogs = [
  "pg_default_acl", "pg_event_trigger", "pg_foreign_data_wrapper", "pg_foreign_server",
  "pg_foreign_table", "pg_largeobject_metadata", "pg_policy", "pg_publication",
  "pg_publication_namespace", "pg_publication_rel", "pg_transform", "pg_user_mappings",
];
const count = (catalog, predicate = "", name = catalog) =>
  `(SELECT count(*)::int FROM pg_catalog.${catalog}${predicate ? " WHERE " + predicate : ""}) AS ${name}`;
const catalogCounts = [
  ...normalOidCatalogs.map(catalog => count(catalog, "oid>=16384")),
  ...emptyCatalogs.map(catalog => count(catalog)),
  count("pg_namespace", "nspname NOT IN ('pg_catalog','pg_toast','information_schema','public')", "unexpected_schemas"),
  count("pg_extension", "extname<>'plpgsql'", "additional_extensions"),
  "(SELECT count(subdbid)::int FROM pg_catalog.pg_subscription WHERE subdbid=$1::oid) AS local_subscriptions",
  count("pg_depend", "objid>=16384 OR refobjid>=16384", "normal_object_dependencies"),
  count("pg_shdepend", "dbid=$1::oid AND objid>=16384", "local_shared_dependencies"),
  count("pg_db_role_setting", "setdatabase=$1::oid OR (setdatabase=0 AND setrole=ANY($2::oid[]))", "relevant_role_settings"),
  count("pg_prepared_xacts", "database=pg_catalog.current_database()", "local_prepared_transactions"),
];
const countsSql = "SELECT " + catalogCounts.join(",\n  ");

const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
function physicalIdentity(row) {
  return [row.pid, row.backend_start, row.database_oid, row.role_oid];
}

export async function verifyEmptyFrontendReplacement(client, options) {
  demand(exact(options, ["target", "predecessorTarget", "administrativeLogins", "verifyEnvironment", "verifySession"]), "input");
  const { target, predecessorTarget, administrativeLogins, verifyEnvironment, verifySession } = options;
  demand(validateTarget(target) && validateTarget(predecessorTarget) &&
    ["host", "port", "database"].some(key => target[key] !== predecessorTarget[key]) &&
    target.user !== predecessorTarget.runtimeRole && typeof verifyEnvironment === "function" &&
    typeof verifySession === "function", "input");
  const forbidden = [...new Set([predecessorTarget.runtimeRole, target.runtimeRole, ...Object.values(FRONTEND_PREPARATION_ROLES)])];
  demand(!forbidden.includes(target.user) && Array.isArray(administrativeLogins) && administrativeLogins.length <= 32 &&
    administrativeLogins.every(login => exact(login, ["name", "oid"]) && roleName(login.name) && oid(login.oid) &&
      login.name !== target.user && !forbidden.includes(login.name)) &&
    new Set(administrativeLogins.map(login => login.name)).size === administrativeLogins.length &&
    new Set(administrativeLogins.map(login => login.oid)).size === administrativeLogins.length, "input");
  const selected = Object.freeze({ ...target }), predecessor = Object.freeze({ ...predecessorTarget });
  const admins = Object.freeze(administrativeLogins.map(login => Object.freeze({ ...login })).sort(byName));
  demand(client instanceof Client, "tls-target");

  const connection = client.connection;
  let phase = "locked-target", original, transactionStatus, lost = false;
  const disconnected = () => { lost = true; };
  // The pinned pg client does not expose this status through a public method.
  // ReadyForQuery distinguishes autocommit from a caller-owned transaction.
  const ready = message => { transactionStatus = message.status; };
  client.on("error", disconnected);
  connection.prependListener("readyForQuery", ready);
  try {
    async function identify(inObservation) {
      const transport = client.connection?.stream, parameters = client.connectionParameters;
      demand(!lost && client.connection === connection && transport?.encrypted === true && transport.authorized === true &&
        parameters?.ssl?.rejectUnauthorized === true && parameters.ssl.checkServerIdentity === undefined &&
        parameters?.host === selected.host && parameters.port === selected.port &&
        parameters.database === selected.database && parameters.user === selected.user, "tls-target");
      const { rows } = await client.query(identitySql, [FRONTEND_MIGRATION_LOCK]);
      const row = rows[0];
      demand(!lost && rows.length === 1 && row.username === selected.user && row.session_username === selected.user &&
        row.database === selected.database && row.major === selected.serverMajor && row.owns_database === true &&
        Number.isInteger(row.pid) && row.pid > 0 && typeof row.backend_start === "string" &&
        oid(row.database_oid) && oid(row.role_oid), "physical-identity");
      demand(row.migration_lock === true, "migration-lock");
      demand(inObservation ? row.read_only === "on" && row.isolation === "repeatable read" &&
        transactionStatus === "T" : transactionStatus === "I", "transaction-boundary");
      const physical = physicalIdentity(row);
      demand(!original || isDeepStrictEqual(physical, original), "physical-identity");
      original ??= physical;
      return row;
    }
    async function verifyHeld() {
      phase = "locked-target";
      await verifyEnvironment();
      await verifySession();
      return identify(false);
    }
    async function observe() {
      phase = "read-only-start";
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const row = await identify(true);
        phase = "database-access";
        const access = (await client.query(accessSql, [row.database_oid, forbidden])).rows[0];
        demand(access?.public_connect === false && access.public_temp === false && access.public_create === false &&
          access.public_schema_create === false && access.previous_or_fixed_role === false && access.other_client === false, phase);
        const expected = [...admins, { name: selected.user, oid: row.role_oid }].sort(byName);
        const logins = (await client.query(loginSql, [row.database_oid])).rows.sort(byName);
        demand(isDeepStrictEqual(logins, expected), "effective-login-access");
        phase = "catalog-scope";
        const { rows } = await client.query(countsSql, [row.database_oid, expected.map(login => login.oid)]);
        demand(rows.length === 1 && Object.keys(rows[0]).length === catalogCounts.length &&
          Object.values(rows[0]).every(count => count === 0), phase);
        await identify(true);
        return rows[0];
      } finally {
        try {
          demand((await client.query("ROLLBACK")).command === "ROLLBACK" && transactionStatus === "I", "read-only-cleanup");
        } catch {
          throw refuse("read-only-cleanup");
        }
      }
    }
    const initial = await verifyHeld();
    const counts = await observe();
    await verifyHeld();
    await observe();
    await verifyHeld();
    return Object.freeze({ version: 1, status: "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED", target: selected,
      predecessorTarget: predecessor, databaseOid: initial.database_oid, migrationRoleOid: initial.role_oid,
      administrativeLogins: admins, catalogScope: "postgresql-16-18-stock-replacement-v1",
      zeroCatalogCounts: Object.freeze(counts), observedAt: new Date().toISOString(), readOnlyVerified: true,
      completeDatabaseEmptyProven: false, authorityIssued: false });
  } catch (error) {
    throw error instanceof BoundaryRefusal ? error : refuse(phase);
  } finally {
    connection.removeListener("readyForQuery", ready);
    client.removeListener("error", disconnected);
  }
}
