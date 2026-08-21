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
  import {
    checkoutOrders,
    customerEmailOutbox,
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
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.ADMIN_OWNER_EMAILS = "finance-refund-test@example.invalid";
  const db = getPrivateDb();
  const prefix = "lh-remediation-refund-";
  const ambiguousAlertKeyPrefix = "shipping-refund-ambiguous/sq-refund-ambiguous-980001/";
  const unlinkedAlertKeyPrefix = "shipping-refund-unlinked/sq-refund-unlinked-960001/";
  const bookingAlertKeyPrefix = "shipping-refund-unlinked/sq-refund-booking-970001/";
  // The out-of-band ("unlinked") alert key that a RETRY of the ambiguous refund
  // would incorrectly raise (N1). It must never be created — cleaned defensively
  // so a leftover from a pre-fix run cannot fail the retry-suppression assertion.
  const ambiguousUnlinkedKeyPrefix = "shipping-refund-unlinked/sq-refund-ambiguous-980001/";

  async function cleanup() {
    await db.delete(customerEmailOutbox).where(
      like(customerEmailOutbox.providerIdempotencyKey, ambiguousAlertKeyPrefix + "%"),
    );
    await db.delete(customerEmailOutbox).where(
      like(customerEmailOutbox.providerIdempotencyKey, unlinkedAlertKeyPrefix + "%"),
    );
    await db.delete(customerEmailOutbox).where(
      like(customerEmailOutbox.providerIdempotencyKey, bookingAlertKeyPrefix + "%"),
    );
    await db.delete(customerEmailOutbox).where(
      like(customerEmailOutbox.providerIdempotencyKey, ambiguousUnlinkedKeyPrefix + "%"),
    );
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
      paymentProvider: "square",
      providerPaymentId: captures[0].providerTransactionId,
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
        provider: "square",
        providerTransactionId: capture.providerTransactionId,
        amountCents: capture.amountCents,
        currency: "CAD",
        providerType: "PAYMENT",
        providerStatus: "COMPLETED",
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: new Date(),
      }).returning();
      result.push(transaction);
    }
    return { order, transactions: result };
  }

  // A settled (COMPLETED) Square refund. Echoes the request's payment id, amount,
  // and currency so the caller's correlation gate passes.
  function settledRefunder(refundId, counter, expectedIdempotencyKey) {
    return {
      refundPayment: async (input) => {
        counter.calls += 1;
        assert.equal(input.idempotencyKey, expectedIdempotencyKey);
        return {
          ok: true,
          refundId,
          paymentId: input.paymentId,
          amountCents: input.amountCents,
          currency: input.currency,
          settled: true,
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
    const refunder = settledRefunder(
      "sq-refund-990001",
      counter,
      concurrentRefund.idempotencyKey,
    );
    await Promise.allSettled([
      processProductOrderRefund(concurrentRefund.id, refunder),
      processProductOrderRefund(concurrentRefund.id, refunder),
    ]);
    assert.equal(counter.calls, 1);
    const [completed] = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.id, concurrentRefund.id));
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.providerRefundId, "sq-refund-990001");
    assert.equal(completed.paymentTransactionId, concurrentSeed.transactions[0].id);

    await seed(prefix + "provider-rejected", [
      { providerTransactionId: "925001", amountCents: 2100 },
    ]);
    const [rejectedRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "provider-rejected",
      reason: "Provider rejection remains actionable",
    });
    const rejected = await processProductOrderRefund(rejectedRefund.id, {
      refundPayment: async () => ({
        ok: false,
        deterministic: true,
        code: "SQUARE_PAYMENT_NOT_REFUNDABLE",
      }),
    });
    assert.equal(rejected.status, "manual_review");
    assert.equal(rejected.lastErrorCode, "SQUARE_PAYMENT_NOT_REFUNDABLE");
    const rejectedAgain = await queueProductOrderRefundAllocations({
      orderReference: prefix + "provider-rejected",
      reason: "Provider rejection remains actionable",
    });
    assert.deepEqual(rejectedAgain.map((row) => row.id), [rejectedRefund.id]);
    const rejectedRows = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.orderId, rejected.orderId));
    assert.equal(rejectedRows.length, 1);

    // A transient/unknown provider outcome may have moved money: it must land in
    // outcome_unknown (awaiting the refund.updated webhook), never manual_review.
    await seed(prefix + "provider-transient", [
      { providerTransactionId: "925101", amountCents: 1500 },
    ]);
    const [transientRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "provider-transient",
      reason: "Transient provider failure",
    });
    const transient = await processProductOrderRefund(transientRefund.id, {
      refundPayment: async () => ({
        ok: false,
        deterministic: false,
        code: "OUTCOME_UNKNOWN",
      }),
    });
    assert.equal(transient.status, "outcome_unknown");

    // A PENDING Square refund is accepted but not settled: the row records the
    // provider refund id and waits for the refund.updated webhook to settle it.
    const pendingSeed = await seed(prefix + "pending", [
      { providerTransactionId: "925201", amountCents: 1700 },
    ]);
    const [pendingRefund] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "pending",
      reason: "Pending Square refund",
    });
    const pending = await processProductOrderRefund(pendingRefund.id, {
      refundPayment: async (input) => ({
        ok: true,
        refundId: "sq-refund-992001",
        paymentId: input.paymentId,
        amountCents: input.amountCents,
        currency: input.currency,
        settled: false,
      }),
    });
    assert.equal(pending.status, "outcome_unknown");
    assert.equal(pending.providerRefundId, "sq-refund-992001");
    // The refund.updated COMPLETED webhook settles the pending refund by its
    // provider refund id.
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "925201",
      providerRefundId: "sq-refund-992001",
      amountCents: 1700,
      currency: "CAD",
    }), true);
    const [pendingAfter] = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.id, pendingRefund.id));
    assert.equal(pendingAfter.status, "succeeded");
    assert.equal(pendingSeed.transactions.length, 1);

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
    let resolveProvider;
    let providerStartedResolve;
    const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
    const deferredRefunder = {
      refundPayment: async () => {
        providerStartedResolve();
        return new Promise((resolve) => { resolveProvider = resolve; });
      },
    };
    const processing = processProductOrderRefund(raceRefund.id, deferredRefunder);
    await providerStarted;
    // The refund.updated webhook settles the in-flight refund by its Square
    // payment id before the issuing request returns.
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: race.transactions[0].providerTransactionId,
      providerRefundId: "sq-refund-993001",
      amountCents: 1800,
      currency: "CAD",
    }), true);
    // The issuing request then resolves to a transient outcome; its guarded
    // completion no-ops because reconciliation already settled the row.
    resolveProvider({ ok: false, deterministic: false, code: "OUTCOME_UNKNOWN" });
    const racedResult = await processing;
    assert.equal(racedResult.status, "succeeded");
    assert.equal(racedResult.providerRefundId, "sq-refund-993001");
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
      providerRefundId: "sq-refund-994001",
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
      providerRefundId: "sq-refund-995001",
      amountCents: 1200,
      currency: "CAD",
    }), false);
    const [untypedAfter] = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.id, untypedRefund.id));
    assert.equal(untypedAfter.status, "manual_review");
    assert.equal(untypedAfter.providerRefundId, "sq-refund-995001");

    // Two same-amount transient refunds against one payment both settle at
    // Square; the COMPLETED webhook cannot disambiguate by provider refund id,
    // so reconcile parks both in manual_review AND raises a finance alert
    // instead of stranding the completed refund silently.
    const ambiguousCompleted = await seed(prefix + "ambiguous-completed", [
      { providerTransactionId: "980001", amountCents: 3000 },
    ]);
    const [ambiguousA] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "ambiguous-completed",
      paymentTransactionId: ambiguousCompleted.transactions[0].id,
      amountCents: 500,
      reason: "Ambiguous completed A",
    });
    const [ambiguousB] = await queueProductOrderRefundAllocations({
      orderReference: prefix + "ambiguous-completed",
      paymentTransactionId: ambiguousCompleted.transactions[0].id,
      amountCents: 500,
      reason: "Ambiguous completed B",
    });
    const transientRefunder = {
      refundPayment: async () => ({ ok: false, deterministic: false, code: "OUTCOME_UNKNOWN" }),
    };
    await processProductOrderRefund(ambiguousA.id, transientRefunder);
    await processProductOrderRefund(ambiguousB.id, transientRefunder);
    const beforeReconcile = await db.select({
      status: productOrderRefunds.status,
      providerRefundId: productOrderRefunds.providerRefundId,
    }).from(productOrderRefunds).where(inArray(productOrderRefunds.id, [ambiguousA.id, ambiguousB.id]));
    assert.deepEqual(beforeReconcile.map((row) => row.status), ["outcome_unknown", "outcome_unknown"]);
    assert.deepEqual(beforeReconcile.map((row) => row.providerRefundId), [null, null]);

    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "980001",
      providerRefundId: "sq-refund-ambiguous-980001",
      amountCents: 500,
      currency: "CAD",
    }), false);
    const ambiguousRows = await db.select({
      status: productOrderRefunds.status,
      lastErrorCode: productOrderRefunds.lastErrorCode,
    }).from(productOrderRefunds).where(inArray(productOrderRefunds.id, [ambiguousA.id, ambiguousB.id]));
    assert.deepEqual(ambiguousRows.map((row) => row.status), ["manual_review", "manual_review"]);
    assert.deepEqual(ambiguousRows.map((row) => row.lastErrorCode), ["AMBIGUOUS_PROVIDER_REFUND", "AMBIGUOUS_PROVIDER_REFUND"]);
    const ambiguousAlerts = await db.select().from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, ambiguousAlertKeyPrefix + "%"));
    assert.ok(ambiguousAlerts.length >= 1, "expected a finance alert for the ambiguous refund");
    assert.ok(ambiguousAlerts.every((row) => row.kind === "shipping_policy_alert" && row.status === "queued"));

    // N1 regression: a webhook RETRY of that SAME ambiguous refund now misses
    // existingProviderMatch (the parked rows carry no providerRefundId) and finds
    // zero live candidates (they are manual_review, not queued/processing/
    // outcome_unknown), so it lands in the zero-candidate branch. It must NOT
    // raise the contradictory "unlinked / out-of-band" alert — the refund was
    // already surfaced by the ambiguous alert above. The ambiguous alert itself
    // must not multiply either.
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "980001",
      providerRefundId: "sq-refund-ambiguous-980001",
      amountCents: 500,
      currency: "CAD",
    }), false);
    const ambiguousRetryUnlinked = await db.select().from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, ambiguousUnlinkedKeyPrefix + "%"));
    assert.equal(ambiguousRetryUnlinked.length, 0, "an ambiguous-refund retry must not raise the out-of-band alert");
    const ambiguousAlertsAfterRetry = await db.select().from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, ambiguousAlertKeyPrefix + "%"));
    assert.equal(ambiguousAlertsAfterRetry.length, ambiguousAlerts.length, "the ambiguous alert must not multiply on retry");

    // A COMPLETED Square refund that settled against a product-order capture but
    // matches NO reserved refund row (e.g. an operator issued it from the Square
    // Dashboard) must raise a critical finance_owner alert — the order stays
    // 'paid' and nothing else watches it. Keyed by the provider refund id so a
    // retried webhook does not re-notify.
    await seed(prefix + "unlinked", [
      { providerTransactionId: "960001", amountCents: 4300 },
    ]);
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "960001",
      providerRefundId: "sq-refund-unlinked-960001",
      amountCents: 4300,
      currency: "CAD",
    }), false);
    const unlinkedAlerts = await db.select().from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, unlinkedAlertKeyPrefix + "%"));
    assert.ok(unlinkedAlerts.length >= 1, "expected a finance alert for the unlinked product-order refund");
    assert.ok(unlinkedAlerts.every((row) => row.kind === "shipping_policy_alert" && row.status === "queued"));
    // A webhook retry is idempotent on the provider refund id: no second alert.
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "960001",
      providerRefundId: "sq-refund-unlinked-960001",
      amountCents: 4300,
      currency: "CAD",
    }), false);
    const unlinkedAlertsAfterRetry = await db.select().from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, unlinkedAlertKeyPrefix + "%"));
    assert.equal(unlinkedAlertsAfterRetry.length, unlinkedAlerts.length);

    // A COMPLETED refund whose originalTransactionId matches NO product-order
    // payment is a genuine service-booking refund (bookings settle through
    // appointment_holds/checkout_payment_events, not orderPaymentTransactions).
    // Reconcile must stay silent — returning false and raising NO alert.
    assert.equal(await reconcileProductOrderRefund({
      originalTransactionId: "sq-booking-capture-does-not-exist",
      providerRefundId: "sq-refund-booking-970001",
      amountCents: 6600,
      currency: "CAD",
    }), false);
    const bookingAlerts = await db.select().from(customerEmailOutbox)
      .where(like(customerEmailOutbox.providerIdempotencyKey, bookingAlertKeyPrefix + "%"));
    assert.equal(bookingAlerts.length, 0, "a booking refund must not raise a product-order finance alert");
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
