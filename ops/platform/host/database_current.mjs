import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

export class CurrentDatabaseError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const demand = (condition, code) => { if (!condition) throw new CurrentDatabaseError(code); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const identitySql = `SELECT current_database() AS database, current_user AS role,
  current_setting('server_version_num') AS version,
  current_setting('transaction_read_only') AS read_only`;
const rolesSql = `SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin,
  has_database_privilege(oid,current_database(),'CREATE') AS database_create,
  has_database_privilege(oid,current_database(),'CONNECT') AS database_connect,
  has_schema_privilege(oid,'public','USAGE') AS schema_usage,
  has_schema_privilege(oid,'public','CREATE') AS schema_create,
  (SELECT count(*)::int FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships
  FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`;
const defaultsSql = `SELECT d.defaclobjtype AS kind,count(*)::int AS count
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole=$1::regrole AND d.defaclnamespace='public'::regnamespace AND a.grantee=$2::regrole
    AND NOT a.is_grantable AND ((d.defaclobjtype='r' AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
      OR (d.defaclobjtype='S' AND a.privilege_type IN ('USAGE','SELECT')))
  GROUP BY d.defaclobjtype ORDER BY d.defaclobjtype`;
const grantsSql = `SELECT bool_and(has_table_privilege($1,c.oid,'SELECT') AND has_table_privilege($1,c.oid,'INSERT')
  AND has_table_privilege($1,c.oid,'UPDATE') AND has_table_privilege($1,c.oid,'DELETE')
  AND NOT has_table_privilege($1,c.oid,'TRUNCATE')) AS runtime_dml,
  NOT has_schema_privilege($1,'drizzle','USAGE') AS journal_isolated
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')`;

/** Called only with inputs prepared by the selected image's manifest validator.
 * One server-enforced read-only snapshot covers identity, journal, schema and roles.
 * This function has no migration, advisory-lock, DDL, DML or repair path. */
export async function checkCurrentDatabase({ client, prepared, assertAppliedLineage, readMigrationCatalog, hasVerifiedMigrationTransport }) {
  const { manifest, artifact, target, baseline } = prepared;
  demand(manifest.environment === "staging" && target.environment === "staging", "CURRENT_CHECK_STAGING_REQUIRED");
  demand(/^lash_her_(course|community)_staging_migration$/u.test(target.user)
    && manifest.runtimeRole === target.user.replace(/_migration$/u, "_runtime"), "CURRENT_CHECK_DEDICATED_ROLES_REQUIRED");
  demand(hasVerifiedMigrationTransport(client, target.host) === true, "CURRENT_CHECK_AUTHENTICATED_TLS_CHANNEL_REQUIRED");
  let begun = false;
  const read = { async query(sql, values) {
    demand(typeof sql === "string" && /^SELECT\b/iu.test(sql.trimStart()), "CURRENT_CHECK_SELECT_ONLY");
    return client.query(sql, values);
  } };
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    const identity = (await read.query(identitySql)).rows[0];
    demand(identity?.database === target.database && identity.role === target.user, "CURRENT_CHECK_DATABASE_IDENTITY_MISMATCH");
    demand(typeof identity.version === "string" && /^\d+$/u.test(identity.version)
      && Math.floor(Number(identity.version) / 10_000) === target.serverMajor, "CURRENT_CHECK_DATABASE_MAJOR_MISMATCH");
    demand(identity.read_only === "on", "CURRENT_CHECK_SERVER_READ_ONLY_REQUIRED");
    const journal = (await read.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST, id ASC")).rows;
    demand(journal.length > 0 && assertAppliedLineage(artifact, journal).length === 0, "CURRENT_CHECK_COMPLETE_LINEAGE_REQUIRED");
    const catalog = await readMigrationCatalog(read);
    demand(isDeepStrictEqual(catalog, baseline.catalog), "CURRENT_CHECK_SCHEMA_CATALOG_MISMATCH");
    const roles = (await read.query(rolesSql, [[target.user, manifest.runtimeRole]])).rows;
    demand(roles.length === 2 && new Set(roles.map((r) => r.rolname)).size === 2
      && roles.every((r) => [target.user, manifest.runtimeRole].includes(r.rolname)), "CURRENT_CHECK_ROLE_SET_MISMATCH");
    for (const role of roles) {
      const migration = role.rolname === target.user;
      demand(role.rolsuper === false && role.rolcreatedb === false && role.rolcreaterole === false
        && role.rolreplication === false && role.rolbypassrls === false && role.rolinherit === false
        && role.rolcanlogin === true && role.memberships === 0 && role.database_connect === true
        && role.schema_usage === true && role.database_create === migration && role.schema_create === migration,
      "CURRENT_CHECK_ROLE_ISOLATION_MISMATCH");
    }
    const defaults = (await read.query(defaultsSql, [target.user, manifest.runtimeRole])).rows;
    demand(defaults.some((r) => r.kind === "r" && r.count === 4) && defaults.some((r) => r.kind === "S" && r.count === 2),
      "CURRENT_CHECK_FUTURE_DML_MISMATCH");
    const grants = (await read.query(grantsSql, [manifest.runtimeRole])).rows[0];
    demand(grants?.runtime_dml === true && grants.journal_isolated === true, "CURRENT_CHECK_RUNTIME_GRANTS_MISMATCH");
    demand(hasVerifiedMigrationTransport(client, target.host) === true, "CURRENT_CHECK_AUTHENTICATED_TLS_CHANNEL_REQUIRED");
    return { status: "CURRENT_API_DATABASE_READ_ONLY_PASS", environment: "staging", service: artifact.service,
      appliedCount: journal.length, pendingTags: [], artifactSha256: artifact.artifactSha256,
      schemaBaselineSha256: manifest.schemaBaselineSha256,
      target: { host: target.host, port: target.port, database: target.database, user: target.user, serverMajor: target.serverMajor },
      checks: ["verified-tls", "server-enforced-read-only", "complete-lineage", "exact-schema-catalog",
        "dedicated-role-isolation", "runtime-future-dml", "runtime-journal-isolation"],
      transportVerifier: "selected-image/hasVerifiedMigrationTransport",
      migrationsExecuted: false, credentialsIncluded: false, trafficAuthorized: false };
  } finally {
    if (begun) await client.query("ROLLBACK");
  }
}

export async function main(args = process.argv.slice(2)) {
  demand(args.length === 2, "CURRENT_CHECK_MANIFEST_AND_SCHEMA_FILES_REQUIRED");
  demand(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "CURRENT_CHECK_VERIFIED_TLS_REQUIRED");
  const manifestBytes = readFileSync(args[0], "utf8"), baselineBytes = readFileSync(args[1], "utf8");
  // The reviewed host parent mounts exact files and runs the pinned migration image.
  const { prepareOperatorMigration } = await import("/app/dist-migration/src/db/operator-migration.js");
  const { assertAppliedLineage, directMigrationConnection, hasVerifiedMigrationTransport } = await import("/app/dist-migration/src/db/migration-lineage.js");
  const { readMigrationCatalog } = await import("/app/dist-migration/src/db/migration-schema.js");
  const { Client } = await import("/app/node_modules/pg/esm/index.mjs");
  const service = JSON.parse(readFileSync("/app/package.json", "utf8")).name;
  const prepared = prepareOperatorMigration(manifestBytes, baselineBytes, "/app/drizzle", service);
  const input = [];
  let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; demand(length <= 16_384, "CURRENT_CHECK_INPUT_TOO_LARGE"); input.push(chunk); }
  const credential = JSON.parse(Buffer.concat(input).toString("utf8"));
  demand(credential && Object.keys(credential).length === 1 && typeof credential.connectionUrl === "string", "CURRENT_CHECK_PRIVATE_STDIN_REQUIRED");
  const url = new URL(credential.connectionUrl);
  demand(url.search === "?sslmode=verify-full", "CURRENT_CHECK_VERIFIED_TLS_REQUIRED");
  const config = { ...directMigrationConnection(credential.connectionUrl, prepared.target), enableChannelBinding: true,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000" };
  delete credential.connectionUrl;
  const client = new Client(config);
  let connectionFailed = false, result;
  client.on("error", () => { connectionFailed = true; });
  try {
    await client.connect();
    demand(!connectionFailed, "CURRENT_CHECK_CONNECTION_FAILED");
    result = await checkCurrentDatabase({ client, prepared, assertAppliedLineage, readMigrationCatalog, hasVerifiedMigrationTransport });
    demand(!connectionFailed, "CURRENT_CHECK_CONNECTION_FAILED");
  } finally { await client.end(); }
  demand(!connectionFailed, "CURRENT_CHECK_CONNECTION_FAILED");
  process.stdout.write(JSON.stringify({ ...result, manifestSha256: hash(manifestBytes), checkerSha256: hash(readFileSync(import.meta.filename)) }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof CurrentDatabaseError ? error.code : "CURRENT_CHECK_INPUT_OR_DATABASE_FAILURE";
    process.stderr.write(JSON.stringify({ status: "CURRENT_API_DATABASE_READ_ONLY_REFUSED", code, migrationsExecuted: false }) + "\n");
    process.exitCode = 1;
  });
}
