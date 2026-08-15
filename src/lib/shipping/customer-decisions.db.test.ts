import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run customer-decision concurrency tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, productOrderCustomerDecisions, productShipments, shippingCustomerLinkIssuances } from "./src/lib/private-db/schema.ts";
  import { exchangeCustomerDecisionToken, hashCustomerDecisionConditions, issueCustomerDecision, selectCustomerDecision } from "./src/lib/shipping/customer-decisions.ts";
  import { claimShippingCustomerLinkIssuance } from "./src/lib/shipping/customer-link-issuance.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SHIPPING_DECISION_TOKEN_SECRET = "customer-decision-db-test-secret-at-least-32-bytes";
  const db = getPrivateDb();
  let orderId;
  let shipmentId;
  try {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-customer-decision-" + crypto.randomUUID(),
      purpose: "product",
      status: "paid",
      customerName: "Decision Test",
      customerEmail: "decision@example.invalid",
      amountCents: 1000,
      merchandiseAmountCents: 1000,
      lineItems: [],
      paymentRiskStatus: "cleared",
    }).returning();
    orderId = order.id;
    const initialDeadline = new Date(Date.now() + 20 * 60_000);
    const waitUntil = new Date(Date.now() + 2 * 60 * 60_000);
    const [shipment] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: "decision-shipment-" + crypto.randomUUID(),
      quoteTokenHash: "decision-token-" + crypto.randomUUID(),
      quoteFingerprint: "decision-fingerprint-" + crypto.randomUUID(),
      destination: { name: "Decision Test", email: "decision@example.invalid", phone: "+14165550100", line1: "1 Test St", city: "Toronto", province: "ON", postalCode: "M5V 1A1", country: "Canada", countryCode: "CA" },
      packageSnapshot: { profileId: "test", profileSlug: "test", packageType: "parcel", lengthCm: 10, widthCm: 10, heightCm: 10, tareWeightGrams: 10, totalWeightGrams: 100 },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
      status: "ready_for_staff",
      autoRefundDeadlineAt: initialDeadline,
    }).returning();
    shipmentId = shipment.id;
    const issued = await issueCustomerDecision({
      orderReference: order.orderId,
      shipmentId: shipment.id,
      kind: "missed_handoff",
      scopeKey: "missed_handoff/" + shipment.id + "/" + initialDeadline.toISOString(),
      proposedConditions: { waitUntil: waitUntil.toISOString() },
      allowedOutcomes: ["refund", "wait"],
      expiresAt: initialDeadline,
    });
    const session = await exchangeCustomerDecisionToken(issued.token);
    assert.ok(session);
    const scopeKey = "missed_handoff/" + shipment.id + "/" + initialDeadline.toISOString();
    const conditionsHash = hashCustomerDecisionConditions(scopeKey, { waitUntil: waitUntil.toISOString() });
    const results = await Promise.all([
      selectCustomerDecision(session, "wait", scopeKey, conditionsHash),
      selectCustomerDecision(session, "wait", scopeKey, conditionsHash),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    const [updatedShipment] = await db.select().from(productShipments).where(eq(productShipments.id, shipment.id));
    assert.equal(updatedShipment.autoRefundDeadlineAt.toISOString(), waitUntil.toISOString());
    const [decision] = await db.select().from(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.id, issued.id));
    assert.ok(decision.consumedAt);
    assert.ok(decision.processedAt);
    await db.transaction(async (tx) => {
      await claimShippingCustomerLinkIssuance(tx, { orderId, kind: "address_change", targetId: "address/1", now: new Date() });
      await claimShippingCustomerLinkIssuance(tx, { orderId, kind: "supplemental_payment", targetId: "supplement/1", now: new Date() });
    });
    await assert.rejects(
      db.transaction((tx) => claimShippingCustomerLinkIssuance(tx, { orderId, kind: "address_change", targetId: "address/2", now: new Date() })),
      /issuance limit reached/,
    );
  } finally {
    if (orderId) {
      await db.delete(shippingCustomerLinkIssuances).where(eq(shippingCustomerLinkIssuances.orderId, orderId));
      await db.delete(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.orderId, orderId));
      if (shipmentId) await db.delete(productShipments).where(eq(productShipments.id, shipmentId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "concurrent wait selection consumes once and extends the exact shipment",
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
