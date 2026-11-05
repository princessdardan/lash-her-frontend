import { execFileSync } from "node:child_process";
import test from "node:test";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, sql } from "drizzle-orm";
  import { getPrivateDb, closePrivateDbPool } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, trainingEnrollments } from "./src/lib/private-db/schema.ts";
  import { createPendingSquareTrainingCardOrder, findCheckoutOrderByOrderId } from "./src/lib/commerce/order-store.ts";
  import { chargeLiveTrainingSplit, reconcileTrainingSplits } from "./src/lib/commerce/square-training-split-live.ts";
  import { withWriterOperationContext } from "./src/lib/writer-admission/context.ts";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PAYMENT_GATEWAY_MODE = "mock";
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL_ENV;
  Object.assign(process.env, { SQUARE_COMMERCE_ENABLED: "true", SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "test", SQUARE_LOCATION_ID: "test", SQUARE_WEBHOOK_SIGNATURE_KEY: "test" });
  // No enrollment is seeded: notification lookup returns null and no emails are sent.
  const db = getPrivateDb();
  const input = { customerName: "Split Test", customerEmail: "split-test@example.invalid", programSlug: "split-test",
    amountCents: 395500, merchandiseAmountCents: 350000, taxAmountCents: 45500,
    afterpayAmountCents: 200000, reservationKey: crypto.randomUUID(),
    cart: { currency: "CAD", amount: 3500, lineItems: [{ productId: "test", sku: "test", description: "Split Test", quantity: 1, price: 3500, total: 3500 }] } };
  let order;
  try {
    order = await createPendingSquareTrainingCardOrder(input);
    assert.deepEqual(await createPendingSquareTrainingCardOrder(input), order);
    for (const change of [{ amountCents: 395501 }, { afterpayAmountCents: 199900 }, { afterpayAmountCents: undefined }, { programSlug: "other" }])
      await assert.rejects(() => createPendingSquareTrainingCardOrder({ ...input, ...change }));
    await db.transaction(async tx => {
      await tx.execute(sql.raw("select pg_advisory_xact_lock(hashtextextended('training-split/" + order.orderId.replaceAll("'", "''") + "', 0))"));
      const busy = await chargeLiveTrainingSplit({ orderReference: order.orderId });
      assert.equal(busy.ok, false);
      assert.equal(busy.reason, "split_payment_in_progress");
      assert.equal(busy.retryWithNewReservation, false);
    });
    const paid = await chargeLiveTrainingSplit({ orderReference: order.orderId, amountCents: 395500,
      payment: { method: "afterpay_card", expectedAmountCents: 395500, afterpayAmountCents: 200000,
        afterpay: { method: "afterpay", sourceId: "mock-ap", expectedAmountCents: 200000 }, card: { sourceId: "mock-card" } } });
    assert.equal(paid.ok, true);
    const saved = await findCheckoutOrderByOrderId(order.orderId);
    assert.equal(saved.status, "paid");
    assert.equal(saved.providerStatus, "COMPLETED");
    assert.equal(saved.providerMetadata.splitPayment.stage, "paid");
    assert.equal(saved.providerMetadata.splitPayment.cardAmountCents, 195500);
    assert.equal(saved.providerMetadata.splitPayment.afterpayAmountCents, 200000);
    assert.notEqual(saved.providerMetadata.splitPayment.cardPaymentId, saved.providerMetadata.splitPayment.afterpayPaymentId);
    assert.equal((await chargeLiveTrainingSplit({ orderReference: order.orderId })).ok, true);
    // A paid split's notification no-op is not completion evidence under admission.
    await assert.rejects(withWriterOperationContext(() => chargeLiveTrainingSplit({
      orderReference: order.orderId,
    })), /WRITER_OPERATION_REQUIRES_REVIEW/);
    const [enrollment] = await db.insert(trainingEnrollments).values({
      checkoutOrderId: order.databaseId, checkoutEmail: input.customerEmail,
      productSnapshot: { id: "owned-training", title: "Owned Training", sku: "OWNED", priceCents: 350000, currency: "CAD" },
      programSnapshot: { id: "owned-training", slug: "owned-training", title: "Owned Training" },
      schedulingStatus: "pending", studentPaymentEmailSentAt: new Date(), staffAlertedAt: new Date(),
    }).returning();
    const duplicate = await withWriterOperationContext(() => chargeLiveTrainingSplit({ orderReference: order.orderId }));
    assert.equal(duplicate.ok, true); assert.equal(duplicate.transition, "already_applied");
    await db.update(trainingEnrollments).set({ schedulingStatus: "scheduled", tokenUsedAt: new Date() })
      .where(eq(trainingEnrollments.id, enrollment.id));
    await assert.rejects(withWriterOperationContext(() => chargeLiveTrainingSplit({
      orderReference: order.orderId,
    })), /WRITER_OPERATION_REQUIRES_REVIEW/);
    const replayed = await findCheckoutOrderByOrderId(order.orderId);
    assert.deepEqual(replayed.providerMetadata.splitPayment, saved.providerMetadata.splitPayment);
    // The actual cron query excludes reserved/fresh/terminal rows, then recovers
    // stale state under its own operation context using the same payment IDs.
    let summary;
    const runner = async task => { summary = await task(); return summary; };
    const future = new Date(Date.now() + 120000);
    const reset = async stage => db.update(checkoutOrders).set({ status: "pending", paidAt: null,
      providerStatus: "APPROVED", updatedAt: new Date(), providerMetadata: {
        ...saved.providerMetadata, splitPayment: { ...saved.providerMetadata.splitPayment, stage },
      } }).where(eq(checkoutOrders.id, order.databaseId));
    await reset("reserved");
    await reconcileTrainingSplits(future, runner);
    assert.deepEqual(summary, { checked: 0, recovered: 0, canceled: 0, failed: 0 });
    await reset("completing");
    await reconcileTrainingSplits(new Date(), runner);
    assert.equal(summary.checked, 0);
    await assert.rejects(withWriterOperationContext(() => reconcileTrainingSplits(future, runner)), /WRITER_OPERATION_REQUIRES_REVIEW/);
    assert.deepEqual(summary, { checked: 1, recovered: 1, canceled: 0, failed: 0 });
    const recovered = await findCheckoutOrderByOrderId(order.orderId);
    assert.equal(recovered.status, "paid");
    assert.deepEqual(recovered.providerMetadata.splitPayment, saved.providerMetadata.splitPayment);
    await reset("canceling");
    await withWriterOperationContext(() => reconcileTrainingSplits(future, runner));
    assert.deepEqual(summary, { checked: 1, recovered: 0, canceled: 1, failed: 0 });
    const canceled = await findCheckoutOrderByOrderId(order.orderId);
    assert.equal(canceled.providerMetadata.splitPayment.stage, "canceled");
    assert.equal(canceled.providerMetadata.splitPayment.cardPaymentId, saved.providerMetadata.splitPayment.cardPaymentId);
    assert.equal(canceled.providerMetadata.splitPayment.afterpayPaymentId, saved.providerMetadata.splitPayment.afterpayPaymentId);
    await reconcileTrainingSplits(future, runner);
    assert.equal(summary.checked, 0);
  } finally {
    if (order) {
      await db.delete(trainingEnrollments).where(eq(trainingEnrollments.checkoutOrderId, order.databaseId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, order.databaseId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "split reservation binding, per-order locking, durable receipt and replay",
  {
    skip: process.env.TEST_DATABASE_URL
      ? undefined
      : "set TEST_DATABASE_URL for split ledger tests",
  },
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
        env: process.env,
        stdio: "inherit",
      },
    );
  },
);
