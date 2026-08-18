import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run address payment revocation tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    adminUsers,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderAddressChangeRequests,
    productOrderRefunds,
    productPaymentRiskIncidents,
    productShipmentJobs,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import { issueAddressChange, revokeAddressChanges } from "./src/lib/shipping/address-changes.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const prefix = "lh-address-payment-revoke-";
  const address = {
    name: "Address Test",
    email: "address-test@example.invalid",
    phone: "+14165550100",
    line1: "100 Test Street",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 1A1",
    country: "Canada",
    countryCode: "CA",
  };

  async function cleanup() {
    await db.execute(sql.raw(
      "DELETE FROM product_shipment_jobs WHERE shipment_id IN " +
      "(SELECT id FROM product_shipments WHERE public_reference LIKE 'lh-address-payment-revoke-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_order_refunds WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-address-payment-revoke-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_order_adjustments WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-address-payment-revoke-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_order_address_change_requests WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-address-payment-revoke-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM product_payment_risk_incidents WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-address-payment-revoke-%')",
    ));
    await db.execute(sql.raw(
      "DELETE FROM order_payment_transactions WHERE obligation_id IN " +
      "(SELECT id FROM order_payment_obligations WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-address-payment-revoke-%'))",
    ));
    await db.execute(sql.raw(
      "DELETE FROM order_payment_obligations WHERE order_id IN " +
      "(SELECT id FROM checkout_orders WHERE order_id LIKE 'lh-address-payment-revoke-%')",
    ));
    await db.delete(productShipments).where(like(productShipments.publicReference, prefix + "%"));
    await db.delete(checkoutOrders).where(like(checkoutOrders.orderId, prefix + "%"));
  }

  try {
    await cleanup();
    const ownerEmail = "address-revoke-owner@example.invalid";
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "address-revoke-owner",
      email: ownerEmail,
      emailNormalized: ownerEmail,
      role: "owner",
      status: "active",
    }).onConflictDoUpdate({
      target: adminUsers.providerUserId,
      set: { status: "active" },
    }).returning({ id: adminUsers.id });
    process.env.ADMIN_OWNER_EMAILS = ownerEmail;
    const orderReference = prefix + "order";
    const [order] = await db.insert(checkoutOrders).values({
      orderId: orderReference,
      purpose: "product",
      status: "paid",
      paidAt: new Date(),
      customerName: address.name,
      customerEmail: address.email,
      amountCents: 10_000,
      merchandiseAmountCents: 9_000,
      shippingAmountCents: 1_000,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "automated_shipping",
      shippingAddress: address,
    }).returning();
    const [prepared] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: prefix + "prepared",
      quoteTokenHash: prefix + "token",
      quoteFingerprint: prefix + "fingerprint",
      status: "label_ready",
      purchasedAt: new Date(),
      actualPurchaseTotalCents: 1_700,
      destination: address,
      packageSnapshot: {
        profileId: "profile",
        profileSlug: "profile",
        packageType: "parcel",
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        tareWeightGrams: 10,
        totalWeightGrams: 100,
      },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).returning();
    const [request] = await db.insert(productOrderAddressChangeRequests).values({
      orderId: order.id,
      status: "approved",
      originalAddress: address,
      proposedAddress: { ...address, line1: "200 Test Street" },
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      preparedShipmentId: prepared.id,
      preparedShipmentStateVersion: prepared.stateVersion,
      adoptionOutcome: "prepared",
    }).returning();
    const [pendingObligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "address_increase",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 500,
      taxAmountCents: 0,
      totalAmountCents: 500,
      currency: "CAD",
      sourceWorkflow: "address_change/" + request.id,
      sourceReferenceId: request.id,
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      initializationStatus: "ready",
      idempotencyKey: "address-increase/" + request.id,
    }).returning();

    const [capturedObligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "address_increase",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 700,
      taxAmountCents: 0,
      totalAmountCents: 700,
      currency: "CAD",
      sourceWorkflow: "address_change/" + request.id,
      sourceReferenceId: request.id,
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      initializationStatus: "ready",
      idempotencyKey: "address-increase-captured/" + request.id,
    }).returning();
    const [primaryObligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "paid",
      merchandiseAmountCents: 9_000,
      shippingAmountCents: 1_000,
      taxAmountCents: 0,
      totalAmountCents: 10_000,
      currency: "CAD",
      sourceWorkflow: "checkout",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      initializationStatus: "ready",
      idempotencyKey: "primary/" + request.id,
      paidAt: new Date(),
    }).returning();
    await db.insert(orderPaymentTransactions).values({
      obligationId: primaryObligation.id,
      provider: "helcim",
      providerTransactionId: "address-revoke-primary-" + request.id,
      amountCents: 10_000,
      currency: "CAD",
      providerType: "PURCHASE",
      providerStatus: "APPROVED",
      riskStatus: "review_required",
      riskReasonCodes: ["AVS_UNKNOWN"],
      capturedAt: new Date(),
    });
    const [requestIncident] = await db.insert(productPaymentRiskIncidents).values({
      orderId: order.id,
      incidentKey: "address-change/" + request.id,
      status: "review_required",
      reasonCodes: ["ADDRESS_LINE1_CHANGED"],
      policyVersion: "test-policy-v1",
      alertedAt: new Date(),
    }).returning();
    await db.update(productOrderAddressChangeRequests)
      .set({ riskIncidentId: requestIncident.id })
      .where(eq(productOrderAddressChangeRequests.id, request.id));

    let releaseCapture;
    let captureLocked;
    const captureLockedPromise = new Promise((resolve) => { captureLocked = resolve; });
    const releaseCapturePromise = new Promise((resolve) => { releaseCapture = resolve; });
    const capture = db.transaction(async (tx) => {
      await tx.select({ id: checkoutOrders.id }).from(checkoutOrders)
        .where(eq(checkoutOrders.id, order.id)).for("update");
      await tx.update(orderPaymentObligations).set({
        status: "paid",
        paidAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(orderPaymentObligations.id, capturedObligation.id));
      await tx.insert(orderPaymentTransactions).values({
        obligationId: capturedObligation.id,
        provider: "helcim",
        providerTransactionId: "address-revoke-capture-" + request.id,
        amountCents: 700,
        currency: "CAD",
        providerType: "PURCHASE",
        providerStatus: "APPROVED",
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: new Date(),
      });
      captureLocked();
      await releaseCapturePromise;
    });
    await captureLockedPromise;
    const revokeInput = {
      orderReference,
      requestId: request.id,
      expectedStateVersion: request.stateVersion,
      requestedByAdminUserId: owner.id,
      rationale: "Owner reviewed the paid address supplement revocation.",
      evidenceReference: "address-revoke-evidence",
      stepUpAuthenticatedAt: new Date(),
    };
    const reissue = issueAddressChange({ orderReference });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseCapture();
    await capture;
    await assert.rejects(
      reissue,
      /paid address supplement requires explicit owner-authorized revocation/,
    );

    const results = await Promise.all([
      revokeAddressChanges(revokeInput),
      revokeAddressChanges(revokeInput),
    ]);
    assert.equal(results.reduce((sum, count) => sum + count, 0), 1);
    const [requestAfter] = await db.select().from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.id, request.id));
    const [pendingAfter] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, pendingObligation.id));
    const [capturedAfter] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, capturedObligation.id));
    const refunds = await db.select().from(productOrderRefunds)
      .where(eq(productOrderRefunds.orderId, order.id));
    const adjustments = await db.select().from(productOrderAdjustments)
      .where(eq(productOrderAdjustments.orderId, order.id));
    const [requestIncidentAfter] = await db.select().from(productPaymentRiskIncidents)
      .where(eq(productPaymentRiskIncidents.id, requestIncident.id));
    const [orderAfter] = await db.select().from(checkoutOrders)
      .where(eq(checkoutOrders.id, order.id));
    const cleanupJobs = await db.select().from(productShipmentJobs)
      .where(eq(productShipmentJobs.shipmentId, prepared.id));
    assert.equal(requestAfter.status, "revoked");
    assert.equal(requestAfter.cleanupOutcome, "queued");
    assert.equal(pendingAfter.status, "superseded");
    assert.equal(capturedAfter.status, "paid");
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amountCents, 700);
    assert.equal(adjustments.length, 1);
    assert.equal(refunds[0].adjustmentId, adjustments[0].id);
    assert.equal(adjustments[0].component, "outbound_shipping");
    assert.equal(adjustments[0].status, "reserved");
    assert.equal(adjustments[0].sourceAddressRequestId, request.id);
    assert.equal(requestIncidentAfter.status, "not_required");
    assert.equal(requestIncidentAfter.outcome, "address_change_revoked");
    assert.equal(orderAfter.paymentRiskStatus, "review_required");
    assert.deepEqual(orderAfter.fraudRiskReasons, ["AUTHORITATIVE_PAYMENT_RISK_UNAVAILABLE"]);
    assert.equal(cleanupJobs.length, 1);
    assert.equal(cleanupJobs[0].type, "refund");
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "address revocation serializes with capture, reserves its refund, and closes scoped risk",
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
