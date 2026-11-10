import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-admission-bootstrap.mjs";

export const MANAGED_NEON_REPLACEMENT_CATALOG_SCOPE = "postgresql-18-managed-neon-replacement-v1";
const baselineId = "staging-neon-replacement-2026-11-09";
const baselineSha256 = "a2215d75c64cce39711c4e616974a6a5f97d6ea273479f1868db4c746269a715";
const baselineDirectHost = "ep-lingering-meadow-bc80gyj9.c-16.us-east-1.aws.neon.tech";
const baselineFile = new URL("./managed-neon-replacement-catalog.json", import.meta.url);
const baselineFields = [
  "version", "id", "provider", "target", "databaseOid", "migrationRoleOid", "administrativeLogins",
  "roles", "memberships", "defaultAcl", "dependencies", "sharedDependencies", "databaseAclBefore",
  "databaseAclAfter", "expectedNonzeroCatalogCounts",
];
const providerFields = ["kind", "projectId", "branchId", "endpointId", "directHost"];
const targetFields = ["host", "port", "database", "user", "runtimeRole", "serverMajor"];
const oid = value => typeof value === "string" && /^(?:0|[1-9][0-9]{0,9})$/u.test(value) && Number(value) <= 4294967295;
const objectOid = value => value !== "0" && oid(value);
const roleName = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const bool = value => typeof value === "boolean";
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const demand = condition => { if (!condition) throw new Error("FRONTEND_MANAGED_NEON_CATALOG_REFUSED"); };
const tupleList = (value, count, checks) => Array.isArray(value) && value.length === count &&
  value.every(row => Array.isArray(row) && row.length === checks.length && row.every((item, index) => checks[index](item)));
const frozen = value => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
};

// The stock and managed observers count the same catalog classes. Managed
// observation permits just the three pinned nonzero counts after row readback.
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
const count = (catalog, predicate = "", name = catalog) => [name,
  `(SELECT count(*)::int FROM pg_catalog.${catalog}${predicate ? " WHERE " + predicate : ""}) AS ${name}`];
const catalogCounts = [
  ...normalOidCatalogs.map(catalog => count(catalog, "oid>=16384")),
  ...emptyCatalogs.map(catalog => count(catalog)),
  count("pg_namespace", "nspname NOT IN ('pg_catalog','pg_toast','information_schema','public')", "unexpected_schemas"),
  count("pg_extension", "extname<>'plpgsql'", "additional_extensions"),
  ["local_subscriptions", "(SELECT count(subdbid)::int FROM pg_catalog.pg_subscription WHERE subdbid=$1::oid) AS local_subscriptions"],
  count("pg_depend", "objid>=16384 OR refobjid>=16384", "normal_object_dependencies"),
  count("pg_shdepend", "dbid=$1::oid AND objid>=16384", "local_shared_dependencies"),
  count("pg_db_role_setting", "setdatabase=$1::oid OR (setdatabase=0 AND setrole=ANY($2::oid[]))", "relevant_role_settings"),
  count("pg_prepared_xacts", "database=pg_catalog.current_database()", "local_prepared_transactions"),
];
const nonzeroCounts = { pg_default_acl: 2, normal_object_dependencies: 2, local_shared_dependencies: 2 };
const expectedCatalogCounts = Object.freeze(Object.fromEntries(catalogCounts.map(([name]) => [name, nonzeroCounts[name] ?? 0])));
export const replacementCatalogCount = catalogCounts.length;
export const replacementCatalogCountsSql = "SELECT " + catalogCounts.map(([, sql]) => sql).join(",\n  ");

function readBaseline(reference) {
  demand(exact(reference, ["id", "sha256"]) && reference.id === baselineId && reference.sha256 === baselineSha256);
  const raw = readFileSync(baselineFile);
  demand(raw.length > 0 && raw.length <= 16_384 && createHash("sha256").update(raw).digest("hex") === baselineSha256);
  return decodeQualificationTargetJson(raw, "carrier");
}

function selectBaseline(reference, { provider, target, databaseOid, migrationRoleOid, administrativeLogins }, baseline) {
  demand(exact(baseline, baselineFields) && baseline.version === 1 && baseline.id === baselineId &&
    exact(provider, providerFields) && exact(baseline.provider, providerFields) && provider.kind === "neon" &&
    exact(target, targetFields) && exact(baseline.target, targetFields) && target.serverMajor === 18 &&
    target.host === baselineDirectHost && target.host === provider.directHost && isDeepStrictEqual(provider, baseline.provider) &&
    isDeepStrictEqual(target, baseline.target) && objectOid(databaseOid) && databaseOid === baseline.databaseOid &&
    objectOid(migrationRoleOid) && migrationRoleOid === baseline.migrationRoleOid &&
    isDeepStrictEqual(administrativeLogins, baseline.administrativeLogins) &&
    isDeepStrictEqual(baseline.expectedNonzeroCatalogCounts, nonzeroCounts));
  const { roles, memberships, defaultAcl, dependencies, sharedDependencies, databaseAclBefore, databaseAclAfter } = baseline;
  const roleFlags = [bool, bool, bool, bool, bool, bool, bool];
  demand(tupleList(roles, 4, [roleName, objectOid, ...roleFlags, Number.isSafeInteger]) &&
    new Set(roles.map(row => row[0])).size === roles.length && new Set(roles.map(row => row[1])).size === roles.length &&
    roles.some(row => row[0] === target.user && row[1] === migrationRoleOid && row[2] === true) &&
    Array.isArray(administrativeLogins) && administrativeLogins.length === 2 &&
    administrativeLogins.every(login => exact(login, ["name", "oid"]) &&
      roles.some(row => row[0] === login.name && row[1] === login.oid && row[2] === true)) &&
    tupleList(memberships, 9, [objectOid, objectOid, objectOid, bool, bool, bool]) &&
    tupleList(defaultAcl, 2, [objectOid, objectOid, oid, value => typeof value === "string" && /^[A-Za-z]$/u.test(value),
      value => typeof value === "string" && value.length <= 4096]) &&
    tupleList(dependencies, 2, [objectOid, roleName, Number.isSafeInteger, roleName, objectOid, Number.isSafeInteger, roleName]) &&
    tupleList(sharedDependencies, 2, [objectOid, roleName, Number.isSafeInteger, roleName, objectOid, roleName]));
  const privileges = [oid, objectOid, value => typeof value === "string" && /^[A-Z]+$/u.test(value), bool];
  demand(Array.isArray(databaseAclBefore) && Array.isArray(databaseAclAfter) &&
    databaseAclBefore.length === databaseAclAfter.length + 2 && databaseAclAfter.length <= 32 &&
    tupleList(databaseAclBefore, databaseAclBefore.length, privileges) &&
    tupleList(databaseAclAfter, databaseAclAfter.length, privileges) &&
    isDeepStrictEqual(databaseAclBefore.filter(row => row[0] === "0").map(row => row[2]), ["CONNECT", "TEMPORARY"]) &&
    isDeepStrictEqual(databaseAclBefore.filter(row => row[0] !== "0"), databaseAclAfter));
  return frozen({ reference: { ...reference }, databaseOid, migrationRoleOid, roles, memberships, defaultAcl,
    dependencies, sharedDependencies, databaseAclBefore, databaseAclAfter, expectedCatalogCounts });
}

export function selectManagedNeonCatalog(reference, context) {
  try {
    return selectBaseline(reference, context, readBaseline(reference));
  } catch {
    throw new Error("FRONTEND_MANAGED_NEON_CATALOG_REFUSED");
  }
}

// The post-write packet already binds the exact host, physical OIDs and admins
// through the reviewed write. Any changed binding for this host is a refusal.
export function selectManagedNeonCatalogForTarget(context) {
  if (context?.target?.host !== baselineDirectHost) return undefined;
  const reference = { id: baselineId, sha256: baselineSha256 };
  try {
    const baseline = readBaseline(reference);
    return selectBaseline(reference, { ...context, provider: baseline.provider }, baseline);
  } catch {
    throw new Error("FRONTEND_MANAGED_NEON_CATALOG_REFUSED");
  }
}

const readRows = async (client, text, values = []) => (await client.query({ text, values, rowMode: "array" })).rows;

export async function readManagedNeonCatalog(client, selection, preparedRoleOids = []) {
  const { databaseOid, migrationRoleOid, roles } = selection;
  const roleOids = roles.map(row => row[1]);
  const prepared = preparedRoleOids.length !== 0;
  const managedAclOids = prepared ? selection.defaultAcl.map(row => row[0]) : [];
  const observedRoles = await readRows(client, `SELECT rolname,oid::text,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,
    rolreplication,rolinherit,rolbypassrls,rolconnlimit FROM pg_catalog.pg_roles
    WHERE oid=ANY($1::oid[]) ORDER BY rolname::text COLLATE "C" LIMIT 5`, [roleOids]);
  const memberships = await readRows(client, `SELECT m.roleid::text,m.member::text,m.grantor::text,
    m.admin_option,m.inherit_option,m.set_option FROM pg_catalog.pg_auth_members m
    WHERE (m.member=ANY($1::oid[]) OR m.roleid=ANY($1::oid[])) AND NOT (m.roleid=ANY($2::oid[]))
    ORDER BY m.roleid,m.member,m.grantor LIMIT 10`, [roleOids, preparedRoleOids]);
  const defaultAcl = await readRows(client, `SELECT oid::text,defaclrole::text,defaclnamespace::text,defaclobjtype,defaclacl::text
    FROM pg_catalog.pg_default_acl WHERE NOT $1::boolean OR defaclrole<>$2::oid ORDER BY oid LIMIT 3`, [prepared, migrationRoleOid]);
  const dependencies = await readRows(client, `SELECT d.objid::text,c.relname,d.objsubid,rc.relname,d.refobjid::text,d.refobjsubid,d.deptype
    FROM pg_catalog.pg_depend d LEFT JOIN pg_catalog.pg_class c ON c.oid=d.classid
    LEFT JOIN pg_catalog.pg_class rc ON rc.oid=d.refclassid
    WHERE CASE WHEN $1::boolean THEN
      (c.relname='pg_default_acl' AND d.objid=ANY($2::oid[])) OR
      (rc.relname='pg_default_acl' AND d.refobjid=ANY($2::oid[]))
      ELSE d.objid>=16384 OR d.refobjid>=16384 END
    ORDER BY d.objid,d.classid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype LIMIT 3`, [prepared, managedAclOids]);
  const sharedDependencies = await readRows(client, `SELECT d.objid::text,c.relname,d.objsubid,rc.relname,d.refobjid::text,d.deptype
    FROM pg_catalog.pg_shdepend d LEFT JOIN pg_catalog.pg_class c ON c.oid=d.classid
    LEFT JOIN pg_catalog.pg_class rc ON rc.oid=d.refclassid
    WHERE d.dbid=$1::oid AND (CASE WHEN $2::boolean THEN c.relname='pg_default_acl' AND d.objid=ANY($3::oid[])
      ELSE d.objid>=16384 END)
    ORDER BY d.objid,d.classid,d.objsubid,d.refclassid,d.refobjid,d.deptype LIMIT 3`, [databaseOid, prepared, managedAclOids]);
  const databaseAcl = await readRows(client, `SELECT a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) a
    WHERE d.oid=$1::oid ORDER BY a.grantee,a.grantor,a.privilege_type COLLATE "C",a.is_grantable LIMIT 33`, [databaseOid]);
  return { roles: observedRoles, memberships, defaultAcl, dependencies, sharedDependencies, databaseAcl };
}

const compareDatabaseAcl = (left, right) => Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1]) ||
  (left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : Number(left[3]) - Number(right[3]));

export async function verifyManagedNeonCatalog(client, selection, options = {}) {
  demand(exact(options, []) || exact(options, ["databaseAcl"]) && ["before", "after"].includes(options.databaseAcl) ||
    exact(options, ["preparedRoles"]) && exact(options.preparedRoles, ["owner", "runtime"]));
  const { preparedRoles } = options;
  let preparedRoleOids = [], expectedAcl = options.databaseAcl === "before" ? selection.databaseAclBefore : selection.databaseAclAfter;
  if (preparedRoles) {
    const { owner, runtime } = preparedRoles;
    demand([["owner", owner], ["runtime", runtime]].every(([kind, role]) => exact(role, ["name", "oid"]) &&
      role.name === FRONTEND_PREPARATION_ROLES[kind] && objectOid(role.oid) &&
      selection.roles.every(row => row[1] !== role.oid)) && owner.oid !== runtime.oid);
    preparedRoleOids = [owner.oid, runtime.oid];
    expectedAcl = [...expectedAcl, [owner.oid, selection.migrationRoleOid, "CREATE", false],
      [runtime.oid, selection.migrationRoleOid, "CONNECT", false]].sort(compareDatabaseAcl);
  }
  const { databaseAcl, ...physical } = await readManagedNeonCatalog(client, selection, preparedRoleOids);
  demand(isDeepStrictEqual(databaseAcl, expectedAcl) &&
    Object.entries(physical).every(([name, rows]) => isDeepStrictEqual(rows, selection[name])));
  if (preparedRoles) {
    const defaults = await readRows(client, `SELECT defaclnamespace::text,defaclobjtype,cardinality(defaclacl)
      FROM pg_catalog.pg_default_acl WHERE defaclrole=$1::oid ORDER BY defaclobjtype LIMIT 3`, [selection.migrationRoleOid]);
    const publicNamespaceOid = selection.defaultAcl[0][2];
    demand(isDeepStrictEqual(defaults, [[publicNamespaceOid, "S", 1], [publicNamespaceOid, "r", 1]]));
  }
}
