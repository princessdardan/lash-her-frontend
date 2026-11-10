import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-admission-bootstrap.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { validateP2FrontendReplacementProbe, verifyP2FrontendReplacementObservation,
  withP2FrontendReplacementReadOnlyProbe } from "./p2-frontend-replacement-probe.mjs";
import { verifyReplacementRuntimeGrants } from "./p2-recovery-current-probe.mjs";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";

const refusal = "P2_FRONTEND_REPLACEMENT_WRITTEN_OBSERVATION_REFUSED";
const demand = condition => { if (!condition) throw new Error(refusal); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, expected) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === expected.length && expected.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, "value");
  });
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const compareLogins = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function replacementReceiptBytes(value, maximum) {
  demand(typeof value === "string" && value.length > 0 && value.length <= 4 * Math.ceil(maximum / 3));
  const bytes = Buffer.from(value, "base64");
  demand(bytes.length > 0 && bytes.length <= maximum && bytes.at(-1) === 10 && bytes.toString("base64") === value);
  return bytes;
}

function prepare(packet) {
  demand(exact(packet, ["probe", "physicalObservation", "databaseReceipt", "continuationStarted", "owner", "runtime", "producerSha256", "administrativeLogins"]));
  const artifact = validateP2FrontendReplacementProbe(packet.probe);
  const { probe, owner, runtime, producerSha256, administrativeLogins } = structuredClone(packet), { job } = probe;
  for (const [kind, role] of [["owner", owner], ["runtime", runtime]]) {
    demand(exact(role, ["name", "oid"]) && role.name === FRONTEND_PREPARATION_ROLES[kind] && oid(role.oid));
  }
  demand(runtime.name === job.target.runtimeRole && new Set([owner.oid, runtime.oid, probe.migrationRoleOid]).size === 3 && digest(producerSha256));
  demand(Array.isArray(administrativeLogins) && administrativeLogins.length <= 32 && administrativeLogins.every(login =>
    exact(login, ["name", "oid"]) && /^[a-z][a-z0-9_]{0,62}$/u.test(login.name) && oid(login.oid) &&
    ![job.target.user, owner.name, runtime.name, probe.predecessorTarget.runtimeRole].includes(login.name)) &&
    new Set(administrativeLogins.map(login => login.name)).size === administrativeLogins.length &&
    new Set([owner.oid, runtime.oid, probe.migrationRoleOid, ...administrativeLogins.map(login => login.oid)]).size === administrativeLogins.length + 3);

  const physical = replacementReceiptBytes(packet.physicalObservation, 8192);
  const database = replacementReceiptBytes(packet.databaseReceipt, 65_536);
  const started = replacementReceiptBytes(packet.continuationStarted, 8192);
  const observation = verifyP2FrontendReplacementObservation(probe, physical);
  const target = Object.fromEntries(["host", "port", "database", "user", "serverMajor"].map(key => [key, job.target[key]]));
  const base = {
    ...Object.fromEntries(["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "contractPhase",
      "phase2ContractManifestSha256", "migrationImageDigest", "sqlArtifactSha256", "schemaBaselineSha256", "contractManifestSha256",
      "operator", "recoveryRef"].map(key => [key, job[key]])),
    service: "frontend", migrationMode: "apply-forward", target, trafficAuthorized: false,
  };
  const journal = artifact.migrations.map(({ hash, folderMillis }) => ({ hash, created_at: String(folderMillis) }));
  const applied = artifact.migrations.map(({ tag, hash }) => ({ tag, hash }));
  demand(isDeepStrictEqual(decodeQualificationTargetJson(database, "carrier"), {
    ...base, status: "DATABASE_VERIFIED", before: [], after: journal, applied,
    schemaVerified: true, runtimeRoleVerified: true, readOnlyVerified: false,
  }));
  demand(isDeepStrictEqual(decodeQualificationTargetJson(started, "carrier"), {
    ...base, status: "FRONTEND_CONTINUATION_STARTED", databaseVerified: true,
  }));
  return { probe, owner, runtime, producerSha256, administrativeLogins: administrativeLogins.sort(compareLogins),
    observation, journal, physical, database, started };
}

export async function verifyReplacementLoginBoundary(client, {
  databaseOid, migrationRoleOid, migrationRole, predecessorRuntimeRole, runtime, administrativeLogins,
}) {
  const access = (await client.query(`SELECT
    pg_catalog.has_database_privilege('public',$1::oid,'CONNECT,TEMP,CREATE') AS public_database_access,
    pg_catalog.has_schema_privilege('public','public','CREATE') AS public_schema_create,
    pg_catalog.has_schema_privilege('public','frontend_admission','USAGE,CREATE') AS public_admission_access,
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$2) AS predecessor_role_present,
    pg_catalog.has_schema_privilege($3::oid,'public','USAGE') AS runtime_public_usage,
    pg_catalog.has_database_privilege($3::oid,$1::oid,'TEMP') AS runtime_temporary
    `, [databaseOid, predecessorRuntimeRole, runtime.oid])).rows;
  demand(isDeepStrictEqual(access, [{ public_database_access: false, public_schema_create: false,
    public_admission_access: false, predecessor_role_present: false, runtime_public_usage: true, runtime_temporary: false }]));
  const logins = (await client.query(`SELECT rolname AS name,oid::text AS oid FROM pg_catalog.pg_roles
    WHERE rolcanlogin AND pg_catalog.has_database_privilege(oid,$1::oid,'CONNECT') LIMIT 35`, [databaseOid])).rows;
  const expected = [...administrativeLogins, runtime, { name: migrationRole, oid: migrationRoleOid }];
  demand(isDeepStrictEqual(logins.sort(compareLogins), expected.sort(compareLogins)));
}

export async function verifyReplacementJournalTable(client, migrationRoleOid) {
  const relation = (await client.query(`SELECT c.relkind, c.relpersistence, c.relowner::text AS owner, c.relrowsecurity,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE c.oid IN (i.inhrelid,i.inhparent)) AS inherits
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='drizzle' AND c.relname='__drizzle_migrations'`)).rows;
  demand(isDeepStrictEqual(relation, [{ relkind: "r", relpersistence: "p", owner: migrationRoleOid,
    relrowsecurity: false, inherits: false }]));
}

export async function verifyReplacementAdmissionRelations(client, ownerOid) {
  const tables = (await client.query(`SELECT c.relname FROM pg_catalog.pg_class c
    WHERE c.relnamespace='frontend_admission'::regnamespace AND c.relkind='r' AND c.relpersistence='p'
      AND c.relowner=$1::oid AND NOT c.relrowsecurity AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_inherits i WHERE c.oid IN (i.inhrelid,i.inhparent))
    ORDER BY c.relname`, [ownerOid])).rows;
  demand(isDeepStrictEqual(tables.map(row => row.relname), ["control", "operations", "producers"]));
}

async function verifyWrittenState(client, selected) {
  const { probe, owner, runtime, producerSha256, administrativeLogins, journal } = selected;
  await verifyReplacementJournalTable(client, probe.migrationRoleOid);
  const actual = (await client.query(`SELECT hash,created_at::text FROM drizzle.__drizzle_migrations
    ORDER BY created_at::bigint ASC NULLS FIRST,id ASC LIMIT $1`, [journal.length + 1])).rows;
  demand(isDeepStrictEqual(actual, journal) && isDeepStrictEqual(await readMigrationCatalog(client), probe.baseline.catalog));
  demand(isDeepStrictEqual(await verifyReplacementRuntimeGrants(client, probe.job.target, owner), runtime));
  await verifyReplacementLoginBoundary(client, { databaseOid: probe.databaseOid, migrationRoleOid: probe.migrationRoleOid,
    migrationRole: probe.job.target.user, predecessorRuntimeRole: probe.predecessorTarget.runtimeRole, runtime, administrativeLogins });
  const ownership = (await client.query(`SELECT r.oid::text AS owner FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_namespace n ON n.nspowner=r.oid
    WHERE n.nspname='frontend_admission' AND r.rolname=$1 AND NOT (
      r.rolcanlogin OR r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND r.rolconfig IS NULL AND r.rolvaliduntil IS NULL AND r.rolconnlimit=-1`, [owner.name])).rows;
  demand(isDeepStrictEqual(ownership, [{ owner: owner.oid }]));
  await verifyReplacementAdmissionRelations(client, owner.oid);
  await client.query(`SET LOCAL ROLE "${owner.name}"`);
  const control = (await client.query("SELECT singleton,environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control LIMIT 2")).rows;
  demand(isDeepStrictEqual(control, [{ singleton: true, environment: "staging", target_sha256: probe.targetSha256,
    epoch: "1", new_work: false, recovery: false }]));
  const producers = (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid,enabled FROM frontend_admission.producers LIMIT 2")).rows;
  demand(isDeepStrictEqual(producers, [{ producer_sha256: producerSha256, source_sha: probe.job.sourceCommit, role_oid: runtime.oid, enabled: true }]));
  demand((await client.query("SELECT 1 FROM frontend_admission.operations LIMIT 1")).rows.length === 0);
  await client.query("RESET ROLE");
}

export function prepareP2FrontendReplacementWrittenReadback(packet) {
  const selected = prepare(packet);
  const { observation, probe, physical, database, started, owner, runtime, producerSha256, administrativeLogins, journal } = selected;
  return { probe, verify: client => verifyWrittenState(client, selected), proof: {
    ...observation, operation: "verify-replacement-written", status: "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED",
    physicalObservationSha256: hash(physical), databaseReceiptSha256: hash(database), continuationStartedSha256: hash(started),
    owner, runtime, producerSha256, administrativeLogins, appliedMigrationCount: journal.length, epoch: "1", newWork: false, recovery: false,
    active: 0, uncertain: 0, schemaVerified: true, runtimeRoleVerified: true, effectiveLoginBoundaryVerified: true,
  } };
}

export async function observeP2FrontendReplacementWritten(packet, { getUrl }) {
  try {
    const { probe, proof, verify } = prepareP2FrontendReplacementWrittenReadback(packet);
    return await withP2FrontendReplacementReadOnlyProbe(probe, getUrl, async client => {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await verify(client);
        return proof;
      } finally {
        await client.query("ROLLBACK");
      }
    });
  } catch {
    throw new Error(refusal);
  }
}

export function readP2FrontendReplacementImagePacket(sourceCommit) {
  const raw = Buffer.alloc(2_000_001);
  let length = 0;
  while (length < raw.length) {
    const count = readSync(0, raw, length, raw.length - length, null);
    if (!count) break;
    length += count;
  }
  demand(length > 0 && length < raw.length);
  const packet = decodeQualificationTargetJson(raw.subarray(0, length), "carrier");
  demand(packet?.probe?.job?.sourceCommit === sourceCommit);
  return packet;
}

export async function runP2FrontendReplacementWrittenCli(sourceCommit) {
  const packet = readP2FrontendReplacementImagePacket(sourceCommit);
  const observation = await observeP2FrontendReplacementWritten(packet, {
    getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
  });
  console.log(JSON.stringify(observation));
}
