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
import { exerciseShippingExecution } from "./owned-shipping-execution.mjs";

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
    CHITCHATS_SHIPPING_ENABLED: "false", ADMIN_OWNER_EMAILS: "owned@example.invalid",
    CHECKOUT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), CRON_SECRET: "owned-cron",
  });
  const operator = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin",
    password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  const connections = [operator], checks = [], reconciliationEvidence = [], nativeFetch = globalThis.fetch;
  let server, closePool, gate, failProvider, providerInvariantFailure, expectedOutboxKey, stockProviderMode, refundProviderMode, expectedRefundKey, unexpectedFetches = 0, activeCalls = [], logCount = 0;
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
        orders: (await operator.query("SELECT order_id,status,provider_status,provider_metadata FROM checkout_orders ORDER BY order_id")).rows,
        stock: (await operator.query("SELECT id,on_hand,reserved FROM product_stock ORDER BY id")).rows,
        refunds: (await operator.query("SELECT id,status,idempotency_key,provider_refund_id,lease_owner,lease_expires_at FROM product_order_refunds ORDER BY id")).rows,
        adjustments: (await operator.query("SELECT id,status FROM product_order_adjustments ORDER BY id")).rows,
        stockMovements: (await operator.query("SELECT order_id,kind,quantity FROM product_stock_movements ORDER BY id")).rows,
        obligations: (await operator.query("SELECT order_id,status FROM order_payment_obligations ORDER BY id")).rows,
        shipments: (await operator.query("SELECT order_id,status FROM product_shipments ORDER BY id")).rows,
        shipmentJobs: (await operator.query("SELECT shipment_id,type,status,idempotency_key,operation_payload_hash,payload FROM product_shipment_jobs ORDER BY id")).rows,
        outbox: (await operator.query("SELECT id,kind,status,provider_message_id,provider_idempotency_key,lease_owner,lease_expires_at FROM customer_email_outbox ORDER BY id")).rows };
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
          if (expectedOutboxKey) assert.equal(request.headers.get("idempotency-key"), expectedOutboxKey);
        } catch (error) { providerInvariantFailure = error; throw error; }
      }
      activeCalls.push({ stage, method: request.method, path: selected.pathname });
      if (gate?.stage === stage && !gate.used) { gate.used = true; gate.enter(); await gate.wait; }
      if (stage === "refund-worker") {
        const body = await request.json();
        try { assert.deepEqual(body, { idempotency_key: expectedRefundKey, payment_id: "owned-refund-payment", amount_money: { amount: 1000, currency: "CAD" } }); }
        catch (error) { providerInvariantFailure = error; throw error; }
      }
      if (failProvider === stage) return Response.json({ name: "owned_failure", message: "owned-private-provider-detail" }, { status: 500 });
      if (stage === "email") return Response.json({ id: "owned-email-receipt" });
      if (stage === "stock") return Response.json(stockProviderMode === "malformed" ? { payments: [{ id: "owned-malformed" }] } :
        stockProviderMode === "bounded" ? { payments: [], cursor: "owned-next" } :
        stockProviderMode === "captured" ? { payments: [{ id: "owned-stock-payment", reference_id: "owned-stock-order", status: "COMPLETED", amount_money: { amount: 1000, currency: "CAD" } }] } : { payments: [] });
      if (stage === "refund-worker") {
        if (refundProviderMode === "rejected") return Response.json({ errors: [{ code: "BAD_REQUEST" }] }, { status: 400 });
        return Response.json({ refund: { id: "owned-worker-refund", status: refundProviderMode === "pending" ? "PENDING" : "COMPLETED",
          ...(refundProviderMode === "missing-payment-id" ? {} : { payment_id: refundProviderMode === "mismatched-payment" ? "unrelated-payment" : "owned-refund-payment" }),
          amount_money: { amount: 1000, currency: "CAD" } } });
      }
      const id = selected.pathname.split("/")[3];
      const status = stage === "service" || selected.pathname.endsWith("/cancel") ? "CANCELED" : selected.pathname.endsWith("/complete") ? "COMPLETED" : "APPROVED";
      return Response.json({ payment: { id, status, amount_money: { amount: 1000, currency: "CAD" } } });
    };
    phase = "import-actual-route";
    const { GET } = await import("../../../src/app/api/admin/payment-reconciliation/route.ts");
    const { GET: outboxGet } = await import("../../../src/app/api/cron/customer-email-outbox/route.ts");
    const { GET: refundGet } = await import("../../../src/app/api/cron/chitchats-shipping/route.ts");
    const { queueProductOrderRefundAllocations } = await import("../../../src/lib/shipping/customer-refunds.ts");
    const { GET: stockGet } = await import("../../../src/app/api/cron/product-stock-reservations/route.ts");
    ({ closePrivateDbPool: closePool } = await import("../../../src/lib/private-db/client.ts"));
    const { runWriterAdmission } = await import("../../../src/lib/writer-admission/runtime.ts");
    server = createServer(async (request, response) => {
      try {
        assert.ok(["/api/admin/payment-reconciliation", "/api/cron/customer-email-outbox", "/api/cron/product-stock-reservations", "/api/cron/chitchats-shipping"].includes(request.url)); assert.equal(request.method, "GET");
        const selectedGet = request.url === "/api/cron/chitchats-shipping" ? refundGet : request.url === "/api/cron/product-stock-reservations" ? stockGet : request.url === "/api/cron/customer-email-outbox" ? outboxGet : GET;
        const result = await selectedGet(new Request(`http://127.0.0.1${request.url}`, {
          headers: request.headers.authorization ? { authorization: request.headers.authorization } : {},
        }));
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
      } catch { response.writeHead(500); response.end("OWNED_BRIDGE_FAILED"); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const performRequest = async (authorized = true, path = "/api/admin/payment-reconciliation", token = "owned-cron") => {
      const result = await nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, {
        headers: authorized ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000),
      });
      const text = await result.text();
      assert.equal(text.includes(password), false); assert.equal(text.includes("owned-private-provider-detail"), false);
      if (result.status === 503) {
        assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(result.headers.get("retry-after"), "30");
      }
      return { status: result.status, text };
    };
    const request = (authorized = true, path, token) => {
      const pending = performRequest(authorized, path, token); requests.push(pending);
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

    const { encryptCustomerEmailOutboxValue: encrypt } = await import("../../../src/lib/commerce/customer-email-outbox-cipher.ts");
    const outboxRequest = (authorized = true) => request(authorized, "/api/cron/customer-email-outbox");
    const seedOutbox = async (kind = "alert") => {
      await operator.query("TRUNCATE customer_email_outbox");
      await seedReconciliationRows(operator, []); activeCalls = [];
      process.env.FRONTEND_WRITER_ADMISSION_MODE = "enforce";
      expectedOutboxKey = kind === "product" ? "product-confirmation:owned-outbox-product" : "owned-outbox-alert-key";
      if (kind === "empty") return;
      if (kind === "product") {
        await operator.query(`INSERT INTO checkout_orders(order_id,purpose,status,payment_provider,provider_status,
          customer_name,customer_email,amount_cents,line_items,paid_at)
          VALUES('owned-outbox-product','product','paid','square','COMPLETED','Owned fixture','owned@example.invalid',1000,'[]',now())`);
        return;
      }
      await operator.query(`INSERT INTO customer_email_outbox(kind,recipient_ciphertext,template_data_ciphertext,
        provider_idempotency_key,redaction_due_at) VALUES('shipping_policy_alert',$1,$2,$3,now()+interval '1 day')`,
      [encrypt("owned@example.invalid", "recipient"), kind === "malformed" ? "owned-invalid-ciphertext" :
        encrypt({ subject: "Owned fixture", message: "Owned fixture", critical: false }, "payload"), expectedOutboxKey]);
    };
    const outboxRows = async () => (await operator.query("SELECT status,provider_message_id,provider_idempotency_key,lease_owner,lease_expires_at,attempt_count FROM customer_email_outbox")).rows;
    const assertOutboxSent = async () => {
      const rows = await outboxRows(); assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "sent"); assert.equal(rows[0].provider_message_id, "owned-email-receipt");
      assert.equal(rows[0].provider_idempotency_key, expectedOutboxKey);
      assert.equal(rows[0].lease_owner, null); assert.equal(rows[0].lease_expires_at, null);
      assertReconciliationProviderCalls(assert, activeCalls, ["email"]);
    };

    phase = "customer-email-authentication-and-closed-admission";
    await seedOutbox(); before = await operations();
    assert.equal((await outboxRequest(false)).status, 401);
    delete process.env.CRON_SECRET; assert.equal((await outboxRequest()).status, 404); process.env.CRON_SECRET = "owned-cron";
    assert.equal((await outboxRequest()).status, 503);
    assert.deepEqual(await since(before), []); assert.deepEqual(activeCalls, []);
    assert.equal((await outboxRows())[0].status, "queued");
    checks.push("customer-email-authentication-and-closed-admission-refuse-before-claims-or-delivery");

    phase = "customer-email-empty-and-product-backfill";
    await seedOutbox("empty"); await change(true); before = await operations();
    assert.equal((await outboxRequest()).status, 200);
    assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); assert.deepEqual(activeCalls, []); await reconcile();
    checks.push("customer-email-empty-batch-completes-one-independent-recovery-entry");
    await seedOutbox("product"); await change(true); before = await operations();
    assert.equal((await outboxRequest()).status, 200); await assertOutboxSent();
    const productReceipt = (await operator.query("SELECT product_confirmation_email_sent_at,product_confirmation_email_claimed_until FROM checkout_orders WHERE order_id='owned-outbox-product'")).rows[0];
    assert.ok(productReceipt.product_confirmation_email_sent_at); assert.equal(productReceipt.product_confirmation_email_claimed_until, null);
    assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); await reconcile();
    checks.push("customer-email-real-product-backfill-encrypted-claim-provider-key-and-atomic-order-receipt");

    phase = "customer-email-policy-close-and-expired-lease";
    await seedOutbox(); await change(true); before = await operations();
    let outboxHeld = holdProvider("email"), outboxPending = outboxRequest();
    try {
      await outboxHeld.entered();
      await operator.query("UPDATE customer_email_outbox SET lease_expires_at=now()-interval '1 hour'");
      await change(false); assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
      assert.equal((await outboxRequest()).status, 503); assert.equal((await since(before)).length, 1);
    } finally { outboxHeld.release(); }
    assert.equal((await outboxPending).status, 200); gate = undefined;
    await assertOutboxSent(); await reconcile();
    checks.push("customer-email-close-refuses-new-claims-and-expired-business-lease-does-not-drain-active-delivery");

    for (const kind of ["provider-failure", "malformed"]) {
      phase = `customer-email-${kind}`;
      await seedOutbox(kind); await change(true); before = await operations();
      failProvider = kind === "provider-failure" ? "email" : undefined;
      assert.equal((await outboxRequest()).status, 503); failProvider = undefined;
      assert.deepEqual((await since(before)).map(row => row.state), ["uncertain"]);
      const rows = await outboxRows(); assert.equal(rows.length, 1); assert.equal(rows[0].status, "failed");
      assert.equal(rows[0].attempt_count, 1); assert.equal(rows[0].lease_owner, null);
      assertReconciliationProviderCalls(assert, activeCalls, kind === "provider-failure" ? ["email"] : []);
      await reconcile(); checks.push(`customer-email-${kind}-retains-real-failure-receipt-and-ledger-uncertainty`);
    }

    for (const fault of ["missing-receipt", "ledger-backend-death"]) {
      phase = `customer-email-${fault}`;
      await seedOutbox(); await change(true); before = await operations();
      outboxHeld = holdProvider("email"); outboxPending = outboxRequest();
      try {
        await outboxHeld.entered(); await change(false);
        if (fault === "missing-receipt") await operator.query("DELETE FROM customer_email_outbox");
        else {
          const sessions = (await operator.query(`SELECT pid FROM pg_stat_activity WHERE usename=$1
            AND application_name='lash-her-frontend-writer-admission'`, [target.user])).rows;
          assert.equal(sessions.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]);
          await delay(25);
        }
      } finally { outboxHeld.release(); }
      assert.equal((await outboxPending).status, 503); gate = undefined;
      assert.deepEqual((await since(before)).map(row => row.state), [fault === "missing-receipt" ? "uncertain" : "active"]);
      if (fault === "missing-receipt") assert.deepEqual(await outboxRows(), []);
      else await assertOutboxSent();
      assertReconciliationProviderCalls(assert, activeCalls, ["email"]);
      await reconcile(); checks.push(`customer-email-${fault}-refuses-success-without-replaying-real-delivery`);
    }
    const stockRequest = (authorized = true) => request(authorized, "/api/cron/product-stock-reservations");
    const seedStock = async (mode = "absent") => {
      await seedReconciliationRows(operator, []);
      await operator.query("TRUNCATE product_stock CASCADE");
      expectedOutboxKey = undefined; stockProviderMode = mode; activeCalls = [];
      if (mode === "empty") return;
      const order = (await operator.query(`INSERT INTO checkout_orders(order_id,purpose,status,payment_provider,
        customer_name,customer_email,amount_cents,line_items,created_at,pii_redaction_due_at)
        VALUES('owned-stock-order','product','pending','square','Owned fixture','owned@example.invalid',1000,'[]','2020-01-01T12:00:00Z','2020-12-30T12:00:00Z') RETURNING id`)).rows[0].id;
      await operator.query(`INSERT INTO order_payment_obligations(order_id,purpose,status,merchandise_amount_cents,
        shipping_amount_cents,tax_amount_cents,total_amount_cents,currency,source_workflow,tax_policy_version,policy_version,
        payment_provider,initialization_status,idempotency_key,expires_at)
        VALUES($1,'primary','pending',1000,0,0,1000,'CAD','owned-stock','owned','owned','square','ready','owned-stock-key',now()-interval '3 hours')`, [order]);
      const stock = (await operator.query(`INSERT INTO product_stock(product_id,on_hand,reserved)
        VALUES('owned-stock-product',10,$1) RETURNING id`, [mode === "missing-stock-receipt" ? 0 : 2])).rows[0].id;
      await operator.query(`INSERT INTO product_stock_movements(product_stock_id,order_id,kind,quantity)
        VALUES($1,'owned-stock-order','reserve',2)`, [stock]);
      if (mode === "no-shipment") return;
      await operator.query(`INSERT INTO product_shipments(order_id,public_reference,quote_token_hash,quote_fingerprint,
        status,destination,package_snapshot,customs_lines,rates,quote_expires_at)
        VALUES($1,'owned-stock-shipment','owned-stock-token','owned-stock-fingerprint','payment_pending','{}','{}','[]','[]',now()+interval '1 hour')`, [order]);
    };
    const assertStockReceipt = async (released = true, missingMovement = false, shipmentMode = "normal") => {
      const orders = (await operator.query("SELECT status FROM checkout_orders WHERE order_id='owned-stock-order'")).rows;
      assert.equal(orders.length, 1); assert.equal(orders[0].status, released ? "cancelled" : "pending");
      const obligations = (await operator.query("SELECT status,idempotency_key FROM order_payment_obligations")).rows;
      assert.equal(obligations.length, 1); assert.equal(obligations[0].status, released ? "cancelled" : "pending");
      assert.equal(obligations[0].idempotency_key, "owned-stock-key");
      const stock = (await operator.query("SELECT on_hand,reserved FROM product_stock")).rows;
      assert.deepEqual(stock, [{ on_hand: 10, reserved: released ? 0 : 2 }]);
      const movements = (await operator.query("SELECT kind,quantity FROM product_stock_movements ORDER BY kind::text")).rows;
      assert.deepEqual(movements, released && !missingMovement ? [{ kind: "release", quantity: 2 }, { kind: "reserve", quantity: 2 }] : [{ kind: "reserve", quantity: 2 }]);
      const shipments = (await operator.query("SELECT status FROM product_shipments")).rows;
      assert.deepEqual(shipments, shipmentMode === "no-shipment" ? [] : [{ status: released && shipmentMode !== "missing-shipment-receipt" ? "abandoned" : "payment_pending" }]);
    };
    phase = "stock-authentication-and-closed-admission";
    await seedStock(); before = await operations();
    assert.equal((await stockRequest(false)).status, 401);
    delete process.env.CRON_SECRET; assert.equal((await stockRequest()).status, 404); process.env.CRON_SECRET = "owned-cron";
    assert.equal((await stockRequest()).status, 503); assert.deepEqual(await since(before), []); assert.deepEqual(activeCalls, []);
    await assertStockReceipt(false); checks.push("stock-authentication-and-closed-admission-refuse-before-selection-provider-or-cleanup");

    phase = "stock-empty";
    await seedStock("empty"); await change(true); before = await operations();
    assert.equal((await stockRequest()).status, 200); assert.deepEqual((await since(before)).map(row => row.state), ["completed"]);
    assert.deepEqual(activeCalls, []); await reconcile(); checks.push("stock-empty-batch-completes-independent-recovery-entry");

    for (const mode of ["absent", "captured", "provider-failure", "malformed", "bounded", "missing-stock-receipt", "missing-movement-receipt", "missing-shipment-receipt", "no-shipment"]) {
      phase = `stock-${mode}`;
      await seedStock(mode); await change(true); before = await operations();
      failProvider = mode === "provider-failure" ? "stock" : undefined;
      if (mode === "missing-movement-receipt") {
        await operator.query("CREATE FUNCTION pg_temp.suppress_owned_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
        await operator.query("CREATE TRIGGER owned_missing_release BEFORE INSERT ON product_stock_movements FOR EACH ROW WHEN (NEW.kind = 'release') EXECUTE FUNCTION pg_temp.suppress_owned_release()");
      }
      if (mode === "missing-shipment-receipt") {
        await operator.query("CREATE FUNCTION pg_temp.suppress_owned_abandonment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
        await operator.query("CREATE TRIGGER owned_missing_abandonment BEFORE UPDATE ON product_shipments FOR EACH ROW WHEN (NEW.status = 'abandoned') EXECUTE FUNCTION pg_temp.suppress_owned_abandonment()");
      }
      let result;
      try { result = await stockRequest(); }
      finally {
        failProvider = undefined;
        if (mode === "missing-movement-receipt") await operator.query("DROP TRIGGER owned_missing_release ON product_stock_movements");
        if (mode === "missing-shipment-receipt") await operator.query("DROP TRIGGER owned_missing_abandonment ON product_shipments");
      }
      const completed = ["absent", "captured", "no-shipment"].includes(mode);
      assert.equal(result.status, completed ? 200 : 503);
      assert.deepEqual((await since(before)).map(row => row.state), [completed ? "completed" : "uncertain"]);
      await assertStockReceipt(mode !== "captured", mode === "missing-movement-receipt", mode);
      const expectedCalls = Array.from({ length: mode === "bounded" ? 4 : 1 }, () => ({ stage: "stock", method: "GET", path: "/v2/payments" }));
      assert.deepEqual(activeCalls, expectedCalls);
      if (mode === "absent") {
        assert.deepEqual(JSON.parse(result.text), { scanned: 1, released: 1, skipped: 0, failed: 0 });
        assert.equal((await stockRequest()).status, 200); await assertStockReceipt(); assert.deepEqual(activeCalls, expectedCalls);
      }
      await reconcile(); checks.push(`stock-${mode}-real-stock-order-obligation-and-shipment-receipts-accounted`);
    }

    phase = "stock-closure-during-locked-cleanup";
    await seedStock(); await change(true); before = await operations();
    const stockBlocker = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin",
      password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
    connections.push(stockBlocker); await stockBlocker.connect(); await stockBlocker.query("BEGIN");
    await stockBlocker.query("SELECT id FROM checkout_orders WHERE order_id='owned-stock-order' FOR UPDATE");
    let stockPending = stockRequest();
    try {
      await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
      await change(false); assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
      assert.equal((await stockRequest()).status, 503); assert.equal((await since(before)).length, 1);
    } finally { await stockBlocker.query("ROLLBACK"); }
    assert.equal((await stockPending).status, 200); await assertStockReceipt();
    assertReconciliationProviderCalls(assert, activeCalls, ["stock"]); await reconcile();
    checks.push("stock-close-retains-active-entry-through-actually-blocked-transaction-and-refuses-new-sweep");

    phase = "stock-ledger-backend-death";
    await seedStock(); await change(true); before = await operations();
    const stockHeld = holdProvider("stock"); stockPending = stockRequest();
    try {
      await stockHeld.entered(); await change(false);
      const sessions = (await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'", [target.user])).rows;
      assert.equal(sessions.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]); await delay(25);
    } finally { stockHeld.release(); }
    assert.equal((await stockPending).status, 503); gate = undefined;
    assert.deepEqual((await since(before)).map(row => row.state), ["active"]);
    await assertStockReceipt(); assertReconciliationProviderCalls(assert, activeCalls, ["stock"]); await reconcile();
    checks.push("stock-ledger-backend-death-retains-unresolved-entry-without-replaying-committed-cleanup");
    const refundRequest = (authorized = true) => request(authorized, "/api/cron/chitchats-shipping");
    const seedRefund = async (mode = "settled") => {
      await seedReconciliationRows(operator, []);
      await operator.query("TRUNCATE customer_email_outbox CASCADE");
      expectedOutboxKey = undefined; expectedRefundKey = undefined; refundProviderMode = mode; activeCalls = [];
      if (mode === "empty") return;
      const order = (await operator.query(`INSERT INTO checkout_orders(order_id,purpose,status,payment_provider,provider_payment_id,
        customer_name,customer_email,amount_cents,merchandise_amount_cents,line_items,paid_at)
        VALUES('owned-refund-order','product','paid','square','owned-refund-payment','Owned fixture','owned@example.invalid',1000,1000,'[]',now()) RETURNING id`)).rows[0].id;
      const obligation = (await operator.query(`INSERT INTO order_payment_obligations(order_id,purpose,status,merchandise_amount_cents,
        shipping_amount_cents,tax_amount_cents,total_amount_cents,currency,source_workflow,tax_policy_version,policy_version,
        payment_provider,initialization_status,idempotency_key,paid_at)
        VALUES($1,'primary','paid',1000,0,0,1000,'CAD','owned-refund','owned','owned','square','ready','owned-refund-obligation',now()) RETURNING id`, [order])).rows[0].id;
      await operator.query(`INSERT INTO order_payment_transactions(obligation_id,provider,provider_transaction_id,amount_cents,currency,
        provider_type,provider_status,risk_status,risk_reason_codes,captured_at)
        VALUES($1,'square','owned-refund-payment',1000,'CAD','PAYMENT','COMPLETED','cleared','[]',now())`, [obligation]);
      const [refund] = await queueProductOrderRefundAllocations({ orderReference: "owned-refund-order", reason: "Owned fixture refund" });
      expectedRefundKey = refund.idempotencyKey;
      if (mode === "expired-lease") {
        await operator.query("UPDATE product_order_refunds SET status='processing',lease_owner='owned-dead-worker',lease_expires_at=now()-interval '1 hour',attempt_count=1,state_version=state_version+1");
        await operator.query("UPDATE product_order_adjustments SET status='processing'");
      }
    };
    const assertRefundReceipt = async (mode = "settled") => {
      const pending = ["pending", "provider-failure", "mismatched-payment", "expired-lease"].includes(mode);
      const manual = mode === "rejected";
      const missing = mode === "missing-refund-receipt";
      const refundStatus = pending ? "outcome_unknown" : manual ? "manual_review" : missing ? "processing" : "succeeded";
      const rows = (await operator.query("SELECT status,idempotency_key,provider_refund_id,lease_owner,attempt_count FROM product_order_refunds")).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].status, refundStatus); assert.equal(rows[0].idempotency_key, expectedRefundKey);
      assert.equal(rows[0].attempt_count, 1);
      assert.equal(rows[0].provider_refund_id, ["provider-failure", "rejected", "expired-lease", "missing-refund-receipt"].includes(mode) ? null : "owned-worker-refund");
      if (!missing) assert.equal(rows[0].lease_owner, null);
      const adjustmentStatus = mode === "missing-adjustment-receipt" || missing ? "processing" : refundStatus;
      assert.deepEqual((await operator.query("SELECT status FROM product_order_adjustments")).rows, [{ status: adjustmentStatus }]);
      const orderStatus = pending || manual || missing || mode === "missing-order-receipt" ? "paid" : "refunded";
      const obligationStatus = pending || manual || missing || mode === "missing-obligation-receipt" ? "paid" : "refunded";
      assert.deepEqual((await operator.query("SELECT status FROM checkout_orders")).rows, [{ status: orderStatus }]);
      assert.deepEqual((await operator.query("SELECT status FROM order_payment_obligations")).rows, [{ status: obligationStatus }]);
      const alerts = (await operator.query("SELECT kind,status,recipient_ciphertext,template_data_ciphertext FROM customer_email_outbox")).rows;
      assert.equal(alerts.length, pending || manual ? 1 : 0);
      for (const row of alerts) { assert.equal(row.kind, "shipping_policy_alert"); assert.equal(row.status, "queued"); assert.ok(row.recipient_ciphertext && row.template_data_ciphertext); }
    };
    phase = "refund-worker-authentication-and-closed-admission";
    await seedRefund(); before = await operations();
    assert.equal((await refundRequest(false)).status, 401);
    assert.equal((await refundRequest()).status, 503); assert.deepEqual(await since(before), []); assert.deepEqual(activeCalls, []);
    assert.equal((await operator.query("SELECT status FROM product_order_refunds")).rows[0].status, "queued");
    checks.push("refund-worker-authentication-and-closed-admission-refuse-before-selection-claim-or-provider");

    phase = "refund-worker-empty";
    await seedRefund("empty"); await change(true); before = await operations();
    assert.equal((await refundRequest()).status, 200); assert.deepEqual((await since(before)).map(row => row.state), ["completed", "completed"]);
    assert.deepEqual(activeCalls, []); await reconcile(); checks.push("refund-worker-empty-batch-completes-independent-recovery-entry");

    for (const mode of ["settled", "pending", "provider-failure", "rejected", "mismatched-payment", "missing-payment-id", "expired-lease",
      "missing-refund-receipt", "missing-adjustment-receipt", "missing-obligation-receipt", "missing-order-receipt"]) {
      phase = `refund-worker-${mode}`; await seedRefund(mode); await change(true); before = await operations();
      failProvider = mode === "provider-failure" ? "refund-worker" : undefined;
      const suppress = { "missing-refund-receipt": ["product_order_refunds", "succeeded"], "missing-adjustment-receipt": ["product_order_adjustments", "succeeded"],
        "missing-obligation-receipt": ["order_payment_obligations", "refunded"], "missing-order-receipt": ["checkout_orders", "refunded"] }[mode];
      if (suppress) {
        await operator.query("CREATE OR REPLACE FUNCTION pg_temp.suppress_owned_refund_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
        await operator.query(`CREATE TRIGGER owned_missing_refund_receipt BEFORE UPDATE ON ${suppress[0]} FOR EACH ROW WHEN (NEW.status = '${suppress[1]}') EXECUTE FUNCTION pg_temp.suppress_owned_refund_receipt()`);
      }
      let result;
      try { result = await refundRequest(); }
      finally { failProvider = undefined; if (suppress) await operator.query(`DROP TRIGGER owned_missing_refund_receipt ON ${suppress[0]}`); }
      assert.equal(result.status, mode === "settled" ? 200 : 503);
      assert.deepEqual((await since(before)).map(row => row.state), mode === "settled" ? ["completed", "completed"] : ["uncertain"]);
      await assertRefundReceipt(mode);
      if (mode === "expired-lease") assert.deepEqual(activeCalls, []);
      else assertReconciliationProviderCalls(assert, activeCalls, ["refund-worker"]);
      if (mode === "settled") { assert.equal((await refundRequest()).status, 200); await assertRefundReceipt(); assertReconciliationProviderCalls(assert, activeCalls, ["refund-worker"]); }
      await reconcile(); checks.push(`refund-worker-${mode}-durable-refund-adjustment-order-obligation-and-alert-receipts-accounted`);
    }

    phase = "refund-worker-close-during-provider-and-expired-business-lease";
    await seedRefund(); await change(true); before = await operations();
    const refundHeld = holdProvider("refund-worker"); let refundPending = refundRequest();
    try {
      await refundHeld.entered(); await change(false);
      await operator.query("UPDATE product_order_refunds SET lease_expires_at=now()-interval '1 hour'");
      assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
      assert.equal((await refundRequest()).status, 503); assert.equal((await since(before)).length, 1);
    } finally { refundHeld.release(); }
    assert.equal((await refundPending).status, 503); gate = undefined; await assertRefundReceipt();
    assertReconciliationProviderCalls(assert, activeCalls, ["refund-worker"]); await reconcile();
    checks.push("refund-worker-close-retains-admitted-provider-call-and-expired-business-lease-never-drains-ledger");

    phase = "refund-worker-close-during-blocked-settlement";
    await seedRefund(); await change(true); before = await operations();
    const refundBlocker = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin",
      password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
    connections.push(refundBlocker); await refundBlocker.connect();
    const refundReceiptHeld = holdProvider("refund-worker"); refundPending = refundRequest();
    try {
      await refundReceiptHeld.entered(); await refundBlocker.query("BEGIN");
      await refundBlocker.query("SELECT id FROM product_order_refunds FOR UPDATE"); refundReceiptHeld.release();
      await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
      await change(false); assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
      assert.equal((await refundRequest()).status, 503); assert.equal((await since(before)).length, 1);
    } finally { refundReceiptHeld.release(); await refundBlocker.query("ROLLBACK"); }
    assert.equal((await refundPending).status, 503); gate = undefined; await assertRefundReceipt();
    assertReconciliationProviderCalls(assert, activeCalls, ["refund-worker"]); await reconcile();
    checks.push("refund-worker-close-retains-active-entry-through-actually-blocked-settlement-transaction");

    phase = "refund-worker-ledger-backend-death";
    await seedRefund(); await change(true); before = await operations();
    const refundDeath = holdProvider("refund-worker"); refundPending = refundRequest();
    try {
      await refundDeath.entered(); await change(false);
      const sessions = (await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'", [target.user])).rows;
      assert.equal(sessions.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]); await delay(25);
    } finally { refundDeath.release(); }
    assert.equal((await refundPending).status, 503); gate = undefined;
    assert.deepEqual((await since(before)).map(row => row.state), ["active"]); await assertRefundReceipt();
    assertReconciliationProviderCalls(assert, activeCalls, ["refund-worker"]); await reconcile();
    checks.push("refund-worker-ledger-backend-death-retains-unresolved-entry-without-replaying-settled-refund");
    // Qualify preparation through the actual route. Future-dated jobs keep the
    // separate, still-unqualified executor out of these synthetic cases.
    Object.assign(process.env, {
      CHITCHATS_SHIPPING_ENABLED: "true", SQUARE_COMMERCE_ENABLED: "false",
      CHITCHATS_ENVIRONMENT: "staging", CHITCHATS_CLIENT_ID: "owned-unused-client",
      CHITCHATS_ACCESS_TOKEN: "owned-unused-key", CHITCHATS_QUOTE_SIGNING_SECRET: "owned-unused-signing-key",
      CHITCHATS_REGION: "ontario_manitoba",
    });
    await operator.query(`CREATE FUNCTION pg_temp.delay_owned_preparation_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.available_at = now() + interval '1 hour'; RETURN NEW; END $$`);
    await operator.query(`CREATE TRIGGER owned_delay_preparation BEFORE INSERT ON product_shipment_jobs
      FOR EACH ROW EXECUTE FUNCTION pg_temp.delay_owned_preparation_job()`);
    const seedPreparation = async (mode = "normal") => {
      await seedReconciliationRows(operator, []);
      await operator.query("TRUNCATE product_shipments CASCADE");
      activeCalls = []; expectedRefundKey = undefined;
      if (mode === "empty") return {};
      const order = (await operator.query(`INSERT INTO checkout_orders(order_id,purpose,status,payment_provider,
        customer_name,customer_email,amount_cents,line_items)
        VALUES('owned-preparation-order','product','pending','square','Owned fixture','owned@example.invalid',1000,'[]') RETURNING id`)).rows[0].id;
      await operator.query(`INSERT INTO order_payment_obligations(order_id,purpose,status,merchandise_amount_cents,
        shipping_amount_cents,tax_amount_cents,total_amount_cents,currency,source_workflow,tax_policy_version,policy_version,
        payment_provider,initialization_status,idempotency_key,expires_at)
        VALUES($1,'primary','pending',1000,0,0,1000,'CAD','owned-preparation','owned','owned','square','ready',
        'owned-preparation-obligation',now()-interval '1 hour')`, [order]);
      const ids = {};
      for (const [name, status, orderId, provider] of [
        ["detached", "quoted", null, null], ["attached", "payment_pending", order, null],
        ["poll", "in_transit", null, "owned-preparation-provider"],
      ]) ids[name] = (await operator.query(`INSERT INTO product_shipments(order_id,public_reference,quote_token_hash,quote_fingerprint,
        status,destination,package_snapshot,customs_lines,rates,quote_expires_at,provider_shipment_id,created_at,pii_redaction_due_at)
        VALUES($1,$2,$2,$2,$3,'{}','{}','[]','[]',now()-interval '1 hour',$4,now()-interval '1 day',now()+interval '364 days') RETURNING id`,
        [orderId, `owned-preparation-${name}`, status, provider])).rows[0].id;
      if (mode === "conflicting-cleanup") await operator.query(`INSERT INTO product_shipment_jobs(shipment_id,type,status,idempotency_key,operation_payload_hash,payload)
        VALUES($1,'cleanup','queued',$2,'owned-wrong-hash','{}')`, [ids.detached, `quote-cleanup/${ids.detached}`]);
      return ids;
    };
    const preparationReceipts = async () => ({
      shipments: (await operator.query("SELECT public_reference,status,state_version FROM product_shipments ORDER BY public_reference")).rows,
      jobs: (await operator.query("SELECT shipment_id,type,status,idempotency_key,operation_payload_hash,payload,available_at FROM product_shipment_jobs ORDER BY idempotency_key")).rows,
    });
    const assertPreparationReceipts = async (ids, mode = "normal") => {
      const receipt = await preparationReceipts();
      assert.deepEqual(receipt.shipments, [
        { public_reference: "owned-preparation-attached", status: mode === "missing-attached-update" ? "payment_pending" : "abandoned", state_version: mode === "missing-attached-update" ? 1 : 2 },
        { public_reference: "owned-preparation-detached", status: mode === "missing-detached-update" ? "quoted" : "abandoned", state_version: mode === "missing-detached-update" ? 1 : 2 },
        { public_reference: "owned-preparation-poll", status: "in_transit", state_version: 1 },
      ]);
      const { hashOperationPayload } = await import("../../../src/lib/shipping/shipment-store.ts");
      const { createHash } = await import("node:crypto");
      for (const [name, key, payload] of [
        ["detached", `quote-cleanup/${ids.detached}`, { expectedShipmentStateVersion: 2 }],
        ["attached", `attached-quote-cleanup/${ids.attached}`, { expectedShipmentStateVersion: 2, reason: "attached_primary_quote_expired" }],
      ]) {
        const rows = receipt.jobs.filter(row => row.idempotency_key === key);
        if (mode === `missing-${name}-update` || mode === `missing-${name}-cleanup`) { assert.deepEqual(rows, []); continue; }
        assert.equal(rows.length, 1); assert.equal(rows[0].shipment_id, ids[name]); assert.equal(rows[0].type, "cleanup");
        if (mode === "conflicting-cleanup" && name === "detached") { assert.equal(rows[0].operation_payload_hash, "owned-wrong-hash"); continue; }
        assert.equal(rows[0].operation_payload_hash, hashOperationPayload(payload)); assert.deepEqual(rows[0].payload, payload);
      }
      const tracking = receipt.jobs.filter(row => row.type === "tracking");
      assert.equal(tracking.length, mode === "missing-tracking" ? 0 : 1);
      if (tracking.length) {
        const row = tracking[0], parts = row.idempotency_key.split("/");
        assert.deepEqual(parts.slice(0,3), ["tracking", ids.poll, "1"]); assert.match(parts[3], /^[0-9]+$/u);
        assert.equal(row.shipment_id, ids.poll); assert.deepEqual(row.payload, mode === "mutated-tracking" ? {} : { expectedShipmentStateVersion: 1 });
        assert.equal(row.operation_payload_hash, createHash("sha256").update(`${ids.poll}:1:${parts[3]}`).digest("hex"));
      }
      assert.ok(receipt.jobs.every(row => row.status === "queued" && row.available_at > new Date()));
      assert.equal(receipt.jobs.length, ["missing-detached-update", "missing-attached-update", "missing-detached-cleanup", "missing-attached-cleanup", "missing-tracking"].includes(mode) ? 2 : 3);
      assert.deepEqual(activeCalls, []);
    };
    phase = "shipping-preparation-closed";
    await seedPreparation(); before = await operations();
    assert.equal((await refundRequest(false)).status, 401); assert.equal((await refundRequest()).status, 503);
    assert.deepEqual(await since(before), []); assert.deepEqual((await preparationReceipts()).jobs, []);
    checks.push("shipping-preparation-closed-authenticated-route-has-no-business-effects");

    for (const mode of ["empty", "normal", "missing-detached-update", "missing-attached-update",
      "missing-detached-cleanup", "missing-attached-cleanup", "conflicting-cleanup", "missing-tracking", "mutated-tracking", "off", "off-missing-detached-cleanup"]) {
      phase = `shipping-preparation-${mode}`;
      const ids = await seedPreparation(mode); await change(true); before = await operations();
      const receiptMode = mode === "off-missing-detached-cleanup" ? "missing-detached-cleanup" : mode;
      const off = mode.startsWith("off");
      const suppressed = receiptMode.startsWith("missing-") ? receiptMode : undefined;
      if (suppressed) {
        await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.suppress_owned_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RETURN NULL; END $$`);
        const table = receiptMode.endsWith("update") ? "product_shipments" : "product_shipment_jobs";
        const condition = receiptMode === "missing-detached-update" ? "NEW.status='abandoned' AND NEW.public_reference='owned-preparation-detached'" :
          receiptMode === "missing-attached-update" ? "NEW.status='abandoned' AND NEW.public_reference='owned-preparation-attached'" :
          receiptMode === "missing-tracking" ? "NEW.type='tracking'" :
          `NEW.idempotency_key LIKE '${receiptMode === "missing-detached-cleanup" ? "quote-cleanup/" : "attached-quote-cleanup/"}%'`;
        await operator.query(`CREATE TRIGGER owned_missing_preparation BEFORE ${receiptMode.endsWith("update") ? "UPDATE" : "INSERT"} ON ${table}
          FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION pg_temp.suppress_owned_preparation()`);
      }
      if (mode === "mutated-tracking") {
        await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.mutate_owned_tracking() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.payload = '{}'::jsonb; RETURN NEW; END $$`);
        await operator.query(`CREATE TRIGGER owned_mutated_tracking BEFORE INSERT ON product_shipment_jobs FOR EACH ROW
          WHEN (NEW.type='tracking') EXECUTE FUNCTION pg_temp.mutate_owned_tracking()`);
      }
      if (off) process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
      let result;
      try { result = await refundRequest(); }
      finally {
        process.env.FRONTEND_WRITER_ADMISSION_MODE = "enforce";
        if (suppressed) await operator.query(`DROP TRIGGER owned_missing_preparation ON ${receiptMode.endsWith("update") ? "product_shipments" : "product_shipment_jobs"}`);
      }
      if (mode === "mutated-tracking") await operator.query("DROP TRIGGER owned_mutated_tracking ON product_shipment_jobs");
      assert.equal(result.status, off || ["empty", "normal"].includes(mode) ? 200 : 503);
      if (result.status === 200) {
        const summary = JSON.parse(result.text);
        assert.deepEqual(summary.operations, { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, fenced: 0 });
        assert.equal(summary.redacted, 0); assert.equal(summary.queued, mode === "empty" ? 0 : 1);
        assert.equal(summary.abandoned, mode === "empty" ? 0 : 2);
      }
      assert.deepEqual((await since(before)).map(row => row.state), off ? [] :
        ["completed", ...(["empty", "normal"].includes(mode) ? ["completed", "completed"] : ["uncertain"])]);
      if (mode === "empty") assert.deepEqual((await preparationReceipts()).jobs, []);
      else await assertPreparationReceipts(ids, receiptMode);
      if (["normal", "mutated-tracking"].includes(mode)) {
        assert.equal((await refundRequest()).status, mode === "normal" ? 200 : 503);
        await assertPreparationReceipts(ids, mode);
      }
      await reconcile(); checks.push(`shipping-preparation-${mode}-real-abandonment-cleanup-and-tracking-receipts-accounted`);
    }

    // A returned row is only a receipt for the requested mutation when its
    // identity and resulting state still match, including on fresh inserts.
    for (const mode of ["tracking-shipment", "tracking-type", "tracking-key", "tracking-hash",
      "detached-status", "detached-version", "attached-status", "attached-version", "off-tracking-hash"]) {
      phase = `shipping-preparation-mutated-${mode}`;
      const ids = await seedPreparation(); await change(true); before = await operations();
      const off = mode.startsWith("off-");
      const mutation = off ? mode.slice(4) : mode;
      const tracking = mutation.startsWith("tracking-");
      const attached = mutation.startsWith("attached-");
      const table = tracking ? "product_shipment_jobs" : "product_shipments";
      const statement = {
        "tracking-shipment": `NEW.shipment_id = '${ids.detached}'::uuid`,
        "tracking-type": "NEW.type = 'cleanup'",
        "tracking-key": "NEW.idempotency_key = NEW.idempotency_key || '/changed'",
        "tracking-hash": "NEW.operation_payload_hash = 'owned-changed-hash'",
        "detached-status": "NEW.status = OLD.status",
        "detached-version": "NEW.state_version = OLD.state_version",
        "attached-status": "NEW.status = OLD.status",
        "attached-version": "NEW.state_version = OLD.state_version",
      }[mutation];
      const condition = tracking ? "NEW.type='tracking'" :
        `NEW.status='abandoned' AND NEW.public_reference='owned-preparation-${attached ? "attached" : "detached"}'`;
      await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.change_owned_preparation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN ${statement}; RETURN NEW; END $$`);
      await operator.query(`CREATE TRIGGER owned_changed_preparation BEFORE ${tracking ? "INSERT" : "UPDATE"} ON ${table}
        FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION pg_temp.change_owned_preparation_receipt()`);
      let result;
      if (off) process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
      try { result = await refundRequest(); }
      finally {
        process.env.FRONTEND_WRITER_ADMISSION_MODE = "enforce";
        await operator.query(`DROP TRIGGER owned_changed_preparation ON ${table}`);
      }
      const receipt = await preparationReceipts();
      assert.equal(receipt.jobs.length, 3);
      assert.deepEqual(activeCalls, []);
      if (tracking) {
        const row = receipt.jobs.find(row => row.idempotency_key.startsWith("tracking/"));
        assert.ok(row);
        if (mutation === "tracking-shipment") assert.equal(row.shipment_id, ids.detached);
        if (mutation === "tracking-type") assert.equal(row.type, "cleanup");
        if (mutation === "tracking-key") assert.ok(row.idempotency_key.endsWith("/changed"));
        if (mutation === "tracking-hash") assert.equal(row.operation_payload_hash, "owned-changed-hash");
      } else {
        const row = receipt.shipments.find(row => row.public_reference.endsWith(attached ? "-attached" : "-detached"));
        assert.equal(row.status, mutation.endsWith("status") ? (attached ? "payment_pending" : "quoted") : "abandoned");
        assert.equal(row.state_version, mutation.endsWith("version") ? 1 : 2);
      }
      assert.equal(result.status, off ? 200 : 503, mode);
      assert.deepEqual((await since(before)).map(row => row.state), off ? [] : ["completed", "uncertain"]);
      await reconcile(); checks.push(`shipping-preparation-mutated-${mode}-retains-receipt-uncertainty`);
    }

    for (const fault of ["close", "ledger-backend-death"]) {
      phase = `shipping-preparation-blocked-transaction-${fault}`;
      const ids = await seedPreparation(); await change(true); before = await operations();
      const blocker = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin",
        password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
      connections.push(blocker); await blocker.connect(); await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM product_shipments WHERE id=$1 FOR UPDATE", [ids.detached]);
      const pending = refundRequest();
      try {
        await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
        await change(false); assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
        assert.equal((await refundRequest()).status, 503);
        assert.deepEqual((await since(before)).map(row => row.state), ["completed", "active"]);
        if (fault === "ledger-backend-death") {
          const sessions = (await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'", [target.user])).rows;
          assert.equal(sessions.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]); await delay(25);
        }
      } finally { await blocker.query("ROLLBACK"); }
      // Execution has its own admission after preparation; closure refuses it.
      assert.equal((await pending).status, 503);
      assert.deepEqual((await since(before)).map(row => row.state), ["completed", fault === "close" ? "completed" : "active"]);
      await assertPreparationReceipts(ids); await reconcile();
      checks.push(`shipping-preparation-blocked-transaction-${fault}-retains-entry-without-replaying-committed-work`);
    }
    await operator.query("DROP TRIGGER owned_delay_preparation ON product_shipment_jobs");
    await exerciseShippingExecution({ operator, target, password, connections, change, operations, since,
      reconcile, request: (authorized = true) => request(authorized, "/api/cron/chitchats-shipping", process.env.CHITCHATS_WORKER_CRON_SECRET), drain, checks, setPhase: value => { phase = value; } });
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
    frames: error.stack?.split("\n").filter(line => /owned-(?:frontend-reconciliation|reconciliation-rows|shipping-execution)\.mjs/u.test(line)) })}\n`);
  process.exitCode = 1;
});
