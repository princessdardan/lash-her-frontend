import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
} from "@/lib/private-db/schema";
import { activateShipmentForPaidOrderInTransaction } from "@/lib/shipping/shipment-store";
import { commitProductStockForOrderInTransaction } from "./product-stock-store";
import { reserveLateCaptureRefund } from "./late-capture-refund";

const SQUARE_COMPLETED_STATUS = "COMPLETED";

/**
 * Terminal, non-fulfillable states a primary product obligation/order can be in
 * when a captured Square payment finally lands. The abandoned-stock sweep sets
 * both the order and its primary obligation to `cancelled`; a manual cancel or a
 * prior refund can also produce these. A captured payment for one of these is a
 * late capture — it must be recorded and refunded, never fulfilled.
 */
function isTerminalPrimaryLateCapture(
  orderStatus: string,
  obligationStatus: string,
): boolean {
  return (
    orderStatus === "cancelled" ||
    orderStatus === "refunded" ||
    obligationStatus === "cancelled" ||
    obligationStatus === "superseded" ||
    obligationStatus === "refunded"
  );
}

/**
 * Square product-payment finalizer.
 *
 * The authoritative money-ledger writer for product checkout paid through
 * Square's embedded card flow. It provides the transactional guarantees product
 * checkout requires — amount/currency verification against the reserved
 * obligation, idempotent ledger insert keyed on the Square payment id, and
 * paid-state transition + shipment activation — under the lighter
 * verified-payment fulfillment gate: a captured Square payment whose amount and
 * currency match the obligation is treated as cleared. There is no certified
 * AVS/CVV contract assessment.
 *
 * Callers must have already verified with Square that the payment is captured
 * (status COMPLETED) before invoking this; the amount/currency re-check here is
 * the server-authoritative guard, not a substitute for that verification.
 */
export interface FinalizeSquareProductPaymentInput {
  orderReference: string;
  /** Square payment id (`payment.id`). Ledger idempotency key. */
  squarePaymentId: string;
  /** Verified captured amount, in cents, from the Square payment. */
  amountCents: number;
  /** Verified ISO currency from the Square payment (e.g. "CAD"). */
  currency: string;
  /** Square payment source type (e.g. "CARD"); stored as provider type. */
  providerType: string;
  /** Square payment status (e.g. "COMPLETED"); stored as provider status. */
  providerStatus: string;
}

export type SquareProductPaymentTransition =
  | "applied"
  | "already_applied"
  | "late_capture_refunded"
  | "not_found"
  | "amount_or_currency_mismatch"
  | "transaction_conflict"
  | "state_conflict";

export interface FinalizeSquareProductPaymentResult {
  transition: SquareProductPaymentTransition;
}

export async function finalizeSquareProductPayment(
  input: FinalizeSquareProductPaymentInput,
): Promise<FinalizeSquareProductPaymentResult> {
  const now = new Date();

  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.paymentProvider, "square"),
          isNull(checkoutOrders.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) {
      return { transition: "not_found" as const };
    }

    const [obligation] = await tx
      .select()
      .from(orderPaymentObligations)
      .where(
        and(
          eq(orderPaymentObligations.orderId, order.id),
          eq(orderPaymentObligations.purpose, "primary"),
          isNull(orderPaymentObligations.quarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!obligation) {
      return { transition: "state_conflict" as const };
    }

    // Server-authoritative amount/currency guard: the captured Square amount
    // must equal the reserved obligation (and, for the primary charge, the
    // order total). This is the core anti-tampering check.
    if (
      input.amountCents !== obligation.totalAmountCents ||
      input.currency.toUpperCase() !== obligation.currency.toUpperCase() ||
      order.amountCents !== obligation.totalAmountCents ||
      order.currency.toUpperCase() !== obligation.currency.toUpperCase()
    ) {
      return { transition: "amount_or_currency_mismatch" as const };
    }

    // Idempotent ledger insert keyed on (provider, providerTransactionId).
    const [existingTransaction] = await tx
      .select()
      .from(orderPaymentTransactions)
      .where(
        and(
          eq(orderPaymentTransactions.provider, "square"),
          eq(
            orderPaymentTransactions.providerTransactionId,
            input.squarePaymentId,
          ),
        ),
      )
      .limit(1);
    if (existingTransaction) {
      if (
        existingTransaction.obligationId !== obligation.id ||
        existingTransaction.amountCents !== obligation.totalAmountCents ||
        existingTransaction.currency.toUpperCase() !==
          obligation.currency.toUpperCase()
      ) {
        return { transition: "transaction_conflict" as const };
      }

      const stateMatches =
        obligation.status === "paid" &&
        order.status === "paid" &&
        order.providerPaymentId === input.squarePaymentId;
      if (!stateMatches) {
        // A recorded payment whose order never reached `paid`. The late-capture
        // branch below records the money and reserves the compensating refund in
        // the same transaction, so a webhook redelivery for a terminal
        // (swept/cancelled) order is an idempotent acknowledgement here — not a
        // spurious conflict that would strand the already-reserved refund.
        if (isTerminalPrimaryLateCapture(order.status, obligation.status)) {
          return { transition: "already_applied" as const };
        }
        return { transition: "state_conflict" as const };
      }

      // Re-drive shipment activation so a replayed webhook after a crash still
      // converges an already-paid, cleared, automated-shipping order.
      if (
        order.paymentRiskStatus === "cleared" &&
        order.fulfillmentMode === "automated_shipping"
      ) {
        const activated = await activateShipmentForPaidOrderInTransaction(
          tx,
          input.orderReference,
          now,
        );
        if (!activated) {
          throw new Error("Paid cleared shipment activation did not converge");
        }
      }
      return { transition: "already_applied" as const };
    }

    if (order.status !== "pending" || obligation.status !== "pending") {
      // W3 double-failure window: a captured Square payment arrives for a product
      // order that is no longer awaiting it. If the order/obligation reached a
      // terminal state (the abandoned-stock sweep cancels a genuinely-paid order
      // during a prolonged webhook outage, because the synchronous finalize had
      // crashed before recording the payment), this is a LATE CAPTURE. Record the
      // money and reserve a compensating refund so the customer is never charged
      // for a cancelled order — mirroring the supplemental late-capture path.
      //
      // Gated on a genuinely CAPTURED (COMPLETED) payment: the synchronous charge
      // core calls this finalizer with an APPROVED (authorized, UNcaptured)
      // payment before it captures, and voids that authorization if finalize does
      // not `apply`. Reserving a refund for an uncaptured authorization would
      // refund money that was never taken, so an APPROVED payment must fall
      // through to `state_conflict` (→ the charge core voids the hold) instead.
      if (
        input.providerStatus.toUpperCase() === SQUARE_COMPLETED_STATUS &&
        isTerminalPrimaryLateCapture(order.status, obligation.status)
      ) {
        const [lateTransaction] = await tx
          .insert(orderPaymentTransactions)
          .values({
            obligationId: obligation.id,
            provider: "square",
            providerTransactionId: input.squarePaymentId,
            amountCents: obligation.totalAmountCents,
            currency: obligation.currency.toUpperCase(),
            originatingIpCiphertext: order.refundOriginIpCiphertext,
            providerType: input.providerType,
            providerStatus: input.providerStatus,
            riskStatus: "cleared",
            riskReasonCodes: [],
            capturedAt: now,
          })
          .returning({ id: orderPaymentTransactions.id });
        if (!lateTransaction) {
          return { transition: "state_conflict" as const };
        }

        // Compensating refund for the captured funds — never fulfillment. Stock
        // was already released by the sweep, so this path must NOT commit stock.
        // Idempotent per (payment transaction, component); a webhook replay lands
        // in the already_applied branch above and never re-reserves.
        await reserveLateCaptureRefund(tx, {
          orderId: order.id,
          obligation,
          paymentTransactionId: lateTransaction.id,
          providerTransactionId: input.squarePaymentId,
          amountCents: obligation.totalAmountCents,
          reason: "late_capture_after_terminal_primary",
        });

        return { transition: "late_capture_refunded" as const };
      }
      return { transition: "state_conflict" as const };
    }

    const [createdTransaction] = await tx
      .insert(orderPaymentTransactions)
      .values({
        obligationId: obligation.id,
        provider: "square",
        providerTransactionId: input.squarePaymentId,
        amountCents: obligation.totalAmountCents,
        currency: obligation.currency.toUpperCase(),
        originatingIpCiphertext: order.refundOriginIpCiphertext,
        providerType: input.providerType,
        providerStatus: input.providerStatus,
        // Lighter verified-payment gate: a captured Square payment is cleared.
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: now,
      })
      .returning({ id: orderPaymentTransactions.id });
    if (!createdTransaction) {
      return { transition: "state_conflict" as const };
    }

    const [paidObligation] = await tx
      .update(orderPaymentObligations)
      .set({ status: "paid", paidAt: now, updatedAt: now })
      .where(
        and(
          eq(orderPaymentObligations.id, obligation.id),
          eq(orderPaymentObligations.status, "pending"),
        ),
      )
      .returning({ id: orderPaymentObligations.id });
    if (!paidObligation) {
      throw new Error("Payment obligation changed while finalizing");
    }

    await tx
      .update(checkoutOrders)
      .set({
        status: "paid",
        providerPaymentId: input.squarePaymentId,
        providerStatus: input.providerStatus,
        paymentRiskStatus: "cleared",
        manualFulfillmentStatus:
          order.manualFulfillmentStatus === "payment_pending"
            ? "paid_pending_dispatch"
            : order.manualFulfillmentStatus,
        paidAt: order.paidAt ?? now,
        updatedAt: now,
      })
      .where(eq(checkoutOrders.id, order.id));

    // First-time paid transition: convert this order's held stock into sold
    // units (onHand -= qty, reserved -= qty). Exactly-once, bound to the same
    // idempotency guarantee as the money ledger above — a replayed webhook lands
    // in the already_applied branch and never reaches here.
    await commitProductStockForOrderInTransaction(tx, input.orderReference);

    if (order.fulfillmentMode === "automated_shipping") {
      const activated = await activateShipmentForPaidOrderInTransaction(
        tx,
        input.orderReference,
        now,
      );
      if (!activated) {
        throw new Error("Paid cleared shipment activation did not converge");
      }
    }

    return { transition: "applied" as const };
  });
}
