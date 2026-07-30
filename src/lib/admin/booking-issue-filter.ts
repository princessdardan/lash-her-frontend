import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  appointmentHolds,
  appointments,
  bookingPaymentAttempts,
  checkoutOrders,
} from "@/lib/private-db/schema";

const BOOKING_ISSUE_STALE_AFTER_MS = 15 * 60 * 1000;

export function getCapturedBookingPaymentExistsExpression(): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${bookingPaymentAttempts}
    where ${bookingPaymentAttempts.holdId} = ${appointmentHolds.id}
      and ${bookingPaymentAttempts.status} in ('captured', 'refunded')
  )`;
}

export function getBookingIssueFilter(now: Date): SQL {
  const staleBefore = new Date(now.getTime() - BOOKING_ISSUE_STALE_AFTER_MS);
  const capturedPaymentExists = getCapturedBookingPaymentExistsExpression();
  const paymentEvidence = or(
    isNotNull(appointmentHolds.paidAt),
    capturedPaymentExists,
    inArray(appointments.paymentStatus, ["paid", "partially_paid"]),
  );
  const staleCapturedPaymentWithoutAppointment = and(
    isNull(appointments.id),
    notInArray(appointmentHolds.status, [
      "booked",
      "manual_rebooked",
      "refunded",
    ]),
    sql<boolean>`exists (
      select 1
      from ${bookingPaymentAttempts}
      where ${bookingPaymentAttempts.holdId} = ${appointmentHolds.id}
        and ${bookingPaymentAttempts.status} in ('captured', 'refunded')
        and ${bookingPaymentAttempts.updatedAt} < ${staleBefore}
    )`,
  );

  return or(
    inArray(appointmentHolds.status, [
      "refund_required",
      "paid_unbookable_rebooking_pending",
    ]),
    inArray(appointmentHolds.finalizationStatus, [
      "refund_required",
      "paid_unbookable_rebooking_pending",
    ]),
    and(
      paymentEvidence,
      or(
        eq(appointmentHolds.status, "manual_followup"),
        eq(appointmentHolds.finalizationStatus, "manual_review"),
        eq(appointmentHolds.status, "booking_failed"),
        eq(appointmentHolds.finalizationStatus, "failed"),
        and(
          eq(appointmentHolds.status, "paid_pending_booking"),
          lt(appointmentHolds.updatedAt, staleBefore),
        ),
        and(
          eq(appointmentHolds.finalizationStatus, "paid_calendar_pending"),
          lt(appointmentHolds.updatedAt, staleBefore),
        ),
      ),
    ),
    staleCapturedPaymentWithoutAppointment,
    and(
      eq(checkoutOrders.status, "paid"),
      inArray(checkoutOrders.calendarFinalizationStatus, [
        "manual_review",
        "paid_unbookable_rebooking_pending",
        "refund_required",
        "failed",
      ]),
    ),
    and(
      isNull(appointments.id),
      isNull(appointmentHolds.bookingConfirmationEmailSentAt),
      isNotNull(appointmentHolds.bookingConfirmationEmailLastError),
    ),
  )!;
}
