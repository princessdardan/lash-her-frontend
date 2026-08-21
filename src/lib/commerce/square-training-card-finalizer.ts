import "server-only";

import { and, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders } from "@/lib/private-db/schema";

/**
 * Square primary-training card finalizer.
 *
 * Marks a reserved Square training order paid once its authorization is
 * captured. Training has no obligation/money-ledger row (that is product-only);
 * the `checkout_orders` row itself carries the payment (providerPaymentId), the
 * same shape the Afterpay invoice flow uses. Verification is server-authoritative
 * (amount/currency must match the reserved order) and the paid transition is
 * idempotent on the Square payment id.
 */
export interface FinalizeSquareTrainingCardPaymentInput {
  orderReference: string;
  squarePaymentId: string;
  amountCents: number;
  currency: string;
  providerType: string;
  providerStatus: string;
}

export type SquareTrainingCardTransition =
  | "applied"
  | "already_applied"
  | "not_found"
  | "amount_or_currency_mismatch"
  | "transaction_conflict"
  | "state_conflict";

export interface FinalizeSquareTrainingCardPaymentResult {
  transition: SquareTrainingCardTransition;
}

export async function finalizeSquareTrainingCardPayment(
  input: FinalizeSquareTrainingCardPaymentInput,
): Promise<FinalizeSquareTrainingCardPaymentResult> {
  const now = new Date();

  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "training"),
          eq(checkoutOrders.paymentProvider, "square"),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) {
      return { transition: "not_found" as const };
    }

    // Server-authoritative amount/currency guard against the reserved order.
    if (
      input.amountCents !== order.amountCents ||
      input.currency.toUpperCase() !== order.currency.toUpperCase()
    ) {
      return { transition: "amount_or_currency_mismatch" as const };
    }

    if (order.status === "paid") {
      return order.providerPaymentId === input.squarePaymentId
        ? { transition: "already_applied" as const }
        : { transition: "transaction_conflict" as const };
    }

    if (order.status !== "pending") {
      return { transition: "state_conflict" as const };
    }

    const [updated] = await tx
      .update(checkoutOrders)
      .set({
        status: "paid",
        providerPaymentId: input.squarePaymentId,
        providerStatus: input.providerStatus,
        paidAt: order.paidAt ?? now,
        providerMetadata: {
          ...(order.providerMetadata ?? {}),
          finalizationStatus: "paid",
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutOrders.id, order.id),
          eq(checkoutOrders.status, "pending"),
        ),
      )
      .returning({ id: checkoutOrders.id });
    if (!updated) {
      return { transition: "state_conflict" as const };
    }

    return { transition: "applied" as const };
  });
}
