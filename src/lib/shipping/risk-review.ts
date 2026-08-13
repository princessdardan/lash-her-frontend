import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  checkoutOrders,
  productOrderRiskReviews,
  shippingPolicyAssignments,
} from "@/lib/private-db/schema";

export async function recordProductOrderRiskReview(input: {
  orderReference: string;
  reviewerAdminUserId: string;
  decision: "clear_false_positive" | "escalate";
  rationale: string;
}): Promise<{ cleared: boolean }> {
  if (input.rationale.trim().length < 10)
    throw new Error(
      "A documented rationale of at least 10 characters is required",
    );
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
    if (!reviewer) throw new Error("Reviewer is not active");
    if (reviewer.role !== "owner") {
      const [assignment] = await tx
        .select({ id: shippingPolicyAssignments.id })
        .from(shippingPolicyAssignments)
        .where(
          and(
            eq(
              shippingPolicyAssignments.adminUserId,
              input.reviewerAdminUserId,
            ),
            eq(shippingPolicyAssignments.duty, "payment_fraud_owner"),
            eq(shippingPolicyAssignments.active, true),
          ),
        )
        .limit(1);
      if (!assignment)
        throw new Error("Reviewer is not assigned to Payment/Fraud");
    }
    const [order] = await tx
      .select({ id: checkoutOrders.id })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.orderId, input.orderReference))
      .for("update")
      .limit(1);
    if (!order) throw new Error("Order was not found");
    if (input.decision === "escalate") {
      await tx
        .update(checkoutOrders)
        .set({
          fraudClassification: "high",
          fraudClearedAt: null,
          fraudRiskReasons: sql`${checkoutOrders.fraudRiskReasons} || '["staff_escalation"]'::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(checkoutOrders.id, order.id));
    }
    await tx
      .insert(productOrderRiskReviews)
      .values({
        orderId: order.id,
        reviewerAdminUserId: input.reviewerAdminUserId,
        reviewerWasBusinessOwner: reviewer.role === "owner",
        decision: input.decision,
        rationale: input.rationale.trim().slice(0, 1000),
      })
      .onConflictDoUpdate({
        target: [
          productOrderRiskReviews.orderId,
          productOrderRiskReviews.reviewerAdminUserId,
        ],
        set: {
          reviewerWasBusinessOwner: reviewer.role === "owner",
          decision: input.decision,
          rationale: input.rationale.trim().slice(0, 1000),
          createdAt: new Date(),
        },
      });
    if (input.decision === "escalate") return { cleared: false };
    const clearances = await tx
      .select({
        reviewerId: productOrderRiskReviews.reviewerAdminUserId,
        owner: productOrderRiskReviews.reviewerWasBusinessOwner,
      })
      .from(productOrderRiskReviews)
      .where(
        and(
          eq(productOrderRiskReviews.orderId, order.id),
          eq(productOrderRiskReviews.decision, "clear_false_positive"),
        ),
      );
    const cleared =
      new Set(clearances.map((entry) => entry.reviewerId)).size >= 2 &&
      clearances.some((entry) => entry.owner);
    if (cleared)
      await tx
        .update(checkoutOrders)
        .set({ fraudClearedAt: new Date(), updatedAt: new Date() })
        .where(eq(checkoutOrders.id, order.id));
    return { cleared };
  });
}
