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
import { markWriterOperationUncertain, withWriterOperationContext } from "./context";
import { recoverSquareCommercePayment } from "@/lib/commerce/square-commerce-webhook-recovery";
import { sendProductOrderConfirmationEmailForOrder, type SendProductOrderConfirmationEmailForOrderDependencies } from "@/lib/commerce/product-order-email";
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
const order = { id: "owned-order-db", orderId: "owned-product-order", paymentProvider: "square", purpose: "product" } as CheckoutOrderRow;
function rawPayment(payment: unknown = { id: "owned-payment", reference_id: order.orderId, status: "COMPLETED", amount_money: { amount: 5000, currency: "CAD" } }) {
  return JSON.stringify({ event_id: "owned-payment-event", type: "payment.updated", data: { object: { payment } } }, null, 2) + "\n";
}
function request(raw = rawPayment(), valid = true) {
  return new Request(url, { method: "POST", body: raw, headers: {
    "x-square-hmacsha256-signature": valid ? createHmac("sha256", key).update(url + raw).digest("base64") : "invalid",
  } });
}
function handler(run: WriterAdmissionRunner, overrides: Partial<Dependencies> = {}) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: false, commerceEnabled: true }),
    alerts: createServicePaymentAlertLogger({ logWarn: () => {}, logError: () => {} }),
    findCheckoutOrderByOrderId: async () => order,
    recoverSquareCommercePayment: async () => ({ status: "recovered" }),
    findOrderBySquareInvoiceId: async () => null,
    claimSquareInvoiceWebhookEvent: async () => { throw new Error("unexpected-invoice"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-invoice"); },
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    finalizeNoShowCharge: async () => { throw new Error("unexpected-no-show"); },
    finalizeSquarePayment: async () => { throw new Error("unexpected-booking"); },
    ...overrides,
  }, undefined, undefined, task => withWriterAdmission("recovery", task, run)());
}

test("product recovery admits after SELECT classification and awaits the actual recovery service and outbox handoff", async () => {
  for (const transition of ["applied", "already_applied", "late_capture_refunded"] as const) {
    const f = admission(); const effects: string[] = [];
    const post = handler(f.run, {
      findCheckoutOrderByOrderId: async reference => { assert.equal(reference, order.orderId); assert.equal(f.calls.length, 0); return order; },
      recoverSquareCommercePayment: input => recoverSquareCommercePayment(input, {
        finalizeProduct: async payment => {
          assert.ok(f.calls.at(-1)?.sql.includes("begin_operation"));
          assert.equal(payment.orderReference, order.orderId); assert.equal(payment.squarePaymentId, "owned-payment");
          assert.equal(payment.amountCents, 5000); assert.equal(payment.currency, "CAD");
          effects.push("finalize"); return { transition };
        },
        sendProductConfirmationEmail: async () => {
          assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); effects.push("outbox");
        },
        finalizeTraining: async () => { throw new Error("unexpected-training"); },
        sendTrainingNotifications: async () => { throw new Error("unexpected-training"); }, logError() {},
      }),
    });
    assert.equal((await post(request())).status, 200);
    assert.deepEqual(effects, transition === "late_capture_refunded" ? ["finalize"] : ["finalize", "outbox"]);
    assert.equal(f.state.uncertain, false);
    assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[1], "recovery");
    assert.equal(JSON.stringify(f.calls).includes("owned-payment"), false);
  }
});

test("closed product recovery allows classification but refuses before business effects", async () => {
  const f = admission(); f.state.recovery = false; let reads = 0, effects = 0;
  const post = handler(f.run, { findCheckoutOrderByOrderId: async () => { reads++; return order; },
    recoverSquareCommercePayment: async () => { effects++; return { status: "recovered" }; } });
  const response = await post(request());
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(reads, 1); assert.equal(effects, 0);
});

test("invalid signatures, bodies and classification failures never enter product recovery", async () => {
  const f = admission(); let reads = 0;
  const post = handler(f.run, { findCheckoutOrderByOrderId: async () => { reads++; throw new Error("owned-private-detail"); } });
  assert.equal((await post(request(rawPayment(), false))).status, 401);
  assert.equal((await post(request("x".repeat(64001)))).status, 413);
  assert.equal((await post(request("{"))).status, 400);
  assert.equal((await post(request())).status, 503);
  assert.equal(reads, 1); assert.equal(f.calls.length, 0);
});

test("product conflicts, caught failures and operation-local uncertainty cannot acknowledge completion", async () => {
  for (const mode of ["conflict", "retryable", "throw", "uncertain"] as const) {
    const f = admission();
    const response = await handler(f.run, { recoverSquareCommercePayment: async () => {
      if (mode === "throw") throw new Error("owned-private-detail");
      if (mode === "uncertain") { markWriterOperationUncertain(); return { status: "recovered" }; }
      return { status: mode };
    } })(request());
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true);
    assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
});

test("closing recovery never settles an admitted finalizer or outbox handoff before it finishes", async () => {
  for (const stage of ["finalize", "outbox"]) {
    const f = admission(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const wait = async (name: string) => { if (stage === name) { entered(); await held; } };
    const post = handler(f.run, { recoverSquareCommercePayment: input => recoverSquareCommercePayment(input, {
      finalizeProduct: async () => { await wait("finalize"); return { transition: "applied" }; },
      sendProductConfirmationEmail: async () => { await wait("outbox"); },
      finalizeTraining: async () => { throw new Error("unexpected-training"); }, sendTrainingNotifications: async () => {}, logError() {},
    }) });
    const pending = post(request()); await started; f.state.recovery = false;
    try {
      assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
      assert.equal((await post(request())).status, 503);
    } finally { release(); }
    assert.equal((await pending).status, 200);
    assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
  }
});

test("lost product settlement acknowledgement or socket never replays business work", async () => {
  for (const mode of ["settlement", "socket"]) {
    const f = admission(); let effects = 0; f.state.loseSettlement = mode === "settlement";
    const response = await handler(f.run, { recoverSquareCommercePayment: async () => {
      effects++; if (mode === "socket") f.client.emit("error", new Error("owned-private-detail")); return { status: "recovered" };
    } })(request());
    assert.equal(response.status, 503); assert.equal(effects, 1);
  }
});

test("admission off preserves product success, duplicate, ignored, conflict and failure responses", async () => {
  for (const status of ["recovered", "duplicate", "ignored", "conflict", "retryable"] as const) {
    const f = admission(); const response = await handler(f.off, { recoverSquareCommercePayment: async () => ({ status }) })(request());
    assert.equal(response.status, status === "retryable" ? 503 : 200); assert.equal(await response.text(), ""); assert.equal(f.calls.length, 0);
  }
});

test("training card/split remain outside product admission and unknown/malformed payments do not enter it", async () => {
  for (const flow of ["training_square_card", "training_square_split"]) {
    const f = admission(); f.state.recovery = false; let effects = 0;
    const post = handler(f.run, { findCheckoutOrderByOrderId: async () => ({ ...order, purpose: "training", providerMetadata: { flow } }) as CheckoutOrderRow,
      recoverSquareCommercePayment: async () => { effects++; return { status: "recovered" }; } });
    assert.equal((await post(request())).status, 200); assert.equal(effects, 1); assert.equal(f.calls.length, 0);
  }
  const f = admission();
  assert.equal((await handler(f.run, { findCheckoutOrderByOrderId: async () => null })(request())).status, 404);
  assert.equal((await handler(f.run)(request(rawPayment({ id: "owned-payment" })))).status, 404);
  assert.equal(f.calls.length, 0);
});

test("production route supplies product admission before recovery effects", async () => {
  const previous = { getEnv: defaultDependencies.getEnv, find: defaultDependencies.findCheckoutOrderByOrderId,
    recover: defaultDependencies.recoverSquareCommercePayment, mode: process.env.FRONTEND_WRITER_ADMISSION_MODE };
  let effects = 0;
  defaultDependencies.getEnv = () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: false, commerceEnabled: true });
  defaultDependencies.findCheckoutOrderByOrderId = async () => order;
  defaultDependencies.recoverSquareCommercePayment = async () => { effects++; return { status: "recovered" }; };
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try { assert.equal((await routePost(request())).status, 503); assert.equal(effects, 0); }
  finally {
    defaultDependencies.getEnv = previous.getEnv; defaultDependencies.findCheckoutOrderByOrderId = previous.find;
    defaultDependencies.recoverSquareCommercePayment = previous.recover;
    if (previous.mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE; else process.env.FRONTEND_WRITER_ADMISSION_MODE = previous.mode;
  }
});

test("product notification no-op claims and unconfirmed enqueue preserve ordinary callers but retain admitted uncertainty", async () => {
  for (const mode of ["atomic-null", "fallback-null", "fallback-duplicate", "atomic-success", "fallback-success"] as const) {
    for (const admitted of [false, true]) {
      let calls = 0;
      const claimed = { orderDatabaseId: "owned-db", orderId: order.orderId, customerEmail: "owned@example.invalid" } as Awaited<ReturnType<SendProductOrderConfirmationEmailForOrderDependencies["claimProductOrderConfirmationEmail"]>>;
      const deps: SendProductOrderConfirmationEmailForOrderDependencies = {
        ...(mode.startsWith("atomic") ? { enqueuePaidProductOrderConfirmationEmail: async () => { calls++; return mode === "atomic-null" ? null : claimed; } } : {}),
        claimProductOrderConfirmationEmail: async () => { calls++; return mode === "fallback-null" ? null : claimed; },
        enqueueCustomerEmail: async () => { calls++; return mode !== "fallback-duplicate"; },
        recordProductOrderConfirmationEmailFailure: async () => {}, logError() {},
      };
      const run = () => sendProductOrderConfirmationEmailForOrder(order.orderId, deps);
      if (admitted && !mode.endsWith("success")) await assert.rejects(withWriterOperationContext(run), /WRITER_OPERATION_REQUIRES_REVIEW/);
      else if (admitted) await withWriterOperationContext(run); else await run();
      assert.equal(calls, mode.startsWith("atomic") || mode === "fallback-null" ? 1 : 2);
    }
  }
});
