import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run P-10 refund termination tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { encryptCheckoutIp } from "./src/lib/commerce/checkout-pii.ts";
  import { redactShippingPolicyPii } from "./src/lib/private-db/shipping-retention.ts";
  import {
    adminUsers,
    checkoutOrders,
    customerEmailOutbox,
    fulfillmentPolicyVersions,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
    productOrderTerminationWorkflows,
    productShipmentJobs,
    productShipments,
    shippingFundingReviews,
    shippingPolicyAssignments,
    shippingPolicySettings,
    shippingServicePolicies,
  } from "./src/lib/private-db/schema.ts";
  import { processProductOrderRefund } from "./src/lib/shipping/customer-refunds.ts";
  import { processClaimedShipmentOperation } from "./src/lib/shipping/operation-worker.ts";
  import { enforceP10Termination } from "./src/lib/shipping/policy-worker.ts";
  import { p10TerminationBlocksOrderInTransaction } from "./src/lib/shipping/p10-termination.ts";
  import {
    claimShipmentOperationJobs,
    enqueuePurchaseOperationForOrder,
  } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.CHECKOUT_PII_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  process.env.CHITCHATS_ACCESS_TOKEN = "p10-race-test-token";
  process.env.CHITCHATS_CLIENT_ID = "p10-race-test-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_QUOTE_SIGNING_SECRET = "p10-race-test-signing-secret-32-bytes";
  process.env.CHITCHATS_REGION = "ontario_manitoba";
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";

  const db = getPrivateDb();
  const fixtureId = crypto.randomUUID();
  const orderReference = "lh-p10-multi-" + fixtureId;
  const ownerProviderId = "p10-owner-" + fixtureId;
  const now = new Date("2032-08-15T16:00:00.000Z");
  let orderId;
  let shipmentId;
  let manualOrderId;
  let riskOrderId;
  let cancelledOrderId;
  let redactedOrderId;
  let unknownOrderId;
  let raceOrderId;
  let policyId;
  let servicePolicyId;
  let raceOperationId;
  const fundingReviewIds = [];

  async function cleanup() {
    if (raceOperationId) {
      await db.delete(customerEmailOutbox).where(
        like(customerEmailOutbox.providerIdempotencyKey, "shipping-p10-purchase-race/" + raceOperationId + "/%"),
      );
    }
    for (const cleanupOrderId of [orderId, manualOrderId, riskOrderId, cancelledOrderId, redactedOrderId, unknownOrderId, raceOrderId].filter(Boolean)) {
      const [termination] = await db.select({ id: productOrderTerminationWorkflows.id })
        .from(productOrderTerminationWorkflows)
        .where(eq(productOrderTerminationWorkflows.orderId, cleanupOrderId))
        .limit(1);
      await db.delete(customerEmailOutbox).where(
        like(customerEmailOutbox.providerIdempotencyKey, "shipping-p10/" + cleanupOrderId + "/%"),
      );
      await db.delete(customerEmailOutbox).where(eq(customerEmailOutbox.orderId, cleanupOrderId));
      if (termination) {
        await db.delete(customerEmailOutbox).where(
          like(customerEmailOutbox.providerIdempotencyKey, "%/" + termination.id + "%"),
        );
      }
      await db.delete(productOrderRefunds).where(eq(productOrderRefunds.orderId, cleanupOrderId));
      await db.delete(productOrderAdjustments).where(eq(productOrderAdjustments.orderId, cleanupOrderId));
      await db.delete(productOrderTerminationWorkflows).where(eq(productOrderTerminationWorkflows.orderId, cleanupOrderId));
      await db.execute(sql.raw(
        "DELETE FROM product_shipment_jobs WHERE shipment_id IN " +
        "(SELECT id FROM product_shipments WHERE order_id = '" + cleanupOrderId + "')",
      ));
      await db.execute(sql.raw(
        "DELETE FROM order_payment_transactions WHERE obligation_id IN " +
        "(SELECT id FROM order_payment_obligations WHERE order_id = '" + cleanupOrderId + "')",
      ));
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, cleanupOrderId));
      await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(eq(checkoutOrders.id, cleanupOrderId));
      await db.delete(productShipments).where(eq(productShipments.orderId, cleanupOrderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, cleanupOrderId));
    }
    if (servicePolicyId) await db.delete(shippingServicePolicies).where(eq(shippingServicePolicies.id, servicePolicyId));
    for (const fundingReviewId of fundingReviewIds.reverse()) {
      await db.delete(shippingFundingReviews).where(eq(shippingFundingReviews.id, fundingReviewId));
    }
    if (ownerProviderId) {
      const [owner] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.providerUserId, ownerProviderId)).limit(1);
      if (owner) await db.delete(shippingPolicyAssignments).where(eq(shippingPolicyAssignments.adminUserId, owner.id));
    }
    if (policyId) await db.delete(fulfillmentPolicyVersions).where(eq(fulfillmentPolicyVersions.id, policyId));
    await db.delete(adminUsers).where(eq(adminUsers.providerUserId, ownerProviderId));
  }

  function gateway(providerRefundId, originalTransactionId, amountCents) {
    return {
      createInvoice: async () => { throw new Error("unused"); },
      initializePay: async () => { throw new Error("unused"); },
      getCardTransaction: async () => { throw new Error("unused"); },
      refundPayment: async () => ({
        transactionId: providerRefundId,
        originalTransactionId,
        amount: (amountCents / 100).toFixed(2),
        currency: "CAD",
        status: "APPROVED",
        transactionType: "REFUND",
      }),
    };
  }

  async function seedAgedOrder(reference, providerTransactionId, overrides) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: reference,
      purpose: "product",
      status: "paid",
      customerName: "P10 Coverage Test",
      customerEmail: "p10-coverage@example.invalid",
      amountCents: 1000,
      merchandiseAmountCents: 1000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      helcimTransactionId: providerTransactionId,
      refundOriginIpCiphertext: encryptCheckoutIp("192.0.2.45"),
      paidAt: new Date(now.getTime() - 365 * 24 * 60 * 60_000),
      createdAt: new Date(now.getTime() - 366 * 24 * 60 * 60_000),
      ...overrides,
    }).returning({ id: checkoutOrders.id });
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "paid",
      merchandiseAmountCents: 1000,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      totalAmountCents: 1000,
      currency: "CAD",
      sourceWorkflow: "p10_coverage_test",
      taxPolicyVersion: "p10-tax-v1",
      policyVersion: "p10-policy-v1",
      initializationStatus: "ready",
      idempotencyKey: reference + "/primary",
      paidAt: new Date(now.getTime() - 365 * 24 * 60 * 60_000),
    }).returning({ id: orderPaymentObligations.id });
    await db.insert(orderPaymentTransactions).values({
      obligationId: obligation.id,
      provider: "helcim",
      providerTransactionId,
      amountCents: 1000,
      currency: "CAD",
      originatingIpCiphertext: encryptCheckoutIp("192.0.2.45"),
      providerType: "PURCHASE",
      providerStatus: "APPROVED",
      riskStatus: "cleared",
      riskReasonCodes: [],
      capturedAt: new Date(now.getTime() - 365 * 24 * 60 * 60_000),
    });
    return order.id;
  }

  try {
    await cleanup();
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: ownerProviderId,
      email: "p10-" + fixtureId + "@example.invalid",
      emailNormalized: "p10-" + fixtureId + "@example.invalid",
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id, email: adminUsers.email });
    process.env.ADMIN_OWNER_EMAILS = owner.email;
    await db.insert(shippingPolicyAssignments).values([
      "business_owner", "operations_lead", "finance_owner",
      "payment_fraud_owner", "privacy_owner", "security_owner",
    ].map((duty) => ({ duty, adminUserId: owner.id, assignedByAdminUserId: owner.id })));
    const [policy] = await db.insert(fulfillmentPolicyVersions).values({
      version: "p10-precap-test-" + fixtureId,
      status: "effective",
      ownerName: "Nataliea Lavoie",
      policySnapshot: {
        p10TerminationNoticeDays: 350,
        p10DefaultExecutionDays: 360,
        p10HardCapDays: 365,
      },
      privacyLegalAttestedAt: now,
      securityAttestedAt: now,
      operationsAttestedAt: now,
      attestationEvidenceReference: "test://p10-precap/" + fixtureId,
      attestedByAdminUserId: owner.id,
      effectiveAt: new Date(now.getTime() - 400 * 24 * 60 * 60_000),
    }).returning({ id: fulfillmentPolicyVersions.id });
    policyId = policy.id;
    await db.insert(shippingPolicySettings).values({ singletonKey: "default" })
      .onConflictDoNothing({ target: shippingPolicySettings.singletonKey });
    const encryptedIp = encryptCheckoutIp("192.0.2.44");
    const [order] = await db.insert(checkoutOrders).values({
      orderId: orderReference,
      purpose: "product",
      status: "paid",
      customerName: "P10 Test",
      customerEmail: "p10-customer@example.invalid",
      amountCents: 12500,
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2500,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      helcimTransactionId: "951001",
      refundOriginIpCiphertext: encryptedIp,
      paymentRiskStatus: "cleared",
      fulfillmentMode: "automated_shipping",
      paidAt: new Date(now.getTime() - 365 * 24 * 60 * 60_000),
      createdAt: new Date(now.getTime() - 361 * 24 * 60 * 60_000),
      piiRedactionDueAt: new Date(
        now.getTime() + 4 * 24 * 60 * 60_000,
      ),
    }).returning({ id: checkoutOrders.id });
    orderId = order.id;
    const [shipment] = await db.insert(productShipments).values({
      orderId,
      publicReference: "p10-shipment-" + fixtureId,
      quoteTokenHash: "p10-token-" + fixtureId,
      quoteFingerprint: "p10-fingerprint-" + fixtureId,
      status: "ready_for_staff",
      destination: {
        name: "P10 Test",
        address1: "1 Test Street",
        city: "Toronto",
        provinceCode: "ON",
        postalCode: "M5V 2T6",
        countryCode: "CA",
      },
      packageSnapshot: { profileId: "p10", lengthCm: 10, widthCm: 10, heightCm: 10, emptyWeightGrams: 10, maxWeightGrams: 1000, maxPackingUnits: 10 },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(now.getTime() + 60_000),
      createdAt: new Date(now.getTime() - 361 * 24 * 60 * 60_000),
      updatedAt: new Date(now.getTime() - 361 * 24 * 60 * 60_000),
      piiRedactionDueAt: new Date(now.getTime() + 4 * 24 * 60 * 60_000),
    }).returning({ id: productShipments.id });
    shipmentId = shipment.id;
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: shipmentId }).where(eq(checkoutOrders.id, orderId));

    const transactions = [];
    const captures = [
      { purpose: "primary", providerTransactionId: "951001", merchandiseAmountCents: 10000, shippingAmountCents: 0 },
      { purpose: "address_increase", providerTransactionId: "951002", merchandiseAmountCents: 0, shippingAmountCents: 2500 },
    ];
    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      const totalAmountCents = capture.merchandiseAmountCents + capture.shippingAmountCents;
      const [obligation] = await db.insert(orderPaymentObligations).values({
        orderId,
        purpose: capture.purpose,
        status: "paid",
        merchandiseAmountCents: capture.merchandiseAmountCents,
        shippingAmountCents: capture.shippingAmountCents,
        taxAmountCents: 0,
        totalAmountCents,
        currency: "CAD",
        sourceWorkflow: "p10_test",
        taxPolicyVersion: "p10-tax-v1",
        policyVersion: "p10-policy-v1",
        initializationStatus: "ready",
        idempotencyKey: orderReference + "/" + index,
        paidAt: new Date(now.getTime() - 365 * 24 * 60 * 60_000),
      }).returning({ id: orderPaymentObligations.id });
      const [transaction] = await db.insert(orderPaymentTransactions).values({
        obligationId: obligation.id,
        provider: "helcim",
        providerTransactionId: capture.providerTransactionId,
        amountCents: totalAmountCents,
        currency: "CAD",
        originatingIpCiphertext: encryptedIp,
        providerType: "PURCHASE",
        providerStatus: "APPROVED",
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: new Date(now.getTime() - 365 * 24 * 60 * 60_000),
      }).returning();
      transactions.push(transaction);
    }

    const noticeNow = new Date(now.getTime() - 11 * 24 * 60 * 60_000);
    await enforceP10Termination(noticeNow);
    assert.equal(
      await db.transaction((tx) =>
        p10TerminationBlocksOrderInTransaction(tx, orderId, noticeNow),
      ),
      false,
    );
    await Promise.all([enforceP10Termination(now), enforceP10Termination(now)]);
    const queued = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.orderId, orderId));
    assert.deepEqual(
      queued.map((row) => [row.paymentTransactionId, row.amountCents]).sort(),
      [[transactions[0].id, 10000], [transactions[1].id, 2500]].sort(),
    );
    assert.ok(queued.every((row) => row.status === "queued"));
    assert.equal((await db.select().from(productOrderTerminationWorkflows).where(eq(productOrderTerminationWorkflows.orderId, orderId))).length, 1);
    assert.equal((await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, orderId)))[0].status, "paid");
    assert.equal((await db.select({ status: productShipments.status }).from(productShipments).where(eq(productShipments.id, shipmentId)))[0].status, "ready_for_staff");
    assert.equal(
      await db.transaction((tx) => p10TerminationBlocksOrderInTransaction(tx, orderId, now)),
      true,
    );

    const first = queued.find((row) => row.paymentTransactionId === transactions[0].id);
    const second = queued.find((row) => row.paymentTransactionId === transactions[1].id);
    await processProductOrderRefund(first.id, gateway("995101", "951001", 10000));
    assert.equal((await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, orderId)))[0].status, "paid");
    assert.equal((await db.select({ status: productShipments.status }).from(productShipments).where(eq(productShipments.id, shipmentId)))[0].status, "ready_for_staff");

    await processProductOrderRefund(second.id, gateway("995102", "951002", 2500));
    assert.equal((await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, orderId)))[0].status, "refunded");
    await enforceP10Termination(now);
    assert.equal((await db.select({ status: productShipments.status }).from(productShipments).where(eq(productShipments.id, shipmentId)))[0].status, "abandoned");

    const racePostageType = "p10_race_" + fixtureId.replaceAll("-", "");
    process.env.CHITCHATS_TRACKED_POSTAGE_TYPES = racePostageType;
    const [servicePolicy] = await db.insert(shippingServicePolicies).values({
      postageType: racePostageType,
      destinationCountryCode: "CA",
      trackingRequired: true,
      insuranceLimitCents: 100000,
      signatureCapable: false,
      claimWaitingDays: 1,
      claimDeadlineDays: 30,
      reviewedAt: now,
      reviewedByAdminUserId: owner.id,
      reviewStepUpAuthenticatedAt: now,
      evidenceReference: "test://p10-race/service",
      reviewEvidenceHash: "a".repeat(64),
      reviewEvidenceVersion: "p10-race-v1",
      reviewAction: "approve_shipping_service_policy",
      enabled: true,
    }).returning({ id: shippingServicePolicies.id });
    servicePolicyId = servicePolicy.id;
    const [forecast] = await db.insert(shippingFundingReviews).values({
      kind: "thirty_day_review",
      status: "recorded",
      observedAt: now,
      validUntil: new Date(now.getTime() + 24 * 60 * 60_000),
    }).returning({ id: shippingFundingReviews.id });
    fundingReviewIds.push(forecast.id);
    const [funding] = await db.insert(shippingFundingReviews).values({
      kind: "balance_check",
      status: "recorded",
      balanceCents: 100000,
      calculatedTwoBusinessDaySpendCents: 1000,
      calculatedFiveBusinessDaySpendCents: 2000,
      forecastReviewId: forecast.id,
      externalEvidenceReference: "test://p10-race/funding",
      observedAt: now,
      validUntil: new Date(now.getTime() + 24 * 60 * 60_000),
    }).returning({ id: shippingFundingReviews.id });
    fundingReviewIds.push(funding.id);
    raceOrderId = await seedAgedOrder(
      "lh-p10-purchase-race-" + fixtureId,
      "951008",
      {
        paymentRiskStatus: "cleared",
        fulfillmentMode: "automated_shipping",
        atRiskValueCents: 1000,
      },
    );
    const shipDate = now.toISOString().slice(0, 10);
    const raceProviderId = "p10-provider-race-" + fixtureId;
    const racePackage = {
      profileId: "p10-race",
      profileSlug: "p10-race",
      packageType: "parcel",
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      tareWeightGrams: 10,
      totalWeightGrams: 100,
    };
    const [raceShipment] = await db.insert(productShipments).values({
      orderId: raceOrderId,
      publicReference: "p10-race-shipment-" + fixtureId,
      quoteTokenHash: "p10-race-token-" + fixtureId,
      quoteFingerprint: "p10-race-fingerprint-" + fixtureId,
      providerShipmentId: raceProviderId,
      providerStatus: "unpaid",
      selectedRateId: racePostageType,
      selectedPostageType: racePostageType,
      status: "ready_for_staff",
      destination: {
        name: "P10 Race Test",
        address1: "1 Test Street",
        city: "Toronto",
        provinceCode: "ON",
        postalCode: "M5V 2T6",
        country: "Canada",
        countryCode: "CA",
      },
      packageSnapshot: racePackage,
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      quoteExpiresAt: new Date(now.getTime() + 60 * 60_000),
      createdAt: new Date(now.getTime() - 361 * 24 * 60 * 60_000),
      updatedAt: new Date(now.getTime() - 361 * 24 * 60 * 60_000),
    }).returning();
    await db.update(checkoutOrders).set({
      activeFulfillmentShipmentId: raceShipment.id,
    }).where(eq(checkoutOrders.id, raceOrderId));
    const raceOperation = await enqueuePurchaseOperationForOrder({
      orderReference: "lh-p10-purchase-race-" + fixtureId,
      shipmentId: raceShipment.id,
      expectedStateVersion: raceShipment.stateVersion,
      idempotencyKey: "p10-race-purchase/" + fixtureId,
      payload: {
        measuredWeightGrams: 100,
        shipDate,
      },
      now,
    });
    assert.ok(raceOperation);
    raceOperationId = raceOperation.id;
    const [claimedRaceOperation] = (await claimShipmentOperationJobs({
      workerId: "p10-race-worker",
      types: ["purchase"],
      now,
    })).filter((candidate) => candidate.id === raceOperation.id);
    assert.ok(claimedRaceOperation);
    const quotedProviderShipment = {
      id: raceProviderId,
      order_id: raceShipment.publicReference,
      status: "unpaid",
      package_type: racePackage.packageType,
      weight_unit: "g",
      weight: "100",
      size_unit: "cm",
      size_x: 10,
      size_y: 10,
      size_z: 10,
      signature_requested: false,
      ship_date: shipDate,
      rates: [{
        postage_type: racePostageType,
        postage_description: "P10 race tracked",
        tracking_type_description: "Tracking included",
        is_insured: true,
        payment_amount: "2.00",
        insurance_fee: "0.00",
      }],
    };
    let releaseProviderPurchase;
    const providerPurchaseReleased = new Promise((resolve) => {
      releaseProviderPurchase = resolve;
    });
    let markProviderPurchaseStarted;
    const providerPurchaseStarted = new Promise((resolve) => {
      markProviderPurchaseStarted = resolve;
    });
    const workerPromise = processClaimedShipmentOperation(
      claimedRaceOperation,
      {
        workerId: "p10-race-worker",
        now: () => now,
        assertQuoteContextCurrent: async () => undefined,
        client: {
          createShipment: async () => { throw new Error("unused"); },
          findShipments: async () => [],
          getShipment: async () => quotedProviderShipment,
          refreshShipment: async () => quotedProviderShipment,
          buyShipment: async () => {
            markProviderPurchaseStarted();
            await providerPurchaseReleased;
            return {
              ...quotedProviderShipment,
              status: "ready",
              purchase_amount: "2.00",
              postage_fee: "2.00",
              postage_purchase_date: new Date(now.getTime() - 1_000).toISOString(),
              postage_label_pdf_url: "https://example.invalid/signed-label?token=secret",
            };
          },
          deleteShipment: async () => undefined,
          refundShipment: async () => { throw new Error("unused"); },
          listReturns: async () => [],
        },
      },
    );
    let purchaseStartTimeout;
    try {
      await Promise.race([
        providerPurchaseStarted,
        new Promise((_, reject) => {
          purchaseStartTimeout = setTimeout(
            () => reject(new Error("purchase worker did not reach the provider call")),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(purchaseStartTimeout);
    }
    await enforceP10Termination(now);
    releaseProviderPurchase();
    assert.equal(await workerPromise, "fenced");
    const [raceShipmentAfter, racePurchaseAfter] = await Promise.all([
      db.query.productShipments.findFirst({
        where: eq(productShipments.id, raceShipment.id),
      }),
      db.query.productShipmentJobs.findFirst({
        where: eq(productShipmentJobs.id, raceOperation.id),
      }),
    ]);
    assert.equal(raceShipmentAfter.status, "refund_pending");
    assert.equal(raceShipmentAfter.actualPurchaseTotalCents, 200);
    assert.equal(raceShipmentAfter.actualPostageCents, 200);
    assert.equal(raceShipmentAfter.purchasedAt?.toISOString(), new Date(now.getTime() - 1_000).toISOString());
    assert.equal("postage_label_pdf_url" in raceShipmentAfter.rawShipment, false);
    assert.equal(racePurchaseAfter.status, "succeeded");
    assert.equal(racePurchaseAfter.outcomeCode, "p10_purchase_settled_refund_queued");
    assert.equal(racePurchaseAfter.fundingReservationStatus, "settled");
    assert.equal(racePurchaseAfter.reservedFundingCents, 200);
    const racePostageRefunds = await db.select().from(productShipmentJobs)
      .where(eq(productShipmentJobs.idempotencyKey, "p10-postage-refund/" + raceOperation.id));
    assert.equal(racePostageRefunds.length, 1);
    assert.equal(racePostageRefunds[0].type, "refund");
    assert.equal(racePostageRefunds[0].status, "queued");

    manualOrderId = await seedAgedOrder(
      "lh-p10-manual-" + fixtureId,
      "951003",
      {
        paymentRiskStatus: "cleared",
        fulfillmentMode: "manual_pickup",
        manualFulfillmentStatus: "paid_pending_dispatch",
      },
    );
    riskOrderId = await seedAgedOrder(
      "lh-p10-risk-" + fixtureId,
      "951004",
      {
        paymentRiskStatus: "review_required",
        fulfillmentMode: "automated_shipping",
      },
    );
    await enforceP10Termination(now);
    assert.equal((await db.select().from(productOrderRefunds).where(eq(productOrderRefunds.orderId, manualOrderId))).length, 1);
    assert.equal((await db.select().from(productOrderRefunds).where(eq(productOrderRefunds.orderId, riskOrderId))).length, 1);
    assert.equal((await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, manualOrderId)))[0].status, "paid");
    assert.equal((await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, riskOrderId)))[0].status, "paid");

    cancelledOrderId = await seedAgedOrder(
      "lh-p10-cancelled-capture-" + fixtureId,
      "951005",
      {
        status: "cancelled",
        paymentRiskStatus: "not_required",
        fulfillmentMode: "manual_pickup",
        manualFulfillmentStatus: "paid_pending_dispatch",
      },
    );
    redactedOrderId = await seedAgedOrder(
      "lh-p10-redacted-before-worker-" + fixtureId,
      "951006",
      {
        paymentRiskStatus: "review_required",
        fulfillmentMode: "manual_pickup",
        manualFulfillmentStatus: "paid_pending_dispatch",
      },
    );
    unknownOrderId = await seedAgedOrder(
      "lh-p10-unknown-outcome-" + fixtureId,
      "951007",
      {
        paymentRiskStatus: "review_required",
        fulfillmentMode: "manual_pickup",
        manualFulfillmentStatus: "paid_pending_dispatch",
      },
    );

    await enforceP10Termination(now);
    assert.equal((await db.select().from(productOrderRefunds).where(eq(productOrderRefunds.orderId, cancelledOrderId))).length, 1);
    const [redactedRefund] = await db.select().from(productOrderRefunds).where(eq(productOrderRefunds.orderId, redactedOrderId));
    const [unknownRefund] = await db.select().from(productOrderRefunds).where(eq(productOrderRefunds.orderId, unknownOrderId));
    assert.ok(redactedRefund);
    assert.ok(unknownRefund);
    const unknownResult = await processProductOrderRefund(unknownRefund.id, {
      ...gateway("995107", "951007", 1000),
      refundPayment: async () => {
        throw new Error("simulated ambiguous provider transport failure");
      },
    });
    assert.equal(unknownResult.status, "outcome_unknown");
    await enforceP10Termination(now);
    assert.equal(
      (await db.select({ status: productOrderTerminationWorkflows.status })
        .from(productOrderTerminationWorkflows)
        .where(eq(productOrderTerminationWorkflows.orderId, unknownOrderId)))[0].status,
      "outcome_unknown",
    );
    await redactShippingPolicyPii(now);
    let providerCalled = false;
    const redactedResult = await processProductOrderRefund(redactedRefund.id, {
      ...gateway("995106", "951006", 1000),
      refundPayment: async () => {
        providerCalled = true;
        throw new Error("must not call provider without original IP");
      },
    });
    assert.equal(providerCalled, false);
    assert.equal(redactedResult.status, "manual_review");
    await enforceP10Termination(now);
    const [redactedWorkflow] = await db.select().from(productOrderTerminationWorkflows)
      .where(eq(productOrderTerminationWorkflows.orderId, redactedOrderId));
    assert.equal(redactedWorkflow.status, "manual_review");
    assert.ok(redactedWorkflow.operationallyTerminatedAt);
    assert.ok((await db.select({ redactedAt: checkoutOrders.redactedAt }).from(checkoutOrders).where(eq(checkoutOrders.id, redactedOrderId)))[0].redactedAt);
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "P-10 reserves every capture and terminalizes only after the full ledger settles",
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
