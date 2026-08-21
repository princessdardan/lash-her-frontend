import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
} from "@/lib/private-db/schema";
import {
  classifyLateSupplementalReason,
  isLateSupplementalCapture,
  reserveLateCaptureRefund,
} from "@/lib/commerce/late-capture-refund";
import { sendShippingPolicyAlert } from "@/lib/shipping/policy-alerts";

/**
 * Square supplemental-obligation finalizer.
 *
 * Finalizes a paid Square payment link for a NON-primary payment obligation
 * (a post-order shipping top-up or address-change increase) under the lighter
 * verified-payment gate: verify amount/currency against the obligation, insert
 * the money-ledger row idempotently on the Square payment id, and then EITHER
 * apply the fulfillment transition (fresh, in-window payment) OR — for a
 * payment that arrives after the offer window closed (expired obligation,
 * cancelled/refunded order, pickup race, or a superseded address change) —
 * record the capture and reserve a compensating refund so funds are never
 * silently kept or stranded.
 */
export interface FinalizeSquareSupplementalObligationInput {
  obligationId: string;
  squarePaymentId: string;
  amountCents: number;
  currency: string;
  providerType: string;
  providerStatus: string;
}

export type SquareSupplementalTransition =
  | "applied"
  | "already_applied"
  | "late_capture_refunded"
  | "not_found"
  | "amount_or_currency_mismatch"
  | "transaction_conflict"
  | "state_conflict";

export interface FinalizeSquareSupplementalObligationResult {
  transition: SquareSupplementalTransition;
}

export async function finalizeSquareSupplementalObligation(
  input: FinalizeSquareSupplementalObligationInput,
): Promise<FinalizeSquareSupplementalObligationResult> {
  const now = new Date();

  return getPrivateDb().transaction(async (tx) => {
    const [obligation] = await tx
      .select()
      .from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, input.obligationId))
      .for("update")
      .limit(1);
    if (
      !obligation ||
      obligation.purpose === "primary" ||
      obligation.paymentProvider !== "square"
    ) {
      return { transition: "not_found" as const };
    }
    if (obligation.quarantinedAt !== null) {
      // A verified Square payment landed on an obligation that is quarantined
      // (e.g. by an admin). But if THIS payment was already recorded on this
      // obligation — i.e. it was applied first and the obligation was quarantined
      // during a later review — a webhook replay must NOT re-alert "not applied":
      // the money is already on the ledger, and a misleading "reconcile (apply or
      // refund) by hand" alert could induce an operator double-refund. Only a
      // genuinely stranded capture (no recorded transaction for this payment)
      // warrants the finance alert.
      const [priorTransaction] = await tx
        .select({ id: orderPaymentTransactions.id })
        .from(orderPaymentTransactions)
        .where(
          and(
            eq(orderPaymentTransactions.obligationId, obligation.id),
            eq(orderPaymentTransactions.provider, "square"),
            eq(
              orderPaymentTransactions.providerTransactionId,
              input.squarePaymentId,
            ),
          ),
        )
        .limit(1);
      if (priorTransaction) {
        return { transition: "already_applied" as const };
      }
      // Not yet recorded: we can neither apply it (quarantined) nor safely
      // auto-refund mid-investigation, so surface a finance alert instead of
      // silently stranding the funds. Idempotent on the Square payment id so
      // webhook retries don't re-notify.
      await sendShippingPolicyAlert({
        duties: ["finance_owner"],
        critical: true,
        subject: "Square supplemental payment on a quarantined obligation",
        message: `Square payment ${input.squarePaymentId} (${input.amountCents} cents ${input.currency}) settled supplemental obligation ${obligation.id}, which is quarantined. The capture was not applied — reconcile (apply or refund) by hand.`,
        idempotencyKey: `supplemental-stranded-quarantine/${input.squarePaymentId}`,
        executor: tx,
      });
      return { transition: "not_found" as const };
    }

    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.id, obligation.orderId),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.paymentProvider, "square"),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) {
      return { transition: "not_found" as const };
    }

    // Server-authoritative amount/currency guard against the reserved top-up.
    if (
      input.amountCents !== obligation.totalAmountCents ||
      input.currency.toUpperCase() !== obligation.currency.toUpperCase()
    ) {
      // A verified payment whose amount/currency does not match the reserved
      // top-up cannot be applied (should not happen with fixed-price links).
      // Surface it rather than silently dropping the captured funds. Idempotent
      // on the Square payment id.
      await sendShippingPolicyAlert({
        duties: ["finance_owner"],
        critical: true,
        subject: "Square supplemental payment amount/currency mismatch",
        message: `Square payment ${input.squarePaymentId} (${input.amountCents} cents ${input.currency}) does not match supplemental obligation ${obligation.id} (${obligation.totalAmountCents} cents ${obligation.currency}). The capture was not applied — reconcile by hand.`,
        idempotencyKey: `supplemental-stranded-mismatch/${input.squarePaymentId}`,
        executor: tx,
      });
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
      // Same Square payment replayed — the money is already recorded.
      return { transition: "already_applied" as const };
    }

    // Record the captured money before deciding fulfillment vs refund.
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
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: now,
      })
      .returning({ id: orderPaymentTransactions.id });
    if (!createdTransaction) {
      return { transition: "state_conflict" as const };
    }

    const late = isLateSupplementalCapture({
      obligation,
      orderStatus: order.status,
      manualFulfillmentStatus: order.manualFulfillmentStatus,
      now,
    });
    const stillOffered = await isSupplementalOfferStillOpen(
      tx,
      obligation,
      order,
    );

    // A payment for a closed/expired offer (or a double payment on the link):
    // record it and reserve a compensating refund — never fulfill or strand it.
    if (obligation.status !== "pending" || late || !stillOffered) {
      await reserveLateCaptureRefund(tx, {
        orderId: order.id,
        obligation,
        paymentTransactionId: createdTransaction.id,
        providerTransactionId: input.squarePaymentId,
        amountCents: obligation.totalAmountCents,
        reason: classifyLateSupplementalReason(obligation.purpose),
      });
      return { transition: "late_capture_refunded" as const };
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

    if (obligation.purpose === "manual_shipping") {
      await tx
        .update(checkoutOrders)
        .set({
          fulfillmentMode: "manual_shipping",
          manualFulfillmentStatus: "paid_pending_dispatch",
          updatedAt: now,
        })
        .where(
          and(
            eq(checkoutOrders.id, order.id),
            eq(checkoutOrders.status, "paid"),
            eq(checkoutOrders.fulfillmentMode, "manual_pickup"),
            eq(checkoutOrders.manualFulfillmentStatus, "paid_pending_dispatch"),
          ),
        );
    }

    await tx
      .update(productOrderCustomerDecisions)
      .set({
        status: "selected",
        selectedOutcome: "pay",
        selectedAt: now,
        consumedAt: now,
        processedAt: now,
        stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderCustomerDecisions.orderId, order.id),
          eq(productOrderCustomerDecisions.kind, "supplemental_payment"),
          eq(
            productOrderCustomerDecisions.scopeKey,
            `supplemental-payment/${obligation.id}`,
          ),
          eq(productOrderCustomerDecisions.status, "pending"),
        ),
      );

    return { transition: "applied" as const };
  });
}

/**
 * Whether the supplemental offer is still in a fulfillable state (matches the
 * poll route's payability gate). Manual-shipping must still be a paid pickup
 * awaiting dispatch; an address increase must have an approved request still
 * awaiting this supplemental payment.
 */
async function isSupplementalOfferStillOpen(
  tx: Parameters<
    Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
  >[0],
  obligation: typeof orderPaymentObligations.$inferSelect,
  order: typeof checkoutOrders.$inferSelect,
): Promise<boolean> {
  if (order.status !== "paid") {
    return false;
  }
  if (obligation.purpose === "manual_shipping") {
    return (
      order.fulfillmentMode === "manual_pickup" &&
      order.manualFulfillmentStatus === "paid_pending_dispatch"
    );
  }
  if (obligation.purpose === "address_increase") {
    if (!obligation.sourceReferenceId) {
      return false;
    }
    const [request] = await tx
      .select({ id: productOrderAddressChangeRequests.id })
      .from(productOrderAddressChangeRequests)
      .where(
        and(
          eq(
            productOrderAddressChangeRequests.id,
            obligation.sourceReferenceId,
          ),
          eq(productOrderAddressChangeRequests.orderId, order.id),
          eq(
            productOrderAddressChangeRequests.supplementalObligationId,
            obligation.id,
          ),
          eq(productOrderAddressChangeRequests.status, "approved"),
          eq(
            productOrderAddressChangeRequests.reconciliationState,
            "awaiting_supplemental_payment",
          ),
        ),
      )
      .limit(1);
    return Boolean(request);
  }
  return false;
}
