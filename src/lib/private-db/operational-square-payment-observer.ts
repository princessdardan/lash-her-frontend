import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import type { SquarePayment } from "@/lib/payments/square/payments-client";

import { getPrivateDb } from "./client";
import { appointmentHolds, bookingPaymentAttempts } from "./schema";

export type OperationalSquarePaymentObservationResult =
  | { status: "not_operational" }
  | { holdId: string; paymentAttemptId: string; status: "observed" };

export async function observeOperationalSquarePayment(
  payment: SquarePayment,
  now: Date,
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): Promise<OperationalSquarePaymentObservationResult> {
  const referenceId = payment.reference_id?.trim();
  if (!referenceId) return { status: "not_operational" };

  return db.transaction(async (tx) => {
    const [hold] = await tx
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.publicReference, referenceId))
      .limit(1)
      .for("update");
    if (hold === undefined || hold.bookingModelVersion !== 2) {
      return { status: "not_operational" } as const;
    }

    const [attempt] = await tx
      .select()
      .from(bookingPaymentAttempts)
      .where(
        and(
          eq(bookingPaymentAttempts.holdId, hold.id),
          eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
          eq(bookingPaymentAttempts.paymentProvider, "square"),
          inArray(bookingPaymentAttempts.status, ["pending", "authorized"]),
        ),
      )
      .orderBy(desc(bookingPaymentAttempts.createdAt))
      .limit(1)
      .for("update");
    if (attempt === undefined) return { status: "not_operational" } as const;

    const intent = readRequestIntent(attempt.providerMetadata);
    if (
      intent === null ||
      intent.referenceId !== referenceId ||
      attempt.amountCents !== payment.amount_money.amount ||
      attempt.currency !== payment.amount_money.currency.trim().toUpperCase() ||
      intent.squareCustomerId !== payment.customer_id ||
      (intent.squareTeamMemberId ?? undefined) !== payment.team_member_id
    ) {
      return { status: "not_operational" } as const;
    }

    const providerMetadata = isRecord(attempt.providerMetadata)
      ? attempt.providerMetadata
      : {};
    const terminalStatus = payment.status.trim().toUpperCase();
    const localStatus =
      terminalStatus === "CANCELED"
        ? "cancelled"
        : ["FAILED", "DECLINED"].includes(terminalStatus)
          ? "failed"
          : attempt.status;

    await tx
      .update(bookingPaymentAttempts)
      .set({
        failedAt: localStatus === "failed" ? now : attempt.failedAt,
        providerMetadata: {
          ...providerMetadata,
          squareWebhookObservation: {
            observedAt: now.toISOString(),
            providerStatus: terminalStatus,
          },
        },
        providerOrderId: payment.order_id ?? attempt.providerOrderId,
        providerPaymentId: payment.id,
        status: localStatus,
        updatedAt: now,
      })
      .where(eq(bookingPaymentAttempts.id, attempt.id));

    return {
      holdId: hold.id,
      paymentAttemptId: attempt.id,
      status: "observed",
    } as const;
  });
}

function readRequestIntent(value: unknown): {
  referenceId: string;
  squareCustomerId: string;
  squareTeamMemberId?: string;
} | null {
  if (!isRecord(value) || !isRecord(value.squareRequestIntent)) return null;
  const intent = value.squareRequestIntent;
  if (
    typeof intent.referenceId !== "string" ||
    typeof intent.squareCustomerId !== "string"
  ) {
    return null;
  }
  if (
    intent.squareTeamMemberId !== undefined &&
    typeof intent.squareTeamMemberId !== "string"
  ) {
    return null;
  }
  return {
    referenceId: intent.referenceId,
    squareCustomerId: intent.squareCustomerId,
    squareTeamMemberId: intent.squareTeamMemberId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
