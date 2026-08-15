import "server-only";

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAdjustments,
  productOrderRefunds,
  productShippingCases,
  productReplacementInventoryAttestations,
  productShipmentJobs,
  productShipments,
  type CheckoutOrderShippingAddressSnapshot,
  type ProductShippingCaseType,
  type ProductShippingCaseStatus,
  type ProductShipmentPurpose,
} from "@/lib/private-db/schema";
import {
  hashShippingQuoteToken,
  parseShippingQuoteContextSnapshot,
} from "./quote-token";
import { issueShippingCustomerToken } from "./customer-token";
import {
  consumeSignedCustomerDecisionWithExecutor,
  lossDamageRemedyDecisionTerms,
} from "./customer-decisions";
import {
  enqueueUnpaidProviderDraftCleanup,
  hashOperationPayload,
} from "./shipment-store";
import type { ChitChatsClient } from "./chitchats-client";
import { getChitChatsConfig } from "./config";
import { loadShippingPolicyContext } from "./policy";
import { selectCustomerRates } from "./rates";
import { hasRecordedCarrierHandoff, stripSignedLabelUrls } from "./status";
import type { ShippingRecipient } from "./types";
import { queueProductOrderRefundAllocationsInTransaction } from "./customer-refunds";
import {
  assertConfiguredFulfillmentOwner,
  assertConfiguredFulfillmentOwnerInTransaction,
} from "./configured-owner";
import {
  assertShippingQuoteContextCurrent,
  lockShippingCheckoutReadinessConfiguration,
} from "./readiness";

export async function openProductShippingCase(input: {
  orderId: string;
  shipmentId?: string;
  type: ProductShippingCaseType;
  cause?: string;
  eligibleAt?: Date;
  carrierDeadlineAt?: Date;
  customerUpdateDueAt?: Date;
  remedyDeadlineAt?: Date;
  createdByAdminUserId?: string;
}) {
  const db = getPrivateDb();
  const activeConditions = [
    eq(productShippingCases.orderId, input.orderId),
    eq(productShippingCases.type, input.type),
    input.shipmentId
      ? eq(productShippingCases.shipmentId, input.shipmentId)
      : isNull(productShippingCases.shipmentId),
    inArray(productShippingCases.status, [
      "open",
      "waiting_customer",
      "waiting_provider",
      "remedy_pending",
    ]),
    isNull(productShippingCases.fulfillmentQuarantinedAt),
  ];
  const [existing] = await db
    .select()
    .from(productShippingCases)
    .where(and(...activeConditions))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(productShippingCases)
    .values({
      ...input,
      sourceShipmentId: input.shipmentId,
      cause: input.cause?.trim().slice(0, 500),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [concurrent] = await db
    .select()
    .from(productShippingCases)
    .where(and(...activeConditions))
    .limit(1);
  if (!concurrent) throw new Error("Shipping case could not be opened");
  return concurrent;
}

export async function openProductShippingCaseAsOperator(input: {
  orderId: string;
  shipmentId?: string;
  type: ProductShippingCaseType;
  cause?: string;
  eligibleAt?: Date;
  carrierDeadlineAt?: Date;
  customerUpdateDueAt?: Date;
  remedyDeadlineAt?: Date;
  actorAdminUserId: string;
}) {
  await assertConfiguredFulfillmentOwner(input.actorAdminUserId);
  return openProductShippingCase({
    orderId: input.orderId,
    shipmentId: input.shipmentId,
    type: input.type,
    cause: input.cause,
    eligibleAt: input.eligibleAt,
    carrierDeadlineAt: input.carrierDeadlineAt,
    customerUpdateDueAt: input.customerUpdateDueAt,
    remedyDeadlineAt: input.remedyDeadlineAt,
    createdByAdminUserId: input.actorAdminUserId,
  });
}

export async function queueInventoryUnavailableRefund(input: {
  caseId: string;
  requestedByAdminUserId: string;
}): Promise<{ id: string; refundOperationIds: string[] }> {
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.requestedByAdminUserId,
    );
    const [row] = await tx
      .select({ shippingCase: productShippingCases, order: checkoutOrders })
      .from(productShippingCases)
      .innerJoin(
        checkoutOrders,
        eq(productShippingCases.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !row ||
      !["loss", "damage"].includes(row.shippingCase.type) ||
      !["waiting_customer", "remedy_pending"].includes(
        row.shippingCase.status,
      ) ||
      row.order.status !== "paid" ||
      row.shippingCase.remedyShipmentId !== null
    )
      throw new Error("Shipping case is not eligible for a full refund remedy");
    const [activeReplacementJob] = await tx
      .select({ id: productShipmentJobs.id })
      .from(productShipmentJobs)
      .where(
        and(
          eq(productShipmentJobs.type, "replacement_prepare"),
          sql`${productShipmentJobs.payload}->>'caseId' = ${row.shippingCase.id}`,
          or(
            inArray(productShipmentJobs.status, [
              "queued",
              "processing",
              "retryable_failed",
            ]),
            and(
              eq(productShipmentJobs.status, "dead_letter"),
              eq(productShipmentJobs.outcomeUnknown, true),
            ),
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (activeReplacementJob)
      throw new Error(
        "Shipping case cannot switch to refund while replacement preparation is active",
      );
    if (
      row.shippingCase.remedyChoice !== null &&
      row.shippingCase.remedyChoice !== "replacement" &&
      row.shippingCase.remedyChoice !== "reshipment" &&
      row.shippingCase.remedyChoice !== "refund_inventory_unavailable"
    )
      throw new Error("Shipping case already has a different refund remedy");
    if (row.shippingCase.remedyChoice !== "refund_inventory_unavailable") {
      const [claimed] = await tx
        .update(productShippingCases)
        .set({
          remedyChoice: "refund_inventory_unavailable",
          status: "remedy_pending",
          stateVersion: row.shippingCase.stateVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(productShippingCases.id, row.shippingCase.id),
            eq(
              productShippingCases.stateVersion,
              row.shippingCase.stateVersion,
            ),
            isNull(productShippingCases.remedyShipmentId),
            isNull(productShippingCases.fulfillmentQuarantinedAt),
          ),
        )
        .returning({ id: productShippingCases.id });
      if (!claimed)
        throw new Error("Shipping case changed during refund selection");
    }
    const reason =
      "Customer selected replacement but inventory was unavailable";
    const refunds = await queueProductOrderRefundAllocationsInTransaction(tx, {
      orderReference: row.order.orderId,
      reason,
      caseId: row.shippingCase.id,
      requestedByAdminUserId: input.requestedByAdminUserId,
      automated: true,
    });
    return {
      id: row.shippingCase.id,
      refundOperationIds: refunds.map((refund) => refund.id),
    };
  });
}

export async function resolveSettledInventoryUnavailableRefundCases(
  now = new Date(),
): Promise<number> {
  const db = getPrivateDb();
  const candidates = await db
    .select({ id: productShippingCases.id })
    .from(productShippingCases)
    .where(
      and(
        eq(productShippingCases.status, "remedy_pending"),
        eq(productShippingCases.remedyChoice, "refund_inventory_unavailable"),
        isNull(productShippingCases.fulfillmentQuarantinedAt),
      ),
    );
  let resolvedCount = 0;
  for (const candidate of candidates) {
    const resolved = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ shippingCase: productShippingCases, order: checkoutOrders })
        .from(productShippingCases)
        .innerJoin(
          checkoutOrders,
          eq(productShippingCases.orderId, checkoutOrders.id),
        )
        .where(eq(productShippingCases.id, candidate.id))
        .for("update")
        .limit(1);
      if (
        !row ||
        row.shippingCase.status !== "remedy_pending" ||
        row.shippingCase.remedyChoice !== "refund_inventory_unavailable" ||
        row.shippingCase.fulfillmentQuarantinedAt !== null
      )
        return false;
      const caseRefunds = await tx
        .select({ status: productOrderRefunds.status })
        .from(productOrderRefunds)
        .where(
          and(
            eq(productOrderRefunds.caseId, row.shippingCase.id),
            isNull(productOrderRefunds.fulfillmentQuarantinedAt),
          ),
        )
        .for("update");
      if (
        !caseRefunds.length ||
        caseRefunds.some((refund) => refund.status !== "succeeded")
      )
        return false;
      await assertShippingCaseRemedyComplete(tx, row);
      const [updated] = await tx
        .update(productShippingCases)
        .set({
          status: "resolved",
          resolvedAt: now,
          stateVersion: row.shippingCase.stateVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShippingCases.id, row.shippingCase.id),
            eq(
              productShippingCases.stateVersion,
              row.shippingCase.stateVersion,
            ),
            eq(productShippingCases.status, "remedy_pending"),
          ),
        )
        .returning({ id: productShippingCases.id });
      return Boolean(updated);
    });
    if (resolved) resolvedCount += 1;
  }
  return resolvedCount;
}

export async function attestReplacementInventory(input: {
  caseId: string;
  productId: string;
  variantId?: string;
  sku: string;
  quantity: number;
  actorAdminUserId: string;
  expiresAt: Date;
}) {
  if (
    !input.productId.trim() ||
    !input.sku.trim() ||
    !Number.isInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.expiresAt <= new Date()
  )
    throw new Error("Inventory attestation is invalid");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [shippingCase] = await tx
      .select({ order: checkoutOrders, case: productShippingCases })
      .from(productShippingCases)
      .innerJoin(
        checkoutOrders,
        eq(productShippingCases.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !shippingCase ||
      !["loss", "damage"].includes(shippingCase.case.type) ||
      !["waiting_customer", "remedy_pending"].includes(
        shippingCase.case.status,
      ) ||
      shippingCase.case.remedyShipmentId
    )
      throw new Error(
        "Replacement inventory can only be attested for an active loss/damage case",
      );
    const productId = input.productId.trim();
    const variantId = input.variantId?.trim() || null;
    const sku = input.sku.trim();
    const line = shippingCase.order.lineItems.find(
      (entry) =>
        entry.productId === productId &&
        (entry.variantId ?? null) === variantId &&
        entry.sku === sku,
    );
    if (!line || line.quantity !== input.quantity)
      throw new Error(
        "Inventory attestation must match an exact purchased line and quantity",
      );
    const [existing] = await tx
      .select({
        id: productReplacementInventoryAttestations.id,
        consumedAt: productReplacementInventoryAttestations.consumedAt,
      })
      .from(productReplacementInventoryAttestations)
      .where(
        and(
          eq(productReplacementInventoryAttestations.caseId, input.caseId),
          eq(productReplacementInventoryAttestations.productId, productId),
          variantId
            ? eq(productReplacementInventoryAttestations.variantId, variantId)
            : isNull(productReplacementInventoryAttestations.variantId),
          eq(productReplacementInventoryAttestations.sku, sku),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.consumedAt)
        throw new Error(
          "Consumed replacement inventory evidence cannot be re-attested",
        );
      const [updated] = await tx
        .update(productReplacementInventoryAttestations)
        .set({
          quantity: input.quantity,
          attestedByAdminUserId: input.actorAdminUserId,
          expiresAt: input.expiresAt,
        })
        .where(
          and(
            eq(productReplacementInventoryAttestations.id, existing.id),
            isNull(productReplacementInventoryAttestations.consumedAt),
          ),
        )
        .returning();
      if (!updated)
        throw new Error("Replacement inventory evidence changed concurrently");
      return updated;
    }
    const [created] = await tx
      .insert(productReplacementInventoryAttestations)
      .values({
        caseId: input.caseId,
        productId,
        variantId,
        sku,
        quantity: input.quantity,
        attestedByAdminUserId: input.actorAdminUserId,
        expiresAt: input.expiresAt,
      })
      .returning();
    return created!;
  });
}

export async function updateProductShippingCase(input: {
  caseId: string;
  actorAdminUserId: string;
  expectedStateVersion: number;
  action: "acknowledge" | "claim" | "inspect" | "resolve";
  cause?: string;
  providerClaimReference?: string;
  evidenceChecklist?: Record<string, boolean>;
  remedyChoice?: string;
}) {
  const now = new Date();
  if (
    !Number.isInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 1
  )
    throw new Error("Shipping case version is required");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [row] = await tx
      .select({ shippingCase: productShippingCases, order: checkoutOrders })
      .from(productShippingCases)
      .innerJoin(
        checkoutOrders,
        eq(productShippingCases.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new Error("Shipping case was not found");
    const current = row.shippingCase;
    if (current.stateVersion !== input.expectedStateVersion)
      throw new Error("Shipping case changed; refresh before retrying");
    const nextStatus = nextOperatorCaseStatus(current.status, input.action);
    if (!nextStatus)
      throw new Error(
        `Shipping case cannot transition from ${current.status} using ${input.action}`,
      );
    if (
      input.action === "inspect" &&
      ["refused", "unclaimed", "return_to_sender"].includes(current.type) &&
      !["customer", "lash_her", "carrier"].includes(input.cause ?? "")
    )
      throw new Error(
        "Return inspection cause must be customer, lash_her, or carrier",
      );
    if (input.action === "claim") {
      const evidence = input.evidenceChecklist ?? {};
      if (
        !current.eligibleAt ||
        current.eligibleAt > now ||
        !current.carrierDeadlineAt ||
        current.carrierDeadlineAt <= now ||
        !input.providerClaimReference?.trim() ||
        ![
          "purchase_receipt",
          "postage_label",
          "tracking_history",
          "item_value",
        ].every((key) => evidence[key] === true)
      )
        throw new Error(
          "Carrier claim is outside its purchase-date window or missing required evidence",
        );
    }
    if (input.action === "resolve") {
      await assertShippingCaseRemedyComplete(tx, {
        shippingCase: current,
        order: row.order,
      });
    }
    const [updated] = await tx
      .update(productShippingCases)
      .set({
        ...(input.cause ? { cause: input.cause.trim().slice(0, 500) } : {}),
        ...(input.providerClaimReference
          ? {
              providerClaimReference: input.providerClaimReference
                .trim()
                .slice(0, 200),
            }
          : {}),
        ...(input.evidenceChecklist || input.action === "inspect"
          ? {
              evidenceChecklist: {
                ...current.evidenceChecklist,
                ...input.evidenceChecklist,
                ...(input.action === "inspect" &&
                ["refused", "unclaimed", "return_to_sender"].includes(
                  current.type,
                )
                  ? { local_inspection: true }
                  : {}),
              },
            }
          : {}),
        ...(input.remedyChoice ? { remedyChoice: input.remedyChoice } : {}),
        ...(input.action === "acknowledge" ? { acknowledgedAt: now } : {}),
        status: nextStatus,
        ...(nextStatus === "resolved" ? { resolvedAt: now } : {}),
        stateVersion: current.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          eq(productShippingCases.status, current.status),
          eq(productShippingCases.stateVersion, current.stateVersion),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .returning();
    if (!updated)
      throw new Error("Shipping case changed; refresh before retrying");
    return updated;
  });
}

type ShippingCaseTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

async function assertShippingCaseRemedyComplete(
  tx: ShippingCaseTransaction,
  input: {
    shippingCase: typeof productShippingCases.$inferSelect;
    order: typeof checkoutOrders.$inferSelect;
  },
): Promise<void> {
  const { shippingCase, order } = input;
  const hasReplacementRemedy =
    shippingCase.remedyShipmentId !== null ||
    shippingCase.remedyChoice === "replacement" ||
    shippingCase.remedyChoice === "reshipment";
  const hasRefundRemedy =
    shippingCase.remedyChoice?.startsWith("refund") ?? false;
  const requiresReturnInspection = [
    "refused",
    "unclaimed",
    "return_to_sender",
  ].includes(shippingCase.type);
  if (requiresReturnInspection) {
    if (
      shippingCase.status !== "remedy_pending" ||
      shippingCase.evidenceChecklist.local_inspection !== true ||
      !["customer", "lash_her", "carrier"].includes(shippingCase.cause ?? "")
    )
      throw new Error(
        "Return case cannot be resolved before local inspection and cause are recorded",
      );
    if (!hasReplacementRemedy && !hasRefundRemedy) return;
  }
  if (
    shippingCase.type === "postage_failure" &&
    !hasReplacementRemedy &&
    !hasRefundRemedy
  ) {
    if (!shippingCase.acknowledgedAt)
      throw new Error(
        "Postage-failure case cannot resolve directly from its open state",
      );
    await assertCaseShipmentReachedCarrierHandoff(tx, {
      shippingCase,
      orderId: order.id,
    });
    return;
  }
  const requiresCompletedRemedy =
    ["loss", "damage"].includes(shippingCase.type) ||
    shippingCase.type === "postage_failure" ||
    hasReplacementRemedy ||
    hasRefundRemedy;
  if (!requiresCompletedRemedy) return;

  if (hasReplacementRemedy) {
    const sourceShipmentId =
      shippingCase.sourceShipmentId ?? shippingCase.shipmentId;
    if (!sourceShipmentId || !shippingCase.remedyShipmentId) {
      throw new Error(
        "Shipping case cannot be resolved before its replacement generation is prepared",
      );
    }
    const shipments = await tx
      .select()
      .from(productShipments)
      .where(
        inArray(productShipments.id, [
          sourceShipmentId,
          shippingCase.remedyShipmentId,
        ]),
      )
      .for("update");
    const source = shipments.find(
      (shipment) => shipment.id === sourceShipmentId,
    );
    const remedy = shipments.find(
      (shipment) => shipment.id === shippingCase.remedyShipmentId,
    );
    if (
      !source ||
      source.orderId !== order.id ||
      !remedy ||
      remedy.orderId !== order.id ||
      !["replacement", "reshipment"].includes(remedy.purpose) ||
      remedy.supersedesShipmentId !== source.id ||
      order.activeFulfillmentShipmentId !== remedy.id ||
      !hasRecordedCarrierHandoff({
        status: remedy.status,
        acceptedAt: remedy.acceptedAt,
      })
    ) {
      throw new Error(
        "Shipping case cannot be resolved before the replacement reaches carrier handoff",
      );
    }
    return;
  }

  if (!hasRefundRemedy) {
    throw new Error(
      "Shipping case cannot be resolved before a replacement or refund remedy is recorded",
    );
  }

  const captures = await tx
    .select({
      transactionId: orderPaymentTransactions.id,
      amountCents: orderPaymentTransactions.amountCents,
      quarantinedAt: orderPaymentObligations.quarantinedAt,
      merchandiseAmountCents: orderPaymentObligations.merchandiseAmountCents,
      shippingAmountCents: orderPaymentObligations.shippingAmountCents,
      taxAmountCents: orderPaymentObligations.taxAmountCents,
    })
    .from(orderPaymentTransactions)
    .innerJoin(
      orderPaymentObligations,
      eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
    )
    .where(eq(orderPaymentObligations.orderId, order.id))
    .for("update");
  if (!captures.length || captures.some((capture) => capture.quarantinedAt)) {
    throw new Error(
      "Shipping case refund cannot be resolved while capture evidence is missing or quarantined",
    );
  }
  const refunds = await tx
    .select()
    .from(productOrderRefunds)
    .where(
      and(
        eq(productOrderRefunds.orderId, order.id),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    )
    .for("update");
  const adjustmentIds = refunds.flatMap((refund) =>
    refund.adjustmentId ? [refund.adjustmentId] : [],
  );
  const adjustments = adjustmentIds.length
    ? await tx
        .select()
        .from(productOrderAdjustments)
        .where(inArray(productOrderAdjustments.id, adjustmentIds))
        .for("update")
    : [];
  const adjustmentById = new Map(
    adjustments.map((adjustment) => [adjustment.id, adjustment]),
  );
  const refundedByTransaction = new Map<string, number>();
  const refundedByTransactionComponent = new Map<string, number>();
  for (const refund of refunds) {
    const adjustment = refund.adjustmentId
      ? adjustmentById.get(refund.adjustmentId)
      : undefined;
    const isCurrentCaseAllocation = refund.caseId === shippingCase.id;
    const isPriorSettledAllocation =
      !isCurrentCaseAllocation && refund.status === "succeeded";
    if (!isCurrentCaseAllocation && !isPriorSettledAllocation) continue;
    if (
      !refund.paymentTransactionId ||
      !adjustment ||
      adjustment.orderId !== order.id ||
      adjustment.direction !== "refund" ||
      adjustment.amountCents !== refund.amountCents
    ) {
      throw new Error(
        "Shipping case refund has an untyped allocation requiring reconciliation",
      );
    }
    if (
      isCurrentCaseAllocation &&
      adjustment.sourceCaseId !== shippingCase.id
    ) {
      throw new Error(
        "Shipping case refund has an untyped allocation requiring reconciliation",
      );
    }
    const settled =
      refund.status === "succeeded" && adjustment.status === "succeeded";
    const handedToManualReview =
      isCurrentCaseAllocation &&
      refund.status === "manual_review" &&
      adjustment.status === "manual_review" &&
      refund.manualReviewRecordedAt !== null &&
      refund.manualReviewByAdminUserId !== null &&
      refund.manualReviewStepUpAuthenticatedAt !== null &&
      refund.manualReviewStepUpAuthenticatedAt <=
        refund.manualReviewRecordedAt &&
      refund.manualReviewStepUpAuthenticatedAt.getTime() >=
        refund.manualReviewRecordedAt.getTime() - 5 * 60_000 &&
      (refund.manualReviewEvidenceReference?.trim().length ?? 0) >= 6 &&
      (refund.manualReviewRationale?.trim().length ?? 0) >= 10;
    if (!settled && !handedToManualReview) {
      throw new Error(
        "Shipping case cannot be resolved while a refund allocation is pending",
      );
    }
    refundedByTransaction.set(
      refund.paymentTransactionId,
      (refundedByTransaction.get(refund.paymentTransactionId) ?? 0) +
        refund.amountCents,
    );
    const componentKey = `${refund.paymentTransactionId}/${adjustment.component}`;
    refundedByTransactionComponent.set(
      componentKey,
      (refundedByTransactionComponent.get(componentKey) ?? 0) +
        refund.amountCents,
    );
  }
  const fullyAllocated = captures.every(
    (capture) =>
      refundedByTransaction.get(capture.transactionId) ===
        capture.amountCents &&
      (refundedByTransactionComponent.get(
        `${capture.transactionId}/merchandise`,
      ) ?? 0) === capture.merchandiseAmountCents &&
      (refundedByTransactionComponent.get(`${capture.transactionId}/tax`) ??
        0) === capture.taxAmountCents &&
      (refundedByTransactionComponent.get(
        `${capture.transactionId}/outbound_shipping`,
      ) ?? 0) === capture.shippingAmountCents,
  );
  if (!fullyAllocated) {
    throw new Error(
      "Shipping case cannot be resolved until every captured payment has a complete refund allocation",
    );
  }
  if (order.status !== "refunded") {
    const [terminalOrder] = await tx
      .update(checkoutOrders)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(
        and(eq(checkoutOrders.id, order.id), eq(checkoutOrders.status, "paid")),
      )
      .returning({ id: checkoutOrders.id });
    if (!terminalOrder)
      throw new Error(
        "Shipping case cannot be resolved until the refund aggregate is terminal",
      );
  }
}

async function assertCaseShipmentReachedCarrierHandoff(
  tx: ShippingCaseTransaction,
  input: {
    shippingCase: typeof productShippingCases.$inferSelect;
    orderId: string;
  },
): Promise<void> {
  const shipmentId =
    input.shippingCase.sourceShipmentId ?? input.shippingCase.shipmentId;
  if (!shipmentId)
    throw new Error(
      "Postage-failure case has no shipment generation to reconcile",
    );
  const [shipment] = await tx
    .select({
      acceptedAt: productShipments.acceptedAt,
      orderId: productShipments.orderId,
      status: productShipments.status,
    })
    .from(productShipments)
    .where(eq(productShipments.id, shipmentId))
    .for("update")
    .limit(1);
  if (
    !shipment ||
    shipment.orderId !== input.orderId ||
    !hasRecordedCarrierHandoff({
      status: shipment.status,
      acceptedAt: shipment.acceptedAt,
    })
  )
    throw new Error(
      "Postage-failure case cannot be resolved before carrier handoff or a complete refund",
    );
}

type OperatorCaseAction = "acknowledge" | "claim" | "inspect" | "resolve";

const ACTIVE_CASE_STATUSES = new Set<ProductShippingCaseStatus>([
  "open",
  "waiting_customer",
  "waiting_provider",
  "remedy_pending",
]);

export function nextOperatorCaseStatus(
  current: ProductShippingCaseStatus,
  action: OperatorCaseAction,
): ProductShippingCaseStatus | null {
  if (!ACTIVE_CASE_STATUSES.has(current)) return null;
  if (action === "acknowledge") return current;
  if (action === "claim")
    return current === "remedy_pending" ? null : "waiting_provider";
  if (action === "inspect") return "remedy_pending";
  return "resolved";
}

export async function createShipmentGeneration(input: {
  caseId: string;
  actorAdminUserId: string;
  purpose: Extract<ProductShipmentPurpose, "replacement" | "reshipment">;
  inventoryAttestationId: string;
}) {
  const now = new Date();
  await assertConfiguredFulfillmentOwner(input.actorAdminUserId);
  const [row] = await getPrivateDb()
    .select({ case: productShippingCases, order: checkoutOrders })
    .from(productShippingCases)
    .innerJoin(
      checkoutOrders,
      eq(productShippingCases.orderId, checkoutOrders.id),
    )
    .where(
      and(
        eq(productShippingCases.id, input.caseId),
        isNull(productShippingCases.fulfillmentQuarantinedAt),
      ),
    )
    .limit(1);
  if (
    !row?.order.shippingAddress ||
    row.order.status !== "paid" ||
    !["loss", "damage"].includes(row.case.type) ||
    !["waiting_customer", "remedy_pending"].includes(row.case.status) ||
    row.case.remedyShipmentId
  )
    throw new Error("Shipping case is not eligible for replacement");
  const sourceShipmentId = row.case.sourceShipmentId ?? row.case.shipmentId;
  if (!sourceShipmentId)
    throw new Error("Replacement case has no bound source shipment");
  const [source] = await getPrivateDb()
    .select()
    .from(productShipments)
    .where(
      and(
        eq(productShipments.id, sourceShipmentId),
        eq(productShipments.orderId, row.order.id),
      ),
    )
    .limit(1);
  if (!source) throw new Error("Replacement source shipment was not found");
  const attestations = await getPrivateDb()
    .select()
    .from(productReplacementInventoryAttestations)
    .where(
      and(
        eq(productReplacementInventoryAttestations.caseId, input.caseId),
        isNull(productReplacementInventoryAttestations.consumedAt),
        gt(productReplacementInventoryAttestations.expiresAt, now),
      ),
    );
  const expectedLines = row.order.lineItems.map(inventoryLineKey).sort();
  const attestedLines = attestations
    .map((entry) => inventoryLineKey(entry))
    .sort();
  if (
    expectedLines.length !== attestedLines.length ||
    expectedLines.some((line, index) => line !== attestedLines[index])
  )
    throw new Error(
      "Current inventory attestations must cover every purchased line and exact quantity",
    );
  if (!row.case.remedyDeadlineAt)
    throw new Error("Replacement case has no immutable remedy deadline");
  const decisionTerms = lossDamageRemedyDecisionTerms({
    caseId: row.case.id,
    remedyDeadlineAt: row.case.remedyDeadlineAt,
  });
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [lockedCase] = await tx
      .select()
      .from(productShippingCases)
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          eq(productShippingCases.stateVersion, row.case.stateVersion),
          isNull(productShippingCases.remedyShipmentId),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lockedCase ||
      !["waiting_customer", "remedy_pending"].includes(lockedCase.status) ||
      (lockedCase.remedyChoice !== null &&
        lockedCase.remedyChoice !== input.purpose)
    )
      throw new Error("Replacement case changed concurrently");
    await assertCaseHasNoRefundAllocations(tx, lockedCase.id);
    const decisionId = await consumeSignedCustomerDecisionWithExecutor(tx, {
      orderId: row.order.id,
      caseId: row.case.id,
      kind: "loss_damage_remedy",
      outcome: "replacement",
      now,
      ...decisionTerms,
    });
    if (!decisionId)
      throw new Error("A current scoped signed replacement remedy is required");
    const consumed = await tx
      .update(productReplacementInventoryAttestations)
      .set({ consumedAt: now })
      .where(
        and(
          inArray(
            productReplacementInventoryAttestations.id,
            attestations.map((entry) => entry.id),
          ),
          isNull(productReplacementInventoryAttestations.consumedAt),
          gt(productReplacementInventoryAttestations.expiresAt, now),
        ),
      )
      .returning({ id: productReplacementInventoryAttestations.id });
    if (consumed.length !== attestations.length)
      throw new Error(
        "Replacement inventory attestations changed concurrently",
      );
    const [updatedCase] = await tx
      .update(productShippingCases)
      .set({
        sourceShipmentId,
        remedyChoice: input.purpose,
        status: "remedy_pending",
        stateVersion: lockedCase.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          eq(productShippingCases.stateVersion, lockedCase.stateVersion),
          isNull(productShippingCases.remedyShipmentId),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .returning({ id: productShippingCases.id });
    if (!updatedCase) throw new Error("Replacement case changed concurrently");
    const payload = {
      caseId: input.caseId,
      purpose: input.purpose,
      sourceShipmentId,
      expectedSourceStateVersion: source.stateVersion,
      expectedShipmentStateVersion: source.stateVersion,
      decisionId,
      inventoryAttestationIds: attestations.map((entry) => entry.id),
    };
    const idempotencyKey = `replacement-prepare/${input.caseId}/${decisionId}`;
    const [operation] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: sourceShipmentId,
        type: "replacement_prepare",
        status: "queued",
        idempotencyKey,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
      })
      .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
      .returning();
    if (!operation)
      throw new Error(
        "Replacement operation already exists for a consumed decision",
      );
    return operation;
  });
}

export async function adoptReplacementShipment(input: {
  caseId: string;
  actorAdminUserId: string;
  expectedSourceStateVersion: number;
  expectedRemedyStateVersion: number;
  now?: Date;
}): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [row] = await tx
      .select({ shippingCase: productShippingCases, order: checkoutOrders })
      .from(productShippingCases)
      .innerJoin(
        checkoutOrders,
        eq(productShippingCases.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    const sourceId = row?.shippingCase.sourceShipmentId;
    const remedyId = row?.shippingCase.remedyShipmentId;
    if (
      !row ||
      !sourceId ||
      !remedyId ||
      row.order.activeFulfillmentShipmentId !== sourceId ||
      row.shippingCase.status !== "remedy_pending" ||
      !["replacement", "reshipment"].includes(
        row.shippingCase.remedyChoice ?? "",
      )
    )
      throw new Error("Replacement adoption intent is stale");
    await assertCaseHasNoRefundAllocations(tx, row.shippingCase.id);
    const shipments = await tx
      .select({
        id: productShipments.id,
        stateVersion: productShipments.stateVersion,
        status: productShipments.status,
        purpose: productShipments.purpose,
        supersedesShipmentId: productShipments.supersedesShipmentId,
      })
      .from(productShipments)
      .where(inArray(productShipments.id, [sourceId, remedyId]))
      .for("update");
    const source = shipments.find((shipment) => shipment.id === sourceId);
    const remedy = shipments.find((shipment) => shipment.id === remedyId);
    if (
      source?.stateVersion !== input.expectedSourceStateVersion ||
      remedy?.stateVersion !== input.expectedRemedyStateVersion ||
      remedy.status !== "ready_for_staff" ||
      remedy.purpose !== row.shippingCase.remedyChoice ||
      remedy.supersedesShipmentId !== sourceId
    )
      throw new Error("Replacement generation changed concurrently");
    const [adopted] = await tx
      .update(checkoutOrders)
      .set({ activeFulfillmentShipmentId: remedyId, updatedAt: now })
      .where(
        and(
          eq(checkoutOrders.id, row.order.id),
          eq(checkoutOrders.activeFulfillmentShipmentId, sourceId),
        ),
      )
      .returning({ id: checkoutOrders.id });
    if (!adopted) throw new Error("Active fulfillment generation changed");
    return { id: remedyId };
  });
}

function inventoryLineKey(line: {
  productId: string;
  variantId?: string | null;
  sku: string;
  quantity: number;
}): string {
  return `${line.productId}\u0000${line.variantId ?? ""}\u0000${line.sku}\u0000${line.quantity}`;
}

export async function processReplacementPrepareOperation(input: {
  jobId: string;
  shipmentId: string;
  payload: Record<string, unknown>;
  client: ChitChatsClient;
  observedAt: Date;
  outcomeUnknown: boolean;
}): Promise<{ outcomeCode: string }> {
  const caseId = payloadString(input.payload, "caseId");
  const sourceShipmentId = payloadString(input.payload, "sourceShipmentId");
  const expectedSourceStateVersion = payloadInteger(
    input.payload,
    "expectedSourceStateVersion",
  );
  const purpose = input.payload.purpose;
  if (
    sourceShipmentId !== input.shipmentId ||
    (purpose !== "replacement" && purpose !== "reshipment")
  )
    throw new Error("Replacement operation intent is invalid");
  const [row] = await getPrivateDb()
    .select({
      case: productShippingCases,
      order: checkoutOrders,
      source: productShipments,
    })
    .from(productShippingCases)
    .innerJoin(
      checkoutOrders,
      eq(productShippingCases.orderId, checkoutOrders.id),
    )
    .innerJoin(productShipments, eq(productShipments.id, sourceShipmentId))
    .where(
      and(
        eq(productShippingCases.id, caseId),
        eq(productShippingCases.sourceShipmentId, sourceShipmentId),
        isNull(productShippingCases.remedyShipmentId),
        isNull(productShippingCases.fulfillmentQuarantinedAt),
        eq(productShipments.stateVersion, expectedSourceStateVersion),
        eq(productShipments.orderId, checkoutOrders.id),
      ),
    )
    .limit(1);
  if (
    !row?.order.shippingAddress ||
    row.order.status !== "paid" ||
    row.order.paymentRiskStatus !== "cleared" ||
    row.order.fulfillmentQuarantinedAt !== null ||
    row.order.activeFulfillmentShipmentId !== sourceShipmentId ||
    row.case.status !== "remedy_pending" ||
    row.case.remedyChoice !== purpose ||
    !["loss", "damage"].includes(row.case.type)
  )
    throw new Error("Replacement operation is stale or no longer eligible");
  const recipient = replacementRecipient({
    shippingAddress: row.order.shippingAddress,
    originalDestination: row.source.destination,
    customerName: row.order.customerName,
    customerEmail: row.order.customerEmail,
  });
  const quoteContext = parseShippingQuoteContextSnapshot(
    row.source.deadlinePolicySnapshot,
  );
  if (!quoteContext)
    throw new Error("Replacement source has no certified quote context");
  await assertReplacementProviderMutationFence({
    caseId,
    sourceShipmentId,
    expectedSourceStateVersion,
    destinationCountryCode: recipient.countryCode,
    quoteContext,
    now: input.observedAt,
  });
  const reference = `lhs-${caseId.slice(0, 8)}-${row.source.sequence + 1}`;
  let provider;
  if (input.outcomeUnknown) {
    const recovered = (await input.client.findShipments(reference)).filter(
      (candidate) => candidate.order_id === reference,
    );
    if (recovered.length !== 1) {
      const ambiguous = new Error(
        recovered.length > 1
          ? "Multiple replacement drafts matched the immutable reference"
          : "Replacement creation outcome remains unresolved",
      );
      ambiguous.name = "AmbiguousShipmentOperationError";
      throw ambiguous;
    }
    provider = recovered[0]!;
  } else
    try {
      provider = await input.client.createShipment({
        recipient,
        packageSnapshot: row.source.packageSnapshot,
        customsLines: row.source.customsLines,
        merchandiseValueCents:
          row.order.atRiskValueCents ??
          row.order.merchandiseAmountCents ??
          row.source.customsLines.reduce(
            (sum, line) => sum + line.quantity * line.unitValueCents,
            0,
          ),
        orderReference: reference,
        signatureRequested: row.source.signatureRequired,
      });
    } catch (error) {
      const recovered = (
        await input.client.findShipments(reference).catch(() => [])
      ).filter((candidate) => candidate.order_id === reference);
      if (recovered.length !== 1) {
        const ambiguous = new Error(
          error instanceof Error
            ? error.message
            : "Replacement creation is ambiguous",
        );
        ambiguous.name = "AmbiguousShipmentOperationError";
        throw ambiguous;
      }
      provider = recovered[0]!;
    }
  const policy = await loadShippingPolicyContext(input.observedAt);
  const configuredTrackedTypes = getChitChatsConfig().trackedPostageTypes;
  const trackedPostageTypes =
    recipient.countryCode === "US"
      ? new Set(
          [...configuredTrackedTypes].filter(
            (service) =>
              row.source.usShippingContractSnapshot?.importTerms === "DDU" &&
              row.source.usShippingContractSnapshot.allowedServiceCodes.includes(
                service,
              ),
          ),
        )
      : configuredTrackedTypes;
  const rates = selectCustomerRates(provider.rates ?? [], trackedPostageTypes, {
    atRiskValueCents:
      row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0,
    destinationCountryCode: recipient.countryCode,
    estimatedDeliveryAt: provider.estimated_delivery_at,
    servicePolicies: policy.servicePolicies,
    signatureThresholdCents: row.source.signatureRequired
      ? 0
      : Number.MAX_SAFE_INTEGER,
  });
  const selected = rates.find(
    (rate) => rate.postageType === row.source.selectedPostageType,
  );
  if (!selected) {
    await enqueueUnpaidProviderDraftCleanup({
      source: row.source,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      publicReference: reference,
      destination: recipient,
      rawShipment: stripSignedLabelUrls(provider),
      reason: "replacement_service_unavailable",
      now: input.observedAt,
    });
    throw providerDraftCleanupQueuedError(
      "Replacement source service is no longer available",
    );
  }
  try {
    await getPrivateDb().transaction(async (tx) => {
      await lockShippingCheckoutReadinessConfiguration(tx);
      await assertShippingQuoteContextCurrent({
        destinationCountryCode: recipient.countryCode,
        expectedContext: quoteContext,
        intakeLocationAttestationId: quoteContext.intakeLocationAttestationId,
        now: input.observedAt,
      });
      const [shippingCase] = await tx
        .select()
        .from(productShippingCases)
        .where(
          and(
            eq(productShippingCases.id, caseId),
            eq(productShippingCases.sourceShipmentId, sourceShipmentId),
            isNull(productShippingCases.remedyShipmentId),
            isNull(productShippingCases.fulfillmentQuarantinedAt),
          ),
        )
        .for("update")
        .limit(1);
      const [order] = await tx
        .select()
        .from(checkoutOrders)
        .where(eq(checkoutOrders.id, row.order.id))
        .for("update")
        .limit(1);
      const [source] = await tx
        .select()
        .from(productShipments)
        .where(
          and(
            eq(productShipments.id, sourceShipmentId),
            eq(productShipments.stateVersion, expectedSourceStateVersion),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !shippingCase ||
        shippingCase.status !== "remedy_pending" ||
        shippingCase.remedyChoice !== purpose ||
        !order ||
        order.status !== "paid" ||
        order.paymentRiskStatus !== "cleared" ||
        order.fulfillmentQuarantinedAt !== null ||
        order.activeFulfillmentShipmentId !== sourceShipmentId ||
        !source ||
        source.orderId !== order.id
      )
        throw new Error("Replacement intent changed concurrently");
      await assertCaseHasNoRefundAllocations(tx, shippingCase.id);
      const [sequence] = await tx
        .select({
          next: sql<number>`coalesce(max(${productShipments.sequence}), -1) + 1`,
        })
        .from(productShipments)
        .where(eq(productShipments.orderId, row.order.id));
      const [generation] = await tx
        .insert(productShipments)
        .values({
          orderId: row.order.id,
          sequence: Number(sequence?.next ?? source.sequence + 1),
          purpose,
          supersedesShipmentId: source.id,
          publicReference: reference,
          quoteTokenHash: hashShippingQuoteToken(issueShippingCustomerToken()),
          quoteFingerprint: `generation:${caseId}:${payloadString(input.payload, "decisionId")}`,
          providerShipmentId: provider.id,
          providerStatus: provider.status,
          destination: recipient,
          packageSnapshot: source.packageSnapshot,
          customsLines: source.customsLines,
          rates,
          selectedRateId: selected.id,
          selectedPostageType: selected.postageType,
          quotedShippingCents: selected.paymentAmountCents,
          rawShipment: stripSignedLabelUrls(provider),
          quoteExpiresAt: new Date(input.observedAt.getTime() + 15 * 60_000),
          status: "ready_for_staff",
          originalHandoffDeadlineAt: source.originalHandoffDeadlineAt,
          autoRefundDeadlineAt: source.autoRefundDeadlineAt,
          calendarVersionId: source.calendarVersionId,
          usShippingContractSnapshot: source.usShippingContractSnapshot,
          deadlinePolicySnapshot: source.deadlinePolicySnapshot,
          latestEstimatedDeliveryAt: selected.estimatedDeliveryAt
            ? new Date(selected.estimatedDeliveryAt)
            : null,
          deliveryMaxBusinessDays: selected.deliveryMaxBusinessDays,
          signatureRequired: source.signatureRequired,
          signatureRequested: source.signatureRequired,
        })
        .returning({ id: productShipments.id });
      const [updated] = await tx
        .update(productShippingCases)
        .set({
          remedyShipmentId: generation!.id,
          remedyChoice: purpose,
          status: "remedy_pending",
          stateVersion: sql`${productShippingCases.stateVersion} + 1`,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productShippingCases.id, caseId),
            isNull(productShippingCases.remedyShipmentId),
            isNull(productShippingCases.fulfillmentQuarantinedAt),
          ),
        )
        .returning({ id: productShippingCases.id });
      if (!updated)
        throw new Error("Replacement case pointer changed concurrently");
    });
  } catch (error) {
    await enqueueUnpaidProviderDraftCleanup({
      source: row.source,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      publicReference: reference,
      destination: recipient,
      rawShipment: stripSignedLabelUrls(provider),
      reason: "replacement_preparation_persistence_failed",
      now: input.observedAt,
    });
    throw providerDraftCleanupQueuedError(
      error instanceof Error
        ? error.message
        : "Replacement preparation could not be persisted",
    );
  }
  return { outcomeCode: "prepared" };
}

async function assertReplacementProviderMutationFence(input: {
  caseId: string;
  sourceShipmentId: string;
  expectedSourceStateVersion: number;
  destinationCountryCode: "CA" | "US";
  quoteContext: NonNullable<
    ReturnType<typeof parseShippingQuoteContextSnapshot>
  >;
  now: Date;
}): Promise<void> {
  await getPrivateDb().transaction(async (tx) => {
    await lockShippingCheckoutReadinessConfiguration(tx);
    await assertShippingQuoteContextCurrent({
      destinationCountryCode: input.destinationCountryCode,
      expectedContext: input.quoteContext,
      intakeLocationAttestationId:
        input.quoteContext.intakeLocationAttestationId,
      now: input.now,
    });
    const [shippingCase] = await tx
      .select()
      .from(productShippingCases)
      .where(eq(productShippingCases.id, input.caseId))
      .for("update")
      .limit(1);
    const [source] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.sourceShipmentId))
      .for("update")
      .limit(1);
    const [order] = source?.orderId
      ? await tx
          .select()
          .from(checkoutOrders)
          .where(eq(checkoutOrders.id, source.orderId))
          .for("update")
          .limit(1)
      : [];
    if (
      !shippingCase ||
      shippingCase.sourceShipmentId !== input.sourceShipmentId ||
      shippingCase.remedyShipmentId !== null ||
      shippingCase.fulfillmentQuarantinedAt !== null ||
      shippingCase.status !== "remedy_pending" ||
      !["replacement", "reshipment"].includes(
        shippingCase.remedyChoice ?? "",
      ) ||
      !source ||
      source.stateVersion !== input.expectedSourceStateVersion ||
      !order ||
      order.status !== "paid" ||
      order.paymentRiskStatus !== "cleared" ||
      order.fulfillmentQuarantinedAt !== null ||
      order.activeFulfillmentShipmentId !== source.id
    ) {
      throw new Error("Replacement provider-mutation fence is stale");
    }
    await assertCaseHasNoRefundAllocations(tx, shippingCase.id);
  });
}

async function assertCaseHasNoRefundAllocations(
  tx: ShippingCaseTransaction,
  caseId: string,
): Promise<void> {
  const [refund] = await tx
    .select({ id: productOrderRefunds.id })
    .from(productOrderRefunds)
    .where(
      and(
        eq(productOrderRefunds.caseId, caseId),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    )
    .for("update")
    .limit(1);
  const [adjustment] = await tx
    .select({ id: productOrderAdjustments.id })
    .from(productOrderAdjustments)
    .where(
      and(
        eq(productOrderAdjustments.sourceCaseId, caseId),
        eq(productOrderAdjustments.direction, "refund"),
      ),
    )
    .for("update")
    .limit(1);
  if (refund || adjustment)
    throw new Error(
      "Shipping case refund allocations prevent replacement fulfillment",
    );
}

function providerDraftCleanupQueuedError(message: string): Error {
  const error = new Error(message);
  error.name = "ProviderDraftCleanupQueuedError";
  return error;
}

function replacementRecipient(input: {
  shippingAddress: CheckoutOrderShippingAddressSnapshot;
  originalDestination: typeof productShipments.$inferSelect.destination;
  customerName: string;
  customerEmail: string;
}): ShippingRecipient {
  const countryCode =
    input.shippingAddress.countryCode ??
    (input.shippingAddress.country.trim().toUpperCase() === "CANADA"
      ? "CA"
      : input.shippingAddress.country.trim().toUpperCase() === "UNITED STATES"
        ? "US"
        : null);
  if (!countryCode)
    throw new Error(
      "Replacement address country must be Canada or United States",
    );
  const phone =
    input.shippingAddress.phone?.trim() ||
    input.originalDestination.phone?.trim();
  if (!phone)
    throw new Error("A replacement recipient phone number is required");
  return {
    ...input.shippingAddress,
    countryCode,
    name: input.customerName,
    email: input.customerEmail,
    phone,
  };
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Replacement payload ${key} is invalid`);
  return value;
}

function payloadInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isInteger(value))
    throw new Error(`Replacement payload ${key} is invalid`);
  return value as number;
}
