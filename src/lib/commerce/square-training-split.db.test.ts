import { execFileSync } from "node:child_process";
import test from "node:test";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, sql } from "drizzle-orm";
  import { getPrivateDb, closePrivateDbPool } from "./src/lib/private-db/client.ts";
  import { checkoutOrders } from "./src/lib/private-db/schema.ts";
  import { createPendingSquareTrainingCardOrder, findCheckoutOrderByOrderId } from "./src/lib/commerce/order-store.ts";
  import { chargeLiveTrainingSplit } from "./src/lib/commerce/square-training-split-live.ts";
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
  } finally {
    if (order) await db.delete(checkoutOrders).where(eq(checkoutOrders.id, order.databaseId));
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
