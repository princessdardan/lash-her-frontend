// Bundled by the reviewed parent and executed in the existing API container.
// Credentials stay in that container's validated runtime environment.
import { TLSSocket, checkServerIdentity } from "node:tls";
import { pathToFileURL } from "node:url";
import { retainDurableWork } from "./staging_work.mjs";
import { businessFingerprint, businessQueries } from "./business_fingerprint.mjs";

const demand = (value, code) => { if (!value) throw new Error(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function runtimeConnection(input, environment) {
  demand(input?.version === 1 && ["course", "community"].includes(input.service)
    && ["preflight", "retain", "outbox", "inbox", "fingerprint"].includes(input.mode)
    && (input.mode !== "retain" && input.mode !== "outbox" || input.service === "course")
    && (input.mode !== "inbox" || input.service === "community"), "STAGING_WORK_SELECTED_MODE_REQUIRED");
  demand(environment.DATABASE_TARGET === "staging" && environment.NODE_ENV === "production"
    && !Object.keys(environment).some(key => key.startsWith("PG")) && environment.NODE_TLS_REJECT_UNAUTHORIZED === undefined,
  "STAGING_WORK_SELECTED_RUNTIME_ENVIRONMENT_REQUIRED");
  const target = input.target;
  demand(target && Object.keys(target).sort().join(",") === "database,host,port,serverMajor,user"
    && typeof target.host === "string" && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.aws\.neon\.tech$/u.test(target.host)
    && target.port === 5432 && target.database === "neondb" && target.serverMajor === 18
    && target.user === `lash_her_${input.service}_staging_runtime`, "STAGING_WORK_EXACT_RUNTIME_TARGET_REQUIRED");
  let url;
  try { url = new URL(environment.STAGING_DATABASE_URL); } catch { /* Static refusal below. */ }
  demand(url && ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === target.host
    && Number(url.port || 5432) === target.port && url.pathname === "/" + target.database
    && decodeURIComponent(url.username) === target.user && url.password && !url.hash
    && JSON.stringify([...url.searchParams]) === JSON.stringify([["sslmode", "verify-full"]]),
  "STAGING_WORK_RUNTIME_DATABASE_BINDING_REQUIRED");
  return { host: target.host, port: target.port, database: target.database, user: target.user,
    password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true, servername: target.host },
    max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 0,
    options: (input.mode === "retain" ? "" : "-c default_transaction_read_only=on ") + "-c statement_timeout=10000" };
}

export function authenticatedRuntimeTls(client, host) {
  try {
    const socket = client.connection?.stream;
    return socket instanceof TLSSocket && socket.encrypted === true && socket.authorized === true && !socket.destroyed
      && checkServerIdentity(host, socket.getPeerCertificate(true)) === undefined;
  } catch { return false; }
}

function eventIds(retained) {
  demand(retained?.status === "STAGING_DURABLE_WORK_RETAINED" && retained.environment === "staging"
    && Array.isArray(retained.events) && retained.events.length === 2
    && retained.events.every(event => uuid.test(event.eventId) && /^[a-f0-9]{64}$/u.test(event.canonicalDigest))
    && new Set(retained.events.map(event => event.eventId)).size === 2, "STAGING_WORK_RETAINED_IDENTITIES_REQUIRED");
  return retained.events.map(event => event.eventId);
}

export async function runImage(input, environment = process.env) {
  const config = runtimeConnection(input, environment);
  if (input.mode === "fingerprint") demand(typeof input.privateFingerprintKey === "string"
    && /^[a-f0-9]{64}$/u.test(input.privateFingerprintKey), "STAGING_FINGERPRINT_BOUND_INPUT_REQUIRED");
  if (["outbox", "inbox"].includes(input.mode)) eventIds(input.retained);
  const { Pool } = await import("/app/node_modules/pg/esm/index.mjs");
  const pool = new Pool(config);
  pool.on("error", () => {}); // Query failures remain handled by the parent.
  let result;
  try {
    const client = await pool.connect();
    try {
      demand(authenticatedRuntimeTls(client, input.target.host), "STAGING_WORK_AUTHENTICATED_RUNTIME_TLS_REQUIRED");
      const identity = (await client.query(`SELECT current_user AS "user",current_database() AS "database",
        (current_setting('server_version_num')::integer/10000)::integer AS "serverMajor",
        current_setting('default_transaction_read_only') AS "readOnly"`)).rows[0];
      demand(identity?.user === input.target.user && identity.database === input.target.database
        && identity.serverMajor === 18 && (input.mode === "retain" || identity.readOnly === "on"),
      "STAGING_WORK_ACTUAL_RUNTIME_IDENTITY_REQUIRED");
    } finally { client.release(); }
    if (input.mode === "preflight") {
      result = { status: "STAGING_RUNTIME_DATABASE_READ_ONLY_VERIFIED", service: input.service, target: input.target,
        authenticatedTls: true, readOnly: true, migrationsExecuted: false };
    } else if (input.mode === "fingerprint") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const tables = {};
        for (const [name, query] of Object.entries(businessQueries[input.service])) tables[name] = (await client.query(query)).rows;
        result = businessFingerprint(input.service, tables, input.privateFingerprintKey);
        await client.query("ROLLBACK");
      } finally { client.release(); }
    } else if (input.mode === "retain") {
      const { drizzle } = await import("/app/node_modules/drizzle-orm/node-postgres/index.js");
      const { createDrizzleCommunityEnrollmentPublisherRepository } = await import("/app/dist/integrations/community/persistence/drizzle-publisher.repository.js");
      const repository = createDrizzleCommunityEnrollmentPublisherRepository(drizzle(pool));
      const readPending = async () => (await pool.query(`SELECT o.event_id AS "eventId",o.stream_id AS "streamId",
        o.stream_version AS "streamVersion",o.canonical_digest AS "canonicalDigest",o.state,
        o.attempts_in_cycle AS "attemptsInCycle",o.replay_cycle AS "replayCycle",o.available_at AS "availableAt",
        o.lease_owner AS "leaseOwner",o.lease_expires_at AS "leaseExpiresAt",s.user_id AS "userId",s.course_id AS "courseId"
        FROM community_enrollment_outbox o JOIN community_enrollment_streams s ON s.id=o.stream_id
        WHERE o.state <> 'delivered' ORDER BY o.created_at,o.event_id`)).rows;
      result = await retainDurableWork(input.fixture, { readPending, repository });
    } else {
      const ids = eventIds(input.retained);
      const query = input.mode === "outbox"
        ? `SELECT event_id AS "eventId",canonical_digest AS "canonicalDigest",state,
          lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt",delivered_at AS "deliveredAt",
          attempts_in_cycle AS "attemptsInCycle" FROM community_enrollment_outbox WHERE event_id=ANY($1::uuid[]) ORDER BY event_id`
        : `SELECT event_id AS "eventId",canonical_digest AS "canonicalDigest",status
          FROM course_enrollment_inbox WHERE event_id=ANY($1::uuid[]) ORDER BY event_id`;
      result = { status: "STAGING_WORK_ROWS_READ_ONLY", service: input.service, mode: input.mode,
        rows: (await pool.query(query, [ids])).rows, authenticatedTls: true, readOnly: true, migrationsExecuted: false };
    }
  } finally { await pool.end(); }
  return result;
}

export async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    demand(Buffer.byteLength(raw) <= 16384, "STAGING_WORK_PRIVATE_INPUT_BOUND_REQUIRED");
  }
  const result = await runImage(JSON.parse(raw));
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = /^STAGING_WORK_[A-Z_]+$/u.test(error.message) ? error.message : "STAGING_WORK_EXECUTION_FAILED";
    process.stderr.write(JSON.stringify({ status: "STAGING_WORK_REQUIRES_REVIEW", code }) + "\n");
    process.exitCode = 1;
  });
}
