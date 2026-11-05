import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { POST as routePost } from "@/app/api/webhooks/square/route";
import { defaultDependencies, createSquareWebhookPostHandler, isKnownNoShowChargeEventWithRepository } from "@/app/api/webhooks/square/handler";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { parseVerifiedSquareWebhook } from "@/lib/booking/square-webhook";
import { finalizeNoShowCharge, type NoShowChargeFinalizerDependencies, type NoShowChargeEventRecord } from "@/lib/booking/payments/service-no-show-charge-finalizer";
import type { NoShowChargeRecordDetail } from "@/lib/booking/payments/service-no-show-invoice";
import type { ServicePaymentAlertLogger } from "@/lib/booking/payments/service-payment-alerts";
import { resolveWriterAdmissionConfiguration } from "./config";
import { createWriterAdmissionRunner, type WriterAdmissionRunner } from "./runtime";
import { markWriterOperationUncertain } from "./context";
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
function rawPayment(status = "COMPLETED") {
  return JSON.stringify({ event_id: "owned-event", type: "payment.updated", data: { object: { payment: {
    id: "owned-payment", order_id: "owned-order", status, amount_money: { amount: 10000, currency: "CAD" },
  } } } }, null, 2) + "\n";
}
function rawInvoice() {
  return JSON.stringify({ event_id: "owned-invoice-event", type: "invoice.payment_made", data: { object: {
    invoice: { id: "owned-invoice", order_id: "owned-order", status: "PAID" }, payment: { id: "owned-payment", order_id: "owned-order" },
  } } });
}
function request(raw = rawPayment(), valid = true) {
  return new Request(url, { method: "POST", body: raw, headers: {
    "x-square-hmacsha256-signature": valid ? createHmac("sha256", key).update(url + raw).digest("base64") : "invalid",
  } });
}
function latch() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await held; } };
}
function business(f: ReturnType<typeof admission>, options: {
  event?: NoShowChargeEventRecord; missing?: boolean; localStatus?: NoShowChargeRecordDetail["status"];
  providerStatus?: string; providerAmount?: number; fail?: string; wait?: (stage: string) => Promise<void>;
} = {}) {
  const calls: string[] = [];
  const step = async (name: string) => {
    assert.ok(f.calls.some(call => call.sql.includes("begin_operation")));
    assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
    calls.push(name); await options.wait?.(name);
    if (options.fail === name) throw new Error("owned-private-detail");
  };
  const record: NoShowChargeRecordDetail = { id: "owned-no-show", status: options.localStatus ?? "charge_pending",
    squareInvoiceId: "owned-invoice", squareOrderId: "owned-order", squarePaymentId: "owned-payment",
    maxChargeCents: 10000, currency: "CAD" };
  const alerts: ServicePaymentAlertLogger = { alert: async () => { await step("alert"); } };
  const deps: NoShowChargeFinalizerDependencies = {
    alerts,
    repository: {
      findNoShowChargeEventByProviderEventId: async () => { await step("event"); return options.event ?? null; },
      findNoShowChargeRecordBySquareInvoiceId: async () => { await step("invoice-record"); return options.missing ? null : record; },
      findNoShowChargeRecordBySquarePaymentId: async () => { await step("payment-record"); return options.missing ? null : record; },
      findNoShowChargeRecordBySquareOrderId: async () => { await step("order-record"); return options.missing ? null : record; },
      finalizeNoShowChargeRecord: async value => { await step("finalize"); assert.equal(value.noShowChargeRecordId, record.id); },
      recordNoShowChargeWebhookEvent: async value => { await step("receipt"); assert.equal(value.processingStatus, "ignored"); },
      updateNoShowChargeRecord: async () => { throw new Error("unexpected-nonatomic-write"); },
    },
    providerReader: {
      getPayment: async id => { await step("payment"); return { payment: { id, status: options.providerStatus ?? "COMPLETED",
        amount_money: { amount: options.providerAmount ?? 10000, currency: "CAD" }, order_id: "owned-order" } }; },
      getInvoice: async id => { await step("invoice"); return { invoice: { id, status: "PAID", order_id: "owned-order", version: 1 } }; },
    },
  };
  return { calls, deps, alerts, run: ({ event }: Parameters<Dependencies["finalizeNoShowCharge"]>[0]) => finalizeNoShowCharge({ event }, deps) };
}
function handler(run: WriterAdmissionRunner, overrides: Partial<Dependencies> = {}) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true, commerceEnabled: false }),
    alerts: { alert() {} },
    isKnownNoShowChargeEvent: async () => true,
    finalizeNoShowCharge: async () => ({ duplicateEvent: false, finalized: true, noShowChargeRecordId: "owned-no-show", retryable: false, status: "charged" }),
    findOrderBySquareInvoiceId: async () => null,
    claimSquareInvoiceWebhookEvent: async () => { throw new Error("unexpected-commerce-invoice"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-commerce-invoice"); },
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    finalizeSquarePayment: async () => { throw new Error("unexpected-booking"); },
    ...overrides,
  }, undefined, undefined, undefined, undefined, undefined, task => withWriterAdmission("recovery", task, run)());
}

test("classified no-show payment and invoice recovery admit before provider and durable finalization", async () => {
  for (const raw of [rawPayment(), rawInvoice()]) {
    const f = admission(), b = business(f);
    const post = handler(f.run, { isKnownNoShowChargeEvent: async () => { assert.equal(f.calls.length, 0); return true; }, finalizeNoShowCharge: b.run });
    assert.equal((await post(request(raw))).status, 200); assert.equal(f.state.uncertain, false);
    assert.ok(b.calls.includes("payment")); assert.ok(b.calls.includes("finalize"));
    if (raw === rawInvoice()) assert.ok(b.calls.includes("invoice"));
    assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[1], "recovery");
    assert.equal(JSON.stringify(f.calls).includes("owned-payment"), false);
  }
});

test("closed no-show recovery allows classification but refuses before any business effect", async () => {
  const f = admission(); f.state.recovery = false; let reads = 0, effects = 0;
  const response = await handler(f.run, { isKnownNoShowChargeEvent: async () => { reads++; return true; },
    finalizeNoShowCharge: async () => { effects++; throw new Error("unexpected-effect"); } })(request());
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30"); assert.equal(reads, 1); assert.equal(effects, 0);
});

test("no-show reads, final receipt and failed-charge alert remain admitted after recovery closes", async () => {
  for (const stage of ["event", "payment-record", "payment", "finalize", "alert", "receipt", "invoice"]) {
    const f = admission(), gate = latch();
    const nonterminal = stage === "receipt", failed = stage === "alert";
    const b = business(f, { providerStatus: failed ? "FAILED" : "COMPLETED", wait: name => name === stage ? gate.wait() : Promise.resolve() });
    const post = handler(f.run, { finalizeNoShowCharge: b.run, alerts: b.alerts });
    const pending = post(request(stage === "invoice" ? rawInvoice() : rawPayment(nonterminal ? "APPROVED" : failed ? "FAILED" : "COMPLETED")));
    await gate.entered; f.state.recovery = false;
    try {
      assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
      assert.equal((await post(request())).status, 503);
    } finally { gate.release(); }
    assert.equal((await pending).status, 200); assert.equal(f.state.uncertain, false);
  }
});

test("no-show terminal provider conflicts, missing records, 404 and mismatches remain uncertain", async () => {
  for (const options of [{ localStatus: "charge_failed" as const }, { missing: true }, { providerAmount: 1 }, { providerStatus: "PENDING" }]) {
    const f = admission(), b = business(f, options);
    assert.equal((await handler(f.run, { finalizeNoShowCharge: b.run, alerts: b.alerts })(request())).status, 503, JSON.stringify(options));
    assert.equal(f.state.uncertain, true); assert.equal(b.calls.includes("finalize"), false);
  }
  const f = admission(), b = business(f);
  b.deps.providerReader.getPayment = async () => { throw new Error("Square status 404"); };
  assert.equal((await handler(f.run, { finalizeNoShowCharge: b.run })(request())).status, 503);
  assert.equal(f.state.uncertain, true); assert.ok(b.calls.includes("receipt"));
});

test("unknown no-show alert finishes before uncertain settlement and cannot escape into booking", async () => {
  const f = admission(), gate = latch(), b = business(f, { missing: true, wait: name => name === "alert" ? gate.wait() : Promise.resolve() });
  const pending = handler(f.run, { finalizeNoShowCharge: b.run })(request());
  await gate.entered;
  try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); }
  finally { gate.release(); }
  assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
});

test("no-show receipt replay distinguishes completed, failed and nonterminal evidence from ambiguous receipts", async () => {
  for (const [processingStatus, eventStatus, success] of [
    ["processed", "COMPLETED", true], ["failed", "FAILED", true], ["ignored", "APPROVED", true],
    ["ignored", "COMPLETED", false], ["failed", "COMPLETED", false], ["received", "COMPLETED", false],
  ] as const) {
    const f = admission(), b = business(f, { event: { noShowChargeRecordId: "owned-no-show", processingStatus } });
    assert.equal((await handler(f.run, { finalizeNoShowCharge: b.run })(request(rawPayment(eventStatus)))).status, success ? 200 : 503);
    assert.equal(f.state.uncertain, !success); assert.deepEqual(b.calls, ["event"]);
  }
});

test("known terminal no-show duplicate finishes without provider replay", async () => {
  const f = admission(), b = business(f, { localStatus: "charged" });
  assert.equal((await handler(f.run, { finalizeNoShowCharge: b.run })(request())).status, 200);
  assert.deepEqual(b.calls, ["event", "payment-record"]); assert.equal(f.state.uncertain, false);
});

test("no-show thrown read, provider and persistence failures stay retryable without leaking private errors", async () => {
  for (const fail of ["event", "payment-record", "payment", "finalize", "receipt", "alert"]) {
    const f = admission(), b = business(f, { fail, providerAmount: fail === "alert" ? 1 : undefined });
    const response = await handler(f.run, { finalizeNoShowCharge: b.run })(request(rawPayment(fail === "receipt" ? "APPROVED" : "COMPLETED")));
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
});

test("lost no-show settlement acknowledgement and ledger socket never replay effects", async () => {
  for (const mode of ["settlement", "socket"]) {
    const f = admission(); f.state.loseSettlement = mode === "settlement"; let effects = 0;
    const response = await handler(f.run, { finalizeNoShowCharge: async () => {
      effects++; if (mode === "socket") f.client.emit("error", new Error("owned-private-detail"));
      return { finalized: true, duplicateEvent: false, status: "charged", retryable: false };
    } })(request());
    assert.equal(response.status, 503); assert.equal(effects, 1);
  }
});

test("no-show retryable and success-shaped uncertain outcomes cannot settle completed", async () => {
  for (const mode of ["retryable", "marker", "unfinished"]) {
    const f = admission();
    assert.equal((await handler(f.run, { finalizeNoShowCharge: async () => {
      if (mode === "marker") markWriterOperationUncertain();
      return { finalized: mode !== "unfinished", duplicateEvent: false, status: "charged", retryable: mode === "retryable" };
    } })(request())).status, 503); assert.equal(f.state.uncertain, true);
  }
});

test("lost no-show classification cannot fall through to booking after admission refuses", async () => {
  for (const enforce of [true, false]) {
    const f = admission(); let booking = 0;
    const response = await handler(enforce ? f.run : f.off, {
      finalizeNoShowCharge: async () => ({ finalized: false, duplicateEvent: false, retryable: false, status: "ignored" }),
      finalizeSquarePayment: async () => { booking++; return { finalized: true, duplicateEvent: false, status: "booked" }; },
    })(request());
    assert.equal(response.status, enforce ? 503 : 200); assert.equal(booking, enforce ? 0 : 1);
  }
});

test("invalid signatures, oversized/malformed requests and failed no-show classification never admit", async () => {
  const f = admission(); let reads = 0;
  const post = handler(f.run, { isKnownNoShowChargeEvent: async () => { reads++; throw new Error("owned-private-detail"); } });
  assert.equal((await post(request(rawPayment(), false))).status, 401); assert.equal((await post(request("x".repeat(64001)))).status, 413);
  assert.equal((await post(request("{"))).status, 400); assert.equal((await post(request())).status, 503);
  assert.equal(reads, 1); assert.equal(f.calls.length, 0);
});

test("actual no-show classification awaits all sibling lookups before propagating failure", async () => {
  const gate = latch(); let finished = false;
  const event = parseVerifiedSquareWebhook(rawInvoice());
  const pending = isKnownNoShowChargeEventWithRepository(event, {
    findNoShowChargeRecordBySquareInvoiceId: async () => { throw new Error("owned-private-detail"); },
    findNoShowChargeRecordBySquarePaymentId: async () => { await gate.wait(); return null; },
    findNoShowChargeRecordBySquareOrderId: async () => null,
  }).finally(() => { finished = true; });
  const rejected = assert.rejects(pending, /No-show charge lookup failed/);
  await gate.entered;
  try { assert.equal(finished, false); } finally { gate.release(); }
  await rejected;
});

test("no-show classification covers each reference and nonmatching booking keeps its independent behavior", async () => {
  const event = parseVerifiedSquareWebhook(rawInvoice());
  for (const matching of ["invoice", "payment", "order", "none"]) {
    const found = { id: "owned-no-show" } as NoShowChargeRecordDetail;
    assert.equal(await isKnownNoShowChargeEventWithRepository(event, {
      findNoShowChargeRecordBySquareInvoiceId: async () => matching === "invoice" ? found : null,
      findNoShowChargeRecordBySquarePaymentId: async () => matching === "payment" ? found : null,
      findNoShowChargeRecordBySquareOrderId: async () => matching === "order" ? found : null,
    }), matching !== "none");
  }
  const f = admission(); f.state.recovery = false; let effects = 0;
  assert.equal((await handler(f.run, { isKnownNoShowChargeEvent: async () => false,
    finalizeSquarePayment: async () => { effects++; return { finalized: true, duplicateEvent: false, status: "booked" }; } })(request())).status, 200);
  assert.equal(effects, 1); assert.equal(f.calls.length, 0);
});

test("admission off preserves no-show retryable and ignored HTTP acknowledgements", async () => {
  for (const status of ["charged", "charge_failed", "duplicate", "ignored"] as const) {
    const f = admission();
    const response = await handler(f.off, { finalizeNoShowCharge: async () => ({ finalized: false,
      duplicateEvent: false, retryable: true, status, noShowChargeRecordId: "owned-no-show" }) })(request());
    assert.equal(response.status, 200); assert.equal(await response.text(), ""); assert.equal(f.calls.length, 0);
  }
});

test("production route supplies no-show recovery admission before finalization", async () => {
  const previous = { env: defaultDependencies.getEnv, known: defaultDependencies.isKnownNoShowChargeEvent,
    finalize: defaultDependencies.finalizeNoShowCharge, mode: process.env.FRONTEND_WRITER_ADMISSION_MODE };
  let effects = 0;
  defaultDependencies.getEnv = () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true });
  defaultDependencies.isKnownNoShowChargeEvent = async () => true;
  defaultDependencies.finalizeNoShowCharge = async () => { effects++; throw new Error("unexpected-effect"); };
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try { assert.equal((await routePost(request())).status, 503); assert.equal(effects, 0); }
  finally {
    defaultDependencies.getEnv = previous.env; defaultDependencies.isKnownNoShowChargeEvent = previous.known;
    defaultDependencies.finalizeNoShowCharge = previous.finalize;
    if (previous.mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE; else process.env.FRONTEND_WRITER_ADMISSION_MODE = previous.mode;
  }
});
