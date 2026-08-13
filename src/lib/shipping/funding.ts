import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  shippingFundingReviews,
  shippingPolicyAssignments,
  shippingPolicySettings,
} from "@/lib/private-db/schema";

export async function recordShippingFundingControl(input: {
  actorAdminUserId: string;
  kind: "balance_check" | "reload" | "emergency_top_up";
  balanceCents?: number;
  reloadThresholdCents?: number;
  reloadAmountCents?: number;
  topUpAmountCents?: number;
  dedicatedBusinessCardConfirmed: boolean;
  issuerAlertsConfirmed: boolean;
  successful?: boolean;
}) {
  if (!input.dedicatedBusinessCardConfirmed || !input.issuerAlertsConfirmed)
    throw new Error(
      "Dedicated business card and issuer alerts must be confirmed",
    );
  const db = getPrivateDb();
  const [actor] = await db
    .select({ role: adminUsers.role })
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.id, input.actorAdminUserId),
        eq(adminUsers.status, "active"),
      ),
    )
    .limit(1);
  if (!actor) throw new Error("Funding actor is not active");
  const [settings] = await db
    .select()
    .from(shippingPolicySettings)
    .where(eq(shippingPolicySettings.singletonKey, "default"))
    .limit(1);
  if (!settings) throw new Error("Shipping funding policy is unavailable");
  if (input.kind === "emergency_top_up") {
    const amount = input.topUpAmountCents ?? 0;
    if (!Number.isInteger(amount) || amount <= 0)
      throw new Error("Emergency top-up amount is invalid");
    const [assignment] = await db
      .select({ duty: shippingPolicyAssignments.duty })
      .from(shippingPolicyAssignments)
      .where(
        and(
          eq(shippingPolicyAssignments.adminUserId, input.actorAdminUserId),
          eq(shippingPolicyAssignments.duty, "operations_lead"),
          eq(shippingPolicyAssignments.active, true),
        ),
      )
      .limit(1);
    const since24Hours = new Date(Date.now() - 24 * 60 * 60_000);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [exposure] = await db
      .select({
        rolling: sql<number>`coalesce(sum(case when ${shippingFundingReviews.createdAt} >= ${since24Hours} then coalesce(${shippingFundingReviews.topUpAmountCents}, 0) + coalesce(${shippingFundingReviews.reloadAmountCents}, 0) else 0 end), 0)`,
        monthly: sql<number>`coalesce(sum(case when ${shippingFundingReviews.createdAt} >= ${monthStart} then coalesce(${shippingFundingReviews.topUpAmountCents}, 0) + coalesce(${shippingFundingReviews.reloadAmountCents}, 0) else 0 end), 0)`,
        recentTopUps: sql<number>`count(*) filter (where ${shippingFundingReviews.kind} = 'emergency_top_up' and ${shippingFundingReviews.createdAt} >= ${since24Hours})::int`,
      })
      .from(shippingFundingReviews);
    const normalAuthority =
      amount <= settings.fundingEmergencyTopUpCents &&
      Number(exposure?.recentTopUps ?? 0) === 0 &&
      assignment?.duty === "operations_lead";
    if (!normalAuthority && actor.role !== "owner")
      throw new Error(
        "Repeated or larger emergency top-ups require Business Owner approval",
      );
    if (
      Number(exposure?.rolling ?? 0) + amount >
      settings.fundingRollingDayLimitCents
    )
      throw new Error(
        "Emergency top-up exceeds the CAD 750 rolling-day control",
      );
    if (
      Number(exposure?.monthly ?? 0) + amount >
      settings.fundingMonthlyLimitCents
    )
      throw new Error("Emergency top-up exceeds the CAD 1,500 monthly control");
  }
  const threshold = input.reloadThresholdCents;
  const reload = input.reloadAmountCents;
  if (
    input.kind === "reload" &&
    (threshold !== settings.fundingReloadThresholdCents ||
      reload !== settings.fundingReloadAmountCents)
  )
    throw new Error("Launch auto-reload must be recorded as CAD 25 / CAD 100");
  if (
    input.balanceCents !== undefined &&
    input.balanceCents > settings.fundingMaximumBalanceCents &&
    actor.role !== "owner"
  )
    throw new Error("Balances above CAD 500 require Business Owner approval");
  const [created] = await db
    .insert(shippingFundingReviews)
    .values({
      kind: input.kind,
      status:
        input.kind === "reload"
          ? input.successful === false
            ? "rejected"
            : "applied"
          : "recorded",
      balanceCents: input.balanceCents,
      reloadThresholdCents: threshold,
      reloadAmountCents: reload,
      topUpAmountCents: input.topUpAmountCents,
      recordedByAdminUserId: input.actorAdminUserId,
      businessOwnerApprovedByAdminUserId:
        actor.role === "owner" ? input.actorAdminUserId : undefined,
      appliedAt:
        input.kind === "reload" && input.successful !== false
          ? new Date()
          : undefined,
      notes:
        "Dedicated business credit card and issuer alerts confirmed; values recorded from the Chit Chats dashboard.",
    })
    .returning();
  return created!;
}

export async function approveFundingReview(input: {
  reviewId: string;
  actorAdminUserId: string;
  markApplied: boolean;
}) {
  return getPrivateDb().transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: adminUsers.role })
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.id, input.actorAdminUserId),
          eq(adminUsers.status, "active"),
        ),
      )
      .limit(1);
    if (!actor) throw new Error("Funding approver is not active");
    const [finance] = await tx
      .select({ id: shippingPolicyAssignments.id })
      .from(shippingPolicyAssignments)
      .where(
        and(
          eq(shippingPolicyAssignments.adminUserId, input.actorAdminUserId),
          eq(shippingPolicyAssignments.duty, "finance_owner"),
          eq(shippingPolicyAssignments.active, true),
        ),
      )
      .limit(1);
    if (actor.role !== "owner" && !finance)
      throw new Error(
        "Only Finance or the Business Owner may approve funding reviews",
      );
    const [review] = await tx
      .select()
      .from(shippingFundingReviews)
      .where(eq(shippingFundingReviews.id, input.reviewId))
      .for("update")
      .limit(1);
    if (!review || !inArrayStatus(review.status))
      throw new Error("Funding review is not awaiting approval");
    const financeId = finance
      ? input.actorAdminUserId
      : review.financeApprovedByAdminUserId;
    const ownerId =
      actor.role === "owner"
        ? input.actorAdminUserId
        : review.businessOwnerApprovedByAdminUserId;
    const fullyApproved = Boolean(financeId && ownerId);
    if (input.markApplied && !fullyApproved)
      throw new Error(
        "Finance and Business Owner approval are required before applying values",
      );
    const [updated] = await tx
      .update(shippingFundingReviews)
      .set({
        financeApprovedByAdminUserId: financeId,
        businessOwnerApprovedByAdminUserId: ownerId,
        status: input.markApplied
          ? "applied"
          : fullyApproved
            ? "approved"
            : "recommended",
        appliedAt: input.markApplied ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(shippingFundingReviews.id, review.id))
      .returning();
    return updated!;
  });
}

function inArrayStatus(status: string): boolean {
  return ["recommended", "approved"].includes(status);
}
