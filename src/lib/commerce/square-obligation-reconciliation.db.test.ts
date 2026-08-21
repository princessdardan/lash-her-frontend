import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run Square obligation reconciliation tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminAuditLogs,
    adminUsers,
    checkoutOrders,
    fulfillmentOwnerActions,
    orderPaymentObligations,
  } from "./src/lib/private-db/schema.ts";
  import { reconcileSquarePaymentObligationInitialization } from "./src/lib/commerce/square-obligation-reconciliation.ts";

  void (async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const prefix = "lh-square-reconcile-" + fixture;
  let ownerId;
  const createdOrderIds = [];

  async function seed(suffix, overrides) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "product",
      status: "paid",
      customerName: "Square Reconciliation Test",
      customerEmail: "square-reconciliation@example.invalid",
      amountCents: 12345,
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2345,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    createdOrderIds.push(order.id);
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "manual_shipping",
      status: "pending",
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2345,
      taxAmountCents: 0,
      totalAmountCents: 12345,
      currency: "CAD",
      sourceWorkflow: "square_reconciliation_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "failed",
      initializationOutcome: "outcome_unknown",
      initializationLastError: "provider outcome unknown",
      idempotencyKey: "square-supplemental/" + order.orderId,
      updatedAt: new Date(Date.now() - 10 * 60_000),
      ...(overrides ?? {}),
    }).returning();
    return { order, obligation };
  }

  try {
    const ownerEmail = "square-reconcile-owner-" + fixture + "@example.invalid";
    process.env.ADMIN_OWNER_EMAILS = ownerEmail;
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "square-reconcile-owner-" + fixture,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;

    // reconcile_and_retry re-queues the obligation for an idempotent re-mint.
    const retryCase = await seed("retry");
    const retried = await reconcileSquarePaymentObligationInitialization({
      action: "reconcile_and_retry",
      actorAdminUserId: ownerId,
      evidenceReference: "square://payment-link/checked",
      expectedStateVersion: retryCase.obligation.initializationStateVersion,
      obligationId: retryCase.obligation.id,
      orderReference: retryCase.order.orderId,
      rationale: "Square shows no completed payment; safe to re-queue for an idempotent re-mint.",
      stepUpAuthenticatedAt: new Date(),
    });
    assert.equal(retried.initializationStatus, "initializing");
    assert.equal(retried.initializationOutcome, null);
    assert.equal(retried.stateVersion, retryCase.obligation.initializationStateVersion + 1);
    const [retriedRow] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, retryCase.obligation.id));
    assert.equal(retriedRow.initializationLastError, null);
    assert.equal(retriedRow.initializationLeaseOwner, null);
    assert.ok(retriedRow.initializationNextAttemptAt !== null);
    const ownerActions = await db.select().from(fulfillmentOwnerActions)
      .where(eq(fulfillmentOwnerActions.targetId, retryCase.obligation.id));
    assert.equal(ownerActions.length, 1);
    assert.equal(ownerActions[0].action, "payment_obligation_initialization_reconcile_and_retry");
    const auditRows = await db.select().from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, retryCase.obligation.id));
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, "payment_obligation.initialization.reconcile_and_retry");

    // record_manual_handoff keeps the obligation failed/manual_review.
    const handoffCase = await seed("handoff");
    const handoff = await reconcileSquarePaymentObligationInitialization({
      action: "record_manual_handoff",
      actorAdminUserId: ownerId,
      evidenceReference: "square://reconciliation/manual",
      expectedStateVersion: handoffCase.obligation.initializationStateVersion,
      obligationId: handoffCase.obligation.id,
      orderReference: handoffCase.order.orderId,
      rationale: "Owner takes this obligation out of the automated flow.",
      stepUpAuthenticatedAt: new Date(),
    });
    assert.equal(handoff.initializationStatus, "failed");
    assert.equal(handoff.initializationOutcome, "manual_review");

    // A stale expected state version fails closed (optimistic concurrency).
    const staleCase = await seed("stale");
    await assert.rejects(
      reconcileSquarePaymentObligationInitialization({
        action: "reconcile_and_retry",
        actorAdminUserId: ownerId,
        evidenceReference: "square://payment-link/checked",
        expectedStateVersion: staleCase.obligation.initializationStateVersion + 5,
        obligationId: staleCase.obligation.id,
        orderReference: staleCase.order.orderId,
        rationale: "Attempted reconciliation against a superseded state version.",
        stepUpAuthenticatedAt: new Date(),
      }),
      /changed or no longer requires reconciliation/,
    );

    // A non-Square (historical Helcim) obligation is not reconcilable here.
    const helcimCase = await seed("helcim", { paymentProvider: "helcim" });
    await assert.rejects(
      reconcileSquarePaymentObligationInitialization({
        action: "reconcile_and_retry",
        actorAdminUserId: ownerId,
        evidenceReference: "square://payment-link/checked",
        expectedStateVersion: helcimCase.obligation.initializationStateVersion,
        obligationId: helcimCase.obligation.id,
        orderReference: helcimCase.order.orderId,
        rationale: "A historical Helcim obligation must not be reconciled here.",
        stepUpAuthenticatedAt: new Date(),
      }),
      /changed or no longer requires reconciliation/,
    );

    // Stale step-up authentication fails closed.
    const stepUpCase = await seed("stepup");
    await assert.rejects(
      reconcileSquarePaymentObligationInitialization({
        action: "reconcile_and_retry",
        actorAdminUserId: ownerId,
        evidenceReference: "square://payment-link/checked",
        expectedStateVersion: stepUpCase.obligation.initializationStateVersion,
        obligationId: stepUpCase.obligation.id,
        orderReference: stepUpCase.order.orderId,
        rationale: "Attempted reconciliation with an expired step-up proof.",
        stepUpAuthenticatedAt: new Date(Date.now() - 10 * 60_000),
      }),
      /step-up authentication is required/i,
    );
  } finally {
    if (ownerId) {
      // Owner-referencing audit rows must go before the owner (FK restrict).
      await db.delete(fulfillmentOwnerActions).where(eq(fulfillmentOwnerActions.adminUserId, ownerId));
      await db.delete(adminAuditLogs).where(eq(adminAuditLogs.actorAdminUserId, ownerId));
    }
    for (const orderId of createdOrderIds) {
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
  })();
`;

test(
  "Square payment-obligation reconciliation re-queues, hands off, and fences by state version and provider",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
  },
);
