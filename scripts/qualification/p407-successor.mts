import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { after, mock, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { hashCustomerSession } from "../../src/lib/customer-auth/policy.ts";
import { customerSessions, customerUsers } from "../../src/lib/customer-auth/schema.ts";
import { coursePurchaseJobs, coursePurchaseOrders, coursePurchaseRefunds } from "../../src/lib/course-purchases/schema.ts";
import { VERCEL_PROJECT_BINDINGS } from "../../src/lib/env/application-environment.mjs";
import { closePrivateDbPool, getPrivateDb } from "../../src/lib/private-db/client.ts";
import { withWriterOperationContext } from "../../src/lib/writer-admission/context.ts";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.FRONTEND_WRITER_ADMISSION_MODE, "off");
for (const [name, database] of [
  ["DATABASE_URL", "/lash_p407_capture_frontend_test"],
  ["TEST_DATABASE_URL", "/lash_p407_capture_course_test"],
]) {
  const url = new URL(process.env[name] ?? "");
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, database);
}

const origin = "https://lash-her-frontend-staging-012345678-dardan-demiris-projects.vercel.app";
const gateway = "https://api-p407.lashher.com";
const notificationUrl = origin + "/api/webhooks/square";
const checkoutUrl = origin + "/api/checkout/course";
const signatureKey = "synthetic-capture-signature-key";
const location = "LCW972G6NQNSE";
const email = "p407@capture-fixture.invalid";
const bearer = "synthetic-p407-capture-recovery-bearer";
const billing = { name: "Test Buyer", line1: "100 Test St", city: "Toronto",
  region: "ON", postalCode: "M4B 1B3", country: "CA" };
Object.assign(process.env, {
  VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", APP_ENV: "staging",
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  VERCEL_OIDC_TOKEN: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1200 })).toString("base64url")}.fixture`,
  API_GATEWAY_STAGING_ORIGIN: gateway, INTERNAL_SERVICE_JWT_SECRET: "synthetic-p407-course-capture-boundary",
  SQUARE_ENVIRONMENT: "sandbox", SQUARE_ACCESS_TOKEN: "synthetic-p407-capture-access",
  SQUARE_LOCATION_ID: location, SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey,
  COURSE_SALES_POLICY: JSON.stringify({ version: "capture-fixture", markets: [
    { country: "CA", region: "ON", disclosure: "Synthetic disclosure", behavior: "exclusive",
      classifications: { fixture: { taxCode: "ca-on-hst", rateBasisPoints: 1300 } } },
  ] }),
  RESEND_API_KEY: "re_synthetic_p407_receipt", ADMIN_EMAIL: email, FROM_EMAIL: email, STAGING_EMAIL_RECIPIENT_ALLOWLIST: email,
  COURSE_PURCHASE_RECOVERY_SECRET: bearer,
  CUSTOMER_AUTH_ENABLED: "true", CUSTOMER_AUTH_URL: origin, CUSTOMER_AUTH_SECRET: "synthetic-p407-customer-auth-secret",
  CUSTOMER_AUTH_GOOGLE_ID: "synthetic-fixture-google-client", CUSTOMER_AUTH_GOOGLE_SECRET: "synthetic-fixture-google-key",
  CUSTOMER_AUTH_RESEND_KEY: "re_synthetic_p407_auth", CUSTOMER_AUTH_EMAIL_FROM: email,
  INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true", INTEGRATION_COURSE_READS_ENABLED: "true",
  INTEGRATION_CHECKOUT_ENABLED: "true", INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED: "true",
  INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED: "false",
});
let activeSession = "";
let newWork = true;
let recoveryWork = true;
const operations: string[] = [];
mock.module("next/headers", { exports: {
  cookies: async () => ({ get: (name: string) => name === "__Host-lash-customer.session-token" && activeSession ? { value: activeSession } : undefined }),
  headers: async () => new Headers(),
} });
mock.module("@/lib/writer-admission/runtime", { exports: {
  runWriterAdmission: async <T>(kind: "new-work" | "recovery", task: () => Promise<T>, options?: { p407CourseOrderId?: string }) => {
    if (scopedOrderId) assert.equal(options?.p407CourseOrderId, scopedOrderId);
    if (kind === "new-work" && !newWork) throw new Error("Synthetic new-work gate closed");
    if (kind === "recovery" && !recoveryWork) throw new Error("Synthetic recovery gate closed");
    try {
      const result = await withWriterOperationContext(task);
      operations.push(`${kind}:completed`);
      return result;
    } catch (error) {
      operations.push(`${kind}:uncertain`);
      throw error;
    }
  },
} });
const checkout = await import("../../src/app/api/checkout/course/route.ts");
const { POST: recover } = await import("../../src/app/api/internal/course-purchases/recover/route.ts");
const { createSquareWebhookPostHandler, defaultDependencies } = await import("../../src/app/api/webhooks/square/handler.ts");
const { buildApp } = await import("../../../course/src/app.ts");
const { createDatabaseConnection } = await import("../../../course/src/db/client.ts");
const { courses, entitlementGrants } = await import("../../../course/src/db/schema.ts");
const { createDrizzleCheckoutOfferRepository } = await import("../../../course/src/checkout/checkout-offer.repository.ts");
const { createDrizzleEntitlementCommandRepository } = await import("../../../course/src/entitlements/entitlement.repository.ts");
const { createInternalServiceVerifierFromEnv } = await import("../../../course/src/entitlements/internal-auth.ts");

const db = getPrivateDb();
const proof = "1".repeat(64);
let scopedOrderId: string | undefined;
function pinFixture(order?: { orderId: string; customerId: string; courseId: string }) {
  scopedOrderId = order?.orderId;
  if (!order) {
    for (const name of ["P407_CHECKOUT_SCOPE_JSON", "P407_POSTGRES_RELAY_URL", "P407_POSTGRES_RELAY_DEPLOYMENT_PROOF", "VERCEL_GIT_COMMIT_SHA"]) delete process.env[name];
    process.env.FRONTEND_WRITER_ADMISSION_MODE = "off";
    return;
  }
  const sourceCommit = "a".repeat(40);
  Object.assign(process.env, {
    P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ orderId: order.orderId, customerId: order.customerId, courseId: order.courseId,
      sourceCommit, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    P407_POSTGRES_RELAY_URL: "wss://api-p407.lashher.com/internal/p4-07/postgres",
    P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: proof, VERCEL_GIT_COMMIT_SHA: sourceCommit,
    VERCEL_URL: new URL(origin).hostname, FRONTEND_WRITER_ADMISSION_MODE: "enforce",
  });
}
const course = createDatabaseConnection(process.env.TEST_DATABASE_URL);
const app = await buildApp({
  entitlementCommandRepository: createDrizzleEntitlementCommandRepository(course.db),
  checkoutOfferRepository: createDrizzleCheckoutOfferRepository(course.db),
  internalAuthVerifier: createInternalServiceVerifierFromEnv(),
});
const webhook = createSquareWebhookPostHandler({
  ...defaultDependencies,
  getEnv: () => ({ notificationUrl, webhookSignatureKey: signatureKey, serviceBookingEnabled: false }),
});

type SquarePayment = { created_at: string;
  id: string; status: "APPROVED" | "COMPLETED" | "FAILED"; source_type: "CARD"; reference_id: string;
  location_id: string; updated_at: string; amount_money: { amount: number; currency: string }; version_token: string;
};
const payments = new Map<string, SquarePayment>();
const createBodies: string[] = [];
const completions: string[] = [];
const captureEffects = new Set<string>();
const gatewayWrites: string[] = [];
const providerEffects = new Set<string>();
const refunds = new Map<string, Record<string, unknown>>();
const disputes = new Map<string, Record<string, unknown>>();
let disputeReads = 0;
const squareReadIds: string[] = [];
let squareReads = 0;
let loseCreate = false;
let timeOutCapture = false;
let advanceCaptureDeadline = false;
let stalePaymentRead = false;
let captureTimeouts = 0;

const originalFetch = globalThis.fetch;
const nativeDeadline = AbortSignal.timeout.bind(AbortSignal);
mock.method(AbortSignal, "timeout", (ms: number) => {
  if (!advanceCaptureDeadline) return nativeDeadline(ms);
  advanceCaptureDeadline = false;
  assert.equal(ms, 10_000);
  return nativeDeadline(8);
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.origin === "https://connect.squareupsandbox.com") {
    assert.equal(headers.get("square-version"), "2026-05-20");
    if (url.pathname.startsWith("/v2/disputes/")) {
      assert.equal(init?.method, "GET");
      const dispute = disputes.get(url.pathname.slice("/v2/disputes/".length));
      assert.ok(dispute);
      disputeReads++;
      return Response.json({ dispute });
    }
    if (url.pathname.startsWith("/v2/refunds/")) {
      assert.equal(init?.method, "GET");
      const refund = refunds.get(url.pathname.slice("/v2/refunds/".length));
      assert.ok(refund);
      return Response.json({ refund });
    }
    if (url.pathname === "/v2/payments") {
      assert.equal(init?.method, "POST");
      const raw = String(init?.body);
      createBodies.push(raw);
      const request = JSON.parse(raw);
      assert.equal(request.autocomplete, false);
      assert.equal(request.idempotency_key, "cp-" + request.reference_id.slice(3));
      const id = "payment-" + request.reference_id.slice(3);
      const prior = payments.get(id);
      const payment = prior ?? {
        id, status: "APPROVED", source_type: "CARD", reference_id: request.reference_id,
        location_id: request.location_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        amount_money: request.amount_money, version_token: "version-authorization",
      } satisfies SquarePayment;
      payments.set(id, payment);
      if (loseCreate) {
        loseCreate = false;
        throw new Error("Synthetic lost authorization reply");
      }
      if (timeOutCapture) advanceCaptureDeadline = true;
      return Response.json({ payment });
    }
    const [, , , paymentId, operation] = url.pathname.split("/");
    const payment = payments.get(decodeURIComponent(paymentId));
    assert.ok(payment);
    assert.ok(init?.signal);
    if (operation === "complete") {
      assert.equal(init?.method, "POST");
      completions.push(payment.id);
      assert.deepEqual(JSON.parse(String(init?.body)), { version_token: "version-authorization" });
      assert.equal(payment.status, "APPROVED");
      assert.equal(captureEffects.has(payment.id), false);
      captureEffects.add(payment.id);
      payment.status = "COMPLETED";
      payment.updated_at = new Date().toISOString();
      if (process.env.P407_FIXTURE_CRASH_FILE) {
        writeFileSync(process.env.P407_FIXTURE_CRASH_FILE, JSON.stringify(payment), { mode: 0o600, flag: "wx" });
        process.exit(89);
      }
      if (timeOutCapture) {
        timeOutCapture = false;
        return await new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => {
          captureTimeouts++;
          reject(init.signal.reason);
        }, { once: true }));
      }
      return Response.json({ payment });
    }
    assert.equal(operation, undefined);
    assert.equal(init?.method, "GET");
    squareReads++;
    squareReadIds.push(payment.id);
    const snapshot = { ...payment, status: stalePaymentRead ? "APPROVED" : payment.status };
    return Response.json({ payment: snapshot });
  }
  if (url.origin === gateway) {
    const isGrant = url.pathname.endsWith("/grants");
    if (scopedOrderId) assert.equal(headers.get("x-lash-p407-course-proof"), proof);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (isGrant) {
      assert.equal(headers.get("x-idempotency-key"), body.idempotencyKey);
      gatewayWrites.push(body.idempotencyKey);
    }
    const response = await app.inject({
      method: init?.method, url: url.pathname.slice("/course".length) + url.search,
      headers: Object.fromEntries(headers), ...(body ? { payload: body } : {}),
    });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  }
  assert.equal(init?.method, "POST");
  const key = headers.get("idempotency-key");
  assert.equal(url.origin, "https://api.resend.com");
  assert.equal(url.pathname, "/emails");
  assert.deepEqual([JSON.parse(String(init?.body)).to].flat(), [email]);
  assert.ok(key);
  providerEffects.add(key);
  return Response.json({ id: "fixture-receipt" });
};
after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  await course.close();
  await closePrivateDbPool();
});

const buyerRequest = (body: object) => new Request(checkoutUrl, {
  method: "POST", headers: { origin, "x-lash-csrf": "1", "content-type": "application/json" }, body: JSON.stringify(body),
});
const operatorRequest = (orderId?: string, login = bearer) =>
  new Request(`${origin}/api/internal/course-purchases/recover${orderId ? "?orderId=" + orderId : ""}`,
    { method: "POST", headers: { authorization: `Bearer ${login}` } });
async function signedNotification(type: string, id: string, object: object, eventId: string) {
  const raw = JSON.stringify({ event_id: eventId, type, data: { id, object } });
  const signature = createHmac("sha256", signatureKey).update(notificationUrl + raw).digest("base64");
  return webhook(new Request(notificationUrl, { method: "POST",
    headers: { "x-square-hmacsha256-signature": signature }, body: raw }));
}
async function sendNotification(payment: SquarePayment, eventId: string, includesReference = true) {
  const snapshot = { ...payment, ...(!includesReference ? { reference_id: undefined } : {}) };
  return signedNotification("payment.updated", payment.id, { payment: snapshot }, eventId);
}
async function fixture() {
  pinFixture();
  const courseId = randomUUID();
  const buyerId = randomUUID();
  const buyerToken = randomUUID();
  // Reuse the sole allowlisted synthetic buyer across completed test cases.
  const prior = (await db.select().from(customerUsers).where(eq(customerUsers.email, email)))[0];
  const customerId = prior?.id ?? buyerId;
  if (!prior) await db.insert(customerUsers).values({ id: buyerId, email });
  await db.insert(customerSessions).values({ userId: customerId, tokenHash: hashCustomerSession(buyerToken), expires: new Date(Date.now() + 600_000) });
  await course.db.insert(courses).values({ id: courseId, slug: `capture-${courseId}`, title: "Synthetic paid capture",
    status: "published", accessMode: "paid", taxClassification: "fixture", priceCents: 10000, currency: "CAD" });
  activeSession = buyerToken;
  newWork = true;
  recoveryWork = true;
  const quote = await checkout.POST(buyerRequest({ operation: "quote", courseId, billing }));
  assert.equal(quote.status, 201);
  const { order: { id: orderId } } = await quote.json();
  const charge = (sourceId = "synthetic-one-use-source") => checkout.POST(buyerRequest({ operation: "charge", orderId, sourceId }));
  return {
    courseId, customerId, buyerToken, orderId, charge,
    order: async () => (await db.select().from(coursePurchaseOrders).where(eq(coursePurchaseOrders.id, orderId)))[0],
    jobs: () => db.select().from(coursePurchaseJobs).where(eq(coursePurchaseJobs.orderId, orderId)),
    grants: () => course.db.select().from(entitlementGrants).where(eq(entitlementGrants.externalOrderId, orderId)),
    status: () => checkout.GET(new Request(`${checkoutUrl}?orderId=${orderId}`)),
    payment: () => payments.get("payment-" + orderId),
  };
}


if (process.env.P407_FIXTURE_CRASH_ORDER) {
  assert.ok(process.env.P407_FIXTURE_CRASH_FILE);
  activeSession = process.env.P407_FIXTURE_CRASH_SESSION ?? "";
  assert.ok(activeSession);
  await checkout.POST(buyerRequest({ operation: "charge", orderId: process.env.P407_FIXTURE_CRASH_ORDER, sourceId: "synthetic-crash-source" }));
  assert.fail("Expected simulated provider completion to terminate the worker");
}

const { createDrizzleAdminEntitlementCommandRepository } = await import("../../../course/src/entitlements/admin-entitlement-command.repository.ts");
const { drainCourseJobs } = await import("../../src/lib/course-purchases/recovery.ts");

async function settle(orderId: string) {
  return withWriterOperationContext(() => drainCourseJobs(orderId, 4));
}

function completedRefund(payment: SquarePayment, amount: number) {
  const result = {
    id: randomUUID(), payment_id: payment.id, location_id: location, status: "COMPLETED",
    amount_money: { amount, currency: "CAD" }, updated_at: new Date().toISOString(), reason: "goodwill",
  };
  refunds.set(result.id, result);
  return result;
}

test("capture acknowledgement lost: retry uses the original capture and signed recovery grants once", async () => {
  const order = await fixture();
  const before = { writes: gatewayWrites.length, creates: createBodies.length, captures: completions.length };
  timeOutCapture = true;
  assert.equal((await order.charge()).status, 503);
  assert.equal(operations.at(-1), "new-work:uncertain");
  assert.equal((await order.order()).status, "charging");
  assert.equal((await order.order()).chargedAt, null);
  assert.deepEqual(await order.jobs(), []);
  assert.equal((await order.charge()).status, 202);
  newWork = false;

  const missingCallback = await recover(operatorRequest());
  assert.equal(missingCallback.status, 200);
  assert.deepEqual(await missingCallback.json(), { completed: 0, failed: 0 });
  assert.equal((await order.order()).status, "charging");

  const event = randomUUID();
  stalePaymentRead = true;
  let firstDelivery: number;
  try {
    firstDelivery = (await sendNotification(order.payment(), event)).status;
    assert.deepEqual(await order.grants(), []);
  } finally {
    stalePaymentRead = false;
  }
  assert.equal((await sendNotification(order.payment(), event)).status, 200);
  assert.equal((await sendNotification(order.payment(), event)).status, 200);
  await settle(order.orderId);
  assert.equal((await order.order()).status, "paid");
  assert.equal((await order.order()).access, "active");
  assert.equal((await order.grants()).length, 1);
  assert.deepEqual(
    { writes: gatewayWrites.length, creates: createBodies.length, captures: completions.length },
    { writes: before.writes + 1, creates: before.creates + 1, captures: before.captures + 1 },
  );
  console.log("OBSERVED: capture acknowledgement loss preserved one capture and one grant after a later signed delivery.");
  assert.equal(firstDelivery, 503, "A signed completion should remain retryable while the payment read is stale");
});

test("a terminated checkout worker leaves the confirmed synthetic capture recoverable by signed delivery", async () => {
  const order = await fixture();
  const directory = mkdtempSync(join(tmpdir(), "p407-provider-fixture-"));
  const paymentFile = join(directory, "capture.json");
  try {
    const child = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--import", "./scripts/register-server-only-test.mjs",
      "--import", "tsx", fileURLToPath(import.meta.url),
    ], {
      env: { ...process.env, P407_FIXTURE_CRASH_ORDER: order.orderId,
             P407_FIXTURE_CRASH_SESSION: order.buyerToken, P407_FIXTURE_CRASH_FILE: paymentFile },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(child.status, 89, "Worker must terminate at fixture capture before the local commit");
    const payment = JSON.parse(readFileSync(paymentFile, "utf8")) as SquarePayment;
    assert.equal(payment.status, "COMPLETED");
    assert.equal((await order.order()).squarePaymentId, payment.id);
    assert.equal((await order.order()).status, "charging");
    assert.deepEqual(await order.jobs(), []);
    assert.equal((await order.charge()).status, 202);
    assert.equal(createBodies.some((body) => body.includes(order.orderId)), false);
    payments.set(payment.id, payment);
    newWork = false;
    const event = randomUUID();
    assert.equal((await sendNotification(payment, event)).status, 200);
    assert.equal((await sendNotification(payment, event)).status, 200);
    await settle(order.orderId);
    assert.equal((await order.order()).access, "active");
    assert.equal((await order.grants()).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial goodwill, conflicting refund replay and isolated revocation", async () => {
  const order = await fixture();
  assert.equal((await order.charge()).status, 200);
  await settle(order.orderId);
  const unrelated = await fixture();
  assert.equal((await unrelated.charge()).status, 200);
  await settle(unrelated.orderId);
  const manual = await createDrizzleAdminEntitlementCommandRepository(course.db).grant({
    userId: order.customerId, courseId: order.courseId, actorUserId: randomUUID(),
    idempotencyKey: randomUUID(), reason: "Synthetic independent support grant",
  });
  const manualId = manual.effects[0]?.entitlementGrantId;
  assert.ok(manualId);
  const payment = order.payment();
  const goodwill = completedRefund(payment, 300);
  const event = randomUUID();
  assert.equal((await signedNotification("refund.updated", goodwill.id, { refund: goodwill }, event)).status, 200);
  await settle(order.orderId);
  assert.equal((await order.order()).refundedCents, 300);
  assert.equal((await order.order()).access, "active");
  assert.equal((await order.grants())[0].status, "active");
  const exactBefore = await order.jobs();
  assert.equal((await signedNotification("refund.updated", goodwill.id, { refund: goodwill }, event)).status, 200);
  assert.deepEqual(await order.jobs(), exactBefore);

  const conflict = { ...goodwill, amount_money: { amount: 400, currency: "CAD" } };
  refunds.set(goodwill.id, conflict);
  assert.equal((await signedNotification("refund.updated", goodwill.id, { refund: conflict }, randomUUID())).status, 503);
  assert.equal((await order.order()).refundedCents, 300);
  assert.deepEqual(await order.jobs(), exactBefore);
  refunds.set(goodwill.id, goodwill);

  const balance = completedRefund(payment, 11000);
  assert.equal((await signedNotification("refund.updated", balance.id, { refund: balance }, randomUUID())).status, 200);
  await settle(order.orderId);
  assert.equal((await order.order()).access, "revoked");
  assert.equal((await order.grants())[0].status, "revoked");
  assert.equal((await unrelated.order()).status, "paid");
  assert.equal((await unrelated.grants())[0].status, "active");
  const [manualGrant] = await course.db.select().from(entitlementGrants).where(eq(entitlementGrants.id, manualId));
  assert.equal(manualGrant.status, "active");
  assert.deepEqual((await db.select().from(coursePurchaseRefunds).where(eq(coursePurchaseRefunds.orderId, order.orderId)))
    .map(({ amountCents }) => amountCents).sort((a, b) => a - b), [300, 11000]);
});

test("a rate-table tax-sale commit failure leaves payment and access intact and retries once", async () => {
  const order = await fixture();
  await db.execute(sql.raw(`
    CREATE FUNCTION p407_fixture_tax_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic rate-table sale write failure';
    END; $$;
    CREATE TRIGGER p407_fixture_tax_write_failure
      BEFORE UPDATE OF tax_transaction_id ON course_purchase_orders FOR EACH ROW
      EXECUTE FUNCTION p407_fixture_tax_write_failure();
  `));
  try {
    assert.equal((await order.charge()).status, 200);
    assert.equal((await settle(order.orderId)).failed, 1);
    const sale = (await order.jobs()).find(({ kind }) => kind === "tax_sale");
    assert.ok(sale);
    assert.equal(sale.status, "pending");
    assert.equal(sale.attempts, 1);
    assert.equal(sale.lastFailure, "dependency_502");
    assert.equal((await order.order()).status, "paid");
    assert.equal((await order.order()).access, "active");
    assert.equal((await order.grants()).length, 1);
    assert.equal((await order.order()).taxTransactionId, null);
    assert.deepEqual(await settle(order.orderId), { completed: 0, failed: 0 });
    await db.update(coursePurchaseJobs).set({ availableAt: new Date(0) }).where(eq(coursePurchaseJobs.id, sale.id));
  } finally {
    await db.execute(sql.raw(`
      DROP TRIGGER p407_fixture_tax_write_failure ON course_purchase_orders;
      DROP FUNCTION p407_fixture_tax_write_failure();
    `));
  }
  assert.deepEqual(await settle(order.orderId), { completed: 1, failed: 0 });
  assert.deepEqual(await settle(order.orderId), { completed: 0, failed: 0 });
  const sale = (await order.jobs()).find(({ kind }) => kind === "tax_sale");
  assert.equal(sale?.status, "done");
  assert.equal(sale?.attempts, 2);
  assert.equal((await order.order()).taxTransactionId, `rate-table:${order.orderId}`);
  assert.equal((await order.grants()).length, 1);
});

test("scoped recovery verifies only the pinned bound capture without a callback or a new charge", async () => {
  const order = await fixture();
  const other = await fixture();
  timeOutCapture = true;
  assert.equal((await other.charge()).status, 503);
  activeSession = order.buyerToken;
  timeOutCapture = true;
  assert.equal((await order.charge()).status, 503);
  assert.equal((await order.order()).status, "charging");
  pinFixture(order);
  newWork = false;
  recoveryWork = false;
  const before = { writes: createBodies.length + completions.length, reads: squareReads };
  assert.equal((await recover(operatorRequest(order.orderId, "wrong-token"))).status, 401);
  assert.equal((await recover(operatorRequest())).status, 400);
  assert.equal((await recover(operatorRequest(other.orderId))).status, 400);
  assert.equal((await recover(operatorRequest(order.orderId))).status, 503);
  assert.equal(squareReads, before.reads);
  recoveryWork = true;
  assert.equal((await recover(operatorRequest(order.orderId + "&paymentId=" + other.payment().id))).status, 409);
  assert.equal(squareReads, before.reads);
  stalePaymentRead = true;
  const pending = await recover(operatorRequest(order.orderId));
  assert.equal(pending.status, 503);
  assert.equal(pending.headers.get("retry-after"), "60");
  assert.deepEqual(await order.jobs(), []);
  stalePaymentRead = false;
  const recovered = await recover(operatorRequest(order.orderId));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { completed: 3, failed: 0 });
  assert.deepEqual(await (await recover(operatorRequest(order.orderId))).json(), { completed: 0, failed: 0 });
  assert.equal(squareReads, before.reads + 2);
  assert.deepEqual(squareReadIds.slice(-2), [order.payment().id, order.payment().id]);
  assert.equal(createBodies.length + completions.length, before.writes);
  assert.equal((await order.order()).access, "active");
  assert.equal((await order.grants()).length, 1);
  assert.deepEqual(await other.jobs(), []);
  assert.equal((await other.order()).status, "charging");
  assert.equal([...providerEffects].some((id) => id.includes(order.orderId)), false);
});

test("unbound recovery requires an explicit payment with the exact reserved reference", async () => {
  const order = await fixture();
  const peer = await fixture();
  loseCreate = true;
  assert.equal((await peer.charge()).status, 503);
  activeSession = order.buyerToken;
  loseCreate = true;
  assert.equal((await order.charge()).status, 503);
  assert.equal((await order.order()).squarePaymentId, null);
  const payment = order.payment();
  payment.status = "COMPLETED";
  payment.updated_at = new Date().toISOString();
  pinFixture(order);
  newWork = false;
  const before = squareReads;
  assert.deepEqual(await (await recover(operatorRequest(order.orderId))).json(), { completed: 0, failed: 0 });
  assert.equal(squareReads, before);
  assert.equal((await recover(operatorRequest(order.orderId + "&paymentId=" + peer.payment().id))).status, 503);
  assert.equal((await order.order()).squarePaymentId, null);
  assert.deepEqual(await order.jobs(), []);
  assert.deepEqual(await (await recover(operatorRequest(order.orderId + "&paymentId=" + payment.id))).json(), { completed: 3, failed: 0 });
  assert.equal((await order.order()).squarePaymentId, payment.id);
  assert.equal((await order.grants()).length, 1);
  assert.deepEqual(await peer.jobs(), []);
});

test("signed and verified scoped dispute revokes, resolves once, and never overrides refund or other grants", async () => {
  const order = await fixture();
  assert.equal((await order.charge()).status, 200);
  await settle(order.orderId);
  const other = await fixture();
  assert.equal((await other.charge()).status, 200);
  await settle(other.orderId);
  const support = await createDrizzleAdminEntitlementCommandRepository(course.db).grant({
    userId: order.customerId, courseId: order.courseId, actorUserId: randomUUID(),
    idempotencyKey: randomUUID(), reason: "Synthetic independent support grant",
  });
  const payment = order.payment();
  pinFixture(order);
  newWork = false;
  const disputed = {
    id: randomUUID(), state: "EVIDENCE_REQUIRED", version: 1, updated_at: new Date().toISOString(),
    location_id: location, disputed_payment: { payment_id: payment.id }, amount_money: payment.amount_money,
  };
  const foreign = { ...disputed, disputed_payment: { payment_id: other.payment().id } };
  const deliver = (dispute: typeof disputed, type = "dispute.state.updated") =>
    signedNotification(type, dispute.id, { dispute }, randomUUID());
  const reads = squareReads;
  const disputeReadsBefore = disputeReads;
  assert.equal((await deliver(foreign)).status, 200);
  assert.equal(squareReads, reads);
  assert.equal(disputeReads, disputeReadsBefore);
  disputes.set(disputed.id, disputed);
  assert.equal((await deliver(disputed, "dispute.created")).status, 200);
  await settle(order.orderId);
  assert.equal((await order.order()).disputeBlocked, true);
  assert.equal((await order.grants())[0].status, "revoked");
  const conflict = { ...disputed, state: "LOST" };
  assert.equal((await deliver(conflict)).status, 503);
  const won = { ...disputed, state: "WON", version: 2, updated_at: new Date().toISOString() };
  disputes.set(won.id, won);
  assert.equal((await deliver(won)).status, 200);
  await settle(order.orderId);
  assert.equal((await deliver(won)).status, 200);
  assert.equal((await deliver(disputed)).status, 200);
  assert.equal((await order.order()).disputeBlocked, false);
  assert.equal((await order.grants()).filter((row) => row.status === "active").length, 1);
  assert.equal((await order.grants()).length, 2);
  const refund = completedRefund(payment, 11300);
  assert.equal((await signedNotification("refund.updated", refund.id, { refund }, randomUUID())).status, 200);
  await settle(order.orderId);
  assert.equal((await deliver(won)).status, 200);
  assert.equal((await order.order()).access, "revoked");
  assert.equal((await order.grants()).filter((row) => row.status === "active").length, 0);
  assert.equal((await other.grants())[0].status, "active");
  const [manual] = await course.db.select().from(entitlementGrants)
    .where(eq(entitlementGrants.id, support.effects[0].entitlementGrantId));
  assert.equal(manual.status, "active");
});
