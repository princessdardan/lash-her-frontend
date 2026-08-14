import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestUrl = process.env.TEST_DATABASE_URL;
const dbTestSkipReason = dbTestUrl
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed payment finalizer tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    orderPaymentObligations,
    orderPaymentTransactions,
  } from "./src/lib/private-db/schema.ts";
  import { finalizeProductPayment } from "./src/lib/commerce/product-payment-finalizer.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const prefix = "lh-remediation-finalizer-";

  async function cleanup() {
    await db.execute(sql.raw(
      "DELETE FROM product_order_risk_reviews WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM fulfillment_owner_actions WHERE target_id IN " +
      "(SELECT id::text FROM product_payment_risk_incidents WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%'))",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_payment_risk_incidents WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM order_payment_transactions WHERE obligation_id IN " +
      "(SELECT id FROM order_payment_obligations WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%'))",
    ));
    await db.execute(sql.raw(
      "DELETE FROM order_payment_obligations WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%')",
    ));
    await db.delete(checkoutOrders).where(like(checkoutOrders.orderId, prefix + "%"));
  }

  async function seed(orderId) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId,
      purpose: "product",
      status: "pending",
      customerName: "Payment Test",
      customerEmail: "payment-test@example.invalid",
      amountCents: 12345,
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2345,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "pending",
      fulfillmentMode: "automated_shipping",
    }).returning({ id: checkoutOrders.id });
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "pending",
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2345,
      taxAmountCents: 0,
      totalAmountCents: 12345,
      currency: "CAD",
      sourceWorkflow: "payment_finalizer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      idempotencyKey: "primary/" + orderId,
    }).returning({ id: orderPaymentObligations.id });
    return { order, obligation };
  }

  const purchase = {
    transactionId: "txn-remediation-finalizer-1",
    source: "helcim_api",
    data: {
      amount: "123.45",
      currency: "CAD",
      status: "APPROVED",
      transactionType: "purchase",
      transactionId: "txn-remediation-finalizer-1",
      avsResponse: "Y",
      cvvResponse: "M",
    },
  };

  try {
    await cleanup();
    const firstOrderId = prefix + "one";
    const first = await seed(firstOrderId);
    const applied = await finalizeProductPayment({
      ...purchase,
      orderReference: firstOrderId,
    });
    assert.deepEqual(applied, { transition: "applied", riskStatus: "cleared" });

    const duplicate = await finalizeProductPayment({
      ...purchase,
      orderReference: firstOrderId,
    });
    assert.deepEqual(duplicate, {
      transition: "already_applied",
      riskStatus: "cleared",
    });

    const [firstOrder] = await db.select({
      status: checkoutOrders.status,
      transactionId: checkoutOrders.helcimTransactionId,
      risk: checkoutOrders.paymentRiskStatus,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, first.order.id));
    assert.deepEqual(firstOrder, {
      status: "paid",
      transactionId: purchase.transactionId,
      risk: "cleared",
    });
    const firstTransactions = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, first.obligation.id));
    assert.equal(firstTransactions.length, 1);

    const secondOrderId = prefix + "two";
    const second = await seed(secondOrderId);
    const replay = await finalizeProductPayment({
      ...purchase,
      orderReference: secondOrderId,
    });
    assert.equal(replay.transition, "transaction_conflict");
    const [secondOrder] = await db.select({
      status: checkoutOrders.status,
      transactionId: checkoutOrders.helcimTransactionId,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, second.order.id));
    assert.deepEqual(secondOrder, { status: "pending", transactionId: null });

    const thirdOrderId = prefix + "three";
    const third = await seed(thirdOrderId);
    const refund = await finalizeProductPayment({
      orderReference: thirdOrderId,
      transactionId: "refund-remediation-finalizer-1",
      source: "helcim_api",
      data: {
        amount: "123.45",
        currency: "CAD",
        status: "APPROVED",
        transactionType: "refund",
        originalTransactionId: purchase.transactionId,
        transactionId: "refund-remediation-finalizer-1",
      },
    });
    assert.equal(refund.transition, "state_conflict");
    const [thirdOrder] = await db.select({ status: checkoutOrders.status })
      .from(checkoutOrders).where(eq(checkoutOrders.id, third.order.id));
    assert.equal(thirdOrder.status, "pending");
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "product finalization is atomic, idempotent, and transaction-identity safe",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "--eval", scenario],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);
