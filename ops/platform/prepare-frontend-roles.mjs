// Explicit plan/apply entrypoint. Never invokes application SQL or coordinator.
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import { prepareFrontendRolesPlan, applyPreparedFrontendRoles, readFrontendRolesMigrationCredential } from "./frontend-role-preparation.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_ROLES_CLI_REFUSED"); };
function document(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = fstatSync(fd); demand(info.isFile() && info.size > 0 && info.size < 2_000_000); return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}
export async function frontendRolesCli(argv, environment = process.env) {
  if (argv.length === 3 && !argv[0].startsWith("--")) argv = ["--plan", ...argv];
  const [mode, candidate, job, specification, confirmFlag, confirmation, receiptsFlag, directory, privateFlag, privateDirectory] = argv;
  demand((mode === "--plan" && argv.length === 4) || (mode === "--apply" && argv.length === 10 && confirmFlag === "--confirm" && receiptsFlag === "--receipts" && privateFlag === "--private"));
  const plan = prepareFrontendRolesPlan(document(candidate), document(job), document(specification));
  if (mode === "--plan") return plan;
  demand(confirmation === `staging/${plan.actionId}` && typeof environment.FRONTEND_ROLES_MIGRATION_PRIVATE_DIRECTORY === "string");
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url))); assertSourceCheckout(root, plan.sourceCommit);
  return withFrontendEnvironmentLock(async verifyEnvironment => {
    const url = new URL(readFrontendRolesMigrationCredential(environment.FRONTEND_ROLES_MIGRATION_PRIVATE_DIRECTORY));
    demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === plan.target.host && Number(url.port || 5432) === plan.target.port &&
      decodeURIComponent(url.pathname.slice(1)) === plan.target.database && decodeURIComponent(url.username) === plan.target.user && url.password && !url.hash &&
      [...url.searchParams].length === 1 && url.searchParams.get("sslmode") === "verify-full");
    const client = new Client({ host: plan.target.host, port: plan.target.port, database: plan.target.database, user: plan.target.user, password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true }, enableChannelBinding: true, connectionTimeoutMillis: 15_000, statement_timeout: 120_000, lock_timeout: 15_000 });
    let locked = false, lost = false; client.on("error", () => { lost = true; });
    try {
      await client.connect(); await verifyEnvironment();
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["lash-her:private-db:migrations"])).rows[0]?.locked === true;
      demand(locked);
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      const verifySession = async () => { demand(!lost && (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid === pid); };
      return await applyPreparedFrontendRoles(plan, client, { confirmation, verifyEnvironment, verifySession, directory, privateDirectory,
        reuseDirectory: environment.FRONTEND_ROLES_REUSE_RECEIPTS_DIRECTORY, reusePrivateDirectory: environment.FRONTEND_ROLES_REUSE_PRIVATE_DIRECTORY });
    } finally {
      try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["lash-her:private-db:migrations"]); } finally { await client.end(); }
    }
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  frontendRolesCli(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write('{"status":"FRONTEND_ROLE_PREPARATION_FAILED_REVIEW_REQUIRED","automaticReplayAllowed":false}\n'); process.exitCode = 1;
  });
