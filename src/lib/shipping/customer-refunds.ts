import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders, productOrderRefunds } from "@/lib/private-db/schema";
import { decryptCheckoutIp } from "@/lib/commerce/checkout-pii";
import {
  createLiveHelcimGateway,
  type HelcimGateway,
} from "@/lib/commerce/helcim-gateway";
import { HelcimApiError } from "@/lib/commerce/helcim-client";

type ProductOrderRefundRow = typeof productOrderRefunds.$inferSelect;

const RESERVED_REFUND_STATUSES = [
  "queued",
  "processing",
  "succeeded",
  "outcome_unknown",
  "manual_review",
] as const;

export async function queueProductOrderRefund(input: {
  orderReference: string;
  amountCents?: number;
  reason: string;
  caseId?: string;
  requestedByAdminUserId?: string;
  automated?: boolean;
}): Promise<ProductOrderRefundRow> {
  const db = getPrivateDb();
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
          inArray(checkoutOrders.status, ["paid", "refunded"]),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !order ||
      order.paymentProvider !== "helcim" ||
      !order.helcimTransactionId ||
      !order.refundOriginIpCiphertext
    )
      throw new Error("Order is not eligible for an automated Helcim refund");
    const [reserved] = await tx
      .select({
        total: sql<number>`coalesce(sum(${productOrderRefunds.amountCents}), 0)`,
      })
      .from(productOrderRefunds)
      .where(
        and(
          eq(productOrderRefunds.orderId, order.id),
          inArray(productOrderRefunds.status, RESERVED_REFUND_STATUSES),
        ),
      );
    const refundableCents = order.amountCents - Number(reserved?.total ?? 0);
    const amountCents = input.amountCents ?? refundableCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0)
      throw new Error("Refund amount must be a positive number of cents");
    if (amountCents > refundableCents)
      throw new Error("Refund exceeds the remaining refundable balance");
    const [created] = await tx
      .insert(productOrderRefunds)
      .values({
        orderId: order.id,
        caseId: input.caseId,
        idempotencyKey: randomUUID(),
        kind: amountCents === refundableCents ? "full" : "partial",
        reason: input.reason.trim().slice(0, 500),
        amountCents,
        originalTransactionId: order.helcimTransactionId,
        requestedByAdminUserId: input.requestedByAdminUserId,
        automated: input.automated ?? false,
      })
      .returning();
    if (!created) throw new Error("Refund could not be queued");
    return created;
  });
}

export async function processProductOrderRefund(
  refundId: string,
  gateway: HelcimGateway = createLiveHelcimGateway(),
): Promise<ProductOrderRefundRow> {
  const db = getPrivateDb();
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ refund: productOrderRefunds, order: checkoutOrders })
      .from(productOrderRefunds)
      .innerJoin(
        checkoutOrders,
        eq(productOrderRefunds.orderId, checkoutOrders.id),
      )
      .where(eq(productOrderRefunds.id, refundId))
      .for("update")
      .limit(1);
    if (!row || !["queued", "processing"].includes(row.refund.status))
      throw new Error("Refund is not available for processing");
    const now = new Date();
    if (
      row.refund.firstAttemptedAt &&
      now.getTime() - row.refund.firstAttemptedAt.getTime() >= 5 * 60_000
    ) {
      await tx
        .update(productOrderRefunds)
        .set({
          status: "manual_review",
          lastErrorCode: "IDEMPOTENCY_WINDOW_EXPIRED",
          updatedAt: now,
        })
        .where(eq(productOrderRefunds.id, refundId));
      throw new Error("Helcim idempotency window expired; reconcile manually");
    }
    if (!row.order.refundOriginIpCiphertext)
      throw new Error("Original checkout IP is unavailable");
    const [updated] = await tx
      .update(productOrderRefunds)
      .set({
        status: "processing",
        firstAttemptedAt: row.refund.firstAttemptedAt ?? now,
        lastAttemptedAt: now,
        attemptCount: sql`${productOrderRefunds.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(eq(productOrderRefunds.id, refundId))
      .returning();
    return { refund: updated!, order: row.order };
  });

  const originalTransactionId = Number(claimed.refund.originalTransactionId);
  if (
    !Number.isSafeInteger(originalTransactionId) ||
    originalTransactionId <= 0
  )
    throw new Error("Original Helcim transaction ID is invalid");
  try {
    const response = await gateway.refundPayment(
      {
        originalTransactionId,
        amount: claimed.refund.amountCents / 100,
        ipAddress: decryptCheckoutIp(claimed.order.refundOriginIpCiphertext!),
        ecommerce: true,
      },
      claimed.refund.idempotencyKey,
    );
    const providerRefundId = String(response.transactionId ?? "");
    if (!providerRefundId)
      throw new Error("Helcim refund response is incomplete");
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(productOrderRefunds)
        .set({
          status: "succeeded",
          providerRefundId,
          succeededAt: new Date(),
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(productOrderRefunds.id, refundId))
        .returning();
      const [total] = await tx
        .select({
          total: sql<number>`coalesce(sum(${productOrderRefunds.amountCents}), 0)`,
        })
        .from(productOrderRefunds)
        .where(
          and(
            eq(productOrderRefunds.orderId, claimed.order.id),
            eq(productOrderRefunds.status, "succeeded"),
          ),
        );
      if (Number(total?.total ?? 0) >= claimed.order.amountCents)
        await tx
          .update(checkoutOrders)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(eq(checkoutOrders.id, claimed.order.id));
      return updated!;
    });
  } catch (error) {
    const deterministic = error instanceof HelcimApiError && error.status < 500;
    const [updated] = await db
      .update(productOrderRefunds)
      .set({
        status: deterministic ? "failed" : "outcome_unknown",
        unknownOutcomeAt: deterministic ? null : new Date(),
        lastErrorCode: refundErrorCode(error),
        updatedAt: new Date(),
      })
      .where(eq(productOrderRefunds.id, refundId))
      .returning();
    return updated!;
  }
}

export async function reconcileProductOrderRefund(input: {
  originalTransactionId: string;
  providerRefundId: string;
  amountCents: number;
}): Promise<boolean> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    return false;
  return getPrivateDb().transaction(async (tx) => {
    const [match] = await tx
      .select({ refund: productOrderRefunds, order: checkoutOrders })
      .from(productOrderRefunds)
      .innerJoin(
        checkoutOrders,
        eq(productOrderRefunds.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(
            productOrderRefunds.originalTransactionId,
            input.originalTransactionId,
          ),
          eq(productOrderRefunds.amountCents, input.amountCents),
          inArray(productOrderRefunds.status, [
            "processing",
            "outcome_unknown",
          ]),
        ),
      )
      .for("update")
      .limit(1);
    if (!match) return false;
    await tx
      .update(productOrderRefunds)
      .set({
        status: "succeeded",
        providerRefundId: input.providerRefundId,
        succeededAt: new Date(),
        unknownOutcomeAt: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(productOrderRefunds.id, match.refund.id));
    const [total] = await tx
      .select({
        total: sql<number>`coalesce(sum(${productOrderRefunds.amountCents}), 0)`,
      })
      .from(productOrderRefunds)
      .where(
        and(
          eq(productOrderRefunds.orderId, match.order.id),
          eq(productOrderRefunds.status, "succeeded"),
        ),
      );
    if (Number(total?.total ?? 0) >= match.order.amountCents)
      await tx
        .update(checkoutOrders)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(checkoutOrders.id, match.order.id));
    return true;
  });
}

function refundErrorCode(error: unknown): string {
  if (error instanceof HelcimApiError) return `HELCIM_${error.status}`;
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return "OUTCOME_UNKNOWN";
}
