import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import type { SquarePayment } from "@/lib/payments/square/payments-client";

import { getPrivateDb } from "./client";
import { appointmentHolds, bookingPaymentAttempts } from "./schema";

export type OperationalSquarePaymentObservationResult =
  | { status: "not_operational" }
  | { holdId: string; paymentAttemptId: string; status: "observed" };

interface CompletedOperationalPaymentEvidence {
  amountCents: number;
  currency: string;
  holdId: string;
  idempotencyKey: string;
  now: Date;
  squareOrderId?: string;
  squarePaymentId: string;
}

interface OperationalSquarePaymentObserverDependencies {
  recordCompletedPayment(
    input: CompletedOperationalPaymentEvidence,
    db: ReturnType<typeof getPrivateDb>,
  ): Promise<void>;
}

export async function observeOperationalSquarePayment(
  payment: SquarePayment,
  now: Date,
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
  dependencies: OperationalSquarePaymentObserverDependencies =
    defaultDependencies,
): Promise<OperationalSquarePaymentObservationResult> {
  const referenceId = payment.reference_id?.trim();
  if (!referenceId) return { status: "not_operational" };

  const observation = await db.transaction(async (tx) => {
    const [hold] = await tx
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.publicReference, referenceId))
      .limit(1)
      .for("update");
    if (hold === undefined || hold.bookingModelVersion !== 2) {
      return {
        completedPayment: null,
        result: { status: "not_operational" } as const,
      };
    }

    const [attempt] = await tx
      .select()
      .from(bookingPaymentAttempts)
      .where(
        and(
          eq(bookingPaymentAttempts.holdId, hold.id),
          eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
          eq(bookingPaymentAttempts.paymentProvider, "square"),
          inArray(bookingPaymentAttempts.status, [
            "pending",
            "authorized",
            "captured",
          ]),
        ),
      )
      .orderBy(desc(bookingPaymentAttempts.createdAt))
      .limit(1)
      .for("update");
    if (attempt === undefined) {
      return {
        completedPayment: null,
        result: { status: "not_operational" } as const,
      };
    }

    const intent = readRequestIntent(attempt.providerMetadata);
    if (
      intent === null ||
      intent.referenceId !== referenceId ||
      attempt.amountCents !== payment.amount_money.amount ||
      attempt.currency !== payment.amount_money.currency.trim().toUpperCase() ||
      intent.squareCustomerId !== payment.customer_id ||
      (intent.squareTeamMemberId ?? undefined) !== payment.team_member_id
    ) {
      return {
        completedPayment: null,
        result: { status: "not_operational" } as const,
      };
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
          : terminalStatus === "APPROVED" || terminalStatus === "COMPLETED"
            ? "authorized"
            : attempt.status;
    const protectedLocalStatus =
      attempt.status === "captured" ? "captured" : localStatus;

    await tx
      .update(bookingPaymentAttempts)
      .set({
        authorizedAt:
          protectedLocalStatus === "authorized"
            ? (attempt.authorizedAt ?? now)
            : attempt.authorizedAt,
        failedAt:
          protectedLocalStatus === "failed" ? now : attempt.failedAt,
        providerMetadata: {
          ...providerMetadata,
          ...(payment.version_token === undefined
            ? {}
            : { squareVersionToken: payment.version_token }),
          squareWebhookObservation: {
            observedAt: now.toISOString(),
            providerStatus: terminalStatus,
          },
        },
        providerOrderId: payment.order_id ?? attempt.providerOrderId,
        providerPaymentId: payment.id,
        status: protectedLocalStatus,
        updatedAt: now,
      })
      .where(eq(bookingPaymentAttempts.id, attempt.id));

    return {
      completedPayment:
        terminalStatus === "COMPLETED"
          ? {
              amountCents: attempt.amountCents,
              currency: attempt.currency,
              holdId: hold.id,
              idempotencyKey: attempt.idempotencyKey,
              now,
              squareOrderId:
                payment.order_id ?? attempt.providerOrderId ?? undefined,
              squarePaymentId: payment.id,
            }
          : null,
      result: {
        holdId: hold.id,
        paymentAttemptId: attempt.id,
        status: "observed",
      } as const,
    };
  });

  if (observation.completedPayment !== null) {
    // Persist captured evidence before appointment projection. The repository
    // intentionally commits those steps separately, so a projection conflict
    // leaves a durable captured attempt for webhook retry and reconciliation.
    await dependencies.recordCompletedPayment(observation.completedPayment, db);
  }

  return observation.result;
}

const defaultDependencies: OperationalSquarePaymentObserverDependencies = {
  async recordCompletedPayment(input, db) {
    const { createServiceBookingPaymentRepository } = await import(
      "./service-booking-payment-repository"
    );
    const repository = await createServiceBookingPaymentRepository(db);
    if (repository.recordCapturedOperationalPayment === undefined) {
      throw new Error("Operational captured-payment writer is unavailable");
    }
    await repository.recordCapturedOperationalPayment(input);
  },
};

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
