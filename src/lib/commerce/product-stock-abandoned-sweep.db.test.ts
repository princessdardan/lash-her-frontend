import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run abandoned-stock sweep tests";

// The abandoned-order stock sweep releases held stock and cancels a product
// order once its reservation lease + grace has lapsed with no captured payment.
// This covers the W3 mitigation: before cancelling, the sweep re-verifies the
// order against Square, and a captured/authorized payment (or an unverifiable
// order it must not silently drop) skips the cancellation so a genuinely-paid
// order is never swept. The verifier is scoped to the fixture's own orders so a
// shared test database's other pending rows are never touched.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, inArray, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    orderPaymentObligations,
    productStock,
    productStockMovements,
  } from "./src/lib/private-db/schema.ts";
  import { releaseAbandonedProductStockReservations } from "./src/lib/commerce/product-stock-abandoned-sweep.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const prefix = "lh-abandoned-sweep-" + fixture;
  const now = new Date();
  // Well past the reservation lease + the sweep's default 60-min grace.
  const expired = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const createdOrderIds = [];
  const createdStockIds = [];

  // A pending product order past its lease with a held stock reservation and NO
  // captured payment — exactly what the sweep would otherwise cancel.
  async function seedAbandoned(suffix) {
    const productId = prefix + "-product-" + suffix;
    const [stock] = await db.insert(productStock).values({
      productId,
      variantKey: null,
      onHand: 10,
      reserved: 2,
    }).returning({ id: productStock.id });
    createdStockIds.push(stock.id);
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "product",
      status: "pending",
      customerName: "Abandoned Sweep Test",
      customerEmail: "abandoned-sweep@example.invalid",
      amountCents: 5000,
      merchandiseAmountCents: 5000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "review_required",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "payment_pending",
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    createdOrderIds.push(order.id);
    await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "pending",
      merchandiseAmountCents: 5000,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      totalAmountCents: 5000,
      currency: "CAD",
      sourceWorkflow: "abandoned_sweep_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "abandoned-sweep/" + order.orderId,
      expiresAt: expired,
    });
    await db.insert(productStockMovements).values({
      productStockId: stock.id,
      orderId: order.orderId,
      kind: "reserve",
      quantity: 2,
    });
    return { order, stockId: stock.id };
  }

  async function orderStatus(id) {
    const [row] = await db.select({ status: checkoutOrders.status })
      .from(checkoutOrders).where(eq(checkoutOrders.id, id));
    return row.status;
  }
  async function reservedFor(stockId) {
    const [row] = await db.select({ reserved: productStock.reserved })
      .from(productStock).where(eq(productStock.id, stockId));
    return row.reserved;
  }
  async function releaseMovements(orderRef, stockId) {
    return db.select({ id: productStockMovements.id }).from(productStockMovements)
      .where(and(
        eq(productStockMovements.orderId, orderRef),
        eq(productStockMovements.productStockId, stockId),
        eq(productStockMovements.kind, "release"),
      ));
  }

  try {
    const captured = await seedAbandoned("captured");
    const authorized = await seedAbandoned("authorized");
    const absent = await seedAbandoned("absent");
    const erroring = await seedAbandoned("erroring");

    const fixtureVerdicts = new Map([
      [captured.order.orderId, "captured"],
      [authorized.order.orderId, "authorized"],
      [absent.order.orderId, "absent"],
    ]);

    const result = await releaseAbandonedProductStockReservations({
      now,
      verifyProviderPayment: async ({ orderReference }) => {
        if (orderReference === erroring.order.orderId) {
          throw new Error("provider unreachable");
        }
        // Any non-fixture order the shared DB might surface is reported captured
        // so this test never cancels data it does not own.
        return fixtureVerdicts.get(orderReference) ?? "captured";
      },
    });

    // A captured payment -> the order is left intact; its stock stays reserved.
    assert.equal(await orderStatus(captured.order.id), "pending",
      "a captured order must not be cancelled");
    assert.equal(await reservedFor(captured.stockId), 2,
      "a captured order's stock must not be released");
    assert.equal((await releaseMovements(captured.order.orderId, captured.stockId)).length, 0);

    // An authorized (uncaptured, still-live) payment is likewise skipped.
    assert.equal(await orderStatus(authorized.order.id), "pending",
      "an authorized order must not be cancelled");
    assert.equal(await reservedFor(authorized.stockId), 2);

    // No provider payment -> the abandoned order is cancelled and stock released.
    assert.equal(await orderStatus(absent.order.id), "cancelled",
      "an order with no provider payment is cancelled");
    assert.equal(await reservedFor(absent.stockId), 0,
      "the released order returns its held stock to available");
    assert.equal((await releaseMovements(absent.order.orderId, absent.stockId)).length, 1);
    const [absentObligation] = await db.select({ status: orderPaymentObligations.status })
      .from(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, absent.order.id));
    assert.equal(absentObligation.status, "cancelled");

    // A provider verification error is best-effort: the sweep proceeds (the
    // finalizer's late-capture refund is the backstop), so this order is still
    // cancelled rather than stuck forever.
    assert.equal(await orderStatus(erroring.order.id), "cancelled",
      "a provider error falls back to cancelling (backstopped by late-capture refund)");
    assert.equal(await reservedFor(erroring.stockId), 0);

    assert.ok(result.scanned >= 4, "all four fixture orders were scanned");
  } finally {
    for (const stockId of createdStockIds) {
      await db.delete(productStockMovements)
        .where(eq(productStockMovements.productStockId, stockId));
    }
    for (const orderId of createdOrderIds) {
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    if (createdStockIds.length > 0) {
      await db.delete(productStock).where(inArray(productStock.id, createdStockIds));
    }
    await closePrivateDbPool();
  }
`;

test(
  "abandoned-stock sweep skips orders Square shows captured/authorized and releases the rest",
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
