import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  checkoutOrders,
  fulfillmentOwnerActions,
  productOrderRiskReviews,
  productPaymentRiskIncidents,
} from "@/lib/private-db/schema";

const COOLING_OFF_MS = 15 * 60_000;

export async function recordProductOrderRiskReview(input: {
  orderReference: string;
  reviewerAdminUserId: string;
  decision: "clear_false_positive" | "escalate";
  rationale: string;
  stepUpAuthenticatedAt?: Date;
  providerEvidenceAvailable?: boolean;
  evidence?: Record<string, unknown>;
}): Promise<{ cleared: boolean; coolingOffUntil?: string }> {
  const rationale = input.rationale.trim().slice(0, 1_000);
  if (rationale.length < 10) {
    throw new Error(
      "A documented rationale of at least 10 characters is required",
    );
  }
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [reviewer] = await tx
      .select({ role: adminUsers.role })
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.id, input.reviewerAdminUserId),
          eq(adminUsers.status, "active"),
        ),
      )
      .limit(1);
    if (reviewer?.role !== "owner") {
      throw new Error("The Business Owner must perform this review");
    }
    const [row] = await tx
      .select({
        orderId: checkoutOrders.id,
        incident: productPaymentRiskIncidents,
      })
      .from(checkoutOrders)
      .innerJoin(
        productPaymentRiskIncidents,
        eq(productPaymentRiskIncidents.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(productPaymentRiskIncidents.status, "review_required"),
        ),
      )
      .orderBy(desc(productPaymentRiskIncidents.createdAt))
      .for("update")
      .limit(1);
    if (!row) throw new Error("No active payment-risk incident was found");

    const evidence = sanitizeEvidence(input.evidence);
    if (input.decision === "escalate") {
      await tx.insert(fulfillmentOwnerActions).values({
        targetType: "payment_risk_incident",
        targetId: row.incident.id,
        action: "fraud_escalated",
        adminUserId: input.reviewerAdminUserId,
        policyVersion: row.incident.policyVersion,
        rationale,
        evidence,
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt ?? now,
        coolingOffUntil: now,
        executedAt: now,
      });
      await tx
        .update(productPaymentRiskIncidents)
        .set({ outcome: "escalated", rationale, updatedAt: now })
        .where(eq(productPaymentRiskIncidents.id, row.incident.id));
      return { cleared: false };
    }

    if (!input.stepUpAuthenticatedAt) {
      throw new Error("Step-up authentication is required");
    }
    if (
      !input.providerEvidenceAvailable ||
      Object.keys(evidence).length === 0
    ) {
      throw new Error("Authoritative provider evidence is required");
    }
    const [proposal] = await tx
      .select()
      .from(fulfillmentOwnerActions)
      .where(
        and(
          eq(fulfillmentOwnerActions.targetType, "payment_risk_incident"),
          eq(fulfillmentOwnerActions.targetId, row.incident.id),
          eq(fulfillmentOwnerActions.action, "fraud_clearance_proposed"),
        ),
      )
      .orderBy(desc(fulfillmentOwnerActions.createdAt))
      .limit(1);
    if (!proposal) {
      const coolingOffUntil = new Date(now.getTime() + COOLING_OFF_MS);
      await tx.insert(fulfillmentOwnerActions).values({
        targetType: "payment_risk_incident",
        targetId: row.incident.id,
        action: "fraud_clearance_proposed",
        adminUserId: input.reviewerAdminUserId,
        policyVersion: row.incident.policyVersion,
        rationale,
        evidence,
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        coolingOffUntil,
      });
      await tx
        .update(productPaymentRiskIncidents)
        .set({
          ownerAdminUserId: input.reviewerAdminUserId,
          stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          coolingOffUntil,
          rationale,
          providerEvidence: evidence,
          updatedAt: now,
        })
        .where(eq(productPaymentRiskIncidents.id, row.incident.id));
      return { cleared: false, coolingOffUntil: coolingOffUntil.toISOString() };
    }
    if (proposal.coolingOffUntil > now) {
      return {
        cleared: false,
        coolingOffUntil: proposal.coolingOffUntil.toISOString(),
      };
    }
    const [execution] = await tx
      .select({ id: fulfillmentOwnerActions.id })
      .from(fulfillmentOwnerActions)
      .where(
        and(
          eq(fulfillmentOwnerActions.targetType, "payment_risk_incident"),
          eq(fulfillmentOwnerActions.targetId, row.incident.id),
          eq(fulfillmentOwnerActions.action, "fraud_clearance_executed"),
        ),
      )
      .limit(1);
    if (execution) return { cleared: true };

    await tx.insert(fulfillmentOwnerActions).values({
      targetType: "payment_risk_incident",
      targetId: row.incident.id,
      action: "fraud_clearance_executed",
      adminUserId: input.reviewerAdminUserId,
      policyVersion: row.incident.policyVersion,
      rationale,
      evidence,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      coolingOffUntil: proposal.coolingOffUntil,
      executedAt: now,
    });
    await tx.insert(productOrderRiskReviews).values({
      orderId: row.orderId,
      reviewerAdminUserId: input.reviewerAdminUserId,
      reviewerWasBusinessOwner: true,
      incidentId: row.incident.id,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      coolingOffUntil: proposal.coolingOffUntil,
      providerEvidenceAvailable: true,
      evidence,
      decision: "clear_false_positive",
      rationale,
    });
    await tx
      .update(productPaymentRiskIncidents)
      .set({
        status: "cleared",
        ownerAdminUserId: input.reviewerAdminUserId,
        reviewedAt: now,
        rationale,
        outcome: "cleared",
        providerEvidence: evidence,
        updatedAt: now,
      })
      .where(eq(productPaymentRiskIncidents.id, row.incident.id));
    await tx
      .update(checkoutOrders)
      .set({
        paymentRiskStatus: "cleared",
        paymentRiskAssessedAt: now,
        paymentRiskSource: "manual",
        fraudClassification: "low",
        fraudClearedAt: now,
        updatedAt: now,
      })
      .where(eq(checkoutOrders.id, row.orderId));
    return { cleared: true };
  });
}

function sanitizeEvidence(value: Record<string, unknown> | undefined) {
  const allowedKeys = new Set([
    "providerTransactionId",
    "providerStatus",
    "avsCode",
    "cvvCode",
    "evidenceReference",
  ]);
  return Object.fromEntries(
    Object.entries(value ?? {}).flatMap(([key, entry]) =>
      allowedKeys.has(key) &&
      (typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean")
        ? [[key, entry]]
        : [],
    ),
  );
}
