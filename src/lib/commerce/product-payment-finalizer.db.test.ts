import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestUrl = process.env.TEST_DATABASE_URL;
const dbTestSkipReason = dbTestUrl
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed payment finalizer tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    fulfillmentRiskAlertOutbox,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
    productPaymentRiskIncidents,
  } from "./src/lib/private-db/schema.ts";
  import { finalizeProductPayment } from "./src/lib/commerce/product-payment-finalizer.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const prefix = "lh-remediation-finalizer-";

  async function cleanup() {
    await db.execute(sql.raw(
      "DELETE FROM fulfillment_risk_alert_outbox WHERE incident_id IN " +
      "(SELECT id FROM product_payment_risk_incidents WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%'))",
    ));
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
      "DELETE FROM product_order_refunds WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-remediation-finalizer-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_order_adjustments WHERE order_id IN " +
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
      fulfillmentMode: "manual_pickup",
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
      initializationStatus: "ready",
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
    assert.deepEqual(applied, {
      transition: "applied",
      riskStatus: "cleared",
      obligationId: first.obligation.id,
    });

    const duplicate = await finalizeProductPayment({
      ...purchase,
      orderReference: firstOrderId,
    });
    assert.deepEqual(duplicate, {
      transition: "already_applied",
      riskStatus: "cleared",
      obligationId: first.obligation.id,
    });

    for (const authoritativeLookupFailure of ["request_failed", "malformed_response"]) {
      const authenticatedReplay = await finalizeProductPayment({
        orderReference: firstOrderId,
        obligationId: first.obligation.id,
        transactionId: purchase.transactionId,
        source: "helcim_api",
        data: {},
        authoritativeLookupFailure,
        authenticatedCallbackIdentity: {
          orderReference: firstOrderId,
          obligationId: first.obligation.id,
          transactionId: purchase.transactionId,
        },
      });
      assert.deepEqual(authenticatedReplay, {
        transition: "already_applied",
        riskStatus: "cleared",
        obligationId: first.obligation.id,
      });
    }

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
    const firstIncidents = await db.select().from(productPaymentRiskIncidents)
      .where(eq(productPaymentRiskIncidents.orderId, first.order.id));
    assert.equal(firstIncidents.length, 0);

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
    const [secondRisk] = await db.select({
      risk: checkoutOrders.paymentRiskStatus,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, second.order.id));
    assert.equal(secondRisk.risk, "review_required");

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
    const validAfterConflictId = "txn-remediation-finalizer-after-conflict";
    const validAfterConflict = await finalizeProductPayment({
      ...purchase,
      orderReference: thirdOrderId,
      transactionId: validAfterConflictId,
      data: { ...purchase.data, transactionId: validAfterConflictId },
    });
    assert.deepEqual(validAfterConflict, {
      transition: "applied",
      riskStatus: "review_required",
      obligationId: third.obligation.id,
    });

    const fourthOrderId = prefix + "four";
    const fourth = await seed(fourthOrderId);
    const reviewPurchase = {
      ...purchase,
      transactionId: "txn-remediation-finalizer-review",
      data: {
        ...purchase.data,
        transactionId: "txn-remediation-finalizer-review",
        avsResponse: "U",
        cvvResponse: "P",
      },
    };
    const held = await finalizeProductPayment({
      ...reviewPurchase,
      orderReference: fourthOrderId,
    });
    assert.equal(held.riskStatus, "review_required");
    const immutableReplay = await finalizeProductPayment({
      ...reviewPurchase,
      orderReference: fourthOrderId,
      data: {
        ...reviewPurchase.data,
        avsResponse: "Y",
        cvvResponse: "M",
      },
    });
    assert.deepEqual(immutableReplay, {
      transition: "already_applied",
      riskStatus: "review_required",
      obligationId: fourth.obligation.id,
    });
    const incidents = await db.select().from(productPaymentRiskIncidents)
      .where(eq(productPaymentRiskIncidents.orderId, fourth.order.id));
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].alertedAt, null);
    const alerts = await db.select().from(fulfillmentRiskAlertOutbox)
      .where(eq(fulfillmentRiskAlertOutbox.incidentId, incidents[0].id));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, "queued");

    const fifthOrderId = prefix + "five";
    const fifth = await seed(fifthOrderId);
    const primaryId = "txn-remediation-finalizer-primary-five";
    await finalizeProductPayment({
      ...purchase,
      orderReference: fifthOrderId,
      transactionId: primaryId,
      data: { ...purchase.data, transactionId: primaryId },
    });
    await db.update(checkoutOrders).set({
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
    }).where(eq(checkoutOrders.id, fifth.order.id));
    const [supplemental] = await db.insert(orderPaymentObligations).values({
      orderId: fifth.order.id,
      purpose: "manual_shipping",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 1000,
      taxAmountCents: 0,
      totalAmountCents: 1000,
      currency: "CAD",
      sourceWorkflow: "payment_finalizer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      initializationStatus: "ready",
      idempotencyKey: "manual-shipping/" + fifthOrderId,
    }).returning({ id: orderPaymentObligations.id });
    const supplementalId = "txn-remediation-finalizer-shipping-five";
    const supplementalResult = await finalizeProductPayment({
      orderReference: fifthOrderId,
      obligationId: supplemental.id,
      transactionId: supplementalId,
      source: "helcim_api",
      data: {
        amount: "10.00",
        currency: "CAD",
        status: "APPROVED",
        transactionType: "purchase",
        transactionId: supplementalId,
        avsResponse: "Y",
        cvvResponse: "M",
      },
    });
    assert.equal(supplementalResult.transition, "applied");
    const [fifthOrder] = await db.select({
      transactionId: checkoutOrders.helcimTransactionId,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, fifth.order.id));
    assert.equal(fifthOrder.transactionId, primaryId);
    const [paidSupplemental] = await db.select({
      status: orderPaymentObligations.status,
    }).from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, supplemental.id));
    assert.equal(paidSupplemental.status, "paid");

    const sixthOrderId = prefix + "six";
    const sixth = await seed(sixthOrderId);
    const concurrentId = "txn-remediation-finalizer-concurrent";
    const concurrentInput = {
      ...purchase,
      orderReference: sixthOrderId,
      transactionId: concurrentId,
      data: { ...purchase.data, transactionId: concurrentId },
    };
    const concurrent = await Promise.all([
      finalizeProductPayment(concurrentInput),
      finalizeProductPayment(concurrentInput),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.transition).sort(),
      ["already_applied", "applied"],
    );
    const sixthTransactions = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, sixth.obligation.id));
    assert.equal(sixthTransactions.length, 1);

    const seventhOrderId = prefix + "seven";
    const seventh = await seed(seventhOrderId);
    await db.update(checkoutOrders).set({
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "payment_pending",
    }).where(eq(checkoutOrders.id, seventh.order.id));
    const manualId = "txn-remediation-finalizer-manual";
    await finalizeProductPayment({
      ...purchase,
      orderReference: seventhOrderId,
      transactionId: manualId,
      data: { ...purchase.data, transactionId: manualId },
    });
    const [paidManual] = await db.select({
      status: checkoutOrders.status,
      manualStatus: checkoutOrders.manualFulfillmentStatus,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, seventh.order.id));
    assert.deepEqual(paidManual, {
      status: "paid",
      manualStatus: "paid_pending_dispatch",
    });

    const eighthOrderId = prefix + "eight";
    const eighth = await seed(eighthOrderId);
    await db.update(checkoutOrders).set({
      status: "cancelled",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "cancelled",
    }).where(eq(checkoutOrders.id, eighth.order.id));
    const lateId = "txn-remediation-finalizer-late";
    const late = await finalizeProductPayment({
      ...purchase,
      orderReference: eighthOrderId,
      transactionId: lateId,
      data: { ...purchase.data, transactionId: lateId },
    });
    assert.deepEqual(late, {
      transition: "state_conflict",
      riskStatus: "review_required",
      obligationId: eighth.obligation.id,
    });
    const [cancelledOrder] = await db.select({
      status: checkoutOrders.status,
      manualStatus: checkoutOrders.manualFulfillmentStatus,
      risk: checkoutOrders.paymentRiskStatus,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, eighth.order.id));
    assert.deepEqual(cancelledOrder, {
      status: "cancelled",
      manualStatus: "cancelled",
      risk: "review_required",
    });
    const [lateObligation] = await db.select({ status: orderPaymentObligations.status })
      .from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, eighth.obligation.id));
    assert.equal(lateObligation.status, "cancelled");
    const [lateTransaction] = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, eighth.obligation.id));
    assert.ok(
      lateTransaction.riskReasonCodes.includes(
        "LATE_CAPTURE_AFTER_MANUAL_CANCELLATION",
      ),
    );
    assert.ok(
      !lateTransaction.riskReasonCodes.includes(
        "LATE_CAPTURE_AFTER_OBSOLETE_ADDRESS_CHANGE",
      ),
    );
    const lateRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, lateTransaction.id));
    assert.equal(lateRefunds.length, 2);
    assert.equal(lateRefunds.reduce((sum, row) => sum + row.amountCents, 0), 12345);
    assert.ok(lateRefunds.every((row) => row.status === "queued"));
    assert.ok(lateRefunds.every((row) => row.originalTransactionId === lateId));
    const lateAdjustments = await db.select().from(productOrderAdjustments)
      .where(eq(productOrderAdjustments.orderId, eighth.order.id));
    assert.deepEqual(
      lateAdjustments.map((row) => [row.component, row.amountCents]).sort(),
      [["merchandise", 10000], ["outbound_shipping", 2345]].sort(),
    );

    async function seedPaidManualWithSupplement(orderSuffix, supplementStatus, expiresAt) {
      const orderReference = prefix + orderSuffix;
      const seeded = await seed(orderReference);
      await db.update(checkoutOrders).set({
        fulfillmentMode: "manual_pickup",
        manualFulfillmentStatus: "payment_pending",
      }).where(eq(checkoutOrders.id, seeded.order.id));
      const primaryTransactionId = "txn-remediation-finalizer-primary-" + orderSuffix;
      await finalizeProductPayment({
        ...purchase,
        orderReference,
        transactionId: primaryTransactionId,
        data: { ...purchase.data, transactionId: primaryTransactionId },
      });
      const [obligation] = await db.insert(orderPaymentObligations).values({
        orderId: seeded.order.id,
        purpose: "manual_shipping",
        status: supplementStatus,
        merchandiseAmountCents: 0,
        shippingAmountCents: 1000,
        taxAmountCents: 0,
        totalAmountCents: 1000,
        currency: "CAD",
        sourceWorkflow: "payment_finalizer_test",
        taxPolicyVersion: "test-tax-v1",
        policyVersion: "test-policy-v1",
        initializationStatus: "ready",
        expiresAt,
        idempotencyKey: "manual-shipping/" + orderReference,
      }).returning({ id: orderPaymentObligations.id });
      return { ...seeded, obligation, orderReference };
    }

    const expired = await seedPaidManualWithSupplement(
      "expired-supplement",
      "pending",
      new Date(Date.now() - 60_000),
    );
    const expiredCaptureId = "txn-remediation-finalizer-expired-supplement";
    const expiredCapture = await finalizeProductPayment({
      orderReference: expired.orderReference,
      obligationId: expired.obligation.id,
      transactionId: expiredCaptureId,
      source: "helcim_api",
      data: {
        amount: "10.00",
        currency: "CAD",
        status: "APPROVED",
        transactionType: "purchase",
        transactionId: expiredCaptureId,
        avsResponse: "Y",
        cvvResponse: "M",
      },
    });
    assert.equal(expiredCapture.transition, "state_conflict");
    const [expiredObligation] = await db.select({ status: orderPaymentObligations.status })
      .from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, expired.obligation.id));
    assert.equal(expiredObligation.status, "superseded");

    const cancelledSupplement = await seedPaidManualWithSupplement(
      "cancelled-supplement",
      "cancelled",
      new Date(Date.now() + 60_000),
    );
    await db.update(checkoutOrders).set({
      manualFulfillmentStatus: "cancelled",
    }).where(eq(checkoutOrders.id, cancelledSupplement.order.id));
    const cancelledCaptureId = "txn-remediation-finalizer-cancelled-supplement";
    const cancelledCapture = await finalizeProductPayment({
      orderReference: cancelledSupplement.orderReference,
      obligationId: cancelledSupplement.obligation.id,
      transactionId: cancelledCaptureId,
      source: "helcim_api",
      data: {
        amount: "10.00",
        currency: "CAD",
        status: "APPROVED",
        transactionType: "purchase",
        transactionId: cancelledCaptureId,
        avsResponse: "Y",
        cvvResponse: "M",
      },
    });
    assert.equal(cancelledCapture.transition, "state_conflict");
    const supplementalTransactions = await db.select({ id: orderPaymentTransactions.id })
      .from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, cancelledSupplement.obligation.id));
    assert.equal(supplementalTransactions.length, 1);
    const supplementalRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, supplementalTransactions[0].id));
    assert.equal(supplementalRefunds.reduce((sum, row) => sum + row.amountCents, 0), 1000);

    const obsoleteAddress = await seedPaidManualWithSupplement(
      "obsolete-address",
      "cancelled",
      new Date(Date.now() + 60_000),
    );
    const obsoleteAddressRequestId = "77777777-7777-4777-8777-777777777777";
    await db.update(orderPaymentObligations).set({
      purpose: "address_increase",
      status: "superseded",
      sourceReferenceId: obsoleteAddressRequestId,
      sourceWorkflow: "address_change/" + obsoleteAddressRequestId,
    }).where(eq(orderPaymentObligations.id, obsoleteAddress.obligation.id));
    const obsoleteCaptureId = "txn-remediation-finalizer-obsolete-address";
    const obsoleteCapture = await finalizeProductPayment({
      orderReference: obsoleteAddress.orderReference,
      obligationId: obsoleteAddress.obligation.id,
      transactionId: obsoleteCaptureId,
      source: "helcim_api",
      data: {
        amount: "10.00",
        currency: "CAD",
        status: "APPROVED",
        transactionType: "purchase",
        transactionId: obsoleteCaptureId,
        avsResponse: "Y",
        cvvResponse: "M",
      },
    });
    assert.equal(obsoleteCapture.transition, "state_conflict");
    const [obsoleteTransaction] = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, obsoleteAddress.obligation.id));
    assert.ok(
      obsoleteTransaction.riskReasonCodes.includes(
        "LATE_CAPTURE_AFTER_OBSOLETE_ADDRESS_CHANGE",
      ),
    );
    assert.ok(
      !obsoleteTransaction.riskReasonCodes.includes(
        "LATE_CAPTURE_AFTER_MANUAL_CANCELLATION",
      ),
    );
    const obsoleteRefunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.paymentTransactionId, obsoleteTransaction.id));
    assert.equal(obsoleteRefunds.reduce((sum, row) => sum + row.amountCents, 0), 1000);
    assert.ok(obsoleteRefunds.every((row) => row.reason === "late_capture_after_obsolete_address_change"));
    const [obsoleteAdjustment] = await db.select().from(productOrderAdjustments)
      .where(eq(productOrderAdjustments.id, obsoleteRefunds[0].adjustmentId));
    assert.equal(obsoleteAdjustment.sourceAddressRequestId, obsoleteAddressRequestId);
    const [obsoleteOrderAfter] = await db.select({
      fulfillmentMode: checkoutOrders.fulfillmentMode,
      manualStatus: checkoutOrders.manualFulfillmentStatus,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, obsoleteAddress.order.id));
    assert.deepEqual(obsoleteOrderAfter, {
      fulfillmentMode: "manual_pickup",
      manualStatus: "paid_pending_dispatch",
    });

    const terminalAutomatedOrderId = prefix + "terminal-automated-capture";
    const terminalAutomated = await seed(terminalAutomatedOrderId);
    await db
      .update(checkoutOrders)
      .set({
        status: "cancelled",
        fulfillmentMode: "automated_shipping",
        manualFulfillmentStatus: null,
      })
      .where(eq(checkoutOrders.id, terminalAutomated.order.id));
    const terminalAutomatedCaptureId =
      "txn-remediation-finalizer-terminal-automated";
    const terminalAutomatedResult = await finalizeProductPayment({
      ...purchase,
      orderReference: terminalAutomatedOrderId,
      transactionId: terminalAutomatedCaptureId,
      data: {
        ...purchase.data,
        transactionId: terminalAutomatedCaptureId,
      },
    });
    assert.equal(terminalAutomatedResult.transition, "state_conflict");
    const [terminalAutomatedTransaction] = await db
      .select()
      .from(orderPaymentTransactions)
      .where(
        eq(
          orderPaymentTransactions.obligationId,
          terminalAutomated.obligation.id,
        ),
      );
    assert.ok(
      terminalAutomatedTransaction.riskReasonCodes.includes(
        "LATE_CAPTURE_AFTER_TERMINAL_PRIMARY",
      ),
    );
    assert.ok(
      !terminalAutomatedTransaction.riskReasonCodes.includes(
        "LATE_CAPTURE_AFTER_MANUAL_CANCELLATION",
      ),
    );
    const terminalAutomatedRefunds = await db
      .select()
      .from(productOrderRefunds)
      .where(
        eq(
          productOrderRefunds.paymentTransactionId,
          terminalAutomatedTransaction.id,
        ),
      );
    assert.ok(
      terminalAutomatedRefunds.every(
        (refund) => refund.reason === "late_capture_after_terminal_primary",
      ),
    );

    const unknownOrderId = prefix + "authoritative-outcome-unknown";
    const unknown = await seed(unknownOrderId);
    await db.update(checkoutOrders).set({
      fulfillmentMode: "automated_shipping",
    }).where(eq(checkoutOrders.id, unknown.order.id));
    const unknownResult = await finalizeProductPayment({
      orderReference: unknownOrderId,
      obligationId: unknown.obligation.id,
      transactionId: "txn-remediation-finalizer-lookup-unknown",
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "request_failed",
    });
    assert.deepEqual(unknownResult, {
      transition: "outcome_unknown",
      riskStatus: "review_required",
      obligationId: unknown.obligation.id,
    });
    const [unknownOrder] = await db.select({
      status: checkoutOrders.status,
      riskStatus: checkoutOrders.paymentRiskStatus,
      fulfillmentClearedAt: checkoutOrders.fulfillmentClearedAt,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, unknown.order.id));
    assert.deepEqual(unknownOrder, {
      status: "pending",
      riskStatus: "review_required",
      fulfillmentClearedAt: null,
    });
    const [unknownObligation] = await db.select({
      status: orderPaymentObligations.status,
    }).from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, unknown.obligation.id));
    assert.equal(unknownObligation.status, "pending");
    const unknownTransactions = await db.select().from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, unknown.obligation.id));
    assert.equal(unknownTransactions.length, 0);
    const [unknownIncident] = await db.select({
      reasonCodes: productPaymentRiskIncidents.reasonCodes,
      status: productPaymentRiskIncidents.status,
    }).from(productPaymentRiskIncidents)
      .where(eq(productPaymentRiskIncidents.orderId, unknown.order.id));
    assert.equal(unknownIncident.status, "review_required");
    assert.ok(
      unknownIncident.reasonCodes.includes("AUTHORITATIVE_PROVIDER_OUTCOME_UNKNOWN"),
    );

    const replayMismatchOrderId = prefix + "authenticated-replay-mismatch";
    const replayMismatch = await seed(replayMismatchOrderId);
    const replayMismatchPurchaseId = "txn-remediation-finalizer-replay-mismatch-original";
    await finalizeProductPayment({
      ...purchase,
      orderReference: replayMismatchOrderId,
      transactionId: replayMismatchPurchaseId,
      data: { ...purchase.data, transactionId: replayMismatchPurchaseId },
    });
    const mismatchedReplay = await finalizeProductPayment({
      orderReference: replayMismatchOrderId,
      obligationId: replayMismatch.obligation.id,
      transactionId: "txn-remediation-finalizer-replay-mismatch-other",
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "request_failed",
      authenticatedCallbackIdentity: {
        orderReference: replayMismatchOrderId,
        obligationId: replayMismatch.obligation.id,
        transactionId: "txn-remediation-finalizer-replay-mismatch-other",
      },
    });
    assert.deepEqual(mismatchedReplay, {
      transition: "outcome_unknown",
      riskStatus: "review_required",
      obligationId: replayMismatch.obligation.id,
    });
    const [replayMismatchOrder] = await db.select({
      status: checkoutOrders.status,
      transactionId: checkoutOrders.helcimTransactionId,
      riskStatus: checkoutOrders.paymentRiskStatus,
    }).from(checkoutOrders).where(eq(checkoutOrders.id, replayMismatch.order.id));
    assert.deepEqual(replayMismatchOrder, {
      status: "paid",
      transactionId: replayMismatchPurchaseId,
      riskStatus: "review_required",
    });
    await db.update(productPaymentRiskIncidents).set({
      status: "cleared",
      outcome: "cleared",
      reviewedAt: new Date(),
      stateVersion: 2,
    }).where(eq(productPaymentRiskIncidents.orderId, unknown.order.id));
    await db.update(checkoutOrders).set({
      paymentRiskStatus: "cleared",
      fraudClearedAt: new Date(),
    }).where(eq(checkoutOrders.id, unknown.order.id));
    const repeatedUnknown = await finalizeProductPayment({
      orderReference: unknownOrderId,
      obligationId: unknown.obligation.id,
      transactionId: "txn-remediation-finalizer-lookup-unknown",
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "request_failed",
    });
    assert.equal(repeatedUnknown.transition, "outcome_unknown");
    assert.equal(repeatedUnknown.riskStatus, "review_required");
    const repeatedIncidents = await db.select({
      status: productPaymentRiskIncidents.status,
    }).from(productPaymentRiskIncidents)
      .where(eq(productPaymentRiskIncidents.orderId, unknown.order.id));
    assert.equal(repeatedIncidents.length, 2);
    assert.equal(
      repeatedIncidents.filter((incident) => incident.status === "review_required").length,
      1,
    );
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
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);
