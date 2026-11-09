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

function originalBytes(value, maximum) {
  demand(typeof value === "string" && value.length > 0 && value.length <= 4 * Math.ceil(maximum / 3));
  const bytes = Buffer.from(value, "base64");
  demand(bytes.length > 0 && bytes.length <= maximum && bytes.at(-1) === 10 && bytes.toString("base64") === value);
  return bytes;
}

function prepare(packet) {
  demand(exact(packet, ["probe", "physicalObservation", "databaseReceipt", "continuationStarted", "owner", "runtime", "producerSha256"]));
  const artifact = validateP2FrontendReplacementProbe(packet.probe);
  const { probe, owner, runtime, producerSha256 } = structuredClone(packet), { job } = probe;
  for (const [kind, role] of [["owner", owner], ["runtime", runtime]]) {
    demand(exact(role, ["name", "oid"]) && role.name === FRONTEND_PREPARATION_ROLES[kind] && oid(role.oid));
  }
  demand(runtime.name === job.target.runtimeRole && new Set([owner.oid, runtime.oid, probe.migrationRoleOid]).size === 3 && digest(producerSha256));

  const physical = originalBytes(packet.physicalObservation, 8192);
  const database = originalBytes(packet.databaseReceipt, 65_536);
  const started = originalBytes(packet.continuationStarted, 8192);
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
  return { probe, owner, runtime, producerSha256, observation, journal, physical, database, started };
}

async function verifyWrittenState(client, selected) {
  const { probe, owner, runtime, producerSha256, journal } = selected;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const relation = (await client.query(`SELECT c.relkind, c.relpersistence, c.relowner::text AS owner, c.relrowsecurity,
      EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE c.oid IN (i.inhrelid,i.inhparent)) AS inherits
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='drizzle' AND c.relname='__drizzle_migrations'`)).rows;
    demand(isDeepStrictEqual(relation, [{ relkind: "r", relpersistence: "p", owner: probe.migrationRoleOid,
      relrowsecurity: false, inherits: false }]));
    const actual = (await client.query(`SELECT hash,created_at::text FROM drizzle.__drizzle_migrations
      ORDER BY created_at::bigint ASC NULLS FIRST,id ASC LIMIT $1`, [journal.length + 1])).rows;
    demand(isDeepStrictEqual(actual, journal) && isDeepStrictEqual(await readMigrationCatalog(client), probe.baseline.catalog));
    demand(isDeepStrictEqual(await verifyReplacementRuntimeGrants(client, probe.job.target, owner), runtime));
    const ownership = (await client.query(`SELECT r.oid::text AS owner FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_namespace n ON n.nspowner=r.oid
      WHERE n.nspname='frontend_admission' AND r.rolname=$1 AND NOT (
        r.rolcanlogin OR r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
        AND r.rolconfig IS NULL AND r.rolvaliduntil IS NULL AND r.rolconnlimit=-1`, [owner.name])).rows;
    demand(isDeepStrictEqual(ownership, [{ owner: owner.oid }]));
    const tables = (await client.query(`SELECT c.relname FROM pg_catalog.pg_class c
      WHERE c.relnamespace='frontend_admission'::regnamespace AND c.relkind='r' AND c.relpersistence='p'
        AND c.relowner=$1::oid AND NOT c.relrowsecurity AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_inherits i WHERE c.oid IN (i.inhrelid,i.inhparent))
      ORDER BY c.relname`, [owner.oid])).rows;
    demand(isDeepStrictEqual(tables.map(row => row.relname), ["control", "operations", "producers"]));
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const control = (await client.query("SELECT singleton,environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control LIMIT 2")).rows;
    demand(isDeepStrictEqual(control, [{ singleton: true, environment: "staging", target_sha256: probe.targetSha256,
      epoch: "1", new_work: false, recovery: false }]));
    const producers = (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid,enabled FROM frontend_admission.producers LIMIT 2")).rows;
    demand(isDeepStrictEqual(producers, [{ producer_sha256: producerSha256, source_sha: probe.job.sourceCommit, role_oid: runtime.oid, enabled: true }]));
    demand((await client.query("SELECT 1 FROM frontend_admission.operations LIMIT 1")).rows.length === 0);
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function observeP2FrontendReplacementWritten(packet, { getUrl }) {
  try {
    const selected = prepare(packet);
    const { observation, probe, physical, database, started, owner, runtime, producerSha256, journal } = selected;
    return await withP2FrontendReplacementReadOnlyProbe(probe, getUrl, async client => {
      await verifyWrittenState(client, selected);
      return { ...observation, operation: "verify-replacement-written", status: "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED",
        physicalObservationSha256: hash(physical), databaseReceiptSha256: hash(database), continuationStartedSha256: hash(started),
        owner, runtime, producerSha256, appliedMigrationCount: journal.length, epoch: "1", newWork: false, recovery: false,
        active: 0, uncertain: 0, schemaVerified: true, runtimeRoleVerified: true };
    });
  } catch {
    throw new Error(refusal);
  }
}

export async function runP2FrontendReplacementWrittenCli(sourceCommit) {
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
  const observation = await observeP2FrontendReplacementWritten(packet, {
    getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
  });
  console.log(JSON.stringify(observation));
}
