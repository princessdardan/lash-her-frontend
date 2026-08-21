import "server-only";

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { log } from "@/lib/logging/logger";
import type { SquarePayment } from "@/lib/payments/square/payments-client";
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

/**
 * What the payment provider (Square) authoritatively knows about an order:
 * - "captured": a COMPLETED payment exists — the order may be genuinely paid.
 * - "authorized": an APPROVED (held, uncaptured) payment exists — it may still
 *   capture, so the reservation must not be released yet.
 * - "absent": the provider has no live claim on funds for this order.
 */
export type ProviderPaymentVerdict = "captured" | "authorized" | "absent";

export interface AbandonedOrderProviderCheck {
  orderReference: string;
  /** Order creation time — bounds the provider lookup window by payment date. */
  createdAt: Date;
}

export type AbandonedOrderProviderVerifier = (
  input: AbandonedOrderProviderCheck,
) => Promise<ProviderPaymentVerdict>;

export interface AbandonedStockSweepOptions {
  now?: Date;
  graceMs?: number;
  limit?: number;
  /**
   * Optional provider re-verification (mitigation for the W3 double-failure).
   * Before an order is cancelled, this re-checks Square for a captured/authorized
   * payment keyed on the order's reference; a positive verdict skips the
   * cancellation so a genuinely-paid order is never swept. Best-effort: a thrown
   * error is treated as "unverified" and the sweep proceeds — a wrongful
   * cancellation is still backstopped by the late-capture refund path in the
   * finalizer, which auto-refunds any capture that lands on a cancelled order.
   */
  verifyProviderPayment?: AbandonedOrderProviderVerifier;
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
    .select({
      orderId: checkoutOrders.orderId,
      createdAt: checkoutOrders.createdAt,
    })
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
      // Provider re-verification (W3): a captured/authorized Square payment for
      // this order means it may be genuinely paid despite carrying no local
      // payment row (the synchronous finalize crashed before recording it and
      // the webhook is delayed past the grace). Do NOT cancel it. Run this
      // BEFORE the row-locked cancellation transaction so the lock is never held
      // across the network round-trip. Failures fall through to "absent" so the
      // sweep still makes progress; the finalizer's late-capture refund backstops
      // a wrongful cancellation.
      if (options.verifyProviderPayment) {
        let verdict: ProviderPaymentVerdict = "absent";
        try {
          verdict = await options.verifyProviderPayment({
            orderReference: candidate.orderId,
            createdAt: candidate.createdAt,
          });
        } catch (error) {
          log(
            "warn",
            "[product-stock-sweep] Provider re-verification failed; proceeding",
            {
              orderId: candidate.orderId,
              error: error instanceof Error ? error.message : "unknown",
            },
          );
        }
        if (verdict !== "absent") {
          skipped += 1;
          log(
            "info",
            "[product-stock-sweep] Skipped cancel: provider reports a payment",
            { orderId: candidate.orderId, verdict },
          );
          continue;
        }
      }

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

// Square records a payment (authorization) at charge time, so its `created_at`
// tracks the order's creation, not its later capture. A window around the
// order's createdAt reliably contains the payment while bounding the scan.
const PROVIDER_LOOKBACK_MS = 15 * 60 * 1000; // 15 min before creation
const PROVIDER_LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // 24 h after creation
const PROVIDER_PAGE_LIMIT = 100;
const PROVIDER_MAX_PAGES = 4;

type SquarePaymentsReader = Pick<
  import("@/lib/payments/square/payments-client").SquarePaymentsClient,
  "listPayments"
>;

/**
 * Live sweep wiring: resolves Square commerce credentials and re-verifies each
 * abandoned order against Square before cancelling it (W3 defense-in-depth).
 * When Square commerce is disabled the verifier is omitted and the sweep behaves
 * exactly as before — the finalizer's late-capture refund remains the backstop.
 */
export async function runAbandonedProductStockSweep(
  options: AbandonedStockSweepOptions = {},
): Promise<AbandonedStockSweepResult> {
  const [{ getSquareCommerceEnv }, { createSquarePaymentsClient }] =
    await Promise.all([
      import("@/lib/env/private-checkout"),
      import("@/lib/payments/square/payments-client"),
    ]);

  const env = getSquareCommerceEnv();
  if (env === null) {
    return releaseAbandonedProductStockReservations(options);
  }

  const client = createSquarePaymentsClient(env);
  return releaseAbandonedProductStockReservations({
    ...options,
    verifyProviderPayment: (input) =>
      verifySquareCommercePayment(client, input),
  });
}

/**
 * Resolve what Square knows about an abandoned order's payment to a sweep
 * verdict, looking the payment up by the order's Square reference (the order has
 * no local payment id). A CANCELED/FAILED payment carries no live claim on funds
 * and is treated as "absent" so the reservation can be cleaned up.
 */
export async function verifySquareCommercePayment(
  client: SquarePaymentsReader,
  input: AbandonedOrderProviderCheck,
): Promise<ProviderPaymentVerdict> {
  const payment = await findSquareCommercePaymentByReference(client, input);
  if (!payment) return "absent";
  const status = payment.status.toUpperCase();
  if (status === "COMPLETED") return "captured";
  if (status === "APPROVED" || status === "AUTHORIZED") return "authorized";
  return "absent";
}

async function findSquareCommercePaymentByReference(
  client: SquarePaymentsReader,
  input: AbandonedOrderProviderCheck,
) {
  const beginTime = new Date(
    input.createdAt.getTime() - PROVIDER_LOOKBACK_MS,
  ).toISOString();
  const endTime = new Date(
    input.createdAt.getTime() + PROVIDER_LOOKAHEAD_MS,
  ).toISOString();

  let cursor: string | undefined;
  // Prefer a LIVE payment for the reference over a dead one: a COMPLETED capture
  // wins outright; an APPROVED (held) authorization is remembered while we keep
  // scanning for a capture. A CANCELED/FAILED attempt for the same reference must
  // never shadow a later capture and cause a paid order to be swept. (In practice
  // the deterministic idempotency key yields one payment per reference, so this
  // only matters as defense in depth.)
  let heldAuthorization: SquarePayment | null = null;
  for (let page = 0; page < PROVIDER_MAX_PAGES; page += 1) {
    const response = await client.listPayments({
      beginTime,
      endTime,
      sortOrder: "ASC",
      limit: PROVIDER_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const payment of response.payments) {
      if (payment.reference_id !== input.orderReference) continue;
      const status = payment.status.toUpperCase();
      if (status === "COMPLETED") return payment;
      if (
        (status === "APPROVED" || status === "AUTHORIZED") &&
        heldAuthorization === null
      ) {
        heldAuthorization = payment;
      }
    }
    if (!response.cursor) break;
    cursor = response.cursor;
  }
  // No capture found within the page budget: surface a held authorization if we
  // saw one, else report not-found and let the finalizer's late-capture refund
  // backstop the rare miss.
  return heldAuthorization;
}
