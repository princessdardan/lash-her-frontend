import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run Square supplemental finalizer tests";

// Money-path coverage for finalizeSquareSupplementalObligation: the
// verified-payment gate for post-order shipping top-ups / address-increase
// obligations. Focus is the just-fixed quarantine-race and amount/currency
// mismatch alerts (funds must never be silently stranded), plus the ledger
// idempotency and late-capture compensation the gate guarantees.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    customerEmailOutbox,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
  } from "./src/lib/private-db/schema.ts";
  import { finalizeSquareSupplementalObligation } from "./src/lib/commerce/square-supplemental-finalizer.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  const fixture = crypto.randomUUID();
  process.env.ADMIN_OWNER_EMAILS = "supplemental-finalizer-" + fixture + "@example.invalid";

  const db = getPrivateDb();
  const prefix = "lh-supplemental-finalizer-" + fixture;
  const createdOrderIds = [];
  const quarantineAlertPrefix = "supplemental-stranded-quarantine/";
  const mismatchAlertPrefix = "supplemental-stranded-mismatch/";

  // Seed a paid manual-pickup product order plus a pending manual_shipping
  // top-up obligation (defaults chosen so the offer is "still open").
  async function seed(suffix, obligationOverrides) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "product",
      status: "paid",
      customerName: "Supplemental Finalizer Test",
      customerEmail: "supplemental-finalizer@example.invalid",
      amountCents: 5000,
      merchandiseAmountCents: 5000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      providerPaymentId: "sq-primary-" + suffix + "-" + fixture,
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    createdOrderIds.push(order.id);
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "manual_shipping",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 1500,
      taxAmountCents: 0,
      totalAmountCents: 1500,
      currency: "CAD",
      sourceWorkflow: "supplemental_finalizer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "supplemental-finalizer/" + order.orderId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      ...(obligationOverrides ?? {}),
    }).returning();
    return { order, obligation };
  }

  async function alertCount(prefixKey, squarePaymentId) {
    const rows = await db.select({ id: customerEmailOutbox.id })
      .from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, prefixKey + squarePaymentId + "/%"));
    return rows.length;
  }

  try {
    // ---- Quarantine race: verified payment on a quarantined obligation ----
    const quarantined = await seed("quarantine", {
      quarantinedAt: new Date(),
      quarantineReason: "under fraud investigation",
    });
    const quarantinePaymentId = "sq-quarantine-" + fixture;
    const quarantineResult = await finalizeSquareSupplementalObligation({
      obligationId: quarantined.obligation.id,
      squarePaymentId: quarantinePaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(quarantineResult.transition, "not_found");
    assert.equal(await alertCount(quarantineAlertPrefix, quarantinePaymentId), 1);
    // No ledger row was written for a quarantined obligation.
    const quarantineTxns = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, quarantinePaymentId));
    assert.equal(quarantineTxns.length, 0);
    // A webhook retry re-returns not_found and does NOT double-alert.
    const quarantineRetry = await finalizeSquareSupplementalObligation({
      obligationId: quarantined.obligation.id,
      squarePaymentId: quarantinePaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(quarantineRetry.transition, "not_found");
    assert.equal(await alertCount(quarantineAlertPrefix, quarantinePaymentId), 1);

    // ---- Amount/currency mismatch against the reserved top-up ----
    const mismatch = await seed("mismatch");
    const mismatchPaymentId = "sq-mismatch-" + fixture;
    const mismatchResult = await finalizeSquareSupplementalObligation({
      obligationId: mismatch.obligation.id,
      squarePaymentId: mismatchPaymentId,
      amountCents: 1600, // reserved top-up is 1500
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(mismatchResult.transition, "amount_or_currency_mismatch");
    assert.equal(await alertCount(mismatchAlertPrefix, mismatchPaymentId), 1);
    // Currency mismatch is caught the same way.
    const currencyMismatch = await finalizeSquareSupplementalObligation({
      obligationId: mismatch.obligation.id,
      squarePaymentId: "sq-currency-" + fixture,
      amountCents: 1500,
      currency: "USD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(currencyMismatch.transition, "amount_or_currency_mismatch");
    // Retry of the amount mismatch does not double-alert.
    await finalizeSquareSupplementalObligation({
      obligationId: mismatch.obligation.id,
      squarePaymentId: mismatchPaymentId,
      amountCents: 1600,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(await alertCount(mismatchAlertPrefix, mismatchPaymentId), 1);

    // ---- Applied: fresh in-window payment records the ledger and pays it ----
    const applied = await seed("applied");
    const appliedPaymentId = "sq-applied-" + fixture;
    const appliedResult = await finalizeSquareSupplementalObligation({
      obligationId: applied.obligation.id,
      squarePaymentId: appliedPaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(appliedResult.transition, "applied");
    const [appliedTxn] = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, appliedPaymentId));
    assert.ok(appliedTxn, "applied payment must write a ledger row");
    assert.equal(appliedTxn.provider, "square");
    assert.equal(appliedTxn.amountCents, 1500);
    assert.equal(appliedTxn.obligationId, applied.obligation.id);
    const [paidObligation] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, applied.obligation.id));
    assert.equal(paidObligation.status, "paid");

    // ---- already_applied: the same Square payment replayed is a no-op ----
    const replayResult = await finalizeSquareSupplementalObligation({
      obligationId: applied.obligation.id,
      squarePaymentId: appliedPaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(replayResult.transition, "already_applied");
    const replayTxns = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, appliedPaymentId));
    assert.equal(replayTxns.length, 1, "a replay must not write a second ledger row");

    // ---- W1 regression: apply FIRST, then quarantine, then a webhook replay
    // must return already_applied and must NOT emit a "capture was not applied"
    // stranded alert. The money is already on the ledger, so that misleading
    // critical alert could induce an operator double-refund. ----
    const applyThenQuarantine = await seed("apply-quarantine");
    const aqPaymentId = "sq-apply-quarantine-" + fixture;
    const aqApplied = await finalizeSquareSupplementalObligation({
      obligationId: applyThenQuarantine.obligation.id,
      squarePaymentId: aqPaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(aqApplied.transition, "applied");
    // Obligation is quarantined AFTER the payment was applied.
    await db.update(orderPaymentObligations)
      .set({ quarantinedAt: new Date(), quarantineReason: "post-apply review" })
      .where(eq(orderPaymentObligations.id, applyThenQuarantine.obligation.id));
    const aqReplay = await finalizeSquareSupplementalObligation({
      obligationId: applyThenQuarantine.obligation.id,
      squarePaymentId: aqPaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(aqReplay.transition, "already_applied");
    // Crucially: NO stranded-quarantine alert for an already-applied payment.
    assert.equal(await alertCount(quarantineAlertPrefix, aqPaymentId), 0);
    const aqTxns = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, aqPaymentId));
    assert.equal(aqTxns.length, 1, "quarantine replay must not write a second ledger row");

    // ---- transaction_conflict: a payment id already on another obligation ----
    const conflict = await seed("conflict");
    const conflictPaymentId = "sq-conflict-" + fixture;
    // Attach the Square payment id to a DIFFERENT (primary) obligation first.
    const [otherObligation] = await db.insert(orderPaymentObligations).values({
      orderId: conflict.order.id,
      purpose: "primary",
      status: "paid",
      merchandiseAmountCents: 5000,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      totalAmountCents: 5000,
      currency: "CAD",
      sourceWorkflow: "supplemental_finalizer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "supplemental-finalizer-primary/" + conflict.order.orderId,
      paidAt: new Date(),
    }).returning({ id: orderPaymentObligations.id });
    await db.insert(orderPaymentTransactions).values({
      obligationId: otherObligation.id,
      provider: "square",
      providerTransactionId: conflictPaymentId,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
      riskStatus: "cleared",
      riskReasonCodes: [],
      capturedAt: new Date(),
    });
    const conflictResult = await finalizeSquareSupplementalObligation({
      obligationId: conflict.obligation.id,
      squarePaymentId: conflictPaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(conflictResult.transition, "transaction_conflict");

    // ---- late_capture_refunded: a payment for an expired offer reserves a
    // compensating refund instead of fulfilling or stranding it ----
    const late = await seed("late", {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const latePaymentId = "sq-late-" + fixture;
    const lateResult = await finalizeSquareSupplementalObligation({
      obligationId: late.obligation.id,
      squarePaymentId: latePaymentId,
      amountCents: 1500,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(lateResult.transition, "late_capture_refunded");
    const [lateTxn] = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, latePaymentId));
    assert.ok(lateTxn, "a late capture still records the captured money");
    const lateRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, lateTxn.id));
    assert.equal(lateRefunds.length, 1);
    assert.equal(lateRefunds[0].status, "queued");
    assert.equal(lateRefunds[0].amountCents, 1500);
    assert.equal(lateRefunds[0].reason, "late_capture_after_manual_cancellation");
  } finally {
    await db.delete(customerEmailOutbox).where(
      like(customerEmailOutbox.providerIdempotencyKey, quarantineAlertPrefix + "sq-quarantine-" + fixture + "/%"),
    );
    await db.delete(customerEmailOutbox).where(
      like(customerEmailOutbox.providerIdempotencyKey, mismatchAlertPrefix + "sq-mismatch-" + fixture + "/%"),
    );
    for (const orderId of createdOrderIds) {
      await db.delete(productOrderRefunds).where(eq(productOrderRefunds.orderId, orderId));
      await db.delete(productOrderAdjustments).where(eq(productOrderAdjustments.orderId, orderId));
      await db.execute(sql.raw(
        "DELETE FROM order_payment_transactions WHERE obligation_id IN (SELECT id FROM order_payment_obligations WHERE order_id = '" + orderId + "')",
      ));
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "Square supplemental finalizer alerts on quarantine/mismatch, applies once, and refunds late captures",
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
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXT_PUBLIC_SANITY_PROJECT_ID:
            process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? "3auncj84",
          NEXT_PUBLIC_SANITY_DATASET:
            process.env.NEXT_PUBLIC_SANITY_DATASET ?? "staging-2026-05-10",
          NEXT_PUBLIC_SANITY_API_VERSION:
            process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? "2026-03-24",
        },
        stdio: "inherit",
      },
    );
  },
);
