import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run case-resolution invariant tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    checkoutOrders,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
    productShippingCases,
    productShipmentJobs,
    productShipments,
    shippingPolicyAssignments,
  } from "./src/lib/private-db/schema.ts";
  import { adoptReplacementShipment, queueInventoryUnavailableRefund, updateProductShippingCase } from "./src/lib/shipping/cases.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const ownerEmail = "case-resolution-" + fixture + "@example.invalid";
  process.env.ADMIN_OWNER_EMAILS = ownerEmail;
  const orderIds = [];
  const shipmentIds = [];
  let ownerId;
  const now = new Date("2026-08-15T12:00:00.000Z");
  const destination = {
    name: "Case Resolution Test",
    email: ownerEmail,
    phone: "+14165550100",
    line1: "100 Test Street",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 1A1",
    country: "Canada",
    countryCode: "CA",
  };
  const packageSnapshot = {
    profileId: "profile",
    profileSlug: "profile",
    packageType: "parcel",
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    tareWeightGrams: 10,
    totalWeightGrams: 100,
  };

  async function createOrder(label) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-case-resolution-" + label + "-" + fixture,
      purpose: "product",
      status: "paid",
      customerName: "Case Resolution Test",
      customerEmail: ownerEmail,
      amountCents: 1200,
      merchandiseAmountCents: 1000,
      shippingAmountCents: 200,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "automated_shipping",
      paidAt: now,
    }).returning();
    orderIds.push(order.id);
    return order;
  }

  async function createCapture(order, label) {
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "paid",
      merchandiseAmountCents: 1000,
      shippingAmountCents: 200,
      taxAmountCents: 0,
      totalAmountCents: 1200,
      currency: "CAD",
      sourceWorkflow: "case_resolution_test",
      taxPolicyVersion: "tax-test",
      policyVersion: "policy-test",
      initializationStatus: "ready",
      idempotencyKey: "case-resolution/" + fixture + "/" + label,
      paidAt: now,
    }).returning();
    const [transaction] = await db.insert(orderPaymentTransactions).values({
      obligationId: obligation.id,
      provider: "helcim",
      providerTransactionId: "case-resolution-" + fixture + "-" + label,
      amountCents: 1200,
      currency: "CAD",
      providerType: "PURCHASE",
      providerStatus: "APPROVED",
      riskStatus: "cleared",
      capturedAt: now,
    }).returning();
    return transaction;
  }

  async function createRefundRemedy(label, refundStatus, adjustmentStatus, amountCents = 1200) {
    const order = await createOrder(label);
    const transaction = await createCapture(order, label);
    const [shippingCase] = await db.insert(productShippingCases).values({
      orderId: order.id,
      type: "loss",
      status: "remedy_pending",
      remedyChoice: "refund",
    }).returning();
    const componentAmounts = [
      ["merchandise", Math.min(amountCents, 1000)],
      ["outbound_shipping", Math.max(0, amountCents - 1000)],
    ].filter(([, componentAmount]) => componentAmount > 0);
    for (const [component, componentAmount] of componentAmounts) {
      const [adjustment] = await db.insert(productOrderAdjustments).values({
        orderId: order.id,
        direction: "refund",
        component,
        reason: "Case resolution invariant test",
        sourceCaseId: shippingCase.id,
        amountCents: componentAmount,
        status: adjustmentStatus,
        idempotencyKey: "case-resolution-adjustment/" + fixture + "/" + label + "/" + component,
      }).returning();
      await db.insert(productOrderRefunds).values({
        orderId: order.id,
        caseId: shippingCase.id,
        idempotencyKey: crypto.randomUUID(),
        kind: componentAmount === 1200 ? "full" : "partial",
        reason: "Case resolution invariant test",
        amountCents: componentAmount,
        originalTransactionId: transaction.providerTransactionId,
        paymentTransactionId: transaction.id,
        adjustmentId: adjustment.id,
        status: refundStatus,
        ...(refundStatus === "succeeded" ? { succeededAt: now } : {}),
        ...(refundStatus === "manual_review" ? { lastErrorCode: "OWNER_RECONCILIATION_REQUIRED" } : {}),
      });
    }
    return { order, shippingCase, transaction };
  }

  try {
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "case-resolution-owner-" + fixture,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    await db.insert(shippingPolicyAssignments).values([
      "business_owner",
      "operations_lead",
      "finance_owner",
      "payment_fraud_owner",
      "privacy_owner",
      "security_owner",
    ].map((duty) => ({ adminUserId: ownerId, duty, active: true })));

    const workflowOrder = await createOrder("type-workflows");
    const [workflowShipment] = await db.insert(productShipments).values({
      orderId: workflowOrder.id,
      sequence: 0,
      purpose: "original",
      publicReference: "case-resolution-workflow-" + fixture,
      quoteTokenHash: "case-resolution-workflow-token-" + fixture,
      quoteFingerprint: "case-resolution-workflow-fingerprint-" + fixture,
      status: "label_ready",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    shipmentIds.push(workflowShipment.id);
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: workflowShipment.id }).where(eq(checkoutOrders.id, workflowOrder.id));
    const [postageCase] = await db.insert(productShippingCases).values({
      orderId: workflowOrder.id,
      shipmentId: workflowShipment.id,
      sourceShipmentId: workflowShipment.id,
      type: "postage_failure",
      status: "open",
    }).returning();
    await assert.rejects(
      updateProductShippingCase({ caseId: postageCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
      /cannot resolve directly from its open state/,
    );
    await updateProductShippingCase({ caseId: postageCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "acknowledge" });
    await assert.rejects(
      updateProductShippingCase({ caseId: postageCase.id, actorAdminUserId: ownerId, expectedStateVersion: 2, action: "resolve" }),
      /before carrier handoff or a complete refund/,
    );
    await db.update(productShipments).set({ status: "accepted", acceptedAt: now, stateVersion: 2 }).where(eq(productShipments.id, workflowShipment.id));
    const resolvedPostage = await updateProductShippingCase({ caseId: postageCase.id, actorAdminUserId: ownerId, expectedStateVersion: 2, action: "resolve" });
    assert.equal(resolvedPostage.status, "resolved");

    const [returnCase] = await db.insert(productShippingCases).values({
      orderId: workflowOrder.id,
      shipmentId: workflowShipment.id,
      sourceShipmentId: workflowShipment.id,
      type: "unclaimed",
      status: "open",
    }).returning();
    await assert.rejects(
      updateProductShippingCase({ caseId: returnCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
      /before local inspection and cause are recorded/,
    );
    const inspectedReturn = await updateProductShippingCase({
      caseId: returnCase.id,
      actorAdminUserId: ownerId,
      expectedStateVersion: 1,
      action: "inspect",
      cause: "carrier",
    });
    assert.equal(inspectedReturn.evidenceChecklist.local_inspection, true);
    const resolvedReturn = await updateProductShippingCase({ caseId: returnCase.id, actorAdminUserId: ownerId, expectedStateVersion: 2, action: "resolve" });
    assert.equal(resolvedReturn.status, "resolved");

    const [preparingCase] = await db.insert(productShippingCases).values({
      orderId: workflowOrder.id,
      shipmentId: workflowShipment.id,
      sourceShipmentId: workflowShipment.id,
      type: "loss",
      status: "remedy_pending",
      remedyChoice: "replacement",
    }).returning();
    await db.insert(productShipmentJobs).values({
      shipmentId: workflowShipment.id,
      type: "replacement_prepare",
      status: "queued",
      idempotencyKey: "case-resolution-replacement-prepare/" + fixture,
      operationPayloadHash: "case-resolution-replacement-hash-" + fixture,
      payload: { caseId: preparingCase.id },
    });
    await assert.rejects(
      queueInventoryUnavailableRefund({ caseId: preparingCase.id, requestedByAdminUserId: ownerId }),
      /replacement preparation is active/,
    );

    const replacementOrder = await createOrder("replacement");
    const [source] = await db.insert(productShipments).values({
      orderId: replacementOrder.id,
      sequence: 0,
      purpose: "original",
      publicReference: "case-resolution-source-" + fixture,
      quoteTokenHash: "case-resolution-source-token-" + fixture,
      quoteFingerprint: "case-resolution-source-fingerprint-" + fixture,
      status: "delivered",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(now.getTime() + 60_000),
      acceptedAt: new Date(now.getTime() - 60_000),
      deliveredAt: now,
    }).returning();
    const [remedy] = await db.insert(productShipments).values({
      orderId: replacementOrder.id,
      sequence: 1,
      purpose: "replacement",
      supersedesShipmentId: source.id,
      publicReference: "case-resolution-remedy-" + fixture,
      quoteTokenHash: "case-resolution-remedy-token-" + fixture,
      quoteFingerprint: "case-resolution-remedy-fingerprint-" + fixture,
      status: "label_ready",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    shipmentIds.push(source.id, remedy.id);
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: source.id }).where(eq(checkoutOrders.id, replacementOrder.id));
    const [replacementCase] = await db.insert(productShippingCases).values({
      orderId: replacementOrder.id,
      shipmentId: source.id,
      sourceShipmentId: source.id,
      remedyShipmentId: remedy.id,
      type: "damage",
      status: "remedy_pending",
      remedyChoice: "replacement",
    }).returning();
    const adoptionRace = await Promise.allSettled([
      adoptReplacementShipment({
        caseId: replacementCase.id,
        actorAdminUserId: ownerId,
        expectedSourceStateVersion: source.stateVersion,
        expectedRemedyStateVersion: remedy.stateVersion,
        now,
      }),
      queueInventoryUnavailableRefund({
        caseId: replacementCase.id,
        requestedByAdminUserId: ownerId,
      }),
    ]);
    assert.equal(adoptionRace.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(adoptionRace.filter((result) => result.status === "rejected").length, 1);
    const [adoptedOrder] = await db.select({ activeShipmentId: checkoutOrders.activeFulfillmentShipmentId }).from(checkoutOrders).where(eq(checkoutOrders.id, replacementOrder.id));
    assert.equal(adoptedOrder.activeShipmentId, remedy.id);
    await assert.rejects(
      updateProductShippingCase({
        caseId: replacementCase.id,
        actorAdminUserId: ownerId,
        expectedStateVersion: 1,
        action: "resolve",
      }),
      /before the replacement reaches carrier handoff/,
    );
    await db.update(productShipments).set({
      status: "accepted",
      acceptedAt: now,
      stateVersion: 2,
    }).where(eq(productShipments.id, remedy.id));
    const replacementRace = await Promise.allSettled([
      updateProductShippingCase({ caseId: replacementCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
      updateProductShippingCase({ caseId: replacementCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
    ]);
    assert.equal(replacementRace.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(replacementRace.filter((result) => result.status === "rejected").length, 1);

    const pending = await createRefundRemedy("pending", "queued", "reserved");
    await assert.rejects(
      updateProductShippingCase({ caseId: pending.shippingCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
      /refund allocation is pending/,
    );

    const incomplete = await createRefundRemedy("incomplete", "succeeded", "succeeded", 1100);
    await db.update(checkoutOrders).set({ status: "refunded" }).where(eq(checkoutOrders.id, incomplete.order.id));
    await assert.rejects(
      updateProductShippingCase({ caseId: incomplete.shippingCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
      /every captured payment has a complete refund allocation/,
    );

    const mistyped = await createRefundRemedy("mistyped", "succeeded", "succeeded");
    await db.update(productOrderAdjustments).set({ component: "merchandise" }).where(eq(productOrderAdjustments.sourceCaseId, mistyped.shippingCase.id));
    await db.update(checkoutOrders).set({ status: "refunded" }).where(eq(checkoutOrders.id, mistyped.order.id));
    await assert.rejects(
      updateProductShippingCase({ caseId: mistyped.shippingCase.id, actorAdminUserId: ownerId, expectedStateVersion: 1, action: "resolve" }),
      /every captured payment has a complete refund allocation/,
    );

    const settled = await createRefundRemedy("settled", "succeeded", "succeeded");
    const settledResult = await updateProductShippingCase({
      caseId: settled.shippingCase.id,
      actorAdminUserId: ownerId,
      expectedStateVersion: 1,
      action: "resolve",
    });
    assert.equal(settledResult.status, "resolved");
    const [settledOrder] = await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, settled.order.id));
    assert.equal(settledOrder.status, "refunded");

    const priorPartial = await createRefundRemedy("prior-partial", "succeeded", "succeeded", 1000);
    const [priorAdjustment] = await db.insert(productOrderAdjustments).values({
      orderId: priorPartial.order.id,
      direction: "refund",
      component: "outbound_shipping",
      reason: "Earlier shipping decrease refund",
      amountCents: 200,
      status: "succeeded",
      idempotencyKey: "case-resolution-adjustment/" + fixture + "/prior-partial/existing",
    }).returning();
    await db.insert(productOrderRefunds).values({
      orderId: priorPartial.order.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "partial",
      reason: "Earlier shipping decrease refund",
      amountCents: 200,
      originalTransactionId: priorPartial.transaction.providerTransactionId,
      paymentTransactionId: priorPartial.transaction.id,
      adjustmentId: priorAdjustment.id,
      status: "succeeded",
      succeededAt: now,
    });
    const priorPartialResult = await updateProductShippingCase({
      caseId: priorPartial.shippingCase.id,
      actorAdminUserId: ownerId,
      expectedStateVersion: 1,
      action: "resolve",
    });
    assert.equal(priorPartialResult.status, "resolved");

    const manual = await createRefundRemedy("manual", "manual_review", "manual_review");
    await assert.rejects(
      updateProductShippingCase({
        caseId: manual.shippingCase.id,
        actorAdminUserId: ownerId,
        expectedStateVersion: 1,
        action: "resolve",
      }),
      /refund allocation is pending/,
    );
    await db.update(productOrderRefunds).set({
      manualReviewEvidenceReference: "owner-reconciliation-evidence",
      manualReviewRationale: "Owner accepted durable manual reconciliation ownership.",
      manualReviewByAdminUserId: ownerId,
      manualReviewStepUpAuthenticatedAt: now,
      manualReviewRecordedAt: now,
    }).where(eq(productOrderRefunds.caseId, manual.shippingCase.id));
    const manualTerminalResult = await updateProductShippingCase({
      caseId: manual.shippingCase.id,
      actorAdminUserId: ownerId,
      expectedStateVersion: 1,
      action: "resolve",
    });
    assert.equal(manualTerminalResult.status, "resolved");
    const [manualOrder] = await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, manual.order.id));
    assert.equal(manualOrder.status, "refunded");

    const mixed = await createRefundRemedy("mixed", "manual_review", "manual_review");
    await db.update(productOrderRefunds).set({
      manualReviewEvidenceReference: "owner-mixed-reconciliation-evidence",
      manualReviewRationale: "Owner accepted the remaining manual refund allocation.",
      manualReviewByAdminUserId: ownerId,
      manualReviewStepUpAuthenticatedAt: now,
      manualReviewRecordedAt: now,
    }).where(eq(productOrderRefunds.caseId, mixed.shippingCase.id));
    const mixedRows = await db.select({
      refundId: productOrderRefunds.id,
      adjustmentId: productOrderAdjustments.id,
      component: productOrderAdjustments.component,
    }).from(productOrderRefunds).innerJoin(productOrderAdjustments, eq(productOrderRefunds.adjustmentId, productOrderAdjustments.id)).where(eq(productOrderRefunds.caseId, mixed.shippingCase.id));
    const mixedSettled = mixedRows.find((row) => row.component === "merchandise");
    await db.update(productOrderRefunds).set({ status: "succeeded", succeededAt: now }).where(eq(productOrderRefunds.id, mixedSettled.refundId));
    await db.update(productOrderAdjustments).set({ status: "succeeded" }).where(eq(productOrderAdjustments.id, mixedSettled.adjustmentId));
    const mixedResult = await updateProductShippingCase({
      caseId: mixed.shippingCase.id,
      actorAdminUserId: ownerId,
      expectedStateVersion: 1,
      action: "resolve",
    });
    assert.equal(mixedResult.status, "resolved");
    const [mixedOrder] = await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, mixed.order.id));
    assert.equal(mixedOrder.status, "refunded");
  } finally {
    if (orderIds.length) {
      await db.delete(productOrderRefunds).where(inArray(productOrderRefunds.orderId, orderIds));
      await db.delete(productOrderAdjustments).where(inArray(productOrderAdjustments.orderId, orderIds));
      await db.delete(productShipmentJobs).where(inArray(productShipmentJobs.shipmentId, shipmentIds));
      await db.delete(productShippingCases).where(inArray(productShippingCases.orderId, orderIds));
      await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(inArray(checkoutOrders.id, orderIds));
    }
    if (shipmentIds.length) await db.delete(productShipments).where(inArray(productShipments.id, shipmentIds));
    if (orderIds.length) {
      const obligations = await db.select({ id: orderPaymentObligations.id }).from(orderPaymentObligations).where(inArray(orderPaymentObligations.orderId, orderIds));
      if (obligations.length) await db.delete(orderPaymentTransactions).where(inArray(orderPaymentTransactions.obligationId, obligations.map((row) => row.id)));
      await db.delete(orderPaymentObligations).where(inArray(orderPaymentObligations.orderId, orderIds));
      await db.delete(checkoutOrders).where(inArray(checkoutOrders.id, orderIds));
    }
    if (ownerId) {
      await db.delete(shippingPolicyAssignments).where(eq(shippingPolicyAssignments.adminUserId, ownerId));
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "case resolution requires replacement handoff or a fully covered settled/manual refund aggregate",
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
