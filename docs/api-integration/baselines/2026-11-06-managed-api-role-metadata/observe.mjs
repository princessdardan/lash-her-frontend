// Explicit source-owned, fixed-target metadata observer. Default is plan only.
// No application/journal data, SQL mutation, role switch or explicit lock.
import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, closeSync, readFileSync, lstatSync, realpathSync, mkdtempSync, chmodSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rootCertificates } from "node:tls";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";

const repository = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const runtimeRoot = "/Users/dardan/.local/share/lash-her/releases/staging/p1-41541683416-1/runtime";
const acceptedRecord = "/Users/dardan/workspace/lash-her-frontend/docs/api-integration/baselines/2026-11-03-p1-c07-verified/final-receipts/admission/admission-outcome.json";
export const STARTUP_OPTIONS = "-c search_path=pg_catalog,public -c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000";
export const CONTEXTS = Object.freeze([
  Object.freeze({ context: "course", host: "ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech", port: 5432, database: "neondb", serverMajor: 18,
    runtimeRole: "lash_her_course_staging_runtime", migrationRole: "lash_her_course_staging_migration", files: Object.freeze(["course-api.env", "course-publisher.env", "course-snapshot.env"]) }),
  Object.freeze({ context: "community", host: "ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech", port: 5432, database: "neondb", serverMajor: 18,
    runtimeRole: "lash_her_community_staging_runtime", migrationRole: "lash_her_community_staging_migration", files: Object.freeze(["community-api.env", "community-worker.env"]) }),
]);
const require = createRequire(import.meta.url);
const demand = (ok, code) => { if (!ok) throw Object.assign(new Error("MANAGED_API_METADATA_REFUSED"), { publicCode: code }); };
const fingerprint = raw => createHash("sha256").update(raw).digest("hex");
const scopeFields = context => Object.fromEntries(["context", "host", "port", "database", "serverMajor", "runtimeRole", "migrationRole"].map(name => [name, context[name]]));

export const SQL = Object.freeze({
  identity: `SELECT pg_catalog.current_database() AS database_name,
    current_user AS authenticated_role, session_user AS session_role,
    current_user::pg_catalog.regrole::pg_catalog.oid::pg_catalog.text AS authenticated_role_oid,
    d.datdba::pg_catalog.text AS database_owner_oid,
    pg_catalog.pg_get_userbyid(d.datdba) AS database_owner_name,
    pg_catalog.current_setting('server_version_num')::pg_catalog.int4 / 10000 AS server_major,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('search_path') AS session_search_path,
    pg_catalog.pg_backend_pid() AS backend_pid,
    s.ssl AS server_reports_tls, s.version AS tls_protocol,
    s.cipher AS tls_cipher, s.bits AS tls_bits
    FROM pg_catalog.pg_database d
    LEFT JOIN pg_catalog.pg_stat_ssl s ON s.pid = pg_catalog.pg_backend_pid()
    WHERE d.datname = pg_catalog.current_database()`,
  roles: `WITH RECURSIVE relevant(oid) AS (
      SELECT r.oid FROM pg_catalog.pg_roles r
      WHERE r.rolname = ANY($1::pg_catalog.text[])
        OR r.oid = (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
      UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN relevant r ON r.oid = m.member
    )
    SELECT r.oid::pg_catalog.text AS role_oid, r.rolname AS role_name,
      r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
      r.rolreplication, r.rolbypassrls, r.rolinherit, r.rolconnlimit,
      r.rolvaliduntil::pg_catalog.text AS role_valid_until,
      r.rolconfig IS NULL AS role_config_is_null,
      ARRAY(SELECT pg_catalog.split_part(config.setting, '=', 1)
        FROM pg_catalog.unnest(COALESCE(r.rolconfig, ARRAY[]::pg_catalog.text[])) AS config(setting)
        ORDER BY 1) AS role_setting_names,
      pg_catalog.pg_has_role(r.oid, 'MEMBER') AS runtime_member,
      pg_catalog.pg_has_role(r.oid, 'USAGE') AS runtime_inherits,
      pg_catalog.pg_has_role(r.oid, 'SET') AS runtime_can_set,
      pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CONNECT') AS database_connect,
      pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE') AS database_create,
      pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMP') AS database_temporary
    FROM pg_catalog.pg_roles r JOIN relevant x ON x.oid = r.oid ORDER BY r.oid LIMIT 65`,
  memberships: `SELECT m.roleid::pg_catalog.text AS role_oid, m.member::pg_catalog.text AS member_oid,
    m.grantor::pg_catalog.text AS grantor_oid, m.admin_option, m.inherit_option, m.set_option
    FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = ANY($1::pg_catalog.oid[]) OR m.member = ANY($1::pg_catalog.oid[])
    ORDER BY m.roleid, m.member, m.grantor LIMIT 4097`,
  schemas: `SELECT n.oid::pg_catalog.text AS schema_oid, n.nspname AS schema_name,
    n.nspowner::pg_catalog.text AS owner_oid, pg_catalog.pg_get_userbyid(n.nspowner) AS owner_name,
    n.nspacl IS NULL AS default_acl,
    pg_catalog.has_schema_privilege(n.oid, 'USAGE') AS runtime_usage,
    pg_catalog.has_schema_privilege(n.oid, 'CREATE') AS runtime_create,
    ARRAY(SELECT e.extname FROM pg_catalog.pg_extension e WHERE e.extnamespace = n.oid ORDER BY e.extname) AS extension_names
    FROM pg_catalog.pg_namespace n ORDER BY n.nspname LIMIT 257`,
  schemaAcl: `SELECT n.oid::pg_catalog.text AS schema_oid, n.nspname AS schema_name,
    a.grantor::pg_catalog.text AS grantor_oid, a.grantee::pg_catalog.text AS grantee_oid,
    a.grantee = 0 AS grantee_public, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    ORDER BY n.oid, a.grantee, a.grantor, a.privilege_type LIMIT 4097`,
  databaseRoleSettings: `SELECT s.setdatabase::pg_catalog.text AS database_scope_oid,
    s.setrole::pg_catalog.text AS role_scope_oid,
    ARRAY(SELECT pg_catalog.split_part(config.setting, '=', 1)
      FROM pg_catalog.unnest(s.setconfig) AS config(setting) ORDER BY 1) AS setting_names
    FROM pg_catalog.pg_db_role_setting s
    WHERE s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()))
      AND (s.setrole = 0 OR s.setrole = ANY($1::pg_catalog.oid[]))
    ORDER BY s.setdatabase, s.setrole LIMIT 4097`,
});

function readBounded(path, privateFile = false) {
  demand(realpathSync(path) === path, "SOURCE_PATH_REFUSED");
  for (let parent = path;; parent = dirname(parent)) {
    demand(!lstatSync(parent).isSymbolicLink(), "SOURCE_SYMLINK_REFUSED"); if (dirname(parent) === parent) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd); demand(info.isFile() && info.size > 0 && info.size <= 2_000_000, "SOURCE_REGULAR_FILE_REQUIRED");
    if (privateFile) demand(info.uid === process.getuid() && (info.mode & 0o077) === 0, "PRIVATE_RUNTIME_FILE_REQUIRED");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function parseGroup(context, rawFiles, acceptedHashes) {
  demand(CONTEXTS.includes(context) && Object.keys(rawFiles).sort().join() === [...context.files].sort().join(), "FIXED_CREDENTIAL_GROUP_REQUIRED");
  const urls = [];
  for (const name of context.files) {
    const raw = rawFiles[name]; demand(Buffer.isBuffer(raw) && fingerprint(raw) === acceptedHashes[name], "ACCEPTED_RUNTIME_BYTES_CHANGED");
    const values = {};
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf("="); demand(at > 0 && /^[A-Z][A-Z0-9_]*$/u.test(line.slice(0, at)) && !Object.hasOwn(values, line.slice(0, at)) &&
        !/[\u0000-\u001f\u007f]/u.test(line.slice(at + 1)), "RAW_RUNTIME_FORMAT_REQUIRED");
      values[line.slice(0, at)] = line.slice(at + 1);
    }
    demand(values.DATABASE_TARGET === "staging" && typeof values.STAGING_DATABASE_URL === "string", "STAGING_RUNTIME_REQUIRED"); urls.push(values.STAGING_DATABASE_URL);
  }
  demand(new Set(urls).size === 1, "CREDENTIAL_GROUP_DISAGREES");
  let url; try { url = new URL(urls[0]); } catch { demand(false, "RUNTIME_URL_REFUSED"); }
  const pooler = context.host.replace(".", "-pooler.");
  if (url.hostname === pooler) demand(false, "POOLER_SELECTOR_REQUIRES_EXPLICIT_REVIEW");
  demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === context.host && Number(url.port || 5432) === context.port &&
    decodeURIComponent(url.pathname) === "/" + context.database && decodeURIComponent(url.username) === context.runtimeRole && url.password && !url.hash,
  "FIXED_RUNTIME_SELECTOR_REQUIRED");
  demand([...url.searchParams.keys()].every(name => name === "sslmode") && url.searchParams.getAll("sslmode").length === 1 &&
    ["require", "verify-full", "verify-ca"].includes(url.searchParams.get("sslmode")), "RUNTIME_TLS_SELECTOR_REFUSED");
  return { user: context.runtimeRole, password: decodeURIComponent(url.password), host: context.host, port: context.port, database: context.database };
}

const publicRoles = new Set([...CONTEXTS.flatMap(context => [context.runtimeRole, context.migrationRole]), "neondb_owner", "cloud_admin", "neon_superuser", "pg_database_owner",
  "pg_read_all_data", "pg_write_all_data", "pg_read_all_settings", "pg_read_all_stats", "pg_stat_scan_tables", "pg_monitor", "pg_signal_backend", "pg_checkpoint",
  "pg_read_server_files", "pg_write_server_files", "pg_execute_server_program", "pg_use_reserved_connections", "pg_create_subscription", "pg_maintain"]);
export function sanitizeMetadata(value) {
  const result = structuredClone(value), redactions = { roleNames: 0, identifiers: 0 };
  const visit = item => {
    if (Array.isArray(item)) { item.forEach(visit); return; } if (!item || typeof item !== "object") return;
    for (const [name, field] of Object.entries(item)) {
      if (["role_name", "owner_name", "database_owner_name", "authenticated_role", "session_role"].includes(name) && !publicRoles.has(field)) {
        item[name] = null; item[name + "_redacted"] = true; redactions.roleNames++;
      } else if (name === "schema_name" && (typeof field !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(field))) {
        item[name] = null; item.schema_name_redacted = true; redactions.identifiers++;
      } else if (["setting_names", "role_setting_names"].includes(name)) {
        item[name] = field.map(key => typeof key === "string" && /^[a-z_][a-z0-9_.]{0,191}$/u.test(key) ? key : (redactions.identifiers++, null));
      } else visit(field);
    }
  };
  visit(result); return { ...result, redactions };
}

function credentials() {
  const receipt = JSON.parse(readBounded(acceptedRecord));
  demand(receipt.binding?.environment === "staging" && receipt.binding.releaseId === "p1-41748860504-1" &&
    receipt.binding.frontendSourceCommit === "b99d4f346696f897fa6a6729dfcc52d6503fe8d6", "ACCEPTED_C07_REFERENCE_REQUIRED");
  return CONTEXTS.map(context => ({ context, configuration: parseGroup(context, Object.fromEntries(context.files.map(name => [name, readBounded(join(runtimeRoot, name), true)])), receipt.binding.configurationSha256) }));
}

export function identityDiagnostic(rows, context, client) {
  const row = rows.length === 1 ? rows[0] : {}, stream = client.connection?.stream, ssl = client.connectionParameters?.ssl;
  const protocol = stream?.getProtocol?.();
  return {
    matches: {
      singleton: rows.length === 1, database: row.database_name === context.database,
      authenticatedRole: row.authenticated_role === context.runtimeRole, sessionRole: row.session_role === context.runtimeRole,
      serverMajor: row.server_major === context.serverMajor, readOnly: row.read_only === "on",
      searchPath: typeof row.session_search_path === "string" && /^\s*pg_catalog\s*,\s*public\s*$/u.test(row.session_search_path),
      positiveBackendPid: Number.isInteger(row.backend_pid) && row.backend_pid > 0,
      clientEncrypted: stream?.encrypted === true, clientAuthorized: stream?.authorized === true,
      selectedHost: client.connectionParameters?.host === context.host, selectedPort: client.connectionParameters?.port === context.port,
      explicitBuiltinCa: Boolean(ssl && isDeepStrictEqual(ssl.ca, [...rootCertificates])), explicitSni: ssl?.servername === context.host,
      rejectUnauthorized: ssl?.rejectUnauthorized === true,
    },
    observed: {
      serverMajor: Number.isInteger(row.server_major) && row.server_major > 0 && row.server_major < 100 ? row.server_major : null,
      transactionReadOnly: ["on", "off"].includes(row.read_only) ? row.read_only : null,
      clientTlsProtocol: ["TLSv1.2", "TLSv1.3"].includes(protocol) ? protocol : null,
      backendReportsTls: typeof row.server_reports_tls === "boolean" ? row.server_reports_tls : null,
      backendTlsProtocol: ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"].includes(row.tls_protocol) ? row.tls_protocol : null,
    },
  };
}

export function checkIdentity(rows, context, client) {
  demand(rows.length === 1, "IDENTITY_ROW_REQUIRED");
  demand(Object.values(identityDiagnostic(rows, context, client).matches).every(Boolean), "EXACT_READONLY_IDENTITY_REQUIRED");
  return rows[0];
}

async function snapshot(client, context) {
  const identityRows = (await client.query(SQL.identity)).rows; const identity = checkIdentity(identityRows, context, client);
  const roles = (await client.query(SQL.roles, [[context.runtimeRole, context.migrationRole, "pg_database_owner"]])).rows;
  demand(roles.length < 65 && [context.runtimeRole, context.migrationRole].every(name => roles.some(row => row.role_name === name)), "ROLE_BOUND_OR_IDENTITY_UNKNOWN");
  const oids = roles.map(row => row.role_oid); demand(oids.every(value => typeof value === "string" && /^[1-9][0-9]*$/u.test(value)), "ROLE_OID_REQUIRED");
  const result = { identity, identityVerification: identityDiagnostic(identityRows, context, client), roles };
  for (const [name, parameters, limit] of [["memberships", [oids], 4097], ["schemas", [], 257], ["schemaAcl", [], 4097], ["databaseRoleSettings", [oids], 4097]]) {
    result[name] = (await client.query(SQL[name], parameters)).rows; demand(result[name].length < limit, "METADATA_ROW_BOUND_UNKNOWN");
  }
  return result;
}

function record(directory, name, value) { writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
export const observe = () => runObservation(false);
export const diagnoseIdentity = () => runObservation(true);
async function runObservation(identityOnly) {
  demand(process.versions.node === "24.18.0" && process.execArgv.length === 0 && Object.keys(process.env).every(name =>
    !/^(?:PG|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_|SSL_CERT_|LD_|DYLD_)/u.test(name)), "CLOSED_PINNED_RUNTIME_REQUIRED");
  const lock = JSON.parse(readBounded(join(repository, "package-lock.json"))), pgVersion = require("pg/package.json").version;
  demand(lock.packages["node_modules/pg"].version === pgVersion && rootCertificates.length > 0, "PINNED_PG_AND_CA_REQUIRED");
  const sourcePaths = [fileURLToPath(import.meta.url), join(repository, "package-lock.json"), acceptedRecord];
  const sourceFingerprints = sourcePaths.map(path => fingerprint(readBounded(path)));
  const groups = credentials(); // Validate ALL five inputs before any connection.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "lash-p2-managed-api-role-metadata-"))); chmodSync(directory, 0o700);
  const results = [];
  for (const { context, configuration } of groups) {
    let phase = "connect", client, initial, final, failure = null, closeAwaited = false, connected = false, idleError = false, diagnostic = null, sourceReadbackVerified = false;
    try {
      client = new Client({ ...configuration, application_name: "lash-p2-api-role-metadata-readonly", options: STARTUP_OPTIONS,
        ssl: { ca: [...rootCertificates], servername: context.host, rejectUnauthorized: true },
        connectionTimeoutMillis: 5000, query_timeout: 6000 });
      client.on("error", () => { idleError = true; });
      await client.connect(); connected = true;
      if (identityOnly) {
        phase = "identity-diagnostic";
        const rows = (await client.query(SQL.identity)).rows;
        diagnostic = identityDiagnostic(rows, context, client);
        checkIdentity(rows, context, client);
      } else {
        phase = "initial-metadata"; initial = await snapshot(client, context);
        phase = "final-metadata"; final = await snapshot(client, context);
        phase = "stable-readback"; demand(!idleError && isDeepStrictEqual(initial, final), "METADATA_CHANGED_DURING_OBSERVATION");
      }
    } catch (error) { failure = { phase, code: error.publicCode ?? "MANAGED_API_METADATA_UNKNOWN" }; }
    finally {
      try {
        credentials();
        demand(sourcePaths.every((path, index) => fingerprint(readBounded(path)) === sourceFingerprints[index]), "OBSERVER_SOURCE_READBACK_CHANGED");
        sourceReadbackVerified = true;
      }
      catch { failure = { phase: "source-readback", code: "ACCEPTED_RUNTIME_READBACK_UNKNOWN" }; }
      if (client) {
        let timer;
        try { await Promise.race([client.end(), new Promise((_, reject) => { timer = setTimeout(() => { client.connection?.stream?.destroy(); reject(Error("close")); }, 5000); })]); closeAwaited = true; }
        catch { failure = { phase: "close", code: "CLOSE_NOT_VERIFIED" }; }
        finally { clearTimeout(timer); }
      }
    }
    if (idleError) failure = { phase: "connection", code: "CONNECTION_ERROR_OBSERVED" };
    const raw = { context: context.context, target: scopeFields(context), connected, initial, final, failure, closeAwaited, sourceReadbackVerified,
      ...(identityOnly ? { identityDiagnostic: diagnostic, strictIdentityAccepted: Boolean(diagnostic && Object.values(diagnostic.matches).every(Boolean)) } : {}) };
    record(directory, context.context + "-private-raw.json", raw);
    const diagnosticRecorded = Boolean(identityOnly && diagnostic && sourceReadbackVerified && closeAwaited && !idleError);
    const sanitized = sanitizeMetadata({ version: 1, status: identityOnly ? (diagnosticRecorded ? "P2_MANAGED_API_IDENTITY_DIAGNOSTIC_RECORDED" : "P2_MANAGED_API_IDENTITY_DIAGNOSTIC_UNKNOWN") :
      (failure ? "P2_MANAGED_API_ROLE_METADATA_UNKNOWN" : "P2_MANAGED_API_ROLE_METADATA_OBSERVED"),
      ...raw, sourceBindingVerified: true, tlsAuthorized: identityOnly ? (diagnostic ? diagnostic.matches.clientEncrypted && diagnostic.matches.clientAuthorized : null) : Boolean(initial),
      rowBoundsComplete: Boolean(initial && final), readbackStable: Boolean(!failure && initial && final),
      metadataOnly: true, observerImposed: { searchPath: "pg_catalog,public", defaultTransactionReadOnly: "on", statementTimeoutMs: 5000, lockTimeoutMs: 1000, idleInTransactionSessionTimeoutMs: 5000 },
      caSource: "Node24.18.0-built-in-rootCertificates", pgVersion, frontendQualified: false, migrationAuthorized: false, rolePreparationAuthorized: false, wholeReleaseAccepted: false });
    record(directory, context.context + "-sanitized.json", sanitized); results.push(sanitized);
  }
  const summary = { version: 1, status: identityOnly ? (results.every(result => result.status === "P2_MANAGED_API_IDENTITY_DIAGNOSTIC_RECORDED") ? "P2_MANAGED_API_IDENTITY_DIAGNOSTIC_RECORDED" : "P2_MANAGED_API_IDENTITY_DIAGNOSTIC_UNKNOWN") :
    (results.every(result => result.status === "P2_MANAGED_API_ROLE_METADATA_OBSERVED") ? "P2_MANAGED_API_METADATA_OBSERVED" : "P2_MANAGED_API_METADATA_UNKNOWN"),
    observationMode: identityOnly ? "identity-only-diagnostic" : "full-metadata",
    observedAt: new Date().toISOString(), privateReceiptDirectory: directory, managedConnectionAttempts: results.length, results,
    readonlyPreparationOnly: true, frontendQualified: false, wholeReleaseAccepted: false };
  record(directory, "summary-sanitized.json", summary); return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 2) process.stdout.write(JSON.stringify({ status: "P2_MANAGED_API_METADATA_PLAN", contexts: CONTEXTS.map(scopeFields), metadataOnly: true, connectionsOpened: 0 }) + "\n");
  else if (process.argv.length === 3 && ["--observe-read-only", "--diagnose-identity-read-only"].includes(process.argv[2])) {
    (process.argv[2] === "--observe-read-only" ? observe() : diagnoseIdentity()).then(value => process.stdout.write(JSON.stringify(value) + "\n")).catch(error => {
      process.stdout.write(JSON.stringify({ status: "P2_MANAGED_API_METADATA_UNKNOWN", code: error.publicCode ?? "PRECONNECTION_CONTEXT_UNKNOWN", connectionsOpened: 0 }) + "\n"); process.exitCode = 1;
    });
  } else { process.stdout.write('{"status":"P2_MANAGED_API_METADATA_REFUSED"}\n'); process.exitCode = 1; }
}
