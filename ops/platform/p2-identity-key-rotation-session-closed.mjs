// Fixed post-session observer for the config-only identity rotation. It proves
// the frontend migration backend and both advisory locks are gone before the
// host-only terminal commit. It never runs SQL, changes roles, or opens traffic.
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";

const demand = value => { if (!value) throw new Error("P2_IDENTITY_ROTATION_SESSION_CLOSE_REFUSED"); };
const NAME = /^[a-z][a-z0-9_]{0,62}$/u;

export async function observeP2IdentityRotationFrontendClosed(input, dependencies = {}) {
  const probe = input?.probe, target = probe?.job?.target, owner = probe?.owner;
  demand(input?.version === 1 && input.operation === "verify-closed" && probe?.version === 1
    && typeof input.actionId === "string" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(input.actionId)
    && probe.receipt?.status === "P2_RECOVERY_DATABASE_CURRENT" && probe.receipt.trafficAuthorized === false
    && /^[a-f0-9]{64}$/u.test(probe.targetSha256 ?? "")
    && typeof probe.marker === "string" && /^[a-f0-9]{64}$/u.test(probe.marker)
    && Number.isSafeInteger(probe.backendPid) && probe.backendPid > 0 && typeof probe.backendStart === "string"
    && typeof probe.applicationName === "string" && NAME.test(target?.user ?? "") && NAME.test(target?.database ?? "")
    && Number.isInteger(target?.port) && Number.isInteger(target?.serverMajor)
    && NAME.test(owner?.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(owner?.oid ?? "")
    && typeof dependencies.getUrl === "function");
  const createClient = dependencies.createClient ?? (options => new Client(options));
  const connection = frontendConnectionOptions(await dependencies.getUrl(), target);
  const client = createClient({ ...connection, application_name: "lash-her-p2-identity-rotation-close",
    options: [connection.options, "-c search_path=pg_catalog,public"].filter(Boolean).join(" ") });
  let lost = false; client.on("error", () => { lost = true; });
  try {
    await client.connect(); demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    const identity = (await client.query("SELECT current_user AS username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(identity?.username === target.user && identity.database === target.database && identity.major === target.serverMajor);
    const activity = (await client.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE pid=$1 AND backend_start::text=$2 AND application_name=$3 AND usename=$4 AND datname=$5`,
    [probe.backendPid, probe.backendStart, probe.applicationName, target.user, target.database])).rows[0];
    demand(activity?.count === 0);
    for (const key of [FRONTEND_MIGRATION_LOCK, probe.marker]) {
      const stale = (await client.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid=$1
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=((hashtext($2)::bigint>>32)&4294967295)::oid AND objid=(hashtext($2)::bigint&4294967295)::oid
        AND objsubid=1 AND mode='ExclusiveLock' AND granted`, [probe.backendPid, key])).rows[0];
      demand(stale?.count === 0);
      const acquired = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key])).rows[0];
      demand(acquired?.locked === true);
      const released = (await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS unlocked", [key])).rows[0];
      demand(released?.unlocked === true);
    }
    await client.query("BEGIN READ ONLY");
    try {
      const actualOwner = (await client.query("SELECT oid::text FROM pg_roles WHERE rolname=$1 AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper", [owner.name])).rows;
      demand(actualOwner.length === 1 && actualOwner[0].oid === owner.oid);
      await client.query(`SET LOCAL ROLE "${owner.name}"`);
      const control = (await client.query("SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton")).rows;
      const counts = (await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
      demand(control.length === 1 && control[0].environment === "staging" && control[0].target_sha256 === probe.targetSha256
        && control[0].new_work === false && control[0].recovery === false && counts?.active === 0 && counts.uncertain === 0);
      await client.query("ROLLBACK");
      demand(!lost);
      return { version: 1, status: "P2_IDENTITY_ROTATION_FRONTEND_SESSION_CLOSED", environment: "staging",
        actionId: input.actionId, sourceCommit: probe.job.sourceCommit, candidateSha256: probe.receipt.candidateSha256,
        backendPid: probe.backendPid, backendStart: probe.backendStart, admissionEpoch: control[0].epoch,
        backendAbsent: true, migrationLockReleased: true, nonceLockReleased: true,
        newWork: false, recovery: false, active: 0, uncertain: 0, sqlExecuted: false,
        rolesPrepared: false, loginChanged: false, trafficAuthorized: false };
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  } finally { await client.end(); demand(!lost); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks); demand(raw.length > 0 && raw.length <= 1_000_000);
    console.log(JSON.stringify(await observeP2IdentityRotationFrontendClosed(JSON.parse(raw),
      { getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL })));
  } catch { console.error("P2_IDENTITY_ROTATION_SESSION_CLOSE_REFUSED"); process.exitCode = 1; }
}
