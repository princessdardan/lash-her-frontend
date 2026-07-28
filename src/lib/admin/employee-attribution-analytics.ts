import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointments,
  appointmentHolds,
  bookingBusinessSettings,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  checkoutOrders,
} from "@/lib/private-db/schema";

import {
  queryCompletedSquareRefunds,
  queryCompletedSquareRefundsForPayments,
  queryEmployeeDirectAttribution,
  queryEmployeeLegacyAttribution,
  queryEmployeeNoShowAttribution,
  queryHistoricalLocalRefundAttribution,
  type EmployeeAttributionReadDb,
} from "./employee-attribution-query";
import {
  aggregateEmployeeAttributionRows,
  calculateRefundPeriodMetrics,
  resolveEmployeeAttributionReportingRange,
  type EmployeeAttributionRow,
} from "./employee-attribution-report";

export type { EmployeeAttributionRow } from "./employee-attribution-report";

const ATTRIBUTION_REPORT_TRANSACTION = {
  accessMode: "read only" as const,
  isolationLevel: "repeatable read" as const,
};

export async function getEmployeeAttributionAnalytics(
  input: {
    from?: string;
    to?: string;
  } = {},
): Promise<{
  from: string;
  rows: EmployeeAttributionRow[];
  timezone: string;
  to: string;
  totals: Omit<
    EmployeeAttributionRow,
    "attributionKey" | "employeeLabel" | "sourceLabels"
  >;
}> {
  const { requirePermission } = await import("./auth");
  await requirePermission("analytics:view");
  const db = getPrivateDb();

  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ timezone: bookingBusinessSettings.timezone })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1);
    const timezone = settings?.timezone ?? "America/Toronto";
    const range = resolveEmployeeAttributionReportingRange(input, timezone);
    const aggregated = await queryEmployeeAttributionAnalyticsForRange(
      tx,
      range,
    );

    return {
      from: range.from,
      rows: aggregated.rows,
      timezone,
      to: range.to,
      totals: aggregated.totals,
    };
  }, ATTRIBUTION_REPORT_TRANSACTION);
}

export async function getEmployeeAttributionAnalyticsForRange(
  db: ReturnType<typeof getPrivateDb>,
  range: { endExclusive: Date; start: Date },
  testSynchronization?: {
    afterInitialReads(): Promise<void>;
  },
) {
  return db.transaction(
    (tx) =>
      queryEmployeeAttributionAnalyticsForRange(tx, range, testSynchronization),
    ATTRIBUTION_REPORT_TRANSACTION,
  );
}

async function queryEmployeeAttributionAnalyticsForRange(
  db: EmployeeAttributionReadDb,
  range: { endExclusive: Date; start: Date },
  testSynchronization?: {
    afterInitialReads(): Promise<void>;
  },
) {
  const directPayments = await queryEmployeeDirectAttribution(db, range);
  const noShowCharges = await queryEmployeeNoShowAttribution(db, range);
  const legacyCharges = await queryEmployeeLegacyAttribution(db, range);
  const periodRefunds = await queryCompletedSquareRefunds(db, range);
  const historicalRefunds = await queryHistoricalLocalRefundAttribution(
    db,
    range,
  );

  await testSynchronization?.afterInitialReads();

  const capturedUnattributedPaymentIds = new Set(
    directPayments.flatMap((payment) =>
      payment.squareTeamMemberId === null && payment.providerPaymentId !== null
        ? [payment.providerPaymentId]
        : [],
    ),
  );
  const eventRefunds = await resolveRefundAttribution(db, {
    capturedUnattributedPaymentIds,
    endExclusive: range.endExclusive,
    periodRefunds,
    start: range.start,
  });
  const countedUnattributedPaymentIds = new Set(capturedUnattributedPaymentIds);
  const localFallbackRefunds = historicalRefunds.map((refund) => {
    const isUnattributedDirect =
      refund.source === "direct" && refund.squareTeamMemberId === null;
    const countUnattributed =
      isUnattributedDirect &&
      (refund.providerPaymentId === null ||
        !countedUnattributedPaymentIds.has(refund.providerPaymentId));

    if (countUnattributed && refund.providerPaymentId !== null) {
      countedUnattributedPaymentIds.add(refund.providerPaymentId);
    }

    return {
      ...refund,
      countUnattributed,
    };
  });

  return aggregateEmployeeAttributionRows({
    directPayments,
    legacyCharges,
    noShowCharges,
    refunds: [...eventRefunds, ...localFallbackRefunds],
  });
}

interface RefundAttributionSource {
  currency: string;
  grossAmountCents: number;
  providerSnapshot: Record<string, unknown>;
  source: "direct" | "legacy" | "no_show";
  squareTeamMemberId: string | null;
}

async function resolveRefundAttribution(
  db: EmployeeAttributionReadDb,
  input: {
    capturedUnattributedPaymentIds: Set<string>;
    endExclusive: Date;
    periodRefunds: Array<{
      amountCents: number;
      currency: string;
      occurredAt: Date;
      squarePaymentId: string;
      squareRefundId: string;
    }>;
    start: Date;
  },
) {
  const paymentIds = [
    ...new Set(input.periodRefunds.map((refund) => refund.squarePaymentId)),
  ];

  if (paymentIds.length === 0) {
    return [];
  }

  const directSources = await db
    .select({
      amountCents: bookingPaymentAttempts.amountCents,
      currency: bookingPaymentAttempts.currency,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
            ${appointmentHolds.providerSnapshot},
            ${appointments.providerSnapshot},
            '{}'::jsonb
          )`,
      squarePaymentId: bookingPaymentAttempts.providerPaymentId,
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
        inArray(bookingPaymentAttempts.providerPaymentId, paymentIds),
      ),
    );
  const noShowSources = await db
    .select({
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
      currency: bookingNoShowChargeRecords.currency,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      squarePaymentId: bookingNoShowChargeRecords.squarePaymentId,
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
    .where(inArray(bookingNoShowChargeRecords.squarePaymentId, paymentIds));
  const legacySources = await db
    .select({
      amountCents: checkoutOrders.amountCents,
      currency: checkoutOrders.currency,
      providerSnapshot: sql<Record<string, unknown>>`coalesce(
        ${appointmentHolds.providerSnapshot},
        ${appointments.providerSnapshot},
        '{}'::jsonb
      )`,
      squarePaymentId: checkoutOrders.providerPaymentId,
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
        inArray(checkoutOrders.providerPaymentId, paymentIds),
      ),
    );
  const allCompletedRefunds = await queryCompletedSquareRefundsForPayments(db, {
    endExclusive: input.endExclusive,
    squarePaymentIds: paymentIds,
  });

  const sources = new Map<string, RefundAttributionSource>();

  for (const source of directSources) {
    if (source.squarePaymentId !== null) {
      sources.set(source.squarePaymentId, {
        currency: source.currency,
        grossAmountCents: source.amountCents + (source.tipCents ?? 0),
        providerSnapshot: source.providerSnapshot,
        source: "direct",
        squareTeamMemberId: source.squareTeamMemberId,
      });
    }
  }

  for (const source of noShowSources) {
    if (
      source.squarePaymentId !== null &&
      !sources.has(source.squarePaymentId)
    ) {
      sources.set(source.squarePaymentId, {
        currency: source.currency,
        grossAmountCents: source.amountCents,
        providerSnapshot: source.providerSnapshot,
        source: "no_show",
        squareTeamMemberId: source.squareTeamMemberId,
      });
    }
  }

  for (const source of legacySources) {
    if (
      source.squarePaymentId !== null &&
      !sources.has(source.squarePaymentId)
    ) {
      sources.set(source.squarePaymentId, {
        currency: source.currency,
        grossAmountCents: source.amountCents + (source.tipCents ?? 0),
        providerSnapshot: source.providerSnapshot,
        source: "legacy",
        squareTeamMemberId: source.squareTeamMemberId,
      });
    }
  }

  const periodByPaymentAndCurrency = new Map<
    string,
    {
      amountCents: number;
      currency: string;
      squarePaymentId: string;
    }
  >();
  for (const refund of input.periodRefunds) {
    const key = `${refund.squarePaymentId}\u0000${refund.currency}`;
    const existing = periodByPaymentAndCurrency.get(key);
    periodByPaymentAndCurrency.set(key, {
      amountCents: (existing?.amountCents ?? 0) + refund.amountCents,
      currency: refund.currency,
      squarePaymentId: refund.squarePaymentId,
    });
  }

  const beforeRangeByPaymentAndCurrency = new Map<string, number>();
  const throughRangeByPaymentAndCurrency = new Map<string, number>();
  for (const refund of allCompletedRefunds) {
    const key = `${refund.squarePaymentId}\u0000${refund.currency}`;
    throughRangeByPaymentAndCurrency.set(
      key,
      (throughRangeByPaymentAndCurrency.get(key) ?? 0) + refund.amountCents,
    );
    if (refund.occurredAt < input.start) {
      beforeRangeByPaymentAndCurrency.set(
        key,
        (beforeRangeByPaymentAndCurrency.get(key) ?? 0) + refund.amountCents,
      );
    }
  }

  const countedUnattributedPaymentIds = new Set(
    input.capturedUnattributedPaymentIds,
  );

  return [...periodByPaymentAndCurrency].map(([key, periodRefund]) => {
    const source = sources.get(periodRefund.squarePaymentId);
    const isCurrencyMismatch =
      source !== undefined && source.currency !== periodRefund.currency;
    const isUnmatched = source === undefined;
    const isMissingNativeAttribution =
      source?.source === "direct" && source.squareTeamMemberId === null;
    const isUnattributed =
      isCurrencyMismatch || isUnmatched || isMissingNativeAttribution;
    const countUnattributed =
      isUnattributed &&
      !countedUnattributedPaymentIds.has(periodRefund.squarePaymentId);

    if (countUnattributed) {
      countedUnattributedPaymentIds.add(periodRefund.squarePaymentId);
    }

    if (source === undefined || isCurrencyMismatch) {
      const unattributedSource: "currency_mismatch" | "unmatched" =
        isCurrencyMismatch ? "currency_mismatch" : "unmatched";

      return {
        amountCents: periodRefund.amountCents,
        countUnattributed,
        evidence: "square_event" as const,
        forceUnattributed: true,
        fullyRefundedCents: 0,
        providerSnapshot: source?.providerSnapshot ?? {},
        source: unattributedSource,
        squareTeamMemberId: null,
      };
    }

    const metrics = calculateRefundPeriodMetrics({
      grossAmountCents: source.grossAmountCents,
      refundedBeforeCents: beforeRangeByPaymentAndCurrency.get(key) ?? 0,
      refundedInPeriodCents: periodRefund.amountCents,
      refundedThroughPeriodCents:
        throughRangeByPaymentAndCurrency.get(key) ?? 0,
    });

    return {
      amountCents: metrics.refundedCents,
      countUnattributed,
      evidence: "square_event" as const,
      fullyRefundedCents: metrics.fullyRefundedCents,
      providerSnapshot: source.providerSnapshot,
      source: source.source,
      squareTeamMemberId: source.squareTeamMemberId,
    };
  });
}
