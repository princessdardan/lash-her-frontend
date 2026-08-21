import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run payment risk-review DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    checkoutOrders,
    fulfillmentOwnerActions,
    productPaymentRiskIncidents,
  } from "./src/lib/private-db/schema.ts";
  import { recordProductOrderRiskReview } from "./src/lib/shipping/risk-review.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  let ownerId;
  let orderId;
  let incidentId;

  try {
    const ownerEmail = "risk-review-" + fixture + "@example.invalid";
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "risk-review-owner-" + fixture,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      displayName: "Risk Review Owner",
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    process.env.ADMIN_OWNER_EMAILS = ownerEmail;

    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-risk-review-" + fixture,
      purpose: "product",
      status: "paid",
      customerName: "Risk Review Test",
      customerEmail: "risk-review@example.invalid",
      amountCents: 3200,
      merchandiseAmountCents: 3000,
      shippingAmountCents: 200,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      paymentRiskStatus: "review_required",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    orderId = order.id;
    const [incident] = await db.insert(productPaymentRiskIncidents).values({
      orderId: order.id,
      incidentKey: "risk-review/" + fixture,
      status: "review_required",
      reasonCodes: ["avs_mismatch"],
      providerEvidence: { providerTransactionId: "risk-provider-" + fixture },
      policyVersion: "risk-policy-v1",
    }).returning({ id: productPaymentRiskIncidents.id });
    incidentId = incident.id;

    await assert.rejects(
      recordProductOrderRiskReview({
        orderReference: order.orderId,
        incidentId: incident.id,
        expectedIncidentStateVersion: 1,
        reviewerAdminUserId: owner.id,
        decision: "escalate",
        rationale: "short",
      }),
      /at least 10 characters/,
    );

    const attempts = await Promise.allSettled([
      recordProductOrderRiskReview({
        orderReference: order.orderId,
        incidentId: incident.id,
        expectedIncidentStateVersion: 1,
        reviewerAdminUserId: owner.id,
        decision: "escalate",
        rationale: "Provider evidence remains unresolved; escalate for review.",
      }),
      recordProductOrderRiskReview({
        orderReference: order.orderId,
        incidentId: incident.id,
        expectedIncidentStateVersion: 1,
        reviewerAdminUserId: owner.id,
        decision: "escalate",
        rationale: "Provider evidence remains unresolved; escalate for review.",
      }),
    ]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);

    const [stored] = await db.select().from(productPaymentRiskIncidents).where(
      eq(productPaymentRiskIncidents.id, incident.id),
    );
    assert.equal(stored.status, "review_required");
    assert.equal(stored.outcome, "escalated");
    assert.equal(stored.stateVersion, 2);
    const actions = await db.select().from(fulfillmentOwnerActions).where(
      eq(fulfillmentOwnerActions.targetId, incident.id),
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, "fraud_escalated");
  } finally {
    if (incidentId) {
      await db.delete(fulfillmentOwnerActions).where(
        eq(fulfillmentOwnerActions.targetId, incidentId),
      );
      await db.delete(productPaymentRiskIncidents).where(
        eq(productPaymentRiskIncidents.id, incidentId),
      );
    }
    if (orderId) await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "payment risk escalation is incident-scoped and fenced under concurrency",
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
