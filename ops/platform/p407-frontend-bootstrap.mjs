import { isDeepStrictEqual } from "node:util";

export const P407_FRONTEND_TARGET = Object.freeze({
  host: "p4-07-db.lashher.com",
  port: 5432,
  database: "lash_her_p407_frontend",
  user: "lash_her_p407_frontend_migration",
  runtimeRole: "lash_her_p407_frontend_runtime",
  serverMajor: 18,
});

const witnessFields = ["databaseOid", "migrationRoleOid", "runtimeRoleOid", "systemIdentifier"];
const refuse = (ok) => { if (!ok) throw new Error("P407_ISOLATED_FRONTEND_REFUSED"); };

export function prepareP407FrontendScope({ job, artifact }, witness) {
  const { target } = job;
  refuse(job.environment === "staging" &&
    Object.entries(P407_FRONTEND_TARGET).every(([name, value]) => target[name] === value) &&
    /^p4-07\/lightsail\/empty-schema\/[a-f0-9]{64}$/u.test(job.recoveryRef) &&
    target.allowEmptyBootstrap === true && artifact.migrations.length > 0 &&
    isDeepStrictEqual(target.approvedPendingTags, artifact.migrations.map(({ tag }) => tag)));
  refuse(witness && isDeepStrictEqual(Object.keys(witness).sort(), ["version", ...witnessFields].sort()) &&
    witness.version === 1 && /^[1-9][0-9]{0,19}$/u.test(witness.systemIdentifier) &&
    witnessFields.filter((key) => key !== "systemIdentifier").every((key) =>
      typeof witness[key] === "string" && /^[1-9][0-9]{0,9}$/u.test(witness[key]) && Number(witness[key]) <= 4294967295) &&
    typeof witness.systemIdentifier === "string" && witness.migrationRoleOid !== witness.runtimeRoleOid);
  return Object.freeze({ ...witness });
}

export async function verifyP407FrontendSession(client, witness, empty = false) {
  const { rows: [seen] } = await client.query(`
    select host(inet_server_addr()) as "serverAddress", host(inet_client_addr()) as "clientAddress",
      (select system_identifier::text from pg_control_system()) as "systemIdentifier",
      (select oid::text from pg_database where datname=current_database()) as "databaseOid",
      current_user::regrole::oid::text as "migrationRoleOid",
      ($1::regrole::oid)::text as "runtimeRoleOid",
      (select count(*)::int from pg_stat_activity where datname=current_database()
         and pid<>pg_backend_pid()) as "otherSessions",
      not exists(select 1 from pg_namespace where nspname not in ('public','pg_catalog','pg_toast','information_schema'))
      and not exists(
        select 1 from pg_class where relnamespace='public'::regnamespace
          and relkind in ('r','p','v','m','f','S')
      ) as empty
  `, [P407_FRONTEND_TARGET.runtimeRole]);
  refuse(seen?.serverAddress === "172.29.40.2" && seen.clientAddress === "172.29.40.11" &&
    seen.otherSessions === 0 && witnessFields.every((name) => seen[name] === witness[name]) &&
    (!empty || seen.empty === true));
}
