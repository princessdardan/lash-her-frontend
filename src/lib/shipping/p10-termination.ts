import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  fulfillmentPolicyVersions,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAddressChangeRequests,
  productOrderAdjustments,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productOrderTerminationWorkflows,
  productPaymentRiskIncidents,
  productShipmentJobs,
  productShipments,
  productShippingCases,
} from "@/lib/private-db/schema";

import { queueProductOrderRefundAllocationsInTransaction } from "./customer-refunds";
import {
  sendShippingCustomerUpdate,
  sendShippingPolicyAlert,
} from "./policy-alerts";

const DAY_MS = 24 * 60 * 60_000;
const P10_WARNING_DAYS = 335;
const P10_NOTICE_DAYS = 350;
const P10_EXECUTION_DAYS = 360;
const P10_HARD_CAP_DAYS = 365;
const P10_LEASE_MS = 5 * 60_000;

type PolicyLeaseCheckpoint = () => Promise<void>;

interface P10PolicyAmendment {
  version: string;
  noticeDays: number;
  executionDays: number;
  hardCapDays: number;
}

export async function runP10TerminationWorkflow(
  now: Date,
  checkpoint: PolicyLeaseCheckpoint = async () => undefined,
): Promise<void> {
  const policy = await loadP10PolicyAmendment(now);
  await discoverAndScheduleP10Orders(now, policy, checkpoint);
  await processDueP10Terminations(now, checkpoint);
  await reconcileP10Terminations(now, checkpoint);
}

async function loadP10PolicyAmendment(now: Date): Promise<P10PolicyAmendment> {
  const [policy] = await getPrivateDb()
    .select({
      version: fulfillmentPolicyVersions.version,
      policySnapshot: fulfillmentPolicyVersions.policySnapshot,
    })
    .from(fulfillmentPolicyVersions)
    .where(
      and(
        eq(fulfillmentPolicyVersions.status, "effective"),
        lte(fulfillmentPolicyVersions.effectiveAt, now),
        isNull(fulfillmentPolicyVersions.supersededAt),
      ),
    )
    .limit(1);
  const snapshot = policy?.policySnapshot;
  const amendment = policy
    ? parseP10PolicyAmendment(policy.version, snapshot)
    : null;
  if (!amendment) {
    throw new Error(
      "The effective fulfillment policy does not contain the approved P-10 pre-cap execution amendment",
    );
  }
  return amendment;
}

export function parseP10PolicyAmendment(
  version: string,
  snapshot: Record<string, unknown>,
): P10PolicyAmendment | null {
  const noticeDays = readInteger(snapshot.p10TerminationNoticeDays);
  const executionDays = readInteger(snapshot.p10DefaultExecutionDays);
  const hardCapDays = readInteger(snapshot.p10HardCapDays);
  if (
    noticeDays !== P10_NOTICE_DAYS ||
    executionDays !== P10_EXECUTION_DAYS ||
    hardCapDays !== P10_HARD_CAP_DAYS
  )
    return null;
  return { version, noticeDays, executionDays, hardCapDays };
}

export async function p10TerminationBlocksOrderInTransaction(
  tx: PrivateDbTransaction,
  orderId: string,
  now: Date,
): Promise<boolean> {
  const [workflow] = await tx
    .select({
      status: productOrderTerminationWorkflows.status,
      executeAt: productOrderTerminationWorkflows.executeAt,
    })
    .from(productOrderTerminationWorkflows)
    .where(eq(productOrderTerminationWorkflows.orderId, orderId))
    .limit(1);
  if (!workflow || workflow.status === "cancelled") return false;
  return workflow.status !== "scheduled" || workflow.executeAt <= now;
}

export async function p10TerminationBlocksShipmentPurchase(
  shipmentId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await getPrivateDb()
    .select({
      status: productOrderTerminationWorkflows.status,
      executeAt: productOrderTerminationWorkflows.executeAt,
    })
    .from(productShipments)
    .innerJoin(
      productOrderTerminationWorkflows,
      eq(productOrderTerminationWorkflows.orderId, productShipments.orderId),
    )
    .where(eq(productShipments.id, shipmentId))
    .limit(1);
  if (!row || row.status === "cancelled") return false;
  return row.status !== "scheduled" || row.executeAt <= now;
}

async function discoverAndScheduleP10Orders(
  now: Date,
  policy: P10PolicyAmendment,
  checkpoint: PolicyLeaseCheckpoint,
): Promise<void> {
  const warningCutoff = new Date(now.getTime() - P10_WARNING_DAYS * DAY_MS);
  const orders = await getPrivateDb()
    .select({
      id: checkoutOrders.id,
      orderReference: checkoutOrders.orderId,
      customerEmail: checkoutOrders.customerEmail,
      createdAt: checkoutOrders.createdAt,
      redactedAt: checkoutOrders.redactedAt,
    })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.purpose, "product"),
        inArray(checkoutOrders.status, ["paid", "refunded", "cancelled"]),
        lte(checkoutOrders.createdAt, warningCutoff),
        unresolvedOrderPredicate(),
      ),
    )
    .orderBy(asc(checkoutOrders.createdAt), asc(checkoutOrders.id));

  for (const order of orders) {
    await checkpoint();
    const noticeAt = addDays(order.createdAt, policy.noticeDays);
    const executeAt = addDays(order.createdAt, policy.executionDays);
    const hardCapAt = addDays(order.createdAt, policy.hardCapDays);
    if (now < noticeAt) {
      await sendShippingPolicyAlert({
        duties: ["operations_lead", "privacy_owner"],
        subject: `P-10 335-day warning: ${order.orderReference}`,
        message:
          "This order must be fulfilled, restored to its original safe address, or resolved under the approved pre-cap refund schedule.",
        idempotencyKey: `shipping-p10/${order.id}/335`,
        now,
      });
      continue;
    }

    await getPrivateDb().transaction(async (tx) => {
      const [workflow] = await tx
        .insert(productOrderTerminationWorkflows)
        .values({
          orderId: order.id,
          policyVersion: policy.version,
          noticeAt,
          executeAt,
          hardCapAt,
        })
        .onConflictDoNothing({
          target: productOrderTerminationWorkflows.orderId,
        })
        .returning({ id: productOrderTerminationWorkflows.id });
      if (!workflow) return;

      const canNotifyCustomer = !order.redactedAt && now < hardCapAt;
      if (canNotifyCustomer) {
        await sendShippingCustomerUpdate({
          to: order.customerEmail,
          orderReference: order.orderReference,
          subject: "Order resolution and privacy deadline",
          message: `Your unresolved order is approaching its privacy deadline. If it is not fulfilled or restored to the original safe address, automatic full-refund and cancellation processing will begin on ${executeAt.toISOString().slice(0, 10)} under policy ${policy.version}.`,
          idempotencyKey: `shipping-p10-customer-notice/${workflow.id}`,
          orderDatabaseId: order.id,
          now,
          executor: tx,
        });
      }
      await sendShippingPolicyAlert({
        duties: ["business_owner", "operations_lead", "privacy_owner"],
        critical: true,
        subject: `P-10 pre-cap termination scheduled: ${order.orderReference}`,
        message: `Default full-refund processing is scheduled for ${executeAt.toISOString()} and the unconditional PII hard cap remains ${hardCapAt.toISOString()}.`,
        idempotencyKey: `shipping-p10-owner-notice/${workflow.id}`,
        now,
        executor: tx,
      });
      await tx
        .update(productOrderTerminationWorkflows)
        .set({
          customerNoticeQueuedAt: canNotifyCustomer ? now : null,
          ownerNoticeQueuedAt: now,
          lastErrorCode: canNotifyCustomer
            ? null
            : "CUSTOMER_NOTICE_WINDOW_MISSED",
          updatedAt: now,
        })
        .where(eq(productOrderTerminationWorkflows.id, workflow.id));
    });
  }
}

async function processDueP10Terminations(
  now: Date,
  checkpoint: PolicyLeaseCheckpoint,
): Promise<void> {
  const claimed = await claimDueP10Workflows(now);
  for (const workflow of claimed) {
    await checkpoint();
    try {
      await reserveP10Refunds(workflow, now);
    } catch (error) {
      await failP10Workflow(workflow, error, now);
    }
  }
}

async function claimDueP10Workflows(now: Date) {
  const leaseOwner = `p10/${randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + P10_LEASE_MS);
  return getPrivateDb().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: productOrderTerminationWorkflows.id })
      .from(productOrderTerminationWorkflows)
      .where(
        and(
          lte(productOrderTerminationWorkflows.executeAt, now),
          or(
            eq(productOrderTerminationWorkflows.status, "scheduled"),
            and(
              eq(productOrderTerminationWorkflows.status, "processing"),
              lt(productOrderTerminationWorkflows.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(productOrderTerminationWorkflows.executeAt))
      .for("update", { skipLocked: true })
      .limit(100);
    if (!candidates.length) return [];
    return tx
      .update(productOrderTerminationWorkflows)
      .set({
        status: "processing",
        leaseOwner,
        leaseExpiresAt,
        attemptCount: sql`${productOrderTerminationWorkflows.attemptCount} + 1`,
        stateVersion: sql`${productOrderTerminationWorkflows.stateVersion} + 1`,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(
        inArray(
          productOrderTerminationWorkflows.id,
          candidates.map(({ id }) => id),
        ),
      )
      .returning({
        id: productOrderTerminationWorkflows.id,
        orderId: productOrderTerminationWorkflows.orderId,
        leaseOwner: productOrderTerminationWorkflows.leaseOwner,
        stateVersion: productOrderTerminationWorkflows.stateVersion,
      });
  });
}

async function reserveP10Refunds(
  workflow: {
    id: string;
    orderId: string;
    leaseOwner: string | null;
    stateVersion: number;
  },
  now: Date,
): Promise<void> {
  await getPrivateDb().transaction(async (tx) => {
    const [locked] = await tx
      .select({
        workflow: productOrderTerminationWorkflows,
        order: checkoutOrders,
      })
      .from(productOrderTerminationWorkflows)
      .innerJoin(
        checkoutOrders,
        eq(productOrderTerminationWorkflows.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(productOrderTerminationWorkflows.id, workflow.id),
          eq(productOrderTerminationWorkflows.status, "processing"),
          eq(productOrderTerminationWorkflows.leaseOwner, workflow.leaseOwner!),
          eq(
            productOrderTerminationWorkflows.stateVersion,
            workflow.stateVersion,
          ),
          sql`${productOrderTerminationWorkflows.leaseExpiresAt} > now()`,
        ),
      )
      .for("update")
      .limit(1);
    if (!locked) throw new Error("P-10 termination lease was lost");
    if (!(await orderStillRequiresP10Remedy(tx, locked.order.id))) {
      await tx
        .update(productOrderTerminationWorkflows)
        .set({
          status: "cancelled",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(productOrderTerminationWorkflows.id, workflow.id));
      return;
    }
    await fenceP10ShipmentPurchasesInTransaction(tx, locked.order.id, now);
    if (await orderFinanciallyFullyRefunded(tx, locked.order.id)) {
      await terminateOperationalWork(tx, locked.order.id, now);
      await completeP10Workflow(tx, workflow.id, now);
      return;
    }
    const refunds = await queueProductOrderRefundAllocationsInTransaction(tx, {
      orderReference: locked.order.orderId,
      reason: `P-10 pre-cap default termination under ${locked.workflow.policyVersion}`,
      automated: true,
    });
    const status = refundWorkflowStatus(refunds.map((refund) => refund.status));
    await tx
      .update(productOrderTerminationWorkflows)
      .set({
        status,
        refundReservedAt: locked.workflow.refundReservedAt ?? now,
        outcomeUnknownAt: status === "outcome_unknown" ? now : null,
        lastErrorCode:
          status === "manual_review"
            ? "REFUND_MANUAL_REVIEW"
            : status === "outcome_unknown"
              ? "REFUND_OUTCOME_UNKNOWN"
              : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(productOrderTerminationWorkflows.id, workflow.id));
  });
}

async function fenceP10ShipmentPurchasesInTransaction(
  tx: PrivateDbTransaction,
  orderId: string,
  now: Date,
): Promise<void> {
  const purchaseJobs = await tx
    .select({
      job: productShipmentJobs,
      shipment: productShipments,
    })
    .from(productShipmentJobs)
    .innerJoin(
      productShipments,
      eq(productShipmentJobs.shipmentId, productShipments.id),
    )
    .where(
      and(
        eq(productShipments.orderId, orderId),
        eq(productShipmentJobs.type, "purchase"),
        inArray(productShipmentJobs.status, [
          "queued",
          "retryable_failed",
          "processing",
        ]),
      ),
    )
    .for("update");

  for (const { job, shipment } of purchaseJobs) {
    const providerCallMayBeInFlight =
      job.outcomeUnknown ||
      job.outcomeCode === "purchase_provider_call_intent_recorded";
    const providerPurchaseAlreadyPersisted =
      shipment.purchasedAt !== null &&
      shipment.actualPurchaseTotalCents !== null &&
      shipment.actualPurchaseTotalCents > 0;
    const retainForReconciliation =
      providerCallMayBeInFlight || providerPurchaseAlreadyPersisted;

    await tx
      .update(productShipmentJobs)
      .set({
        status: "dead_letter",
        outcomeCode: retainForReconciliation
          ? "p10_purchase_reconciliation_required"
          : "p10_termination_started",
        outcomeUnknown: retainForReconciliation,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: sql`${productShipmentJobs.stateVersion} + 1`,
        fundingReservationStatus:
          job.fundingReservationStatus === "reserved" &&
          !retainForReconciliation
            ? "released"
            : undefined,
        fundingReleasedAt:
          job.fundingReservationStatus === "reserved" &&
          !retainForReconciliation
            ? now
            : undefined,
        updatedAt: now,
      })
      .where(eq(productShipmentJobs.id, job.id));

    if (providerPurchaseAlreadyPersisted) {
      const [refundPending] = await tx
        .update(productShipments)
        .set({
          status: "refund_pending",
          stateVersion: sql`${productShipments.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(productShipments.id, shipment.id))
        .returning({ stateVersion: productShipments.stateVersion });
      if (refundPending) {
        const payload = {
          expectedShipmentStateVersion: refundPending.stateVersion,
        };
        const operationPayloadHash = hashP10OperationPayload(payload);
        const idempotencyKey = `p10-postage-refund/${job.id}`;
        const [createdRefund] = await tx
          .insert(productShipmentJobs)
          .values({
            shipmentId: shipment.id,
            type: "refund",
            status: "queued",
            idempotencyKey,
            operationPayloadHash,
            payload,
            availableAt: now,
          })
          .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
          .returning();
        const durableRefund =
          createdRefund ??
          (await tx.query.productShipmentJobs.findFirst({
            where: eq(productShipmentJobs.idempotencyKey, idempotencyKey),
          }));
        if (
          durableRefund?.shipmentId !== shipment.id ||
          durableRefund.type !== "refund" ||
          durableRefund.operationPayloadHash !== operationPayloadHash
        ) {
          await tx
            .update(productShipments)
            .set({
              status: "manual_review",
              manualReviewStartedAt: sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
              stateVersion: sql`${productShipments.stateVersion} + 1`,
              updatedAt: now,
            })
            .where(eq(productShipments.id, shipment.id));
          continue;
        }
      }
      await tx
        .update(productShipmentJobs)
        .set({
          status: "succeeded",
          outcomeCode: "p10_purchase_settled_refund_queued",
          outcomeUnknown: false,
          fundingReservationStatus: job.fundingAttestationId
            ? "settled"
            : undefined,
          reservedFundingCents: job.fundingAttestationId
            ? shipment.actualPurchaseTotalCents
            : undefined,
          fundingSettledAt: job.fundingAttestationId ? now : undefined,
          fundingReleasedAt: job.fundingAttestationId ? null : undefined,
          updatedAt: now,
        })
        .where(eq(productShipmentJobs.id, job.id));
      continue;
    }

    await tx
      .update(productShipments)
      .set({
        status: retainForReconciliation ? "manual_review" : "abandoned",
        manualReviewStartedAt: retainForReconciliation
          ? sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`
          : undefined,
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, shipment.id),
          isNull(productShipments.purchasedAt),
          inArray(productShipments.status, [
            "quote_pending",
            "quoted",
            "quote_unknown",
            "payment_pending",
            "ready_for_staff",
            "purchase_pending",
            "manual_review",
          ]),
        ),
      );
  }
}

async function reconcileP10Terminations(
  now: Date,
  checkpoint: PolicyLeaseCheckpoint,
): Promise<void> {
  const workflows = await getPrivateDb()
    .select()
    .from(productOrderTerminationWorkflows)
    .where(
      inArray(productOrderTerminationWorkflows.status, [
        "refund_pending",
        "outcome_unknown",
        "manual_review",
      ]),
    )
    .orderBy(asc(productOrderTerminationWorkflows.hardCapAt));
  for (const workflow of workflows) {
    await checkpoint();
    const result = await getPrivateDb().transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(productOrderTerminationWorkflows)
        .where(eq(productOrderTerminationWorkflows.id, workflow.id))
        .for("update")
        .limit(1);
      if (!locked || locked.status === "completed") return null;
      if (await orderFinanciallyFullyRefunded(tx, locked.orderId)) {
        await terminateOperationalWork(tx, locked.orderId, now);
        await completeP10Workflow(tx, locked.id, now);
        return "completed" as const;
      }
      const refundStatuses = await tx
        .select({ status: productOrderRefunds.status })
        .from(productOrderRefunds)
        .where(
          and(
            eq(productOrderRefunds.orderId, locked.orderId),
            isNull(productOrderRefunds.fulfillmentQuarantinedAt),
          ),
        );
      const status = refundWorkflowStatus(
        refundStatuses.map((refund) => refund.status),
      );
      const hardCapReached = now >= locked.hardCapAt;
      if (hardCapReached) {
        await terminateOperationalWork(tx, locked.orderId, now);
      }
      await tx
        .update(productOrderTerminationWorkflows)
        .set({
          status,
          outcomeUnknownAt:
            status === "outcome_unknown"
              ? (locked.outcomeUnknownAt ?? now)
              : locked.outcomeUnknownAt,
          operationallyTerminatedAt: hardCapReached
            ? (locked.operationallyTerminatedAt ?? now)
            : locked.operationallyTerminatedAt,
          lastErrorCode:
            status === "manual_review"
              ? "REFUND_MANUAL_REVIEW"
              : status === "outcome_unknown"
                ? "REFUND_OUTCOME_UNKNOWN"
                : null,
          updatedAt: now,
        })
        .where(eq(productOrderTerminationWorkflows.id, locked.id));
      return hardCapReached || status !== "refund_pending" ? status : null;
    });
    if (result && result !== "completed") {
      await sendShippingPolicyAlert({
        duties: ["business_owner", "finance_owner", "privacy_owner"],
        critical: true,
        subject: `P-10 termination requires reconciliation: ${workflow.id}`,
        message:
          "The order is operationally terminated at the privacy cap, but at least one provider refund still requires reconciliation. PII redaction remains unconditional and no refund may be retried without certified evidence.",
        idempotencyKey: `shipping-p10-reconciliation/${workflow.id}/${now.toISOString().slice(0, 10)}`,
        now,
      });
    }
  }
}

async function failP10Workflow(
  workflow: { id: string; leaseOwner: string | null; stateVersion: number },
  error: unknown,
  now: Date,
): Promise<void> {
  await getPrivateDb()
    .update(productOrderTerminationWorkflows)
    .set({
      status: "manual_review",
      lastErrorCode:
        error instanceof Error
          ? error.message.slice(0, 200)
          : "P10_TERMINATION_FAILED",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(productOrderTerminationWorkflows.id, workflow.id),
        eq(productOrderTerminationWorkflows.leaseOwner, workflow.leaseOwner!),
        eq(
          productOrderTerminationWorkflows.stateVersion,
          workflow.stateVersion,
        ),
      ),
    );
}

async function terminateOperationalWork(
  tx: PrivateDbTransaction,
  orderId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(checkoutOrders)
    .set({ manualFulfillmentStatus: "cancelled", updatedAt: now })
    .where(
      and(
        eq(checkoutOrders.id, orderId),
        inArray(checkoutOrders.fulfillmentMode, [
          "manual_pickup",
          "manual_shipping",
        ]),
      ),
    );
  await tx
    .update(productShippingCases)
    .set({ status: "cancelled", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(productShippingCases.orderId, orderId),
        isNull(productShippingCases.fulfillmentQuarantinedAt),
        inArray(productShippingCases.status, [
          "open",
          "waiting_customer",
          "waiting_provider",
          "remedy_pending",
        ]),
      ),
    );
  await tx
    .update(productShipments)
    .set({ status: "abandoned", updatedAt: now })
    .where(
      and(
        eq(productShipments.orderId, orderId),
        inArray(productShipments.status, [
          "quote_pending",
          "quoted",
          "quote_unknown",
          "payment_pending",
          "ready_for_staff",
          "purchase_pending",
          "label_ready",
          "accepted",
          "in_transit",
          "exception",
          "manual_review",
        ]),
      ),
    );
  await tx
    .update(productOrderAddressChangeRequests)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(productOrderAddressChangeRequests.orderId, orderId),
        inArray(productOrderAddressChangeRequests.status, [
          "pending_customer",
          "submitted",
          "risk_review",
          "approved",
        ]),
      ),
    );
  await tx
    .update(productOrderCustomerDecisions)
    .set({ status: "revoked", processedAt: now, updatedAt: now })
    .where(
      and(
        eq(productOrderCustomerDecisions.orderId, orderId),
        inArray(productOrderCustomerDecisions.status, ["pending", "selected"]),
      ),
    );
  await tx
    .update(orderPaymentObligations)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        eq(orderPaymentObligations.status, "pending"),
      ),
    );
}

async function completeP10Workflow(
  tx: PrivateDbTransaction,
  workflowId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(productOrderTerminationWorkflows)
    .set({
      status: "completed",
      operationallyTerminatedAt: now,
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: now,
    })
    .where(eq(productOrderTerminationWorkflows.id, workflowId));
}

async function orderStillRequiresP10Remedy(
  tx: PrivateDbTransaction,
  orderId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ unresolved: sql<boolean>`${unresolvedOrderPredicate()}` })
    .from(checkoutOrders)
    .where(eq(checkoutOrders.id, orderId))
    .limit(1);
  return row?.unresolved === true;
}

async function orderFinanciallyFullyRefunded(
  tx: PrivateDbTransaction,
  orderId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      transactionCount: sql<number>`count(distinct ${orderPaymentTransactions.id})::int`,
      remainingCount: sql<number>`count(distinct ${orderPaymentTransactions.id}) filter (where coalesce((select sum(r.amount_cents) from ${productOrderRefunds} r where r.payment_transaction_id = ${orderPaymentTransactions.id} and r.status = 'succeeded' and r.fulfillment_quarantined_at is null), 0) < ${orderPaymentTransactions.amountCents})::int`,
    })
    .from(orderPaymentTransactions)
    .innerJoin(
      orderPaymentObligations,
      eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
    )
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        isNull(orderPaymentObligations.quarantinedAt),
      ),
    );
  return (
    Number(row?.transactionCount ?? 0) > 0 &&
    Number(row?.remainingCount ?? 0) === 0
  );
}

function refundWorkflowStatus(statuses: string[]) {
  if (statuses.includes("outcome_unknown")) return "outcome_unknown" as const;
  if (statuses.includes("manual_review") || statuses.includes("failed"))
    return "manual_review" as const;
  return "refund_pending" as const;
}

function unresolvedOrderPredicate() {
  return sql`(
    (
      ${checkoutOrders.fulfillmentMode} in ('manual_pickup', 'manual_shipping')
      and coalesce(${checkoutOrders.manualFulfillmentStatus}, '') in ('payment_pending', 'paid_pending_dispatch')
    )
    or ${checkoutOrders.paymentRiskStatus} in ('pending', 'review_required')
    or exists (select 1 from ${productShipments} s where s.order_id = ${checkoutOrders.id} and s.status not in ('delivered', 'voided', 'abandoned'))
    or exists (select 1 from ${productShippingCases} c where c.order_id = ${checkoutOrders.id} and c.fulfillment_quarantined_at is null and c.status not in ('resolved', 'cancelled'))
    or exists (select 1 from ${productPaymentRiskIncidents} i where i.order_id = ${checkoutOrders.id} and i.status in ('pending', 'review_required'))
    or exists (select 1 from ${orderPaymentObligations} o where o.order_id = ${checkoutOrders.id} and o.quarantined_at is null and o.status in ('pending', 'manual_review'))
    or exists (select 1 from ${productOrderRefunds} r where r.order_id = ${checkoutOrders.id} and r.fulfillment_quarantined_at is null and r.status in ('queued', 'processing', 'outcome_unknown', 'manual_review'))
    or exists (select 1 from ${productOrderAdjustments} a where a.order_id = ${checkoutOrders.id} and a.status in ('pending', 'reserved', 'processing', 'outcome_unknown', 'manual_review'))
    or exists (select 1 from ${productOrderAddressChangeRequests} a where a.order_id = ${checkoutOrders.id} and a.status in ('pending_customer', 'submitted', 'risk_review', 'approved'))
    or exists (select 1 from ${productOrderCustomerDecisions} d where d.order_id = ${checkoutOrders.id} and d.status in ('pending', 'selected'))
    or (
      ${checkoutOrders.status} = 'cancelled'
      and exists (
        select 1
        from ${orderPaymentObligations} o
        join ${orderPaymentTransactions} t on t.obligation_id = o.id
        where o.order_id = ${checkoutOrders.id}
          and o.quarantined_at is null
          and t.provider = 'helcim'
      )
    )
  )`;
}

function readInteger(value: unknown): number | null {
  return Number.isInteger(value) ? Number(value) : null;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function hashP10OperationPayload(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex");
}

type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];
