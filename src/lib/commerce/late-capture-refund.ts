import "server-only";

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  orderPaymentObligations,
  productOrderAdjustments,
  productOrderRefunds,
} from "@/lib/private-db/schema";

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export type LateCaptureReason =
  | "late_capture_after_manual_cancellation"
  | "late_capture_after_obsolete_address_change"
  | "late_capture_after_terminal_primary";

/**
 * A supplemental payment that arrives after its offer window is a late capture:
 * the obligation was cancelled/superseded/refunded or has expired, the order was
 * cancelled/refunded, or a manual-shipping order already dispatched/cancelled.
 * The money must be recorded and refunded, never treated as a fresh fulfillment.
 */
export function isLateSupplementalCapture(input: {
  obligation: typeof orderPaymentObligations.$inferSelect;
  orderStatus: string;
  manualFulfillmentStatus: string | null;
  now: Date;
}): boolean {
  return (
    ["cancelled", "superseded", "refunded"].includes(input.obligation.status) ||
    (input.obligation.expiresAt !== null &&
      input.obligation.expiresAt <= input.now) ||
    ["cancelled", "refunded"].includes(input.orderStatus) ||
    (input.obligation.purpose === "manual_shipping" &&
      ["dispatched", "cancelled"].includes(input.manualFulfillmentStatus ?? ""))
  );
}

export function classifyLateSupplementalReason(
  purpose: string,
): LateCaptureReason {
  return purpose === "address_increase"
    ? "late_capture_after_obsolete_address_change"
    : "late_capture_after_manual_cancellation";
}

/**
 * Reserve a compensating refund for captured funds that can no longer be applied
 * to fulfillment. Idempotent per payment transaction + component. Ported from the
 * (Helcim) product finalizer so the Square supplemental flow keeps the same
 * fund-safety guarantee.
 */
export async function reserveLateCaptureRefund(
  tx: DbTransaction,
  input: {
    orderId: string;
    obligation: typeof orderPaymentObligations.$inferSelect;
    paymentTransactionId: string;
    providerTransactionId: string;
    amountCents: number;
    reason: LateCaptureReason;
  },
): Promise<void> {
  const existing = await tx
    .select({ amountCents: productOrderRefunds.amountCents })
    .from(productOrderRefunds)
    .where(
      and(
        eq(
          productOrderRefunds.paymentTransactionId,
          input.paymentTransactionId,
        ),
        eq(productOrderRefunds.reason, input.reason),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    );
  const existingTotal = existing.reduce(
    (total, refund) => total + refund.amountCents,
    0,
  );
  if (existingTotal === input.amountCents) return;
  if (existingTotal !== 0) {
    throw new Error("Late-capture refund ledger is only partially reserved");
  }
  const components = [
    ["merchandise", input.obligation.merchandiseAmountCents],
    ["tax", input.obligation.taxAmountCents],
    ["outbound_shipping", input.obligation.shippingAmountCents],
  ] as const;
  const componentTotal = components.reduce(
    (total, [, amountCents]) => total + amountCents,
    0,
  );
  if (componentTotal !== input.amountCents) {
    throw new Error("Late-capture components do not equal the captured amount");
  }
  for (const [component, amountCents] of components) {
    if (amountCents <= 0) continue;
    const adjustmentKey = `late-capture-refund/${input.paymentTransactionId}/${component}`;
    const [adjustment] = await tx
      .insert(productOrderAdjustments)
      .values({
        orderId: input.orderId,
        direction: "refund",
        component,
        reason: "late_capture_after_terminal_obligation",
        sourceAddressRequestId:
          input.obligation.purpose === "address_increase"
            ? input.obligation.sourceReferenceId
            : null,
        amountCents,
        status: "reserved",
        idempotencyKey: adjustmentKey,
      })
      .onConflictDoNothing({ target: productOrderAdjustments.idempotencyKey })
      .returning({ id: productOrderAdjustments.id });
    const adjustmentId =
      adjustment?.id ??
      (
        await tx
          .select({ id: productOrderAdjustments.id })
          .from(productOrderAdjustments)
          .where(eq(productOrderAdjustments.idempotencyKey, adjustmentKey))
          .limit(1)
      )[0]?.id;
    if (!adjustmentId) {
      throw new Error("Late-capture adjustment was not reserved");
    }
    await tx
      .insert(productOrderRefunds)
      .values({
        orderId: input.orderId,
        paymentTransactionId: input.paymentTransactionId,
        originalTransactionId: input.providerTransactionId,
        idempotencyKey: semanticRefundUuid(adjustmentKey),
        kind: amountCents === input.amountCents ? "full" : "partial",
        reason: input.reason,
        amountCents,
        adjustmentId,
        automated: true,
        status: "queued",
      })
      .onConflictDoNothing({ target: productOrderRefunds.idempotencyKey });
  }
}

function semanticRefundUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
