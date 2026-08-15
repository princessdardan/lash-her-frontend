import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAdjustments,
  productOrderRefunds,
  productShippingCases,
} from "@/lib/private-db/schema";
import { decryptCheckoutIp } from "@/lib/commerce/checkout-pii";
import {
  createLiveHelcimGateway,
  type HelcimGateway,
} from "@/lib/commerce/helcim-gateway";
import { HelcimApiError } from "@/lib/commerce/helcim-client";
import { classifyHelcimTransaction } from "@/lib/commerce/helcim-contract";
import { readCertifiedHelcimRefundCorrelationField } from "@/lib/commerce/helcim-certified-contract";
import { parseProviderMoneyCents } from "./provider-money";

type ProductOrderRefundRow = typeof productOrderRefunds.$inferSelect;
export type ProductRefundDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];
type DbTransaction = ProductRefundDbTransaction;

export interface QueueProductOrderRefundInput {
  orderReference: string;
  paymentTransactionId?: string;
  amountCents?: number;
  component?: "merchandise" | "tax" | "outbound_shipping";
  reason: string;
  caseId?: string;
  sourceShipmentId?: string;
  sourceAddressRequestId?: string;
  requestedByAdminUserId?: string;
  automated?: boolean;
}

const REFUND_LEASE_MS = 5 * 60_000;
const RESERVED_REFUND_STATUSES = [
  "queued",
  "processing",
  "succeeded",
  "outcome_unknown",
  "manual_review",
] as const;

export async function queueProductOrderRefund(
  input: QueueProductOrderRefundInput,
): Promise<ProductOrderRefundRow> {
  const rows = await queueProductOrderRefundAllocations(input);
  const first = rows[0];
  if (!first) throw new Error("No refundable payment transaction was found");
  return first;
}

/**
 * Allocates a full-order request over every immutable capture. Callers that
 * need synchronous completion can process every returned row; the policy
 * worker will also drain any rows left queued.
 */
export async function queueProductOrderRefundAllocations(
  input: QueueProductOrderRefundInput,
): Promise<ProductOrderRefundRow[]> {
  if (
    input.amountCents !== undefined &&
    (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
  ) {
    throw new Error("Refund amount must be a positive number of cents");
  }
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error("Refund reason is required");

  return getPrivateDb().transaction((tx) =>
    queueProductOrderRefundAllocationsInTransaction(tx, input),
  );
}

export async function queueProductOrderRefundAllocationsInTransaction(
  tx: ProductRefundDbTransaction,
  input: QueueProductOrderRefundInput,
): Promise<ProductOrderRefundRow[]> {
  if (
    input.amountCents !== undefined &&
    (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
  ) {
    throw new Error("Refund amount must be a positive number of cents");
  }
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error("Refund reason is required");

  const [order] = await tx
    .select()
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.orderId, input.orderReference),
        eq(checkoutOrders.purpose, "product"),
        inArray(checkoutOrders.status, ["paid", "refunded", "cancelled"]),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!order || order.paymentProvider !== "helcim") {
    throw new Error("Order is not eligible for an automated Helcim refund");
  }
  if (input.caseId) {
    const [shippingCase] = await tx
      .select({
        id: productShippingCases.id,
        remedyChoice: productShippingCases.remedyChoice,
        remedyShipmentId: productShippingCases.remedyShipmentId,
      })
      .from(productShippingCases)
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          eq(productShippingCases.orderId, order.id),
          isNull(productShippingCases.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!shippingCase)
      throw new Error("Shipping case refund target is unavailable");
    if (
      shippingCase.remedyShipmentId ||
      shippingCase.remedyChoice === "replacement" ||
      shippingCase.remedyChoice === "reshipment"
    )
      throw new Error(
        "Shipping case replacement remedy prevents refund allocation",
      );
  }

  const payments = await tx
    .select({
      transaction: orderPaymentTransactions,
      obligation: orderPaymentObligations,
    })
    .from(orderPaymentTransactions)
    .innerJoin(
      orderPaymentObligations,
      eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
    )
    .where(
      and(
        eq(orderPaymentObligations.orderId, order.id),
        isNull(orderPaymentObligations.quarantinedAt),
        eq(orderPaymentTransactions.provider, "helcim"),
        ...(input.paymentTransactionId
          ? [eq(orderPaymentTransactions.id, input.paymentTransactionId)]
          : []),
      ),
    )
    .for("update");
  if (!payments.length) {
    throw new Error("No immutable Helcim payment transaction was found");
  }

  const allocations: Array<{
    transaction: (typeof payments)[number]["transaction"];
    amountCents: number;
    component: "merchandise" | "tax" | "outbound_shipping";
    reservationOffsetCents: number;
  }> = [];
  const existingAllocations: ProductOrderRefundRow[] = [];
  for (const payment of payments) {
    const reservations = await tx
      .select({
        refund: productOrderRefunds,
        component: productOrderAdjustments.component,
      })
      .from(productOrderRefunds)
      .leftJoin(
        productOrderAdjustments,
        eq(productOrderRefunds.adjustmentId, productOrderAdjustments.id),
      )
      .where(
        and(
          eq(productOrderRefunds.paymentTransactionId, payment.transaction.id),
          inArray(productOrderRefunds.status, RESERVED_REFUND_STATUSES),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      )
      .for("update", { of: productOrderRefunds });
    const reservedCents = reservations.reduce(
      (total, { refund }) => total + refund.amountCents,
      0,
    );
    const refundableCents = payment.transaction.amountCents - reservedCents;
    if (refundableCents < 0) {
      throw new Error("Refund ledger exceeds the captured transaction amount");
    }
    const untyped = reservations.filter(
      ({ refund, component }) => !refund.adjustmentId || !component,
    );
    if (untyped.length) {
      await tx
        .update(productOrderRefunds)
        .set({
          status: "manual_review",
          lastErrorCode: "UNTYPED_REFUND_RESERVATION",
          updatedAt: new Date(),
        })
        .where(
          inArray(
            productOrderRefunds.id,
            untyped.map(({ refund }) => refund.id),
          ),
        );
      existingAllocations.push(
        ...untyped.map(({ refund }) => ({
          ...refund,
          status: "manual_review" as const,
          lastErrorCode: "UNTYPED_REFUND_RESERVATION",
        })),
      );
      continue;
    }
    if (refundableCents === 0) {
      if (!input.paymentTransactionId && input.amountCents === undefined) {
        existingAllocations.push(...reservations.map(({ refund }) => refund));
      }
      continue;
    }
    const componentAmounts = [
      ["merchandise", payment.obligation.merchandiseAmountCents],
      ["tax", payment.obligation.taxAmountCents],
      ["outbound_shipping", payment.obligation.shippingAmountCents],
    ] as const;
    for (const [component, configuredAmount] of componentAmounts) {
      const componentReservedCents = reservations.reduce(
        (total, reservation) =>
          reservation.component === component
            ? total + reservation.refund.amountCents
            : total,
        0,
      );
      const amountCents = configuredAmount - componentReservedCents;
      if (amountCents < 0) {
        throw new Error(
          `Refund ledger exceeds the ${component} captured component`,
        );
      }
      if (amountCents <= 0) continue;
      allocations.push({
        transaction: payment.transaction,
        amountCents,
        component,
        reservationOffsetCents: componentReservedCents,
      });
    }
    const allocatedCents = allocations
      .filter(({ transaction }) => transaction.id === payment.transaction.id)
      .reduce((total, allocation) => total + allocation.amountCents, 0);
    if (allocatedCents !== refundableCents) {
      throw new Error(
        "Captured transaction does not match its immutable obligation components",
      );
    }
  }

  if (input.amountCents !== undefined) {
    const refundable = allocations.filter(
      (allocation) => allocation.amountCents > 0,
    );
    const eligible = input.component
      ? refundable.filter(
          (allocation) => allocation.component === input.component,
        )
      : refundable;
    if (
      !input.paymentTransactionId &&
      new Set(eligible.map(({ transaction }) => transaction.id)).size !== 1
    ) {
      throw new Error(
        "A payment transaction target is required for an ambiguous multi-capture partial refund",
      );
    }
    if (
      !input.component &&
      new Set(refundable.map((row) => row.component)).size > 1
    ) {
      throw new Error(
        "A refund component is required for a multi-component partial refund",
      );
    }
    const target = eligible[0];
    const componentBalance = eligible.reduce(
      (total, allocation) => total + allocation.amountCents,
      0,
    );
    if (!target || input.amountCents > componentBalance) {
      throw new Error("Refund exceeds the transaction's refundable balance");
    }
    target.amountCents = input.amountCents;
    allocations.splice(0, allocations.length, target);
  }

  const result: ProductOrderRefundRow[] = [...existingAllocations];
  for (const allocation of allocations) {
    if (allocation.amountCents <= 0) continue;
    const reasonHash = createHash("sha256")
      .update(reason, "utf8")
      .digest("hex")
      .slice(0, 16);
    const adjustmentKey = `customer-refund/${allocation.transaction.id}/${allocation.component}/${allocation.reservationOffsetCents}/${allocation.amountCents}/${reasonHash}`;
    const [adjustment] = await tx
      .insert(productOrderAdjustments)
      .values({
        orderId: order.id,
        direction: "refund",
        component: allocation.component,
        reason,
        sourceCaseId: input.caseId,
        sourceShipmentId: input.sourceShipmentId,
        sourceAddressRequestId: input.sourceAddressRequestId,
        amountCents: allocation.amountCents,
        status: "reserved",
        idempotencyKey: adjustmentKey,
      })
      .returning({ id: productOrderAdjustments.id });
    if (!adjustment) throw new Error("Refund adjustment could not be reserved");
    const [created] = await tx
      .insert(productOrderRefunds)
      .values({
        orderId: order.id,
        caseId: input.caseId,
        idempotencyKey: semanticRefundUuid(adjustmentKey),
        kind:
          allocation.amountCents === allocation.transaction.amountCents
            ? "full"
            : "partial",
        reason,
        amountCents: allocation.amountCents,
        originalTransactionId: allocation.transaction.providerTransactionId,
        paymentTransactionId: allocation.transaction.id,
        adjustmentId: adjustment.id,
        requestedByAdminUserId: input.requestedByAdminUserId,
        automated: input.automated ?? false,
      })
      .returning();
    if (!created) throw new Error("Refund could not be queued");
    result.push(created);
  }
  return result;
}

export async function processProductOrderRefund(
  refundId: string,
  gateway: HelcimGateway = createLiveHelcimGateway(),
): Promise<ProductOrderRefundRow> {
  const db = getPrivateDb();
  const now = new Date();

  // Validate immutable local inputs before claiming so deterministic local
  // failures cannot strand a lease in processing.
  const [candidate] = await db
    .select({
      refund: productOrderRefunds,
      transaction: orderPaymentTransactions,
      order: checkoutOrders,
    })
    .from(productOrderRefunds)
    .innerJoin(
      orderPaymentTransactions,
      eq(productOrderRefunds.paymentTransactionId, orderPaymentTransactions.id),
    )
    .innerJoin(
      orderPaymentObligations,
      eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
    )
    .innerJoin(
      checkoutOrders,
      eq(orderPaymentObligations.orderId, checkoutOrders.id),
    )
    .where(
      and(
        eq(productOrderRefunds.id, refundId),
        eq(productOrderRefunds.orderId, checkoutOrders.id),
        eq(orderPaymentTransactions.provider, "helcim"),
        isNull(orderPaymentObligations.quarantinedAt),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    )
    .limit(1);
  if (!candidate) {
    return markRefundForManualReview(
      refundId,
      "REFUND_PAYMENT_TRANSACTION_UNAVAILABLE",
    );
  }
  if (
    ["succeeded", "outcome_unknown", "manual_review"].includes(
      candidate.refund.status,
    )
  ) {
    return candidate.refund;
  }
  if (candidate.refund.status === "processing") {
    if (
      !candidate.refund.leaseExpiresAt ||
      candidate.refund.leaseExpiresAt <= now
    ) {
      return markRefundOutcomeUnknown(
        refundId,
        "REFUND_LEASE_EXPIRED_AFTER_PROVIDER_MUTATION_MAY_HAVE_STARTED",
      );
    }
    return candidate.refund;
  }
  const ipCiphertext =
    candidate.transaction.originatingIpCiphertext ??
    candidate.order.refundOriginIpCiphertext;
  if (!candidate.refund.adjustmentId) {
    return markRefundForManualReview(refundId, "UNTYPED_REFUND_RESERVATION");
  }
  if (!ipCiphertext) {
    return markRefundForManualReview(refundId, "ORIGINAL_IP_UNAVAILABLE");
  }
  if (
    candidate.refund.originalTransactionId !==
    candidate.transaction.providerTransactionId
  ) {
    return markRefundForManualReview(refundId, "TRANSACTION_IDENTITY_MISMATCH");
  }
  const originalTransactionId = Number(
    candidate.transaction.providerTransactionId,
  );
  if (
    !Number.isSafeInteger(originalTransactionId) ||
    originalTransactionId <= 0
  ) {
    return markRefundForManualReview(
      refundId,
      "INVALID_PROVIDER_TRANSACTION_ID",
    );
  }
  let ipAddress: string;
  try {
    ipAddress = decryptCheckoutIp(ipCiphertext);
  } catch {
    return markRefundForManualReview(refundId, "ORIGINAL_IP_UNREADABLE");
  }

  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + REFUND_LEASE_MS);
  const claimedRefund = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(productOrderRefunds)
      .set({
        status: "processing",
        leaseOwner,
        leaseExpiresAt,
        firstAttemptedAt: sql`coalesce(${productOrderRefunds.firstAttemptedAt}, ${now})`,
        lastAttemptedAt: now,
        attemptCount: sql`${productOrderRefunds.attemptCount} + 1`,
        stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderRefunds.id, refundId),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
          eq(productOrderRefunds.status, "queued"),
        ),
      )
      .returning();
    if (!claimed) return undefined;
    if (!claimed.adjustmentId) {
      throw new Error("Refund has no typed financial adjustment");
    }
    const [adjustment] = await tx
      .update(productOrderAdjustments)
      .set({ status: "processing", updatedAt: now })
      .where(
        and(
          eq(productOrderAdjustments.id, claimed.adjustmentId),
          inArray(productOrderAdjustments.status, ["reserved", "processing"]),
        ),
      )
      .returning({ id: productOrderAdjustments.id });
    if (!adjustment) throw new Error("Refund adjustment is not processable");
    return claimed;
  });
  if (!claimedRefund) throw new Error("Refund is not available for processing");

  try {
    const response = await gateway.refundPayment(
      {
        originalTransactionId,
        amount: claimedRefund.amountCents / 100,
        ipAddress,
        ecommerce: true,
      },
      claimedRefund.idempotencyKey,
    );
    const providerRefundId =
      readCertifiedHelcimRefundCorrelationField(
        response,
        "providerRefundIdFields",
      ) ?? "";
    const responseOriginalId =
      readCertifiedHelcimRefundCorrelationField(
        response,
        "originalTransactionIdFields",
      ) ?? "";
    const responseMerchantReference = readCertifiedHelcimRefundCorrelationField(
      response,
      "merchantReferenceFields",
    );
    const responseAmountCents = parseProviderMoneyCents(response.amount);
    const classification = classifyHelcimTransaction({
      originalTransactionId: responseOriginalId,
      status: response.status,
      transactionType: response.transactionType,
    });
    if (
      !providerRefundId ||
      responseOriginalId !== claimedRefund.originalTransactionId ||
      (responseMerchantReference !== undefined &&
        responseMerchantReference !== claimedRefund.idempotencyKey) ||
      responseAmountCents !== claimedRefund.amountCents ||
      response.currency?.toUpperCase() !==
        candidate.transaction.currency.toUpperCase() ||
      classification.kind !== "refund" ||
      !classification.successful
    ) {
      throw new Error("Helcim refund response requires reconciliation");
    }
    return db.transaction(async (tx) => {
      const updated = await completeClaimedRefund(tx, {
        refund: claimedRefund,
        leaseOwner,
        status: "succeeded",
        providerRefundId,
        now: new Date(),
      });
      if (updated.status === "succeeded") {
        await updateRefundedFinancialState(tx, updated.orderId);
      }
      return updated;
    });
  } catch (error) {
    const deterministic =
      error instanceof HelcimApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 409;
    return db.transaction(async (tx) =>
      completeClaimedRefund(tx, {
        refund: claimedRefund,
        leaseOwner,
        status: deterministic ? "manual_review" : "outcome_unknown",
        errorCode: refundErrorCode(error),
        now: new Date(),
      }),
    );
  }
}

async function markRefundForManualReview(
  refundId: string,
  errorCode: string,
): Promise<ProductOrderRefundRow> {
  return getPrivateDb().transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(productOrderRefunds)
      .set({
        status: "manual_review",
        lastErrorCode: errorCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderRefunds.id, refundId),
          inArray(productOrderRefunds.status, ["queued", "processing"]),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      )
      .returning();
    const current =
      updated ??
      (
        await tx
          .select()
          .from(productOrderRefunds)
          .where(eq(productOrderRefunds.id, refundId))
          .limit(1)
      )[0];
    if (!current) throw new Error("Refund was not found");
    if (updated?.adjustmentId) {
      await tx
        .update(productOrderAdjustments)
        .set({ status: "manual_review", updatedAt: now })
        .where(eq(productOrderAdjustments.id, updated.adjustmentId));
    }
    return current;
  });
}

async function markRefundOutcomeUnknown(
  refundId: string,
  errorCode: string,
): Promise<ProductOrderRefundRow> {
  return getPrivateDb().transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(productOrderRefunds)
      .set({
        status: "outcome_unknown",
        lastErrorCode: errorCode,
        unknownOutcomeAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderRefunds.id, refundId),
          eq(productOrderRefunds.status, "processing"),
          sql`(${productOrderRefunds.leaseExpiresAt} IS NULL OR ${productOrderRefunds.leaseExpiresAt} <= ${now})`,
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      )
      .returning();
    const current =
      updated ??
      (await tx.query.productOrderRefunds.findFirst({
        where: eq(productOrderRefunds.id, refundId),
      }));
    if (!current) throw new Error("Refund was not found");
    if (updated?.adjustmentId) {
      await tx
        .update(productOrderAdjustments)
        .set({ status: "outcome_unknown", updatedAt: now })
        .where(eq(productOrderAdjustments.id, updated.adjustmentId));
    }
    return current;
  });
}

export async function reconcileProductOrderRefund(input: {
  originalTransactionId: string;
  providerRefundId: string;
  amountCents: number;
  currency: string;
  providerMerchantReference?: string;
}): Promise<boolean> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return false;
  }
  return getPrivateDb().transaction(async (tx) => {
    const [existingProviderMatch] = await tx
      .select({
        refund: productOrderRefunds,
        currency: orderPaymentTransactions.currency,
      })
      .from(productOrderRefunds)
      .innerJoin(
        orderPaymentTransactions,
        eq(
          productOrderRefunds.paymentTransactionId,
          orderPaymentTransactions.id,
        ),
      )
      .where(
        and(
          eq(productOrderRefunds.providerRefundId, input.providerRefundId),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (existingProviderMatch) {
      return (
        existingProviderMatch.refund.originalTransactionId ===
          input.originalTransactionId &&
        existingProviderMatch.refund.amountCents === input.amountCents &&
        existingProviderMatch.currency.toUpperCase() ===
          input.currency.toUpperCase() &&
        existingProviderMatch.refund.status === "succeeded"
      );
    }

    if (
      input.providerMerchantReference &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.providerMerchantReference,
      )
    ) {
      const referenceMatches = await tx
        .select({
          refund: productOrderRefunds,
          transaction: orderPaymentTransactions,
        })
        .from(productOrderRefunds)
        .innerJoin(
          orderPaymentTransactions,
          eq(
            productOrderRefunds.paymentTransactionId,
            orderPaymentTransactions.id,
          ),
        )
        .where(
          and(
            eq(
              productOrderRefunds.idempotencyKey,
              input.providerMerchantReference,
            ),
            isNull(productOrderRefunds.fulfillmentQuarantinedAt),
          ),
        )
        .for("update")
        .limit(2);
      if (referenceMatches.length !== 1) return false;
      const referenceMatch = referenceMatches[0]!;
      if (
        referenceMatch.refund.originalTransactionId !==
          input.originalTransactionId ||
        referenceMatch.refund.amountCents !== input.amountCents ||
        referenceMatch.transaction.currency.toUpperCase() !==
          input.currency.toUpperCase()
      ) {
        return false;
      }
      return settleReconciledRefund(
        tx,
        referenceMatch.refund,
        input.providerRefundId,
      );
    }

    const candidates = await tx
      .select({ refund: productOrderRefunds })
      .from(productOrderRefunds)
      .innerJoin(
        orderPaymentTransactions,
        eq(
          productOrderRefunds.paymentTransactionId,
          orderPaymentTransactions.id,
        ),
      )
      .innerJoin(
        orderPaymentObligations,
        eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
      )
      .innerJoin(
        checkoutOrders,
        eq(orderPaymentObligations.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(
            orderPaymentTransactions.providerTransactionId,
            input.originalTransactionId,
          ),
          eq(
            productOrderRefunds.originalTransactionId,
            input.originalTransactionId,
          ),
          eq(productOrderRefunds.amountCents, input.amountCents),
          eq(orderPaymentTransactions.currency, input.currency.toUpperCase()),
          isNull(orderPaymentObligations.quarantinedAt),
          isNull(checkoutOrders.fulfillmentQuarantinedAt),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
          inArray(productOrderRefunds.status, [
            "queued",
            "processing",
            "outcome_unknown",
          ]),
        ),
      )
      .for("update")
      .limit(10);
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        await tx
          .update(productOrderRefunds)
          .set({
            status: "manual_review",
            lastErrorCode: "AMBIGUOUS_PROVIDER_REFUND",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            inArray(
              productOrderRefunds.id,
              candidates.map(({ refund }) => refund.id),
            ),
          );
        const adjustmentIds = candidates
          .map(({ refund }) => refund.adjustmentId)
          .filter((id): id is string => Boolean(id));
        if (adjustmentIds.length) {
          await tx
            .update(productOrderAdjustments)
            .set({ status: "manual_review", updatedAt: new Date() })
            .where(inArray(productOrderAdjustments.id, adjustmentIds));
        }
      }
      return false;
    }
    return settleReconciledRefund(
      tx,
      candidates[0]!.refund,
      input.providerRefundId,
    );
  });
}

async function settleReconciledRefund(
  tx: DbTransaction,
  match: ProductOrderRefundRow,
  providerRefundId: string,
): Promise<boolean> {
  if (!match.adjustmentId) {
    await tx
      .update(productOrderRefunds)
      .set({
        status: "manual_review",
        providerRefundId,
        lastErrorCode: "UNTYPED_RECONCILED_REFUND",
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productOrderRefunds.id, match.id),
          eq(productOrderRefunds.stateVersion, match.stateVersion),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      );
    return false;
  }
  const [updated] = await tx
    .update(productOrderRefunds)
    .set({
      status: "succeeded",
      providerRefundId,
      succeededAt: new Date(),
      unknownOutcomeAt: null,
      lastErrorCode: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productOrderRefunds.id, match.id),
        inArray(productOrderRefunds.status, [
          "queued",
          "processing",
          "outcome_unknown",
        ]),
        eq(productOrderRefunds.stateVersion, match.stateVersion),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    )
    .returning({ orderId: productOrderRefunds.orderId });
  if (!updated) return false;
  await tx
    .update(productOrderAdjustments)
    .set({ status: "succeeded", updatedAt: new Date() })
    .where(eq(productOrderAdjustments.id, match.adjustmentId));
  await updateRefundedFinancialState(tx, updated.orderId);
  return true;
}

async function completeClaimedRefund(
  tx: DbTransaction,
  input: {
    refund: ProductOrderRefundRow;
    leaseOwner: string;
    status: "succeeded" | "failed" | "outcome_unknown" | "manual_review";
    providerRefundId?: string;
    errorCode?: string;
    now: Date;
  },
): Promise<ProductOrderRefundRow> {
  const [updated] = await tx
    .update(productOrderRefunds)
    .set({
      status: input.status,
      providerRefundId: input.providerRefundId,
      succeededAt: input.status === "succeeded" ? input.now : undefined,
      unknownOutcomeAt: input.status === "outcome_unknown" ? input.now : null,
      lastErrorCode: input.status === "succeeded" ? null : input.errorCode,
      leaseOwner: null,
      leaseExpiresAt: null,
      stateVersion: sql`${productOrderRefunds.stateVersion} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(productOrderRefunds.id, input.refund.id),
        eq(productOrderRefunds.status, "processing"),
        eq(productOrderRefunds.leaseOwner, input.leaseOwner),
        eq(productOrderRefunds.stateVersion, input.refund.stateVersion),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    )
    .returning();
  if (updated) {
    if (!updated.adjustmentId) {
      throw new Error("Refund completed without a typed financial adjustment");
    }
    await tx
      .update(productOrderAdjustments)
      .set({
        status:
          input.status === "succeeded"
            ? "succeeded"
            : input.status === "outcome_unknown"
              ? "outcome_unknown"
              : input.status === "manual_review"
                ? "manual_review"
                : "failed",
        updatedAt: input.now,
      })
      .where(eq(productOrderAdjustments.id, updated.adjustmentId));
    return updated;
  }
  const [current] = await tx
    .select()
    .from(productOrderRefunds)
    .where(eq(productOrderRefunds.id, input.refund.id))
    .limit(1);
  if (!current) throw new Error("Refund disappeared after lease loss");
  return current;
}

async function updateRefundedFinancialState(
  tx: DbTransaction,
  orderId: string,
): Promise<void> {
  const transactions = await tx
    .select({
      transactionId: orderPaymentTransactions.id,
      obligationId: orderPaymentTransactions.obligationId,
      amountCents: orderPaymentTransactions.amountCents,
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
  const [quarantinedCapture] = await tx
    .select({ id: orderPaymentTransactions.id })
    .from(orderPaymentTransactions)
    .innerJoin(
      orderPaymentObligations,
      eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
    )
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        isNotNull(orderPaymentObligations.quarantinedAt),
      ),
    )
    .limit(1);
  const succeeded = await tx
    .select({
      paymentTransactionId: productOrderRefunds.paymentTransactionId,
      amountCents: productOrderRefunds.amountCents,
    })
    .from(productOrderRefunds)
    .where(
      and(
        eq(productOrderRefunds.orderId, orderId),
        eq(productOrderRefunds.status, "succeeded"),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    );
  const refundedByTransaction = new Map<string, number>();
  for (const refund of succeeded) {
    if (!refund.paymentTransactionId) continue;
    refundedByTransaction.set(
      refund.paymentTransactionId,
      (refundedByTransaction.get(refund.paymentTransactionId) ?? 0) +
        refund.amountCents,
    );
  }
  const transactionByObligation = new Map<string, typeof transactions>();
  for (const transaction of transactions) {
    const rows = transactionByObligation.get(transaction.obligationId) ?? [];
    rows.push(transaction);
    transactionByObligation.set(transaction.obligationId, rows);
  }
  for (const [obligationId, rows] of transactionByObligation) {
    const fullyRefunded = rows.every(
      (transaction) =>
        (refundedByTransaction.get(transaction.transactionId) ?? 0) >=
        transaction.amountCents,
    );
    if (fullyRefunded) {
      await tx
        .update(orderPaymentObligations)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(orderPaymentObligations.id, obligationId));
    }
  }
  const allCapturedRefunded =
    transactions.length > 0 &&
    transactions.every(
      (transaction) =>
        (refundedByTransaction.get(transaction.transactionId) ?? 0) >=
        transaction.amountCents,
    );
  if (allCapturedRefunded && !quarantinedCapture) {
    await tx
      .update(checkoutOrders)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(
        and(eq(checkoutOrders.id, orderId), eq(checkoutOrders.status, "paid")),
      );
  }
}

function refundErrorCode(error: unknown): string {
  if (error instanceof HelcimApiError) return `HELCIM_${error.status}`;
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return "OUTCOME_UNKNOWN";
}

function semanticRefundUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
