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
import { getSquareCommerceEnv } from "@/lib/env/private-checkout";
import { createSquarePaymentsClient } from "@/lib/payments/square/payments-client";
import {
  createSquareProductRefunder,
  type SquareProductRefunder,
} from "@/lib/payments/square/product-refund";
import { sendShippingPolicyAlert } from "./policy-alerts";

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

function createLiveSquareProductRefunder(): SquareProductRefunder {
  const env = getSquareCommerceEnv();
  if (env === null) {
    throw new Error("Square commerce refunds are not enabled");
  }
  return createSquareProductRefunder(
    createSquarePaymentsClient({
      accessToken: env.accessToken,
      environment: env.environment,
    }),
  );
}

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
  if (!order || order.paymentProvider !== "square") {
    throw new Error("Order is not eligible for an automated Square refund");
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
        eq(orderPaymentTransactions.provider, "square"),
        ...(input.paymentTransactionId
          ? [eq(orderPaymentTransactions.id, input.paymentTransactionId)]
          : []),
      ),
    )
    .for("update");
  if (!payments.length) {
    throw new Error("No immutable Square payment transaction was found");
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
  refunder: SquareProductRefunder = createLiveSquareProductRefunder(),
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
        eq(orderPaymentTransactions.provider, "square"),
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
  if (!candidate.refund.adjustmentId) {
    return markRefundForManualReview(refundId, "UNTYPED_REFUND_RESERVATION");
  }
  // A PII-redacted order is at end-of-life; never auto-move money against it —
  // route any still-queued refund to a human. (The former Helcim path blocked
  // here implicitly because redaction removed the cardholder IP it required;
  // Square needs no IP, so the guard is now explicit.)
  if (candidate.order.redactedAt !== null) {
    return markRefundForManualReview(refundId, "ORDER_REDACTED_BEFORE_REFUND");
  }
  if (
    candidate.refund.originalTransactionId !==
    candidate.transaction.providerTransactionId
  ) {
    return markRefundForManualReview(refundId, "TRANSACTION_IDENTITY_MISMATCH");
  }
  // The original Square capture's payment id — the refund targets exactly this
  // payment. Square refunds carry no cardholder IP (unlike the former Helcim
  // ecommerce refund), so no IP evidence is decrypted or required here.
  const paymentId = candidate.transaction.providerTransactionId;

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

  // The refunder never throws — it classifies API/network failures. The
  // deterministic Square idempotency key (`claimedRefund.idempotencyKey`)
  // guarantees a retried attempt reuses the same refund rather than issuing a
  // second one.
  const outcome = await refunder.refundPayment({
    paymentId,
    amountCents: claimedRefund.amountCents,
    currency: candidate.transaction.currency,
    idempotencyKey: claimedRefund.idempotencyKey,
  });

  if (!outcome.ok) {
    // Deterministic client rejection → manual review. A transient/unknown
    // outcome may have moved money, so it is outcome_unknown pending the
    // refund.updated webhook — never silently retried as a fresh refund.
    return db.transaction(async (tx) =>
      completeClaimedRefund(tx, {
        refund: claimedRefund,
        leaseOwner,
        status: outcome.deterministic ? "manual_review" : "outcome_unknown",
        errorCode: outcome.code,
        now: new Date(),
      }),
    );
  }

  // Correlation gate: the refund Square issued must target the exact captured
  // payment for the reserved amount and currency. A mismatch means money may
  // have moved against a different reservation — record the provider refund id
  // and defer to reconciliation rather than closing the row as succeeded.
  if (
    !outcome.refundId ||
    outcome.paymentId !== paymentId ||
    outcome.amountCents !== claimedRefund.amountCents ||
    outcome.currency.toUpperCase() !==
      candidate.transaction.currency.toUpperCase()
  ) {
    return db.transaction(async (tx) =>
      completeClaimedRefund(tx, {
        refund: claimedRefund,
        leaseOwner,
        status: "outcome_unknown",
        ...(outcome.refundId ? { providerRefundId: outcome.refundId } : {}),
        errorCode: "REFUND_REQUIRES_RECONCILIATION",
        now: new Date(),
      }),
    );
  }

  // A PENDING refund is accepted but not yet final: store the provider refund
  // id and let the refund.updated webhook settle it to succeeded, so money is
  // never marked returned before Square confirms it.
  if (!outcome.settled) {
    return db.transaction(async (tx) =>
      completeClaimedRefund(tx, {
        refund: claimedRefund,
        leaseOwner,
        status: "outcome_unknown",
        providerRefundId: outcome.refundId,
        errorCode: "REFUND_PENDING_PROVIDER_SETTLEMENT",
        now: new Date(),
      }),
    );
  }

  return db.transaction(async (tx) => {
    const updated = await completeClaimedRefund(tx, {
      refund: claimedRefund,
      leaseOwner,
      status: "succeeded",
      providerRefundId: outcome.refundId,
      now: new Date(),
    });
    if (updated.status === "succeeded") {
      await updateRefundedFinancialState(tx, updated.orderId);
    }
    return updated;
  });
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
  /** Square payment id of the original capture (from `refund.payment_id`). */
  originalTransactionId?: string;
  providerRefundId: string;
  amountCents: number;
  currency: string;
  providerMerchantReference?: string;
}): Promise<boolean> {
  const providerRefundId = input.providerRefundId.trim();
  const originalTransactionId = input.originalTransactionId?.trim();
  const currency = input.currency.trim().toUpperCase();
  if (
    !providerRefundId ||
    !currency ||
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0
  ) {
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
          eq(productOrderRefunds.providerRefundId, providerRefundId),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (existingProviderMatch) {
      const refund = existingProviderMatch.refund;
      const correlates =
        (!originalTransactionId ||
          refund.originalTransactionId === originalTransactionId) &&
        refund.amountCents === input.amountCents &&
        existingProviderMatch.currency.toUpperCase() === currency;
      if (!correlates) return false;
      // Idempotent re-delivery of an already-settled refund.
      if (refund.status === "succeeded") return true;
      // A refund we issued that Square reported PENDING (recorded as
      // outcome_unknown with this provider refund id) now settles to succeeded.
      if (
        refund.status === "queued" ||
        refund.status === "processing" ||
        refund.status === "outcome_unknown"
      ) {
        return settleReconciledRefund(tx, refund, providerRefundId);
      }
      return false;
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
        (originalTransactionId &&
          referenceMatch.refund.originalTransactionId !==
            originalTransactionId) ||
        referenceMatch.refund.amountCents !== input.amountCents ||
        referenceMatch.transaction.currency.toUpperCase() !== currency
      ) {
        return false;
      }
      return settleReconciledRefund(
        tx,
        referenceMatch.refund,
        providerRefundId,
      );
    }

    if (!originalTransactionId) return false;

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
          eq(orderPaymentTransactions.provider, "square"),
          eq(
            orderPaymentTransactions.providerTransactionId,
            originalTransactionId,
          ),
          eq(productOrderRefunds.originalTransactionId, originalTransactionId),
          eq(productOrderRefunds.amountCents, input.amountCents),
          eq(orderPaymentTransactions.currency, currency),
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
        // A COMPLETED Square refund that maps to more than one reserved refund
        // cannot be linked automatically (e.g. two same-amount transient
        // failures against one payment that both settled). The rows are parked
        // in manual_review here, but nothing else watches non-queued rows — so
        // surface a critical finance alert, keyed by the provider refund id so
        // a retried webhook does not re-notify.
        await sendShippingPolicyAlert({
          duties: ["finance_owner"],
          critical: true,
          subject: "Square refund could not be auto-linked",
          message: `Completed Square refund ${providerRefundId} (${input.amountCents} cents ${currency}) matched ${candidates.length} reserved refunds and was parked in manual review. Reconcile it by hand.`,
          idempotencyKey: `shipping-refund-ambiguous/${providerRefundId}`,
          executor: tx,
        });
      } else {
        // Zero candidates. Only orderPaymentTransactions rows exist for product
        // orders (bookings settle through appointment_holds/checkout_payment_events),
        // so a genuine service-booking refund has no matching row here and the
        // silent return below is correct. But a COMPLETED refund that DOES match a
        // product-order payment yet no reserved refund row means money left the
        // merchant out-of-band (e.g. an operator issued it from the Square
        // Dashboard) while the order stays `paid` and nothing else watches it —
        // surface a finance alert, keyed by the provider refund id so a retried
        // webhook does not re-notify.
        const [productPayment] = await tx
          .select({ id: orderPaymentTransactions.id })
          .from(orderPaymentTransactions)
          .where(
            and(
              eq(orderPaymentTransactions.provider, "square"),
              eq(
                orderPaymentTransactions.providerTransactionId,
                originalTransactionId,
              ),
            ),
          )
          .limit(1);
        if (productPayment) {
          // The ambiguous branch above parks its matching reserved refunds in
          // manual_review WITHOUT a providerRefundId, so a webhook retry of that
          // SAME refund misses `existingProviderMatch`, finds zero live
          // candidates, and lands here. That refund is NOT out-of-band — it was
          // already surfaced by the `shipping-refund-ambiguous` alert — so a
          // second, contradictory "unlinked" alert would only confuse. Suppress
          // it only when a refund the ambiguous branch parked for this exact
          // (payment, amount, currency) still exists. Keyed on the
          // AMBIGUOUS_PROVIDER_REFUND marker so a genuinely out-of-band refund
          // (no reserved row at all) and a distinct second refund on the same
          // payment (a prior `succeeded` row is not manual_review) both still
          // alert. Re-read here (after the candidate `for("update")` lock) so it
          // holds under a concurrent delivery too, not just a sequential retry.
          const [ambiguousParked] = await tx
            .select({ id: productOrderRefunds.id })
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
                eq(orderPaymentTransactions.provider, "square"),
                eq(
                  orderPaymentTransactions.providerTransactionId,
                  originalTransactionId,
                ),
                eq(
                  productOrderRefunds.originalTransactionId,
                  originalTransactionId,
                ),
                eq(productOrderRefunds.amountCents, input.amountCents),
                eq(orderPaymentTransactions.currency, currency),
                eq(productOrderRefunds.status, "manual_review"),
                eq(
                  productOrderRefunds.lastErrorCode,
                  "AMBIGUOUS_PROVIDER_REFUND",
                ),
                isNull(productOrderRefunds.fulfillmentQuarantinedAt),
              ),
            )
            .limit(1);
          if (!ambiguousParked) {
            await sendShippingPolicyAlert({
              duties: ["finance_owner"],
              critical: true,
              subject: "Unlinked Square refund on a product order",
              message: `Completed Square refund ${providerRefundId} (${input.amountCents} cents ${currency}) settled against product-order payment ${originalTransactionId} but matched no reserved refund. It was likely issued out-of-band (e.g. the Square Dashboard); reconcile the order's refund state by hand.`,
              idempotencyKey: `shipping-refund-unlinked/${providerRefundId}`,
              executor: tx,
            });
          }
        }
      }
      return false;
    }
    return settleReconciledRefund(tx, candidates[0]!.refund, providerRefundId);
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

function semanticRefundUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
