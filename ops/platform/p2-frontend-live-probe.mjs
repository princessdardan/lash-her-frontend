// Fixed image-side observer for the P2 broker. No application SQL or replay.
import { Client } from "pg";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";

const demand = ok => { if (!ok) throw new Error("P2_FRONTEND_LIVE_PROBE_REFUSED"); };
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
export async function observeP2Frontend(input, { getUrl, createClient = options => new Client(options) }) {
  demand(input?.version === 1 && ["observe", "verify-schema", "fence"].includes(input.operation) && sha(input.marker) &&
    Number.isSafeInteger(input.backendPid) && input.backendPid > 0 && typeof input.backendStart === "string" &&
    input.job?.environment === "staging" && input.job.contractPhase === "p2" &&
    input.receipt?.status === "DATABASE_VERIFIED" && input.receipt.sourceCommit === input.job.sourceCommit &&
    input.receipt.sqlArtifactSha256 === input.job.sqlArtifactSha256 && sha(input.targetSha256) &&
    /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(input.owner?.name ?? "") && /^[1-9][0-9]*$/u.test(input.owner.oid));
  const options = frontendConnectionOptions(await getUrl(), input.job.target);
  const client = createClient({ ...options, application_name: "lash-her-p2-lock-observer", statement_timeout: 15000, lock_timeout: 10000 });
  let failure;
  client.on("error", () => { failure = true; });
  try {
    await client.connect(); demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    const me = (await client.query("SELECT current_user,current_database() AS database,current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(me.current_user === input.job.target.user && me.database === input.job.target.database && me.major === input.job.target.serverMajor);
    if (input.operation === "fence") {
      // Automatic closure is allowed on controller loss. It never opens access,
      // retires a login, changes application rows or attempts migration replay.
      const owner = (await client.query("SELECT oid::text FROM pg_roles WHERE rolname=$1 AND NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit", [input.owner.name])).rows;
      demand(owner.length === 1 && owner[0].oid === input.owner.oid);
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE "${input.owner.name}"`);
        const control = (await client.query("SELECT environment,target_sha256 FROM frontend_admission.control WHERE singleton FOR UPDATE")).rows;
        demand(control.length === 1 && control[0].environment === "staging" && control[0].target_sha256 === input.targetSha256);
        await client.query("UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND (new_work OR recovery)");
        const closed = (await client.query("SELECT new_work,recovery FROM frontend_admission.control WHERE singleton")).rows[0];
        demand(closed?.new_work === false && closed.recovery === false); await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      demand(!failure); return { status: "P2_FRONTEND_ADMISSION_CLOSED", targetSha256: input.targetSha256 };
    }
    await client.query("BEGIN READ ONLY");
    try {
      const original = (await client.query("SELECT backend_start::text,usename,datname,application_name FROM pg_stat_activity WHERE pid=$1", [input.backendPid])).rows;
      demand(original.length === 1 && original[0].backend_start === input.backendStart && original[0].usename === input.job.target.user &&
        original[0].datname === input.job.target.database && original[0].application_name === "lash-her-operator-frontend-migration");
      for (const name of [FRONTEND_MIGRATION_LOCK, input.marker]) {
        const held = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=((hashtext($2)::bigint>>32)&4294967295)::oid AND objid=(hashtext($2)::bigint&4294967295)::oid
          AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`, [input.backendPid, name])).rows[0];
        demand(held?.held === true);
      }
      const journal = (await client.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC")).rows;
      demand(isDeepStrictEqual(journal, input.receipt.after));
      if (input.operation === "verify-schema") demand(isDeepStrictEqual(await readMigrationCatalog(client), input.baseline.catalog));
    } finally { await client.query("ROLLBACK"); }
    demand(!failure); return { status: "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED", marker: input.marker, backendPid: input.backendPid, sourceCommit: input.job.sourceCommit };
  } finally { await client.end(); }
}

if (process.argv[1]?.endsWith("p2-frontend-live-probe.mjs")) {
  try {
    const bytes = readFileSync(0); demand(bytes.length > 0 && bytes.length <= 2_000_000);
    console.log(JSON.stringify(await observeP2Frontend(JSON.parse(bytes), { getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL })));
  } catch { console.error("P2_FRONTEND_LIVE_PROBE_REFUSED"); process.exitCode = 1; }
}
