// Child of the owned loopback frontend-migration fixture. Never accepts a configured database URL.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { changeFrontendAdmission, observeFrontendDrain, reconcileFrontendOperation } from "../frontend-admission.mjs";
import { frontendWriterInventory } from "../frontend-writer-inventory.mjs";

export function ownedWorkerTarget(env) {
  assert.equal(env.FRONTEND_WORKER_ADMISSION_OWNED_TEST, "true");
  const port = Number(env.OWNED_RECONCILIATION_PORT), major = Number(env.OWNED_RECONCILIATION_MAJOR);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.ok(/^owned-[a-f0-9-]{36}$/u.test(env.OWNED_RECONCILIATION_PASSWORD ?? ""));
  assert.ok([16, 18].includes(major));
  assert.ok(env.NODE_EXTRA_CA_CERTS?.startsWith("/"));
  return { environment: "staging", host: "127.0.0.1", port, database: "frontend_admission_owned",
    user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
}

let phase = "configuration";
export async function exerciseOwnedFrontendWorkers() {
  const target = ownedWorkerTarget(process.env), password = process.env.OWNED_RECONCILIATION_PASSWORD;
  const url = `postgresql://${target.user}:${password}@127.0.0.1:${target.port}/${target.database}?sslmode=verify-full`;
  const { VERCEL_PROJECT_BINDINGS } = await import("../../../src/lib/env/application-environment.mjs");
  const fields = ["website_id", "email_eligible", "sms_eligible", "email_destination", "sms_destination", "original_source",
    "original_path", "attribution", "source", "source_path", "historical", "lifecycle", "interest", "last_activity", "offer",
    "offer_code", "offer_label", "offer_terms", "offer_url", "journey_key"];
  Object.assign(process.env, {
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(target), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    CRON_SECRET: "owned-cron", RESEND_MARKETING_SYNC_CRON_SECRET: "owned-cron", PRIVATE_DATA_RETENTION_CRON_SECRET: "owned-cron",
    RESEND_API_KEY: "re_owned_unused", ADMIN_EMAIL: "owned@example.invalid", FROM_EMAIL: "owned@example.invalid",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "owned@example.invalid", NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
    NEXT_PUBLIC_SANITY_DATASET: "test-dataset", SANITY_WEBHOOK_SECRET: "owned-webhook",
    CHITCHATS_SHIPPING_ENABLED: "true", FLAT_RATE_SHIPPING_ENABLED: "true", CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_REGION: "ontario_manitoba", CHITCHATS_CLIENT_ID: "owned-client", CHITCHATS_ACCESS_TOKEN: "owned-unused",
    CHITCHATS_QUOTE_SIGNING_SECRET: "owned-unused", CHITCHATS_TRACKED_POSTAGE_TYPES: "chit_chats_canada_tracked",
    HIGHLEVEL_SYNC_ENABLED: "true", HIGHLEVEL_ACCOUNT_AUDITED: "true", HIGHLEVEL_MARKETING_ENABLED: "false",
    HIGHLEVEL_LOCATION_ID: "vd09FLBpPLXuHb5Tnhn4", HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
    HIGHLEVEL_FIELD_IDS: JSON.stringify(Object.fromEntries(fields.map(field => [field, field]))),
    CHECKOUT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), MARKETING_DELIVERY_PROVIDER: "resend",
  });
  const operator = new Client({ host: target.host, port: target.port, database: target.database, user: "frontend_test_admin",
    password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  const checks = [], reconciliationEvidence = [], requests = [], providerCalls = [], nativeFetch = globalThis.fetch;
  let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
  let server, closePool, gate, providerFailure, invariantFailure, originalSanityFetch, sanityClient, logCount = 0;
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => { logCount++; };
  const operations = async () => (await operator.query("SELECT id,kind,state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
  const change = async (newWork, recovery) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork, recovery })).epoch; };
  const drain = () => observeFrontendDrain(operator, target, epoch);
  const since = async before => (await operations()).filter(row => !before.some(prior => prior.id === row.id));
  const hold = stage => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
    gate = { stage, used: false, enter, waiting, release };
    return { entered, release };
  };
  const provider = async (stage, kind) => {
    const active = (await operations()).filter(row => row.state === "active");
    try {
      assert.equal(active.length, 1, `${stage}: expected durable whole-operation entry`);
      assert.equal(active[0].kind, kind);
      const sessions = (await operator.query("SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING(pid) WHERE usename=$1", [target.user])).rows;
      assert.ok(sessions.length >= 2 && sessions.every(row => row.ssl === true));
    } catch (error) { invariantFailure = error; throw error; }
    providerCalls.push(stage);
    if (gate?.stage === stage && !gate.used) { gate.used = true; gate.enter(); await gate.waiting; }
    if (providerFailure === stage) throw new Error("owned-provider-failure");
  };
  const inspectedState = async () => ({ operations: await operations(),
    marketing: (await operator.query("SELECT id,status,locked_by,locked_until,attempts FROM marketing_contact_sync_jobs ORDER BY id")).rows,
    crm: (await operator.query("SELECT id,status,locked_by,locked_until,attempts FROM highlevel_outbox ORDER BY id")).rows,
    effects: (await operator.query("SELECT key,state,provider_id FROM highlevel_effects ORDER BY key")).rows,
    stock: (await operator.query("SELECT product_id,variant_key,on_hand,reserved,sanity_seed_quantity FROM product_stock ORDER BY id")).rows,
    rates: (await operator.query("SELECT zone_id,size_bucket_id,amount_cents FROM shipping_rate_cache ORDER BY zone_id,size_bucket_id")).rows });
  const reconcile = async () => {
    await Promise.all(requests); await change(false, false);
    const unresolved = (await operations()).filter(row => row.state !== "completed");
    if (unresolved.length) { assert.equal((await drain()).ledgerDrained, false); await assert.rejects(change(true, true)); }
    // Fixture-only deliberate reconciliation after every worker/provider sibling has stopped.
    const evidence = createHash("sha256").update(JSON.stringify(await inspectedState())).digest("hex");
    reconciliationEvidence.push(evidence);
    for (const row of unresolved) await reconcileFrontendOperation(operator, target, epoch, row.id, evidence);
    assert.equal((await drain()).ledgerDrained, true); assert.equal((await drain()).migrationAuthorized, false);
    assert.equal((await drain()).historicalWritersFenced, false);
  };
  const clearTriggers = async () => {
    for (const table of ["marketing_contact_sync_jobs", "shipping_rate_cache", "product_stock", "highlevel_outbox"])
      await operator.query(`DROP TRIGGER IF EXISTS owned_suppress_receipt ON ${table}`);
    await operator.query("DROP FUNCTION IF EXISTS owned_suppress_receipt()");
  };
  const suppressReceipt = async (table, when = "true") => {
    assert.ok(["marketing_contact_sync_jobs", "shipping_rate_cache", "product_stock", "highlevel_outbox"].includes(table));
    assert.ok(["true", "NEW.status = 'succeeded'"].includes(when));
    await operator.query(`CREATE FUNCTION owned_suppress_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${when} THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await operator.query(`CREATE TRIGGER owned_suppress_receipt BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION owned_suppress_receipt()`);
  };
  const seedMarketing = async () => {
    await clearTriggers(); await operator.query("DELETE FROM marketing_contact_sync_jobs");
    await operator.query("DELETE FROM marketing_contacts WHERE email_normalized='owned-worker@example.invalid'");
    await operator.query("INSERT INTO marketing_contacts(email,email_normalized,source,first_consented_at,last_consented_at) VALUES('owned-worker@example.invalid','owned-worker@example.invalid','contact_popup',now(),now())");
    await operator.query(`INSERT INTO marketing_contact_sync_jobs(idempotency_key,email,email_normalized,source,payload)
      VALUES('owned-worker','owned-worker@example.invalid','owned-worker@example.invalid','contact_popup',$1)`,
    [JSON.stringify({ email: "owned-worker@example.invalid", source: "contact_popup", consentedAt: new Date().toISOString() })]);
    providerCalls.length = 0; providerFailure = undefined;
  };
  const seedCrm = async () => {
    await clearTriggers(); await operator.query("DELETE FROM highlevel_outbox"); await operator.query("DELETE FROM highlevel_effects");
    await operator.query("DELETE FROM highlevel_contacts");
    const contact = (await operator.query(`INSERT INTO highlevel_contacts(location_id,email_normalized,provider_id) VALUES($1,'owned-worker@example.invalid','owned-crm') RETURNING id`, [process.env.HIGHLEVEL_LOCATION_ID])).rows[0].id;
    await operator.query("INSERT INTO highlevel_outbox(event_key,entity_type,entity_id,event_type) VALUES('owned-worker','contact',$1,'owned_fixture')", [contact]);
    providerCalls.length = 0; providerFailure = undefined;
  };
  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), selected = new URL(request.url);
      if (server && selected.origin === `http://127.0.0.1:${server.address().port}`) return nativeFetch(request);
      if (selected.hostname === "api.resend.com") {
        await provider("marketing", "recovery");
        return selected.pathname === "/events/send" ? Response.json({ event: "owned-event", object: "event" }) : Response.json({ id: "owned-contact" });
      }
      if (selected.hostname === "staging.chitchats.com" && selected.pathname.startsWith("/api/v1/clients/owned-client/shipments")) {
        const stage = request.method === "DELETE" ? "rate-cleanup" : "rate-create";
        await provider(stage, "new-work");
        if (stage === "rate-cleanup") return new Response(null, { status: 204 });
        return Response.json({ shipment: { id: "owned-rate-draft", status: "draft", rates: [{ postage_type: "chit_chats_canada_tracked",
          postage_description: "Owned tracked", tracking_type_description: "Full tracking included", is_insured: true, payment_amount: "12.34" }] } });
      }
      if (selected.hostname === "services.leadconnectorhq.com" && selected.pathname.startsWith("/contacts/owned-crm")) {
        await provider("crm", "recovery");
        return Response.json({ contact: { id: "owned-crm", locationId: process.env.HIGHLEVEL_LOCATION_ID, email: "owned-worker@example.invalid" } });
      }
      invariantFailure = new Error("unexpected-provider-route"); throw invariantFailure;
    };
    phase = "imports";
    const { GET: marketingGet } = await import("../../../src/app/api/admin/marketing-contact-sync/route.ts");
    const { GET: retentionGet } = await import("../../../src/app/api/admin/private-data-retention/route.ts");
    const { GET: rateGet } = await import("../../../src/app/api/cron/shipping-rate-cache-refresh/route.ts");
    const { GET: crmGet } = await import("../../../src/app/api/cron/highlevel-sync/route.ts");
    const { POST: stockPost } = await import("../../../src/app/api/webhooks/sanity/inventory-sync/route.ts");
    ({ closePrivateDbPool: closePool } = await import("../../../src/lib/private-db/client.ts"));
    const { encryptCredential } = await import("../../../src/lib/highlevel/crypto.ts");
    ({ client: sanityClient } = await import("../../../src/sanity/lib/client.ts"));
    let stockQuantity = 5;
    originalSanityFetch = sanityClient.fetch;
    sanityClient.fetch = async () => { await provider("stock-read", "recovery"); return { _id: "owned-worker-product", _type: "product", stockQuantity }; };
    const credentials = encryptCredential({ access_token: "owned-access", refresh_token: "owned-refresh" }, process.env.HIGHLEVEL_LOCATION_ID);
    await operator.query(`INSERT INTO highlevel_connections(location_id,credentials_ciphertext,expires_at,installed_by) VALUES($1,$2,now()+interval '1 day','11111111-1111-4111-8111-111111111111')
      ON CONFLICT(location_id) DO UPDATE SET credentials_ciphertext=EXCLUDED.credentials_ciphertext,expires_at=EXCLUDED.expires_at,refresh_state='ready'`, [process.env.HIGHLEVEL_LOCATION_ID, credentials]);
    const routes = new Map([["/marketing", marketingGet], ["/retention", retentionGet], ["/rates", rateGet], ["/crm", crmGet], ["/stock", stockPost]]);
    server = createServer(async (request, response) => {
      try {
        assert.ok(routes.has(request.url)); const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const result = await routes.get(request.url)(new Request(`http://127.0.0.1${request.url}`, { method: request.method,
          headers: request.headers, ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }));
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
      } catch { response.writeHead(500); response.end("OWNED_BRIDGE_FAILED"); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const perform = async (path, authorized = true) => {
      const body = JSON.stringify({ _id: "owned-worker-product", _type: "product" }), timestamp = Date.now();
      const result = await nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: path === "/stock" ? "POST" : "GET", signal: AbortSignal.timeout(20000),
        headers: path === "/stock" ? { "sanity-webhook-signature": authorized ? `t=${timestamp},v1=${createHmac("sha256", "owned-webhook").update(`${timestamp}.${body}`).digest("base64url")}` : "invalid" } : authorized ? { authorization: "Bearer owned-cron" } : {},
        ...(path === "/stock" ? { body } : {}),
      });
      const text = await result.text(); assert.doesNotMatch(text, /owned-provider-failure|owned-unused|owned-access|owned-refresh/);
      return { status: result.status, headers: result.headers, text };
    };
    const request = (path, authorized) => { const pending = perform(path, authorized); requests.push(pending); return pending; };

    phase = "authentication-and-policy";
    await reconcile(); await seedMarketing();
    let before = await operations();
    for (const path of ["/marketing", "/retention", "/rates", "/crm", "/stock"]) assert.equal((await request(path, false)).status, 401);
    assert.equal((await since(before)).length, 0); assert.deepEqual(providerCalls, []);
    for (const path of ["/marketing", "/retention", "/rates", "/crm", "/stock"]) assert.equal((await request(path)).status, 503);
    assert.equal((await since(before)).length, 0); assert.deepEqual(providerCalls, []);
    assert.equal((await operator.query("SELECT status FROM marketing_contact_sync_jobs WHERE idempotency_key='owned-worker'")).rows[0].status, "queued");
    checks.push("five-actual-exported-routes-authenticate-and-refuse-before-claims-provider-or-business-writes");

    phase = "marketing-settlement";
    await change(false, true); before = await operations();
    assert.equal((await request("/marketing")).status, 200);
    assert.equal((await operator.query("SELECT status,locked_by FROM marketing_contact_sync_jobs WHERE idempotency_key='owned-worker'")).rows[0].status, "succeeded");
    assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); assert.ok(providerCalls.includes("marketing")); await reconcile();
    checks.push("marketing-nonempty-actual-claim-provider-and-completion-receipt-over-tls");

    for (const fault of ["provider", "missing-receipt", "backend-death", "fence-in-flight"]) {
      phase = `marketing-${fault}`; await seedMarketing(); await change(false, true); before = await operations();
      const held = hold("marketing"), pending = request("/marketing");
      try {
        await held.entered; await change(false, false);
        assert.equal((await drain()).active, 1); assert.equal((await drain()).ledgerDrained, false);
        assert.equal((await request("/marketing")).status, 503);
        if (fault === "provider") providerFailure = "marketing";
        if (fault === "missing-receipt") await operator.query("UPDATE marketing_contact_sync_jobs SET locked_by='owned-lost-lock' WHERE idempotency_key='owned-worker'");
        if (fault === "fence-in-flight") await operator.query("UPDATE marketing_contact_sync_jobs SET locked_until=now()-interval '1 hour' WHERE idempotency_key='owned-worker'");
        if (fault === "backend-death") {
          const backend = (await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'", [target.user])).rows;
          assert.equal(backend.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [backend[0].pid]); await delay(25);
        }
      } finally { held.release(); }
      assert.equal((await pending).status, fault === "fence-in-flight" ? 200 : 503); gate = undefined;
      const state = (await operator.query("SELECT status FROM marketing_contact_sync_jobs WHERE idempotency_key='owned-worker'")).rows[0].status;
      assert.equal(state, fault === "provider" ? "retryable_failed" : fault === "missing-receipt" ? "processing" : "succeeded");
      assert.deepEqual((await since(before)).map(row => row.state), [fault === "fence-in-flight" ? "completed" : fault === "backend-death" ? "active" : "uncertain"]);
      await reconcile(); checks.push(`marketing-${fault}-retains-actual-lease-receipt-and-durable-admission-accounting`);
    }

    phase = "crm-settlement-and-missing-receipt";
    for (const missing of [false, true]) {
      await seedCrm(); if (missing) await suppressReceipt("highlevel_outbox", "NEW.status = 'succeeded'");
      await change(false, true); before = await operations();
      assert.equal((await request("/crm")).status, missing ? 503 : 200);
      assert.equal((await operator.query("SELECT status FROM highlevel_outbox WHERE event_key='owned-worker'")).rows[0].status, missing ? "processing" : "succeeded");
      assert.deepEqual((await since(before)).map(row => row.state), [missing ? "uncertain" : "completed"]);
      assert.ok(providerCalls.includes("crm")); await clearTriggers(); await reconcile();
    }
    checks.push("crm-actual-provider-contact-projection-and-job-receipts-with-missing-receipt-fault");

    phase = "rate-maintenance-classification-and-receipts";
    await change(false, true); before = await operations(); providerCalls.length = 0;
    assert.equal((await request("/rates")).status, 503); assert.equal((await since(before)).length, 0); assert.deepEqual(providerCalls, []); await reconcile();
    for (const fault of ["none", "cleanup", "missing-receipt"]) {
      await operator.query("DELETE FROM shipping_rate_cache"); await clearTriggers(); providerCalls.length = 0; providerFailure = fault === "cleanup" ? "rate-cleanup" : undefined;
      if (fault === "missing-receipt") await suppressReceipt("shipping_rate_cache");
      await change(true, false); before = await operations();
      assert.equal((await request("/rates")).status, fault === "none" ? 200 : 503);
      const count = Number((await operator.query("SELECT count(*) FROM shipping_rate_cache")).rows[0].count);
      assert.ok(fault === "missing-receipt" ? count === 0 : count > 0);
      assert.equal(providerCalls.filter(stage => stage === "rate-create").length, providerCalls.filter(stage => stage === "rate-cleanup").length);
      assert.deepEqual((await since(before)).map(row => row.state), [fault === "none" ? "completed" : "uncertain"]);
      await clearTriggers(); await reconcile();
    }
    checks.push("rates-new-work-policy-actual-cache-receipts-and-all-draft-cleanup-with-faults");

    phase = "retention-actual-migrated-record";
    await operator.query("INSERT INTO highlevel_oauth_states(hash,actor_id,expires_at) VALUES('owned-expired-state','11111111-1111-4111-8111-111111111111',now()-interval '1 day') ON CONFLICT(hash) DO UPDATE SET expires_at=EXCLUDED.expires_at");
    await change(true, false); before = await operations();
    assert.equal((await request("/retention")).status, 200);
    assert.equal((await operator.query("SELECT hash FROM highlevel_oauth_states WHERE hash='owned-expired-state'")).rows.length, 0);
    assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); await reconcile();
    checks.push("retention-new-work-entry-through-actual-expiry-and-existing-sequential-cleanup");

    phase = "signed-inventory-callback";
    await operator.query("DELETE FROM product_stock WHERE product_id='owned-worker-product'"); providerCalls.length = 0; providerFailure = undefined;
    await change(false, true); before = await operations();
    assert.equal((await request("/stock")).status, 200);
    assert.equal((await operator.query("SELECT on_hand,sanity_seed_quantity FROM product_stock WHERE product_id='owned-worker-product'")).rows[0].on_hand, 5);
    assert.deepEqual((await since(before)).map(row => row.state), ["completed"]); assert.deepEqual(providerCalls, ["stock-read"]); await reconcile();
    await suppressReceipt("product_stock"); stockQuantity = 7;
    await change(false, true); before = await operations();
    assert.equal((await request("/stock")).status, 503);
    assert.equal((await operator.query("SELECT on_hand FROM product_stock WHERE product_id='owned-worker-product'")).rows[0].on_hand, 5);
    assert.deepEqual((await since(before)).map(row => row.state), ["uncertain"]); await clearTriggers(); await reconcile();
    checks.push("actual-signed-sanity-callback-with-intercepted-catalog-read-stock-transaction-and-missing-update-receipt");
    if (invariantFailure) throw invariantFailure;
    return { status: "FRONTEND_WORKER_ADMISSION_OWNED_PASS", postgresMajor: target.serverMajor, checks, reconciliationEvidence,
      applicationSourceManifestSha256: frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url))).sourceManifestSha256,
      actualRouteExports: 5, loopbackHttp: true, verifiedPostgresTls: true, realBusinessDatabase: true, providersIntercepted: true,
      sanitySdkReadIntercepted: true, providerTouched: false, historicalWritersFenced: false, migrationAuthorized: false,
      syntheticLedgerSourceIdentity: true, applicationLogsSuppressed: logCount > 0,
      remaining: ["immutable-next-deployment-and-schedules", "historical-and-manual-provider-inventory", "revalidate-next-cache-context", "admin-oauth-campaign-owned-qualification", "shipping-pr91-and-execution", "parent-release-coordinator"] };
  } finally {
    gate?.release(); await Promise.allSettled(requests); await clearTriggers().catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (sanityClient && originalSanityFetch) sanityClient.fetch = originalSanityFetch;
    await closePool?.(); await operator.end(); globalThis.fetch = nativeFetch; Object.assign(console, originals);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exerciseOwnedFrontendWorkers().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${JSON.stringify({ status: "FRONTEND_WORKER_ADMISSION_OWNED_FAILED", phase, code: error.code,
      assertion: error instanceof assert.AssertionError ? error.message : undefined,
      frames: error.stack?.split("\n").filter(line => /owned-frontend-worker-admission\.mjs/u.test(line)) })}\n`);
    process.exitCode = 1;
  });
}
