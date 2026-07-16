import "server-only";

import { and, eq, gte, inArray, lt } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointments,
  bookingBusinessSettings,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  checkoutOrders,
} from "@/lib/private-db/schema";

import { requirePermission } from "./auth";
import {
  aggregateEmployeeAttributionRows,
  resolveEmployeeAttributionReportingRange,
  type EmployeeAttributionRow,
} from "./employee-attribution-report";

export type { EmployeeAttributionRow } from "./employee-attribution-report";

export async function getEmployeeAttributionAnalytics(input: {
  from?: string;
  to?: string;
} = {}): Promise<{
  from: string;
  rows: EmployeeAttributionRow[];
  timezone: string;
  to: string;
  totals: Omit<EmployeeAttributionRow, "attributionKey" | "employeeLabel" | "sourceLabels" | "squareTeamMemberId">;
}> {
  await requirePermission("analytics:view");
  const db = getPrivateDb();
  const [settings] = await db
    .select({ timezone: bookingBusinessSettings.timezone })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);
  const timezone = settings?.timezone ?? "America/Toronto";
  const range = resolveEmployeeAttributionReportingRange(input, timezone);

  const [directPayments, noShowCharges, legacyCharges] = await Promise.all([
    db
      .select({
        amountCents: bookingPaymentAttempts.amountCents,
        providerSnapshot: appointments.providerSnapshot,
        squareTeamMemberId: bookingPaymentAttempts.squareTeamMemberId,
        status: bookingPaymentAttempts.status,
        tipCents: checkoutOrders.squareTipAmountCents,
      })
      .from(bookingPaymentAttempts)
      .innerJoin(
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
      ),
    db
      .select({
        amountCents: bookingNoShowChargeRecords.maxChargeCents,
        providerSnapshot: appointments.providerSnapshot,
        squareTeamMemberId: appointments.squareTeamMemberId,
      })
      .from(bookingNoShowChargeRecords)
      .innerJoin(
        appointments,
        eq(appointments.id, bookingNoShowChargeRecords.appointmentId),
      )
      .where(
        and(
          eq(bookingNoShowChargeRecords.status, "charged"),
          gte(bookingNoShowChargeRecords.chargedAt, range.start),
          lt(bookingNoShowChargeRecords.chargedAt, range.endExclusive),
        ),
      ),
    db
      .select({
        amountCents: checkoutOrders.amountCents,
        providerSnapshot: appointments.providerSnapshot,
        squareTeamMemberId: appointments.squareTeamMemberId,
        status: checkoutOrders.status,
        tipCents: checkoutOrders.squareTipAmountCents,
      })
      .from(checkoutOrders)
      .innerJoin(
        appointments,
        eq(appointments.checkoutOrderId, checkoutOrders.id),
      )
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
      ),
  ]);

  const aggregated = aggregateEmployeeAttributionRows({
    directPayments,
    legacyCharges,
    noShowCharges,
  });

  return {
    from: range.from,
    rows: aggregated.rows,
    timezone,
    to: range.to,
    totals: aggregated.totals,
  };
}
