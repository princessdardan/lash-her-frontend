// Child of test-frontend-migration-local.mjs only. No configured/live URL input.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { frontendWriterInventory } from "../frontend-writer-inventory.mjs";
import { changeFrontendAdmission, observeFrontendDrain, reconcileFrontendOperation } from "../frontend-admission.mjs";
import { seedReconciliationRows, assertReconciliationReceipts } from "./owned-reconciliation-rows.mjs";
import { reconciliationProviderStage, assertReconciliationProviderCalls } from "./owned-reconciliation-providers.mjs";

let phase = "configuration";
async function main() {
  assert.equal(process.env.FRONTEND_RECONCILIATION_OWNED_TEST, "true");
  const port = Number(process.env.OWNED_RECONCILIATION_PORT), password = process.env.OWNED_RECONCILIATION_PASSWORD;
  const major = Number(process.env.OWNED_RECONCILIATION_MAJOR);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.ok(/^owned-[a-f0-9-]{36}$/u.test(password ?? ""));
  assert.ok([16, 18].includes(major));
  const target = { environment: "staging", host: "127.0.0.1", port, database: "frontend_admission_owned",
    user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
  const url = `postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`;
  const { VERCEL_PROJECT_BINDINGS } = await import("../../../src/lib/env/application-environment.mjs");
  Object.assign(process.env, {
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(target),
    FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    PAYMENT_RECONCILIATION_CRON_SECRET: "owned-cron", SQUARE_COMMERCE_ENABLED: "true",
    SERVICE_BOOKING_SQUARE_ENABLED: "true", SQUARE_ENVIRONMENT: "sandbox", PAYMENT_GATEWAY_MODE: "live",
    SQUARE_ACCESS_TOKEN: "owned-unused-provider-key", SQUARE_LOCATION_ID: "owned-location",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "owned-unused-signature-key",
    SQUARE_SERVICE_BOOKING_RETURN_URL: "https://owned.invalid/api/booking/square/return",
    SQUARE_SERVICE_BOOKING_WEBHOOK_URL: "https://owned.invalid/api/webhooks/square",
    RESEND_API_KEY: "re_owned_unused", ADMIN_EMAIL: "owned@example.invalid", FROM_EMAIL: "owned@example.invalid",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "owned@example.invalid", NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
    NEXT_PUBLIC_SANITY_DATASET: "test-dataset",
  });
  const operator = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin",
    password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  const connections = [operator], checks = [], reconciliationEvidence = [], nativeFetch = globalThis.fetch;
  let server, closePool, gate, failProvider, providerInvariantFailure, unexpectedFetches = 0, activeCalls = [], logCount = 0;
  const requests = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  // Expected domain failures are inspected through durable rows and sanitized
  // public responses. Do not retain application log payloads or fixture secrets.
  console.log = console.warn = console.error = () => { logCount++; };
  try {
    let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
    const change = async (recovery) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork: false, recovery })).epoch; };
    const drain = () => observeFrontendDrain(operator, target, epoch);
    const operations = async () => (await operator.query("SELECT id,kind,state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
    const since = async (before) => (await operations()).filter(row => !before.some(old => old.id === row.id));
    const reconcile = async () => {
      await Promise.all(requests);
      await change(false);
      const unresolved = (await operations()).filter(row => row.state !== "completed");
      if (unresolved.length) {
        assert.equal((await drain()).ledgerDrained, false);
        await assert.rejects(change(true));
      }
      // All HTTP/provider work has finished before this deliberate fixture-only
      // owner action. The evidence binds the inspected durable terminal rows.
      const inspected = { operations: await operations(),
        attempts: (await operator.query("SELECT id,status,idempotency_key,provider_payment_id FROM booking_payment_attempts ORDER BY id")).rows,
        appointments: (await operator.query("SELECT id,booking_confirmation_email_sent_at,booking_confirmation_email_claimed_until,booking_confirmation_email_last_error FROM appointments ORDER BY id")).rows,
        orders: (await operator.query("SELECT order_id,status,provider_status,provider_metadata FROM checkout_orders ORDER BY order_id")).rows };
      const evidence = createHash("sha256").update(JSON.stringify(inspected)).digest("hex");
      reconciliationEvidence.push(evidence);
      for (const row of unresolved) await reconcileFrontendOperation(operator, target, epoch, row.id, evidence);
      assert.equal((await drain()).ledgerDrained, true);
      assert.equal((await drain()).migrationAuthorized, false);
      assert.equal((await drain()).historicalWritersFenced, false);
    };
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), selected = new URL(request.url);
      if (server && selected.origin === `http://127.0.0.1:${server.address().port}`)
        return nativeFetch(request);
      let stage;
      try { stage = reconciliationProviderStage(request); }
      catch (error) { unexpectedFetches++; throw error; }
      const active = (await operations()).filter(row => row.state === "active");
      if (process.env.FRONTEND_WRITER_ADMISSION_MODE === "enforce") {
        try {
          assert.equal(active.length, 1, `${stage}: provider effect requires one durable active entry`);
          assert.equal(active[0].kind, "recovery");
          const sessions = (await operator.query(`SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING(pid)
            WHERE usename=$1`, [target.user])).rows;
          assert.ok(sessions.length >= 2 && sessions.every(row => row.ssl === true));
        } catch (error) { providerInvariantFailure = error; throw error; }
      }
      activeCalls.push({ stage, method: request.method, path: selected.pathname });
      if (gate?.stage === stage && !gate.used) { gate.used = true; gate.enter(); await gate.wait; }
      if (failProvider === stage) return Response.json({ name: "owned_failure", message: "owned-private-provider-detail" }, { status: 500 });
      if (stage === "email") return Response.json({ id: "owned-email-receipt" });
      const id = selected.pathname.split("/")[3];
      const status = stage === "service" || selected.pathname.endsWith("/cancel") ? "CANCELED" : selected.pathname.endsWith("/complete") ? "COMPLETED" : "APPROVED";
      return Response.json({ payment: { id, status, amount_money: { amount: 1000, currency: "CAD" } } });
    };
    phase = "import-actual-route";
    const { GET } = await import("../../../src/app/api/admin/payment-reconciliation/route.ts");
    ({ closePrivateDbPool: closePool } = await import("../../../src/lib/private-db/client.ts"));
    const { runWriterAdmission } = await import("../../../src/lib/writer-admission/runtime.ts");
    server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/api/admin/payment-reconciliation"); assert.equal(request.method, "GET");
        const result = await GET(new Request(`http://127.0.0.1${request.url}`, {
          headers: request.headers.authorization ? { authorization: request.headers.authorization } : {},
        }));
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
      } catch { response.writeHead(500); response.end("OWNED_BRIDGE_FAILED"); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const performRequest = async (authorized = true) => {
      const result = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/admin/payment-reconciliation`, {
        headers: authorized ? { authorization: "Bearer owned-cron" } : {}, signal: AbortSignal.timeout(15000),
      });
      const text = await result.text();
      assert.equal(text.includes(password), false); assert.equal(text.includes("owned-private-provider-detail"), false);
      if (result.status === 503) {
        assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(result.headers.get("retry-after"), "30");
      }
      return { status: result.status, text };
    };
    const request = (authorized = true) => {
      const pending = performRequest(authorized); requests.push(pending);
      pending.catch(() => {}); return pending;
    };
    const until = async (predicate) => {
      for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await delay(25); }
      throw new Error("OWNED_OBSERVATION_TIMEOUT");
    };
    const holdProvider = (stage) => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      gate = { stage, used: false, enter, wait, release };
      return { entered: () => Promise.race([entered, delay(8000, undefined, { ref: false }).then(() => { throw new Error("OWNED_PROVIDER_GATE_TIMEOUT"); })]), release };
    };

    phase = "authentication-and-closed-policy";
    await seedReconciliationRows(operator);
    let before = await operations();
    assert.equal((await request(false)).status, 401);
    delete process.env.PAYMENT_RECONCILIATION_CRON_SECRET;
    assert.equal((await request()).status, 404);
    process.env.PAYMENT_RECONCILIATION_CRON_SECRET = "owned-cron";
    assert.equal((await request()).status, 503);
    assert.deepEqual(await since(before), []); assert.deepEqual(activeCalls, []);
    assert.equal((await operator.query("SELECT status FROM booking_payment_attempts")).rows[0].status, "authorized");
    checks.push("actual-http-authentication-and-closed-policy-refuse-before-ledger-business-or-provider-effects");

    phase = "empty-independent-entries";
    await seedReconciliationRows(operator, []); await change(true); before = await operations();
    let newWorkEffects = 0;
    await assert.rejects(runWriterAdmission("new-work", async () => { newWorkEffects++; })); assert.equal(newWorkEffects, 0);
    assert.equal((await request()).status, 200);
    assert.deepEqual((await since(before)).map(row => [row.kind, row.state]), Array.from({ length: 4 }, () => ["recovery", "completed"]));
    assertReconciliationProviderCalls(assert, activeCalls, []);
    await reconcile();
    checks.push("recovery-only-policy-admits-four-independent-empty-batches-and-refuses-new-work");

    phase = "nonempty-real-business-receipts";
    let ids = await seedReconciliationRows(operator); activeCalls = []; await change(true); before = await operations();
    assert.equal((await request()).status, 503);
    assert.deepEqual((await since(before)).map(row => row.state), ["uncertain", "completed", "completed", "completed"]);
    await assertReconciliationReceipts(assert, operator, ids);
    assertReconciliationProviderCalls(assert, activeCalls, ["service", "email", "split", "capture"]);
    await reconcile();
    checks.push("four-nonempty-batches-retain-independent-ledger-outcomes-and-real-business-receipts");

    for (const [index, stage] of ["service", "email", "split", "capture"].entries()) {
      phase = `close-during-${stage}`;
      ids = await seedReconciliationRows(operator); activeCalls = []; await change(true); before = await operations();
      const held = holdProvider(stage), pending = request();
      try {
        await held.entered();
        assert.equal((await drain()).active, 1);
        await change(false); assert.equal((await drain()).ledgerDrained, false);
        assert.equal((await request()).status, 503);
        assert.equal((await since(before)).length, index + 1);
      } finally { held.release(); }
      assert.equal((await pending).status, 503); gate = undefined;
      const rows = await since(before);
      assert.equal(rows.length, index + 1); assert.equal(rows.some(row => row.state === "active"), false);
      await assertReconciliationReceipts(assert, operator, ids, index + 1);
      assertReconciliationProviderCalls(assert, activeCalls, ["service", "email", "split", "capture"].slice(0, index + 1));
      await reconcile();
      checks.push(`policy-close-during-${stage}-retains-current-effects-refuses-new-entries-and-prevents-drain`);
    }

    phase = "failed-query-with-blocked-sibling";
    await seedReconciliationRows(operator, []); await change(true); before = await operations();
    const blocker = new Client({ ...operator.connectionParameters, ssl: operator.connectionParameters.ssl });
    connections.push(blocker); await blocker.connect();
    await blocker.query("BEGIN; LOCK checkout_payment_events IN ACCESS EXCLUSIVE MODE");
    await operator.query("REVOKE SELECT ON booking_policy_acceptances FROM frontend_admission_protocol");
    let pending = request();
    try {
      await until(async () => Number((await operator.query(`SELECT count(*) AS count FROM pg_stat_activity
        WHERE usename=$1 AND wait_event_type='Lock' AND query ILIKE '%checkout_payment_events%'`, [target.user])).rows[0].count) > 0);
      assert.equal((await drain()).active, 1); await change(false); assert.equal((await drain()).ledgerDrained, false);
    } finally {
      await operator.query("GRANT SELECT ON booking_policy_acceptances TO frontend_admission_protocol");
      await blocker.query("ROLLBACK");
    }
    assert.equal((await pending).status, 503);
    assert.deepEqual((await since(before)).map(row => row.state), ["uncertain"]); await reconcile();
    checks.push("failed-real-query-awaits-actually-blocked-sibling-before-uncertain-settlement");

    for (const stage of ["email", "split"]) {
      phase = `caught-${stage}-provider-failure`;
      await seedReconciliationRows(operator, [stage, "capture"]); activeCalls = []; failProvider = stage;
      await change(true); before = await operations();
      assert.equal((await request()).status, 503); failProvider = undefined;
      const states = (await since(before)).map(row => row.state);
      assert.deepEqual(states, stage === "email" ? ["completed", "uncertain", "completed", "completed"] : ["completed", "completed", "uncertain"]);
      const capture = (await operator.query("SELECT provider_status FROM checkout_orders WHERE order_id='owned-capture'")).rows[0];
      assert.equal(capture.provider_status, stage === "email" ? "COMPLETED" : "APPROVED");
      assertReconciliationProviderCalls(assert, activeCalls, stage === "email" ? ["email", "capture"] : ["split"], stage);
      await reconcile();
      checks.push(`caught-${stage}-provider-failure-retains-uncertainty-and-existing-sibling-order`);
    }

    phase = "actual-ledger-backend-death";
    ids = await seedReconciliationRows(operator, ["capture"]); activeCalls = []; await change(true); before = await operations();
    const held = holdProvider("capture"); pending = request();
    try {
      await held.entered(); await change(false);
      const sessions = (await operator.query(`SELECT pid FROM pg_stat_activity WHERE usename=$1
        AND application_name='lash-her-frontend-writer-admission'`, [target.user])).rows;
      assert.equal(sessions.length, 1);
      await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]);
      await delay(25);
    } finally { held.release(); }
    assert.equal((await pending).status, 503); gate = undefined;
    assert.deepEqual((await since(before)).map(row => row.state), ["completed", "completed", "completed", "active"]);
    assertReconciliationProviderCalls(assert, activeCalls, ["capture"]);
    await assertReconciliationReceipts(assert, operator, ids); await reconcile();
    checks.push("actual-ledger-backend-death-retains-active-operation-without-replaying-capture-or-receipt");

    phase = "invalid-intent-and-admission-off";
    for (const mode of ["enforce", "off"]) {
      await seedReconciliationRows(operator, ["invalid-intent"]); activeCalls = []; before = await operations();
      await change(true); process.env.FRONTEND_WRITER_ADMISSION_MODE = mode;
      assert.equal((await request()).status, mode === "enforce" ? 503 : 200);
      assert.deepEqual((await since(before)).map(row => row.state), mode === "enforce" ? ["uncertain", "completed", "completed", "completed"] : []);
      assert.deepEqual(activeCalls, []); await reconcile();
    }
    checks.push("actual-malformed-business-intent-remains-uncertain-under-enforcement-and-preserves-off-mode");
    assert.equal(unexpectedFetches, 0);
    if (providerInvariantFailure) throw providerInvariantFailure;
    return { status: "FRONTEND_RECONCILIATION_OWNED_PASS", postgresMajor: major, checks, reconciliationEvidence,
      applicationSourceManifestSha256: frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url))).sourceManifestSha256,
      syntheticLedgerSourceIdentity: true,
      actualRouteExport: true, loopbackHttp: true, verifiedPostgresTls: true, realBusinessDatabase: true,
      providersIntercepted: true, providerTouched: false, historicalWritersFenced: false, migrationAuthorized: false,
      applicationLogsSuppressed: logCount > 0 };
  } finally {
    gate?.release();
    await Promise.allSettled(requests);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await closePool?.();
    for (const client of connections) { try { await client.end(); } catch { /* owned fixture only */ } }
    globalThis.fetch = nativeFetch; Object.assign(console, originalConsole);
  }
}

main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`${JSON.stringify({ status: "FRONTEND_RECONCILIATION_OWNED_FAILED", phase,
    code: error.code, assertion: error instanceof assert.AssertionError ? error.message : undefined,
    frames: error.stack?.split("\n").filter(line => /owned-(?:frontend-reconciliation|reconciliation-rows)\.mjs/u.test(line)) })}\n`);
  process.exitCode = 1;
});
