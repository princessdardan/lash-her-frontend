import "server-only";

import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointments,
  appointmentHolds,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  checkoutOrders,
  squarePaymentRefundEvents,
} from "@/lib/private-db/schema";

type PrivateDb = ReturnType<typeof getPrivateDb>;
type PrivateDbTransaction = Parameters<
  Parameters<PrivateDb["transaction"]>[0]
>[0];

export type EmployeeAttributionReadDb = PrivateDb | PrivateDbTransaction;

export async function queryEmployeeDirectAttribution(
  db: EmployeeAttributionReadDb,
  range: { endExclusive: Date; start: Date },
) {
  return db
    .select({
      amountCents: bookingPaymentAttempts.amountCents,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      providerPaymentId: bookingPaymentAttempts.providerPaymentId,
      squareTeamMemberId: bookingPaymentAttempts.squareTeamMemberId,
      tipCents: checkoutOrders.squareTipAmountCents,
    })
    .from(bookingPaymentAttempts)
    .leftJoin(
      appointmentHolds,
      eq(appointmentHolds.id, bookingPaymentAttempts.holdId),
    )
    .leftJoin(
      appointments,
      eq(appointments.id, bookingPaymentAttempts.appointmentId),
    )
    .leftJoin(
      checkoutOrders,
      eq(checkoutOrders.id, bookingPaymentAttempts.checkoutOrderId),
    )
    .where(
      and(
        eq(bookingPaymentAttempts.paymentProvider, "square"),
        eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
        inArray(bookingPaymentAttempts.status, ["captured", "refunded"]),
        gte(bookingPaymentAttempts.capturedAt, range.start),
        lt(bookingPaymentAttempts.capturedAt, range.endExclusive),
      ),
    );
}

export async function queryEmployeeLegacyAttribution(
  db: EmployeeAttributionReadDb,
  range: { endExclusive: Date; start: Date },
) {
  return db
    .select({
      amountCents: checkoutOrders.amountCents,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      providerPaymentId: checkoutOrders.providerPaymentId,
      squareTeamMemberId: sql<string | null>`coalesce(
        ${appointmentHolds.squareTeamMemberId},
        ${appointments.squareTeamMemberId}
      )`,
      tipCents: checkoutOrders.squareTipAmountCents,
    })
    .from(checkoutOrders)
    .leftJoin(
      appointmentHolds,
      eq(appointmentHolds.checkoutOrderId, checkoutOrders.id),
    )
    .leftJoin(appointments, eq(appointments.checkoutOrderId, checkoutOrders.id))
    .where(
      and(
        eq(checkoutOrders.paymentProvider, "square"),
        inArray(checkoutOrders.purpose, [
          "appointment_deposit",
          "appointment_full",
          "appointment_custom_partial",
        ]),
        inArray(checkoutOrders.status, ["paid", "refunded"]),
        gte(checkoutOrders.paidAt, range.start),
        lt(checkoutOrders.paidAt, range.endExclusive),
      ),
    );
}

export async function queryEmployeeNoShowAttribution(
  db: EmployeeAttributionReadDb,
  range: { endExclusive: Date; start: Date },
) {
  return db
    .select({
      // A charged record can have retries and adjusted amounts. Prefer the
      // terminal attempt linked to the record's provider payment; otherwise
      // use the most recent terminal attempt. Historical charged records with
      // no terminal attempt contribute zero instead of the policy ceiling.
      amountCents: sql<number>`coalesce((
          select ${bookingNoShowChargeAttempts.amountCents}
          from ${bookingNoShowChargeAttempts}
          where ${bookingNoShowChargeAttempts.noShowChargeRecordId} = ${bookingNoShowChargeRecords.id}
            and ${bookingNoShowChargeAttempts.status} = 'charged'
            and (
              ${bookingNoShowChargeRecords.squarePaymentId} is null
              or ${bookingNoShowChargeAttempts.squarePaymentId} = ${bookingNoShowChargeRecords.squarePaymentId}
            )
          order by ${bookingNoShowChargeAttempts.processedAt} desc nulls last,
            ${bookingNoShowChargeAttempts.createdAt} desc
          limit 1
        ), 0)`.mapWith(Number),
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      squareTeamMemberId: sql<string | null>`coalesce(
        ${appointmentHolds.squareTeamMemberId},
        ${appointments.squareTeamMemberId}
      )`,
    })
    .from(bookingNoShowChargeRecords)
    .innerJoin(
      appointmentHolds,
      eq(appointmentHolds.id, bookingNoShowChargeRecords.holdId),
    )
    .leftJoin(
      appointments,
      eq(appointments.id, bookingNoShowChargeRecords.appointmentId),
    )
    .where(
      and(
        eq(bookingNoShowChargeRecords.status, "charged"),
        gte(bookingNoShowChargeRecords.chargedAt, range.start),
        lt(bookingNoShowChargeRecords.chargedAt, range.endExclusive),
      ),
    );
}

export async function queryCompletedSquareRefunds(
  db: EmployeeAttributionReadDb,
  range: { endExclusive: Date; start: Date },
) {
  const firstCompletedRefund = completedSquareRefundSubquery(db);

  return db
    .select({
      amountCents: firstCompletedRefund.amountCents,
      currency: firstCompletedRefund.currency,
      occurredAt: firstCompletedRefund.occurredAt,
      squarePaymentId: firstCompletedRefund.squarePaymentId,
      squareRefundId: firstCompletedRefund.squareRefundId,
    })
    .from(firstCompletedRefund)
    .where(
      and(
        gte(firstCompletedRefund.occurredAt, range.start),
        lt(firstCompletedRefund.occurredAt, range.endExclusive),
      ),
    );
}

export async function queryCompletedSquareRefundsForPayments(
  db: EmployeeAttributionReadDb,
  input: { endExclusive: Date; squarePaymentIds: string[] },
) {
  if (input.squarePaymentIds.length === 0) {
    return [];
  }

  const firstCompletedRefund = completedSquareRefundSubquery(db);

  return db
    .select({
      amountCents: firstCompletedRefund.amountCents,
      currency: firstCompletedRefund.currency,
      occurredAt: firstCompletedRefund.occurredAt,
      squarePaymentId: firstCompletedRefund.squarePaymentId,
      squareRefundId: firstCompletedRefund.squareRefundId,
    })
    .from(firstCompletedRefund)
    .where(
      and(
        inArray(firstCompletedRefund.squarePaymentId, input.squarePaymentIds),
        lt(firstCompletedRefund.occurredAt, input.endExclusive),
      ),
    );
}

export interface HistoricalLocalRefundAttribution {
  amountCents: number;
  evidence: "local_fallback";
  forceUnattributed?: boolean;
  fullyRefundedCents: number;
  providerPaymentId: string | null;
  providerSnapshot: Record<string, unknown>;
  source: "direct" | "legacy" | "no_show";
  squareTeamMemberId: string | null;
}

/**
 * Compatibility for terminal refund evidence written before immutable Square
 * refund events were introduced. `updatedAt` (direct/legacy) and
 * `processedAt ?? createdAt` (no-show) are local evidence timestamps. They are
 * used only when no completed Square refund event exists for the payment.
 */
export async function queryHistoricalLocalRefundAttribution(
  db: EmployeeAttributionReadDb,
  range: { endExclusive: Date; start: Date },
): Promise<HistoricalLocalRefundAttribution[]> {
  const direct = await db
    .select({
      amountCents: sql<number>`(
        ${bookingPaymentAttempts.amountCents} +
        coalesce(${checkoutOrders.squareTipAmountCents}, 0)
      )`.mapWith(Number),
      providerPaymentId: bookingPaymentAttempts.providerPaymentId,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      squareTeamMemberId: bookingPaymentAttempts.squareTeamMemberId,
    })
    .from(bookingPaymentAttempts)
    .leftJoin(
      appointmentHolds,
      eq(appointmentHolds.id, bookingPaymentAttempts.holdId),
    )
    .leftJoin(
      appointments,
      eq(appointments.id, bookingPaymentAttempts.appointmentId),
    )
    .leftJoin(
      checkoutOrders,
      eq(checkoutOrders.id, bookingPaymentAttempts.checkoutOrderId),
    )
    .where(
      and(
        eq(bookingPaymentAttempts.paymentProvider, "square"),
        eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
        eq(bookingPaymentAttempts.status, "refunded"),
        gte(bookingPaymentAttempts.updatedAt, range.start),
        lt(bookingPaymentAttempts.updatedAt, range.endExclusive),
        sql`not exists (
          select 1
          from ${squarePaymentRefundEvents}
          where ${squarePaymentRefundEvents.status} = 'COMPLETED'
            and ${squarePaymentRefundEvents.squarePaymentId} = ${bookingPaymentAttempts.providerPaymentId}
        )`,
      ),
    );
  const legacy = await db
    .select({
      amountCents: sql<number>`(
        ${checkoutOrders.amountCents} +
        coalesce(${checkoutOrders.squareTipAmountCents}, 0)
      )`.mapWith(Number),
      providerPaymentId: checkoutOrders.providerPaymentId,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      squareTeamMemberId: sql<string | null>`coalesce(
        ${appointmentHolds.squareTeamMemberId},
        ${appointments.squareTeamMemberId}
      )`,
    })
    .from(checkoutOrders)
    .leftJoin(
      appointmentHolds,
      eq(appointmentHolds.checkoutOrderId, checkoutOrders.id),
    )
    .leftJoin(appointments, eq(appointments.checkoutOrderId, checkoutOrders.id))
    .where(
      and(
        eq(checkoutOrders.paymentProvider, "square"),
        inArray(checkoutOrders.purpose, [
          "appointment_deposit",
          "appointment_full",
          "appointment_custom_partial",
        ]),
        eq(checkoutOrders.status, "refunded"),
        gte(checkoutOrders.updatedAt, range.start),
        lt(checkoutOrders.updatedAt, range.endExclusive),
        sql`not exists (
          select 1
          from ${squarePaymentRefundEvents}
          where ${squarePaymentRefundEvents.status} = 'COMPLETED'
            and ${squarePaymentRefundEvents.squarePaymentId} = ${checkoutOrders.providerPaymentId}
        )`,
      ),
    );
  const noShowAttempts = await db
    .select({
      amountCents: bookingNoShowChargeAttempts.amountCents,
      createdAt: bookingNoShowChargeAttempts.createdAt,
      grossAmountCents: sql<number>`coalesce((
        select charged_attempt.amount_cents
        from ${bookingNoShowChargeAttempts} charged_attempt
        where charged_attempt.no_show_charge_record_id = ${bookingNoShowChargeRecords.id}
          and charged_attempt.status = 'charged'
          and (
            ${bookingNoShowChargeRecords.squarePaymentId} is null
            or charged_attempt.square_payment_id = ${bookingNoShowChargeRecords.squarePaymentId}
          )
        order by charged_attempt.processed_at desc nulls last,
          charged_attempt.created_at desc
        limit 1
      ), 0)`.mapWith(Number),
      noShowChargeRecordId: bookingNoShowChargeAttempts.noShowChargeRecordId,
      processedAt: bookingNoShowChargeAttempts.processedAt,
      providerPaymentId: bookingNoShowChargeRecords.squarePaymentId,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      squareTeamMemberId: sql<string | null>`coalesce(
        ${appointmentHolds.squareTeamMemberId},
        ${appointments.squareTeamMemberId}
      )`,
      status: bookingNoShowChargeAttempts.status,
    })
    .from(bookingNoShowChargeAttempts)
    .innerJoin(
      bookingNoShowChargeRecords,
      eq(
        bookingNoShowChargeRecords.id,
        bookingNoShowChargeAttempts.noShowChargeRecordId,
      ),
    )
    .innerJoin(
      appointmentHolds,
      eq(appointmentHolds.id, bookingNoShowChargeRecords.holdId),
    )
    .leftJoin(
      appointments,
      eq(appointments.id, bookingNoShowChargeRecords.appointmentId),
    )
    .where(
      and(
        inArray(bookingNoShowChargeAttempts.status, [
          "partially_refunded",
          "refunded",
        ]),
        lt(
          sql`coalesce(
            ${bookingNoShowChargeAttempts.processedAt},
            ${bookingNoShowChargeAttempts.createdAt}
          )`,
          range.endExclusive,
        ),
        sql`not exists (
          select 1
          from ${squarePaymentRefundEvents}
          where ${squarePaymentRefundEvents.status} = 'COMPLETED'
            and ${squarePaymentRefundEvents.squarePaymentId} = ${bookingNoShowChargeRecords.squarePaymentId}
        )`,
      ),
    );

  const result: HistoricalLocalRefundAttribution[] = [
    ...direct.map((refund) => ({
      ...refund,
      evidence: "local_fallback" as const,
      fullyRefundedCents: refund.amountCents,
      source: "direct" as const,
    })),
    ...legacy.map((refund) => ({
      ...refund,
      evidence: "local_fallback" as const,
      fullyRefundedCents: refund.amountCents,
      source: "legacy" as const,
    })),
  ];
  const noShowAttemptsWithOccurredAt = noShowAttempts.map((attempt) => ({
    ...attempt,
    occurredAt: attempt.processedAt ?? attempt.createdAt,
  }));
  const byRecord = new Map<string, typeof noShowAttemptsWithOccurredAt>();
  for (const attempt of noShowAttemptsWithOccurredAt) {
    const attempts = byRecord.get(attempt.noShowChargeRecordId) ?? [];
    attempts.push(attempt);
    byRecord.set(attempt.noShowChargeRecordId, attempts);
  }

  for (const attempts of byRecord.values()) {
    attempts.sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    const first = attempts[0];
    if (first === undefined || first.grossAmountCents <= 0) {
      continue;
    }

    let refundedCents = 0;
    let refundedInPeriodCents = 0;
    let fullyRefundedInPeriodCents = 0;

    for (const attempt of attempts) {
      if (refundedCents >= first.grossAmountCents) {
        break;
      }
      const remaining = first.grossAmountCents - refundedCents;
      const refundDelta =
        attempt.status === "refunded"
          ? remaining
          : Math.min(attempt.amountCents, remaining);
      refundedCents += refundDelta;

      if (attempt.occurredAt >= range.start) {
        refundedInPeriodCents += refundDelta;
        if (
          attempt.status === "refunded" &&
          refundedCents >= first.grossAmountCents
        ) {
          fullyRefundedInPeriodCents = first.grossAmountCents;
        }
      }
    }

    if (refundedInPeriodCents > 0) {
      result.push({
        amountCents: refundedInPeriodCents,
        evidence: "local_fallback",
        fullyRefundedCents: fullyRefundedInPeriodCents,
        providerPaymentId: first.providerPaymentId,
        providerSnapshot: first.providerSnapshot,
        source: "no_show",
        squareTeamMemberId: first.squareTeamMemberId,
      });
    }
  }

  return result;
}

function completedSquareRefundSubquery(db: EmployeeAttributionReadDb) {
  return db
    .selectDistinctOn([squarePaymentRefundEvents.squareRefundId], {
      amountCents: squarePaymentRefundEvents.amountCents,
      currency: squarePaymentRefundEvents.currency,
      occurredAt: squarePaymentRefundEvents.occurredAt,
      squarePaymentId: squarePaymentRefundEvents.squarePaymentId,
      squareRefundId: squarePaymentRefundEvents.squareRefundId,
    })
    .from(squarePaymentRefundEvents)
    .where(eq(squarePaymentRefundEvents.status, "COMPLETED"))
    .orderBy(
      squarePaymentRefundEvents.squareRefundId,
      asc(squarePaymentRefundEvents.occurredAt),
      asc(squarePaymentRefundEvents.createdAt),
    )
    .as("first_completed_square_refunds");
}
