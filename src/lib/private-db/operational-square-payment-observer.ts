import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import {
  createServicePaymentAlertLogger,
  type ServicePaymentAlertLogger,
} from "@/lib/booking/payments/service-payment-alerts";
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
  alerts: ServicePaymentAlertLogger;
  cancelPayment(paymentId: string): Promise<{ payment: SquarePayment }>;
  markHoldPaymentFailed(input: {
    holdId: string;
    now: Date;
    reason: string;
  }): Promise<void>;
  markHoldRefundRequired(input: {
    holdId: string;
    idempotencyKey: string;
    now: Date;
    providerEvidence: "cancellation_unconfirmed" | "completed";
    reason: string;
    squarePaymentId: string;
  }): Promise<unknown>;
  markPaymentTerminated(input: {
    holdId: string;
    idempotencyKey: string;
    now: Date;
    squarePaymentId: string;
    status: "cancelled" | "failed";
  }): Promise<"cancelled" | "failed" | "capture_preserved" | "not_found">;
  recordCompletedPayment(
    input: CompletedOperationalPaymentEvidence,
    db: ReturnType<typeof getPrivateDb>,
  ): Promise<void>;
}

export async function observeOperationalSquarePayment(
  payment: SquarePayment,
  now: Date,
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
  dependencyOverrides: Partial<OperationalSquarePaymentObserverDependencies> = {},
): Promise<OperationalSquarePaymentObservationResult> {
  const dependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
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
        paymentIdentityConflict: null,
        remediation: null,
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
        paymentIdentityConflict: null,
        remediation: null,
        result: { status: "not_operational" } as const,
      };
    }

    const intent = readRequestIntent(attempt.providerMetadata);
    if (
      intent === null ||
      intent.referenceId !== referenceId ||
      attempt.amountCents !== payment.amount_money.amount ||
      attempt.currency !== payment.amount_money.currency.trim().toUpperCase() ||
      intent.squareCustomerId !== payment.customer_id
    ) {
      return {
        completedPayment: null,
        paymentIdentityConflict: null,
        remediation: null,
        result: { status: "not_operational" } as const,
      };
    }

    const paymentIdentityConflict =
      (attempt.providerPaymentId !== null &&
        attempt.providerPaymentId !== payment.id) ||
      (attempt.providerPaymentId === null && attempt.status !== "pending");
    if (paymentIdentityConflict) {
      return {
        completedPayment: null,
        paymentIdentityConflict: {
          boundSquarePaymentId: attempt.providerPaymentId,
          holdId: hold.id,
          incomingSquarePaymentId: payment.id,
          paymentAttemptId: attempt.id,
          paymentAttemptStatus: attempt.status,
        },
        remediation: null,
        result: {
          holdId: hold.id,
          paymentAttemptId: attempt.id,
          status: "observed",
        } as const,
      };
    }

    const expectedSquareTeamMemberId =
      attempt.squareTeamMemberId ?? intent.squareTeamMemberId;
    const attributionMismatch =
      (expectedSquareTeamMemberId ?? undefined) !== payment.team_member_id;
    const providerMetadata = isRecord(attempt.providerMetadata)
      ? attempt.providerMetadata
      : {};
    const terminalStatus = payment.status.trim().toUpperCase();
    const localStatus =
      terminalStatus === "CANCELED"
        ? "cancelled"
        : ["FAILED", "DECLINED"].includes(terminalStatus)
          ? "failed"
          : terminalStatus === "COMPLETED" && attributionMismatch
            ? "captured"
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
        capturedAt:
          protectedLocalStatus === "captured"
            ? (attempt.capturedAt ?? now)
            : attempt.capturedAt,
        failedAt: protectedLocalStatus === "failed" ? now : attempt.failedAt,
        providerMetadata: {
          ...providerMetadata,
          ...(payment.version_token === undefined
            ? {}
            : { squareVersionToken: payment.version_token }),
          squareWebhookObservation: {
            observedAt: now.toISOString(),
            providerStatus: terminalStatus,
          },
          ...(attributionMismatch
            ? {
                squareTeamAttributionMismatch: {
                  expectedSquareTeamMemberId:
                    expectedSquareTeamMemberId ?? null,
                  observedAt: now.toISOString(),
                  observedSquareTeamMemberId: payment.team_member_id ?? null,
                  providerStatus: terminalStatus,
                },
              }
            : {}),
        },
        providerOrderId: payment.order_id ?? attempt.providerOrderId,
        providerPaymentId: payment.id,
        status: protectedLocalStatus,
        updatedAt: now,
      })
      .where(eq(bookingPaymentAttempts.id, attempt.id));

    return {
      completedPayment:
        terminalStatus === "COMPLETED" && !attributionMismatch
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
      paymentIdentityConflict: null,
      remediation: attributionMismatch
        ? {
            expectedSquareTeamMemberId,
            holdId: hold.id,
            idempotencyKey: attempt.idempotencyKey,
            observedSquareTeamMemberId: payment.team_member_id,
            providerStatus: terminalStatus,
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

  if (observation.paymentIdentityConflict !== null) {
    await dependencies.alerts.alert({
      category: "stuck_payment_state",
      severity: "error",
      message:
        "Operational Square webhook payment ID did not match the immutable payment attempt",
      context: observation.paymentIdentityConflict,
    });
    return observation.result;
  }

  if (observation.remediation !== null) {
    await remediateAttributionMismatch(
      observation.remediation,
      now,
      dependencies,
    );
    return observation.result;
  }

  if (observation.completedPayment !== null) {
    // Persist captured evidence before appointment projection. The repository
    // intentionally commits those steps separately, so a projection conflict
    // leaves a durable captured attempt for webhook retry and reconciliation.
    await dependencies.recordCompletedPayment(observation.completedPayment, db);
  }

  return observation.result;
}

const defaultDependencies: OperationalSquarePaymentObserverDependencies = {
  alerts: createServicePaymentAlertLogger({}),
  async cancelPayment(paymentId) {
    const [
      { createSquarePaymentsClient },
      { getSquareServiceBookingRuntimeEnv },
    ] = await Promise.all([
      import("@/lib/payments/square/payments-client"),
      import("@/lib/booking/square-runtime"),
    ]);
    const env = getSquareServiceBookingRuntimeEnv();
    if (env === null) {
      throw new Error("Square service booking is not enabled");
    }
    return createSquarePaymentsClient(env).cancelPayment(paymentId);
  },
  async markHoldPaymentFailed(input) {
    const repository = await getOperationalPaymentRepository();
    await repository.markHoldPaymentFailed(input);
  },
  async markHoldRefundRequired(input) {
    const repository = await getOperationalPaymentRepository();
    return repository.markHoldRefundRequired(input);
  },
  async markPaymentTerminated(input) {
    const repository = await getOperationalPaymentRepository();
    if (repository.markAuthorizedOperationalPaymentTerminated === undefined) {
      throw new Error("Operational payment terminal writer is unavailable");
    }
    return repository.markAuthorizedOperationalPaymentTerminated(input);
  },
  async recordCompletedPayment(input, db) {
    const { createServiceBookingPaymentRepository } =
      await import("./service-booking-payment-repository");
    const repository = await createServiceBookingPaymentRepository(db);
    if (repository.recordCapturedOperationalPayment === undefined) {
      throw new Error("Operational captured-payment writer is unavailable");
    }
    await repository.recordCapturedOperationalPayment(input);
  },
};

async function remediateAttributionMismatch(
  input: {
    expectedSquareTeamMemberId?: string;
    holdId: string;
    idempotencyKey: string;
    observedSquareTeamMemberId?: string;
    providerStatus: string;
    squarePaymentId: string;
  },
  now: Date,
  dependencies: OperationalSquarePaymentObserverDependencies,
): Promise<void> {
  await dependencies.alerts.alert({
    category: "stuck_payment_state",
    severity: "error",
    message:
      "Operational Square webhook payment did not match the immutable team attribution",
    context: {
      expectedSquareTeamMemberId: input.expectedSquareTeamMemberId ?? null,
      holdId: input.holdId,
      observedSquareTeamMemberId: input.observedSquareTeamMemberId ?? null,
      providerStatus: input.providerStatus,
      squarePaymentId: input.squarePaymentId,
    },
  });

  if (input.providerStatus === "COMPLETED") {
    await dependencies.markHoldRefundRequired({
      holdId: input.holdId,
      idempotencyKey: input.idempotencyKey,
      now,
      providerEvidence: "completed",
      reason:
        "Captured Square webhook payment team attribution did not match the hold snapshot; refund required",
      squarePaymentId: input.squarePaymentId,
    });
    return;
  }

  if (input.providerStatus === "APPROVED") {
    let cancellationConfirmed = false;
    try {
      const cancellation = await dependencies.cancelPayment(
        input.squarePaymentId,
      );
      cancellationConfirmed =
        cancellation.payment.id === input.squarePaymentId &&
        cancellation.payment.status.trim().toUpperCase() === "CANCELED";
    } catch {
      cancellationConfirmed = false;
    }

    if (cancellationConfirmed) {
      const outcome = await dependencies.markPaymentTerminated({
        holdId: input.holdId,
        idempotencyKey: input.idempotencyKey,
        now,
        squarePaymentId: input.squarePaymentId,
        status: "cancelled",
      });
      if (outcome === "cancelled") {
        await dependencies.markHoldPaymentFailed({
          holdId: input.holdId,
          now,
          reason:
            "Square authorization team attribution did not match the hold snapshot",
        });
        return;
      }
    }

    await dependencies.markHoldRefundRequired({
      holdId: input.holdId,
      idempotencyKey: input.idempotencyKey,
      now,
      providerEvidence: "cancellation_unconfirmed",
      reason:
        "Square authorization team attribution did not match the hold snapshot and cancellation could not be confirmed",
      squarePaymentId: input.squarePaymentId,
    });
    return;
  }

  if (["CANCELED", "FAILED", "DECLINED"].includes(input.providerStatus)) {
    await dependencies.markHoldPaymentFailed({
      holdId: input.holdId,
      now,
      reason: `Square payment ended as ${input.providerStatus} with invalid team attribution`,
    });
    return;
  }

  await dependencies.markHoldRefundRequired({
    holdId: input.holdId,
    idempotencyKey: input.idempotencyKey,
    now,
    providerEvidence: "cancellation_unconfirmed",
    reason: `Square payment team attribution mismatch requires manual follow-up for provider status ${input.providerStatus}`,
    squarePaymentId: input.squarePaymentId,
  });
}

async function getOperationalPaymentRepository() {
  const { createServiceBookingPaymentRepository } =
    await import("./service-booking-payment-repository");
  return createServiceBookingPaymentRepository();
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
