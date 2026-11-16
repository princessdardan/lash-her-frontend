import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const runnerProjectId = "prj_B7bEG3kusrfasLFFVNg4Sj3nLzzM";
const runnerHost = "lash-her-production-backup-runner.vercel.app";
const projectId = "ancient-wave-93726207";
const sourceBranchId = "br-rough-frost-aqtdtxln";
const sourceEndpointId = "ep-morning-shadow-aqyf179j";
const sourceEndpointHost = "ep-morning-shadow-aqyf179j.c-8.us-east-1.aws.neon.tech";
const database = "neondb";
const role = "neondb_owner";
const maxSnapshotAge = 8 * 24 * 60 * 60 * 1000;
const pitrLookbackSeconds = 60 * 60;
const neonProjectUrl = `https://console.neon.tech/api/v2/projects/${projectId}`;

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handleRestore(req, res) {
  const executionId = req.headers["x-backup-execution-id"];
  const secret = process.env.BACKUP_VALIDATION_RUNNER_SECRET;
  const key = process.env.NEON_BACKUP_PROJECT_API_KEY;
  if (process.env.VERCEL_PROJECT_ID !== runnerProjectId || process.env.VERCEL_ENV !== "production" ||
      req.headers.host !== runnerHost || !/^[a-f0-9]{64}$/.test(secret ?? "") || !key) {
    return json(res, 404, { validationPerformed: false });
  }

  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (req.method !== "POST" || actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
      typeof executionId !== "string" || !/^schx_[A-Z0-9]{10,64}$/.test(executionId)) {
    return json(res, 404, { validationPerformed: false });
  }

  try {
    const proof = await validateRestore(key);
    const receipt = { executionId, ...proof };
    console.info(JSON.stringify({ event: "production_backup_restore_verified", ...receipt }));
    return json(res, 200, receipt);
  } catch (error) {
    const code = /^[a-z_]+$/.test(error?.message) ? error.message : "provider_or_database_error";
    console.error(JSON.stringify({ event: "production_backup_restore_failed", executionId, code }));
    return json(res, 503, { validationPerformed: false });
  }
}

async function validateRestore(key) {
  const workDeadline = AbortSignal.timeout(125_000);
  async function neon(path, { method = "GET", body, cleanup = false, missingOk = false } = {}) {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(neonProjectUrl + path, {
      method,
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: cleanup ? timeout : AbortSignal.any([workDeadline, timeout]),
    });
    if (missingOk && response.status === 404) return null;
    requireCondition(response.ok, "neon_request_failed");
    return response.status === 204 ? {} : response.json();
  }


  async function waitForOperations(operations = [], cleanupSignal) {
    const signal = cleanupSignal ?? workDeadline;
    let pending = operations;
    for (;;) {
      signal.throwIfAborted();
      requireCondition(!pending.some(({ status }) => status === "failed" || status === "cancelled"),
        "neon_operation_failed");
      pending = pending.filter(({ status }) => status !== "finished" && status !== "skipped");
      if (pending.length === 0) return;
      requireCondition(pending.every(({ id }) => /^[a-f0-9-]{36}$/i.test(id)), "neon_operation_identity_mismatch");
      await delay(1000, undefined, { signal });
      pending = await Promise.all(pending.map(async ({ id }) => {
        const { operation } = await neon(`/operations/${id}`, { cleanup: Boolean(cleanupSignal) });
        requireCondition(operation?.id === id, "neon_operation_identity_mismatch");
        return operation;
      }));
    }
  }

  async function databaseEndpoint(branchId, forbiddenIds = [], type = "read_write") {
    const { endpoints } = await neon(`/branches/${branchId}/endpoints`);
    const endpoint = endpoints.find((candidate) => candidate.type === type);
    requireCondition(endpoint?.branch_id === branchId &&
      /^ep-[a-z0-9-]+$/.test(endpoint.id) &&
      endpoint.host.startsWith(`${endpoint.id}.`) && endpoint.host.endsWith(".neon.tech") &&
      !forbiddenIds.includes(endpoint.id), "endpoint_identity_mismatch");
    return endpoint;
  }

  async function inspectDatabase(branchId, endpoint) {
    const parameters = new URLSearchParams({ branch_id: branchId, endpoint_id: endpoint.id,
      database_name: database, role_name: role, pooled: "false" });
    const { uri } = await neon(`/connection_uri?${parameters}`);
    const url = new URL(uri);
    requireCondition(url.protocol === "postgresql:" && url.hostname === endpoint.host &&
      (url.port === "" || url.port === "5432") && url.pathname === `/${database}` &&
      url.username === role && url.password.length > 0, "database_uri_mismatch");
    url.search = "?sslmode=verify-full";

    const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 15_000, query_timeout: 7_000 });
    try {
      await client.connect();
      requireCondition(client.connection.stream.authorized === true, "database_tls_unverified");
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const { rows: [identity] } = await client.query(`SELECT current_user AS role, current_database() AS database,
        current_setting('transaction_read_only') AS read_only`);
      requireCondition(identity.role === role && identity.database === database && identity.read_only === "on",
        "database_identity_mismatch");
      const { rows: lineage } = await client.query("SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id");
      const { rows: schema } = await client.query(`SELECT table_name, column_name, data_type, udt_name, is_nullable
        FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
      const { rows: [integrity] } = await client.query(`SELECT
        to_regclass('public.training_enrollments') IS NOT NULL AS enrollments,
        to_regclass('public.customer_email_outbox') IS NOT NULL AS outbox,
        NOT EXISTS (SELECT 1 FROM public.order_payment_obligations AS obligation
          LEFT JOIN public.checkout_orders AS checkout ON checkout.id = obligation.order_id
          WHERE checkout.id IS NULL) AS payment_integrity`);
      await client.query("COMMIT");
      requireCondition(integrity.enrollments && integrity.outbox && integrity.payment_integrity && lineage.length > 0,
        "database_integrity_failed");
      const hash = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      return { migrationCount: lineage.length, lineage: hash(lineage), schema: hash(schema) };
    } finally {
      await client.end();
    }
  }

  const [{ snapshots }, { branch: source }, sourceEndpoint] = await Promise.all([
    neon("/snapshots"), neon(`/branches/${sourceBranchId}`), databaseEndpoint(sourceBranchId),
  ]);
  requireCondition(source.id === sourceBranchId && source.project_id === projectId &&
    source.default === true && source.name === "main" && sourceEndpoint.id === sourceEndpointId &&
    sourceEndpoint.host === sourceEndpointHost, "source_identity_mismatch");
  const now = Date.now();
  const snapshot = snapshots.filter((entry) => entry.source_branch_id === sourceBranchId &&
    /^snap-[a-z0-9-]+$/.test(entry.id) && Date.parse(entry.created_at) <= now &&
    now - Date.parse(entry.created_at) <= maxSnapshotAge)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];

  let recoveryPointAt = snapshot?.created_at;
  if (!snapshot) {
    const [{ schedule }, { project }] = await Promise.all([
      neon(`/branches/${sourceBranchId}/backup_schedule`), neon(""),
    ]);
    requireCondition(Array.isArray(schedule) && schedule.length === 0, "fresh_production_snapshot_missing");
    requireCondition(project.id === projectId &&
      project.history_retention_seconds >= pitrLookbackSeconds + 900, "production_recovery_history_unavailable");
    recoveryPointAt = new Date(Math.floor(now / 1000) * 1000 - pitrLookbackSeconds * 1000).toISOString();
  }

  const name = `prod-backup-restore-${randomUUID()}`;
  let branchId;
  let inspected;
  const isRestoreBranch = (branch) => branch?.name === name && branch.project_id === projectId &&
    branch.id !== sourceBranchId && /^br-[a-z0-9-]+$/.test(branch.id) && !branch.default && !branch.protected;

  try {
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString().replace(".000Z", "Z");
    const restored = snapshot
      ? await neon(`/snapshots/${snapshot.id}/restore`, {
        method: "POST",
        body: { name, finalize_restore: false },
      })
      : await neon("/branches", {
        method: "POST",
        body: { branch: { name, parent_id: sourceBranchId, parent_timestamp: recoveryPointAt,
          expires_at: expiresAt }, endpoints: [{ type: "read_only" }] },
      });
    const branch = restored.branch ?? restored.restored_branch;
    requireCondition(isRestoreBranch(branch), "restore_branch_identity_mismatch");
    branchId = branch.id;
    await waitForOperations(restored.operations);
    if (snapshot) {
      await neon(`/branches/${branchId}`, { method: "PATCH", body: { branch: { expires_at: expiresAt } } });
    } else {
      requireCondition(branch.parent_id === sourceBranchId &&
        /^[a-f0-9]+\/[a-f0-9]+$/i.test(branch.parent_lsn ?? "") &&
        Date.parse(branch.expires_at) === Date.parse(expiresAt), "historical_restore_point_mismatch");
    }

    const [restoreEndpoint, currentSourceEndpoint] = await Promise.all([
      databaseEndpoint(branchId, [sourceEndpoint.id], snapshot ? "read_write" : "read_only"),
      databaseEndpoint(sourceBranchId),
    ]);
    requireCondition(currentSourceEndpoint.id === sourceEndpoint.id && currentSourceEndpoint.host === sourceEndpoint.host,
      "source_endpoint_changed");
    const [target, current] = await Promise.all([
      inspectDatabase(branchId, restoreEndpoint), inspectDatabase(sourceBranchId, sourceEndpoint),
    ]);
    requireCondition(target.lineage === current.lineage && target.schema === current.schema, "restored_schema_or_lineage_differs");
    inspected = target;
  } finally {
    if (!branchId) {
      const { branches } = await neon(`/branches?search=${encodeURIComponent(name)}`, { cleanup: true });
      branchId = branches.find(isRestoreBranch)?.id;
    }
    if (branchId) {
      const path = `/branches/${branchId}`;
      const result = await neon(path, { cleanup: true, missingOk: true });
      if (result) {
        requireCondition(isRestoreBranch(result.branch), "cleanup_branch_identity_mismatch");
        const deletion = await neon(path, { method: "DELETE", cleanup: true, missingOk: true });
        await waitForOperations(deletion?.operations, AbortSignal.timeout(30_000));
      }
      requireCondition(await neon(path, { cleanup: true, missingOk: true }) === null, "restore_cleanup_unverified");
    }
  }

  return { validationPerformed: true, provider: "neon",
    recoverySource: snapshot ? "snapshot" : "point_in_time", recoveryPointAt,
    ...(snapshot ? { snapshot: snapshot.id } : {}), migrationCount: inspected.migrationCount,
    isolatedRestore: true, sourcePreserved: true, cleanupVerified: true,
    migrationLineageMatches: true, schemaMatches: true, readOnly: true, tlsVerified: true };
}
