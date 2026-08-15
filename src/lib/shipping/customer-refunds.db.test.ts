import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestUrl = process.env.TEST_DATABASE_URL;
const dbTestSkipReason = dbTestUrl
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed refund ledger tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { encryptCheckoutIp } from "./src/lib/commerce/checkout-pii.ts";
  import { HelcimApiError } from "./src/lib/commerce/helcim-client.ts";
  import {
    checkoutOrders,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
  } from "./src/lib/private-db/schema.ts";
  import {
    processProductOrderRefund,
    queueProductOrderRefundAllocations,
    reconcileProductOrderRefund,
  } from "./src/lib/shipping/customer-refunds.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.CHECKOUT_PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const db = getPrivateDb();
  const prefix = "lh-remediation-refund-";

  async function cleanup() {
    await db.execute(sql.raw(
      "DELETE FROM product_order_refunds WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-refund-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_order_adjustments WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-refund-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM order_payment_transactions WHERE obligation_id IN " +
      "(SELECT id FROM order_payment_obligations WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-refund-%'))",
    ));
    await db.execute(sql.raw(
      "DELETE FROM order_payment_obligations WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-refund-%')",
    ));
    await db.delete(checkoutOrders).where(like(checkoutOrders.orderId, prefix + "%"));
  }

  async function seed(orderId, captures) {
    const amountCents = captures.reduce((total, capture) => total + capture.amountCents, 0);
    const [order] = await db.insert(checkoutOrders).values({
      orderId,
      purpose: "product",
      status: "paid",
      customerName: "Refund Test",
      customerEmail: "refund-test@example.invalid",
      amountCents,
      merchandiseAmountCents: amountCents,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      helcimTransactionId: captures[0].providerTransactionId,
      refundOriginIpCiphertext: encryptCheckoutIp("192.0.2.10"),
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_shipping",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id });
    const result = [];
    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      const [obligation] = await db.insert(orderPaymentObligations).values({
        orderId: order.id,
        purpose: index === 0 ? "primary" : "manual_shipping",
        status: "paid",
        merchandiseAmountCents: capture.amountCents,
        shippingAmountCents: 0,
        taxAmountCents: 0,
        totalAmountCents: capture.amountCents,
        currency: "CAD",
        sourceWorkflow: "refund_test",
        taxPolicyVersion: "test-tax-v1",
        policyVersion: "test-policy-v1",
        initializationStatus: "ready",
        idempotencyKey: orderId + "/" + index,
        paidAt: new Date(),
      }).returning({ id: orderPaymentObligations.id });
      const [transaction] = await db.insert(orderPaymentTransactions).values({
        obligationId: obligation.id,
        provider: "helcim",
        providerTransactionId: capture.providerTransactionId,
        amountCents: capture.amountCents,
        currency: "CAD",
        originatingIpCiphertext: encryptCheckoutIp("192.0.2.10"),
        providerType: "PURCHASE",
        providerStatus: "APPROVED",
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: new Date(),
      }).returning();
      result.push(transaction);
    }
    return { order, transactions: result };
  }

  function gatewayFor(refundId, originalTransactionId, amountCents, counter) {
    return {
      createInvoice: async () => { throw new Error("unused"); },
      initializePay: async () => { throw new Error("unused"); },
      getCardTransaction: async () => { throw new Error("unused"); },
      refundPayment: async (_request, idempotencyKey) => {
        counter.calls += 1;
        assert.equal(idempotencyKey, refundId);
        return {
          transactionId: "990001",
          originalTransactionId,
          amount: (amountCents / 100).toFixed(2),
          currency: "CAD",
          status: "APPROVED",
          transactionType: "REFUND",
        };
      },
    };
  }

  try {
    await cleanup();
    const multi = await seed(prefix + "multi", [
      { providerTransactionId: "910001", amountCents: 10000 },
      { providerTransactionId: "910002", amountCents: 2500 },
    ]);
    await assert.rejects(
      queueProductOrderRefundAllocations({
        orderReference: prefix + "multi",
        amountCents: 500,
        reason: "Partial multi-capture refund",
      }),
      /transaction target is required/,
    );
    const targeted = await queueProductOrderRefundAllocations({
      orderReference: prefix + "multi",
      paymentTransactionId: multi.transactions[1].id,
      amountCents: 500,
      reason: "Targeted partial refund",
    });
    assert.equal(targeted.length, 1);
    assert.equal(targeted[0].paymentTransactionId, multi.transactions[1].id);
    assert.ok(targeted[0].adjustmentId);
    const [targetedAdjustment] = await db.select()
      .from(productOrderAdjustments)
      .where(eq(productOrderAdjustments.id, targeted[0].adjustmentId));
    assert.equal(targetedAdjustment.direction, "refund");
    assert.equal(targetedAdjustment.component, "merchandise");
    assert.equal(targetedAdjustment.status, "reserved");
    const remaining = await queueProductOrderRefundAllocations({
      orderReference: prefix + "multi",
      reason: "Refund all remaining captures",
    });
    assert.deepEqual(
      remaining.map((row) => [row.paymentTransactionId, row.amountCents]).sort(),
      [
        [multi.transactions[0].id, 10000],
        [multi.transactions[1].id, 2000],
      ].sort(),
    );

    const concurrentSeed = await seed(prefix + "concurrent", [
      { providerTransactionId: "920001", amountCents: 3400 },
    ]);
    const [concurrentRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "concurrent",
      reason: "Concurrent refund",
    });
    const counter = { calls: 0 };
    const gateway = gatewayFor(
      concurrentRefund.idempotencyKey,
      "920001",
      3400,
      counter,
    );
    await Promise.allSettled([
      processProductOrderRefund(concurrentRefund.id, gateway),
      processProductOrderRefund(concurrentRefund.id, gateway),
    ]);
    assert.equal(counter.calls, 1);
    const [completed] = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.id, concurrentRefund.id));
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.paymentTransactionId, concurrentSeed.transactions[0].id);

    await seed(prefix + "provider-rejected", [
      { providerTransactionId: "925001", amountCents: 2100 },
    ]);
    const [rejectedRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "provider-rejected",
      reason: "Provider rejection remains actionable",
    });
    const rejected = await processProductOrderRefund(rejectedRefund.id, {
      createInvoice: async () => { throw new Error("unused"); },
      initializePay: async () => { throw new Error("unused"); },
      getCardTransaction: async () => { throw new Error("unused"); },
      refundPayment: async () => {
        throw new HelcimApiError({
          path: "/payment/refund",
          responseError: "refund rejected",
          status: 422,
        });
      },
    });
    assert.equal(rejected.status, "manual_review");
    const rejectedAgain = await queueProductOrderRefundAllocations({
      orderReference: prefix + "provider-rejected",
      reason: "Provider rejection remains actionable",
    });
    assert.deepEqual(rejectedAgain.map((row) => row.id), [rejectedRefund.id]);
    const rejectedRows = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.orderId, rejected.orderId));
    assert.equal(rejectedRows.length, 1);

    await seed(prefix + "expired-lease", [
      { providerTransactionId: "926001", amountCents: 2200 },
    ]);
    const [expiredLeaseRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "expired-lease",
      reason: "Expired provider mutation lease",
    });
    await db.update(productOrderRefunds).set({
      status: "processing",
      leaseOwner: "crashed-worker",
      leaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(productOrderRefunds.id, expiredLeaseRefund.id));
    let expiredLeaseProviderCalls = 0;
    const expiredLeaseResult = await processProductOrderRefund(
      expiredLeaseRefund.id,
      {
        createInvoice: async () => { throw new Error("unused"); },
        initializePay: async () => { throw new Error("unused"); },
        getCardTransaction: async () => { throw new Error("unused"); },
        refundPayment: async () => {
          expiredLeaseProviderCalls += 1;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(expiredLeaseProviderCalls, 0);
    assert.equal(expiredLeaseResult.status, "outcome_unknown");

    const race = await seed(prefix + "race", [
      { providerTransactionId: "930001", amountCents: 1800 },
    ]);
    const [raceRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "race",
      reason: "Webhook race",
    });
    let rejectProvider;
    let providerStartedResolve;
    const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
    const deferredGateway = {
      createInvoice: async () => { throw new Error("unused"); },
      initializePay: async () => { throw new Error("unused"); },
      getCardTransaction: async () => { throw new Error("unused"); },
      refundPayment: async () => {
        providerStartedResolve();
        return new Promise((_resolve, reject) => { rejectProvider = reject; });
      },
    };
    const processing = processProductOrderRefund(raceRefund.id, deferredGateway);
    await providerStarted;
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "930001",
      providerRefundId: "993001",
      amountCents: 1800,
      currency: "CAD",
    }), true);
    rejectProvider(new Error("late transport failure"));
    const racedResult = await processing;
    assert.equal(racedResult.status, "succeeded");
    assert.equal(racedResult.providerRefundId, "993001");
    assert.equal(racedResult.paymentTransactionId, race.transactions[0].id);

    const ambiguous = await seed(prefix + "ambiguous", [
      { providerTransactionId: "940001", amountCents: 900 },
    ]);
    await db.insert(productOrderRefunds).values([
      {
        orderId: ambiguous.order.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "partial",
        reason: "Ambiguous A",
        amountCents: 111,
        originalTransactionId: "940001",
        paymentTransactionId: ambiguous.transactions[0].id,
      },
      {
        orderId: ambiguous.order.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "partial",
        reason: "Ambiguous B",
        amountCents: 111,
        originalTransactionId: "940001",
        paymentTransactionId: ambiguous.transactions[0].id,
      },
    ]);
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "940001",
      providerRefundId: "994001",
      amountCents: 111,
      currency: "CAD",
    }), false);
    const manual = await db.select({ status: productOrderRefunds.status })
      .from(productOrderRefunds)
      .where(eq(productOrderRefunds.orderId, ambiguous.order.id));
    assert.deepEqual(manual.map((row) => row.status), ["manual_review", "manual_review"]);

    const untyped = await seed(prefix + "untyped-reconcile", [
      { providerTransactionId: "950001", amountCents: 1200 },
    ]);
    const [untypedRefund] = await db.insert(productOrderRefunds).values({
      orderId: untyped.order.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "full",
      reason: "Legacy untyped refund",
      amountCents: 1200,
      originalTransactionId: "950001",
      paymentTransactionId: untyped.transactions[0].id,
    }).returning();
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "950001",
      providerRefundId: "995001",
      amountCents: 1200,
      currency: "CAD",
    }), false);
    const [untypedAfter] = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.id, untypedRefund.id));
    assert.equal(untypedAfter.status, "manual_review");
    assert.equal(untypedAfter.providerRefundId, "995001");
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "refund allocations and leases preserve exact transaction identity under races",
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
        stdio: "pipe",
      },
    );
  },
);
