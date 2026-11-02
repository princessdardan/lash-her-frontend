// Initial login activation only. Existing roles/privileges are not recreated.
import { createHmac, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = createRequire(new URL("../../package.json", import.meta.url))("pg");
const HOST = "ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech";
const ROLES = ["lash_her_course_staging_migration", "lash_her_course_staging_runtime"];
const VARIABLES = ["COURSE_STAGING_ADMIN_DATABASE_URL", "COURSE_STAGING_DATABASE_URL", "COURSE_STAGING_RUNTIME_DATABASE_URL"];
const demand = (ok) => { if (!ok) throw new Error("COURSE_INITIAL_LOGIN_INPUT_REFUSED"); };

function connection(value, role, admin = false) {
  let url; try { url = new URL(value); } catch { demand(false); }
  const host = admin ? url.hostname.replace(/-pooler(?=\.)/u, "") : url.hostname;
  demand(["postgres:", "postgresql:"].includes(url.protocol) && host === HOST &&
    ["", "5432"].includes(url.port) && decodeURIComponent(url.pathname) === "/neondb" &&
    decodeURIComponent(url.username) === role && !url.hash);
  const entries = [...url.searchParams];
  demand(new Set(entries.map(([key]) => key)).size === entries.length);
  demand(admin ? entries.every(([key, value]) => key === "sslmode" && ["require", "verify-ca", "verify-full"].includes(value) ||
    key === "channel_binding" && value === "require") && url.searchParams.has("sslmode") :
    entries.length === 1 && url.searchParams.get("sslmode") === "verify-full");
  const password = decodeURIComponent(url.password);
  demand(password.length >= (admin ? 16 : 32) && password.length <= 256 && [...password].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127));
  return { host, port: 5432, database: "neondb", user: role, password, ssl: { rejectUnauthorized: true },
    enableChannelBinding: true, connectionTimeoutMillis: 15000, query_timeout: 15000, statement_timeout: 10000,
    lock_timeout: 5000, options: "", application_name: "lash-her-course-initial-login" };
}

// Send SCRAM verifiers, not plaintext passwords, in the role DDL. Neither form
// may be printed, added to command arguments, retained in receipts or logged.
function verifier(password) {
  const salt = randomBytes(16), iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored}:${server}`;
}

export async function activateCourseLogins(values, dependencies = {}) {
  const clients = [];
  let transaction = false, committed = false;
  const createClient = dependencies.createClient ?? ((options) => new Client(options));
  const connect = async (options) => {
    const client = createClient(options); clients.push(client); await client.connect();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    return client;
  };
  try {
    const configs = [connection(values[VARIABLES[0]], "neondb_owner", true), ...ROLES.map((role, index) => connection(values[VARIABLES[index + 1]], role))];
    demand(new Set(configs.map((config) => config.password)).size === 3);
    const owner = await connect(configs[0]);
    await owner.query("BEGIN"); transaction = true;
    const identity = (await owner.query("select current_user,current_database() as database,current_setting('server_version_num')::int/10000 as major")).rows[0];
    demand(identity.current_user === "neondb_owner" && identity.database === "neondb" && identity.major === 18);
    demand((await owner.query("select pg_try_advisory_xact_lock(5494745940314423301::bigint) as locked")).rows[0].locked === true);
    const roles = (await owner.query(`select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      from pg_roles where rolname=any($1::text[])`, [ROLES])).rows;
    demand(roles.length === 2 && roles.every((r) => ROLES.includes(r.rolname) &&
      ["rolcanlogin", "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].every((key) => r[key] === false)));
    demand((await owner.query(`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','drizzle') and c.relkind in ('r','p','v','m','f','S')`)).rows[0].count === 0);
    const privileges = (await owner.query(`select has_database_privilege($1,current_database(),'CREATE') as migration_db_create,
      has_schema_privilege($1,'public','CREATE') as migration_schema_create,
      has_schema_privilege($2,'public','CREATE') as runtime_schema_create,
      has_database_privilege($2,current_database(),'CREATE') as runtime_db_create,
      pg_has_role($2,$1,'MEMBER') as runtime_migration_member`, ROLES)).rows[0];
    demand(privileges.migration_db_create === true && privileges.migration_schema_create === true &&
      privileges.runtime_schema_create === false && privileges.runtime_db_create === false && privileges.runtime_migration_member === false);
    for (let index = 0; index < ROLES.length; index++) {
      const scram = verifier(configs[index + 1].password);
      // Both identifiers are fixed constants; generated SCRAM has no SQL quote.
      demand(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u.test(scram));
      await owner.query(`ALTER ROLE "${ROLES[index]}" LOGIN PASSWORD '${scram}'`);
    }
    await owner.query("COMMIT"); transaction = false; committed = true;
    // A lost COMMIT response is uncertain. Never retry role activation or
    // replace either password automatically; inspect login state deliberately.
    for (let index = 0; index < ROLES.length; index++) {
      const client = await connect(configs[index + 1]);
      await client.query("BEGIN READ ONLY");
      const current = (await client.query("select current_user,current_database() as database,current_setting('transaction_read_only') as read_only")).rows[0];
      demand(current.current_user === ROLES[index] && current.database === "neondb" && current.read_only === "on");
      await client.query("ROLLBACK");
    }
    return { status: "COURSE_INITIAL_LOGINS_VERIFIED", environment: "staging", roles: ROLES,
      distinctCredentials: true, newLoginConnectionsVerified: true, databaseSchemaChanged: false, databaseOrSchemaGrantsChanged: false,
      migrationPerformed: false, credentialsDisplayed: false };
  } catch {
    if (transaction && clients[0]) { try { await clients[0].query("ROLLBACK"); } catch { /* retain uncertain outcome */ } }
    throw new Error(committed ? "COURSE_LOGIN_POSTFLIGHT_FAILED_REVIEW_ACTUAL_STATE" : "COURSE_LOGIN_ACTIVATION_FAILED_REVIEW_ACTUAL_STATE");
  } finally {
    let cleanupFailed = false;
    for (const client of clients) { try { await client.end(); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new Error("COURSE_LOGIN_DISCONNECT_UNVERIFIED_REVIEW_ACTUAL_STATE");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) console.log(JSON.stringify({ operation: "initial-course-staging-login-activation", project: "damp-mouse-63038480",
      host: HOST, roles: ROLES, requiredVariables: VARIABLES, apply: false, credentialsRead: false, migrationPerformed: false }));
    else {
      demand(args.length === 5 && args[0] === "--apply" && args[1] === "--confirm" && args[2] === "staging/course-initial-logins" &&
        args[3] === "--env-file" && isAbsolute(args[4]));
      for (const name of VARIABLES) delete process.env[name];
      process.loadEnvFile(args[4]);
      console.log(JSON.stringify(await activateCourseLogins(Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]])))));
    }
  } catch {
    console.error("COURSE_INITIAL_LOGIN_SETUP_FAILED_REVIEW_ACTUAL_STATE_NO_AUTOMATIC_RETRY"); process.exitCode = 1;
  }
}
