import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { NextRequest } from "next/server";
import { createTrainingCheckoutPostHandler } from "@/app/api/training-checkout/handler";
import { createTrainingSquareInvoicePostHandler } from "@/app/api/training-checkout/square-invoice/handler";
import { createSplitStatusHandler } from "@/app/api/training-checkout/split-status/handler";
import { chargeSquareTrainingOrder } from "@/lib/commerce/square-training-checkout";
import { chargeTrainingSplit, type TrainingSplitDependencies, type TrainingSplitState } from "@/lib/commerce/square-training-split";
import type { SquarePayment } from "@/lib/payments/square/payments-client";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveWriterAdmissionConfiguration } from "./config";
import { createWriterAdmissionRunner } from "./runtime";
import { withWriterAdmission } from "./route";

function admission() {
  const url = "postgresql://protocol_runtime:owned-password@db.owned.invalid/owned?sslmode=verify-full";
  const configuration = resolveWriterAdmissionConfiguration({
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", APP_ENV: "staging", VERCEL: "1",
    VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432,
      database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "a".repeat(64) }),
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
  });
  const state = { newWork: true, recovery: true, uncertain: false, epoch: "1" };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const operations = new Map<string, string>();
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {}, async end() {},
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT current_user")) return { rows: [{ username: "protocol_runtime", database: "owned", major: 18 }] };
      if (sql.includes("current_policy")) return { rows: [{ epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] };
      if (sql.includes("begin_operation")) operations.set(String(values?.[0]), "active");
      if (sql.includes("finish_operation")) {
        state.uncertain = values?.[1] === "uncertain";
        operations.set(String(values?.[0]), String(values?.[1]));
      }
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({ getConfiguration: () => configuration, createClient: () => client });
  const off = createWriterAdmissionRunner({ getConfiguration: () => null });
  return { state, calls, operations, run, off };
}

const program = { _id: "owned-program", slug: "owned-training", title: "Owned training", description: "Owned fixture", blocks: [],
  checkoutEnabled: true, price: 1499, currency: "CAD" as const, isAvailable: true };
const body = { programSlug: program.slug, programId: program._id, customerName: "Owned Customer", customerEmail: "owned@example.invalid",
  payment: { sourceId: "owned-nonce" }, reservationKey: "owned-reservation-123" };
const request = (value: unknown = body) => new NextRequest("https://owned.invalid/api/training-checkout", { method: "POST", body: JSON.stringify(value) });

function checkout(overrides: Partial<Parameters<typeof createTrainingCheckoutPostHandler>[0]> = {}) {
  return createTrainingCheckoutPostHandler({
    getTrainingProgramBySlug: async () => program, getPromotionCode: async () => null, squareCommerceEnabled: true,
    reserveSquareTrainingOrder: async () => ({ orderId: "owned-order", databaseId: "owned-row" }),
    createTrainingEnrollment: async () => ({}),
    chargeSquareTrainingOrder: async () => ({ ok: true, squarePaymentId: "owned-payment", transition: "applied" }),
    ...overrides,
  });
}

function invoice(
  failAt?: string,
  failure = new Error("owned-private-marker"),
  onEffect: (stage: string) => void = () => {},
  publishedInvoiceId = "owned-invoice",
) {
  const effects: string[] = [];
  const effect = (stage: string) => { effects.push(stage); onEffect(stage); if (stage === failAt) throw failure; };
  const handler = createTrainingSquareInvoicePostHandler({
    isEnabled: () => true, locationId: "owned-location", getTrainingProgramBySlug: async () => program, getPromotionCode: async () => null,
    createPendingSquareInvoiceOrder: async () => { effect("persist"); return { _id: "owned-row", orderId: "owned-order" }; },
    recordSquareInvoicePublication: async () => { effect("record"); },
    squareInvoiceClient: {
      createCustomer: async () => { effect("customer"); return "owned-customer"; },
      createOrder: async () => { effect("order"); return "owned-square-order"; },
      createInvoice: async () => { effect("invoice"); return { id: "owned-invoice", version: 1 }; },
      publishInvoice: async () => { effect("publish"); return { id: publishedInvoiceId, version: 2, publicUrl: "https://owned.invalid/invoice" }; },
      getOrder: async () => ({ id: "owned-square-order" }), getInvoice: async () => ({ id: "owned-invoice" }),
    },
  });
  return { effects, handler };
}

function split() {
  let state: TrainingSplitState = { stage: "reserved", cardAmountCents: 195500, afterpayAmountCents: 200000 };
  const payments = new Map<string, SquarePayment>(), calls: string[] = [];
  const deps: TrainingSplitDependencies = {
    load: async () => ({ ...state }), save: async value => { state = { ...value }; },
    createOrder: async () => { calls.push("order"); return "owned-square-order"; },
    authorize: async input => {
      const leg = input.idempotency_key.endsWith("/card") ? "card" : "afterpay";
      calls.push(`authorize:${leg}`);
      const value = { id: leg, status: "APPROVED", order_id: input.order_id, reference_id: input.reference_id,
        amount_money: input.amount_money, source_type: leg === "card" ? "CARD" : "BUY_NOW_PAY_LATER" };
      payments.set(leg, value); return value;
    },
    getPayment: async id => ({ ...payments.get(id)! }),
    payOrder: async () => { calls.push("capture"); for (const payment of payments.values()) payment.status = "COMPLETED"; },
    complete: async id => { calls.push("complete"); payments.get(id)!.status = "COMPLETED"; },
    cancel: async id => { calls.push(`cancel:${id}`); payments.get(id)!.status = "CANCELED"; },
    cancelByKey: async () => { calls.push("cancel-key"); },
    finalize: async value => { calls.push("finalize"); state = { ...value }; },
    notify: async () => { calls.push("notify"); }, logError: () => {},
  };
  const payment = { method: "afterpay_card" as const, expectedAmountCents: 395500, afterpayAmountCents: 200000,
    afterpay: { method: "afterpay" as const, sourceId: "owned-afterpay", expectedAmountCents: 200000 }, card: { sourceId: "owned-card" } };
  const run = (recover = false) => chargeTrainingSplit({ orderReference: "owned-order", amountCents: 395500, ...(recover ? {} : { payment }) }, deps);
  return { deps, calls, payments, run, state: () => state };
}

test("closed training new-work refuses the actual handlers before bodies or downstream effects", async () => {
  const f = admission(); f.state.newWork = false; let reservations = 0;
  const primary = checkout({ reserveSquareTrainingOrder: async () => { reservations++; throw new Error(); } });
  const hosted = invoice();
  for (const handler of [primary, hosted.handler]) {
    const req = request();
    assert.equal((await withWriterAdmission("new-work", handler, f.run)(req)).status, 503);
    assert.equal(req.bodyUsed, false);
  }
  assert.equal(reservations, 0); assert.deepEqual(hosted.effects, []);
});

test("training reservation and enrollment occur after committed admission and retain the original payment key", async () => {
  const f = admission(), effects: string[] = [];
  const handler = checkout({
    reserveSquareTrainingOrder: async input => {
      assert.ok(f.calls.at(-1)?.sql.includes("begin_operation"));
      assert.equal(input.reservationKey, body.reservationKey); effects.push("reserve");
      return { orderId: "owned-order", databaseId: "owned-row" };
    },
    createTrainingEnrollment: async () => { effects.push("enroll"); },
    chargeSquareTrainingOrder: async input => {
      assert.equal(input.orderReference, "owned-order"); effects.push("charge");
      return { ok: true, squarePaymentId: "owned-payment", transition: "applied" };
    },
  });
  assert.equal((await withWriterAdmission("new-work", handler, f.run)(request())).status, 200);
  assert.deepEqual(effects, ["reserve", "enroll", "charge"]); assert.equal(f.state.uncertain, false);
});

test("caught training cleanup failures remain uncertain behind a payment-rejected response", async () => {
  const f = admission();
  const handler = checkout({
    chargeSquareTrainingOrder: async () => ({ ok: false, reason: "payment_failed", retryWithNewReservation: true }),
    markTrainingOrderVerificationFailed: async () => { throw new Error("owned-private-marker"); },
  });
  assert.equal((await withWriterAdmission("new-work", handler, f.off)(request())).status, 402);
  assert.equal((await withWriterAdmission("new-work", handler, f.run)(request())).status, 503);
  assert.equal(f.state.uncertain, true);
});

test("invoice customer, order, draft, persistence and publication errors cannot complete admission behind HTTP 400", async () => {
  for (const stage of ["customer", "order", "invoice", "persist", "publish", "record"]) {
    const f = admission(), s = invoice(stage);
    assert.equal((await withWriterAdmission("new-work", s.handler, f.off)(request())).status, 400);
    const before = s.effects.length;
    const response = await withWriterAdmission("new-work", s.handler, f.run)(request());
    assert.equal(response.status, 503, stage); assert.equal(f.state.uncertain, true, stage);
    assert.equal(s.effects.length, before * 2, "no operation replays provider work");
    assert.equal((await response.text()).includes("owned-private-marker"), false);
  }
});

test("invoice success retains its response and records every effect after admission", async () => {
  const f = admission();
  const s = invoice(undefined, undefined, () => { assert.ok(f.calls.at(-1)?.sql.includes("begin_operation")); });
  const response = await withWriterAdmission("new-work", s.handler, f.run)(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { publicUrl: "https://owned.invalid/invoice", orderId: "owned-order" });
  assert.deepEqual(s.effects, ["customer", "order", "invoice", "persist", "publish", "record"]);
  assert.equal(f.state.uncertain, false);
});

test("a crossed invoice publication acknowledgement stays uncertain without a local write", async () => {
  const f = admission();
  const s = invoice(undefined, undefined, undefined, "owned-other-invoice");
  const response = await withWriterAdmission("new-work", s.handler, f.run)(request());
  assert.equal(response.status, 503);
  assert.deepEqual(s.effects, ["customer", "order", "invoice", "persist", "publish"]);
  assert.equal(f.state.uncertain, true);
  assert.equal((await response.text()).includes("owned-other-invoice"), false);
});

test("invoice BNPL and publication error branches preserve off-mode responses and retain enforced uncertainty", async () => {
  for (const [name, status] of [["SquareInvoiceBNPLUnavailableError", 422], ["SquareInvoicePublishError", 502], ["SquareInvoiceVersionConflictError", 502]] as const) {
    const f = admission(), error = new Error("owned-private-marker"); error.name = name;
    const s = invoice("publish", error);
    assert.equal((await withWriterAdmission("new-work", s.handler, f.off)(request())).status, status);
    assert.equal((await withWriterAdmission("new-work", s.handler, f.run)(request())).status, 503);
    assert.equal(f.state.uncertain, true);
  }
});

test("recorded training payments never reauthorize when caught notification recovery fails", async () => {
  const f = admission(); let authorized = 0;
  const handler = async () => {
    const result = await chargeSquareTrainingOrder({ orderReference: "owned-order", amountCents: 500, currency: "CAD", sourceId: "owned-nonce" }, {
      observePayment: async () => ({ state: "captured", squarePaymentId: "owned-payment" }),
      authorizePayment: async () => { authorized++; throw new Error(); },
      capturePayment: async () => { throw new Error(); }, voidPayment: async () => {}, voidPaymentByIdempotencyKey: async () => {},
      finalize: async () => { throw new Error(); }, onCaptured: async () => true, sendNotifications: async () => { throw new Error("owned-private-marker"); }, logError: () => {},
    });
    assert.equal(result.ok, true); return Response.json(result);
  };
  assert.equal((await withWriterAdmission("new-work", handler, f.off)()).status, 200);
  assert.equal((await withWriterAdmission("new-work", handler, f.run)()).status, 503);
  assert.equal(f.state.uncertain, true); assert.equal(authorized, 0);
});

test("split lost capture acknowledgement retains uncertainty and independent recovery reuses the same payments", async () => {
  const f = admission(), s = split(), capture = s.deps.payOrder;
  s.deps.payOrder = async (...args) => { await capture(...args); throw new Error("owned-private-marker"); };
  assert.equal((await withWriterAdmission("new-work", async () => Response.json(await s.run()), f.run)()).status, 503);
  assert.equal(f.state.uncertain, true); assert.equal(s.state().stage, "capturing");
  const original = [...f.operations.keys()][0];
  f.state.newWork = false; f.state.epoch = "7";
  const recovery = withWriterAdmission("recovery", createSplitStatusHandler({
    findOrder: async () => ({ orderId: "owned-order", customerEmail: body.customerEmail, isSplit: true }), recover: async () => s.run(true),
  }), f.run);
  assert.equal((await recovery(request({ reservationKey: body.reservationKey, customerEmail: body.customerEmail }))).status, 200);
  assert.equal(s.calls.filter(call => call.startsWith("authorize:")).length, 2);
  assert.equal(s.calls.filter(call => call === "capture").length, 1);
  assert.equal(f.operations.get(original), "uncertain", "business recovery does not reconcile the original execution automatically");
  f.state.recovery = false;
  const req = request({ reservationKey: body.reservationKey, customerEmail: body.customerEmail });
  assert.equal((await recovery(req)).status, 503); assert.equal(req.bodyUsed, false);
});

test("split observation failure waits for the sibling provider read before cancellation or settlement", async () => {
  const f = admission(), s = split(), getPayment = s.deps.getPayment;
  let entered!: () => void, release!: () => void, settled = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  s.deps.getPayment = async id => {
    if (id === "card") throw new Error("owned-private-marker");
    entered(); await held; return getPayment(id);
  };
  const pending = withWriterAdmission("new-work", async () => Response.json(await s.run()), f.run)().then(response => { settled = true; return response; });
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
  assert.equal(s.calls.some(call => call.startsWith("cancel")), false);
  release(); assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
});

test("nonthrowing pending and partial capture outcomes cannot settle a split as completed", async () => {
  for (const mode of ["pending", "partial"]) {
    const f = admission(), s = split(), getPayment = s.deps.getPayment;
    s.deps.getPayment = async id => ({ ...await getPayment(id), status: mode === "pending" ? "PENDING" : id === "card" ? "COMPLETED" : "FAILED" });
    assert.equal((await withWriterAdmission("new-work", async () => Response.json(await s.run()), f.run)()).status, 503);
    assert.equal(f.state.uncertain, true); assert.equal(s.calls.includes("finalize"), false);
  }
});

test("confirmed declined and cancelled split payments keep their normal rejection without artificial uncertainty", async () => {
  const f = admission(), s = split(), authorize = s.deps.authorize;
  s.deps.authorize = async input => { const payment = await authorize(input); payment.status = "FAILED"; return payment; };
  const response = await withWriterAdmission("new-work", async () => {
    const result = await s.run(); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.retryWithNewReservation, true);
    return Response.json(result, { status: 402 });
  }, f.run)();
  assert.equal(response.status, 402); assert.equal(f.state.uncertain, false); assert.equal(s.state().stage, "canceled");
});
