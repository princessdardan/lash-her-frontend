import { and, asc, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";

import type { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  bookingPaymentAttempts,
  checkoutOrders,
  squarePaymentRefundEvents,
} from "@/lib/private-db/schema";

type AdminRefundQueryDb = Pick<
  ReturnType<typeof getPrivateDb>,
  "select" | "selectDistinctOn"
>;

/**
 * Builds the refund queries separately from authentication and presentation so
 * their generated SQL can be regression-tested. Lateral lookups are required:
 * selecting raw correlated SQL from only the completed-refunds subquery causes
 * Drizzle's single-table projection path to remove nested table qualifiers.
 */
export function buildAdminRefundQueries(
  db: AdminRefundQueryDb,
  input: { endExclusive: Date; search: string; start: Date },
) {
  const completedRefunds = db
    .selectDistinctOn([squarePaymentRefundEvents.squareRefundId], {
      amountCents: squarePaymentRefundEvents.amountCents,
      currency: squarePaymentRefundEvents.currency,
      id: squarePaymentRefundEvents.id,
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
    .as("admin_completed_square_refunds");
  const linkedOrder = db
    .select({
      customerEmail: checkoutOrders.customerEmail,
      customerName: checkoutOrders.customerName,
      purpose: checkoutOrders.purpose,
      reference: checkoutOrders.orderId,
    })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.paymentProvider, "square"),
        eq(checkoutOrders.providerPaymentId, completedRefunds.squarePaymentId),
      ),
    )
    .orderBy(desc(checkoutOrders.paidAt))
    .limit(1)
    .as("admin_refund_order");
  const linkedHold = db
    .select({
      customerSnapshot: appointmentHolds.customerSnapshot,
      reference: appointmentHolds.publicReference,
    })
    .from(bookingPaymentAttempts)
    .innerJoin(
      appointmentHolds,
      eq(appointmentHolds.id, bookingPaymentAttempts.holdId),
    )
    .where(
      and(
        eq(
          bookingPaymentAttempts.providerPaymentId,
          completedRefunds.squarePaymentId,
        ),
        eq(bookingPaymentAttempts.paymentProvider, "square"),
      ),
    )
    .orderBy(desc(bookingPaymentAttempts.updatedAt))
    .limit(1)
    .as("admin_refund_hold");
  const customerNameExpression = sql<
    string | null
  >`coalesce(${linkedOrder.customerName}, ${linkedHold.customerSnapshot}->>'name')`;
  const customerEmailExpression = sql<
    string | null
  >`coalesce(${linkedOrder.customerEmail}, ${linkedHold.customerSnapshot}->>'email')`;
  const referenceExpression = sql<string>`coalesce(
    ${linkedOrder.reference},
    ${linkedHold.reference},
    'Refund record'
  )`;
  const sourceLabelExpression = sql<string>`case
    when ${linkedOrder.purpose} = 'product' then 'Product order'
    when ${linkedOrder.purpose} = 'training' then 'Training purchase'
    when ${linkedOrder.purpose} = 'appointment_deposit' then 'Appointment deposit'
    when ${linkedOrder.purpose} = 'appointment_full' then 'Appointment payment'
    when ${linkedOrder.purpose} = 'appointment_custom_partial' then 'Appointment partial payment'
    when ${linkedHold.reference} is not null then 'Appointment payment'
    else 'Payment record'
  end`;
  const searchFilter = input.search
    ? or(
        ilike(referenceExpression, `%${input.search}%`),
        ilike(customerNameExpression, `%${input.search}%`),
        ilike(customerEmailExpression, `%${input.search}%`),
        ilike(sourceLabelExpression, `%${input.search}%`),
      )
    : undefined;
  const where = and(
    gte(completedRefunds.occurredAt, input.start),
    lt(completedRefunds.occurredAt, input.endExclusive),
    searchFilter,
  );
  const summary = db
    .select({
      total: sql<number>`count(*)::int`,
      totalRefundedCents: sql<number>`coalesce(
        sum(${completedRefunds.amountCents}),
        0
      )::int`,
    })
    .from(completedRefunds)
    .leftJoinLateral(linkedOrder, sql`true`)
    .leftJoinLateral(linkedHold, sql`true`)
    .where(where);
  const rows = db
    .select({
      amountCents: completedRefunds.amountCents,
      currency: completedRefunds.currency,
      customerEmail: customerEmailExpression,
      customerName: customerNameExpression,
      id: completedRefunds.id,
      occurredAt: completedRefunds.occurredAt,
      reference: referenceExpression,
      sourceLabel: sourceLabelExpression,
    })
    .from(completedRefunds)
    .leftJoinLateral(linkedOrder, sql`true`)
    .leftJoinLateral(linkedHold, sql`true`)
    .where(where)
    .orderBy(desc(completedRefunds.occurredAt), desc(completedRefunds.id));

  return { rows, summary };
}
