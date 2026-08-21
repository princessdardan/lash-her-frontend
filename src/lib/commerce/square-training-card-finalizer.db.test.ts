import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run Square training card finalizer tests";

// Square primary-training card finalizer. Training has no money-ledger row; the
// checkout_orders row itself carries the payment. Covers the server-authoritative
// amount/currency gate, the idempotent paid transition on the Square payment id
// (replay -> already_applied), transaction_conflict when a different payment id
// lands on an already-paid order, and the terminal state_conflict guard.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders } from "./src/lib/private-db/schema.ts";
  import { finalizeSquareTrainingCardPayment } from "./src/lib/commerce/square-training-card-finalizer.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const prefix = "lh-square-training-finalizer-" + fixture;
  const createdOrderIds = [];

  async function seed(suffix, overrides) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "training",
      status: "pending",
      customerName: "Square Training Finalizer Test",
      customerEmail: "square-training-finalizer@example.invalid",
      amountCents: 30000,
      merchandiseAmountCents: 30000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "cleared",
      ...(overrides ?? {}),
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    createdOrderIds.push(order.id);
    return order;
  }

  try {
    // ---- amount/currency gate ----
    const mismatch = await seed("mismatch");
    const amountMismatch = await finalizeSquareTrainingCardPayment({
      orderReference: mismatch.orderId,
      squarePaymentId: "sq-mismatch-amount-" + fixture,
      amountCents: 29999,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(amountMismatch.transition, "amount_or_currency_mismatch");
    const currencyMismatch = await finalizeSquareTrainingCardPayment({
      orderReference: mismatch.orderId,
      squarePaymentId: "sq-mismatch-currency-" + fixture,
      amountCents: 30000,
      currency: "USD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(currencyMismatch.transition, "amount_or_currency_mismatch");
    const [stillPending] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, mismatch.id));
    assert.equal(stillPending.status, "pending");

    // ---- applied: a matching captured payment marks the order paid ----
    const applied = await seed("applied");
    const appliedPaymentId = "sq-applied-" + fixture;
    const appliedResult = await finalizeSquareTrainingCardPayment({
      orderReference: applied.orderId,
      squarePaymentId: appliedPaymentId,
      amountCents: 30000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(appliedResult.transition, "applied");
    const [paidOrder] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, applied.id));
    assert.equal(paidOrder.status, "paid");
    assert.equal(paidOrder.providerPaymentId, appliedPaymentId);
    assert.equal(paidOrder.providerStatus, "COMPLETED");
    assert.equal(paidOrder.providerMetadata.finalizationStatus, "paid");

    // ---- already_applied: same Square payment id replayed is a no-op ----
    const replay = await finalizeSquareTrainingCardPayment({
      orderReference: applied.orderId,
      squarePaymentId: appliedPaymentId,
      amountCents: 30000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(replay.transition, "already_applied");

    // ---- transaction_conflict: a DIFFERENT Square payment id on an already-paid
    // order must never overwrite the recorded payment ----
    const conflict = await finalizeSquareTrainingCardPayment({
      orderReference: applied.orderId,
      squarePaymentId: "sq-different-" + fixture,
      amountCents: 30000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(conflict.transition, "transaction_conflict");
    const [unchanged] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, applied.id));
    assert.equal(unchanged.providerPaymentId, appliedPaymentId);

    // ---- state_conflict: a terminal (cancelled) order cannot be finalized ----
    const cancelled = await seed("cancelled", { status: "cancelled" });
    const stateConflict = await finalizeSquareTrainingCardPayment({
      orderReference: cancelled.orderId,
      squarePaymentId: "sq-cancelled-" + fixture,
      amountCents: 30000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(stateConflict.transition, "state_conflict");

    // ---- not_found: an unknown order reference ----
    const notFound = await finalizeSquareTrainingCardPayment({
      orderReference: prefix + "-nonexistent",
      squarePaymentId: "sq-none-" + fixture,
      amountCents: 30000,
      currency: "CAD",
      providerType: "CARD",
      providerStatus: "COMPLETED",
    });
    assert.equal(notFound.transition, "not_found");
  } finally {
    for (const orderId of createdOrderIds) {
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "Square training card finalizer verifies amount/currency and idempotently marks the order paid",
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
