import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run late-capture refund tests";

// Coverage for the late-capture compensation used by the Square supplemental
// finalizer: the pure lateness classifiers, plus the DB-stateful
// reserveLateCaptureRefund, which must reserve a compensating refund exactly
// once per capture so captured funds are never stranded or double-refunded.
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
  import {
    classifyLateSupplementalReason,
    isLateSupplementalCapture,
    reserveLateCaptureRefund,
  } from "./src/lib/commerce/late-capture-refund.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const prefix = "lh-late-capture-" + fixture;
  const createdOrderIds = [];
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60_000);
  const past = new Date(now.getTime() - 60_000);

  function obligation(overrides) {
    return {
      status: "pending",
      expiresAt: future,
      purpose: "manual_shipping",
      ...overrides,
    };
  }

  async function seedForReserve(suffix, obligationOverrides) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "product",
      status: "paid",
      customerName: "Late Capture Test",
      customerEmail: "late-capture@example.invalid",
      amountCents: 5000,
      merchandiseAmountCents: 5000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    createdOrderIds.push(order.id);
    const [obligationRow] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "manual_shipping",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 1500,
      taxAmountCents: 0,
      totalAmountCents: 1500,
      currency: "CAD",
      sourceWorkflow: "late_capture_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "late-capture/" + order.orderId,
      expiresAt: past,
      ...(obligationOverrides ?? {}),
    }).returning();
    const [transaction] = await db.insert(orderPaymentTransactions).values({
      obligationId: obligationRow.id,
      provider: "square",
      providerTransactionId: "sq-late-" + suffix + "-" + fixture,
      amountCents: obligationRow.totalAmountCents,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
      riskStatus: "cleared",
      riskReasonCodes: [],
      capturedAt: new Date(),
    }).returning();
    return { order, obligation: obligationRow, transaction };
  }

  try {
    // ---- isLateSupplementalCapture: lateness classification ----
    // A fresh, in-window, pending manual_shipping capture is NOT late.
    assert.equal(isLateSupplementalCapture({
      obligation: obligation(),
      orderStatus: "paid",
      manualFulfillmentStatus: "paid_pending_dispatch",
      now,
    }), false);
    // Terminal obligation states are late.
    for (const status of ["cancelled", "superseded", "refunded"]) {
      assert.equal(isLateSupplementalCapture({
        obligation: obligation({ status }),
        orderStatus: "paid",
        manualFulfillmentStatus: "paid_pending_dispatch",
        now,
      }), true, status + " obligation is late");
    }
    // An expired obligation is late.
    assert.equal(isLateSupplementalCapture({
      obligation: obligation({ expiresAt: past }),
      orderStatus: "paid",
      manualFulfillmentStatus: "paid_pending_dispatch",
      now,
    }), true);
    // A cancelled/refunded order is late.
    for (const orderStatus of ["cancelled", "refunded"]) {
      assert.equal(isLateSupplementalCapture({
        obligation: obligation(),
        orderStatus,
        manualFulfillmentStatus: "paid_pending_dispatch",
        now,
      }), true, orderStatus + " order is late");
    }
    // A manual_shipping order already dispatched/cancelled is late.
    for (const manual of ["dispatched", "cancelled"]) {
      assert.equal(isLateSupplementalCapture({
        obligation: obligation(),
        orderStatus: "paid",
        manualFulfillmentStatus: manual,
        now,
      }), true, manual + " manual fulfillment is late");
    }

    // ---- classifyLateSupplementalReason ----
    assert.equal(
      classifyLateSupplementalReason("address_increase"),
      "late_capture_after_obsolete_address_change",
    );
    assert.equal(
      classifyLateSupplementalReason("manual_shipping"),
      "late_capture_after_manual_cancellation",
    );

    // ---- reserveLateCaptureRefund: single-component (shipping) idempotency ----
    const single = await seedForReserve("single");
    await db.transaction((tx) =>
      reserveLateCaptureRefund(tx, {
        orderId: single.order.id,
        obligation: single.obligation,
        paymentTransactionId: single.transaction.id,
        providerTransactionId: single.transaction.providerTransactionId,
        amountCents: 1500,
        reason: "late_capture_after_manual_cancellation",
      }),
    );
    const singleRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, single.transaction.id));
    assert.equal(singleRefunds.length, 1);
    assert.equal(singleRefunds[0].status, "queued");
    assert.equal(singleRefunds[0].amountCents, 1500);
    assert.equal(singleRefunds[0].kind, "full");
    assert.equal(singleRefunds[0].reason, "late_capture_after_manual_cancellation");
    assert.equal(singleRefunds[0].automated, true);
    assert.ok(singleRefunds[0].adjustmentId);
    const [singleAdjustment] = await db.select().from(productOrderAdjustments)
      .where(eq(productOrderAdjustments.id, singleRefunds[0].adjustmentId));
    assert.equal(singleAdjustment.direction, "refund");
    assert.equal(singleAdjustment.component, "outbound_shipping");
    assert.equal(singleAdjustment.status, "reserved");

    // A retried finalize (webhook redelivery) reserves nothing new.
    await db.transaction((tx) =>
      reserveLateCaptureRefund(tx, {
        orderId: single.order.id,
        obligation: single.obligation,
        paymentTransactionId: single.transaction.id,
        providerTransactionId: single.transaction.providerTransactionId,
        amountCents: 1500,
        reason: "late_capture_after_manual_cancellation",
      }),
    );
    const singleRefundsAfter = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, single.transaction.id));
    assert.equal(singleRefundsAfter.length, 1, "reserve is idempotent per capture");

    // ---- reserveLateCaptureRefund: multi-component split sums to the capture ----
    const multi = await seedForReserve("multi", {
      merchandiseAmountCents: 1000,
      taxAmountCents: 200,
      shippingAmountCents: 300,
      totalAmountCents: 1500,
    });
    await db.transaction((tx) =>
      reserveLateCaptureRefund(tx, {
        orderId: multi.order.id,
        obligation: multi.obligation,
        paymentTransactionId: multi.transaction.id,
        providerTransactionId: multi.transaction.providerTransactionId,
        amountCents: 1500,
        reason: "late_capture_after_manual_cancellation",
      }),
    );
    const multiRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, multi.transaction.id));
    assert.equal(multiRefunds.length, 3);
    assert.equal(multiRefunds.reduce((total, row) => total + row.amountCents, 0), 1500);
    assert.ok(multiRefunds.every((row) => row.status === "queued"));
    // Idempotent re-reservation.
    await db.transaction((tx) =>
      reserveLateCaptureRefund(tx, {
        orderId: multi.order.id,
        obligation: multi.obligation,
        paymentTransactionId: multi.transaction.id,
        providerTransactionId: multi.transaction.providerTransactionId,
        amountCents: 1500,
        reason: "late_capture_after_manual_cancellation",
      }),
    );
    const multiRefundsAfter = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, multi.transaction.id));
    assert.equal(multiRefundsAfter.length, 3);
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
  "late-capture refund classifies lateness and reserves a compensating refund idempotently",
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
