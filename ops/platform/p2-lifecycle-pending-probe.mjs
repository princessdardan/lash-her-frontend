// Fixed SELECT-only observer. It does not create commands or deliver work.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";

const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_PENDING_REFUSED"); };
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
export const p2SuspensionEvidenceSha256 = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const date = value => new Date(value).toISOString();

export const P2_LIFECYCLE_PENDING_SQL = Object.freeze({
  identity: `SELECT pg_catalog.pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,
    pg_catalog.current_database() AS database,(pg_catalog.current_setting('server_version_num')::int/10000)::int AS major,
    pg_catalog.current_setting('transaction_read_only') AS read_only`,
  lock: `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
    AND granted AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
    AND objsubid=1 AND classid=((pg_catalog.hashtext($1)::bigint>>32)&4294967295)::oid
    AND objid=(pg_catalog.hashtext($1)::bigint&4294967295)::oid) AS held`,
  account: "SELECT id::text,status,account_version::text FROM public.customer_users WHERE id=$1::uuid",
  command: `SELECT command_id::text,user_id::text,account_version::text,action,issued_at,command,requested_by_admin_id::text
    FROM public.customer_account_commands WHERE command_id=$1::uuid AND user_id=$2::uuid`,
  deliveries: `SELECT receiver,status,attempts,lease_id::text,lease_until,acknowledged_at
    FROM public.customer_account_deliveries WHERE command_id=$1::uuid ORDER BY CASE receiver WHEN 'course' THEN 0 ELSE 1 END`,
  later: "SELECT count(*)::int AS count FROM public.customer_account_commands WHERE user_id=$1::uuid AND account_version>$2::bigint",
  outstanding: `SELECT count(*)::int AS count FROM public.customer_account_deliveries d JOIN public.customer_account_commands c USING(command_id)
    WHERE c.user_id=$1::uuid AND d.status IN ('pending','delivering')`,
  sessions: "SELECT count(*)::int AS count FROM public.customer_sessions WHERE user_id=$1::uuid",
  owner: "SELECT id::text,status,role FROM public.admin_users WHERE id=$1::uuid",
  now: "SELECT pg_catalog.clock_timestamp() AS now",
});

export function qualifyP2SuspensionPending(observation, selection) {
  demand(closed(selection, ["userId", "commandId", "accountVersion", "requestId", "responseObservedAt", "controlledDenialObservedAt"])
    && uuid(selection.userId) && uuid(selection.commandId) && uuid(selection.requestId)
    && Number.isSafeInteger(selection.accountVersion) && selection.accountVersion >= 1
    && Number.isFinite(Date.parse(selection.responseObservedAt)) && Number.isFinite(Date.parse(selection.controlledDenialObservedAt))
    && Date.parse(selection.controlledDenialObservedAt) >= Date.parse(selection.responseObservedAt));
  demand(closed(observation, ["identity", "account", "command", "deliveries", "later", "outstanding", "sessions", "owner", "now"]));
  const row = observation.command[0], command = row?.command;
  demand(observation.command.length === 1 && row.command_id === selection.commandId && row.user_id === selection.userId
    && row.account_version === String(selection.accountVersion) && row.action === "suspend" && uuid(row.requested_by_admin_id)
    && closed(command, ["version", "commandId", "userId", "accountVersion", "action", "issuedAt"])
    && command.version === 1 && command.commandId === selection.commandId && command.userId === selection.userId
    && command.accountVersion === selection.accountVersion && command.action === "suspend"
    && date(command.issuedAt) === command.issuedAt && date(row.issued_at) === command.issuedAt
    && Date.parse(command.issuedAt) <= Date.parse(selection.responseObservedAt));
  demand(observation.account.length === 1 && observation.account[0].id === selection.userId && observation.account[0].status === "suspended"
    && observation.account[0].account_version === String(selection.accountVersion) && observation.sessions === 0
    && observation.owner.length === 1 && observation.owner[0].id === row.requested_by_admin_id
    && observation.owner[0].status === "active" && observation.owner[0].role === "owner"
    && observation.later === 0 && observation.outstanding === 2
    && observation.deliveries.length === 2 && observation.deliveries.map(value => value.receiver).join() === "course,community"
    && observation.deliveries.every(value => value.status === "pending" && value.attempts === 0 && value.lease_id === null
      && value.lease_until === null && value.acknowledged_at === null)
    && Date.parse(observation.now) >= Date.parse(selection.controlledDenialObservedAt));
  return { version: 1, status: "P2_LIFECYCLE_SUSPENSION_PENDING_OBSERVED", command,
    requestedByAdminId: row.requested_by_admin_id, uiRequestId: selection.requestId, uiResponseObservedAt: selection.responseObservedAt,
    controlledDenialObservedAt: selection.controlledDenialObservedAt, observedAt: date(observation.now),
    frontendStatus: "suspended", sessions: 0, deliveries: observation.deliveries,
    laterCommandCount: 0, pendingOrDeliveringCount: 2, readOnly: true, workerInvoked: false };
}

export async function observeP2SuspensionPending(client, target, selection, { verifyEnvironment, verifySession }) {
  demand(client instanceof Client && typeof verifyEnvironment === "function" && typeof verifySession === "function"
    && client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true
    && client.connectionParameters?.host === target.host && Number(client.connectionParameters.port) === target.port);
  const read = async (sql, args) => { await verifyEnvironment(); await verifySession(); const result = await client.query(sql, args); await verifySession(); await verifyEnvironment(); return result.rows; };
  const initial = (await read(P2_LIFECYCLE_PENDING_SQL.identity))[0];
  demand(initial?.username === target.user && initial.session_username === target.user && initial.database === target.database
    && initial.major === target.serverMajor && Number.isInteger(initial.pid));
  demand((await read(P2_LIFECYCLE_PENDING_SQL.lock, ["lash-her:private-db:migrations"]))[0]?.held === true);
  await read("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let observation;
  try {
    const identity = (await read(P2_LIFECYCLE_PENDING_SQL.identity))[0];
    demand(identity.pid === initial.pid && identity.read_only === "on" && identity.username === target.user && identity.database === target.database);
    const account = await read(P2_LIFECYCLE_PENDING_SQL.account, [selection.userId]);
    const command = await read(P2_LIFECYCLE_PENDING_SQL.command, [selection.commandId, selection.userId]);
    demand(command.length === 1 && uuid(command[0].requested_by_admin_id));
    observation = { identity, account, command, deliveries: await read(P2_LIFECYCLE_PENDING_SQL.deliveries, [selection.commandId]),
      later: (await read(P2_LIFECYCLE_PENDING_SQL.later, [selection.userId, selection.accountVersion]))[0]?.count,
      outstanding: (await read(P2_LIFECYCLE_PENDING_SQL.outstanding, [selection.userId]))[0]?.count,
      sessions: (await read(P2_LIFECYCLE_PENDING_SQL.sessions, [selection.userId]))[0]?.count,
      owner: await read(P2_LIFECYCLE_PENDING_SQL.owner, [command[0].requested_by_admin_id]), now: date((await read(P2_LIFECYCLE_PENDING_SQL.now))[0]?.now) };
    return qualifyP2SuspensionPending(observation, selection);
  } finally { await client.query("ROLLBACK"); }
}
