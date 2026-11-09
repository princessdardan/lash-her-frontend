import { randomBytes } from "node:crypto";
import { readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK, prepareFrontendMigration } from "./frontend-migration.mjs";
import { P2_PROFILED_CURRENT_LOCK_APPLICATION } from "./p2-profiled-current-probe.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = "P2_FRONTEND_REPLACEMENT_PHYSICAL_OBSERVATION_REFUSED";
const operation = "verify-pre-bootstrap-lock";
const staticFields = ["version", "qualificationTargetProfile", "operation", "candidate", "job", "baseline",
  "predecessorTarget", "targetSha256", "databaseOid", "migrationRoleOid"];
const targetFields = ["host", "port", "database", "user", "runtimeRole", "serverMajor"];
const jobFields = ["version", "qualificationTargetProfile", "operator", "releaseId", "environment", "contractPhase",
  "phase2ContractManifestSha256", "sourceCommit", "contractManifestSha256", "migrationImageDigest",
  "sqlArtifactSha256", "schemaBaselineSha256", "recoveryRef", "target"];
const demand = value => { if (!value) throw new Error(refusal); };
const keys = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === fields.length && fields.every(field => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  });
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const role = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const start = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(value);
const pid = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const directTarget = value => typeof value.host === "string" && value.host.length <= 253 &&
  /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u.test(value.host) && !/pooler|pgbouncer/u.test(value.host) &&
  Number.isInteger(value.port) && value.port > 0 && value.port < 65536 &&
  [value.user, value.runtimeRole, value.database].every(role) && value.user !== value.runtimeRole &&
  [16, 18].includes(value.serverMajor);

function validate(input, physical) {
  demand(keys(input, physical ? [...staticFields, "marker", "backendPid", "backendStart"] : staticFields) &&
    input.version === 1 && input.operation === operation && oid(input.databaseOid) && oid(input.migrationRoleOid) &&
    (!physical || digest(input.marker) && pid(input.backendPid) && start(input.backendStart)));
  requireQualificationTargetProfile(profile, input);
  const { job, candidate, baseline, predecessorTarget } = input;
  demand(keys(job, jobFields) && keys(job.target, [...targetFields, "qualificationTargetProfile", "allowEmptyBootstrap", "approvedPendingTags"]) &&
    job.environment === "staging" && job.contractPhase === "p2" &&
    directTarget(job.target) && keys(predecessorTarget, targetFields) && directTarget(predecessorTarget) &&
    ["host", "port", "database"].some(field => job.target[field] !== predecessorTarget[field]) &&
    ![job.target.user, job.target.runtimeRole].includes(predecessorTarget.runtimeRole) &&
    input.targetSha256 === frontendAdmissionTargetSha256("staging", job.target));
  const { artifact } = prepareFrontendMigration(candidate, job, baseline, undefined, profile);
  demand(job.target.allowEmptyBootstrap === true &&
    isDeepStrictEqual(job.target.approvedPendingTags, artifact.migrations.map(({ tag }) => tag)));
  return artifact;
}

export function validateP2FrontendReplacementProbe(input) {
  return validate(input, true);
}

const backendStart = `pg_catalog.to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const identitySql = `SELECT current_user AS role, session_user AS login, pg_catalog.current_database() AS database,
  pg_catalog.current_setting('server_version_num')::int/10000 AS major,
  pg_catalog.current_setting('transaction_read_only') AS read_only,
  pg_catalog.pg_backend_pid() AS current_pid,
  a.pid, ${backendStart} AS backend_start, a.application_name, a.usename, a.usesysid::text AS role_oid,
  a.datname, a.datid::text AS database_oid,
  (SELECT count(DISTINCT held.objid)::int FROM pg_catalog.pg_locks held
    JOIN (SELECT pg_catalog.hashtext($2)::bigint AS key UNION SELECT pg_catalog.hashtext($3)::bigint) required
      ON held.classid=((required.key>>32)&4294967295)::oid AND held.objid=(required.key&4294967295)::oid
    WHERE held.locktype='advisory' AND held.database=a.datid AND held.pid=a.pid
      AND held.objsubid=1 AND held.mode='ExclusiveLock' AND held.granted) AS locks
  FROM pg_catalog.pg_stat_activity a WHERE a.pid=$1 AND a.backend_type='client backend'`;

function verifiedTransport(client, target) {
  const transport = client.connection?.stream, connection = client.connectionParameters;
  demand(client instanceof Client && transport?.encrypted === true && transport.authorized === true &&
    connection?.ssl?.rejectUnauthorized === true && connection.ssl.checkServerIdentity === undefined &&
    ["host", "port", "database", "user"].every(field => connection[field] === target[field]));
}

async function verifyLockedBackend(client, input, independent) {
  const target = input.job.target;
  verifiedTransport(client, target);
  const { rows } = await client.query(identitySql, [input.backendPid, FRONTEND_MIGRATION_LOCK, input.marker]);
  const row = rows[0];
  demand(rows.length === 1 && row.role === target.user && row.login === target.user && row.database === target.database &&
    row.major === target.serverMajor && row.pid === input.backendPid && row.backend_start === input.backendStart &&
    row.application_name === P2_PROFILED_CURRENT_LOCK_APPLICATION && row.usename === target.user &&
    row.role_oid === input.migrationRoleOid && row.datname === target.database && row.database_oid === input.databaseOid &&
    row.locks === 2 && (independent ? row.current_pid !== row.pid && row.read_only === "on" : row.current_pid === row.pid));
}

// The migration owner holds the physical lock. This nonce stays on that
// backend and makes the independent observer's result specific to this probe.
export async function createP2FrontendReplacementProbe(input, client, verifySession) {
  validate(input, false);
  demand(typeof verifySession === "function" && client instanceof Client);
  const selected = structuredClone(input);
  verifiedTransport(client, selected.job.target);
  await verifySession();
  const marker = randomBytes(32).toString("hex");
  const { rows: [identity] } = await client.query(`SELECT pid, ${backendStart} AS backend_start
    FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
  const probe = { ...selected, marker, backendPid: identity?.pid, backendStart: identity?.backend_start };
  demand(pid(probe.backendPid) && start(probe.backendStart));
  const { rows: [result] } = await client.query(`SELECT CASE WHEN pg_catalog.hashtext($1)<>pg_catalog.hashtext($2)
    THEN pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) ELSE false END AS locked`, [marker, FRONTEND_MIGRATION_LOCK]);
  demand(result?.locked === true);
  try {
    await verifyLockedBackend(client, probe, false);
    await verifySession();
    return probe;
  } catch (error) {
    try { await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", [marker]); }
    catch { /* A disconnected backend releases its session locks. */ }
    throw error;
  }
}

export async function observeP2FrontendReplacement(input, { getUrl }) {
  validateP2FrontendReplacementProbe(input);
  demand(typeof getUrl === "function");
  const probe = structuredClone(input), options = frontendConnectionOptions(await getUrl(), probe.job.target);
  const client = new Client({ ...options, application_name: "lash-her-frontend-replacement-observer",
    options: "-c search_path=pg_catalog,public -c default_transaction_read_only=on",
    statement_timeout: 5000, query_timeout: 7000, lock_timeout: 2000 });
  let lost = false;
  client.on("error", () => { lost = true; });
  try {
    await client.connect();
    await verifyLockedBackend(client, probe, true);
  } finally {
    await client.end();
  }
  demand(!lost);
  return { version: 1, qualificationTargetProfile: profile, operation,
    status: "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", environment: "staging",
    releaseId: probe.job.releaseId, sourceCommit: probe.job.sourceCommit, targetSha256: probe.targetSha256,
    databaseOid: probe.databaseOid, migrationRoleOid: probe.migrationRoleOid, marker: probe.marker,
    backendPid: probe.backendPid, backendStart: probe.backendStart,
    readOnlyVerified: true, authorityIssued: false, trafficAuthorized: false };
}

export async function runP2FrontendReplacementProbeCli(verifySource) {
  const raw = Buffer.alloc(2_000_001);
  let length = 0;
  while (length < raw.length) {
    const count = readSync(0, raw, length, raw.length - length, null);
    if (!count) break;
    length += count;
  }
  demand(length > 0 && length <= 2_000_000);
  const input = decodeQualificationTargetJson(raw.subarray(0, length), "carrier");
  const result = await observeP2FrontendReplacement(input, {
    getUrl() {
      verifySource?.(input.job.sourceCommit);
      return process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL;
    },
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    demand(process.argv.length === 2);
    await runP2FrontendReplacementProbeCli();
  } catch {
    console.error(refusal);
    process.exitCode = 1;
  }
}
