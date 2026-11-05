import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { POST as routePost } from "@/app/api/webhooks/square/route";
import { defaultDependencies, createSquareWebhookPostHandler } from "@/app/api/webhooks/square/handler";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { observeOperationalSquarePayment, isKnownOperationalSquarePayment } from "@/lib/private-db/operational-square-payment-observer";
import { appointmentHolds } from "@/lib/private-db/schema";
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
function rawPayment(status = "COMPLETED", eventType = "payment.updated") {
  return JSON.stringify({ event_id: "owned-event", type: eventType, data: { object: { payment: {
    id: "owned-payment", reference_id: "owned-reference", order_id: "owned-order", customer_id: "owned-customer",
    status, amount_money: { amount: 10000, currency: "CAD" },
  } } } }, null, 2) + "\n";
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
function handler(run: WriterAdmissionRunner, overrides: Partial<Dependencies> = {}) {
  return createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true, commerceEnabled: false }),
    alerts: { alert() {} }, isKnownNoShowChargeEvent: async () => false,
    isKnownOperationalPayment: async () => true, observeOperationalPayment: async () => ({ status: "observed" }),
    finalizeNoShowCharge: async () => { throw new Error("unexpected-no-show"); },
    findOrderBySquareInvoiceId: async () => null,
    claimSquareInvoiceWebhookEvent: async () => { throw new Error("unexpected-commerce-invoice"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-commerce-invoice"); },
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    finalizeSquarePayment: async () => { throw new Error("unexpected-booking"); },
    ...overrides,
  }, undefined, undefined, undefined, undefined, undefined, undefined,
  task => withWriterAdmission("recovery", task, run)());
}

// Controlled database terminals exercise the actual observer and remediation.
// Separate PostgreSQL tests verify the query and persistence semantics.
function business(f: ReturnType<typeof admission>, options: {
  missing?: "hold" | "attempt"; mismatch?: "amount" | "identity" | "team";
  captured?: boolean; cancel?: "throw" | "confirmed" | "wrong"; fail?: string;
  wait?: (stage: string) => Promise<void>;
} = {}) {
  const calls: string[] = [];
  const step = async (stage: string) => {
    assert.ok(f.calls.some(call => call.sql.includes("begin_operation")));
    assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
    calls.push(stage); await options.wait?.(stage);
    if (options.fail === stage) throw new Error("owned-private-detail");
  };
  const hold = { id: "owned-hold", bookingModelVersion: 2 };
  const attempt = { id: "owned-attempt", holdId: hold.id, idempotencyKey: "owned-idempotency", status: options.captured ? "captured" : "pending",
    providerPaymentId: options.mismatch === "identity" ? "different-payment" : "owned-payment", amountCents: options.mismatch === "amount" ? 1 : 10000,
    currency: "CAD", squareTeamMemberId: options.mismatch === "team" ? "different-team" : null,
    providerMetadata: { squareRequestIntent: { referenceId: "owned-reference", squareCustomerId: "owned-customer" } },
    providerOrderId: "owned-order", authorizedAt: null, capturedAt: null, failedAt: null };
  const tx = {
    select: () => ({ from: (table: unknown) => {
      const stage = table === appointmentHolds ? "hold" : "attempt";
      const builder = { where: () => builder, orderBy: () => builder, limit: () => builder,
        for: async () => { await step(stage); return options.missing === stage ? [] : [stage === "hold" ? hold : attempt]; } };
      return builder;
    } }),
    update: () => ({ set: () => ({ where: async () => { await step("write"); } }) }),
  };
  const db = { transaction: async (task: (value: typeof tx) => Promise<unknown>) => {
    await step("transaction"); const result = await task(tx); await step("commit"); return result;
  } } as unknown as Parameters<typeof observeOperationalSquarePayment>[2];
  const dependencies: Parameters<typeof observeOperationalSquarePayment>[3] = {
    alerts: { alert: async () => { await step("alert"); } },
    cancelPayment: async id => {
      await step("cancel"); if (options.cancel === "throw") throw new Error("owned-private-detail");
      return { payment: { id, status: options.cancel === "wrong" ? "COMPLETED" : "CANCELED", amount_money: { amount: 10000, currency: "CAD" } } };
    },
    markHoldPaymentFailed: async () => { await step("failed"); },
    markHoldRefundRequired: async () => { await step("refund"); return { status: "refund_required" }; },
    markPaymentTerminated: async () => { await step("terminated"); return "cancelled"; },
    recordCompletedPayment: async () => { await step("captured"); },
  };
  return { calls, dependencies, run: ({ payment, now }: Parameters<NonNullable<Dependencies["observeOperationalPayment"]>>[0]) =>
    observeOperationalSquarePayment(payment, now, db, dependencies) };
}

test("operational created and updated payments admit before actual observer writes and captured projection", async () => {
  for (const type of ["payment.created", "payment.updated"]) {
    const f = admission(), b = business(f);
    const post = handler(f.run, { isKnownOperationalPayment: async () => { assert.equal(f.calls.length, 0); return true; }, observeOperationalPayment: b.run });
    assert.equal((await post(request(rawPayment("COMPLETED", type)))).status, 200);
    assert.deepEqual(b.calls, ["transaction", "hold", "attempt", "write", "commit", "captured"]);
    assert.equal(f.state.uncertain, false);
    assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[1], "recovery");
    assert.equal(JSON.stringify(f.calls).includes("owned-payment"), false);
  }
});

test("closed operational recovery permits read-only classification and refuses before observer effects", async () => {
  const f = admission(); f.state.recovery = false; let reads = 0, effects = 0;
  const response = await handler(f.run, { isKnownOperationalPayment: async () => { reads++; return true; },
    observeOperationalPayment: async () => { effects++; return { status: "observed" }; } })(request());
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(reads, 1); assert.equal(effects, 0);
});

test("operational reads, commits, capture projection and cancellation remediation stay admitted across closure", async () => {
  for (const stage of ["hold", "attempt", "write", "commit", "captured", "alert", "cancel", "terminated", "failed", "refund"]) {
    const f = admission(), gate = latch();
    const mismatch = ["alert", "cancel", "terminated", "failed", "refund"].includes(stage);
    const b = business(f, { mismatch: mismatch ? "team" : undefined, cancel: stage === "refund" ? "throw" : "confirmed",
      wait: name => name === stage ? gate.wait() : Promise.resolve() });
    const post = handler(f.run, { observeOperationalPayment: b.run });
    const pending = post(request(rawPayment(mismatch ? "APPROVED" : "COMPLETED")));
    await gate.entered; f.state.recovery = false;
    try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); assert.equal((await post(request())).status, 503); }
    finally { gate.release(); }
    assert.equal((await pending).status, mismatch ? 503 : 200); assert.equal(f.state.uncertain, mismatch);
  }
});

test("ordinary operational nonterminal and confirmed failed observations complete", async () => {
  for (const status of ["APPROVED", "PENDING", "FAILED", "CANCELED", "DECLINED"]) {
    const f = admission(), b = business(f);
    assert.equal((await handler(f.run, { observeOperationalPayment: b.run })(request(rawPayment(status)))).status, 200);
    assert.equal(f.state.uncertain, false); assert.equal(b.calls.includes("captured"), false);
  }
});

test("operational mismatches, missing records, unknown status and captured terminal conflict remain uncertain", async () => {
  for (const options of [{ missing: "hold" as const }, { missing: "attempt" as const }, { mismatch: "amount" as const },
    { mismatch: "identity" as const }, { mismatch: "team" as const }, { captured: true }]) {
    const f = admission(), b = business(f, options);
    assert.equal((await handler(f.run, { observeOperationalPayment: b.run })(request(rawPayment(options.captured ? "FAILED" : "COMPLETED")))).status, 503);
    assert.equal(f.state.uncertain, true); assert.equal(b.calls.includes("captured"), false);
  }
  const f = admission(), b = business(f);
  assert.equal((await handler(f.run, { observeOperationalPayment: b.run })(request(rawPayment("UNKNOWN")))).status, 503);
  assert.equal(f.state.uncertain, true);
});

test("caught operational cancellation errors and incompatible confirmations await refund evidence and remain uncertain", async () => {
  for (const cancel of ["throw", "wrong"] as const) {
    const f = admission(), b = business(f, { mismatch: "team", cancel });
    assert.equal((await handler(f.run, { observeOperationalPayment: b.run })(request(rawPayment("APPROVED")))).status, 503);
    assert.ok(b.calls.includes("cancel")); assert.ok(b.calls.includes("refund")); assert.equal(f.state.uncertain, true);
  }
});

test("operational read, commit, projection, remediation and awaited error-alert failures remain retryable", async () => {
  for (const fail of ["hold", "attempt", "write", "commit", "captured", "alert", "terminated", "failed", "refund"]) {
    const f = admission(), b = business(f, { fail, mismatch: ["alert", "terminated", "failed", "refund"].includes(fail) ? "team" : undefined,
      cancel: fail === "refund" ? "throw" : "confirmed" });
    const response = await handler(f.run, { observeOperationalPayment: b.run })(request(rawPayment(["terminated", "failed", "refund"].includes(fail) ? "APPROVED" : "COMPLETED")));
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal((await response.text()).includes("owned-private-detail"), false);
  }
  const f = admission(), gate = latch();
  const pending = handler(f.run, { observeOperationalPayment: async () => { throw new Error("owned-private-detail"); },
    alerts: { alert: async () => { await gate.wait(); } } })(request());
  await gate.entered;
  try { assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false); } finally { gate.release(); }
  assert.equal((await pending).status, 503); assert.equal(f.state.uncertain, true);
});

test("operational lost socket and settlement acknowledgements never replay business effects", async () => {
  for (const mode of ["socket", "settlement"]) {
    const f = admission(); f.state.loseSettlement = mode === "settlement"; let effects = 0;
    const response = await handler(f.run, { observeOperationalPayment: async () => {
      effects++; if (mode === "socket") f.client.emit("error", new Error("owned-private-detail")); return { status: "observed" };
    } })(request());
    assert.equal(response.status, 503); assert.equal(effects, 1);
  }
});

test("positive operational classification cannot escape into unqualified booking after a lost match", async () => {
  for (const enforce of [true, false]) {
    const f = admission(); let booking = 0;
    const response = await handler(enforce ? f.run : f.off, { observeOperationalPayment: async () => ({ status: "not_operational" }),
      finalizeSquarePayment: async () => { booking++; return { finalized: true, duplicateEvent: false, status: "booked" }; } })(request());
    assert.equal(response.status, enforce ? 503 : 200); assert.equal(booking, enforce ? 0 : 1);
  }
});

test("unmatched operational classification preserves independent ordinary booking behavior", async () => {
  const f = admission(); f.state.recovery = false; let booking = 0;
  const response = await handler(f.run, { isKnownOperationalPayment: async () => false,
    observeOperationalPayment: async () => { throw new Error("unexpected-observation"); },
    finalizeSquarePayment: async () => { booking++; return { finalized: true, duplicateEvent: false, status: "booked" }; } })(request());
  assert.equal(response.status, 200); assert.equal(booking, 1); assert.equal(f.calls.length, 0);
});

test("invalid operational requests and classification failures never admit", async () => {
  const f = admission(); let reads = 0;
  const post = handler(f.run, { isKnownOperationalPayment: async () => { reads++; throw new Error("owned-private-detail"); } });
  assert.equal((await post(request(rawPayment(), false))).status, 401); assert.equal((await post(request("x".repeat(64001)))).status, 413);
  assert.equal((await post(request("{"))).status, 400); assert.equal((await post(request())).status, 503);
  assert.equal(reads, 1); assert.equal(f.calls.length, 0);
});

test("actual operational classification uses only an unlocked SELECT and skips empty references", async () => {
  let reads = 0;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => { reads++; return [{ id: "owned-hold" }]; } }) }) }) } as unknown as Parameters<typeof isKnownOperationalSquarePayment>[1];
  const payment = { id: "owned-payment", status: "APPROVED", reference_id: "owned-reference", amount_money: { amount: 10000, currency: "CAD" } };
  assert.equal(await isKnownOperationalSquarePayment(payment, db), true); assert.equal(reads, 1);
  assert.equal(await isKnownOperationalSquarePayment({ ...payment, reference_id: " " }, db), false); assert.equal(reads, 1);
});

test("admission off preserves operational observed mismatches and unknown statuses as HTTP acknowledgements", async () => {
  const f = admission(); let effects = 0;
  assert.equal((await handler(f.off, { observeOperationalPayment: async () => {
    effects++; markWriterOperationUncertain(); return { status: "observed" };
  } })(request())).status, 200); assert.equal(effects, 1); assert.equal(f.calls.length, 0);
});

test("production route supplies operational recovery admission before observation", async () => {
  const previous = { env: defaultDependencies.getEnv, known: defaultDependencies.isKnownOperationalPayment,
    noShow: defaultDependencies.isKnownNoShowChargeEvent, observe: defaultDependencies.observeOperationalPayment,
    mode: process.env.FRONTEND_WRITER_ADMISSION_MODE };
  let effects = 0;
  defaultDependencies.getEnv = () => ({ notificationUrl: url, webhookSignatureKey: key, serviceBookingEnabled: true });
  defaultDependencies.isKnownNoShowChargeEvent = async () => false; defaultDependencies.isKnownOperationalPayment = async () => true;
  defaultDependencies.observeOperationalPayment = async () => { effects++; return { status: "observed" }; };
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try { assert.equal((await routePost(request())).status, 503); assert.equal(effects, 0); }
  finally {
    defaultDependencies.getEnv = previous.env; defaultDependencies.isKnownOperationalPayment = previous.known;
    defaultDependencies.isKnownNoShowChargeEvent = previous.noShow; defaultDependencies.observeOperationalPayment = previous.observe;
    if (previous.mode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = previous.mode;
  }
});
