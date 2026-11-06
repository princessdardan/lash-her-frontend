// Actual capability observations for the already reviewed private handoff.
// Configuration provenance binds original records, never current project env or
// a hash of a secret. No assertion about raw HTTP invocation counts is made.
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const demand = ok => { if (!ok) throw new Error("FRONTEND_HISTORICAL_CAPABILITY_BINDING_REFUSED"); };
const markerSql = `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid=$1
  AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND mode='ExclusiveLock' AND granted
  AND objsubid=1 AND ((classid::bigint << 32) | objid::bigint)=ANY($2::bigint[])`;

export async function observeHistoricalFrontendCapabilityBindings(...args) {
  try { return await observeCapabilityBindings(...args); }
  catch { throw new Error("FRONTEND_HISTORICAL_CAPABILITY_BINDING_REFUSED"); }
}

async function observeCapabilityBindings(context, bindings, privateRuntime, dependencies = {}) {
  const parent = context.databaseClient, verify = context.verifyLockedSession;
  demand(parent && typeof verify === "function");
  const result = { version: 1, actionId: context.plan.actionId, sourceCommit: context.plan.sourceCommit,
    targetSha256: context.plan.targetSha256, providerBindingsSha256: context.plan.providerBindingsSha256,
    rawInvocationCount: null, bindings: [], missingSurfaceSha256: [] };
  for (const surface of bindings.surfaces.filter(row => ["deployment", "direct-caller"].includes(row.kind))) {
    const selected = bindings.historicalRuntimeBindings?.find(row => row.surfaceSha256 === surface.surfaceSha256);
    const actual = privateRuntime.historicalRuntimeConfigurations?.[surface.surfaceSha256];
    if (!selected || !actual) { result.missingSurfaceSha256.push(surface.surfaceSha256); continue; }
    demand(actual.sourceCommit === selected.sourceCommit && actual.configurationRecordSha256 === selected.configurationRecordSha256 &&
      typeof actual.databaseUrl === "string");
    // Only the selected staging direct host or its exact Neon pooler spelling
    // may be contacted. The marker read, not matching hostnames, proves the DB.
    const target = context.plan.historicalLogins.target, url = new URL(actual.databaseUrl);
    const pooler = target.host.endsWith(".neon.tech") ? target.host.replace(/^(ep-[^.]+)(\.)/u, "$1-pooler$2") : null;
    demand(["postgres:", "postgresql:"].includes(url.protocol) && [target.host, pooler].includes(url.hostname) &&
      Number(url.port || 5432) === target.port && decodeURIComponent(url.pathname.slice(1)) === target.database &&
      decodeURIComponent(url.username) === selected.databaseRole.name && url.password && !url.hash &&
      [...url.searchParams.keys()].every(key => ["sslmode", "channel_binding"].includes(key)) &&
      ["require", "verify-full"].includes(url.searchParams.get("sslmode")) &&
      [null, "require", "prefer"].includes(url.searchParams.get("channel_binding")));
    for (const binding of selected.providerCredentials) {
      const expected = privateRuntime[binding.runtimeKey], value = actual.providerCredentials?.[binding.runtimeKey];
      demand(typeof expected === "string" && expected.length > 0 && value === expected);
    }
    demand(actual.providerCredentials && Object.keys(actual.providerCredentials).sort().join() ===
      selected.providerCredentials.map(row => row.runtimeKey).sort().join());
    const markers = Array.from({ length: 4 }, () => (randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn).toString());
    let historical, locked = [], failure;
    try {
      await verify();
      const pid = (await parent.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      demand(Number.isInteger(pid));
      for (const marker of markers) {
        await parent.query("SELECT pg_advisory_lock($1::bigint)", [marker]); locked.push(marker);
      }
      historical = (dependencies.createClient ?? (options => new Client(options)))({ host: url.hostname, port: target.port,
        user: selected.databaseRole.name, password: decodeURIComponent(url.password), database: target.database,
        ssl: { rejectUnauthorized: true }, options: "-c default_transaction_read_only=on", application_name: "lash-her-historical-capability-observer",
        connectionTimeoutMillis: 10000, query_timeout: 10000 });
      historical.on("error", () => { failure = true; });
      await historical.connect();
      demand(historical.connection?.stream?.encrypted === true && historical.connection.stream.authorized === true);
      const identity = (await historical.query(`SELECT current_database() AS database,current_user AS username,
        (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
        current_setting('server_version_num')::int/10000 AS major,current_setting('default_transaction_read_only') AS read_only`)).rows[0];
      demand(identity?.database === target.database && identity.username === selected.databaseRole.name &&
        identity.role_oid === selected.databaseRole.oid && identity.major === target.serverMajor && identity.read_only === "on" &&
        (await historical.query(markerSql, [pid, markers])).rows[0]?.count === 4);
      await verify(); demand(!failure);
      result.bindings.push({ surfaceSha256: surface.surfaceSha256, sourceCommit: selected.sourceCommit,
        configurationRecordSha256: selected.configurationRecordSha256, databaseRole: selected.databaseRole,
        samePhysicalDatabaseVerified: true, privateRetiredCredentialEqualityVerified: true,
        providerCredentials: selected.providerCredentials });
    } finally {
      if (historical) await historical.end();
      for (const marker of locked.reverse()) demand((await parent.query("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [marker])).rows[0]?.unlocked === true);
      await verify();
    }
  }
  return result;
}

export async function observeHistoricalFrontendDatabaseFence(context) {
  const { plan, databaseClient: client, verifyLockedSession: verify } = context;
  demand(client && typeof verify === "function"); await verify();
  const expected = plan.historicalLogins.retiredLogins;
  const roles = (await client.query(`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
    FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
    [expected.map(row => row.name)])).rows;
  const memberships = (await client.query("SELECT count(*)::int AS count FROM pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])",
    [expected.map(row => row.oid)])).rows[0]?.count;
  const ownership = (await client.query(`SELECT count(*)::int AS count FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
    AND refobjid=ANY($1::oid[]) AND deptype='o'`, [expected.map(row => row.oid)])).rows[0]?.count;
  await client.query("SELECT pg_stat_clear_snapshot()");
  const sessions = (await client.query(`SELECT usesysid::text AS role_oid,datname,count(*)::int AS count FROM pg_stat_activity
    WHERE usesysid=ANY($1::oid[]) GROUP BY usesysid,datname ORDER BY usesysid,datname`, [expected.map(row => row.oid)])).rows;
  demand(roles.length === expected.length && roles.every(row => expected.some(role => role.name === row.rolname && role.oid === row.oid)));
  const result = { roles: roles.map(row => ({ name: row.rolname, oid: row.oid, canLogin: row.rolcanlogin })), sessions,
    retiredRolesDedicated: ownership === 0 && memberships === 0 && roles.every(row => ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].every(key => row[key] === false)),
    retiredLoginsDenied: roles.every(row => row.rolcanlogin === false), selectedSessions: sessions.reduce((n, row) => n + row.count, 0) };
  if ((await client.query("SELECT to_regnamespace('frontend_admission') IS NOT NULL AS present")).rows[0]?.present !== true) {
    await verify(); return { ...result, admissionOwnerVerified: false,
      admission: { installed: false, newWork: null, recovery: null, active: null, uncertain: null } };
  }
  const owner = (await client.query(`SELECT oid::text,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
    FROM pg_roles WHERE rolname=$1`, [plan.owner.name])).rows;
  demand(owner.length === 1 && owner[0].oid === plan.owner.oid &&
    ["rolcanlogin", "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].every(key => owner[0][key] === false));
  await client.query("BEGIN READ ONLY");
  let controls, operations;
  try {
    demand(/^[a-z][a-z0-9_]{0,62}$/u.test(plan.owner.name));
    await client.query(`SET LOCAL ROLE "${plan.owner.name}"`);
    controls = (await client.query("SELECT environment,target_sha256,new_work,recovery FROM frontend_admission.control WHERE singleton")).rows;
    operations = (await client.query("SELECT state,count(*)::int AS count FROM frontend_admission.operations WHERE state<>'completed' GROUP BY state ORDER BY state")).rows;
  } finally { await client.query("ROLLBACK"); }
  demand(controls.length === 1 && controls[0].environment === "staging" && controls[0].target_sha256 === plan.targetSha256);
  await verify();
  return { ...result, admissionOwnerVerified: true,
    admission: { newWork: controls[0].new_work, recovery: controls[0].recovery, active: operations.filter(row => row.state === "active").reduce((n, row) => n + row.count, 0),
      uncertain: operations.filter(row => row.state !== "active").reduce((n, row) => n + row.count, 0) } };
}
