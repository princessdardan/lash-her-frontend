import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointments,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
} from "@/lib/private-db/schema";

export async function queryEmployeeNoShowAttribution(
  db: ReturnType<typeof getPrivateDb>,
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
    );
}
