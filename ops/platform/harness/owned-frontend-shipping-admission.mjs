// Child of the owned shipping launcher only. No configured/live URL input.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { changeFrontendAdmission, observeFrontendDrain, reconcileFrontendOperation } from "../frontend-admission.mjs";
import { frontendWriterInventory } from "../frontend-writer-inventory.mjs";
import { exerciseShippingExecution } from "./owned-shipping-execution.mjs";

export function ownedShippingTarget(environment) {
  assert.equal(environment.FRONTEND_SHIPPING_OWNED_TEST, "true");
  const port = Number(environment.OWNED_RECONCILIATION_PORT), major = Number(environment.OWNED_RECONCILIATION_MAJOR);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.ok([16, 18].includes(major));
  assert.ok(/^owned-[a-f0-9-]{36}$/u.test(environment.OWNED_RECONCILIATION_PASSWORD ?? ""));
  assert.ok(environment.NODE_EXTRA_CA_CERTS?.startsWith("/"));
  return { environment: "staging", host: "127.0.0.1", port, database: "frontend_admission_owned",
    user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
}

let phase = "configuration";
async function main() {
  const target = ownedShippingTarget(process.env), password = process.env.OWNED_RECONCILIATION_PASSWORD;
  const url = `postgresql://${target.user}:${password}@127.0.0.1:${target.port}/${target.database}?sslmode=verify-full`;
  const { VERCEL_PROJECT_BINDINGS } = await import("../../../src/lib/env/application-environment.mjs");
  Object.assign(process.env, {
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(target),
    FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project", NEXT_PUBLIC_SANITY_DATASET: "test-dataset",
    SQUARE_COMMERCE_ENABLED: "true", SQUARE_ENVIRONMENT: "sandbox", PAYMENT_GATEWAY_MODE: "live",
    SQUARE_ACCESS_TOKEN: "owned-unused-square-key", SQUARE_LOCATION_ID: "owned-location",
    SQUARE_APPLICATION_ID: "owned-square-application", SQUARE_WEBHOOK_SIGNATURE_KEY: "owned-square-webhook-key",
    CHITCHATS_SHIPPING_ENABLED: "true", CHITCHATS_ENVIRONMENT: "staging", CHITCHATS_REGION: "ontario_manitoba",
    CHITCHATS_CLIENT_ID: "owned-client", CHITCHATS_ACCESS_TOKEN: "owned-unused-chitchats-key",
    CRON_SECRET: "owned-shipping-cron", CHITCHATS_WORKER_CRON_SECRET: "owned-shipping-cron",
    CHITCHATS_QUOTE_SIGNING_SECRET: "owned-shipping-signing-secret-at-least-32-bytes",
    RESEND_API_KEY: "re_owned_unused", ADMIN_EMAIL: "owned@example.invalid", FROM_EMAIL: "owned@example.invalid",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "owned@example.invalid", ADMIN_OWNER_EMAILS: "owned@example.invalid",
    CHECKOUT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  const operator = new Client({ host: target.host, port: target.port, database: target.database, user: "frontend_test_admin",
    password, ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  const connections = [operator], checks = [], reconciliationEvidence = [], requests = [];
  const nativeFetch = globalThis.fetch, originalConsole = { log: console.log, warn: console.warn, error: console.error };
  let server, closePool, logCount = 0, bridgePort;
  console.log = console.warn = console.error = () => { logCount += 1; };
  try {
    let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
    const operations = async () => (await operator.query("SELECT id,kind,state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
    const change = async (recovery, newWork = recovery) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork, recovery })).epoch; };
    const drain = () => observeFrontendDrain(operator, target, epoch);
    const since = async (before) => (await operations()).filter((row) => !before.some((old) => old.id === row.id));
    const reconcile = async () => {
      await Promise.all(requests); await change(false, false);
      const unresolved = (await operations()).filter((row) => row.state !== "completed");
      if (unresolved.length) { assert.equal((await drain()).ledgerDrained, false); await assert.rejects(change(true)); }
      const evidence = createHash("sha256").update(JSON.stringify({ operations: await operations(),
        jobs: (await operator.query("SELECT id,shipment_id,type,status,outcome_unknown,outcome_code,lease_owner,lease_expires_at,payload FROM product_shipment_jobs ORDER BY id")).rows,
        shipments: (await operator.query("SELECT id,status,state_version,provider_shipment_id,redacted_at,destination,customs_lines,rates,raw_shipment,tracking_url,quote_token_hash FROM product_shipments ORDER BY id")).rows,
        outbox: (await operator.query("SELECT id,kind,status,provider_idempotency_key,provider_message_id FROM customer_email_outbox ORDER BY id")).rows,
        refunds: (await operator.query("SELECT id,status,amount_cents FROM product_order_refunds ORDER BY id")).rows,
      })).digest("hex");
      reconciliationEvidence.push(evidence);
      for (const row of unresolved) await reconcileFrontendOperation(operator, target, epoch, row.id, evidence);
      assert.equal((await drain()).ledgerDrained, true);
      assert.equal((await drain()).migrationAuthorized, false);
      assert.equal((await drain()).historicalWritersFenced, false);
    };
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), destination = new URL(request.url);
      if (destination.hostname === "127.0.0.1" && destination.port === String(bridgePort)) return nativeFetch(request);
      throw new Error("OWNED_UNEXPECTED_EXTERNAL_FETCH");
    };
    const { GET } = await import("../../../src/app/api/cron/chitchats-shipping/route.ts");
    const { closePrivateDbPool } = await import("../../../src/lib/private-db/client.ts"); closePool = closePrivateDbPool;
    const { runShippingOperationWorker, processClaimedShipmentOperation } = await import("../../../src/lib/shipping/operation-worker.ts");
    const { createChitChatsClient } = await import("../../../src/lib/shipping/chitchats-client.ts");
    const { redactExpiredShipmentPii } = await import("../../../src/lib/shipping/shipment-store.ts");
    const { runManualWriterAdmission } = await import("../../../src/lib/writer-admission/manual.ts");
    server = createServer(async (incoming, outgoing) => {
      try {
        const request = new Request(`https://owned.invalid${incoming.url}`, { method: "GET", headers: incoming.headers });
        let response;
        if (incoming.url?.startsWith("/api/cron/chitchats-shipping")) response = await GET(request);
        else if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) response = new Response(null, { status: 401 });
        else {
          try {
            if (incoming.url === "/direct-worker") response = Response.json({ operations: await runShippingOperationWorker() });
            else if (incoming.url === "/manual-worker") response = Response.json({ operations: await runManualWriterAdmission(true, "recovery", () => runShippingOperationWorker()) });
            else if (incoming.url === "/direct-redaction") response = Response.json({ redacted: await redactExpiredShipmentPii() });
            else if (incoming.url?.startsWith("/direct-claimed?")) {
              const id = new URL(request.url).searchParams.get("id");
              assert.match(id ?? "", /^[a-f0-9-]{36}$/u);
              // Test-owner snapshot construction is read-only. The exported
              // application helper must independently admit all subsequent work.
              const { getPrivateDb } = await import("../../../src/lib/private-db/client.ts");
              const { productShipmentJobs } = await import("../../../src/lib/private-db/schema.ts");
              const { eq } = await import("drizzle-orm");
              const [job] = await getPrivateDb().select().from(productShipmentJobs).where(eq(productShipmentJobs.id, id)).limit(1);
              response = Response.json({ outcome: await processClaimedShipmentOperation(job, { client: createChitChatsClient(), now: () => new Date(), workerId: "owned-direct" }) });
            } else response = new Response(null, { status: 404 });
          } catch { response = Response.json({ error: "Owned operation unavailable" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "30" } }); }
        }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
      } catch { outgoing.writeHead(500); outgoing.end("Owned bridge failed"); }
    });
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready)); bridgePort = server.address().port;
    const request = (path = "/api/cron/chitchats-shipping", authorization = `Bearer ${process.env.CRON_SECRET}`) => {
      const pending = nativeFetch(`http://127.0.0.1:${bridgePort}${path}`, { headers: { authorization } }).then(async (response) => ({ status: response.status, headers: response.headers, text: await response.text() }));
      requests.push(pending); return pending;
    };
    phase = "route-authentication";
    const before = await operations();
    assert.equal((await request(undefined, "")).status, 401); assert.deepEqual(await since(before), []);
    await change(false, false);
    for (const path of ["/api/cron/chitchats-shipping", "/direct-worker", "/direct-redaction", "/manual-worker"]) assert.equal((await request(path)).status, 503);
    assert.deepEqual(await since(before), []);
    checks.push("actual-route-and-direct-worker-maintenance-manual-calls-refuse-closed-admission-before-effects");
    await exerciseShippingExecution({ operator, target, password, connections, change, operations, since, reconcile, request, drain, checks, setPhase: (next) => { phase = next; } });
    return { status: "FRONTEND_SHIPPING_OWNED_PASS", postgresMajor: target.serverMajor, checks, reconciliationEvidence,
      applicationSourceManifestSha256: frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url))).sourceManifestSha256,
      actualRouteExport: true, loopbackHttp: true, verifiedPostgresTls: true, realBusinessDatabase: true,
      providersIntercepted: true, providerTouched: false, historicalWritersFenced: false, migrationAuthorized: false,
      syntheticLedgerSourceIdentity: true, applicationLogsSuppressed: logCount > 0 };
  } finally {
    await Promise.allSettled(requests);
    if (server) { server.closeAllConnections(); await new Promise((closed) => server.close(closed)); }
    await closePool?.();
    for (const client of connections) { try { await client.end(); } catch { /* Owned cluster cleanup only. */ } }
    globalThis.fetch = nativeFetch; Object.assign(console, originalConsole);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "FRONTEND_SHIPPING_OWNED_FAILED", phase,
      code: error.code, assertion: error instanceof assert.AssertionError ? error.message : undefined,
      frames: error.stack?.split("\n").filter((line) => /owned-(?:frontend-shipping-admission|shipping-execution)\.mjs/u.test(line)) })}\n`);
    process.exitCode = 1;
  });
}
