// Fixed SELECT-only observer. It does not create commands or deliver work.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { p2FirstOwnerIdentitySha256, validP2FirstOwnerDiscoverySelection,
  validP2FirstOwnerSelection } from "./p2-first-owner-identity.mjs";

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

const INTERACTIVE_LIFECYCLE_SQL = Object.freeze({
  state: `SELECT u.id::text,u.status,u.account_version::text,
    (SELECT count(*)::int FROM public.customer_sessions s WHERE s.user_id=u.id) AS sessions,
    EXISTS(SELECT 1 FROM public.customer_sessions s WHERE s.user_id=u.id AND s.expires>pg_catalog.statement_timestamp()) AS has_live_session,
    (SELECT p.learning_updates FROM public.customer_account_preferences p WHERE p.user_id=u.id) AS learning_updates,
    (SELECT count(*)::text FROM public.customer_account_commands c WHERE c.user_id=u.id) AS command_count,
    (SELECT coalesce(max(c.account_version),0)::text FROM public.customer_account_commands c WHERE c.user_id=u.id) AS latest_version,
    (SELECT count(*)::int FROM public.customer_account_deliveries d JOIN public.customer_account_commands c USING(command_id)
      WHERE c.user_id=u.id AND d.status IN ('pending','delivering')) AS outstanding,
    NOT EXISTS(SELECT 1 FROM public.customer_provider_links l WHERE l.user_id=u.id) AS links_cleared,
    NOT EXISTS(SELECT 1 FROM public.customer_account_exports e WHERE e.user_id=u.id
      AND (e.status<>'expired' OR e.data IS NOT NULL OR e.frontend_data IS NOT NULL)) AS exports_cleared
    FROM public.customer_users u WHERE u.id=$1::uuid`,
  command: `SELECT c.command_id::text,c.user_id::text,c.account_version::text,c.action,c.requested_by_admin_id::text,
    c.issued_at=pg_catalog.date_trunc('milliseconds',c.issued_at)
      AND c.command=pg_catalog.jsonb_build_object('version',1,'commandId',c.command_id::text,'userId',c.user_id::text,
        'accountVersion',c.account_version,'action',c.action,'issuedAt',
        pg_catalog.to_char(c.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS canonical
    FROM public.customer_account_commands c WHERE c.command_id=$1::uuid AND c.user_id=$2::uuid`,
  deliveries: `SELECT d.receiver,d.status,d.attempts,
    (d.lease_id IS NULL AND d.lease_until IS NULL AND d.acknowledged_at IS NULL AND d.last_error IS NULL
      AND d.next_run_at=c.issued_at) AS pristine
    FROM public.customer_account_deliveries d JOIN public.customer_account_commands c USING(command_id)
    WHERE d.command_id=$1::uuid ORDER BY CASE d.receiver WHEN 'course' THEN 0 ELSE 1 END`,
  pendingExport: `SELECT command_id::text,user_id::text,status,
    (ready_at IS NULL AND expires_at IS NULL AND data IS NULL AND frontend_data IS NOT NULL) AS pending_snapshot
    FROM public.customer_account_exports WHERE command_id=$1::uuid`,
});
const interactiveBaselines = new WeakMap();
const commandOperations = new Set(["suspend", "restore", "export", "delete"]);
const preferencesOperation = operation => operation === "preferences-on" || operation === "preferences-off";

function interactiveSelection(value) {
  demand(closed(value, ["actorKind", "actorId", "userId", "operation"]) && uuid(value.actorId) && uuid(value.userId)
    && (value.actorKind === "admin" && commandOperations.has(value.operation)
      || value.actorKind === "customer" && value.actorId === value.userId
        && (["export", "delete"].includes(value.operation) || preferencesOperation(value.operation))));
  return Object.freeze({ ...value });
}

function interactiveResponse(value, selection, before) {
  const preferences = preferencesOperation(selection.operation);
  const pathname = selection.actorKind === "admin" ? `/api/admin/customer-accounts/${selection.userId}/commands`
    : preferences ? "/api/account/preferences" : "/api/account/commands";
  demand(closed(value, ["method", "pathname", "status", "requestId", "body"]) && value.method === "POST"
    && value.pathname === pathname && uuid(value.requestId) && value.status === (preferences ? 200 : 202));
  if (preferences) {
    demand(closed(value.body, ["saved"]) && value.body.saved === true);
  } else {
    demand(closed(value.body, ["commandId", "action", "accountVersion", "status"]) && uuid(value.body.commandId)
      && value.body.action === selection.operation && value.body.status === "pending"
      && Number.isSafeInteger(value.body.accountVersion) && value.body.accountVersion === Number(before.account_version) + 1);
  }
  return { ...value, body: { ...value.body } };
}

const interactiveTarget = ({ host, port, user, database, serverMajor }) => ({ host, port, user, database, serverMajor });

async function readHeldInteractiveSnapshot(client, target, { verifyEnvironment, verifySession }, backend, select) {
  demand(client instanceof Client && typeof verifyEnvironment === "function" && typeof verifySession === "function"
    && client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true
    && client.connectionParameters?.host === target.host && Number(client.connectionParameters.port) === target.port);
  const read = async (sql, values) => {
    await verifyEnvironment(); await verifySession();
    const { rows } = await client.query(sql, values);
    await verifySession(); await verifyEnvironment();
    return rows;
  };
  const requireBound = async pid => {
    const [identity] = await read(P2_LIFECYCLE_PENDING_SQL.identity);
    demand(identity?.username === target.user && identity.session_username === target.user && identity.database === target.database
      && identity.major === target.serverMajor && Number.isInteger(identity.pid) && (pid === undefined || identity.pid === pid)
      && client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    demand((await read(P2_LIFECYCLE_PENDING_SQL.lock, ["lash-her:private-db:migrations"]))[0]?.held === true);
    return identity;
  };
  const initial = await requireBound(backend);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    demand((await requireBound(initial.pid)).read_only === "on");
    const observation = await select(read);
    demand((await requireBound(initial.pid)).read_only === "on");
    return { backend: initial.pid, ...observation };
  } finally {
    await client.query("ROLLBACK");
    await requireBound(initial.pid);
  }
}

function readInteractiveLifecycle(client, target, selection, response, dependencies, backend) {
  return readHeldInteractiveSnapshot(client, target, dependencies, backend, async read => {
    const states = await read(INTERACTIVE_LIFECYCLE_SQL.state, [selection.userId]);
    const state = states[0];
    demand(states.length === 1 && state.id === selection.userId && ["active", "suspended", "deleted"].includes(state.status)
      && /^(0|[1-9][0-9]*)$/u.test(state.account_version) && Number.isSafeInteger(Number(state.account_version))
      && state.command_count === state.account_version && state.latest_version === state.account_version
      && Number.isInteger(state.sessions) && state.sessions >= 0 && Number.isInteger(state.outstanding) && state.outstanding >= 0
      && (state.learning_updates === null || typeof state.learning_updates === "boolean")
      && typeof state.has_live_session === "boolean" && typeof state.links_cleared === "boolean" && typeof state.exports_cleared === "boolean");
    if (selection.actorKind === "admin") {
      const owners = await read(P2_LIFECYCLE_PENDING_SQL.owner, [selection.actorId]);
      demand(owners.length === 1 && owners[0].id === selection.actorId && owners[0].status === "active" && owners[0].role === "owner");
    }
    const commandId = response?.body.commandId;
    const command = commandId ? await read(INTERACTIVE_LIFECYCLE_SQL.command, [commandId, selection.userId]) : [];
    const deliveries = commandId ? await read(INTERACTIVE_LIFECYCLE_SQL.deliveries, [commandId]) : [];
    const pendingExport = commandId && selection.operation === "export"
      ? await read(INTERACTIVE_LIFECYCLE_SQL.pendingExport, [commandId]) : [];
    const [{ now }] = await read(P2_LIFECYCLE_PENDING_SQL.now);
    return { state, command, deliveries, pendingExport, observedAt: date(now) };
  });
}

export async function captureP2InteractiveLifecycleBaseline(client, target, selection, dependencies) {
  const selected = interactiveSelection(selection), binding = interactiveTarget(target);
  const { backend, state, observedAt } = await readInteractiveLifecycle(client, binding, selected, null, dependencies);
  const { operation } = selected;
  demand(state.status !== "deleted" && (selected.actorKind !== "customer" || state.status === "active" && state.has_live_session));
  if (operation === "suspend") demand(state.status === "active");
  if (operation === "restore") demand(state.status === "suspended" && state.sessions === 0);
  if (preferencesOperation(operation)) demand((state.learning_updates ?? false) === (operation === "preferences-off"));
  const receipt = Object.freeze({
    version: 1, status: "P2_INTERACTIVE_LIFECYCLE_BASELINE_OBSERVED", ...selected,
    accountVersion: Number(state.account_version), frontendStatus: state.status, sessions: state.sessions,
    learningUpdates: state.learning_updates ?? false, pendingOrDeliveringCount: state.outstanding, observedAt, readOnly: true,
  });
  interactiveBaselines.set(receipt, { client, binding, selected, backend, state });
  return receipt;
}

export async function observeP2InteractiveLifecycleCase(client, target, selection, baseline, response, dependencies) {
  const selected = interactiveSelection(selection), saved = interactiveBaselines.get(baseline);
  demand(saved?.client === client && isDeepStrictEqual(saved.binding, interactiveTarget(target)) && isDeepStrictEqual(saved.selected, selected));
  const before = saved.state, checked = interactiveResponse(response, selected, before);
  interactiveBaselines.delete(baseline);
  const { state: after, command, deliveries, pendingExport, observedAt } = await readInteractiveLifecycle(
    client, saved.binding, selected, checked, dependencies, saved.backend);
  const { actorKind, actorId, userId, operation } = selected;
  if (preferencesOperation(operation)) {
    demand(after.status === "active" && after.has_live_session && after.account_version === before.account_version
      && after.sessions === before.sessions && after.outstanding === before.outstanding && after.learning_updates === (operation === "preferences-on"));
  } else {
    const row = command[0], commandId = checked.body.commandId, accountVersion = String(checked.body.accountVersion);
    demand(command.length === 1 && row.command_id === commandId && row.user_id === userId && row.account_version === accountVersion
      && row.action === operation && row.canonical === true && row.requested_by_admin_id === (actorKind === "admin" ? actorId : null)
      && after.account_version === accountVersion && after.outstanding === before.outstanding + 2
      && deliveries.length === 2 && deliveries[0].receiver === "course" && deliveries[1].receiver === "community"
      && deliveries.every(delivery => delivery.status === "pending" && delivery.attempts === 0 && delivery.pristine === true));
    if (operation === "export") {
      demand(after.status === before.status && after.sessions === before.sessions && after.learning_updates === before.learning_updates
        && pendingExport.length === 1 && pendingExport[0].command_id === commandId && pendingExport[0].user_id === userId
        && pendingExport[0].status === "pending" && pendingExport[0].pending_snapshot === true);
    } else if (operation === "delete") {
      demand(after.status === "deleted" && after.sessions === 0 && after.learning_updates === null && after.links_cleared && after.exports_cleared);
    } else {
      demand(after.status === "suspended" && after.sessions === 0 && after.learning_updates === before.learning_updates);
    }
  }
  return {
    version: 1, status: "P2_INTERACTIVE_LIFECYCLE_CASE_OBSERVED", ...selected, requestId: checked.requestId, httpStatus: checked.status,
    baselineSha256: p2SuspensionEvidenceSha256(baseline), frontendStatus: after.status, accountVersion: Number(after.account_version),
    sessionsBefore: before.sessions, sessionsAfter: after.sessions, learningUpdates: after.learning_updates ?? false,
    commandId: checked.body.commandId ?? null, deliveries: deliveries.map(({ receiver, status, attempts }) => ({ receiver, status, attempts })),
    pendingOrDeliveringCount: after.outstanding, observedAt, readOnly: true,
  };
}

const INTERACTIVE_IDENTITY_SQL = Object.freeze({
  // JSON tokens are joined without inter-token whitespace so PostgreSQL and
  // the browser's JSON.stringify produce the same challenge-bound bytes.
  owner: `SELECT id::text,role::text,status::text,
    CASE WHEN length(provider_user_id) BETWEEN 1 AND 255 AND left(provider_user_id,8)<>'pending:' THEN
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        '["p2q-interactive-owner-v1",'||pg_catalog.to_json($2::text)::text||','||
        pg_catalog.to_json(id::text)::text||','||pg_catalog.to_json(provider_user_id)::text||']','UTF8')),'hex')
      END AS owner_subject_sha256
    FROM public.admin_users WHERE id=$1::uuid`,
  customer: `WITH observed AS MATERIALIZED (SELECT pg_catalog.clock_timestamp() AS at)
    SELECT u.id::text,u.status,observed.at::text AS observed_at,live.total,live.fresh
    FROM public.customer_users u CROSS JOIN observed
    CROSS JOIN LATERAL (SELECT count(*)::text AS total,count(*) FILTER (WHERE s.created_at>$2::timestamptz)::text AS fresh
      FROM public.customer_sessions s WHERE s.user_id=u.id AND s.expires>observed.at AND s.created_at<=observed.at) live
    WHERE u.id=$1::uuid`,
  customerPair: `WITH observed AS MATERIALIZED (SELECT pg_catalog.clock_timestamp() AS at)
    SELECT u.id::text,u.status,observed.at::text AS observed_at,live.total,live.fresh
    FROM public.customer_users u CROSS JOIN observed
    CROSS JOIN LATERAL (SELECT count(*)::text AS total,count(*) FILTER (
      WHERE s.created_at>$2::timestamptz AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        '["p2q-customer-session-v1",'||pg_catalog.to_json($3::text)::text||','||
        pg_catalog.to_json(s.token_hash)::text||']','UTF8')),'hex')=ANY($4::text[]))::text AS fresh
      FROM public.customer_sessions s WHERE s.user_id=u.id AND s.expires>observed.at AND s.created_at<=observed.at) live
    WHERE u.id=$1::uuid`,
});
const identityBaselines = new WeakMap();
const firstOwnerBaselines = new WeakMap();
const firstOwnerDiscoveryBaselines = new WeakMap();
const identityDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const FIRST_OWNER_SQL = Object.freeze({
  empty: `SELECT pg_catalog.clock_timestamp()::text AS cutoff,
    NOT EXISTS (SELECT 1 FROM public.admin_users) AS absent`,
  owner: `WITH observed AS MATERIALIZED (SELECT pg_catalog.clock_timestamp() AS at)
    SELECT id::text, status, role, email_normalized, provider_user_id,
      (created_at > $1::timestamptz AND created_at <= observed.at
       AND last_signed_in_at > $1::timestamptz AND last_signed_in_at <= observed.at) AS fresh
    FROM public.admin_users CROSS JOIN observed ORDER BY id LIMIT 2`,
});

export async function captureP2InteractiveFirstOwnerBaseline(client, target, selection, dependencies) {
  demand(validP2FirstOwnerSelection(selection));
  const selected = Object.freeze({ ...selection }), binding = interactiveTarget(target);
  const { backend, empty } = await readHeldInteractiveSnapshot(client, binding, dependencies, undefined,
    async read => ({ empty: await read(FIRST_OWNER_SQL.empty) }));
  demand(empty.length === 1 && empty[0].absent === true && Number.isFinite(Date.parse(empty[0].cutoff)));
  const baseline = Object.freeze({});
  firstOwnerBaselines.set(baseline, { client, binding, selected, backend, cutoff: empty[0].cutoff });
  return baseline;
}

export async function observeP2InteractiveFirstOwnerCase(client, target, selection, baseline, browserIdentity, dependencies) {
  const saved = firstOwnerBaselines.get(baseline);
  demand(saved?.client === client && isDeepStrictEqual(saved.binding, interactiveTarget(target))
    && isDeepStrictEqual(saved.selected, selection) && closed(browserIdentity, ["actorKind", "actorId", "sessionVerified"])
    && browserIdentity.actorKind === "admin" && uuid(browserIdentity.actorId) && browserIdentity.sessionVerified === true);
  firstOwnerBaselines.delete(baseline);
  try {
    const { witness } = await readHeldInteractiveSnapshot(client, saved.binding, dependencies, saved.backend, async read => {
      const rows = await read(FIRST_OWNER_SQL.owner, [saved.cutoff]), row = rows[0];
      demand(rows.length === 1 && row.id === browserIdentity.actorId && row.status === "active" && row.role === "owner" &&
        row.fresh === true && p2FirstOwnerIdentitySha256(selection.nonce, row.email_normalized, row.provider_user_id) === selection.identitySha256);
      return { witness: { actorKind: "admin", actorId: row.id, actorActive: true, ownerMappingVerified: true, firstOwnerVerified: true } };
    });
    return witness;
  } catch {
    // No provider subject or email belongs in an operator failure.
    throw new Error("P2_LIFECYCLE_PENDING_REFUSED");
  }
}

export async function captureP2InteractiveFirstOwnerDiscoveryBaseline(client, target, selection, dependencies) {
  demand(validP2FirstOwnerDiscoverySelection(selection));
  const selected = Object.freeze({ ...selection }), binding = interactiveTarget(target);
  const { backend, empty } = await readHeldInteractiveSnapshot(client, binding, dependencies, undefined,
    async read => ({ empty: await read(FIRST_OWNER_SQL.empty) }));
  demand(empty.length === 1 && empty[0].absent === true && Number.isFinite(Date.parse(empty[0].cutoff)));
  const baseline = Object.freeze({});
  firstOwnerDiscoveryBaselines.set(baseline, { client, binding, selected, backend });
  return baseline;
}

export async function observeP2InteractiveFirstOwnerDiscoveryCase(client, target, selection, baseline, browserIdentity, dependencies) {
  const saved = firstOwnerDiscoveryBaselines.get(baseline);
  demand(saved?.client === client && isDeepStrictEqual(saved.binding, interactiveTarget(target)) &&
    isDeepStrictEqual(saved.selected, selection) && closed(browserIdentity, ["firstOwner", "sessionVerified"]) &&
    browserIdentity.sessionVerified === true && validP2FirstOwnerSelection(browserIdentity.firstOwner) &&
    browserIdentity.firstOwner.nonce === selection.nonce && browserIdentity.firstOwner.identitySha256 !== selection.emailSha256);
  firstOwnerDiscoveryBaselines.delete(baseline);
  try {
    const { witness } = await readHeldInteractiveSnapshot(client, saved.binding, dependencies, saved.backend, async read => {
      const rows = await read(FIRST_OWNER_SQL.empty);
      demand(rows.length === 1 && rows[0].absent === true);
      return { witness: { adminUserCount: 0, firstOwnerDiscoveryVerified: true,
        firstOwnerIdentitySha256: browserIdentity.firstOwner.identitySha256 } };
    });
    return witness;
  } catch {
    throw new Error("P2_LIFECYCLE_PENDING_REFUSED");
  }
}

function identitySelection(value) {
  const paired = value && Object.hasOwn(value, "sessionCount");
  demand(closed(value, ["actorKind", "actorId", ...(paired ? ["sessionCount"] : [])])
    && ["admin", "customer"].includes(value.actorKind) && uuid(value.actorId)
    && (!paired || value.actorKind === "customer" && value.sessionCount === 2));
  return Object.freeze({ ...value });
}

function identitySessionCount(value) {
  demand(typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value)));
  return Number(value);
}

function readInteractiveIdentity(client, target, selection, challenge, cutoff, dependencies, backend, sessionProofs) {
  return readHeldInteractiveSnapshot(client, target, dependencies, backend, async read => {
    const admin = selection.actorKind === "admin";
    const rows = await read(admin ? INTERACTIVE_IDENTITY_SQL.owner : sessionProofs ? INTERACTIVE_IDENTITY_SQL.customerPair : INTERACTIVE_IDENTITY_SQL.customer,
      [selection.actorId, admin ? challenge : cutoff, ...(sessionProofs ? [challenge, sessionProofs] : [])]);
    const row = rows[0];
    demand(rows.length === 1 && row.id === selection.actorId && row.status === "active");
    if (admin) {
      demand(row.role === "owner" && identityDigest(row.owner_subject_sha256));
      return { ownerSubjectSha256: row.owner_subject_sha256 };
    }
    const liveSessionCount = identitySessionCount(row.total), freshSessionCount = identitySessionCount(row.fresh);
    demand(typeof row.observed_at === "string" && freshSessionCount <= liveSessionCount);
    return { cutoff: row.observed_at, liveSessionCount, freshSessionCount };
  });
}

export async function captureP2InteractiveIdentityBaseline(client, target, selection, challenge, dependencies) {
  const selected = identitySelection(selection), binding = interactiveTarget(target);
  demand(identityDigest(challenge));
  const state = await readInteractiveIdentity(client, binding, selected, challenge, null, dependencies);
  const baseline = {};
  if (selected.actorKind === "admin") {
    Object.defineProperty(baseline, "ownerSubjectSha256", { value: state.ownerSubjectSha256, enumerable: false });
  }
  identityBaselines.set(baseline, { client, binding, selected, challenge, state });
  return Object.freeze(baseline);
}

export async function observeP2InteractiveIdentityCase(client, target, selection, baseline, browserIdentity, dependencies) {
  const selected = identitySelection(selection), saved = identityBaselines.get(baseline);
  const paired = selected.sessionCount === 2;
  demand(saved?.client === client && isDeepStrictEqual(saved.binding, interactiveTarget(target)) && isDeepStrictEqual(saved.selected, selected)
    && closed(browserIdentity, ["actorKind", "actorId", "sessionVerified", ...(paired ? ["sessionProofs"] : [])]) && browserIdentity.actorKind === selected.actorKind
    && browserIdentity.actorId === selected.actorId && browserIdentity.sessionVerified === true);
  const sessionProofs = paired ? browserIdentity.sessionProofs : undefined;
  if (paired) demand(Array.isArray(sessionProofs) && sessionProofs.length === 2 && sessionProofs.every(identityDigest)
    && sessionProofs[0] !== sessionProofs[1]);
  identityBaselines.delete(baseline);
  const observed = await readInteractiveIdentity(client, saved.binding, selected, saved.challenge,
    saved.state.cutoff ?? null, dependencies, saved.state.backend, sessionProofs);
  if (selected.actorKind === "admin") {
    demand(observed.ownerSubjectSha256 === saved.state.ownerSubjectSha256);
    return { ...selected, actorActive: true, ownerMappingVerified: true };
  }
  demand(paired ? observed.freshSessionCount === 2 : observed.freshSessionCount > 0);
  return { ...selected, actorActive: true, liveSessionCount: observed.liveSessionCount,
    ...(paired ? { verifiedFreshSessionCount: observed.freshSessionCount } : {}) };
}

const INTERACTIVE_ENROLLMENT_SQL = Object.freeze({
  absent: `SELECT pg_catalog.clock_timestamp()::text AS cutoff,
    NOT EXISTS(SELECT 1 FROM public.customer_users WHERE email=$1::text) AS absent`,
  customer: `WITH observed AS MATERIALIZED (SELECT pg_catalog.clock_timestamp() AS at)
    SELECT u.id::text,u.status,u.account_version::text,
      (u.created_at>$2::timestamptz AND u.created_at<=observed.at AND u.email_verified IS NOT NULL) AS fresh_verified_user,
      sessions.live,sessions.fresh,links.total AS link_count,links.google AS google_link_count
    FROM public.customer_users u CROSS JOIN observed
    CROSS JOIN LATERAL (SELECT count(*)::text AS live,count(*) FILTER (
        WHERE s.created_at>=u.created_at AND s.created_at>$2::timestamptz AND s.created_at<=observed.at)::text AS fresh
      FROM public.customer_sessions s WHERE s.user_id=u.id AND s.expires>observed.at) sessions
    CROSS JOIN LATERAL (SELECT count(*)::text AS total,count(*) FILTER (
        WHERE l.provider='google' AND l.type='oidc' AND length(btrim(l.provider_account_id)) BETWEEN 1 AND 255
          AND l.created_at>=u.created_at AND l.created_at<=observed.at)::text AS google
      FROM public.customer_provider_links l WHERE l.user_id=u.id) links
    WHERE u.email=$1::text`,
  // Both lookups are indexed. New legacy consent inserts are mirrored into
  // highlevel_consent_events by the source migration in the same transaction.
  marketing: `SELECT
    NOT EXISTS(SELECT 1 FROM public.marketing_contacts WHERE email_normalized=$1::text) AS contact_absent,
    NOT EXISTS(SELECT 1 FROM public.highlevel_consent_events WHERE email_normalized=$1::text) AS consent_absent`,
});
const enrollmentBaselines = new WeakMap();

export function validateP2InteractiveEnrollmentEmail(selection, email) {
  demand(closed(selection, ["provider", "emailSha256", "nonce"]) && ["google", "resend"].includes(selection.provider)
    && identityDigest(selection.emailSha256) && typeof selection.nonce === "string" && /^[a-f0-9]{32}$/u.test(selection.nonce)
    && typeof email === "string" && email.length <= 254 && email === email.normalize("NFKC").trim().toLowerCase()
    && !/[\u0000-\u001f\u007f]/u.test(email) && /^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/u.test(email)
    && p2SuspensionEvidenceSha256(JSON.stringify(["p2q-customer-enrollment-v1", selection.provider, selection.nonce, email])) === selection.emailSha256);
  return email;
}

async function readInteractiveEnrollment(client, binding, email, cutoff, dependencies, backend) {
  try {
    return await readHeldInteractiveSnapshot(client, binding, dependencies, backend, async read => {
      const args = cutoff === undefined ? [email] : [email, cutoff];
      const rows = await read(cutoff === undefined ? INTERACTIVE_ENROLLMENT_SQL.absent : INTERACTIVE_ENROLLMENT_SQL.customer, args);
      const marketing = await read(INTERACTIVE_ENROLLMENT_SQL.marketing, [email]);
      demand(rows.length === 1 && marketing.length === 1 && marketing[0].contact_absent === true && marketing[0].consent_absent === true);
      return { row: rows[0] };
    });
  } catch {
    // Database errors can contain the operator's private lookup value.
    throw new Error("P2_LIFECYCLE_PENDING_REFUSED");
  }
}

export async function captureP2InteractiveEnrollmentBaseline(client, target, selection, email, dependencies) {
  const selected = Object.freeze({ ...selection }), binding = interactiveTarget(target);
  const address = validateP2InteractiveEnrollmentEmail(selected, email);
  const { backend, row } = await readInteractiveEnrollment(client, binding, address, undefined, dependencies);
  demand(row.absent === true && typeof row.cutoff === "string" && Number.isFinite(Date.parse(row.cutoff)));
  const baseline = Object.freeze({});
  enrollmentBaselines.set(baseline, { client, binding, selected, address, backend, cutoff: row.cutoff });
  return baseline;
}

export async function observeP2InteractiveEnrollmentCase(client, target, selection, baseline, browserIdentity, dependencies) {
  const saved = enrollmentBaselines.get(baseline);
  demand(saved?.client === client && isDeepStrictEqual(saved.binding, interactiveTarget(target))
    && isDeepStrictEqual(saved.selected, selection) && closed(browserIdentity, ["actorKind", "actorId", "sessionVerified"])
    && browserIdentity.actorKind === "customer" && uuid(browserIdentity.actorId) && browserIdentity.sessionVerified === true);
  enrollmentBaselines.delete(baseline);
  const address = validateP2InteractiveEnrollmentEmail(saved.selected, saved.address);
  const { row } = await readInteractiveEnrollment(client, saved.binding, address, saved.cutoff, dependencies, saved.backend);
  const { provider } = saved.selected, providerLinkCount = provider === "google" ? 1 : 0;
  demand(row.id === browserIdentity.actorId && row.status === "active" && row.account_version === "0"
    && row.fresh_verified_user === true && row.live === "1" && row.fresh === "1"
    && row.link_count === String(providerLinkCount) && row.google_link_count === String(providerLinkCount));
  return { actorKind: "customer", actorId: row.id, actorActive: true, liveSessionCount: 1, provider, providerLinkCount };
}
