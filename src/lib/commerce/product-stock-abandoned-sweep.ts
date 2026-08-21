import "server-only";

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { log } from "@/lib/logging/logger";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
  productShipments,
} from "@/lib/private-db/schema";

import { releaseProductStockForOrderInTransaction } from "./product-stock-store";

// A product order reserves stock at creation and commits it at payment. If the
// buyer abandons before paying (the synchronous charge never completes and no
// webhook recovers it), the reservation would otherwise be held forever. This
// sweep releases those holds and cancels the dead order.
//
// It is deliberately conservative: it acts only after a generous grace beyond
// the reservation lease (`orderPaymentObligations.expiresAt`) and only when NO
// captured payment transaction exists — so a paid-but-not-yet-finalized order is
// never cancelled here. Cancelling (rather than leaving the order pending) is
// what keeps a late payment safe: the finalizer requires a `pending` order to
// apply, so a straggling capture lands in `state_conflict` and is handled by
// payment reconciliation instead of silently selling an un-decremented unit.
const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 60 min past the lease
const DEFAULT_BATCH_LIMIT = 200;

export interface AbandonedStockSweepResult {
  scanned: number;
  released: number;
  skipped: number;
  failed: number;
}

export interface AbandonedStockSweepOptions {
  now?: Date;
  graceMs?: number;
  limit?: number;
}

export async function releaseAbandonedProductStockReservations(
  options: AbandonedStockSweepOptions = {},
): Promise<AbandonedStockSweepResult> {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const cutoff = new Date(now.getTime() - graceMs);
  const db = getPrivateDb();

  const candidates = await db
    .select({ orderId: checkoutOrders.orderId })
    .from(checkoutOrders)
    .innerJoin(
      orderPaymentObligations,
      and(
        eq(orderPaymentObligations.orderId, checkoutOrders.id),
        eq(orderPaymentObligations.purpose, "primary"),
      ),
    )
    .where(
      and(
        eq(checkoutOrders.purpose, "product"),
        eq(checkoutOrders.status, "pending"),
        // No captured payment recorded on the order (defense in depth alongside
        // the per-order transaction check below).
        isNull(checkoutOrders.providerPaymentId),
        eq(orderPaymentObligations.status, "pending"),
        isNotNull(orderPaymentObligations.expiresAt),
        lt(orderPaymentObligations.expiresAt, cutoff),
      ),
    )
    .limit(limit);

  let released = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // Isolate each order: one failing cancellation (e.g. a lock timeout) must
    // not abort the rest of the batch.
    try {
      const outcome = await releaseAbandonedOrder(candidate.orderId, now);
      if (outcome === "released") {
        released += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      log("error", "[product-stock-sweep] Failed to release abandoned order", {
        orderId: candidate.orderId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return { scanned: candidates.length, released, skipped, failed };
}

async function releaseAbandonedOrder(
  orderId: string,
  now: Date,
): Promise<"released" | "skipped"> {
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: checkoutOrders.id,
        status: checkoutOrders.status,
        providerPaymentId: checkoutOrders.providerPaymentId,
      })
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, orderId),
          eq(checkoutOrders.purpose, "product"),
        ),
      )
      .for("update")
      .limit(1);
    // Re-check under the row lock: another path may have paid or cancelled it,
    // or a finalize may have stamped a payment id since the candidate scan.
    if (!order || order.status !== "pending" || order.providerPaymentId) {
      return "skipped";
    }

    const [obligation] = await tx
      .select({
        id: orderPaymentObligations.id,
        status: orderPaymentObligations.status,
      })
      .from(orderPaymentObligations)
      .where(
        and(
          eq(orderPaymentObligations.orderId, order.id),
          eq(orderPaymentObligations.purpose, "primary"),
        ),
      )
      .for("update")
      .limit(1);
    if (!obligation || obligation.status !== "pending") return "skipped";

    // Any captured payment -> leave it to the finalizer / reconciliation.
    const [payment] = await tx
      .select({ id: orderPaymentTransactions.id })
      .from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, obligation.id))
      .limit(1);
    if (payment) return "skipped";

    await releaseProductStockForOrderInTransaction(tx, orderId);

    await tx
      .update(orderPaymentObligations)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(orderPaymentObligations.id, obligation.id),
          eq(orderPaymentObligations.status, "pending"),
        ),
      );

    await tx
      .update(checkoutOrders)
      .set({ status: "cancelled", failedAt: now, updatedAt: now })
      .where(
        and(
          eq(checkoutOrders.id, order.id),
          eq(checkoutOrders.status, "pending"),
        ),
      );

    await tx
      .update(productShipments)
      .set({ status: "abandoned", updatedAt: now })
      .where(
        and(
          eq(productShipments.orderId, order.id),
          eq(productShipments.status, "payment_pending"),
        ),
      );

    // Audit trail: cancelling an abandoned order is expected, but logging each
    // one lets staff spot the rare case where a genuinely-captured payment
    // arrives after cancellation (finalize crash + prolonged webhook outage).
    log("info", "[product-stock-sweep] Released abandoned order reservation", {
      orderId,
    });

    return "released";
  });
}
