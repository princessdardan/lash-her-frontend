import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productShipmentReturnObservations,
  productShippingCases,
  productShipments,
  shippingFundingReviews,
  shippingServicePolicies,
} from "@/lib/private-db/schema";
import {
  openProductShippingCase,
  resolveSettledInventoryUnavailableRefundCases,
} from "./cases";
import {
  expirePendingCustomerDecisions,
  issueCustomerDecision,
  lossDamageRemedyDecisionTerms,
} from "./customer-decisions";
import {
  processProductOrderRefund,
  queueProductOrderRefund,
  queueProductOrderRefundAllocations,
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
import { mapChitChatsReturnReason } from "./return-rules";
export { mapChitChatsReturnReason } from "./return-rules";
import {
  claimShippingPolicyJobs,
  completeShippingPolicyJob,
  enqueueDueShippingPolicyJobs,
  failShippingPolicyJob,
  renewShippingPolicyJobLease,
  type ClaimedShippingPolicyJob,
} from "./policy-jobs";
import { runP10TerminationWorkflow } from "./p10-termination";

export interface ShippingPolicyWorkerResult {
  manualReviewAlerts: number;
  escalations: number;
  handoffMisses: number;
  casesOpened: number;
  refundsProcessed: number;
  returnsObserved: number;
  failures: number;
  tasksClaimed: number;
  tasksCompleted: number;
  tasksQueued: number;
  tasksManualReview: number;
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
    tasksClaimed: 0,
    tasksCompleted: 0,
    tasksQueued: 0,
    tasksManualReview: 0,
  };
  if (getShippingPolicyEnforcementMode() === "off") return result;
  const policy = await loadShippingPolicyContext(now);
  if (policy.mode === "observe") {
    for await (const shipments of listPolicyShipmentPages()) {
      result.manualReviewAlerts += shipments.filter(
        ({ shipment }) => shipment.status === "manual_review",
      ).length;
      result.handoffMisses += shipments.filter(
        ({ shipment }) =>
          !shipment.acceptedAt &&
          Boolean(
            shipment.originalHandoffDeadlineAt &&
            shipment.originalHandoffDeadlineAt <= now,
          ),
      ).length;
    }
    return result;
  }
  result.tasksQueued = await enqueueDueShippingPolicyJobs(now);
  const tasks = await claimShippingPolicyJobs({ now });
  result.tasksClaimed = tasks.length;
  for (const task of tasks) {
    try {
      await withShippingPolicyJobLease(task, (checkpoint) =>
        processPolicyTask(task, policy, now, result, checkpoint),
      );
      if (!(await completeShippingPolicyJob(task, new Date())))
        throw new Error("Shipping policy task lease expired before completion");
      result.tasksCompleted += 1;
    } catch (error) {
      result.failures += 1;
      const outcome = await failShippingPolicyJob({
        job: task,
        error,
        now: new Date(),
      });
      if (outcome === "manual_review") {
        result.tasksManualReview += 1;
        await sendShippingPolicyAlert({
          duties: ["operations_lead"],
          critical: true,
          subject: `Shipping policy task requires manual review: ${task.type}`,
          message: `Task ${task.id} exhausted its retry policy. Review the durable task evidence before resuming automation.`,
          idempotencyKey: `shipping-policy-task-manual/${task.id}`,
        }).catch(() => undefined);
      }
    }
  }
  return result;
}

type PolicyLeaseCheckpoint = () => Promise<void>;

async function withShippingPolicyJobLease<T>(
  task: ClaimedShippingPolicyJob,
  work: (checkpoint: PolicyLeaseCheckpoint) => Promise<T>,
): Promise<T> {
  let lost = false;
  let renewal: Promise<void> | null = null;
  const checkpoint = (): Promise<void> => {
    if (lost)
      return Promise.reject(new Error("Shipping policy task lease was lost"));
    if (renewal) return renewal;
    renewal = (async () => {
      if (!(await renewShippingPolicyJobLease(task, new Date()))) {
        lost = true;
        throw new Error("Shipping policy task lease was lost");
      }
    })().finally(() => {
      renewal = null;
    });
    return renewal;
  };
  await checkpoint();
  const heartbeat = setInterval(() => {
    void checkpoint().catch(() => undefined);
  }, 60_000);
  heartbeat.unref?.();
  try {
    const value = await work(checkpoint);
    await checkpoint();
    return value;
  } finally {
    clearInterval(heartbeat);
  }
}

const POLICY_SHIPMENT_PAGE_SIZE = 100;

async function* listPolicyShipmentPages(): AsyncGenerator<ShipmentAndOrder[]> {
  let afterId: string | null = null;
  for (;;) {
    const page = await getPrivateDb()
      .select({ shipment: productShipments, order: checkoutOrders })
      .from(productShipments)
      .innerJoin(
        checkoutOrders,
        eq(productShipments.orderId, checkoutOrders.id),
      )
      .where(
        and(
          or(
            inArray(productShipments.status, [
              "ready_for_staff",
              "purchase_pending",
              "label_ready",
              "accepted",
              "in_transit",
              "exception",
              "manual_review",
            ]),
            and(
              eq(productShipments.status, "delivered"),
              isNotNull(productShipments.deliveredAt),
              isNotNull(productShipments.latestEstimatedDeliveryAt),
              gte(checkoutOrders.shippingAmountCents, 100),
            ),
          ),
          afterId ? gt(productShipments.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(productShipments.id))
      .limit(POLICY_SHIPMENT_PAGE_SIZE);
    if (!page.length) return;
    yield page;
    afterId = page.at(-1)!.shipment.id;
    if (page.length < POLICY_SHIPMENT_PAGE_SIZE) return;
  }
}

async function processPolicyTask(
  task: ClaimedShippingPolicyJob,
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
  result: ShippingPolicyWorkerResult,
  checkpoint: PolicyLeaseCheckpoint,
): Promise<void> {
  await checkpoint();
  switch (task.type) {
    case "deadlines":
      for await (const shipments of listPolicyShipmentPages()) {
        for (const row of shipments) {
          await checkpoint();
          if (row.shipment.status === "manual_review")
            await handleManualReview(row, policy, now, result);
          if (
            !row.shipment.acceptedAt &&
            row.shipment.originalHandoffDeadlineAt &&
            row.shipment.originalHandoffDeadlineAt <= now
          )
            await handleMissedHandoff(row, policy.mode, now, result);
          await handleDelayAndLoss(row, policy, now, result);
          await handleLateDelivery(row, policy);
        }
      }
      await enforceP10Termination(now, checkpoint);
      return;
    case "decisions":
      await expireCustomerDecisions(now, policy.mode, result);
      await processSelectedCustomerDecisions(policy.mode);
      return;
    case "remedies":
      await ensureRemedyDecisions(policy, now);
      return;
    case "refunds":
      await processQueuedRefunds(policy.mode, result, checkpoint);
      await alertUnknownRefunds();
      return;
    case "returns":
      await pollReturns(policy.mode, result);
      return;
    case "claims":
      await alertClaimDeadlines(policy, now);
      await alertServicePolicyReviews(now);
      return;
    case "funding":
      await recordThirtyDayFundingReview(policy, now);
      await alertFundingControls(policy);
      return;
    case "calendar":
      await alertCalendarCoverage(policy, now);
      return;
    case "privacy":
      await alertPrivacyOverdue(now);
      return;
    case "notifications":
      await sendBlockedFulfillmentUpdates(policy, now);
  }
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
  if (
    mode === "enforce" &&
    row.shipment.autoRefundDeadlineAt &&
    row.shipment.autoRefundDeadlineAt > now
  ) {
    const [existing] = await getPrivateDb()
      .select({ id: productOrderCustomerDecisions.id })
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(productOrderCustomerDecisions.orderId, row.order.id),
          eq(productOrderCustomerDecisions.shipmentId, row.shipment.id),
          eq(productOrderCustomerDecisions.kind, "missed_handoff"),
          eq(productOrderCustomerDecisions.status, "pending"),
          eq(
            productOrderCustomerDecisions.scopeKey,
            `missed_handoff/${row.shipment.id}/${row.shipment.autoRefundDeadlineAt.toISOString()}`,
          ),
        ),
      )
      .limit(1);
    if (!existing && row.shipment.autoRefundDeadlineAt) {
      await issueCustomerDecision({
        orderReference: row.order.orderId,
        shipmentId: row.shipment.id,
        kind: "missed_handoff",
        scopeKey: `missed_handoff/${row.shipment.id}/${row.shipment.autoRefundDeadlineAt.toISOString()}`,
        allowedOutcomes: ["refund", "wait"],
        proposedConditions: {
          waitUntil: businessDeadline(
            row.shipment.autoRefundDeadlineAt,
            policyWaitExtensionBusinessDays(),
            await loadShippingPolicyContext(now),
          ).toISOString(),
        },
        expiresAt: row.shipment.autoRefundDeadlineAt,
        notificationOrigin: publicOrigin(),
      });
    }
    if (!row.shipment.customerNotifiedAt)
      await getPrivateDb()
        .update(productShipments)
        .set({ customerNotifiedAt: now, updatedAt: now })
        .where(eq(productShipments.id, row.shipment.id));
  }
  if (
    row.shipment.autoRefundDeadlineAt &&
    row.shipment.autoRefundDeadlineAt <= now
  ) {
    const [fresh] = await getPrivateDb()
      .select({
        deadline: productShipments.autoRefundDeadlineAt,
        acceptedAt: productShipments.acceptedAt,
      })
      .from(productShipments)
      .where(
        and(
          eq(productShipments.id, row.shipment.id),
          eq(productShipments.orderId, row.order.id),
        ),
      )
      .limit(1);
    const supplementalExempt = await hasOpenAddressSupplement(row.order.id);
    if (
      mode === "enforce" &&
      !fresh?.acceptedAt &&
      fresh?.deadline &&
      fresh.deadline <= now &&
      !supplementalExempt
    )
      await queueFullRefund(
        row.order.orderId,
        "Automatic refund after missed carrier handoff",
      );
  }
  result.handoffMisses += 1;
}

async function hasOpenAddressSupplement(orderId: string): Promise<boolean> {
  const [row] = await getPrivateDb()
    .select({ id: productOrderAddressChangeRequests.id })
    .from(productOrderAddressChangeRequests)
    .where(
      and(
        eq(productOrderAddressChangeRequests.orderId, orderId),
        eq(productOrderAddressChangeRequests.customerCaused, true),
        eq(productOrderAddressChangeRequests.status, "approved"),
        sql`(
          coalesce(${productOrderAddressChangeRequests.postageDifferenceCents}, 0) > 0
          or ${productOrderAddressChangeRequests.supplementalObligationId} is not null
          or ${productOrderAddressChangeRequests.reconciliationState} in (
            'awaiting_supplemental_payment',
            'not_started'
          )
        )`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

function policyWaitExtensionBusinessDays(): number {
  return 2;
}

async function ensureRemedyDecisions(
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
  now: Date,
): Promise<void> {
  if (policy.mode !== "enforce") return;
  let afterCaseId: string | null = null;
  for (;;) {
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
          isNull(productShippingCases.fulfillmentQuarantinedAt),
          afterCaseId ? gt(productShippingCases.id, afterCaseId) : undefined,
        ),
      )
      .orderBy(asc(productShippingCases.id))
      .limit(100);
    if (!cases.length) return;
    afterCaseId = cases.at(-1)!.caseId;
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
      const decisionTerms = lossDamageRemedyDecisionTerms({
        caseId: entry.caseId,
        remedyDeadlineAt: expiresAt,
      });
      await issueCustomerDecision({
        orderReference: entry.orderReference,
        caseId: entry.caseId,
        kind: "loss_damage_remedy",
        ...decisionTerms,
        allowedOutcomes: ["refund", "replacement"],
        expiresAt,
        notificationOrigin: publicOrigin(),
      });
      await getPrivateDb()
        .update(productShippingCases)
        .set({
          status: "waiting_customer",
          remedyDeadlineAt: expiresAt,
          stateVersion: sql`${productShippingCases.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(productShippingCases.id, entry.caseId));
    }
    if (cases.length < 100) return;
  }
}

async function processSelectedCustomerDecisions(
  mode: "off" | "observe" | "enforce",
): Promise<void> {
  if (mode !== "enforce") return;
  let afterDecisionId: string | null = null;
  for (;;) {
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
      .where(
        and(
          eq(productOrderCustomerDecisions.status, "selected"),
          isNull(productOrderCustomerDecisions.processedAt),
          afterDecisionId
            ? gt(productOrderCustomerDecisions.id, afterDecisionId)
            : undefined,
        ),
      )
      .orderBy(asc(productOrderCustomerDecisions.id))
      .limit(100);
    if (!decisions.length) return;
    afterDecisionId = decisions.at(-1)!.id;
    for (const decision of decisions) {
      if (decision.outcome !== "refund") continue;
      await queueFullRefund(
        decision.orderReference,
        "Customer selected refund under shipping policy",
        decision.caseId ?? undefined,
      );
      const now = new Date();
      await getPrivateDb()
        .update(productOrderCustomerDecisions)
        .set({ consumedAt: now, processedAt: now, updatedAt: now })
        .where(
          and(
            eq(productOrderCustomerDecisions.id, decision.id),
            isNull(productOrderCustomerDecisions.processedAt),
          ),
        );
      if (decision.caseId)
        await getPrivateDb()
          .update(productShippingCases)
          .set({
            remedyChoice: "refund",
            status: "remedy_pending",
            stateVersion: sql`${productShippingCases.stateVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(productShippingCases.id, decision.caseId),
              isNull(productShippingCases.fulfillmentQuarantinedAt),
            ),
          );
    }
    if (decisions.length < 100) return;
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
    const claimWindow = shippingClaimWindow({
      providerShipDateAt: row.shipment.providerShipDateAt,
      purchasedAt: row.shipment.purchasedAt,
      waitingDays: service?.claimWaitingDays ?? 0,
      deadlineDays: service?.claimDeadlineDays ?? 0,
    });
    if (service && claimWindow) {
      const lossEligible = claimWindow.eligibleAt;
      if (lossEligible <= now) {
        await openProductShippingCase({
          orderId: row.order.id,
          shipmentId: row.shipment.id,
          type: "loss",
          cause: "service_policy_claim_window_open",
          eligibleAt: lossEligible,
          carrierDeadlineAt: claimWindow.deadlineAt,
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
        orderDatabaseId: row.order.id,
        orderReference: row.order.orderId,
        subject: "Delayed shipment update",
        message:
          "Your shipment is delayed. We are monitoring it and will update you again within two business days.",
        idempotencyKey: `shipping-delay-update/${delay.id}/${delay.customerUpdateDueAt.toISOString()}`,
        now,
      });
      await getPrivateDb()
        .update(productShippingCases)
        .set({
          customerUpdateDueAt: businessDeadline(now, 2, policy),
          stateVersion: sql`${productShippingCases.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(productShippingCases.id, delay.id));
    }
  }
}

export function shippingClaimWindow(input: {
  providerShipDateAt: Date | null;
  purchasedAt: Date | null;
  waitingDays: number;
  deadlineDays: number;
}): { eligibleAt: Date; deadlineAt: Date } | null {
  if (
    !input.providerShipDateAt ||
    !input.purchasedAt ||
    !Number.isInteger(input.waitingDays) ||
    input.waitingDays < 0 ||
    !Number.isInteger(input.deadlineDays) ||
    input.deadlineDays <= 0
  )
    return null;
  return {
    eligibleAt: new Date(
      input.providerShipDateAt.getTime() + input.waitingDays * 24 * 60 * 60_000,
    ),
    deadlineAt: new Date(
      input.purchasedAt.getTime() + input.deadlineDays * 24 * 60 * 60_000,
    ),
  };
}

async function handleLateDelivery(
  row: ShipmentAndOrder,
  policy: Awaited<ReturnType<typeof loadShippingPolicyContext>>,
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
    if (existing || row.order.status === "refunded") return;
    await queueProductOrderRefund({
      orderReference: row.order.orderId,
      amountCents: row.order.shippingAmountCents,
      component: "outbound_shipping",
      reason,
      automated: true,
    });
  }
}

async function expireCustomerDecisions(
  now: Date,
  mode: "off" | "observe" | "enforce",
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  if (mode !== "enforce") return;
  const expired = await expirePendingCustomerDecisions(now);
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
    if (row && ["loss", "damage"].includes(row.type)) {
      await queueFullRefund(
        row.orderReference,
        "No response to loss or damage remedy choice",
        decision.caseId,
      );
      await getPrivateDb()
        .update(productShippingCases)
        .set({
          remedyChoice: "refund",
          status: "remedy_pending",
          stateVersion: sql`${productShippingCases.stateVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(productShippingCases.id, decision.caseId),
            inArray(productShippingCases.status, [
              "open",
              "waiting_customer",
              "waiting_provider",
              "remedy_pending",
            ]),
            isNull(productShippingCases.fulfillmentQuarantinedAt),
          ),
        );
    }
  }
  result.refundsProcessed += 0;
}

async function processQueuedRefunds(
  mode: "off" | "observe" | "enforce",
  result: ShippingPolicyWorkerResult,
  checkpoint: PolicyLeaseCheckpoint = async () => undefined,
): Promise<void> {
  if (mode !== "enforce") return;
  const queued = await getPrivateDb()
    .select({ id: productOrderRefunds.id })
    .from(productOrderRefunds)
    .where(eq(productOrderRefunds.status, "queued"))
    .orderBy(asc(productOrderRefunds.createdAt))
    .limit(25);
  for (const row of queued) {
    await checkpoint();
    try {
      const refund = await processProductOrderRefund(row.id);
      if (refund.status === "succeeded") result.refundsProcessed += 1;
      if (refund.status === "manual_review") {
        result.failures += 1;
        await sendShippingPolicyAlert({
          duties: ["finance_owner"],
          critical: true,
          subject: "Helcim refund requires manual review",
          message: `Refund ${row.id} has invalid or incomplete immutable payment evidence and was removed from the automatic queue.`,
          idempotencyKey: `shipping-refund-manual-review/${row.id}`,
        });
      }
      if (refund.status === "outcome_unknown") {
        result.failures += 1;
        await sendShippingPolicyAlert({
          duties: ["finance_owner"],
          critical: true,
          subject: "Helcim refund outcome is unknown",
          message: `Refund ${row.id} requires transaction reconciliation; do not resubmit it.`,
          idempotencyKey: `shipping-refund-unknown/${row.id}`,
        });
      }
    } catch {
      result.failures += 1;
      await sendShippingPolicyAlert({
        duties: ["finance_owner"],
        critical: true,
        subject: "Helcim refund worker failed",
        message: `Refund ${row.id} could not be processed. Later queued refunds were still attempted.`,
        idempotencyKey: `shipping-refund-worker-failed/${row.id}`,
      });
    }
  }
  await resolveSettledInventoryUnavailableRefundCases();
}

async function pollReturns(
  mode: "off" | "observe" | "enforce",
  result: ShippingPolicyWorkerResult,
): Promise<void> {
  if (mode === "off") return;
  const returns = await listAllReturns();
  for (const item of returns) {
    const providerShipmentId = item.original_shipment?.id;
    if (!item.id) continue;
    if (mode === "observe") {
      result.returnsObserved += 1;
      continue;
    }
    const [shipment] = await getPrivateDb()
      .select({ id: productShipments.id, orderId: productShipments.orderId })
      .from(productShipments)
      .where(
        eq(
          productShipments.providerShipmentId,
          providerShipmentId ?? "missing",
        ),
      )
      .limit(1);
    const providerUpdatedAt = item.updated_at
      ? new Date(item.updated_at)
      : null;
    const normalizedProviderUpdatedAt =
      providerUpdatedAt && !Number.isNaN(providerUpdatedAt.getTime())
        ? providerUpdatedAt
        : null;
    let shippingCase: { id: string } | null = null;
    let matchStatus: "matched" | "unmatched" | "manual_review" =
      shipment?.orderId ? "matched" : "unmatched";
    if (shipment?.orderId) {
      try {
        const mappedReturn = mapChitChatsReturnReason(item.return_reason);
        shippingCase = await openProductShippingCase({
          orderId: shipment.orderId,
          shipmentId: shipment.id,
          type: mappedReturn.type,
          cause: mappedReturn.cause,
        });
      } catch {
        matchStatus = "manual_review";
        result.failures += 1;
      }
    }
    await getPrivateDb()
      .insert(productShipmentReturnObservations)
      .values({
        providerReturnId: item.id,
        shipmentId: shipment?.id,
        providerShipmentId,
        matchStatus,
        caseId: shippingCase?.id,
        providerStatus: item.status,
        returnReason: item.return_reason,
        resolution: item.resolution,
        rawPayload: null,
        observedAt: new Date(),
        providerUpdatedAt: normalizedProviderUpdatedAt,
      })
      .onConflictDoUpdate({
        target: productShipmentReturnObservations.providerReturnId,
        set: {
          shipmentId: shipment?.id ?? null,
          providerShipmentId: providerShipmentId ?? null,
          matchStatus,
          caseId: shippingCase?.id ?? null,
          providerStatus: item.status,
          returnReason: item.return_reason,
          resolution: item.resolution,
          rawPayload: null,
          providerUpdatedAt: normalizedProviderUpdatedAt,
          stateVersion: sql`${productShipmentReturnObservations.stateVersion} + 1`,
          updatedAt: new Date(),
        },
        setWhere: sql`
          ${productShipmentReturnObservations.shipmentId} is distinct from ${shipment?.id ?? null}
          or ${productShipmentReturnObservations.providerShipmentId} is distinct from ${providerShipmentId ?? null}
          or ${productShipmentReturnObservations.matchStatus} is distinct from ${matchStatus}
          or ${productShipmentReturnObservations.caseId} is distinct from ${shippingCase?.id ?? null}
          or ${productShipmentReturnObservations.providerStatus} is distinct from ${item.status ?? null}
          or ${productShipmentReturnObservations.returnReason} is distinct from ${item.return_reason ?? null}
          or ${productShipmentReturnObservations.resolution} is distinct from ${item.resolution ?? null}
          or ${productShipmentReturnObservations.providerUpdatedAt} is distinct from ${normalizedProviderUpdatedAt}
        `,
      });
    result.returnsObserved += 1;
  }
}

async function listAllReturns() {
  const client = createChitChatsClient(getChitChatsConfig());
  const all: Awaited<ReturnType<typeof client.listReturns>> = [];
  for (let page = 1; page <= 20; page += 1) {
    const items = await client.listReturns(page);
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error("Chit Chats returns pagination exceeded the safety cap");
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
      total: sql<number>`coalesce(sum(coalesce(${productShipments.actualPurchaseTotalCents}, ${productShipments.actualPostageCents} + coalesce(${productShipments.actualInsuranceCents}, 0), 0)), 0)`,
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
  let afterCaseId: string | null = null;
  for (;;) {
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
          isNull(productShippingCases.fulfillmentQuarantinedAt),
          lte(productShippingCases.carrierDeadlineAt, warningCutoff),
          afterCaseId ? gt(productShippingCases.id, afterCaseId) : undefined,
        ),
      )
      .orderBy(asc(productShippingCases.id))
      .limit(100);
    if (!cases.length) return;
    afterCaseId = cases.at(-1)!.id;
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
    if (cases.length < 100) return;
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

export async function enforceP10Termination(
  now: Date,
  checkpoint: PolicyLeaseCheckpoint = async () => undefined,
): Promise<void> {
  await runP10TerminationWorkflow(now, checkpoint);
}

async function alertUnknownRefunds(): Promise<void> {
  let afterRefundId: string | null = null;
  for (;;) {
    const refunds = await getPrivateDb()
      .select({ id: productOrderRefunds.id })
      .from(productOrderRefunds)
      .where(
        and(
          eq(productOrderRefunds.status, "outcome_unknown"),
          afterRefundId ? gt(productOrderRefunds.id, afterRefundId) : undefined,
        ),
      )
      .orderBy(asc(productOrderRefunds.id))
      .limit(100);
    if (!refunds.length) return;
    afterRefundId = refunds.at(-1)!.id;
    for (const refund of refunds)
      await sendShippingPolicyAlert({
        duties: ["finance_owner"],
        critical: true,
        subject: "Helcim refund outcome is unknown",
        message: `Refund ${refund.id} requires signed-webhook or transaction reconciliation. Do not submit a new refund.`,
        idempotencyKey: `shipping-refund-unknown/${refund.id}`,
      });
    if (refunds.length < 100) return;
  }
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
      orderDatabaseId: checkoutOrders.id,
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
        isNull(productShippingCases.fulfillmentQuarantinedAt),
        lte(productShippingCases.customerUpdateDueAt, now),
      ),
    )
    .limit(100);
  for (const entry of cases) {
    if (!entry.dueAt) continue;
    await sendShippingCustomerUpdate({
      to: entry.email,
      orderDatabaseId: entry.orderDatabaseId,
      orderReference: entry.orderReference,
      subject: "Shipping fulfillment update",
      message:
        "Your order remains under shipping review. We are not retrying an uncertain carrier charge and will send another update within one business day unless it is resolved sooner.",
      idempotencyKey: `shipping-blocked-update/${entry.caseId}/${entry.dueAt.toISOString()}`,
      now,
    });
    await getPrivateDb()
      .update(productShippingCases)
      .set({
        customerUpdateDueAt: businessDeadline(now, 1, policy),
        stateVersion: sql`${productShippingCases.stateVersion} + 1`,
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
  const coverageEnd = policy.calendarCoverageEndsAt
    ? new Date(`${policy.calendarCoverageEndsAt}T23:59:59Z`)
    : new Date(0);
  const remainingMs = coverageEnd.getTime() - now.getTime();
  if (policy.calendarCoverageSufficient) return;
  const critical = remainingMs <= 60 * 24 * 60 * 60_000;
  await sendShippingPolicyAlert({
    duties: ["operations_lead"],
    critical,
    subject: critical
      ? "Shipping calendar coverage is near exhaustion"
      : "Shipping calendar coverage is below 21 months",
    message: `Calendar exceptions are configured only through ${policy.calendarCoverageEndsAt || "no future date"}. Add statutory, observed, and branch-closure dates; checkout readiness requires at least 21 months. Existing deadline snapshots remain unchanged.`,
    idempotencyKey: `shipping-calendar-coverage/${policy.calendarCoverageEndsAt || "missing"}/${critical ? "urgent" : "warning"}`,
  });
}

async function queueFullRefund(
  orderReference: string,
  reason: string,
  caseId?: string,
): Promise<void> {
  await queueProductOrderRefundAllocations({
    orderReference,
    reason,
    caseId,
    automated: true,
  });
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
