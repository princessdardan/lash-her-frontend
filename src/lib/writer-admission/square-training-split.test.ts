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
import { recoverSquareCommercePayment } from "@/lib/commerce/square-commerce-webhook-recovery";
import { notifyPaidTrainingOrder, type NotifyPaidTrainingOrderDependencies } from "@/lib/commerce/training-paid-notification";
import { sendTrainingPaymentNotificationEmailsIfNeededWithDependencies } from "@/lib/commerce/training-payment-notification-service";
import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type { CheckoutOrderRow } from "@/lib/commerce/order-store";
import { chargeTrainingSplit, type TrainingSplitDependencies, type TrainingSplitState } from "@/lib/commerce/square-training-split";
import type { SquarePayment } from "@/lib/payments/square/payments-client";
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
const order = { id: "owned-order-db", orderId: "owned-training-order", paymentProvider: "square", purpose: "training",
  providerMetadata: { flow: "training_square_split" } } as unknown as CheckoutOrderRow;
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
  }, undefined, undefined, undefined, undefined, task => withWriterAdmission("recovery", task, run)());
}
function notification(input: { missing?: boolean; complete?: boolean; nullToken?: boolean; nullClaim?: boolean;
  falseMark?: "customer" | "staff"; failedSend?: boolean; wait?: (stage: string) => Promise<void> } = {}) {
  const calls: string[] = [];
  const enrollment = { enrollmentId: "owned-enrollment", studentPaymentEmailSentAt: input.complete ? new Date() : null,
    staffAlertedAt: input.complete ? new Date() : null, programSnapshot: { slug: "owned-training", title: "Owned Training" },
    checkoutOrder: { orderId: order.orderId, customerEmail: "owned@example.invalid", customerName: "Owned Fixture" },
  } as PendingTrainingEnrollmentRecord;
  const deps: NotifyPaidTrainingOrderDependencies = {
    getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => { calls.push("enrollment"); return input.missing ? null : enrollment; },
    getOrIssueTrainingSchedulingTokenForPaidOrder: async () => { calls.push("token"); return input.nullToken ? null : {
      ...enrollment, schedulingToken: "owned-schedule", tokenExpiresAt: new Date(),
    }; },
    sendTrainingPaymentNotificationEmailsIfNeeded: value => {
      assert.match(value.schedulingUrl, /^https:\/\/owned.invalid\//);
      return sendTrainingPaymentNotificationEmailsIfNeededWithDependencies(value, {
        claimTrainingPaymentEmails: async () => { calls.push("claim"); return input.nullClaim ? null : enrollment; },
        sendTrainingCustomerPaymentEmail: async () => { calls.push("customer"); await input.wait?.("customer"); if (input.failedSend) throw new Error("owned-private-detail"); },
        sendTrainingAdminPaymentEmail: async () => { calls.push("staff"); await input.wait?.("staff"); },
        markTrainingEnrollmentStudentPaymentEmailSent: async () => { calls.push("customer-recorded"); return input.falseMark !== "customer"; },
        markTrainingEnrollmentStaffAlerted: async () => { calls.push("staff-recorded"); return input.falseMark !== "staff"; },
        recordTrainingPaymentEmailFailure: async () => { calls.push("failure-recorded"); },
      });
    },
  };
  return { calls, run: () => notifyPaidTrainingOrder(order.orderId, "https://owned.invalid", deps) };
}

function split(f: ReturnType<typeof admission>, input: {
  stage?: TrainingSplitState["stage"];
  notification?: Parameters<typeof notification>[0];
  wait?: (stage: string) => Promise<void>;
} = {}) {
  let state: TrainingSplitState = { stage: input.stage ?? "capturing", cardAmountCents: 195500,
    afterpayAmountCents: 200000, squareOrderId: "owned-square-order", cardPaymentId: "owned-card", afterpayPaymentId: "owned-afterpay" };
  const calls: string[] = [];
  const step = async (name: string) => {
    assert.ok(f.calls.some(call => call.sql.includes("begin_operation")));
    assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
    calls.push(name); await input.wait?.(name);
  };
  const payments = new Map<string, SquarePayment>(["card", "afterpay"].map(leg => ["owned-" + leg, {
    id: "owned-" + leg, status: "APPROVED", order_id: state.squareOrderId, reference_id: order.orderId,
    amount_money: { amount: leg === "card" ? state.cardAmountCents : state.afterpayAmountCents, currency: "CAD" },
    source_type: leg === "card" ? "CARD" : "BUY_NOW_PAY_LATER",
  }]));
  const notify = notification({ ...input.notification, wait: async stage => { await step(stage); await input.notification?.wait?.(stage); } });
  const deps: TrainingSplitDependencies = {
    load: async () => { await step("load"); return { ...state }; },
    save: async value => { await step("save:" + value.stage); state = { ...value }; },
    createOrder: async () => { throw new Error("recovery-must-not-create-order"); },
    authorize: async () => { throw new Error("recovery-must-not-authorize"); },
    getPayment: async id => { await step("read:" + id); return { ...payments.get(id)! }; },
    payOrder: async (id, ids, key) => {
      await step("pay"); assert.equal(id, "owned-square-order");
      assert.deepEqual(ids, ["owned-card", "owned-afterpay"]); assert.equal(key, `training-split/${order.orderId}/pay`);
    },
    complete: async id => { await step("complete:" + id); payments.get(id)!.status = "COMPLETED"; },
    cancel: async id => { await step("cancel:" + id); payments.get(id)!.status = "CANCELED"; },
    cancelByKey: async key => { await step("cancel-key:" + key); assert.ok(key.startsWith(`training-split/${order.orderId}/`)); },
    finalize: async value => { await step("finalize"); state = { ...value }; },
    notify: async () => { await step("notify"); await notify.run(); },
    logError: reason => { calls.push("log:" + reason); },
  };
  const recover: NonNullable<Dependencies["recoverSquareCommercePayment"]> = payment => recoverSquareCommercePayment(payment, {
    recoverTrainingSplit: async reference => {
      assert.equal(reference, order.orderId);
      const result = await chargeTrainingSplit({ orderReference: reference, amountCents: 395500 }, deps);
      return result.ok ? { status: "recovered" } : { status: "retryable", reason: result.reason };
    },
    finalizeTraining: async () => { throw new Error("unexpected-card-finalizer"); },
    finalizeProduct: async () => { throw new Error("unexpected-product-finalizer"); },
    sendTrainingNotifications: async () => { throw new Error("unexpected-direct-notify"); },
    sendProductConfirmationEmail: async () => { throw new Error("unexpected-product-email"); }, logError() {},
  });
  return { calls, deps, payments, notify, recover, state: () => state };
}

function latch() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await held; } };
}

test("split webhook admits recovery before capture and awaits paid receipt and both notification writes", async () => {
  const f = admission(), s = split(f);
  const post = handler(f.run, {
    findCheckoutOrderByOrderId: async () => { assert.equal(f.calls.length, 0); return order; }, recoverSquareCommercePayment: s.recover,
  });
  assert.equal((await post(request())).status, 200); assert.equal(f.state.uncertain, false);
  assert.equal(s.state().stage, "paid"); assert.ok(s.calls.includes("pay")); assert.ok(s.calls.includes("finalize"));
  assert.deepEqual(s.notify.calls, ["enrollment", "token", "claim", "customer", "customer-recorded", "staff", "staff-recorded"]);
  assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[1], "recovery");
  assert.equal(JSON.stringify(f.calls).includes(order.orderId), false);
});

test("split paid duplicate recovers notifications without capture or new authorization", async () => {
  const f = admission(), s = split(f, { stage: "paid" });
  assert.equal((await handler(f.run, { recoverSquareCommercePayment: s.recover })(request())).status, 200);
  assert.deepEqual(s.calls, ["load", "notify", "customer", "staff"]); assert.equal(f.state.uncertain, false);
});

test("split interrupted authorization cancels original keys without creating a new order or payment", async () => {
  const f = admission(), s = split(f, { stage: "authorizing_afterpay" });
  delete s.state().afterpayPaymentId;
  assert.equal((await handler(f.run, { recoverSquareCommercePayment: s.recover })(request())).status, 503);
  assert.equal(s.state().stage, "canceled"); assert.equal(f.state.uncertain, true);
  assert.ok(s.calls.includes("cancel:owned-card"));
  assert.ok(s.calls.includes(`cancel-key:training-split/${order.orderId}/afterpay`));
  assert.equal(s.calls.includes("pay"), false); assert.equal(s.calls.includes("finalize"), false);
});

test("split partial capture remains uncertain without finalizing or canceling a captured leg", async () => {
  const f = admission(), s = split(f);
  s.payments.get("owned-card")!.status = "COMPLETED"; s.payments.get("owned-afterpay")!.status = "CANCELED";
  assert.equal((await handler(f.run, { recoverSquareCommercePayment: s.recover })(request())).status, 503);
  assert.equal(f.state.uncertain, true); assert.equal(s.calls.includes("finalize"), false);
  assert.equal(s.calls.some(call => call.startsWith("cancel")), false);
});

test("closed split recovery allows classification but no business effects", async () => {
  const f = admission(); f.state.recovery = false; let reads = 0, effects = 0;
  const response = await handler(f.run, {
    findCheckoutOrderByOrderId: async () => { reads++; return order; },
    recoverSquareCommercePayment: async () => { effects++; return { status: "recovered" }; },
  })(request());
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30"); assert.equal(reads, 1); assert.equal(effects, 0);
});

test("invalid signatures, oversized/malformed requests and failed classification never admit split work", async () => {
  const f = admission(); let reads = 0;
  const post = handler(f.run, { findCheckoutOrderByOrderId: async () => { reads++; throw new Error("owned-private-detail"); } });
  assert.equal((await post(request(rawPayment(), false))).status, 401);
  assert.equal((await post(request("x".repeat(64001)))).status, 413); assert.equal((await post(request("{"))).status, 400);
  assert.equal((await post(request())).status, 503); assert.equal(reads, 1); assert.equal(f.calls.length, 0);
});

test("noncompleted split events settle without provider recovery", async () => {
  const f = admission(), s = split(f);
  const raw = rawPayment({ id: "owned-payment", reference_id: order.orderId, status: "APPROVED", amount_money: { amount: 195500, currency: "CAD" } });
  assert.equal((await handler(f.run, { recoverSquareCommercePayment: s.recover })(request(raw))).status, 200);
  assert.deepEqual(s.calls, []); assert.equal(f.state.uncertain, false);
});

test("admitted split capture, completion, persistence and sends remain active after recovery closes", async () => {
  for (const stage of ["load", "save:capturing", "read:owned-card", "pay", "complete:owned-card", "complete:owned-afterpay", "finalize", "customer", "staff"]) {
    const f = admission(), gate = latch(), s = split(f, { wait: name => name === stage ? gate.wait() : Promise.resolve() });
    const post = handler(f.run, { recoverSquareCommercePayment: s.recover });
    const pending = post(request()); await gate.entered; f.state.recovery = false;
    try {
      assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
      assert.equal((await post(request())).status, 503);
    } finally { gate.release(); }
    assert.equal((await pending).status, 200);
    assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
  }
});

test("failed split provider observation awaits its sibling before compensation and uncertain settlement", async () => {
  const f = admission(), gate = latch(), s = split(f, { stage: "authorizing_afterpay" });
  s.deps.getPayment = async id => {
    if (id === "owned-card") throw new Error("owned-private-detail");
    await gate.wait(); return { ...s.payments.get(id)! };
  };
  const pending = handler(f.run, { recoverSquareCommercePayment: s.recover })(request()); await gate.entered;
  try {
    assert.equal(s.calls.some(call => call.startsWith("cancel")), false);
    assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
  } finally { gate.release(); }
  assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
  assert.ok(s.calls.includes("cancel:owned-card")); assert.ok(s.calls.includes("cancel:owned-afterpay"));
});

test("split cancellation awaits both legs even if one fails and recovery closes", async () => {
  const f = admission(), gate = latch(), s = split(f, { stage: "canceling" });
  s.deps.cancel = async id => {
    if (id === "owned-card") throw new Error("owned-private-detail");
    await gate.wait();
  };
  const post = handler(f.run, { recoverSquareCommercePayment: s.recover });
  const pending = post(request()); await gate.entered; f.state.recovery = false;
  try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); assert.equal((await post(request())).status, 503); }
  finally { gate.release(); }
  assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true); assert.equal(s.state().stage, "canceling");
});

test("lost capture acknowledgement preserves original split payment IDs and never replays within the operation", async () => {
  const f = admission(), s = split(f); let captures = 0;
  s.deps.payOrder = async () => { captures++; throw new Error("owned-private-detail"); };
  const response = await handler(f.run, { recoverSquareCommercePayment: s.recover })(request());
  assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal(captures, 1);
  assert.equal(s.state().cardPaymentId, "owned-card"); assert.equal(s.state().afterpayPaymentId, "owned-afterpay");
  assert.equal(s.state().stage, "capturing"); assert.equal(s.calls.includes("finalize"), false);
});

test("split success cannot hide notification ambiguity or failed sent-state persistence", async () => {
  for (const notification of [{ missing: true }, { nullClaim: true }, { falseMark: "customer" as const }, { falseMark: "staff" as const }, { nullToken: true }, { failedSend: true }]) {
    const f = admission(), s = split(f, { stage: "paid", notification });
    assert.equal((await handler(f.run, { recoverSquareCommercePayment: s.recover })(request())).status, 503); assert.equal(f.state.uncertain, true);
  }
});

test("split thrown, retryable and success-shaped uncertain outcomes stay retryable", async () => {
  for (const mode of ["throw", "retryable", "uncertain"] as const) {
    const f = admission();
    const response = await handler(f.run, { recoverSquareCommercePayment: async () => {
      if (mode === "throw") throw new Error("owned-private-detail");
      if (mode === "uncertain") markWriterOperationUncertain();
      return { status: mode === "retryable" ? "retryable" : "recovered" };
    } })(request());
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
});

test("split recovery does not replay after lost settlement acknowledgement or ledger socket", async () => {
  for (const mode of ["settlement", "socket"]) {
    const f = admission(); let effects = 0; f.state.loseSettlement = mode === "settlement";
    assert.equal((await handler(f.run, { recoverSquareCommercePayment: async () => {
      effects++; if (mode === "socket") f.client.emit("error", new Error("owned-private-detail")); return { status: "recovered" };
    } })(request())).status, 503); assert.equal(effects, 1);
  }
});

test("admission off preserves split webhook responses", async () => {
  for (const status of ["recovered", "duplicate", "ignored", "conflict", "retryable"] as const) {
    const f = admission();
    const response = await handler(f.off, { recoverSquareCommercePayment: async () => ({ status }) })(request());
    assert.equal(response.status, status === "retryable" ? 503 : 200); assert.equal(await response.text(), ""); assert.equal(f.calls.length, 0);
  }
});

test("product and training-card recovery keep independent adapters", async () => {
  for (const found of [{ ...order, purpose: "product" }, { ...order, providerMetadata: { flow: "training_square_card" } }]) {
    const f = admission(); f.state.recovery = false; let effects = 0;
    assert.equal((await handler(f.run, { findCheckoutOrderByOrderId: async () => found as CheckoutOrderRow,
      recoverSquareCommercePayment: async () => { effects++; return { status: "recovered" }; } })(request())).status, 200);
    assert.equal(effects, 1); assert.equal(f.calls.length, 0);
  }
});

test("production route supplies split recovery admission before any business effect", async () => {
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
