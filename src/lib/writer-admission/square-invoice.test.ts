import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { POST as routePost } from "@/app/api/webhooks/square/route";
import { defaultDependencies, createSquareWebhookPostHandler } from "@/app/api/webhooks/square/handler";
import { createServicePaymentAlertLogger } from "@/lib/booking/payments/service-payment-alerts";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveWriterAdmissionConfiguration } from "./config";
import { createWriterAdmissionRunner, type WriterAdmissionRunner } from "./runtime";
import { markWriterOperationUncertain } from "./context";
import type { CheckoutOrderRow } from "@/lib/commerce/order-store";
import { withWriterAdmission } from "./route";

function admission() {
  const url = "postgresql://protocol_runtime:owned-password@db.owned.invalid/owned?sslmode=verify-full";
  const configuration = resolveWriterAdmissionConfiguration({
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432,
      database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "a".repeat(64) }),
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
  });
  const state = { newWork: false, recovery: true, epoch: "7", uncertain: false, loseSettlement: false };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, authorized: true } }, async connect() {}, async end() {},
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT current_user")) return { rows: [{ username: "protocol_runtime", database: "owned", major: 18 }] };
      if (sql.includes("current_policy")) return { rows: [{ epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] };
      if (sql.includes("finish_operation")) {
        state.uncertain = values?.[1] === "uncertain";
        if (state.loseSettlement) throw new Error("owned-private-error");
      }
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({ getConfiguration: () => configuration, createClient: () => client });
  const off = createWriterAdmissionRunner({ getConfiguration: () => null });
  return { state, calls, run, off, client };
}

const url = "https://owned.invalid/api/webhooks/square", key = "owned-hmac-fixture";
type Dependencies = Parameters<typeof createSquareWebhookPostHandler>[0];
// Only classification fields are read by this handler; terminal persistence is controlled.
const order = { id: "owned-order-db", orderId: "owned-training-order", paymentProvider: "square", purpose: "training",
  providerMetadata: { flow: "training_square_invoice" }, providerOrderId: "owned-square-order" } as unknown as CheckoutOrderRow;
function rawInvoice(invoice: unknown = { id: "owned-invoice", reference_id: "owned-correlation" }) {
  return JSON.stringify({ event_id: "owned-invoice-event", type: "invoice.payment_made", data: { object: { invoice } } }, null, 2) + "\n";
}
function request(raw = rawInvoice(), valid = true) {
  return new Request(url, { method: "POST", body: raw, headers: {
    "x-square-hmacsha256-signature": valid ? createHmac("sha256", key).update(url + raw).digest("base64") : "invalid",
  } });
}
function handler(run: WriterAdmissionRunner, overrides: Partial<Dependencies> = {}) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: false }),
    alerts: createServicePaymentAlertLogger({ logWarn: () => {}, logError: () => {} }),
    findOrderBySquareInvoiceId: async () => order,
    claimSquareInvoiceWebhookEvent: async () => ({ duplicate: false }),
    finalizeTrainingSquareInvoicePayment: async () => ({ finalized: true, duplicateEvent: false, status: "paid" }),
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    finalizeNoShowCharge: async () => { throw new Error("unexpected-no-show"); },
    finalizeSquarePayment: async () => { throw new Error("unexpected-booking"); },
    ...overrides,
  }, undefined, task => withWriterAdmission("recovery", task, run)());
}

test("classified training invoices admit recovery before receipt and await processed persistence", async () => {
  const f = admission(); const effects: string[] = [];
  const post = handler(f.run, {
    findOrderBySquareInvoiceId: async id => { assert.equal(id, "owned-invoice"); assert.equal(f.calls.length, 0); return order; },
    claimSquareInvoiceWebhookEvent: async input => {
      assert.ok(f.calls.at(-1)?.sql.includes("begin_operation")); effects.push("receipt");
      assert.equal(input.providerCheckoutId, "owned-invoice"); assert.equal(input.orderDatabaseId, order.id);
      assert.equal(input.status, "received"); return { duplicate: false };
    },
    finalizeTrainingSquareInvoicePayment: async input => {
      effects.push("finalize"); assert.equal(input.squareInvoiceId, "owned-invoice"); assert.equal(input.source, "webhook");
      return { finalized: true, duplicateEvent: false, status: "paid" };
    },
    recordSquareInvoiceWebhookEventProcessed: async input => {
      assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
      assert.equal(input.status, "processed"); effects.push("processed");
    },
  });
  const response = await post(request()); assert.equal(response.status, 200); assert.equal(await response.text(), "");
  assert.deepEqual(effects, ["receipt", "finalize", "processed"]); assert.equal(f.state.uncertain, false);
  assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[1], "recovery");
  assert.equal(JSON.stringify(f.calls).includes("owned-invoice"), false);
});

test("closed recovery permits read-only classification but no training invoice effects", async () => {
  const f = admission(); f.state.recovery = false; let reads = 0, effects = 0;
  const post = handler(f.run, {
    findOrderBySquareInvoiceId: async () => { reads++; return order; },
    claimSquareInvoiceWebhookEvent: async () => { effects++; },
  });
  const req = request(); const response = await post(req);
  assert.equal(response.status, 503); assert.equal(req.bodyUsed, true); assert.equal(reads, 1); assert.equal(effects, 0);
  assert.equal(response.headers.get("retry-after"), "30");
});

test("invalid raw requests and failed classification do not claim an invoice operation", async () => {
  const f = admission(); let effects = 0;
  const post = handler(f.run, { findOrderBySquareInvoiceId: async () => { effects++; throw new Error("owned-private-detail"); } });
  assert.equal((await post(request(rawInvoice(), false))).status, 401);
  assert.equal((await post(request("x".repeat(64_001)))).status, 413);
  assert.equal((await post(request("{"))).status, 400);
  assert.equal((await post(request())).status, 503);
  assert.equal(effects, 1); assert.equal(f.calls.length, 0);
});

test("duplicate received and processed invoice receipts still recover finalization and notifications", async () => {
  for (const processingStatus of ["received", "processed"]) {
    const f = admission(); let finalizations = 0, processed = 0;
    const post = handler(f.run, {
      claimSquareInvoiceWebhookEvent: async () => ({ duplicate: true, processingStatus }),
      finalizeTrainingSquareInvoicePayment: async () => { finalizations++; return { finalized: false, duplicateEvent: true, status: "duplicate" }; },
      recordSquareInvoiceWebhookEventProcessed: async () => { processed++; },
    });
    assert.equal((await post(request())).status, 200); assert.equal(finalizations, 1); assert.equal(processed, 1);
    assert.equal(f.state.uncertain, false);
  }
});

test("claim, finalizer and processed-write exceptions leave uncertain retryable operations", async () => {
  for (const stage of ["claim", "finalize", "processed"]) {
    const f = admission(); const effects: string[] = [];
    const perform = (name: string) => { effects.push(name); if (stage === name) throw new Error("owned-private-detail"); };
    const post = handler(f.run, {
      claimSquareInvoiceWebhookEvent: async () => { perform("claim"); return { duplicate: false }; },
      finalizeTrainingSquareInvoicePayment: async () => { perform("finalize"); return { finalized: true, duplicateEvent: false, status: "paid" }; },
      recordSquareInvoiceWebhookEventProcessed: async () => { perform("processed"); },
    });
    const response = await post(request()); assert.equal(response.status, 503); assert.equal(f.state.uncertain, true);
    assert.equal(effects.at(-1), stage); assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
});

test("non-finalization and notification failures never record a processed invoice receipt", async () => {
  for (const result of [
    { finalized: false, duplicateEvent: false, status: "verification-failed" },
    { finalized: true, duplicateEvent: false, notificationFailed: true, status: "notification-failed" },
    { finalized: false, duplicateEvent: true, notificationFailed: true, status: "notification-failed" },
  ]) {
    const f = admission(); let processed = 0;
    const response = await handler(f.run, { finalizeTrainingSquareInvoicePayment: async () => result,
      recordSquareInvoiceWebhookEventProcessed: async () => { processed++; } })(request());
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal(processed, 0);
  }
});

test("caught transitive uncertainty behind duplicate success refuses acknowledgement", async () => {
  const f = admission();
  const response = await handler(f.run, { finalizeTrainingSquareInvoicePayment: async () => {
    markWriterOperationUncertain(); return { finalized: false, duplicateEvent: true, status: "duplicate" };
  } })(request());
  assert.equal(response.status, 503); assert.equal(f.state.uncertain, true);
});

test("each invoice effect remains active after recovery closes until it finishes", async () => {
  for (const stage of ["claim", "finalize", "processed"]) {
    const f = admission(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const perform = async (name: string) => { if (stage === name) { entered(); await held; } };
    const post = handler(f.run, {
      claimSquareInvoiceWebhookEvent: async () => { await perform("claim"); return { duplicate: false }; },
      finalizeTrainingSquareInvoicePayment: async () => { await perform("finalize"); return { finalized: true, duplicateEvent: false, status: "paid" }; },
      recordSquareInvoiceWebhookEventProcessed: async () => { await perform("processed"); },
    });
    const pending = post(request()); await started;
    assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
    f.state.recovery = false;
    try { assert.equal((await post(request())).status, 503); } finally { release(); }
    assert.equal((await pending).status, 200);
    assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
  }
});

test("lost settlement acknowledgement and connection loss do not replay invoice recovery", async () => {
  for (const mode of ["settlement", "socket"]) {
    const f = admission(); let effects = 0; f.state.loseSettlement = mode === "settlement";
    const response = await handler(f.run, { recordSquareInvoiceWebhookEventProcessed: async () => {
      effects++; if (mode === "socket") f.client.emit("error", new Error("owned-private-detail"));
    } })(request());
    assert.equal(response.status, 503); assert.equal(effects, 1);
    assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
  }
});

test("off mode preserves invoice success, retryable failures and duplicate recovery without ledger calls", async () => {
  const f = admission(); let effects = 0;
  const post = handler(f.off, { finalizeTrainingSquareInvoicePayment: async () => {
    effects++; return { finalized: false, duplicateEvent: true, status: "duplicate" };
  } });
  const success = await post(request()); assert.equal(success.status, 200); assert.equal(await success.text(), "");
  const failed = await handler(f.off, { claimSquareInvoiceWebhookEvent: async () => { throw new Error("owned-failure"); } })(request());
  assert.equal(failed.status, 503); assert.equal(await failed.text(), ""); assert.equal(effects, 1); assert.equal(f.calls.length, 0);
});

test("unknown, nontraining and malformed invoice IDs do not admit other Square branches", async () => {
  const missing = admission(); missing.state.recovery = false;
  assert.equal((await handler(missing.run)(request(rawInvoice({})))).status, 404);
  assert.equal(missing.calls.length, 0);
  for (const found of [null, { ...order, purpose: "product" } as CheckoutOrderRow]) {
    const f = admission(); f.state.recovery = false; let noShows = 0;
    const post = handler(f.run, {
      getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true }),
      findOrderBySquareInvoiceId: async () => found, isKnownNoShowChargeEvent: async () => true,
      finalizeNoShowCharge: async () => { noShows++; return { finalized: true, duplicateEvent: false, retryable: false, status: "charged" }; },
    });
    assert.equal((await post(request())).status, 200); assert.equal(noShows, 1); assert.equal(f.calls.length, 0);
  }
});

test("production route wires invoice admission and refuses invalid enforcement before receipt claim", async () => {
  const previous = { getEnv: defaultDependencies.getEnv, find: defaultDependencies.findOrderBySquareInvoiceId,
    claim: defaultDependencies.claimSquareInvoiceWebhookEvent, mode: process.env.FRONTEND_WRITER_ADMISSION_MODE };
  let effects = 0;
  defaultDependencies.getEnv = () => ({ notificationUrl: url, webhookSignatureKey: key });
  defaultDependencies.findOrderBySquareInvoiceId = async () => order;
  defaultDependencies.claimSquareInvoiceWebhookEvent = async () => { effects++; };
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try { assert.equal((await routePost(request())).status, 503); assert.equal(effects, 0); }
  finally {
    defaultDependencies.getEnv = previous.getEnv; defaultDependencies.findOrderBySquareInvoiceId = previous.find;
    defaultDependencies.claimSquareInvoiceWebhookEvent = previous.claim;
    if (previous.mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = previous.mode;
  }
});
