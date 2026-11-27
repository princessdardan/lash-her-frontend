// Operator-only rehearsal on the disconnected PostgreSQL copy. Even a successful
// run rolls back. Use explicit journal IDs because nextval is not transactional.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { assertAppliedMigrationLineage } from "../../src/lib/private-db/migration-lineage.ts";

const database = "lash_her_p600_frontend";
const migrationRole = "lash_her_p600_frontend_migration";
const runtimeRole = "lash_her_frontend_staging_runtime_p2";
const originalTarget = "99903a525aeaa8c635bfb869025f528babee1990074b612252c5ffbcfdd3074c";
const originalCatalog = "5a3d2ad3896a00e3c13de4a9efb53d40b0793bd4a2ed96249be9edbd273adada";
const finalBaseline = "566e905ddfbca78a91fc47ae14acb11918b0b38ecf94d9a7e0037757a10ef41a";
const sqlDigest = "52777ab08b9fba9ae2bcd087117c114340908b90a15abc9125629f17a0ac9b70";
const selectedTarget = frontendAdmissionTargetSha256("staging", {
  host: "p600-frontend-db.lashher.com", port: 5432, database, user: migrationRole, serverMajor: 18,
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function requireState(ok, reason) {
  if (!ok) throw new Error("P600_REHEARSAL_" + reason);
}

export function checkCopyIdentity(row) {
  requireState(row?.cluster === "7712934692662906902" && row.db === database && row.version === "180006" &&
    row.login === "postgres" && row.local === true && row.listen === "" && row.other_logins === 0 &&
    row.other_sessions === 0 && row.prepared === 0 && row.recovery === false, "COPY_IDENTITY_REFUSED");
}

async function observeIdentity(client) {
  const [identity] = (await client.query(`SELECT system_identifier::text AS cluster,current_database() AS db,
    current_setting('server_version_num') AS version,session_user AS login,inet_client_addr() IS NULL AS local,
    current_setting('listen_addresses') AS listen,pg_is_in_recovery() AS recovery,
    (SELECT count(*)::int FROM pg_roles WHERE rolcanlogin AND rolname<>'postgres') AS other_logins,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
       AND backend_type='client backend') AS other_sessions,
    (SELECT count(*)::int FROM pg_prepared_xacts) AS prepared FROM pg_control_system()`)).rows;
  checkCopyIdentity(identity);
  return identity;
}

async function guardedState(client, artifact) {
  const identity = await observeIdentity(client);
  const journal = (await client.query("SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
  requireState(journal.length === 83 && journal.every((row, i) => row.id === i + 1) &&
    assertAppliedMigrationLineage(artifact.expected, journal) === artifact.migrations[82].folderMillis, "PREFIX_REFUSED");
  const sequence = (await client.query("SELECT last_value::text,is_called FROM drizzle.__drizzle_migrations_id_seq")).rows;
  requireState(isDeepStrictEqual(sequence, [{last_value: "83", is_called: true}]), "SEQUENCE_REFUSED");
  const catalog = await readMigrationCatalog(client);
  requireState(hash(JSON.stringify(catalog)) === originalCatalog, "CATALOG_REFUSED");
  const [control] = (await client.query(`SELECT environment,target_sha256,epoch::text,new_work,recovery
    FROM frontend_admission.control WHERE singleton FOR UPDATE NOWAIT`)).rows;
  requireState(isDeepStrictEqual(control, { environment: "staging", target_sha256: originalTarget, epoch: "5",
    new_work: false, recovery: false }), "ADMISSION_REFUSED");
  const [registry] = (await client.query(`SELECT string_agg(concat_ws(':',producer_sha256,source_sha,database_role::text,enabled::text),
    chr(10) ORDER BY producer_sha256) AS entries FROM frontend_admission.producers`)).rows;
  requireState(hash(registry.entries ?? "") === "f63647f3986eecc4c45389dc4d5fcc8d8b16d8bd9b79dba6ec71365cc1cfa9fb", "REGISTRY_REFUSED");
  const [ledger] = (await client.query(`SELECT count(*)::int AS entries,count(*) FILTER (WHERE state<>'completed')::int AS pending,
    sha256(convert_to(coalesce(string_agg(to_jsonb(o)::text,chr(10) ORDER BY id),''),'UTF8')) AS digest
    FROM frontend_admission.operations o`)).rows;
  requireState(ledger.pending === 0, "DRAIN_REFUSED");
  return { ledger, identity };
}

async function lockCopy(client) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SET LOCAL search_path=public");
  await observeIdentity(client);
  const { rows } = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held", [FRONTEND_MIGRATION_LOCK]);
  requireState(rows[0]?.held, "LOCK_REFUSED");
  await client.query("LOCK TABLE frontend_admission.control, frontend_admission.producers, frontend_admission.operations, drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE NOWAIT");
}

export async function rehearseDisconnectedCopy(commit) {
  requireState(/^[a-f0-9]{40}$/u.test(commit) && !/^0+$/u.test(commit), "SOURCE_REQUIRED");
  const artifact = frontendMigrationArtifact();
  requireState(artifact.sqlArtifactSha256 === sqlDigest && artifact.migrations.length === 87, "ARTIFACT_REFUSED");
  const client = new Client({host: "/var/run/postgresql", port: 5432, user: "postgres", database, ssl: false,
    application_name: "p600-disconnected-rehearsal", connectionTimeoutMillis: 5000, statement_timeout: 20000});
  await client.connect();
  try {
    await lockCopy(client);
    const before = await guardedState(client, artifact);
    await client.query("SET LOCAL ROLE lash_her_p600_frontend_migration");
    for (const [index, migration] of artifact.migrations.slice(83).entries()) {
      for (const statement of migration.sql) await client.query(statement);
      await client.query("INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES ($1,$2,$3)",
        [84 + index, migration.hash, migration.folderMillis]);
    }
    const finalJournal = (await client.query("SELECT hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
    requireState(finalJournal.length === 87 && assertAppliedMigrationLineage(artifact.expected, finalJournal) === artifact.migrations[86].folderMillis, "FINAL_JOURNAL_REFUSED");
    const catalog = await readMigrationCatalog(client);
    requireState(hash(JSON.stringify({version: 1, serverMajor: 18, sqlArtifactSha256: sqlDigest, catalog})) === finalBaseline, "FINAL_SCHEMA_REFUSED");
    await client.query("RESET ROLE");
    await client.query("SET LOCAL ROLE lash_her_frontend_staging_admission_owner_p2");
    // Retain original producer and completed-operation identities for audit.
    // The closed target gets a distinct, physically resolved successor record.
    await client.query("UPDATE frontend_admission.producers SET enabled=false WHERE enabled");
    const producer = hash(["lash-her:p600:runtime:v1", commit, selectedTarget].join("\n"));
    await client.query(`INSERT INTO frontend_admission.producers(producer_sha256,source_sha,database_role,enabled)
      VALUES ($1,$2,$3::regrole::oid,false)`, [producer, commit, runtimeRole]);
    await client.query("UPDATE frontend_admission.control SET target_sha256=$1,epoch=epoch+1 WHERE singleton", [selectedTarget]);
    const observed = (await client.query(`SELECT c.epoch::text,c.new_work,c.recovery,p.enabled,
      p.database_role=$1::regrole::oid AS role_matches FROM frontend_admission.control c JOIN
      frontend_admission.producers p ON p.producer_sha256=$2 WHERE c.singleton AND c.target_sha256=$3 AND p.source_sha=$4`,
      [runtimeRole, producer, selectedTarget, commit])).rows;
    requireState(isDeepStrictEqual(observed,[{epoch:"6",new_work:false,recovery:false,enabled:false,role_matches:true}]), "ROLE_BINDING_REFUSED");
    await client.query("ROLLBACK");
    await lockCopy(client);
    const restored = await guardedState(client, artifact);
    requireState(isDeepStrictEqual(before, restored), "ROLLBACK_REFUSED");
    await client.query("ROLLBACK");
    return {scope: "disconnected-copy-rollback", sourceCommit: commit, cluster: before.identity.cluster,
      baseline: finalBaseline, appliedInTransaction: 4, journalInsideTransaction: 87, journalAfterRollback: 83,
      completedOperations: before.ledger.entries, registryRestored: true, successorRoleResolved: true, trafficAuthorized: false};
  } finally {
    // Closing the dedicated connection aborts any open transaction on failure.
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await rehearseDisconnectedCopy(process.argv[2]))); }
  catch (error) {
    console.error(/^P600_REHEARSAL_[A-Z_]+$/u.test(error.message) ? error.message : "P600_REHEARSAL_FAILED");
    process.exitCode = 1;
  }
}
