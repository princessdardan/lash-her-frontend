import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  shippingFundingReviews,
  shippingPolicyAssignments,
  shippingPolicySettings,
} from "@/lib/private-db/schema";
import { assertConfiguredFulfillmentOwnerInTransaction } from "./configured-owner";

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
  externalEvidenceReference?: string;
  observedAt?: Date;
  validUntil?: Date;
  forecastReviewId?: string;
}) {
  if (!input.dedicatedBusinessCardConfirmed || !input.issuerAlertsConfirmed)
    throw new Error(
      "Dedicated business card and issuer alerts must be confirmed",
    );
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('lash-her:shipping-funding-controls'))`,
    );
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
    if (!actor) throw new Error("Funding actor is not active");
    const [settings] = await tx
      .select()
      .from(shippingPolicySettings)
      .where(eq(shippingPolicySettings.singletonKey, "default"))
      .limit(1);
    if (!settings) throw new Error("Shipping funding policy is unavailable");

    if (input.kind === "emergency_top_up") {
      const amount = input.topUpAmountCents ?? 0;
      if (!Number.isInteger(amount) || amount <= 0)
        throw new Error("Emergency top-up amount is invalid");
      const [assignment] = await tx
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
      const since24Hours = new Date(now.getTime() - 24 * 60 * 60_000);
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const [exposure] = await tx
        .select({
          rolling: sql<number>`coalesce(sum(case when ${shippingFundingReviews.createdAt} >= ${since24Hours} and ${shippingFundingReviews.status} = 'recorded' and ${shippingFundingReviews.kind} = 'emergency_top_up' then coalesce(${shippingFundingReviews.topUpAmountCents}, 0) when ${shippingFundingReviews.createdAt} >= ${since24Hours} and ${shippingFundingReviews.status} = 'applied' and ${shippingFundingReviews.kind} = 'reload' then coalesce(${shippingFundingReviews.reloadAmountCents}, 0) else 0 end), 0)`,
          monthly: sql<number>`coalesce(sum(case when ${shippingFundingReviews.createdAt} >= ${monthStart} and ${shippingFundingReviews.status} = 'recorded' and ${shippingFundingReviews.kind} = 'emergency_top_up' then coalesce(${shippingFundingReviews.topUpAmountCents}, 0) when ${shippingFundingReviews.createdAt} >= ${monthStart} and ${shippingFundingReviews.status} = 'applied' and ${shippingFundingReviews.kind} = 'reload' then coalesce(${shippingFundingReviews.reloadAmountCents}, 0) else 0 end), 0)`,
          recentTopUps: sql<number>`count(*) filter (where ${shippingFundingReviews.kind} = 'emergency_top_up' and ${shippingFundingReviews.status} = 'recorded' and ${shippingFundingReviews.createdAt} >= ${since24Hours})::int`,
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
        throw new Error(
          "Emergency top-up exceeds the CAD 1,500 monthly control",
        );
    }

    const threshold = input.reloadThresholdCents;
    const reload = input.reloadAmountCents;
    if (
      input.kind === "reload" &&
      (threshold !== settings.fundingReloadThresholdCents ||
        reload !== settings.fundingReloadAmountCents)
    )
      throw new Error(
        "Launch auto-reload must be recorded as CAD 25 / CAD 100",
      );
    if (
      input.balanceCents !== undefined &&
      input.balanceCents > settings.fundingMaximumBalanceCents &&
      actor.role !== "owner"
    )
      throw new Error("Balances above CAD 500 require Business Owner approval");

    let forecast: typeof shippingFundingReviews.$inferSelect | undefined;
    if (input.kind === "balance_check") {
      const evidence = input.externalEvidenceReference?.trim() ?? "";
      const observedAt = input.observedAt;
      const validUntil = input.validUntil;
      if (
        !Number.isInteger(input.balanceCents) ||
        input.balanceCents! < 0 ||
        !evidence ||
        !observedAt ||
        !validUntil ||
        observedAt > new Date(now.getTime() + 5 * 60_000) ||
        validUntil <= now ||
        validUntil > new Date(observedAt.getTime() + 24 * 60 * 60_000) ||
        !input.forecastReviewId
      ) {
        throw new Error("Balance attestation evidence is incomplete or stale");
      }
      [forecast] = await tx
        .select()
        .from(shippingFundingReviews)
        .where(
          and(
            eq(shippingFundingReviews.id, input.forecastReviewId),
            eq(shippingFundingReviews.kind, "thirty_day_review"),
            sql`${shippingFundingReviews.status} IN ('approved', 'applied')`,
          ),
        )
        .limit(1);
      if (
        !forecast ||
        forecast.calculatedTwoBusinessDaySpendCents === null ||
        forecast.calculatedFiveBusinessDaySpendCents === null
      ) {
        throw new Error("Balance attestation requires an approved forecast");
      }
    }

    const [created] = await tx
      .insert(shippingFundingReviews)
      .values({
        kind: input.kind,
        status:
          input.kind === "reload"
            ? input.successful === false
              ? "rejected"
              : "applied"
            : "recorded",
        balanceCents:
          input.kind === "balance_check" ? input.balanceCents : undefined,
        reloadThresholdCents: input.kind === "reload" ? threshold : undefined,
        reloadAmountCents: input.kind === "reload" ? reload : undefined,
        topUpAmountCents:
          input.kind === "emergency_top_up"
            ? input.topUpAmountCents
            : undefined,
        calculatedTwoBusinessDaySpendCents:
          forecast?.calculatedTwoBusinessDaySpendCents,
        calculatedFiveBusinessDaySpendCents:
          forecast?.calculatedFiveBusinessDaySpendCents,
        forecastReviewId: forecast?.id,
        externalEvidenceReference:
          input.kind === "balance_check"
            ? input.externalEvidenceReference?.trim()
            : undefined,
        observedAt:
          input.kind === "balance_check" ? input.observedAt : undefined,
        validUntil:
          input.kind === "balance_check" ? input.validUntil : undefined,
        recordedByAdminUserId: input.actorAdminUserId,
        businessOwnerApprovedByAdminUserId:
          actor.role === "owner" ? input.actorAdminUserId : undefined,
        appliedAt:
          input.kind === "reload" && input.successful !== false
            ? now
            : undefined,
        notes:
          input.kind === "balance_check"
            ? "Dedicated business credit card and issuer alerts confirmed; balance recorded from controlled Chit Chats dashboard evidence."
            : input.kind === "reload"
              ? "Dedicated business credit card and issuer alerts confirmed; reload outcome recorded."
              : "Dedicated business credit card and issuer alerts confirmed; emergency top-up recorded.",
      })
      .returning();
    return created!;
  });
}

export async function recordInitialShippingFundingForecast(input: {
  actorAdminUserId: string;
  calculatedFiveBusinessDaySpendCents: number;
  calculatedTwoBusinessDaySpendCents: number;
  evidenceReference: string;
  dedicatedBusinessCardConfirmed: boolean;
  issuerAlertsConfirmed: boolean;
  reloadAmountCents: number;
  reloadThresholdCents: number;
}) {
  const values = [
    input.calculatedTwoBusinessDaySpendCents,
    input.calculatedFiveBusinessDaySpendCents,
    input.reloadThresholdCents,
    input.reloadAmountCents,
  ];
  const evidenceReference = input.evidenceReference.trim();
  if (
    values.some((value) => !Number.isInteger(value) || value <= 0) ||
    !input.dedicatedBusinessCardConfirmed ||
    !input.issuerAlertsConfirmed ||
    evidenceReference.length < 6 ||
    evidenceReference.length > 500
  ) {
    throw new Error("Initial funding forecast evidence is invalid");
  }
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('lash-her:shipping-funding-controls'))`,
    );
    const [settings] = await tx
      .select({
        maximumBalanceCents: shippingPolicySettings.fundingMaximumBalanceCents,
      })
      .from(shippingPolicySettings)
      .where(eq(shippingPolicySettings.singletonKey, "default"))
      .limit(1);
    if (
      !settings ||
      input.reloadThresholdCents + input.reloadAmountCents >
        settings.maximumBalanceCents
    ) {
      throw new Error(
        "Initial funding forecast exceeds the controlled balance cap",
      );
    }
    const [created] = await tx
      .insert(shippingFundingReviews)
      .values({
        kind: "thirty_day_review",
        status: "recommended",
        calculatedTwoBusinessDaySpendCents:
          input.calculatedTwoBusinessDaySpendCents,
        calculatedFiveBusinessDaySpendCents:
          input.calculatedFiveBusinessDaySpendCents,
        reloadThresholdCents: input.reloadThresholdCents,
        reloadAmountCents: input.reloadAmountCents,
        externalEvidenceReference: evidenceReference,
        recordedByAdminUserId: input.actorAdminUserId,
        businessOwnerApprovedByAdminUserId: input.actorAdminUserId,
        notes:
          "Prelaunch owner forecast; requires explicit funding approval before a balance attestation can reference it.",
      })
      .returning();
    if (!created) throw new Error("Initial funding forecast was not recorded");
    return created;
  });
}

export async function assertShippingPurchaseFundingAvailable(input: {
  requiredAmountCents: number;
  now?: Date;
}): Promise<{ attestationId: string; availableBalanceCents: number }> {
  if (
    !Number.isInteger(input.requiredAmountCents) ||
    input.requiredAmountCents <= 0
  )
    throw new Error("Shipping purchase amount is invalid");
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('lash-her:shipping-funding-controls'))`,
    );
    const [funding] = await tx
      .select()
      .from(shippingFundingReviews)
      .where(
        and(
          eq(shippingFundingReviews.kind, "balance_check"),
          eq(shippingFundingReviews.status, "recorded"),
          sql`${shippingFundingReviews.observedAt} <= ${now}`,
          sql`${shippingFundingReviews.validUntil} > ${now}`,
          sql`length(trim(${shippingFundingReviews.externalEvidenceReference})) > 0`,
        ),
      )
      .orderBy(sql`${shippingFundingReviews.observedAt} desc`)
      .limit(1)
      .for("update");
    const minimum = funding?.calculatedTwoBusinessDaySpendCents ?? 0;
    if (
      !funding ||
      funding.balanceCents === null ||
      !funding.forecastReviewId ||
      funding.balanceCents - input.requiredAmountCents < minimum
    ) {
      throw new Error("Shipping funding is stale or insufficient for purchase");
    }
    return {
      attestationId: funding.id,
      availableBalanceCents: funding.balanceCents,
    };
  });
}

export async function approveFundingReview(input: {
  reviewId: string;
  actorAdminUserId: string;
  markApplied: boolean;
}) {
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
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
