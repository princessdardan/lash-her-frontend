import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { POST as routePost } from "@/app/api/webhooks/square/route";
import { defaultDependencies, createSquareWebhookPostHandler } from "@/app/api/webhooks/square/handler";
import { createSquarePaymentFinalizer } from "@/lib/booking/square-payment-finalizer";
import { finalizePaidBooking, finalizeAppointmentPaymentWithLock, type FinalizePaidBookingResult } from "@/lib/booking/finalizer";
import { sendBookingConfirmationEmailForOrder } from "@/lib/booking/email";
import { sendProviderBookingEmailForOrder } from "@/lib/booking/provider-booking-email";
import type { BookingHoldRecord } from "@/lib/booking/holds";
import type { SquareClient } from "@/lib/booking/square-client";
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
function raw(type = "payment.updated") {
  const object = type === "order.updated" ? { order: { id: "owned-order" } } : { payment: {
    id: "owned-payment", order_id: "owned-order", status: "COMPLETED", amount_money: { amount: 10000, currency: "CAD" },
  } };
  return JSON.stringify({ event_id: "owned-event", type, data: { object } }, null, 2) + "\n";
}
function request(body = raw(), valid = true) {
  return new Request(url, { method: "POST", body, headers: {
    "x-square-hmacsha256-signature": valid ? createHmac("sha256", key).update(url + body).digest("base64") : "invalid",
  } });
}
function latch() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await held; } };
}
function handler(run: WriterAdmissionRunner, overrides: Partial<Dependencies> = {}) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true, commerceEnabled: false }),
    alerts: { alert() {} }, isKnownNoShowChargeEvent: async () => false, isKnownOperationalPayment: async () => false,
    finalizeNoShowCharge: async () => { throw new Error("unexpected-no-show"); }, findOrderBySquareInvoiceId: async () => null,
    claimSquareInvoiceWebhookEvent: async () => { throw new Error("unexpected-invoice"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-invoice"); },
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    finalizeSquarePayment: async () => { throw new Error("unexpected-booking"); }, ...overrides,
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    task => withWriterAdmission("recovery", task, run)());
}
function hold(): BookingHoldRecord {
  const now = new Date("2032-01-01T12:00:00.000Z");
  return { id: "owned-hold", publicReference: "owned-reference", bookingModelVersion: 1, bookingType: "in-person-appointment",
    state: "payment_pending", customer: { name: "Owned customer", email: "client@owned.invalid", phone: "5555555555" },
    createdAt: now, updatedAt: now, expiresAt: new Date("2032-01-01T12:30:00.000Z"), googleEventId: null,
    offeringId: "owned-offering", offeringSnapshot: {}, payment: null, paymentSessionReference: "owned-session",
    selectedStart: new Date("2032-01-03T12:00:00.000Z"), selectedEnd: new Date("2032-01-03T13:00:00.000Z"), timezone: "America/Toronto" };
}
function business(f: ReturnType<typeof admission>, options: {
  status?: string; amount?: number; identity?: boolean; duplicate?: boolean; missingOrder?: boolean; missingHold?: boolean;
  holdState?: BookingHoldRecord["state"]; finalization?: FinalizePaidBookingResult; fail?: string;
  wait?: (stage: string) => Promise<void>; noFailedWriter?: boolean; off?: boolean;
  paymentId?: string; providerOrderId?: string; returnedOrderId?: string; tenderPaymentId?: string;
} = {}) {
  const calls: string[] = [], record = hold();
  if (options.duplicate) { record.state = options.holdState ?? "booked"; record.googleEventId = "owned-calendar-event"; }
  const step = async (stage: string) => {
    if (!options.off) assert.ok(f.calls.some(call => call.sql.includes("begin_operation")));
    assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
    calls.push(stage); await options.wait?.(stage);
    if (options.fail === stage) throw new Error("owned-private-detail");
  };
  const finalize = createSquarePaymentFinalizer({
    getEnv: () => ({ accessToken: "owned-fixture", environment: "sandbox", locationId: "owned-location",
      serviceBookingReturnUrl: "https://owned.invalid/return", serviceBookingWebhookUrl: url, webhookSignatureKey: key }),
    repository: {
      claimSquareEvent: async () => { await step("claim"); return options.duplicate ? { duplicate: true, processingStatus: "processed" } : { duplicate: false }; },
      findSquareOrder: async () => { await step("order"); return options.missingOrder ? null : {
        id: "owned-order-db", orderId: "lh-sq-owned", amountCents: 10000, providerOrderId: options.providerOrderId ?? "owned-order", providerPaymentId: options.identity ? "other-payment" : options.paymentId ?? "owned-payment",
        purpose: "appointment_full", squareLocationId: "owned-location", status: options.duplicate ? "paid" : "pending",
      }; },
      recordSquareEvent: async () => { await step("receipt"); return { duplicate: false }; },
      recordSquarePaymentPendingCalendar: async () => { await step("paid"); },
      recordSquarePaymentFailed: options.noFailedWriter ? undefined : async () => { await step("failed"); },
    },
    squareClientFactory: () => ({
      getPayment: async () => { await step("payment"); return { payment: { id: options.paymentId ?? "owned-payment", order_id: options.providerOrderId ?? "owned-order",
        status: options.status ?? "COMPLETED", amount_money: { amount: options.amount ?? 10000, currency: "CAD" } } }; },
      getOrder: async () => { await step("provider-order"); return { order: { id: options.returnedOrderId ?? "owned-order", tenders: [{ payment_id: options.tenderPaymentId ?? "owned-payment" }] } }; },
    } as unknown as SquareClient),
    getAppointmentHoldByCheckoutOrderPublicId: async () => { await step("duplicate-hold"); return options.missingHold ? null : record; },
    finalizeAppointmentPaymentForOrder: async () => options.finalization ?? finalizeAppointmentPaymentWithLock({
      holdId: record.id, lock: {
        acquire: async () => { await step("lock"); return true; }, release: async () => { await step("release"); },
      }, finalize: () => finalizePaidBooking({ holdId: record.id, now: new Date("2032-01-01T12:01:00.000Z"),
        payment: { amountCents: 10000, currency: "CAD", source: "webhook", transactionId: "owned-payment" },
        calendar: { findExistingEventForHold: async () => { await step("calendar-find"); return null; },
          insertBookingEvent: async () => { await step("calendar-insert"); return "owned-calendar-event"; } },
        repository: {
          lockHold: async () => { await step("hold"); return options.missingHold ? null : record; },
          recordPaidPendingBooking: async () => { await step("paid-hold"); record.state = "paid_pending_booking"; return record; },
          markBooked: async () => { await step("booked"); record.state = "booked"; record.googleEventId = "owned-calendar-event"; return record; },
          markBookingFailed: async () => { await step("manual"); return record; },
          markPaidUnbookableForRebooking: async () => { await step("rebooking"); return record; },
          recordCalendarRetryPending: async () => { await step("retry"); return record; },
        },
      }),
    }),
    sendBookingConfirmationEmailForOrder: orderId => sendBookingConfirmationEmailForOrder(orderId, {
      claimBookingConfirmationEmailByOrderId: async () => { await step("customer-claim"); return record; },
      sendBookingConfirmationEmail: async () => { await step("customer-email"); },
      markBookingConfirmationEmailSent: async () => { await step("customer-sent"); return { correctionRequired: false }; },
      recordBookingConfirmationEmailFailure: async () => { await step("customer-failure"); }, logError() {},
      sendProviderBookingEmailForOrder: id => sendProviderBookingEmailForOrder(id, {
        claimProviderBookingEmail: async () => { await step("provider-claim"); return {
          bookingType: "in-person-appointment", capturedAmountCents: 10000, currency: "CAD", customer: record.customer,
          end: record.selectedEnd, holdId: record.id, offeringSnapshot: {}, orderId: id, paymentProvider: "square", paymentPurpose: "appointment_full",
          providerName: "Owned provider", recipientEmails: ["provider@owned.invalid"], start: record.selectedStart, timezone: record.timezone, tipAmountCents: 0,
        }; }, sendProviderBookingEmail: async () => { await step("provider-email"); },
        markProviderBookingEmailSent: async () => { await step("provider-sent"); },
        recordProviderBookingEmailFailure: async () => { await step("provider-failure"); }, logError() {},
      }),
    }),
    sendBookingSchedulingFailureAdminEmail: async () => { await step("admin-alert"); },
  });
  return { calls, run: finalize, alerts: { alert: async () => { await step("alert"); } } };
}

test("ordinary payment and order webhook recovery admits before actual claiming, Square lookup, Calendar and emails", async () => {
  for (const type of ["payment.created", "payment.updated", "order.updated"]) {
    const f = admission(), b = business(f);
    assert.equal((await handler(f.run, { finalizeSquarePayment: b.run, alerts: b.alerts })(request(raw(type)))).status, 200);
    assert.equal(f.state.uncertain, false);
    for (const stage of ["claim", "payment", "paid", "calendar-insert", "booked", "release", "customer-sent", "provider-sent", "receipt"]) assert.ok(b.calls.includes(stage), stage);
    assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[1], "recovery");
    assert.equal(JSON.stringify(f.calls).includes("owned-payment"), false);
  }
});

test("closed ordinary recovery refuses before event claiming or provider work", async () => {
  const f = admission(); f.state.recovery = false; const b = business(f);
  const response = await handler(f.run, { finalizeSquarePayment: b.run })(request());
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30"); assert.deepEqual(b.calls, []);
});

test("ordinary claiming, Square, Calendar, lock cleanup, notification and receipt lifetimes survive closure", async () => {
  for (const stage of ["claim", "payment", "order", "paid", "lock", "hold", "paid-hold", "calendar-find", "calendar-insert", "booked", "release",
    "customer-claim", "customer-email", "customer-sent", "provider-claim", "provider-email", "provider-sent", "receipt", "provider-order", "failed", "alert"]) {
    const f = admission(), gate = latch(), b = business(f, { status: ["failed", "alert"].includes(stage) ? "FAILED" : undefined,
      wait: name => name === stage ? gate.wait() : Promise.resolve() });
    const post = handler(f.run, { finalizeSquarePayment: b.run, alerts: b.alerts });
    const pending = post(request(raw(stage === "provider-order" ? "order.updated" : "payment.updated")));
    await gate.entered; f.state.recovery = false;
    try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); assert.equal((await post(request())).status, 503); }
    finally { gate.release(); }
    assert.equal((await pending).status, 200, stage); assert.equal(f.state.uncertain, false, stage);
  }
});

test("ordinary failures, including caught Calendar/cleanup errors, remain retryable and sanitized", async () => {
  for (const fail of ["claim", "payment", "order", "paid", "lock", "hold", "paid-hold", "calendar-find", "calendar-insert", "booked", "release",
    "customer-claim", "customer-email", "customer-sent", "provider-claim", "provider-email", "provider-sent", "receipt"]) {
    const f = admission(), b = business(f, { fail });
    const response = await handler(f.run, { finalizeSquarePayment: b.run, alerts: b.alerts })(request());
    assert.equal(response.status, 503, fail); assert.equal(f.state.uncertain, true, fail);
    assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
});

test("ordinary mismatch, missing records, unknown and authorization-only payments cannot establish completion", async () => {
  for (const options of [{ amount: 1 }, { status: "PENDING", amount: 1 }, { identity: true }, { duplicate: true, identity: true }, { missingOrder: true }, { missingHold: true }, { status: "UNKNOWN" }, { status: "APPROVED" }, { status: "FAILED", noFailedWriter: true }]) {
    const f = admission(), b = business(f, options);
    assert.equal((await handler(f.run, { finalizeSquarePayment: b.run, alerts: b.alerts })(request())).status, 503); assert.equal(f.state.uncertain, true);
  }
});

test("ordinary lookup identities must agree with the signed event and requested Square resources", async () => {
  for (const [type, options] of [
    ["payment.updated", { paymentId: "other-payment" }],
    ["payment.updated", { providerOrderId: "other-order" }],
    ["order.updated", { returnedOrderId: "other-order" }],
    ["order.updated", { tenderPaymentId: "other-payment" }],
    ["order.updated", { providerOrderId: "other-order" }],
  ] as const) {
    for (const off of [false, true]) {
      const f = admission(), b = business(f, { ...options, off });
      const response = await handler(off ? f.off : f.run, { finalizeSquarePayment: b.run })(request(raw(type)));
      assert.equal(response.status, off ? 200 : 503, `${type}: ${JSON.stringify(options)}`);
      assert.equal(f.state.uncertain, !off);
      assert.ok(b.calls.includes("receipt"));
    }
  }
});

test("ordinary manual, rebooking and pending business outcomes remain uncertain even after a processed receipt", async () => {
  for (const status of ["finalization_pending", "hold_not_found", "manual_followup", "paid_unbookable_rebooking_pending"] as const) {
    const f = admission(), b = business(f, { finalization: { ok: false, error: "owned-business-outcome", status } });
    assert.equal((await handler(f.run, { finalizeSquarePayment: b.run })(request())).status, 503); assert.ok(b.calls.includes("receipt"));
  }
  const f = admission(), b = business(f, { finalization: { ok: false, error: "owned-business-outcome", status: "manual_followup" }, fail: "admin-alert" });
  assert.equal((await handler(f.run, { finalizeSquarePayment: b.run })(request())).status, 503); assert.ok(b.calls.includes("admin-alert"));
});

test("ordinary processed duplicates verify terminal booking and await notification recovery", async () => {
  for (const options of [{ duplicate: true }, { duplicate: true, missingHold: true }, { duplicate: true, missingOrder: true },
    { duplicate: true, holdState: "paid_pending_booking" as const }, { duplicate: true, holdState: "manual_followup" as const }]) {
    const f = admission(), b = business(f, options);
    const expected = options.missingHold || options.missingOrder || options.holdState ? 503 : 200;
    assert.equal((await handler(f.run, { finalizeSquarePayment: b.run })(request())).status, expected);
    assert.equal(b.calls.includes("payment"), false);
    assert.equal(f.state.uncertain, expected === 503);
  }
});

test("ordinary known nonterminal and confirmed unpaid observations may complete", async () => {
  for (const status of ["PENDING", "FAILED", "CANCELED"]) {
    const f = admission(), b = business(f, { status });
    assert.equal((await handler(f.run, { finalizeSquarePayment: b.run, alerts: b.alerts })(request())).status, 200);
    assert.equal(b.calls.includes("paid"), false); assert.equal(f.state.uncertain, false);
  }
});

test("ordinary alert completion is awaited before uncertain settlement", async () => {
  const f = admission(), gate = latch(), b = business(f, { fail: "claim" });
  const pending = handler(f.run, { finalizeSquarePayment: b.run, alerts: { alert: async () => { await gate.wait(); } } })(request());
  await gate.entered;
  try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); } finally { gate.release(); }
  assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
});

test("lost ordinary socket/settlement acknowledgements never replay business work", async () => {
  for (const mode of ["socket", "settlement"]) {
    const f = admission(); f.state.loseSettlement = mode === "settlement"; let effects = 0;
    const response = await handler(f.run, { finalizeSquarePayment: async () => { effects++;
      if (mode === "socket") f.client.emit("error", new Error("owned-private-detail"));
      return { duplicateEvent: false, finalized: true, status: "booked" };
    } })(request());
    assert.equal(response.status, 503); assert.equal(effects, 1);
  }
});

test("ordinary admission-off acknowledgements and unrelated event gates remain unchanged", async () => {
  for (const options of [{ amount: 1 }, { missingOrder: true }, { status: "UNKNOWN" }, { finalization: { ok: false as const, error: "owned", status: "manual_followup" as const } }]) {
    const f = admission(), b = business(f, { ...options, off: true });
    assert.equal((await handler(f.off, { finalizeSquarePayment: b.run, alerts: b.alerts })(request())).status, 200);
    assert.equal(f.calls.length, 0); assert.ok(b.calls.includes("receipt"));
  }
  const f = admission();
  assert.equal((await handler(f.run)(request(raw("card.created")))).status, 200); assert.equal(f.calls.length, 0);
  assert.equal((await handler(f.run)(request(raw(), false))).status, 401);
  assert.equal((await handler(f.run)(request("x".repeat(64001)))).status, 413);
  assert.equal((await handler(f.run)(request("{"))).status, 400); assert.equal(f.calls.length, 0);
});

test("production route supplies ordinary recovery admission before the finalizer", async () => {
  const previous = { env: defaultDependencies.getEnv, noShow: defaultDependencies.isKnownNoShowChargeEvent,
    operational: defaultDependencies.isKnownOperationalPayment, finalize: defaultDependencies.finalizeSquarePayment,
    mode: process.env.FRONTEND_WRITER_ADMISSION_MODE };
  let effects = 0;
  defaultDependencies.getEnv = () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true });
  defaultDependencies.isKnownNoShowChargeEvent = async () => false; defaultDependencies.isKnownOperationalPayment = async () => false;
  defaultDependencies.finalizeSquarePayment = async () => { effects++; return { finalized: true, duplicateEvent: false, status: "booked" }; };
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try { assert.equal((await routePost(request())).status, 503); assert.equal(effects, 0); }
  finally {
    defaultDependencies.getEnv = previous.env; defaultDependencies.isKnownNoShowChargeEvent = previous.noShow;
    defaultDependencies.isKnownOperationalPayment = previous.operational; defaultDependencies.finalizeSquarePayment = previous.finalize;
    if (previous.mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE; else process.env.FRONTEND_WRITER_ADMISSION_MODE = previous.mode;
  }
});

test("ordinary Calendar availability failure waits for every started sibling before settlement", async () => {
  const { isPaidHoldSlotStillAvailable } = await import("@/lib/booking/finalizer");
  for (const delayed of ["calendar", "holds"]) {
    const f = admission(), gate = latch();
    const pending = handler(f.run, { finalizeSquarePayment: async () => {
      await isPaidHoldSlotStillAvailable({ calendarIds: ["fails", "held"],
        listCalendarEvents: async ({ calendarId }) => {
          if (calendarId === "fails") throw new Error("owned-private-detail");
          if (delayed === "calendar") await gate.wait(); return [];
        }, hold: hold(), now: new Date("2032-01-01T12:01:00.000Z"),
        settings: { slotIntervalMinutes: 30, bufferMinutes: 0, intakeQuestions: [] } as unknown as import("@/lib/booking/types").BookingSettings,
        holdsModule: { listActiveAppointmentHolds: async () => { if (delayed === "holds") await gate.wait(); return []; } } as unknown as typeof import("@/lib/booking/holds"),
      });
      return { finalized: true, duplicateEvent: false, status: "booked" };
    } })(request());
    await gate.entered;
    try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); } finally { gate.release(); }
    assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
  }
});

test("ordinary provider email failure retains admission until its other recipient finishes", async () => {
  const { sendProviderBookingEmail } = await import("@/lib/booking/provider-booking-email");
  const originalFetch = globalThis.fetch, previous = { key: process.env.RESEND_API_KEY, admin: process.env.ADMIN_EMAIL, from: process.env.FROM_EMAIL };
  const f = admission(), gate = latch(); let sends = 0;
  process.env.RESEND_API_KEY = "re_owned_fixture"; process.env.ADMIN_EMAIL = "admin@owned.invalid"; process.env.FROM_EMAIL = "test@owned.invalid";
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)); sends++;
    if (payload.to === "fails@owned.invalid") throw new Error("owned-private-detail");
    await gate.wait(); return Response.json({ id: "owned-email" });
  };
  try {
    const pending = handler(f.run, { finalizeSquarePayment: async () => {
      await sendProviderBookingEmail({ holdId: "owned-hold", orderId: "owned-order", providerName: "Owned provider", serviceName: "Owned service",
        customerEmail: "client@owned.invalid", customerName: "Owned client", customerPhone: "5555555555", start: hold().selectedStart,
        end: hold().selectedEnd, timezone: "America/Toronto", recipientEmails: ["fails@owned.invalid", "held@owned.invalid"],
        currency: "CAD", paymentKindLabel: "Full payment", paymentProvider: "square", addOnPaymentCopy: null,
        bookedSubtotalCents: 10000, bookedTotalAfterTaxCents: 11300, bookingPaymentAmountCents: 11300,
        remainingBalanceAfterTaxCents: 0, remainingBalanceCents: 0, tipAmountCents: 0, totalPaidCents: 11300,
      }); return { finalized: true, duplicateEvent: false, status: "booked" };
    } })(request());
    await gate.entered;
    try { assert.equal(sends, 2); assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); } finally { gate.release(); }
    assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ RESEND_API_KEY: previous.key, ADMIN_EMAIL: previous.admin, FROM_EMAIL: previous.from })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
