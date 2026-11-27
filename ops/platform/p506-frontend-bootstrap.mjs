import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const P506_FRONTEND_TARGET = Object.freeze({
  host: "p506-frontend-db.lashher.com",
  port: 5432,
  database: "lash_her_p506_frontend",
  user: "lash_her_p506_frontend_migration",
  runtimeRole: "lash_her_p506_frontend_runtime",
  serverMajor: 18,
});

// Each physical candidate has its own reviewed receipt and exact migration
// network peers. Add a new record only after witnessing both on that foundation.
const foundations = new Map([
  ["7711876906181357618", {
    receiptSha256: "cda6ac840cf728c8df4ddc18bcbbf59677353d4012c0b7bcf310e86e17fc016e",
    serverAddress: "172.30.56.2",
    migrationClientAddress: "172.30.56.11",
  }],
  ["7712635123417854000", {
    receiptSha256: "923f521a9650d82fb31168cdb36de05991b709adc7219c3827a7bfa473a129c2",
    serverAddress: "172.30.56.2",
    migrationClientAddress: "172.30.56.11",
  }],
  ["7712662041236086833", {
    receiptSha256: "6ddb3a20b847f1ea75e6c955ee33765f6d313efa9c197d7fcfa4ddd5445e0050",
    serverAddress: "172.30.56.2",
    migrationClientAddress: "172.30.56.11",
  }],
]);
const oidFields = ["databaseOid", "migrationRoleOid", "runtimeRoleOid"];
const sha40 = /^(?!0+$)[a-f0-9]{40}$/u;
const refuse = (ok) => { if (!ok) throw new Error("P506_ISOLATED_FRONTEND_REFUSED"); };
const p506Modes = new Set(["--execute-p506-bootstrap", "--execute-p506-current"]);


export function prepareP506FrontendScope({ candidate, job, artifact }, witness, foundation, backup, mode, confirmation) {
  const { target } = job;
  const bootstrap = mode === "--execute-p506-bootstrap";
  refuse(p506Modes.has(mode) && job.environment === "staging" &&
    /^p5-06-[a-z0-9-]{1,58}$/u.test(job.releaseId) && typeof job.sourceCommit === "string" && sha40.test(job.sourceCommit) &&
    Object.entries(P506_FRONTEND_TARGET).every(([name, value]) => target[name] === value) &&
    target.allowEmptyBootstrap === bootstrap && artifact.migrations.length > 0 &&
    isDeepStrictEqual(target.approvedPendingTags, bootstrap ? artifact.migrations.map(({ tag }) => tag) : []));
  for (const [service, repo] of [["frontend", "lash-her-frontend"], ["course", "lash-her-course-api"], ["community", "lash-her-community-api"]]) {
    const source = candidate.sources?.[service];
    refuse(source?.repository === `https://github.com/princessdardan/${repo}.git` &&
      typeof source.commit === "string" && sha40.test(source.commit) && source.requiredChecks === "passed");
  }
  refuse(Buffer.isBuffer(foundation) && Buffer.isBuffer(backup) && backup.length > 0);
  const foundationSha256 = createHash("sha256").update(foundation).digest("hex");
  const backupSha256 = createHash("sha256").update(backup).digest("hex");
  refuse(job.recoveryRef === `p5-06/lightsail/empty-schema/${backupSha256}` &&
    confirmation === `staging/${job.releaseId}/p5-06/${job.sourceCommit}/${backupSha256}`);
  refuse(witness && isDeepStrictEqual(Object.keys(witness).sort(), ["version", "systemIdentifier", ...oidFields].sort()) &&
    witness.version === 1 && foundations.get(witness.systemIdentifier)?.receiptSha256 === foundationSha256 &&
    oidFields.every((key) => typeof witness[key] === "string" && /^[1-9][0-9]{0,9}$/u.test(witness[key]) &&
      Number(witness[key]) <= 4294967295) && witness.migrationRoleOid !== witness.runtimeRoleOid);
  return Object.freeze({ foundationSha256, backupSha256, witness: Object.freeze({ ...witness }) });
}

export async function verifyP506FrontendSession(client, witness, empty = false) {
  const foundation = foundations.get(witness?.systemIdentifier);
  refuse(foundation);
  const { rows: [seen] } = await client.query(`
    select host(inet_server_addr()) as "serverAddress", host(inet_client_addr()) as "clientAddress",
      (select system_identifier::text from pg_control_system()) as "systemIdentifier",
      (select oid::text from pg_database where datname=current_database()) as "databaseOid",
      current_user::regrole::oid::text as "migrationRoleOid",
      ($1::regrole::oid)::text as "runtimeRoleOid",
      (select not rolcanlogin from pg_roles where oid=$1::regrole::oid) as "runtimeHeld",
      (select not rolsuper and not rolcreaterole and not rolcreatedb
           and not rolreplication and not rolbypassrls
         from pg_roles where rolname=current_user) as "migrationRestricted",
      (select count(*)::int from pg_stat_activity where datname=current_database()
         and pid<>pg_backend_pid()) as "otherSessions",
      not exists(select 1 from pg_namespace where nspname not in ('public','pg_catalog','pg_toast','information_schema'))
      and not exists(
        select 1 from pg_class where relnamespace='public'::regnamespace
          and relkind in ('r','p','v','m','f','S')
      ) as empty
  `, [P506_FRONTEND_TARGET.runtimeRole]);
  refuse(seen?.serverAddress === foundation.serverAddress && seen.clientAddress === foundation.migrationClientAddress &&
    seen.otherSessions === 0 && seen.runtimeHeld === true && seen.migrationRestricted === true && seen.systemIdentifier === witness.systemIdentifier &&
    oidFields.every((key) => seen[key] === witness[key]) && (!empty || seen.empty === true));
}
