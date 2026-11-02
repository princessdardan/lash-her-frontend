// Verify an existing credential or deliberately complete the empty staging
// runtime handoff. Never creates a role, changes grants or migrates schemas.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const { Client, escapeLiteral } = createRequire(new URL("../../package.json", import.meta.url))("pg");
const HOST = "ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech";
const ROLE = "lash_her_community_staging_runtime";
const VARIABLES = ["COMMUNITY_STAGING_DATABASE_URL", "COMMUNITY_STAGING_RUNTIME_DATABASE_URL"];
const demand = (ok) => { if (!ok) throw new Error("COMMUNITY_RUNTIME_INPUT_REFUSED"); };

function connection(value, admin = false) {
  let url; try { url = new URL(value); } catch { demand(false); }
  const host = admin ? url.hostname.replace(/-pooler(?=\.)/u, "") : url.hostname;
  demand(["postgres:", "postgresql:"].includes(url.protocol) && host === HOST &&
    ["", "5432"].includes(url.port) && decodeURIComponent(url.pathname) === "/neondb" &&
    decodeURIComponent(url.username) === (admin ? "neondb_owner" : ROLE) && !url.hash);
  const entries = [...url.searchParams];
  demand(new Set(entries.map(([key]) => key)).size === entries.length);
  demand(admin ? entries.every(([key, value]) => key === "sslmode" && ["require", "verify-ca", "verify-full"].includes(value) ||
    key === "channel_binding" && value === "require") && url.searchParams.has("sslmode") :
    entries.length === 1 && url.searchParams.get("sslmode") === "verify-full");
  const password = decodeURIComponent(url.password);
  demand(password.length >= (admin ? 16 : 32) && password.length <= 256 && [...password].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127));
  return { host, port: 5432, database: "neondb", user: admin ? "neondb_owner" : ROLE, password,
    ssl: { rejectUnauthorized: true }, enableChannelBinding: true, connectionTimeoutMillis: 15000,
    query_timeout: 15000, statement_timeout: 10000, lock_timeout: 5000, options: "",
    application_name: "lash-her-community-runtime-credential" };
}

export async function configureCommunityRuntimeLogin(values, { setPassword = false, createClient = (options) => new Client(options) } = {}) {
  const clients = [];
  let transaction = false, committed = false, commitAttempted = false, phase = "input";
  const connect = async (options) => {
    const client = createClient(options); clients.push(client); await client.connect();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    return client;
  };
  try {
    demand(typeof setPassword === "boolean");
    const admin = connection(values[VARIABLES[0]], true), runtime = connection(values[VARIABLES[1]]);
    demand(admin.password !== runtime.password);
    phase = "admin-connect";
    const owner = await connect(admin);
    phase = "preflight";
    await owner.query(setPassword ? "BEGIN" : "BEGIN READ ONLY"); transaction = true;
    const identity = (await owner.query("select current_user,current_database() as database,current_setting('server_version_num')::int/10000 as major")).rows[0];
    demand(identity.current_user === "neondb_owner" && identity.database === "neondb" && identity.major === 18);
    const roles = (await owner.query(`select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      from pg_roles where rolname=$1`, [ROLE])).rows;
    demand(roles.length === 1 && roles[0].rolcanlogin === true &&
      ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].every((key) => roles[0][key] === false));
    const privileges = (await owner.query(`select has_database_privilege($1,current_database(),'CREATE') as database_create,
      has_schema_privilege($1,'public','CREATE') as schema_create,
      pg_has_role($1,'neondb_owner','MEMBER') as owner_member,
      pg_has_role($1,'neon_superuser','MEMBER') as neon_superuser_member`, [ROLE])).rows[0];
    demand(Object.values(privileges).length === 4 && Object.values(privileges).every((value) => value === false));
    if (setPassword) {
      demand((await owner.query("select pg_try_advisory_xact_lock(5494745940314423301::bigint) as locked")).rows[0].locked === true);
      demand((await owner.query(`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','drizzle') and c.relkind in ('r','p','v','m','f','S')`)).rows[0].count === 0);
      demand((await owner.query("select count(*)::int as count from pg_stat_activity where usename=$1", [ROLE])).rows[0].count === 0);
      demand((await owner.query(`select exists(select 1 from pg_auth_members m
        join pg_roles granted on granted.oid=m.roleid join pg_roles member on member.oid=m.member
        where granted.rolname=$1 and member.rolname=current_user and m.admin_option) as permitted`, [ROLE])).rows[0].permitted === true);
      phase = "password-encryption";
      await owner.query("SET LOCAL password_encryption = 'scram-sha-256'");
      phase = "runtime-password";
      await owner.query(`ALTER ROLE "${ROLE}" PASSWORD ${escapeLiteral(runtime.password)}`);
      phase = "commit"; commitAttempted = true;
      await owner.query("COMMIT"); transaction = false; committed = true;
    } else {
      await owner.query("ROLLBACK"); transaction = false;
    }
    phase = "runtime-login-verification";
    const client = await connect({ ...runtime, options: "-c default_transaction_read_only=on" });
    await client.query("BEGIN READ ONLY");
    const current = (await client.query("select current_user,current_database() as database,current_setting('transaction_read_only') as read_only")).rows[0];
    demand(current.current_user === ROLE && current.database === "neondb" && current.read_only === "on");
    await client.query("ROLLBACK");
    return { status: "COMMUNITY_RUNTIME_LOGIN_VERIFIED", environment: "staging", role: ROLE,
      passwordConfigured: committed, freshVerifiedTlsLogin: true, databaseSchemaChanged: false,
      grantsChanged: false, migrationPerformed: false, credentialsDisplayed: false };
  } catch (error) {
    if (transaction && clients[0]) { try { await clients[0].query("ROLLBACK"); } catch { /* uncertain state requires review */ } }
    throw Object.assign(new Error("COMMUNITY_RUNTIME_CREDENTIAL_FAILED_REVIEW_ACTUAL_STATE"), {
      phase, sqlState: /^[A-Z0-9]{5}$/u.test(error?.code ?? "") ? error.code : null,
      commitState: committed ? "acknowledged" : commitAttempted ? "unknown" : "not-attempted",
    });
  } finally {
    let failed = false;
    for (const client of clients) { try { await client.end(); } catch { failed = true; } }
    if (failed) throw new Error("COMMUNITY_RUNTIME_CLEANUP_UNVERIFIED_REVIEW_ACTUAL_STATE");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) console.log(JSON.stringify({ operation: "community-staging-runtime-credential", host: HOST,
      role: ROLE, requiredVariables: VARIABLES, apply: false, credentialsRead: false, migrationPerformed: false }));
    else {
      const verify = args.length === 3 && args[0] === "--verify" && args[1] === "--env-file" && isAbsolute(args[2]);
      const apply = args.length === 5 && args[0] === "--apply" && args[1] === "--confirm" &&
        args[2] === "staging/community-runtime-credential" && args[3] === "--env-file" && isAbsolute(args[4]);
      demand(verify || apply);
      const loaded = parseEnv(readFileSync(args[verify ? 2 : 4], "utf8"));
      console.log(JSON.stringify(await configureCommunityRuntimeLogin(Object.fromEntries(VARIABLES.map((name) => [name, loaded[name]])), { setPassword: apply })));
    }
  } catch (error) {
    const phases = new Set(["input", "admin-connect", "preflight", "password-encryption", "runtime-password", "commit", "runtime-login-verification"]);
    console.error(JSON.stringify({ status: "COMMUNITY_RUNTIME_CREDENTIAL_FAILED_REVIEW_ACTUAL_STATE_NO_AUTOMATIC_RETRY",
      phase: phases.has(error?.phase) ? error.phase : "setup-or-cleanup", sqlState: /^[A-Z0-9]{5}$/u.test(error?.sqlState ?? "") ? error.sqlState : null,
      commitState: ["acknowledged", "unknown", "not-attempted"].includes(error?.commitState) ? error.commitState : "unknown",
      credentialsDisplayed: false })); process.exitCode = 1;
  }
}
