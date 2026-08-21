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
  } finally {
    for (const orderId of createdOrderIds) {
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
  "Square product finalizer verifies amount/currency, writes the cleared ledger once, and fences payment-id conflicts",
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
