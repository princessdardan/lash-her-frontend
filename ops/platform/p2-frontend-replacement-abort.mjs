import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { Client } from "pg";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { createP2FrontendReplacementProbe, validateP2FrontendReplacementProbe, verifyP2FrontendReplacementObservation,
  verifyP2FrontendReplacementSession } from "./p2-frontend-replacement-probe.mjs";
import { P2_PROFILED_CURRENT_LOCK_APPLICATION } from "./p2-profiled-current-probe.mjs";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";

const refusal = "P2_FRONTEND_REPLACEMENT_ABORT_REFUSED";
const demand = value => { if (!value) throw new Error(refusal); };
const hash = value => createHash("sha256").update(value).digest("hex");
const originalBackend = `a.pid=$1 AND a.pid<>pg_catalog.pg_backend_pid()
  AND pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=$2
  AND a.usename=$3 AND a.datname=$4 AND a.usesysid=$5::oid AND a.datid=$6::oid
  AND a.application_name=$7 AND a.backend_type='client backend'`;
const matchingLocks = `FROM pg_catalog.pg_locks l
  JOIN (SELECT pg_catalog.hashtext($8)::bigint AS key UNION SELECT pg_catalog.hashtext($9)::bigint) required
    ON l.classid=((required.key>>32)&4294967295)::oid AND l.objid=(required.key&4294967295)::oid
  WHERE l.locktype='advisory' AND l.database=$6::oid AND l.objsubid=1`;
const observerLock = `l.pid=pg_catalog.pg_backend_pid() AND required.key=pg_catalog.hashtext($8)::bigint
  AND l.mode='ExclusiveLock' AND l.granted`;

async function readBoundary(client, values, serverMajor) {
  const { rows: [row] } = await client.query(`SELECT
    current_user=$3 AND session_user=$3 AND pg_catalog.current_database()=$4
      AND pg_catalog.current_setting('server_version_num')::int/10000=$10::int
      AND pg_catalog.current_setting('transaction_read_only')='on'
      AND pg_catalog.hashtext($8)<>pg_catalog.hashtext($9)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=$5::oid AND r.rolname=session_user)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.oid=$6::oid AND d.datname=pg_catalog.current_database()) AS target_verified,
    EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=$1) AS pid_present,
    EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE ${originalBackend}) AS exact_backend,
    EXISTS(SELECT 1 ${matchingLocks} AND l.pid=$1) AS original_lock_present,
    EXISTS(SELECT 1 ${matchingLocks} AND ${observerLock}) AS observer_lock_held,
    EXISTS(SELECT 1 ${matchingLocks} AND l.pid IS DISTINCT FROM $1 AND (${observerLock}) IS NOT TRUE) AS conflicting_lock,
    EXISTS(SELECT 1 FROM pg_catalog.pg_prepared_xacts p WHERE p.database=pg_catalog.current_database()) AS prepared_transaction`,
  [...values, serverMajor]);
  demand(row?.target_verified === true && row.prepared_transaction === false &&
    row.conflicting_lock === false && row.pid_present === row.exact_backend);
  return row;
}

async function withReadOnlyReplacementSession(probe, getUrl, applicationName, work, signal) {
  demand(typeof getUrl === "function");
  demand(!signal?.aborted);
  const target = probe.job.target;
  const options = frontendConnectionOptions(await getUrl(), target);
  const client = new Client({ ...options, application_name: applicationName,
    options: "-c search_path=pg_catalog,public -c default_transaction_read_only=on -c row_security=off",
    statement_timeout: 7000, query_timeout: 8000, lock_timeout: 2000 });
  let lost = false;
  const abort = () => { lost = true; client.connection?.stream?.destroy(); };
  client.on("error", () => { lost = true; });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    demand(!signal?.aborted);
    await client.connect();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    const values = [probe.backendPid, probe.backendStart, target.user, target.database, probe.migrationRoleOid,
      probe.databaseOid, P2_PROFILED_CURRENT_LOCK_APPLICATION, FRONTEND_MIGRATION_LOCK, probe.marker];
    const boundary = async () => {
      const result = await readBoundary(client, values, target.serverMajor);
      demand(!lost);
      return result;
    };
    return await work(client, values, boundary);
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.end();
    demand(!lost);
  }
}

async function readAfterOriginalClosure(client, boundary, read, continueHeld) {
  const requireOriginalAbsent = async observerLockHeld => {
    const actual = await boundary();
    demand(!actual.pid_present && !actual.original_lock_present && actual.observer_lock_held === observerLockHeld);
  };
  await requireOriginalAbsent(false);
  // Hold the canonical lock before taking the journal snapshot so a second
  // coordinated migration cannot complete between the observation checks.
  const { rows: [locked] } = await client.query("SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS acquired",
    [FRONTEND_MIGRATION_LOCK]);
  demand(locked?.acquired === true);
  const recheck = async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await requireOriginalAbsent(true);
      const result = await read(client);
      await client.query("SELECT pg_catalog.pg_stat_clear_snapshot()");
      await requireOriginalAbsent(true);
      return result;
    } finally {
      await client.query("ROLLBACK");
    }
  };
  const result = continueHeld ? await continueHeld(recheck) : await recheck();
  await requireOriginalAbsent(true);
  const { rows: [unlocked] } = await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS released",
    [FRONTEND_MIGRATION_LOCK]);
  demand(unlocked?.released === true);
  await requireOriginalAbsent(false);
  return result;
}

export function withP2FrontendReplacementClosedProbe(probe, getUrl, read) {
  validateP2FrontendReplacementProbe(probe);
  return withReadOnlyReplacementSession(probe, getUrl, "lash-her-frontend-replacement-closed",
    (client, _values, boundary) => readAfterOriginalClosure(client, boundary, read));
}

export function withP2FrontendReplacementRecoveryProbe(original, getUrl, read, work, signal) {
  validateP2FrontendReplacementProbe(original);
  const { backendPid, backendStart, marker, ...selection } = original;
  return withReadOnlyReplacementSession(original, getUrl, P2_PROFILED_CURRENT_LOCK_APPLICATION,
    (client, _values, boundary) => readAfterOriginalClosure(client, boundary, read, async readSnapshot => {
      const fresh = await createP2FrontendReplacementProbe(selection, client, async () => {});
      demand(fresh.backendPid !== backendPid && fresh.backendStart >= backendStart && fresh.marker !== marker);
      const verify = async () => {
        await verifyP2FrontendReplacementSession(client, fresh);
        await readSnapshot();
        await verifyP2FrontendReplacementSession(client, fresh);
      };
      await verify();
      const result = await work({ probe: structuredClone(fresh), verify, databaseClient: client });
      await verify();
      return result;
    }), signal);
}

async function readJournal(client, migrations, migrationRoleOid) {
  const { rows: catalog } = await client.query(`SELECT c.relkind, c.relpersistence, c.relowner::text, c.relrowsecurity,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE c.oid IN (i.inhrelid,i.inhparent)) AS inherits
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='drizzle' AND c.relname='__drizzle_migrations'`);
  if (catalog.length === 0) return { journalPresent: false, appliedPrefix: [] };
  const [relation] = catalog;
  demand(catalog.length === 1 && relation.relkind === "r" && relation.relpersistence === "p" &&
    relation.relowner === migrationRoleOid && relation.relrowsecurity === false && relation.inherits === false);
  const { rows } = await client.query(`SELECT hash, created_at::text
    FROM drizzle.__drizzle_migrations ORDER BY created_at::bigint ASC NULLS FIRST, id ASC LIMIT $1`, [migrations.length + 1]);
  demand(rows.length <= migrations.length);
  const appliedPrefix = migrations.slice(0, rows.length).map(({ tag, hash, folderMillis }, index) => {
    demand(rows[index].created_at === String(folderMillis) && rows[index].hash === hash);
    return { tag, hash, folderMillis };
  });
  return { journalPresent: true, appliedPrefix };
}

// The fixed host guard must authenticate the retained observation bytes under
// its own lock and source custody before invoking this kernel. Matching JSON
// alone cannot prove custody or authorize a release.
export async function abortP2FrontendReplacement(input, retainedPhysicalObservationBytes, { getUrl }) {
  try {
    const artifact = validateP2FrontendReplacementProbe(input);
    const probe = structuredClone(input);
    demand(Buffer.isBuffer(retainedPhysicalObservationBytes) && retainedPhysicalObservationBytes.length <= 8192);
    const raw = Buffer.from(retainedPhysicalObservationBytes);
    const expected = verifyP2FrontendReplacementObservation(probe, raw);
    return await withReadOnlyReplacementSession(probe, getUrl, "lash-her-frontend-replacement-abort",
      async (client, values, boundary) => {
        const before = await boundary();
        let backendTerminated = false;
        if (before.exact_backend) {
          // The prior observation binds both locks. The same backend may have
          // subsequently lost either lock. Recheck its entire tuple in the
          // terminating statement. PostgreSQL accepts only a PID, so this does
          // not eliminate the server's interval between the check and signal.
          const { rows } = await client.query(`SELECT pg_catalog.pg_terminate_backend(a.pid,5000) AS terminated
            FROM pg_catalog.pg_stat_activity a WHERE ${originalBackend}
            AND NOT EXISTS(SELECT 1 ${matchingLocks} AND l.pid IS DISTINCT FROM $1)`, values);
          demand(rows.length === 0 || rows.length === 1 && rows[0].terminated === true);
          backendTerminated = rows.length === 1;
        }
        const journal = await readAfterOriginalClosure(client, boundary,
          observer => readJournal(observer, artifact.migrations, probe.migrationRoleOid));
        return { ...expected, operation: "observe-after-replacement-abort",
          status: "P2_FRONTEND_REPLACEMENT_ABORT_OBSERVED", physicalObservationSha256: hash(raw),
          observedAt: new Date().toISOString(), backendTerminated, originalBackendAbsent: true, originalLocksAbsent: true,
          observationLockReleased: true, ...journal, appliedPrefixSha256: hash(JSON.stringify(journal.appliedPrefix)), replayAuthorized: false };
      });
  } catch {
    throw new Error(refusal);
  }
}

export async function runP2FrontendReplacementAbortCli(sourceCommit) {
  // The abort command accepts only the retained host observation and its
  // original probe. Source custody is checked before resolving the credential.
  const input = Buffer.alloc(2_000_001);
  let length = 0;
  while (length < input.length) {
    const count = readSync(0, input, length, input.length - length, null);
    if (!count) break;
    length += count;
  }
  demand(length > 0 && length < input.length);
  const packet = decodeQualificationTargetJson(input.subarray(0, length), "carrier");
  demand(packet && Object.getPrototypeOf(packet) === Object.prototype && Object.keys(packet).length === 2 &&
    Object.hasOwn(packet, "probe") && Object.hasOwn(packet, "physicalObservation") &&
    packet.probe?.job?.sourceCommit === sourceCommit &&
    typeof packet.physicalObservation === "string" && packet.physicalObservation.length <= 10_924);
  const observation = Buffer.from(packet.physicalObservation, "base64");
  demand(observation.length > 0 && observation.length <= 8192 && observation.toString("base64") === packet.physicalObservation);
  const result = await abortP2FrontendReplacement(packet.probe, observation, {
    getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
  });
  console.log(JSON.stringify(result));
}
