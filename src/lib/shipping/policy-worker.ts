import "server-only";

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productShippingCases,
  productShipments,
  shippingFundingReviews,
  shippingServicePolicies,
} from "@/lib/private-db/schema";
import { openProductShippingCase } from "./cases";
import { issueCustomerDecision } from "./customer-decisions";
import { sendShippingCustomerLinkEmail } from "./customer-link-email";
import {
  processProductOrderRefund,
  queueProductOrderRefund,
} from "./customer-refunds";
import { createChitChatsClient } from "./chitchats-client";
import { getChitChatsConfig } from "./config";
import {
  addBusinessDays,
  addCoverageHours,
  localDateTimeToInstant,
} from "./policy-calendar";
import {
  getShippingPolicyEnforcementMode,
  loadShippingPolicyContext,
} from "./policy";
import {
  sendShippingCustomerUpdate,
  sendShippingPolicyAlert,
} from "./policy-alerts";

export interface ShippingPolicyWorkerResult {
  manualReviewAlerts: number;
  escalations: number;
  handoffMisses: number;
  casesOpened: number;
  refundsProcessed: number;
  returnsObserved: number;
  failures: number;
}

export async function runShippingPolicyWorker(
  now = new Date(),
): Promise<ShippingPolicyWorkerResult> {
  const result: ShippingPolicyWorkerResult = {
    manualReviewAlerts: 0,
    escalations: 0,
    handoffMisses: 0,
    casesOpened: 0,
    refundsProcessed: 0,
    returnsObserved: 0,
    failures: 0,
  };
  if (getShippingPolicyEnforcementMode() === "off") return result;
  const policy = await loadShippingPolicyContext(now);
  const db = getPrivateDb();
  const shipments = await db
    .select({ shipment: productShipments, order: checkoutOrders })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .where(
      inArray(productShipments.status, [
        "ready_for_staff",
        "purchase_pending",
        "label_ready",
        "accepted",
        "in_transit",
        "exception",
        "manual_review",
        "delivered",
      ]),
    )
    .orderBy(asc(productShipments.updatedAt))
    .limit(500);

  for (const row of shipments) {
    try {
      if (row.shipment.status === "manual_review")
        await handleManualReview(row, policy, now, result);
      if (
        !row.shipment.acceptedAt &&
        row.shipment.originalHandoffDeadlineAt &&
        row.shipment.originalHandoffDeadlineAt <= now
      )
        await handleMissedHandoff(row, policy.mode, now, result);
      await handleDelayAndLoss(row, policy, now, result);
      await handleLateDelivery(row, policy, now, result);
    } catch {
      result.failures += 1;
    }
  }

  for (const operation of [
    () => expireCustomerDecisions(now, policy.mode, result),
    () => ensureRemedyDecisions(policy, now),
    () => processSelectedCustomerDecisions(policy.mode),
    () => processQueuedRefunds(policy.mode, result),
    () => pollReturns(policy.mode, result),
    () => recordThirtyDayFundingReview(policy, now),
    () => alertCalendarCoverage(policy, now),
    () => alertClaimDeadlines(policy, now),
    () => alertServicePolicyReviews(now),
    () => alertPrivacyOverdue(now),
    () => alertUnknownRefunds(),
    () => sendBlockedFulfillmentUpdates(policy, now),
    () => alertFundingControls(policy),
  ]) {
    try {
      await operation();
    } catch {
      result.failures += 1;
    }
  }
  return result;
}

async function handleManualReview(
  row: ShipmentAndOrder,
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  const started = row.shipment.manualReviewStartedAt ?? row.shipment.updatedAt;
  const alertAt = addCoverageHours({
    from: started,
    coverageHours: policy.settings.manualReviewAlertCoverageHours,
    settings: policy.settings,
    closedDates: policy.closedDates,
  });
  const escalateAt = addCoverageHours({
    from: started,
    coverageHours: policy.settings.manualReviewEscalationCoverageHours,
    settings: policy.settings,
    closedDates: policy.closedDates,
  });
  const handoffDeadlineImminent = Boolean(
    row.shipment.originalHandoffDeadlineAt &&
    row.shipment.originalHandoffDeadlineAt.getTime() - now.getTime() <=
      4 * 60 * 60_000,
  );
  if (!row.shipment.manualReviewAlertedAt && alertAt <= now) {
    await sendShippingPolicyAlert({
      duties: ["operations_lead"],
      subject: `Shipping manual review: ${row.order.orderId}`,
      message:
        "A paid order has remained in manual review for two coverage hours.",
      idempotencyKey: `shipping-manual-alert/${row.shipment.id}`,
    });
    await getPrivateDb()
      .update(productShipments)
      .set({ manualReviewAlertedAt: now, updatedAt: now })
      .where(eq(productShipments.id, row.shipment.id));
    result.manualReviewAlerts += 1;
  }
  if (
    !row.shipment.manualReviewEscalatedAt &&
    (escalateAt <= now || handoffDeadlineImminent)
  ) {
    await sendShippingPolicyAlert({
      duties: ["operations_lead"],
      critical: true,
      subject: `Escalated shipping manual review: ${row.order.orderId}`,
      message: handoffDeadlineImminent
        ? "A paid order in manual review is within four hours of its carrier-handoff deadline."
        : "A paid order has remained in manual review for four coverage hours.",
      idempotencyKey: `shipping-manual-escalation/${row.shipment.id}`,
    });
    await getPrivateDb()
      .update(productShipments)
      .set({ manualReviewEscalatedAt: now, updatedAt: now })
      .where(eq(productShipments.id, row.shipment.id));
    result.escalations += 1;
  }
}

async function handleMissedHandoff(
  row: ShipmentAndOrder,
  mode: "off" | "observe" | "enforce",
  now: Date,
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  await openProductShippingCase({
    orderId: row.order.id,
    shipmentId: row.shipment.id,
    type: "postage_failure",
    cause: "carrier_handoff_deadline_missed",
    customerUpdateDueAt: now,
  });
  if (!row.shipment.customerNotifiedAt && mode === "enforce") {
    const [existing] = await getPrivateDb()
      .select({ id: productOrderCustomerDecisions.id })
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(productOrderCustomerDecisions.orderId, row.order.id),
          eq(productOrderCustomerDecisions.kind, "missed_handoff"),
          inArray(productOrderCustomerDecisions.status, [
            "pending",
            "selected",
            "expired",
            "revoked",
          ]),
        ),
      )
      .limit(1);
    if (!existing && row.shipment.autoRefundDeadlineAt) {
      const issued = await issueCustomerDecision({
        orderReference: row.order.orderId,
        kind: "missed_handoff",
        allowedOutcomes: ["refund", "wait"],
        expiresAt: row.shipment.autoRefundDeadlineAt,
      });
      const link = new URL("/orders/shipping-decision", publicOrigin());
      link.searchParams.set("token", issued.token);
      await sendShippingCustomerLinkEmail({
        to: issued.email,
        orderReference: row.order.orderId,
        link: link.toString(),
        purpose: "decision",
        idempotencyKey: `shipping-handoff-decision/${issued.id}`,
      });
    }
    await getPrivateDb()
      .update(productShipments)
      .set({ customerNotifiedAt: now, updatedAt: now })
      .where(eq(productShipments.id, row.shipment.id));
  }
  if (
    row.shipment.autoRefundDeadlineAt &&
    row.shipment.autoRefundDeadlineAt <= now
  ) {
    const [choice] = await getPrivateDb()
      .select({ id: productOrderCustomerDecisions.id })
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(productOrderCustomerDecisions.orderId, row.order.id),
          eq(productOrderCustomerDecisions.status, "selected"),
          inArray(productOrderCustomerDecisions.selectedOutcome, [
            "wait",
            "accept_substitute",
          ]),
        ),
      )
      .limit(1);
    if (!choice && mode === "enforce")
      await queueFullRefund(
        row.order.orderId,
        "Automatic refund after missed carrier handoff",
      );
  }
  result.handoffMisses += 1;
}

async function ensureRemedyDecisions(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
): Promise<void> {
  if (policy.mode !== "enforce") return;
  const cases = await getPrivateDb()
    .select({
      caseId: productShippingCases.id,
      orderReference: checkoutOrders.orderId,
      remedyDeadlineAt: productShippingCases.remedyDeadlineAt,
    })
    .from(productShippingCases)
    .innerJoin(
      checkoutOrders,
      eq(productShippingCases.orderId, checkoutOrders.id),
    )
    .where(
      and(
        inArray(productShippingCases.type, ["loss", "damage"]),
        inArray(productShippingCases.status, [
          "open",
          "waiting_customer",
          "remedy_pending",
        ]),
      ),
    )
    .limit(100);
  for (const entry of cases) {
    const [existing] = await getPrivateDb()
      .select({ id: productOrderCustomerDecisions.id })
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(productOrderCustomerDecisions.caseId, entry.caseId),
          inArray(productOrderCustomerDecisions.status, [
            "pending",
            "selected",
          ]),
        ),
      )
      .limit(1);
    if (existing) continue;
    const expiresAt =
      entry.remedyDeadlineAt ?? businessDeadline(now, 2, policy);
    const issued = await issueCustomerDecision({
      orderReference: entry.orderReference,
      caseId: entry.caseId,
      kind: "loss_damage_remedy",
      allowedOutcomes: ["refund", "replacement"],
      expiresAt,
    });
    const link = new URL("/orders/shipping-decision", publicOrigin());
    link.searchParams.set("token", issued.token);
    await sendShippingCustomerLinkEmail({
      to: issued.email,
      orderReference: entry.orderReference,
      link: link.toString(),
      purpose: "decision",
      idempotencyKey: `shipping-remedy-decision/${issued.id}`,
    });
    await getPrivateDb()
      .update(productShippingCases)
      .set({
        status: "waiting_customer",
        remedyDeadlineAt: expiresAt,
        updatedAt: now,
      })
      .where(eq(productShippingCases.id, entry.caseId));
  }
}

async function processSelectedCustomerDecisions(
  mode: "off" | "observe" | "enforce",
): Promise<void> {
  if (mode !== "enforce") return;
  const decisions = await getPrivateDb()
    .select({
      id: productOrderCustomerDecisions.id,
      outcome: productOrderCustomerDecisions.selectedOutcome,
      orderReference: checkoutOrders.orderId,
      caseId: productOrderCustomerDecisions.caseId,
    })
    .from(productOrderCustomerDecisions)
    .innerJoin(
      checkoutOrders,
      eq(productOrderCustomerDecisions.orderId, checkoutOrders.id),
    )
    .where(eq(productOrderCustomerDecisions.status, "selected"))
    .limit(100);
  for (const decision of decisions) {
    if (decision.outcome !== "refund") continue;
    await queueFullRefund(
      decision.orderReference,
      "Customer selected refund under shipping policy",
    );
    if (decision.caseId)
      await getPrivateDb()
        .update(productShippingCases)
        .set({
          remedyChoice: "refund",
          status: "remedy_pending",
          updatedAt: new Date(),
        })
        .where(eq(productShippingCases.id, decision.caseId));
  }
}

async function handleDelayAndLoss(
  row: ShipmentAndOrder,
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  if (
    !["label_ready", "accepted", "in_transit", "exception"].includes(
      row.shipment.status,
    )
  )
    return;
  const movement =
    row.shipment.lastCarrierMovementAt ??
    row.shipment.acceptedAt ??
    row.shipment.purchasedAt;
  const noMovement =
    movement && now.getTime() - movement.getTime() >= 5 * 24 * 60 * 60_000;
  const estimateLate = row.shipment.latestEstimatedDeliveryAt
    ? businessDeadline(row.shipment.latestEstimatedDeliveryAt, 2, policy) <= now
    : false;
  if (noMovement || estimateLate) {
    const delay = await openProductShippingCase({
      orderId: row.order.id,
      shipmentId: row.shipment.id,
      type: "delay",
      cause: noMovement
        ? "five_calendar_days_without_movement"
        : "two_business_days_beyond_estimate",
      customerUpdateDueAt: now,
    });
    result.casesOpened += 1;
    const service = row.shipment.selectedPostageType
      ? policy.servicePolicies.get(
          `${row.shipment.selectedPostageType}:${countryCode(row.shipment.destination)}`,
        )
      : null;
    if (service && movement) {
      const lossEligible = new Date(
        movement.getTime() + service.claimWaitingDays * 24 * 60 * 60_000,
      );
      if (lossEligible <= now) {
        await openProductShippingCase({
          orderId: row.order.id,
          shipmentId: row.shipment.id,
          type: "loss",
          cause: "service_policy_claim_window_open",
          eligibleAt: lossEligible,
          carrierDeadlineAt: new Date(
            movement.getTime() + service.claimDeadlineDays * 24 * 60 * 60_000,
          ),
          customerUpdateDueAt: now,
          remedyDeadlineAt: businessDeadline(now, 2, policy),
        });
        result.casesOpened += 1;
      }
    }
    if (
      delay.customerUpdateDueAt &&
      delay.customerUpdateDueAt <= now &&
      policy.mode === "enforce"
    ) {
      await sendShippingCustomerUpdate({
        to: row.order.customerEmail,
        orderReference: row.order.orderId,
        subject: "Delayed shipment update",
        message:
          "Your shipment is delayed. We are monitoring it and will update you again within two business days.",
        idempotencyKey: `shipping-delay-update/${delay.id}/${delay.customerUpdateDueAt.toISOString()}`,
      });
      await getPrivateDb()
        .update(productShippingCases)
        .set({
          customerUpdateDueAt: businessDeadline(now, 2, policy),
          updatedAt: now,
        })
        .where(eq(productShippingCases.id, delay.id));
    }
  }
}

async function handleLateDelivery(
  row: ShipmentAndOrder,
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  if (
    row.shipment.status !== "delivered" ||
    !row.shipment.deliveredAt ||
    !row.shipment.latestEstimatedDeliveryAt ||
    row.order.shippingAmountCents < 100 ||
    businessDeadline(row.shipment.latestEstimatedDeliveryAt, 5, policy) >
      row.shipment.deliveredAt
  )
    return;
  if (policy.mode === "enforce") {
    const reason =
      "Delivered at least five business days beyond upper estimate";
    const [existing] = await getPrivateDb()
      .select({ id: productOrderRefunds.id })
      .from(productOrderRefunds)
      .where(
        and(
          eq(productOrderRefunds.orderId, row.order.id),
          eq(productOrderRefunds.reason, reason),
        ),
      )
      .limit(1);
    if (existing) return;
    try {
      const refund = await queueProductOrderRefund({
        orderReference: row.order.orderId,
        amountCents: row.order.shippingAmountCents,
        reason,
        automated: true,
      });
      await processProductOrderRefund(refund.id);
      result.refundsProcessed += 1;
    } catch {
      // Existing ledger reservation makes this policy action idempotent.
    }
  }
}

async function expireCustomerDecisions(
  now: Date,
  mode: "off" | "observe" | "enforce",
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  const expired = await getPrivateDb()
    .update(productOrderCustomerDecisions)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(productOrderCustomerDecisions.status, "pending"),
        lte(productOrderCustomerDecisions.expiresAt, now),
      ),
    )
    .returning({
      orderId: productOrderCustomerDecisions.orderId,
      caseId: productOrderCustomerDecisions.caseId,
    });
  if (mode !== "enforce") return;
  for (const decision of expired) {
    if (!decision.caseId) continue;
    const [row] = await getPrivateDb()
      .select({
        type: productShippingCases.type,
        orderReference: checkoutOrders.orderId,
      })
      .from(productShippingCases)
      .innerJoin(
        checkoutOrders,
        eq(productShippingCases.orderId, checkoutOrders.id),
      )
      .where(eq(productShippingCases.id, decision.caseId))
      .limit(1);
    if (row && ["loss", "damage"].includes(row.type))
      await queueFullRefund(
        row.orderReference,
        "No response to loss or damage remedy choice",
      );
  }
  result.refundsProcessed += 0;
}

async function processQueuedRefunds(
  mode: "off" | "observe" | "enforce",
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  if (mode !== "enforce") return;
  const queued = await getPrivateDb()
    .select({ id: productOrderRefunds.id })
    .from(productOrderRefunds)
    .where(eq(productOrderRefunds.status, "queued"))
    .orderBy(asc(productOrderRefunds.createdAt))
    .limit(25);
  for (const row of queued) {
    const refund = await processProductOrderRefund(row.id);
    if (refund.status === "succeeded") result.refundsProcessed += 1;
    if (refund.status === "outcome_unknown")
      await sendShippingPolicyAlert({
        duties: ["finance_owner"],
        critical: true,
        subject: "Helcim refund outcome is unknown",
        message: `Refund ${row.id} requires transaction reconciliation; do not resubmit it.`,
        idempotencyKey: `shipping-refund-unknown/${row.id}`,
      });
  }
}

async function pollReturns(
  mode: "off" | "observe" | "enforce",
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  if (mode === "off") return;
  const returns =
    await createChitChatsClient(getChitChatsConfig()).listReturns(1);
  for (const item of returns) {
    if (!item.shipment_id) continue;
    const [shipment] = await getPrivateDb()
      .select({ id: productShipments.id, orderId: productShipments.orderId })
      .from(productShipments)
      .where(eq(productShipments.providerShipmentId, item.shipment_id))
      .limit(1);
    if (!shipment?.orderId) continue;
    const returnSignal =
      `${item.reason ?? ""} ${item.status ?? ""}`.toLowerCase();
    await openProductShippingCase({
      orderId: shipment.orderId,
      shipmentId: shipment.id,
      type: returnSignal.includes("unclaim")
        ? "unclaimed"
        : returnSignal.includes("refus")
          ? "refused"
          : "return_to_sender",
      cause: "cause_pending_local_inspection",
    });
    result.returnsObserved += 1;
  }
}

async function recordThirtyDayFundingReview(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
): Promise<void> {
  if (
    !policy.settings.pilotStartedAt ||
    now.getTime() - policy.settings.pilotStartedAt.getTime() <
      30 * 24 * 60 * 60_000
  )
    return;
  const [existing] = await getPrivateDb()
    .select({ id: shippingFundingReviews.id })
    .from(shippingFundingReviews)
    .where(eq(shippingFundingReviews.kind, "thirty_day_review"))
    .limit(1);
  if (existing) return;
  const [spend] = await getPrivateDb()
    .select({
      total: sql<number>`coalesce(sum(coalesce(${productShipments.actualPostageCents}, 0) + coalesce(${productShipments.actualInsuranceCents}, 0)), 0)`,
    })
    .from(productShipments)
    .where(
      and(
        gte(
          productShipments.purchasedAt,
          new Date(now.getTime() - 30 * 24 * 60 * 60_000),
        ),
        lte(productShipments.purchasedAt, now),
      ),
    );
  const daily = Number(spend?.total ?? 0) / 22;
  const calculatedThreshold = roundUp25(daily * 2);
  const calculatedReload = roundUp25(daily * 5);
  const guardedThreshold = clamp(calculatedThreshold, 2_500, 25_000);
  const guardedReload = clamp(calculatedReload, 10_000, 100_000);
  const exceedsCap =
    guardedThreshold + guardedReload >
    policy.settings.fundingMaximumBalanceCents;
  const threshold = exceedsCap
    ? Math.min(
        guardedThreshold,
        policy.settings.fundingMaximumBalanceCents - 10_000,
      )
    : guardedThreshold;
  const reload = exceedsCap
    ? policy.settings.fundingMaximumBalanceCents - threshold
    : guardedReload;
  const [created] = await getPrivateDb()
    .insert(shippingFundingReviews)
    .values({
      kind: "thirty_day_review",
      status: "recommended",
      calculatedTwoBusinessDaySpendCents: calculatedThreshold,
      calculatedFiveBusinessDaySpendCents: calculatedReload,
      reloadThresholdCents: threshold,
      reloadAmountCents: reload,
      notes: exceedsCap
        ? "Recommendation was capped at CAD 500; exceeding it requires Finance and Business Owner approval"
        : "Finance must record the values applied in the Chit Chats dashboard",
    })
    .returning({ id: shippingFundingReviews.id });
  if (created)
    await sendShippingPolicyAlert({
      duties: ["finance_owner"],
      critical: exceedsCap,
      subject: "Chit Chats 30-day funding review is ready",
      message:
        "The calculated two-day threshold and five-day reload recommendation is ready for Finance review and dashboard recording.",
      idempotencyKey: `shipping-funding-thirty-day/${created.id}`,
    });
}

async function alertClaimDeadlines(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
): Promise<void> {
  const warningCutoff = new Date(now.getTime() + 5 * 24 * 60 * 60_000);
  const urgentCutoff = businessDeadline(now, 1, policy);
  const cases = await getPrivateDb()
    .select({
      id: productShippingCases.id,
      deadline: productShippingCases.carrierDeadlineAt,
      orderReference: checkoutOrders.orderId,
    })
    .from(productShippingCases)
    .innerJoin(
      checkoutOrders,
      eq(productShippingCases.orderId, checkoutOrders.id),
    )
    .where(
      and(
        inArray(productShippingCases.type, ["loss", "damage", "claim"]),
        inArray(productShippingCases.status, [
          "open",
          "waiting_customer",
          "waiting_provider",
          "remedy_pending",
        ]),
        lte(productShippingCases.carrierDeadlineAt, warningCutoff),
      ),
    )
    .limit(100);
  for (const entry of cases) {
    if (!entry.deadline) continue;
    const critical = entry.deadline <= urgentCutoff;
    await sendShippingPolicyAlert({
      duties: ["operations_lead"],
      critical,
      subject: `Carrier claim deadline: ${entry.orderReference}`,
      message: `The locally tracked carrier claim deadline is ${entry.deadline.toISOString()}. Confirm the Chit Chats claim and evidence checklist before it expires.`,
      idempotencyKey: `shipping-claim-deadline/${entry.id}/${critical ? "urgent" : "warning"}/${entry.deadline.toISOString()}`,
    });
  }
}

async function alertServicePolicyReviews(now: Date): Promise<void> {
  const reviewDueBefore = new Date(now.getTime() - 76 * 24 * 60 * 60_000);
  const policies = await getPrivateDb()
    .select({
      id: shippingServicePolicies.id,
      postageType: shippingServicePolicies.postageType,
      country: shippingServicePolicies.destinationCountryCode,
      reviewedAt: shippingServicePolicies.reviewedAt,
    })
    .from(shippingServicePolicies)
    .where(
      and(
        eq(shippingServicePolicies.enabled, true),
        lte(shippingServicePolicies.reviewedAt, reviewDueBefore),
      ),
    );
  for (const service of policies) {
    const critical =
      service.reviewedAt <= new Date(now.getTime() - 90 * 24 * 60 * 60_000);
    await sendShippingPolicyAlert({
      duties: ["operations_lead"],
      critical,
      subject: `Shipping service policy review: ${service.postageType}`,
      message: `${service.postageType} for ${service.country} is due for its 90-day insurance, signature, and claim-rule review. Rates fail closed once stale.`,
      idempotencyKey: `shipping-service-review/${service.id}/${critical ? "overdue" : "due"}/${service.reviewedAt.toISOString()}`,
    });
  }
}

async function alertPrivacyOverdue(now: Date): Promise<void> {
  const hardCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60_000);
  const [overdue] = await getPrivateDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.purpose, "product"),
        lte(checkoutOrders.createdAt, hardCutoff),
        sql`${checkoutOrders.redactedAt} is null`,
      ),
    );
  const count = Number(overdue?.count ?? 0);
  if (!count) return;
  await sendShippingPolicyAlert({
    duties: ["privacy_owner"],
    critical: true,
    subject: "Shipping PII exceeds the 365-day hard cap",
    message: `${count} product order record(s) remain unredacted beyond the absolute live-data limit. Treat the retention job as failed and investigate immediately.`,
    idempotencyKey: `shipping-privacy-overdue/${now.toISOString().slice(0, 10)}`,
  });
}

async function alertUnknownRefunds(): Promise<void> {
  const refunds = await getPrivateDb()
    .select({ id: productOrderRefunds.id })
    .from(productOrderRefunds)
    .where(eq(productOrderRefunds.status, "outcome_unknown"))
    .limit(100);
  for (const refund of refunds)
    await sendShippingPolicyAlert({
      duties: ["finance_owner"],
      critical: true,
      subject: "Helcim refund outcome is unknown",
      message: `Refund ${refund.id} requires signed-webhook or transaction reconciliation. Do not submit a new refund.`,
      idempotencyKey: `shipping-refund-unknown/${refund.id}`,
    });
}

async function sendBlockedFulfillmentUpdates(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
): Promise<void> {
  if (policy.mode !== "enforce") return;
  const cases = await getPrivateDb()
    .select({
      caseId: productShippingCases.id,
      email: checkoutOrders.customerEmail,
      orderReference: checkoutOrders.orderId,
      dueAt: productShippingCases.customerUpdateDueAt,
    })
    .from(productShippingCases)
    .innerJoin(
      checkoutOrders,
      eq(productShippingCases.orderId, checkoutOrders.id),
    )
    .where(
      and(
        eq(productShippingCases.type, "postage_failure"),
        inArray(productShippingCases.status, [
          "open",
          "waiting_customer",
          "waiting_provider",
          "remedy_pending",
        ]),
        lte(productShippingCases.customerUpdateDueAt, now),
      ),
    )
    .limit(100);
  for (const entry of cases) {
    if (!entry.dueAt) continue;
    await sendShippingCustomerUpdate({
      to: entry.email,
      orderReference: entry.orderReference,
      subject: "Shipping fulfillment update",
      message:
        "Your order remains under shipping review. We are not retrying an uncertain carrier charge and will send another update within one business day unless it is resolved sooner.",
      idempotencyKey: `shipping-blocked-update/${entry.caseId}/${entry.dueAt.toISOString()}`,
    });
    await getPrivateDb()
      .update(productShippingCases)
      .set({
        customerUpdateDueAt: businessDeadline(now, 1, policy),
        updatedAt: now,
      })
      .where(eq(productShippingCases.id, entry.caseId));
  }
}

async function alertFundingControls(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
): Promise<void> {
  const [failedReload] = await getPrivateDb()
    .select()
    .from(shippingFundingReviews)
    .where(
      and(
        eq(shippingFundingReviews.kind, "reload"),
        eq(shippingFundingReviews.status, "rejected"),
      ),
    )
    .orderBy(desc(shippingFundingReviews.createdAt))
    .limit(1);
  if (failedReload) {
    await sendShippingPolicyAlert({
      duties: ["finance_owner"],
      critical: true,
      subject: "Chit Chats reload failed",
      message:
        "The recorded account reload failed. Stop postage purchases that depend on unavailable credit and complete a controlled funding review.",
      idempotencyKey: `shipping-reload-failed/${failedReload.id}`,
    });
  }
  const [latestBalance] = await getPrivateDb()
    .select()
    .from(shippingFundingReviews)
    .where(eq(shippingFundingReviews.kind, "balance_check"))
    .orderBy(desc(shippingFundingReviews.createdAt))
    .limit(1);
  if (!latestBalance || latestBalance.balanceCents === null) return;
  const [forecast] = await getPrivateDb()
    .select({
      amount: shippingFundingReviews.calculatedTwoBusinessDaySpendCents,
    })
    .from(shippingFundingReviews)
    .where(eq(shippingFundingReviews.kind, "thirty_day_review"))
    .orderBy(desc(shippingFundingReviews.createdAt))
    .limit(1);
  const minimum = Math.max(
    policy.settings.fundingReloadThresholdCents,
    forecast?.amount ?? 0,
  );
  if (latestBalance.balanceCents >= minimum) return;
  await sendShippingPolicyAlert({
    duties: ["finance_owner"],
    critical: true,
    subject: "Chit Chats balance is below the two-day forecast",
    message: `The recorded balance is below the controlled two-business-day forecast of CAD ${(minimum / 100).toFixed(2)}.`,
    idempotencyKey: `shipping-balance-low/${latestBalance.id}`,
  });
}

async function alertCalendarCoverage(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
): Promise<void> {
  const coverageEnd = new Date(`${policy.calendarCoverageEndsAt}T23:59:59Z`);
  if (coverageEnd.getTime() - now.getTime() > 60 * 24 * 60 * 60_000) return;
  await sendShippingPolicyAlert({
    duties: ["operations_lead"],
    critical: true,
    subject: "Shipping calendar coverage expires within 60 days",
    message: `Calendar exceptions are configured only through ${policy.calendarCoverageEndsAt}. Add Ontario holidays and branch closures before rates fail closed.`,
    idempotencyKey: `shipping-calendar-coverage/${policy.calendarCoverageEndsAt}`,
  });
}

async function queueFullRefund(
  orderReference: string,
  reason: string,
): Promise<void> {
  try {
    await queueProductOrderRefund({ orderReference, reason, automated: true });
  } catch {
    // An existing reservation or terminal refund makes the action idempotent.
  }
}

function businessDeadline(
  from: Date,
  days: number,
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
): Date {
  const start = new Intl.DateTimeFormat("en-CA", {
    timeZone: policy.settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(from);
  const date = addBusinessDays(start, days, policy.closedDates);
  return localDateTimeToInstant(
    date,
    policy.settings.coverageEndsAt,
    policy.settings.timezone,
  );
}

function countryCode(destination: {
  country: string;
  countryCode?: "CA" | "US";
}): string {
  return (
    destination.countryCode ??
    (destination.country.toUpperCase() === "CANADA" ? "CA" : "US")
  );
}

function roundUp25(value: number): number {
  return Math.ceil(Math.max(0, value) / 2500) * 2500;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function publicOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return new URL(configured).origin;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return new URL(`https://${vercel}`).origin;
  throw new Error(
    "NEXT_PUBLIC_SITE_URL is required for shipping decision links",
  );
}

type ShipmentAndOrder = {
  shipment: typeof productShipments.$inferSelect;
  order: typeof checkoutOrders.$inferSelect;
};
