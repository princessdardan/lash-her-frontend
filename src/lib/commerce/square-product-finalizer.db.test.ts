import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run Square product finalizer tests";

// The authoritative money-ledger writer for Square product checkout. Covers the
// server-authoritative amount/currency gate, the idempotent (provider,
// providerTransactionId) ledger insert (replay -> already_applied), the
// provider:"square" cleared ledger write, and the transaction_conflict guard.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
  } from "./src/lib/private-db/schema.ts";
  import { finalizeSquareProductPayment } from "./src/lib/commerce/square-product-finalizer.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const prefix = "lh-square-product-finalizer-" + fixture;
  const createdOrderIds = [];

  // A pending manual-pickup product order + its pending primary obligation.
  // Manual pickup avoids automated shipment activation, keeping the test focused
  // on the ledger gates.
  async function seed(suffix, amountCents) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "product",
      status: "pending",
      customerName: "Square Product Finalizer Test",
      customerEmail: "square-product-finalizer@example.invalid",
      amountCents,
      merchandiseAmountCents: amountCents,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "review_required",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "payment_pending",
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    createdOrderIds.push(order.id);
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "pending",
      merchandiseAmountCents: amountCents,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      totalAmountCents: amountCents,
      currency: "CAD",
      sourceWorkflow: "square_product_finalizer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "square-product/" + order.orderId,
    }).returning();
    return { order, obligation };
  }

  try {
    // ---- amount/currency gate rejects a tampered captured amount ----
    const mismatch = await seed("mismatch", 5000);
    const amountMismatch = await finalizeSquareProductPayment({
      orderReference: mismatch.order.orderId,
      squarePaymentId: "sq-mismatch-amount-" + fixture,
      amountCents: 4999,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(amountMismatch.transition, "amount_or_currency_mismatch");
    const currencyMismatch = await finalizeSquareProductPayment({
      orderReference: mismatch.order.orderId,
      squarePaymentId: "sq-mismatch-currency-" + fixture,
      amountCents: 5000,
      currency: "USD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(currencyMismatch.transition, "amount_or_currency_mismatch");
    // A rejected finalize writes no ledger row and leaves the order pending.
    const noTxns = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, mismatch.obligation.id));
    assert.equal(noTxns.length, 0);
    const [stillPending] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, mismatch.order.id));
    assert.equal(stillPending.status, "pending");

    // ---- applied: a matching captured payment writes the cleared square ledger ----
    const applied = await seed("applied", 5000);
    const appliedPaymentId = "sq-applied-" + fixture;
    const appliedResult = await finalizeSquareProductPayment({
      orderReference: applied.order.orderId,
      squarePaymentId: appliedPaymentId,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(appliedResult.transition, "applied");
    const [appliedTxn] = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, appliedPaymentId));
    assert.ok(appliedTxn, "applied payment must write a ledger row");
    assert.equal(appliedTxn.provider, "square");
    assert.equal(appliedTxn.amountCents, 5000);
    assert.equal(appliedTxn.currency, "CAD");
    assert.equal(appliedTxn.riskStatus, "cleared");
    assert.equal(appliedTxn.obligationId, applied.obligation.id);
    const [paidObligation] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, applied.obligation.id));
    assert.equal(paidObligation.status, "paid");
    const [paidOrder] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, applied.order.id));
    assert.equal(paidOrder.status, "paid");
    assert.equal(paidOrder.providerPaymentId, appliedPaymentId);
    assert.equal(paidOrder.paymentRiskStatus, "cleared");
    assert.equal(paidOrder.manualFulfillmentStatus, "paid_pending_dispatch");

    // ---- already_applied: the same Square payment id replayed is a no-op ----
    const replay = await finalizeSquareProductPayment({
      orderReference: applied.order.orderId,
      squarePaymentId: appliedPaymentId,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(replay.transition, "already_applied");
    const replayTxns = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, appliedPaymentId));
    assert.equal(replayTxns.length, 1, "a replay must not write a second ledger row");

    // ---- transaction_conflict: a Square payment id already on another
    // obligation must never be re-attributed to the primary obligation ----
    const conflict = await seed("conflict", 5000);
    const conflictPaymentId = "sq-conflict-" + fixture;
    const [otherObligation] = await db.insert(orderPaymentObligations).values({
      orderId: conflict.order.id,
      purpose: "manual_shipping",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 1200,
      taxAmountCents: 0,
      totalAmountCents: 1200,
      currency: "CAD",
      sourceWorkflow: "square_product_finalizer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "square-product-shipping/" + conflict.order.orderId,
    }).returning({ id: orderPaymentObligations.id });
    await db.insert(orderPaymentTransactions).values({
      obligationId: otherObligation.id,
      provider: "square",
      providerTransactionId: conflictPaymentId,
      amountCents: 1200,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
      riskStatus: "cleared",
      riskReasonCodes: [],
      capturedAt: new Date(),
    });
    const conflictResult = await finalizeSquareProductPayment({
      orderReference: conflict.order.orderId,
      squarePaymentId: conflictPaymentId,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(conflictResult.transition, "transaction_conflict");
    // The primary obligation stays pending; no money was attributed to it.
    const [conflictPrimary] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, conflict.obligation.id));
    assert.equal(conflictPrimary.status, "pending");

    // ---- not_found: an unknown order reference ----
    const notFound = await finalizeSquareProductPayment({
      orderReference: prefix + "-nonexistent",
      squarePaymentId: "sq-none-" + fixture,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(notFound.transition, "not_found");

    // ---- late_capture_refunded: W3 double-failure. A captured payment lands on
    // an order the abandoned-stock sweep already cancelled (finalize had crashed
    // before recording it, and the webhook was delayed past the grace). The
    // finalizer must record the money and reserve a compensating refund, never
    // fulfill — and never charge the customer for a cancelled order. ----
    const late = await seed("late", 5000);
    await db.update(checkoutOrders).set({ status: "cancelled" })
      .where(eq(checkoutOrders.id, late.order.id));
    await db.update(orderPaymentObligations).set({ status: "cancelled" })
      .where(eq(orderPaymentObligations.id, late.obligation.id));
    const latePaymentId = "sq-late-capture-" + fixture;
    const lateResult = await finalizeSquareProductPayment({
      orderReference: late.order.orderId,
      squarePaymentId: latePaymentId,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(lateResult.transition, "late_capture_refunded");
    // The captured money is recorded on the ledger.
    const [lateTxn] = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, latePaymentId));
    assert.ok(lateTxn, "a late capture must record the captured funds");
    assert.equal(lateTxn.obligationId, late.obligation.id);
    assert.equal(lateTxn.amountCents, 5000);
    // Exactly one compensating refund is reserved for the full captured amount.
    const lateRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, lateTxn.id));
    assert.equal(lateRefunds.length, 1, "one refund reserved for the captured funds");
    assert.equal(lateRefunds[0].amountCents, 5000);
    assert.equal(lateRefunds[0].reason, "late_capture_after_terminal_primary");
    assert.equal(lateRefunds[0].status, "queued");
    assert.equal(lateRefunds[0].originalTransactionId, latePaymentId);
    // The order is NOT resurrected to paid, and its stock is never committed.
    const [stillCancelled] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, late.order.id));
    assert.equal(stillCancelled.status, "cancelled");

    // A webhook redelivery of the same late capture is idempotent: it neither
    // records a second ledger row nor reserves a second refund.
    const lateReplay = await finalizeSquareProductPayment({
      orderReference: late.order.orderId,
      squarePaymentId: latePaymentId,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(lateReplay.transition, "already_applied");
    const lateTxnsAfter = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.providerTransactionId, latePaymentId));
    assert.equal(lateTxnsAfter.length, 1, "no second ledger row on replay");
    const lateRefundsAfter = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, lateTxn.id));
    assert.equal(lateRefundsAfter.length, 1, "refund reserved exactly once");

    // ---- an UNcaptured (APPROVED) authorization for a cancelled order must NOT
    // reserve a refund: the synchronous charge core finalizes an authorization
    // BEFORE capturing, then voids it if finalize does not apply. Reserving a
    // refund here would refund money that was never taken. ----
    const authorized = await seed("authorized", 5000);
    await db.update(checkoutOrders).set({ status: "cancelled" })
      .where(eq(checkoutOrders.id, authorized.order.id));
    await db.update(orderPaymentObligations).set({ status: "cancelled" })
      .where(eq(orderPaymentObligations.id, authorized.obligation.id));
    const authorizedResult = await finalizeSquareProductPayment({
      orderReference: authorized.order.orderId,
      squarePaymentId: "sq-authorized-" + fixture,
      amountCents: 5000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "APPROVED",
    });
    assert.equal(authorizedResult.transition, "state_conflict");
    const authorizedTxns = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, authorized.obligation.id));
    assert.equal(authorizedTxns.length, 0, "an uncaptured authorization records no ledger row");
    const authorizedRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.orderId, authorized.order.id));
    assert.equal(authorizedRefunds.length, 0, "an uncaptured authorization reserves no refund");
  } finally {
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
  "Square product finalizer verifies amount/currency, writes the cleared ledger once, fences payment-id conflicts, and refunds a late capture on a swept order exactly once",
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
