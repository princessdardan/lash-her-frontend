import { Client } from "pg";
import { pathToFileURL } from "node:url";
import { FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";

const host = "ep-lingering-meadow-bc80gyj9.c-16.us-east-1.aws.neon.tech";
const owner = "neondb_owner";
const sourceName = "neondb";
const runtimeRole = "lash_her_frontend_staging_runtime_p2";

function insist(value, reason) {
  if (!value) throw new Error("P600_SOURCE_" + reason);
}

export function sourceConnection(uri, database) {
  try {
    const url = new URL(uri);
    const keys = [...url.searchParams.keys()];
    insist(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === host &&
      (!url.port || url.port === "5432") && url.username === owner && url.pathname === "/" + sourceName &&
      !!url.password && !url.hash && [sourceName, "postgres"].includes(database) &&
      keys.length === 2 && ["require", "verify-full"].includes(url.searchParams.get("sslmode")) &&
      url.searchParams.get("channel_binding") === "require", "CONNECTION_REFUSED");
    return { host, port: 5432, database, user: owner, password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true, servername: host }, enableChannelBinding: true,
      application_name: "p600-source-fence-preflight", connectionTimeoutMillis: 5000,
      statement_timeout: 5000, lock_timeout: 350, idle_in_transaction_session_timeout: 15000,
      options: "-c default_transaction_read_only=on" };
  } catch { throw new Error("P600_SOURCE_CONNECTION_REFUSED"); }
}

async function connect(uri, name) {
  const client = new Client(sourceConnection(uri, name));
  client.on("error", () => {}); // The next query fails and disconnect rolls back the rehearsal.
  try {
    await client.connect();
    const [row] = (await client.query("SELECT current_database() AS db,session_user AS login,current_setting('server_version_num')::int/10000 AS major")).rows;
    insist(client.connection.stream.authorized === true && row?.db === name && row.login === owner && row.major === 18, "SESSION_REFUSED");
    return client;
  } catch (error) { await client.end(); throw error; }
}

async function allowsConnections(client) {
  const rows = (await client.query(`SELECT datallowconn,oid::text AS oid,pg_get_userbyid(datdba) AS owner
    FROM pg_database WHERE datname=$1`, [sourceName])).rows;
  insist(rows.length === 1 && rows[0].oid === "16397" && rows[0].owner === owner, "DATABASE_REFUSED");
  return rows[0].datallowconn;
}

// The maintenance transaction is deliberately never committed. The physical
// source session remains open throughout to witness the externally visible flag.
export async function rehearseSourceFence(uri) {
  const source = await connect(uri, sourceName);
  let maintenance;
  try {
    maintenance = await connect(uri, "postgres");
    const [lock] = (await source.query("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [FRONTEND_MIGRATION_LOCK])).rows;
    insist(lock.held, "LOCK_BUSY");
    const [state] = (await source.query(`SELECT epoch::text,new_work,recovery,
      (SELECT count(*)::int FROM frontend_admission.operations WHERE state<>'completed') AS pending
      FROM frontend_admission.control WHERE singleton AND environment='staging' AND target_sha256=$1`,
      ["99903a525aeaa8c635bfb869025f528babee1990074b612252c5ffbcfdd3074c"])).rows;
    insist(state && !state.new_work && !state.recovery && state.pending === 0, "ADMISSION_OPEN");
    const [rights] = (await maintenance.query(`SELECT pg_has_role(current_user,'pg_signal_backend','USAGE') AS signal,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=$1::regrole AND member=current_user::regrole AND admin_option) AS runtime_admin`,
      [runtimeRole])).rows;
    insist(rights.signal && rights.runtime_admin && await allowsConnections(maintenance), "RESCUE_REFUSED");
    await maintenance.query("BEGIN READ WRITE");
    try {
      await maintenance.query("ALTER DATABASE neondb ALLOW_CONNECTIONS false");
      insist(await allowsConnections(maintenance) === false && await allowsConnections(source) === true, "FENCE_VISIBILITY_REFUSED");
    } finally { await maintenance.query("ROLLBACK"); }
    insist(await allowsConnections(maintenance) && await allowsConnections(source), "ROLLBACK_REFUSED");
    // Reconnect independently, exercising the existing URI and TLS negotiation.
    const fresh = await connect(uri, sourceName);
    await fresh.end();
    return { scope: "staging-source-fence-rollback", source: sourceName, maintenance: "postgres",
      epoch: state.epoch, pending: state.pending, databaseOwnerVerified: true, externalAdmissionUnchanged: true,
      rollbackVerified: true, freshSourceConnectionVerified: true, liveWritersFenced: false };
  } finally {
    try { if (maintenance) await maintenance.end(); } finally { await source.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const uri = process.env.P600_STAGING_SOURCE;
    delete process.env.P600_STAGING_SOURCE;
    console.log(JSON.stringify(await rehearseSourceFence(uri)));
  } catch (error) {
    console.error(/^P600_SOURCE_[A-Z_]+$/u.test(error.message) ? error.message : "P600_SOURCE_PREFLIGHT_FAILED");
    process.exitCode = 1;
  }
}
