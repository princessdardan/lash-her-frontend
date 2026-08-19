import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run address signature-decision tests";

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
    addressSignatureDecisionTerms,
    exchangeCustomerDecisionToken,
    expirePendingCustomerDecisions,
    hashCustomerDecisionConditions,
    issueCustomerDecision,
    revokeCustomerDecisions,
    selectCustomerDecision,
  } from "./src/lib/shipping/customer-decisions.ts";
  import { reconcileAddressChangePostage } from "./src/lib/shipping/address-changes.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SHIPPING_DECISION_TOKEN_SECRET = "address-signature-decision-secret-at-least-32-bytes";
  const db = getPrivateDb();
  const prefix = "address-signature-decision-" + crypto.randomUUID();
  const address = {
    name: "Signature Decision",
    email: "signature-decision@example.invalid",
    phone: "+14165550100",
    line1: "1 Test Street",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 1A1",
    country: "Canada",
    countryCode: "CA",
  };
  let orderId;
  let sourceId;
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
      destination: address,
      packageSnapshot: { profileId: "test", profileSlug: "test", packageType: "parcel", lengthCm: 10, widthCm: 10, heightCm: 10, tareWeightGrams: 10, totalWeightGrams: 100 },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
    }).returning();
    sourceId = source.id;
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: source.id }).where(eq(checkoutOrders.id, order.id));

    async function createAwaiting(suffix) {
      const [request] = await db.insert(productOrderAddressChangeRequests).values({
        orderId,
        shipmentId: source.id,
        status: "approved",
        originalAddress: address,
        proposedAddress: { ...address, line1: "2 Test Street" },
        tokenHash: prefix + "-request-token-" + suffix,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        reconciliationState: "awaiting_signature",
        expectedSourceShipmentId: source.id,
        expectedSourceShipmentStateVersion: source.stateVersion,
      }).returning();
      const terms = addressSignatureDecisionTerms({ requestId: request.id, sourceShipmentId: source.id });
      const decision = await issueCustomerDecision({
        orderReference: order.orderId,
        shipmentId: source.id,
        kind: "signature_requirement",
        ...terms,
        allowedOutcomes: ["accept_signature", "decline_signature"],
        expiresAt: new Date(Date.now() + 60_000),
      });
      await db.update(productOrderAddressChangeRequests)
        .set({ providerReconciliation: { signatureDecisionId: decision.id } })
        .where(eq(productOrderAddressChangeRequests.id, request.id));
      return { decision, request, terms };
    }

    const expiring = await createAwaiting("expired");
    await expirePendingCustomerDecisions(new Date(Date.now() + 61_000));
    const [expiredRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, expiring.request.id));
    assert.equal(expiredRequest.reconciliationState, "signature_expired");
    assert.equal(expiredRequest.providerReconciliation.signatureDecisionId, undefined);
    const reissue = await reconcileAddressChangePostage(expiring.request.id, expiredRequest.stateVersion);
    assert.ok(reissue.operationId);
    const [reissueRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, expiring.request.id));
    assert.equal(reissueRequest.reconciliationState, "queued");
    const repeatedReissue = await reconcileAddressChangePostage(
      expiring.request.id,
      reissueRequest.stateVersion,
    );
    assert.equal(repeatedReissue.operationId, reissue.operationId);

    const revoked = await createAwaiting("revoked");
    assert.equal(await revokeCustomerDecisions({ orderReference: order.orderId, kind: "signature_requirement" }), 1);
    const [revokedRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, revoked.request.id));
    assert.equal(revokedRequest.reconciliationState, "signature_revoked");
    assert.equal(revokedRequest.providerReconciliation.signatureDecisionId, undefined);

    const declined = await createAwaiting("declined");
    const session = await exchangeCustomerDecisionToken(declined.decision.token);
    assert.ok(session);
    assert.equal(await selectCustomerDecision(
      session,
      "decline_signature",
      declined.terms.scopeKey,
      hashCustomerDecisionConditions(declined.terms.scopeKey, declined.terms.proposedConditions),
    ), true);
    const [declinedRequest] = await db.select().from(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.id, declined.request.id));
    assert.equal(declinedRequest.reconciliationState, "signature_declined");
    assert.equal(declinedRequest.providerReconciliation.signatureDecisionId, undefined);
  } finally {
    if (orderId) {
      if (sourceId) await db.delete(productShipmentJobs).where(eq(productShipmentJobs.shipmentId, sourceId));
      await db.delete(shippingCustomerLinkIssuances).where(eq(shippingCustomerLinkIssuances.orderId, orderId));
      await db.delete(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.orderId, orderId));
      await db.delete(productOrderAddressChangeRequests).where(eq(productOrderAddressChangeRequests.orderId, orderId));
      if (sourceId) await db.delete(productShipments).where(inArray(productShipments.id, [sourceId]));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "signature decline, expiry, and revocation are recoverable without provider mutation",
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
