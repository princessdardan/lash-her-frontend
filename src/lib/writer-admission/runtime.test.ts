import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { currentWriterOperationIdentity, markWriterOperationUncertain } from "./context";
import { authorizeCaptureSquarePayment } from "@/lib/payments/square/square-payment-charge";
import { createHmac } from "node:crypto";
import { createWriterAdmissionRunner } from "./runtime";
import { withWriterAdmission } from "./route";
import { resolveWriterAdmissionConfiguration, WriterAdmissionError } from "./config";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { createSquareWebhookPostHandler } from "@/app/api/webhooks/square/handler";
import { createServicePaymentAlertLogger } from "@/lib/booking/payments/service-payment-alerts";

function environment() {
  return { FRONTEND_WRITER_ADMISSION_MODE: "enforce", VERCEL: "1", APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432, database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "a".repeat(64), password: "must-not-copy" }),
    DATABASE_URL: "postgresql://protocol_runtime:owned-application-password@db.owned.invalid/owned?sslmode=verify-full",
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: "postgresql://protocol_runtime:owned-private-marker@db.owned.invalid/owned?sslmode=verify-full" };
}
function fixture() {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const state = { ended: false, epoch: "1", newWork: true, recovery: true, authorized: true, database: "owned", uncertain: false };
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, get authorized() { return state.authorized; } } },
    async connect() {}, async end() { state.ended = true; },
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT current_user")) return { rows: [{ username: "protocol_runtime", database: state.database, major: 18 }] };
      if (sql.includes("current_policy")) return { rows: [{ epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] };
      if (sql.includes("finish_operation")) state.uncertain = values?.[1] === "uncertain";
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({ getConfiguration: () => resolveWriterAdmissionConfiguration(environment()), createClient: () => client });
  return { calls, state, client, run };
}

test("off mode preserves responses and exceptions without configuration or database work", async () => {
  let created = 0;
  const run = createWriterAdmissionRunner({ getConfiguration: () => resolveWriterAdmissionConfiguration({}), createClient: () => { created++; throw new Error(); } });
  const response = Response.json({ error: "original" }, { status: 500 });
  assert.equal(await withWriterAdmission("new-work", async () => response, run)(), response);
  const error = new Error("original-handler-error");
  await assert.rejects(withWriterAdmission("recovery", async () => { throw error; }, run)(), caught => caught === error);
  assert.equal(created, 0);
});

test("configuration binds dedicated hosted identity, source, producer, direct target and verified TLS", () => {
  const env = environment(), configuration = resolveWriterAdmissionConfiguration(env)!;
  assert.equal(configuration.connection.ssl.rejectUnauthorized, true);
  assert.equal(JSON.stringify(configuration.target).includes("must-not-copy"), false);
  for (const change of [
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_MODE = "true"; },
    (v: Record<string, string | undefined>) => { v.VERCEL_ENV = "preview"; v.VERCEL_TARGET_ENV = "preview"; },
    (v: Record<string, string | undefined>) => { v.VERCEL_PROJECT_ID = "another_project"; },
    (v: Record<string, string | undefined>) => { v.VERCEL_GIT_COMMIT_SHA = undefined; },
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_DATABASE_URL = v.FRONTEND_WRITER_ADMISSION_DATABASE_URL!.replace("verify-full", "require"); },
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_DATABASE_URL += "&options=bad"; },
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_DATABASE_URL = v.FRONTEND_WRITER_ADMISSION_DATABASE_URL!.replace("db.owned.invalid", "other.owned.invalid"); },
  ]) {
    const value: Record<string, string | undefined> = { ...env }; change(value);
    assert.throws(() => resolveWriterAdmissionConfiguration(value), error => error instanceof WriterAdmissionError && !error.message.includes("owned-private-marker"));
  }
});

test("closed new-work admission returns retryable 503 before handler or raw body is consumed", async () => {
  const f = fixture(); f.state.newWork = false; let effects = 0;
  const request = new Request("https://owned.invalid", { method: "POST", body: "untouched" });
  const response = await withWriterAdmission("new-work", async (request: Request) => { effects++; await request.text(); return Response.json({ ok: true }); }, f.run)(request);
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30"); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(request.bodyUsed, false); assert.equal(effects, 0); assert.equal(f.state.ended, true);
  assert.equal(f.calls.some(call => call.sql.startsWith("CALL")), false);
});

test("recovery reads the current epoch and commits admission before passing the original request", async () => {
  const f = fixture(); f.state.newWork = false; f.state.epoch = "7";
  const request = new Request("https://owned.invalid", { method: "POST", body: "signed-raw-body" });
  const response = await withWriterAdmission("recovery", async (actual: Request) => {
    assert.equal(actual, request); assert.equal(f.calls.at(-1)?.sql.includes("begin_operation"), true);
    assert.equal(await actual.text(), "signed-raw-body"); return Response.json({ ok: true });
  }, f.run)(request);
  assert.equal(response.status, 200); assert.equal(f.state.ended, true);
  assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[4], "7");
});

test("opaque identity is the admitted ledger UUID, scoped to the active task and cleared after completion", async () => {
  const f = fixture(); f.state.epoch = "8";
  assert.equal(currentWriterOperationIdentity(), undefined);
  await f.run("recovery", async () => {
    const identity = currentWriterOperationIdentity()!;
    assert.ok(Object.isFrozen(identity));
    assert.equal(identity.operationId, f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[0]);
    assert.deepEqual({ ...identity, operationId: "owned" }, { operationId: "owned", kind: "recovery", epoch: "8",
      producerSha256: "b".repeat(64), sourceCommit: "c".repeat(40), targetSha256: "a".repeat(64) });
    await Promise.resolve(); assert.equal(currentWriterOperationIdentity(), identity);
  });
  assert.equal(currentWriterOperationIdentity(), undefined);
  const off = createWriterAdmissionRunner({ getConfiguration: () => null });
  await off("recovery", async () => assert.equal(currentWriterOperationIdentity(), undefined));
});

test("the real Square handler validates the untouched signature and persists recovery only after admission", async () => {
  const f = fixture(); f.state.newWork = false; let persisted = 0;
  const url = "https://owned.invalid/api/webhooks/square", key = "owned-signature-fixture";
  const raw = JSON.stringify({ event_id: "owned_refund_event", type: "refund.created", data: { object: { refund: {
    id: "owned_refund", payment_id: "owned_payment", status: "PENDING", amount_money: { amount: 500, currency: "CAD" }, created_at: "2026-11-04T00:00:00Z",
  } } } }, null, 2) + "\n";
  const request = () => new Request(url, { method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": createHmac("sha256", key).update(url + raw).digest("base64") } });
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key }),
    alerts: createServicePaymentAlertLogger({ logWarn: () => {}, logError: () => {} }),
    claimSquareInvoiceWebhookEvent: async () => undefined,
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    findOrderBySquareInvoiceId: async () => null,
    finalizeNoShowCharge: async () => { throw new Error("unexpected-finalizer"); },
    finalizeSquarePayment: async () => { throw new Error("unexpected-finalizer"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-finalizer"); },
    recordSquareRefundEvent: async () => { assert.equal(f.calls.at(-1)?.sql.includes("begin_operation"), true); persisted++; return { duplicate: false }; },
  });
  const admitted = withWriterAdmission("recovery", handler, f.run);
  assert.equal((await admitted(request())).status, 200); assert.equal(persisted, 1);
  f.state.recovery = false;
  const blocked = request();
  assert.equal((await admitted(blocked)).status, 503); assert.equal(blocked.bodyUsed, false); assert.equal(persisted, 1);
});

test("lost admission or settlement acknowledgements never invoke or replay effects", async () => {
  for (const stage of ["begin_operation", "finish_operation"]) {
    const f = fixture(), query = f.client.query; let effects = 0, failures = 0;
    f.client.query = async (sql, values) => { const result = await query(sql, values); if (sql.includes(stage)) { failures++; throw new Error("owned-private-marker"); } return result; };
    const response = await withWriterAdmission("recovery", async () => { effects++; return Response.json({ ok: true }); }, f.run)();
    assert.equal(response.status, 503); assert.equal(effects, stage === "begin_operation" ? 0 : 1); assert.equal(failures, 1);
    assert.equal((await response.text()).includes("owned-private-marker"), false); assert.equal(f.state.ended, true);
  }
});

test("5xx, handler exceptions and idle connection loss cannot acknowledge a successful recovery", async () => {
  for (const mode of ["response", "exception", "socket"]) {
    const f = fixture();
    const response = await withWriterAdmission("recovery", async () => {
      if (mode === "exception") throw new Error("owned-private-marker");
      if (mode === "socket") f.client.emit("error", new Error("owned-private-marker"));
      return Response.json({ ok: true }, { status: mode === "response" ? 500 : 200 });
    }, f.run)();
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal(f.state.ended, true);
  }
});

test("TLS, actual target, policy lookup and disconnect failures remain sanitized and fail closed", async () => {
  for (const mode of ["tls", "target", "policy", "disconnect"]) {
    const f = fixture(); let effects = 0;
    if (mode === "tls") f.state.authorized = false;
    if (mode === "target") f.state.database = "other";
    if (mode === "policy") { const query = f.client.query; f.client.query = async (sql, values) => { if (sql.includes("current_policy")) throw new Error("private-marker"); return query(sql, values); }; }
    if (mode === "disconnect") f.client.end = async () => { throw new Error("private-marker"); };
    const response = await withWriterAdmission("new-work", async () => { effects++; return Response.json({ ok: true }); }, f.run)();
    assert.equal(response.status, 503); assert.equal(effects, mode === "disconnect" ? 1 : 0);
    assert.equal((await response.text()).includes("private-marker"), false);
  }
});



test("caught Square charge errors retain uncertainty even behind successful or payment-rejected responses", async () => {
  for (const stage of ["authorize", "finalize", "capture", "captured-marker", "email", "void", "void-by-key"]) {
    const f = fixture(); let captures = 0;
    const fail = () => { throw new Error("owned-private-marker"); };
    const handler = async () => {
      const result = await authorizeCaptureSquarePayment({ orderReference: "owned-order", amountCents: 500, currency: "CAD", sourceId: "owned-nonce", idempotencyKey: "owned-key" }, {
        authorizePayment: async () => {
          if (stage === "authorize" || stage === "void-by-key") fail();
          return { payment: { id: "owned-payment", status: stage === "void" ? "FAILED" : "APPROVED", amount_money: { amount: 500, currency: "CAD" } } };
        },
        finalize: async () => { if (stage === "finalize") fail(); return { transition: "applied" }; },
        capturePayment: async () => { captures++; if (stage === "capture") fail(); },
        onCaptured: async () => { if (stage === "captured-marker") fail(); },
        onSuccess: async () => { if (stage === "email") fail(); },
        voidPayment: async () => { if (stage === "void") fail(); },
        voidPaymentByIdempotencyKey: async () => { if (stage === "void-by-key") fail(); },
        logError: () => {},
      });
      return Response.json({ ok: result.ok }, { status: result.ok ? 200 : 402 });
    };
    assert.equal((await withWriterAdmission("new-work", handler, f.run)()).status, 503, stage);
    assert.equal(f.state.uncertain, true, stage);
    assert.ok(captures <= 1);
    // The same domain flow retains its prior response when admission is off.
    const off = createWriterAdmissionRunner({ getConfiguration: () => null });
    const original = await withWriterAdmission("new-work", handler, off)();
    assert.ok(original.status === 200 || original.status === 402);
  }
});

test("uncertainty is sticky across awaits and isolated between simultaneous requests", async () => {
  const failed = fixture(), clean = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = withWriterAdmission("new-work", async () => {
    markWriterOperationUncertain(); entered(); await held;
    return Response.json({ ok: true });
  }, failed.run)();
  await started;
  assert.equal((await withWriterAdmission("new-work", async () => Response.json({ ok: true }), clean.run)()).status, 200);
  release(); assert.equal((await pending).status, 503);
  assert.equal(failed.state.uncertain, true); assert.equal(clean.state.uncertain, false);
});


test("application database must share the admitted direct target, login and strict TLS before effects", async () => {
  const valid = environment();
  assert.ok(resolveWriterAdmissionConfiguration(valid));
  for (const databaseUrl of [
    undefined,
    "postgresql://protocol_runtime:application-private-marker@elsewhere.owned.invalid/owned?sslmode=verify-full",
    valid.DATABASE_URL.replace("/owned?", "/another?"),
    valid.DATABASE_URL.replace("db.owned.invalid/", "db.owned.invalid:6432/"),
    valid.DATABASE_URL.replace("protocol_runtime:", "legacy_runtime:"),
    valid.DATABASE_URL.replace("db.owned.invalid", "db-pooler.owned.invalid"),
    valid.DATABASE_URL.replace("verify-full", "disable"),
    valid.DATABASE_URL + "&host=elsewhere.owned.invalid",
    valid.DATABASE_URL + "&options=-csearch_path=other",
  ]) {
    let created = 0, effects = 0;
    const run = createWriterAdmissionRunner({
      getConfiguration: () => resolveWriterAdmissionConfiguration({ ...valid, DATABASE_URL: databaseUrl }),
      createClient: () => { created++; throw new Error(); },
    });
    const response = await withWriterAdmission("new-work", async () => { effects++; return Response.json({ ok: true }); }, run)();
    assert.equal(response.status, 503);
    assert.equal(created, 0, "configuration must refuse before any connection is created");
    assert.equal(effects, 0);
    assert.equal((await response.text()).includes("application-private-marker"), false);
  }
});
