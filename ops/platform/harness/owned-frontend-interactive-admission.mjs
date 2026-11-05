// Child of the disposable owned PostgreSQL migration fixture only. Never accepts
// a configured URL, live target, external provider connection or credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendWriterInventory } from "../frontend-writer-inventory.mjs";
import { changeFrontendAdmission, observeFrontendDrain, reconcileFrontendOperation } from "../frontend-admission.mjs";

let phase = "configuration";
async function main() {
  assert.equal(process.env.FRONTEND_INTERACTIVE_OWNED_TEST, "true");
  const port = Number(process.env.OWNED_INTERACTIVE_PORT), password = process.env.OWNED_INTERACTIVE_PASSWORD;
  const major = Number(process.env.OWNED_INTERACTIVE_MAJOR);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.ok(/^owned-[a-f0-9-]{36}$/u.test(password ?? ""));
  assert.ok([16, 18].includes(major));
  const target = { environment: "staging", host: "127.0.0.1", port, database: "frontend_admission_owned", user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
  const url = `postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`;
  const { VERCEL_PROJECT_BINDINGS } = await import("../../../src/lib/env/application-environment.mjs");
  Object.assign(process.env, {
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(target),
    FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    SERVICE_BOOKING_SQUARE_ENABLED: "true", HIGHLEVEL_SYNC_ENABLED: "false", MARKETING_DELIVERY_PROVIDER: "resend",
    RESEND_API_KEY: "re_owned_unused", ADMIN_EMAIL: "owned@example.invalid", FROM_EMAIL: "owned@example.invalid",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "owned@example.invalid", NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project", NEXT_PUBLIC_SANITY_DATASET: "test-dataset",
  });
  const operator = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin", password,
    ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  const connections = [operator], requests = [], checks = [], evidence = [], nativeFetch = globalThis.fetch;
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const sourceBefore = frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url)));
  let server, closePool, gate, providerMode = "success", providerCalls = [], unexpectedFetches = 0, invariantFailure, logCount = 0;
  console.log = console.warn = console.error = () => { logCount++; };
  try {
    let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
    const change = async (newWork, recovery = false) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork, recovery })).epoch; };
    const drain = () => observeFrontendDrain(operator, target, epoch);
    const operations = async () => (await operator.query("SELECT id,kind,state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
    const since = async before => (await operations()).filter(row => !before.some(old => old.id === row.id));
    const inspectBusiness = async () => ({
      submissions: (await operator.query("SELECT id,submission_type,source,consent_choice FROM marketing_contact_submissions WHERE source_path='/owned-interactive' ORDER BY id")).rows,
      consents: (await operator.query("SELECT id,submission_id,event_type FROM marketing_consent_events WHERE source='general_inquiry' ORDER BY id")).rows,
      holds: (await operator.query("SELECT id,status,offering_snapshot ? 'promotionSnapshot' AS has_promotion FROM appointment_holds WHERE public_reference='owned-interactive-hold'")).rows,
    });
    const reconcile = async () => {
      await Promise.allSettled(requests); await change(false);
      const rows = await operations(), unresolved = rows.filter(row => row.state !== "completed");
      if (unresolved.length) { assert.equal((await drain()).ledgerDrained, false); await assert.rejects(change(true)); }
      const digest = createHash("sha256").update(JSON.stringify({ operations: rows, business: await inspectBusiness(), providerCalls })).digest("hex");
      evidence.push(digest);
      for (const row of unresolved) await reconcileFrontendOperation(operator, target, epoch, row.id, digest);
      assert.equal((await drain()).ledgerDrained, true);
      assert.equal((await drain()).migrationAuthorized, false); assert.equal((await drain()).historicalWritersFenced, false);
    };
    const until = async predicate => {
      for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await delay(25); }
      throw new Error("OWNED_INTERACTIVE_OBSERVATION_TIMEOUT");
    };
    const holdProvider = flow => {
      let entered, release; const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
      gate = { flow, wait, entered, release, used: false };
      return { entered: () => Promise.race([started, delay(8000, undefined, { ref: false }).then(() => { throw new Error("OWNED_INTERACTIVE_PROVIDER_GATE_TIMEOUT"); })]), release };
    };
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), selected = new URL(request.url);
      if (server && selected.origin === `http://127.0.0.1:${server.address().port}`) return nativeFetch(request);
      if (selected.origin !== "https://api.resend.com" || selected.pathname !== "/emails" || request.method !== "POST") {
        unexpectedFetches++; throw new Error("OWNED_INTERACTIVE_UNEXPECTED_PROVIDER");
      }
      const body = await request.json(), flow = body.tags?.find(tag => tag.name === "flow")?.value;
      try {
        assert.ok(["general-inquiry_admin", "general-inquiry_customer"].includes(flow));
        const active = (await operations()).filter(row => row.state === "active");
        assert.ok(active.length >= 1 && active.every(row => row.kind === "new-work"));
        assert.equal((await operator.query("SELECT count(*)::int AS count FROM marketing_contact_submissions WHERE source_path='/owned-interactive'")).rows[0].count, 1);
        const sessions = (await operator.query("SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING(pid) WHERE usename=$1", [target.user])).rows;
        assert.ok(sessions.length >= 2 && sessions.every(row => row.ssl === true));
      } catch (error) { invariantFailure = error; throw error; }
      providerCalls.push({ flow, method: request.method, path: selected.pathname });
      if (gate?.flow === flow && !gate.used) { gate.used = true; gate.entered(); await gate.wait; }
      if (providerMode === "reject-admin" && flow === "general-inquiry_admin") return Response.json({ name: "owned_failure", message: "owned-private-provider-detail" }, { status: 500 });
      if (providerMode === "missing-receipt") return Response.json({});
      return Response.json({ id: `owned-interactive-email-${providerCalls.length}` });
    };
    phase = "import-actual-producers";
    const { submitGeneralInquiry } = await import("../../../src/app/actions/form.ts");
    const { POST: promotionPost } = await import("../../../src/app/api/booking/payment/promotion-code/route.ts");
    const { NextRequest } = await import("next/server");
    ({ closePrivateDbPool: closePool } = await import("../../../src/lib/private-db/client.ts"));
    server = createServer(async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.ok(["/__owned/forms/general-inquiry", "/api/booking/payment/promotion-code"].includes(request.url));
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        const result = request.url.startsWith("/__owned/")
          ? Response.json(await submitGeneralInquiry(JSON.parse(body)), { headers: { "cache-control": "no-store" } })
          : await promotionPost(new NextRequest(`http://127.0.0.1${request.url}`, { method: "POST", headers: { "content-type": "application/json" }, body }));
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
      } catch { response.writeHead(500); response.end("OWNED_INTERACTIVE_BRIDGE_FAILED"); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const performRequest = async (path, body) => {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const text = await response.text(); assert.equal(text.includes(password), false); assert.equal(text.includes("owned-private-provider-detail"), false);
      if (response.status === 503) { assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("retry-after"), "30"); }
      return { status: response.status, body: JSON.parse(text) };
    };
    const request = (path, body) => { const pending = performRequest(path, body); requests.push(pending); pending.catch(() => {}); return pending; };
    const form = () => request("/__owned/forms/general-inquiry", { name: "Owned fixture", email: "owned@example.invalid", message: "Owned interactive fixture", marketingConsent: false, sourcePath: "/owned-interactive" });
    const clearForm = async () => {
      await operator.query("DELETE FROM marketing_contact_submissions WHERE source_path='/owned-interactive'");
      providerCalls = []; providerMode = "success"; invariantFailure = undefined; gate = undefined;
    };
    const assertFormReceipt = async expected => {
      const rows = (await operator.query("SELECT id,submission_type,consent_choice FROM marketing_contact_submissions WHERE source_path='/owned-interactive'")).rows;
      assert.equal(rows.length, expected);
      if (expected) {
        assert.equal(rows[0].submission_type, "general_inquiry"); assert.equal(rows[0].consent_choice, "not_opted_in");
        assert.deepEqual((await operator.query("SELECT event_type FROM marketing_consent_events WHERE submission_id=$1", [rows[0].id])).rows, [{ event_type: "no_opt_in" }]);
      }
    };
    phase = "forms-closed-policy";
    await clearForm(); await change(false); let before = await operations();
    assert.equal((await form()).body.success, false); assert.deepEqual(await since(before), []); assert.deepEqual(providerCalls, []); await assertFormReceipt(0);
    checks.push("actual-form-export-closed-policy-refuses-before-private-write-and-two-email-effects");
    phase = "forms-success";
    await change(true); before = await operations();
    assert.deepEqual((await form()).body, { success: true }); await assertFormReceipt(1);
    assert.equal(providerCalls.length, 2); assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); assert.equal(invariantFailure, undefined);
    await reconcile(); checks.push("actual-form-export-persists-submission-and-consent-before-both-provider-effects-under-verified-tls");
    for (const mode of ["reject-admin", "missing-receipt", "database-error", "missing-submission-receipt"]) {
      phase = `forms-${mode}`;
      await clearForm(); await change(true); before = await operations(); providerMode = mode;
      let restore;
      if (mode === "database-error") { await operator.query("REVOKE INSERT ON marketing_contact_submissions FROM frontend_admission_protocol"); restore = () => operator.query("GRANT INSERT ON marketing_contact_submissions TO frontend_admission_protocol"); }
      if (mode === "missing-submission-receipt") {
        await operator.query("CREATE FUNCTION owned_interactive_skip_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
        await operator.query("CREATE TRIGGER owned_interactive_skip_submission BEFORE INSERT ON marketing_contact_submissions FOR EACH ROW EXECUTE FUNCTION owned_interactive_skip_submission()");
        restore = async () => { await operator.query("DROP TRIGGER owned_interactive_skip_submission ON marketing_contact_submissions"); await operator.query("DROP FUNCTION owned_interactive_skip_submission()"); };
      }
      let result;
      try { result = await form(); } finally { await restore?.(); }
      assert.equal(result.body.success, false); assert.deepEqual((await since(before)).map(row => row.state), ["uncertain"]);
      await assertFormReceipt(mode === "database-error" || mode === "missing-submission-receipt" ? 0 : 1);
      assert.equal(providerCalls.length, mode === "database-error" || mode === "missing-submission-receipt" ? 0 : 2); assert.equal(invariantFailure, undefined);
      await reconcile(); checks.push(`actual-form-${mode}-cannot-complete-or-replay-unknown-effects`);
    }
    phase = "forms-failed-email-sibling";
    await clearForm(); await change(true); before = await operations(); providerMode = "reject-admin";
    const sibling = holdProvider("general-inquiry_customer"), siblingRequest = form();
    try {
      await sibling.entered(); await until(async () => providerCalls.length === 2); await change(false);
      assert.deepEqual((await since(before)).map(row => row.state), ["active"]); assert.equal((await drain()).ledgerDrained, false);
    } finally { sibling.release(); }
    assert.equal((await siblingRequest).body.success, false); gate = undefined; await assertFormReceipt(1);
    assert.deepEqual((await since(before)).map(row => row.state), ["uncertain"]); await reconcile();
    checks.push("failed-admin-email-keeps-actual-form-active-until-delayed-customer-email-settles");
    phase = "forms-locked-transaction";
    await clearForm(); await change(true); before = await operations();
    const blocker = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin", password,
      ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
    connections.push(blocker); await blocker.connect(); await blocker.query("BEGIN"); await blocker.query("LOCK TABLE marketing_contact_submissions IN ACCESS EXCLUSIVE MODE");
    const blocked = form();
    try {
      await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length >= 1);
      await change(false); assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
      assert.equal((await form()).body.success, false); assert.equal((await since(before)).length, 1);
    } finally { await blocker.query("ROLLBACK"); }
    assert.deepEqual((await blocked).body, { success: true }); await assertFormReceipt(1); assert.equal(providerCalls.length, 2); await reconcile();
    checks.push("closed-policy-retains-actual-form-through-blocked-business-transaction-and-refuses-second-submission");
    phase = "forms-ledger-backend-death";
    await clearForm(); await change(true); before = await operations();
    const held = holdProvider("general-inquiry_customer"), dead = form();
    try {
      await held.entered(); await change(false);
      const sessions = (await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'", [target.user])).rows;
      assert.equal(sessions.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]); await delay(25);
    } finally { held.release(); }
    assert.equal((await dead).body.success, false); gate = undefined; await assertFormReceipt(1);
    assert.deepEqual((await since(before)).map(row => row.state), ["active"]); assert.equal(providerCalls.length, 2); await reconcile();
    checks.push("actual-ledger-backend-death-preserves-unresolved-form-and-committed-submission-without-replaying-emails");
    phase = "booking-promotion-real-route";
    const seedHold = async () => {
      await operator.query("DELETE FROM appointment_holds WHERE public_reference='owned-interactive-hold'");
      const snapshot = { id: "owned-service", serviceSlug: "owned-service", title: "Owned service", pricing: { fullPrice: 100, depositAmount: 50, customAmountMinimum: 50, customAmountMaximum: 100, addOnPrice: 0, currency: "CAD" },
        promotionSnapshot: { code: "OWNED", discountType: "percentage", discountAmount: 10, discountCents: 1000, originalBasePriceCents: 10000, discountedBasePriceCents: 9000 } };
      await operator.query(`INSERT INTO appointment_holds(public_reference,payment_session_reference,offering_id,offering_snapshot,booking_type,customer_snapshot,selected_start,selected_end,timezone,status,expires_at,booking_model_version)
        VALUES('owned-interactive-hold','owned-interactive-session','owned-offering',$1,'appointment','{"name":"Owned fixture","email":"owned@example.invalid"}',now()+interval '1 day',now()+interval '1 day 1 hour','America/Toronto','held',now()+interval '1 hour',1)`, [snapshot]);
    };
    const promotion = () => request("/api/booking/payment/promotion-code", { action: "remove", paymentSessionReference: "owned-interactive-session" });
    await seedHold(); await change(false); before = await operations();
    assert.equal((await promotion()).status, 503); assert.deepEqual(await since(before), []); assert.equal((await inspectBusiness()).holds[0].has_promotion, true);
    await change(true); before = await operations();
    assert.equal((await promotion()).status, 200); assert.equal((await inspectBusiness()).holds[0].has_promotion, false);
    assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); await reconcile();
    checks.push("actual-booking-promotion-http-export-refuses-closed-work-and-records-real-held-snapshot-mutation");
    await seedHold(); await change(true); before = await operations();
    await operator.query("CREATE FUNCTION owned_interactive_skip_hold_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
    await operator.query("CREATE TRIGGER owned_interactive_skip_hold_update BEFORE UPDATE ON appointment_holds FOR EACH ROW EXECUTE FUNCTION owned_interactive_skip_hold_update()");
    let missingHold;
    try { missingHold = await promotion(); }
    finally { await operator.query("DROP TRIGGER owned_interactive_skip_hold_update ON appointment_holds"); await operator.query("DROP FUNCTION owned_interactive_skip_hold_update()"); }
    assert.equal(missingHold.status, 503); assert.equal((await inspectBusiness()).holds[0].has_promotion, true);
    assert.deepEqual((await since(before)).map(row => row.state), ["uncertain"]); await reconcile();
    checks.push("actual-booking-promotion-missing-update-receipt-remains-uncertain-behind-conflict-result");
    assert.equal(unexpectedFetches, 0); assert.equal(invariantFailure, undefined);
    const sourceAfter = frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url)));
    assert.deepEqual(sourceAfter, sourceBefore);
    return { status: "FRONTEND_INTERACTIVE_OWNED_PASS", postgresMajor: major, checks, reconciliationEvidenceSha256: evidence,
      sourceManifestSha256: sourceBefore.sourceManifestSha256, harnessSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
      syntheticLedgerSourceIdentity: true, actualFormExport: true, actualRouteExport: true, loopbackHttp: true, verifiedPostgresTls: true, realBusinessDatabase: true,
      providersIntercepted: true, providerTouched: false, historicalWritersFenced: false, migrationAuthorized: false, applicationLogsSuppressed: logCount > 0 };
  } finally {
    gate?.release(); await Promise.allSettled(requests);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await closePool?.(); for (const client of connections) { try { await client.end(); } catch { /* disposable fixture only */ } }
    globalThis.fetch = nativeFetch; Object.assign(console, originalConsole);
  }
}

main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`${JSON.stringify({ status: "FRONTEND_INTERACTIVE_OWNED_FAILED", phase, code: error.code,
    assertion: error instanceof assert.AssertionError ? error.message : undefined,
    frames: error.stack?.split("\n").filter(line => /owned-frontend-interactive-admission\.mjs/u.test(line)) })}\n`);
  process.exitCode = 1;
});
