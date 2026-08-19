import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run address service-decision tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    productOrderAddressChangeRequests,
    productOrderCustomerDecisions,
    productShipmentJobs,
    productShipments,
    shippingCustomerLinkIssuances,
  } from "./src/lib/private-db/schema.ts";
  import {
    addressServiceSubstitutionDecisionTerms,
    exchangeCustomerDecisionToken,
    expirePendingCustomerDecisions,
    hashCustomerDecisionConditions,
    issueCustomerDecision,
    selectCustomerDecision,
  } from "./src/lib/shipping/customer-decisions.ts";
  import { processAddressReplaceOperation } from "./src/lib/shipping/address-changes.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SHIPPING_DECISION_TOKEN_SECRET = "address-service-decision-secret-at-least-32-bytes";
  const db = getPrivateDb();
  const prefix = "address-service-decision-" + crypto.randomUUID();
  const address = {
    name: "Address Decision",
    email: "address-decision@example.invalid",
    phone: "+14165550100",
    line1: "1 Test Street",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 1A1",
    country: "Canada",
    countryCode: "CA",
  };
  let orderId;
  const shipmentIds = [];
  try {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix,
      purpose: "product",
      status: "paid",
      customerName: address.name,
      customerEmail: address.email,
      amountCents: 10_000,
      merchandiseAmountCents: 9_000,
      shippingAmountCents: 1_000,
      currency: "CAD",
      lineItems: [],
      paymentRiskStatus: "cleared",
      fulfillmentMode: "automated_shipping",
      shippingAddress: address,
    }).returning();
    orderId = order.id;
    const [source] = await db.insert(productShipments).values({
      orderId,
      publicReference: prefix + "-source",
      quoteTokenHash: prefix + "-source-token",
      quoteFingerprint: prefix + "-source-fingerprint",
      status: "ready_for_staff",
      selectedPostageType: "original-service",
      destination: address,
      packageSnapshot: { profileId: "test", profileSlug: "test", packageType: "parcel", lengthCm: 10, widthCm: 10, heightCm: 10, tareWeightGrams: 10, totalWeightGrams: 100 },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).returning();
    shipmentIds.push(source.id);

    async function createAwaitingRequest(suffix) {
      const [prepared] = await db.insert(productShipments).values({
        orderId,
        sequence: shipmentIds.length,
        purpose: "reshipment",
        supersedesShipmentId: source.id,
        publicReference: prefix + "-prepared-" + suffix,
        quoteTokenHash: prefix + "-prepared-token-" + suffix,
        quoteFingerprint: prefix + "-prepared-fingerprint-" + suffix,
        status: "quoted",
        selectedPostageType: "substitute-service",
        selectedRateId: "rate-1",
        quotedShippingCents: 1_200,
        destination: { ...address, line1: "2 Test Street" },
        packageSnapshot: source.packageSnapshot,
        customsLines: [],
        rates: [],
        quoteExpiresAt: new Date(Date.now() + 30 * 60_000),
      }).returning();
      shipmentIds.push(prepared.id);
      const [request] = await db.insert(productOrderAddressChangeRequests).values({
        orderId,
        shipmentId: source.id,
        status: "approved",
        originalAddress: address,
        proposedAddress: { ...address, line1: "2 Test Street" },
        tokenHash: prefix + "-request-token-" + suffix,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        reconciliationState: "awaiting_service_substitution",
        expectedSourceShipmentId: source.id,
        expectedSourceShipmentStateVersion: source.stateVersion,
        preparedShipmentId: prepared.id,
        preparedShipmentStateVersion: prepared.stateVersion,
      }).returning();
      return { prepared, request };
    }

    async function issue(request, expiresAt) {
      const terms = addressServiceSubstitutionDecisionTerms({
        requestId: request.id,
        sourceShipmentId: source.id,
        originalPostageType: source.selectedPostageType,
        substitutePostageType: "substitute-service",
        substituteAmountCents: 1_200,
      });
      const decision = await issueCustomerDecision({
        orderReference: order.orderId,
        shipmentId: source.id,
        kind: "service_substitution",
        ...terms,
        allowedOutcomes: ["accept_substitute", "decline_substitute"],
        expiresAt,
      });
      await db.update(productOrderAddressChangeRequests)
        .set({ providerReconciliation: { substitutionDecisionId: decision.id } })
        .where(eq(productOrderAddressChangeRequests.id, request.id));
      return { decision, terms };
    }

    const accepted = await createAwaitingRequest("accepted");
    const acceptedIssue = await issue(accepted.request, new Date(Date.now() + 10 * 60_000));
    const acceptedSession = await exchangeCustomerDecisionToken(acceptedIssue.decision.token);
    assert.ok(acceptedSession);
    assert.equal(await selectCustomerDecision(
      acceptedSession,
      "accept_substitute",
      acceptedIssue.terms.scopeKey,
      hashCustomerDecisionConditions(acceptedIssue.terms.scopeKey, acceptedIssue.terms.proposedConditions),
    ), true);
    const [acceptedRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, accepted.request.id));
    assert.equal(acceptedRequest.reconciliationState, "decision_resume_queued");
    assert.equal(acceptedRequest.preparedShipmentId, accepted.prepared.id);
    const acceptedJobs = await db.select().from(productShipmentJobs).where(eq(productShipmentJobs.idempotencyKey, "address-decision-resume/" + acceptedIssue.decision.id));
    assert.equal(acceptedJobs.length, 1);
    assert.equal(acceptedJobs[0].type, "address_replace");
    assert.equal(acceptedJobs[0].payload.mode, "resume_service_substitution");
    const purchaseBeforeConsentConsumption = await db.select().from(productShipmentJobs).where(eq(productShipmentJobs.type, "purchase"));
    assert.equal(purchaseBeforeConsentConsumption.length, 0);
    await db.update(productShipments)
      .set({ quoteExpiresAt: new Date(Date.now() - 1) })
      .where(eq(productShipments.id, accepted.prepared.id));
    const expiredResume = await processAddressReplaceOperation({
      jobId: acceptedJobs[0].id,
      shipmentId: source.id,
      payload: acceptedJobs[0].payload,
      client: {},
      observedAt: new Date(),
      outcomeUnknown: false,
    });
    assert.equal(expiredResume.outcomeCode, "service_substitution_quote_expired");
    const [acceptedExpiredRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, accepted.request.id));
    const [acceptedExpiredPrepared] = await db.select().from(productShipments).where(eq(productShipments.id, accepted.prepared.id));
    assert.equal(acceptedExpiredRequest.reconciliationState, "service_substitution_expired");
    assert.equal(acceptedExpiredRequest.preparedShipmentId, null);
    assert.equal(acceptedExpiredPrepared.status, "abandoned");

    const declined = await createAwaitingRequest("declined");
    const declinedIssue = await issue(declined.request, new Date(Date.now() + 10 * 60_000));
    const declinedSession = await exchangeCustomerDecisionToken(declinedIssue.decision.token);
    assert.ok(declinedSession);
    assert.equal(await selectCustomerDecision(
      declinedSession,
      "decline_substitute",
      declinedIssue.terms.scopeKey,
      hashCustomerDecisionConditions(declinedIssue.terms.scopeKey, declinedIssue.terms.proposedConditions),
    ), true);
    const [declinedRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, declined.request.id));
    const [declinedPrepared] = await db.select().from(productShipments).where(eq(productShipments.id, declined.prepared.id));
    assert.equal(declinedRequest.reconciliationState, "service_substitution_declined");
    assert.equal(declinedRequest.preparedShipmentId, null);
    assert.equal(declinedPrepared.status, "abandoned");

    const expired = await createAwaitingRequest("expired");
    const expiry = new Date(Date.now() + 60_000);
    const expiredIssue = await issue(expired.request, expiry);
    await expirePendingCustomerDecisions(new Date(expiry.getTime() + 1));
    const [expiredRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, expired.request.id));
    const [expiredPrepared] = await db.select().from(productShipments).where(eq(productShipments.id, expired.prepared.id));
    const [expiredDecision] = await db.select().from(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.id, expiredIssue.decision.id));
    assert.equal(expiredDecision.status, "expired");
    assert.equal(expiredRequest.reconciliationState, "service_substitution_expired");
    assert.equal(expiredRequest.preparedShipmentId, null);
    assert.equal(expiredPrepared.status, "abandoned");
  } finally {
    if (orderId) {
      await db.delete(productShipmentJobs).where(inArray(productShipmentJobs.shipmentId, shipmentIds));
      await db.delete(shippingCustomerLinkIssuances).where(eq(shippingCustomerLinkIssuances.orderId, orderId));
      await db.delete(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.orderId, orderId));
      await db.delete(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.orderId, orderId));
      await db.delete(productShipments).where(inArray(productShipments.id, shipmentIds));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "address substitute acceptance resumes once while decline and expiry clean unpaid drafts",
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
