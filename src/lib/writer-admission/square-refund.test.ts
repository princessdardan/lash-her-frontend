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
function rawRefund(status = "COMPLETED") {
  return JSON.stringify({ event_id: "owned-refund-event", type: "refund.updated", data: { object: { refund: {
    id: "owned-refund", payment_id: "owned-payment", status, amount_money: { amount: 500, currency: "CAD" },
    updated_at: "2026-11-04T00:00:00Z",
  } } } }, null, 2) + "\n";
}
function request(raw = rawRefund(), valid = true) {
  return new Request(url, { method: "POST", body: raw, headers: {
    "x-square-hmacsha256-signature": valid ? createHmac("sha256", key).update(url + raw).digest("base64") : "invalid",
  } });
}
function handler(run: WriterAdmissionRunner, overrides: Partial<Dependencies> = {}) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: false }),
    alerts: createServicePaymentAlertLogger({ logWarn: () => {}, logError: () => {} }),
    claimSquareInvoiceWebhookEvent: async () => { throw new Error("unexpected-invoice"); },
    recordSquareInvoiceWebhookEventProcessed: async () => { throw new Error("unexpected-invoice"); },
    findOrderBySquareInvoiceId: async () => null,
    finalizeNoShowCharge: async () => { throw new Error("unexpected-no-show"); },
    finalizeSquarePayment: async () => { throw new Error("unexpected-booking"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-invoice"); },
    recordSquareRefundEvent: async () => ({ duplicate: false }),
    reconcileProductRefund: async () => true,
    ...overrides,
  }, task => withWriterAdmission("recovery", task, run)());
}

test("verified refunds use independent recovery admission before persistence; closed recovery has no refund effects", async () => {
  const f = admission(); let records = 0, reconciliations = 0;
  const post = handler(f.run, {
    recordSquareRefundEvent: async input => {
      assert.ok(f.calls.at(-1)?.sql.includes("begin_operation"));
      assert.equal(input.providerEventId, "owned-refund-event");
      assert.equal(input.squareRefundId, "owned-refund");
      assert.equal(input.squarePaymentId, "owned-payment");
      assert.equal(input.payloadSanitized.event_id, "owned-refund-event");
      records++; return { duplicate: false };
    },
    reconcileProductRefund: async input => {
      assert.equal(input.providerRefundId, "owned-refund"); assert.equal(input.originalTransactionId, "owned-payment");
      assert.equal(input.amountCents, 500); assert.equal(input.currency, "CAD"); reconciliations++; return true;
    },
  });
  assert.equal((await post(request())).status, 200);
  assert.equal(records, 1); assert.equal(reconciliations, 1); assert.equal(f.state.uncertain, false);
  const begin = f.calls.find(call => call.sql.includes("begin_operation"));
  assert.equal(begin?.values?.[1], "recovery"); assert.equal(begin?.values?.[4], "7");
  assert.equal(JSON.stringify(f.calls).includes("owned-refund"), false);
  f.state.recovery = false;
  const blocked = request(); const response = await post(blocked);
  assert.equal(response.status, 503); assert.equal(blocked.bodyUsed, true);
  assert.equal(records, 1); assert.equal(reconciliations, 1);
  assert.equal(response.headers.get("retry-after"), "30");
});

test("invalid signatures, oversized bodies and malformed payloads never enter the refund ledger", async () => {
  const f = admission(); let effects = 0;
  const post = handler(f.run, { recordSquareRefundEvent: async () => { effects++; return { duplicate: false }; } });
  assert.equal((await post(request(rawRefund(), false))).status, 401);
  assert.equal((await post(request("x".repeat(64_001)))).status, 413);
  assert.equal((await post(request("{"))).status, 400);
  assert.equal(effects, 0); assert.equal(f.calls.length, 0);
});

test("duplicate refund receipts still reconcile a prior interrupted completion; pending refunds only record evidence", async () => {
  const f = admission(); let records = 0, reconciliations = 0;
  const post = handler(f.run, {
    recordSquareRefundEvent: async () => { records++; return { duplicate: true }; },
    reconcileProductRefund: async () => { reconciliations++; return false; },
  });
  for (const status of ["COMPLETED", "COMPLETED", "PENDING", "FAILED", "REJECTED"]) {
    assert.equal((await post(request(rawRefund(status)))).status, 200);
  }
  assert.equal(records, 5); assert.equal(reconciliations, 2); assert.equal(f.state.uncertain, false);
});

test("caught persistence and reconciliation failures remain uncertain, sanitized and retryable", async () => {
  for (const stage of ["record", "reconcile", "missing"]) {
    const f = admission(); let records = 0, reconciliations = 0;
    const post = handler(f.run, {
      recordSquareRefundEvent: stage === "missing" ? undefined : async () => {
        records++; if (stage === "record") throw new Error("owned-private-detail"); return { duplicate: false };
      },
      reconcileProductRefund: async () => { reconciliations++; throw new Error("owned-private-detail"); },
    });
    const response = await post(request());
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true);
    assert.equal(records, stage === "missing" ? 0 : 1); assert.equal(reconciliations, stage === "reconcile" ? 1 : 0);
    assert.equal((await response.text()).includes("owned-private-detail"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("refund reconciliation retains admission until completion after recovery closes", async () => {
  const f = admission(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const post = handler(f.run, { reconcileProductRefund: async () => { entered(); await held; return true; } });
  const pending = post(request()); await started;
  assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
  f.state.recovery = false;
  try { assert.equal((await post(request())).status, 503); }
  finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
});

test("lost settlement acknowledgement and connection loss never replay refund effects or acknowledge success", async () => {
  for (const mode of ["settlement", "socket"]) {
    const f = admission(); let effects = 0;
    f.state.loseSettlement = mode === "settlement";
    const response = await handler(f.run, { reconcileProductRefund: async () => {
      effects++; if (mode === "socket") f.client.emit("error", new Error("owned-private-detail")); return true;
    } })(request());
    assert.equal(response.status, 503); assert.equal(effects, 1);
    assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
    assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
});

test("off mode retains blank refund acknowledgements and persistence failures without a ledger", async () => {
  const f = admission(); let effects = 0;
  const success = await handler(f.off, { recordSquareRefundEvent: async () => { effects++; return { duplicate: false }; } })(request());
  assert.equal(success.status, 200); assert.equal(await success.text(), "");
  const failed = await handler(f.off, { reconcileProductRefund: async () => { effects++; throw new Error("owned-failure"); } })(request());
  assert.equal(failed.status, 503); assert.equal(await failed.text(), "");
  assert.equal(effects, 2); assert.equal(f.calls.length, 0);
});

test("non-refund Square branches remain explicitly outside this component even when refund recovery is closed", async () => {
  const f = admission(); f.state.recovery = false; let finalized = 0;
  const post = handler(f.run, {
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true }),
    isKnownNoShowChargeEvent: async () => false,
    finalizeSquarePayment: async () => { finalized++; return { finalized: true, duplicateEvent: false, status: "paid_calendar_pending" }; },
  });
  const raw = JSON.stringify({ event_id: "owned-payment-event", type: "payment.updated", data: { object: {
    payment: { id: "owned-payment", status: "COMPLETED", amount_money: { amount: 500, currency: "CAD" } },
  } } });
  assert.equal((await post(request(raw))).status, 200); assert.equal(finalized, 1); assert.equal(f.calls.length, 0);
});


test("the production route wires refund admission and fails closed on invalid enforcement configuration", async () => {
  const originalEnv = defaultDependencies.getEnv, originalRecord = defaultDependencies.recordSquareRefundEvent;
  const previousMode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  let effects = 0;
  defaultDependencies.getEnv = () => ({ notificationUrl: url, webhookSignatureKey: key });
  defaultDependencies.recordSquareRefundEvent = async () => { effects++; return { duplicate: false }; };
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try {
    assert.equal((await routePost(request())).status, 503); assert.equal(effects, 0);
    assert.equal((await routePost(request(rawRefund(), false))).status, 401); assert.equal(effects, 0);
  } finally {
    defaultDependencies.getEnv = originalEnv; defaultDependencies.recordSquareRefundEvent = originalRecord;
    if (previousMode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = previousMode;
  }
});
