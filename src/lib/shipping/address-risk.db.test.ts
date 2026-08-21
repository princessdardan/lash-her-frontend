import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run address-risk concurrency tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { encryptCheckoutIp } from "./src/lib/commerce/checkout-pii.ts";
  import {
    adminUsers,
    checkoutOrders,
    fulfillmentOwnerActions,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAddressChangeRequests,
    productPaymentRiskIncidents,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import { approveAddressChange, recordAddressPhoneCallbackEvidence } from "./src/lib/shipping/address-changes.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.CHECKOUT_PII_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  let ownerId;
  let orderId;
  let shipmentId;
  let obligationId;
  let requestId;
  let targetIncidentId;
  let otherIncidentId;

  try {
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "address-risk-owner-" + fixture,
      email: "address-risk-" + fixture + "@example.invalid",
      emailNormalized: "address-risk-" + fixture + "@example.invalid",
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    process.env.ADMIN_OWNER_EMAILS = "address-risk-" + fixture + "@example.invalid";
    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-address-risk-" + fixture,
      purpose: "product",
      status: "paid",
      customerName: "Address Risk Test",
      customerEmail: "address-risk@example.invalid",
      amountCents: 5000,
      merchandiseAmountCents: 4500,
      shippingAmountCents: 500,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "review_required",
      shippingPolicyVersion: "address-risk-policy-v1",
      fulfillmentMode: "automated_shipping",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id });
    orderId = order.id;
    const [shipment] = await db.insert(productShipments).values({
      orderId,
      publicReference: "address-risk-shipment-" + fixture,
      quoteTokenHash: "address-risk-token-" + fixture,
      quoteFingerprint: "address-risk-fingerprint-" + fixture,
      status: "ready_for_staff",
      destination: { name: "Address Risk Test", email: "address-risk@example.invalid", phone: "+14165550101", line1: "1 Original St", city: "Toronto", province: "ON", postalCode: "M5V 1A1", country: "Canada", countryCode: "CA" },
      packageSnapshot: { profileId: "test", profileSlug: "test", packageType: "parcel", lengthCm: 10, widthCm: 10, heightCm: 10, tareWeightGrams: 10, totalWeightGrams: 100 },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).returning({ id: productShipments.id });
    shipmentId = shipment.id;
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: shipmentId }).where(eq(checkoutOrders.id, orderId));
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId,
      purpose: "primary",
      status: "paid",
      merchandiseAmountCents: 4500,
      shippingAmountCents: 500,
      taxAmountCents: 0,
      totalAmountCents: 5000,
      currency: "CAD",
      sourceWorkflow: "address_risk_test",
      taxPolicyVersion: "address-risk-tax-v1",
      policyVersion: "address-risk-policy-v1",
      initializationStatus: "ready",
      idempotencyKey: "address-risk/" + fixture,
      paidAt: new Date(),
    }).returning({ id: orderPaymentObligations.id });
    obligationId = obligation.id;
    // A settled Square capture: it carries a provider id/type/status and clears
    // risk, but Square never returns AVS/CVV codes, so those are null. The
    // high-risk approval gate must accept this authoritative provider evidence
    // WITHOUT card-verification codes. (Seeding a Helcim capture with avsCode/
    // cvvCode "M" masked the bug: the old gate demanded codes Square never
    // provides, so a Square order would have thrown "Authoritative provider
    // evidence is required".)
    await db.insert(orderPaymentTransactions).values({
      obligationId,
      provider: "square",
      providerTransactionId: "96" + fixture.replace(/-/g, "").slice(0, 10),
      amountCents: 5000,
      currency: "CAD",
      originatingIpCiphertext: encryptCheckoutIp("192.0.2.61"),
      providerType: "CARD",
      providerStatus: "COMPLETED",
      avsCode: null,
      cvvCode: null,
      riskStatus: "cleared",
      riskReasonCodes: [],
      capturedAt: new Date(),
    });
    const [targetIncident] = await db.insert(productPaymentRiskIncidents).values({
      orderId,
      incidentKey: "address-change-target/" + fixture,
      status: "review_required",
      reasonCodes: ["ADDRESS_COUNTRY_CHANGED"],
      providerEvidence: {},
      policyVersion: "address-risk-policy-v1",
    }).returning();
    targetIncidentId = targetIncident.id;
    const [otherIncident] = await db.insert(productPaymentRiskIncidents).values({
      orderId,
      incidentKey: "other-risk/" + fixture,
      status: "pending",
      reasonCodes: ["TRANSACTION_CONFLICT"],
      providerEvidence: {},
      policyVersion: "address-risk-policy-v1",
    }).returning();
    otherIncidentId = otherIncident.id;
    const originalAddress = { line1: "1 Original St", city: "Toronto", province: "ON", postalCode: "M5V 1A1", country: "Canada", countryCode: "CA", phone: "+14165550101" };
    const [request] = await db.insert(productOrderAddressChangeRequests).values({
      orderId,
      shipmentId,
      status: "risk_review",
      originalAddress,
      proposedAddress: { ...originalAddress, line1: "2 Changed St" },
      riskFlags: ["line1_changed"],
      riskIncidentId: targetIncident.id,
      tokenHash: "address-risk-request-" + fixture,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      submittedAt: new Date(),
      providerReconciliation: { responsibility: "customer" },
    }).returning({
      id: productOrderAddressChangeRequests.id,
      stateVersion: productOrderAddressChangeRequests.stateVersion,
    });
    requestId = request.id;
    const stepUp = new Date();
    await recordAddressPhoneCallbackEvidence({
      requestId,
      adminUserId: ownerId,
      expectedStateVersion: request.stateVersion,
      rationale: "Original-order phone callback completed and documented.",
      evidenceReference: "callback-evidence-" + fixture,
      stepUpAuthenticatedAt: stepUp,
    });
    const [afterCallback] = await db
      .select({ stateVersion: productOrderAddressChangeRequests.stateVersion })
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.id, requestId));
    const input = {
      requestId,
      adminUserId: ownerId,
      action: "fraud_clearance",
      expectedStateVersion: afterCallback.stateVersion,
      responsibility: "customer",
      rationale: "Authoritative evidence supports clearing this address incident.",
      stepUpAuthenticatedAt: stepUp,
    };
    const proposal = await approveAddressChange(input);
    assert.equal(proposal.complete, false);
    const [afterProposal] = await db
      .select({ stateVersion: productOrderAddressChangeRequests.stateVersion })
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.id, requestId));
    const executionInput = {
      ...input,
      expectedStateVersion: afterProposal.stateVersion,
    };
    await db.update(fulfillmentOwnerActions).set({
      coolingOffUntil: new Date(Date.now() - 1000),
    }).where(and(
      eq(fulfillmentOwnerActions.targetId, targetIncident.id),
      eq(fulfillmentOwnerActions.action, "fraud_clearance_proposed"),
    ));
    const competing = await Promise.allSettled([
      approveAddressChange(executionInput),
      approveAddressChange(executionInput),
    ]);
    assert.equal(
      competing.filter((entry) => entry.status === "fulfilled").length,
      1,
      competing
        .map((entry) =>
          entry.status === "rejected"
            ? entry.reason instanceof Error
              ? entry.reason.message
              : String(entry.reason)
            : "fulfilled",
        )
        .join(" | "),
    );
    assert.equal(competing.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal((await db.select({ status: productPaymentRiskIncidents.status }).from(productPaymentRiskIncidents).where(eq(productPaymentRiskIncidents.id, targetIncident.id)))[0].status, "cleared");
    assert.equal((await db.select({ status: productPaymentRiskIncidents.status }).from(productPaymentRiskIncidents).where(eq(productPaymentRiskIncidents.id, otherIncident.id)))[0].status, "pending");
    assert.equal((await db.select({ status: checkoutOrders.paymentRiskStatus }).from(checkoutOrders).where(eq(checkoutOrders.id, orderId)))[0].status, "review_required");
    const [afterExecution] = await db
      .select({ stateVersion: productOrderAddressChangeRequests.stateVersion })
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.id, requestId));
    await assert.rejects(
      approveAddressChange({
        ...input,
        expectedStateVersion: afterExecution.stateVersion,
      }),
      /not reviewable/,
    );
  } finally {
    if (requestId) {
      await db.delete(fulfillmentOwnerActions).where(eq(fulfillmentOwnerActions.targetId, requestId));
      await db.delete(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, requestId));
    }
    if (orderId) {
      const incidentIds = [targetIncidentId, otherIncidentId].filter(Boolean);
      if (incidentIds.length) {
        await db.delete(fulfillmentOwnerActions).where(
          inArray(fulfillmentOwnerActions.targetId, incidentIds),
        );
      }
      await db.delete(productPaymentRiskIncidents).where(eq(productPaymentRiskIncidents.orderId, orderId));
      await db.delete(orderPaymentTransactions).where(eq(orderPaymentTransactions.obligationId, obligationId));
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(eq(checkoutOrders.id, orderId));
      await db.delete(productShipments).where(eq(productShipments.orderId, orderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "address fraud clearance is fenced and cannot clear an overlapping risk incident",
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
