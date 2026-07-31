import "server-only";

import { and, eq } from "drizzle-orm";

import { bookingResourceCalendarAssignments } from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";
import { getBookingDestinationChangeError } from "./calendar-destination-policy";

export async function lockAndValidateBookingDestinationChange(
  tx: AdminWriteTransaction,
  input: {
    acceptsBookings: boolean;
    confirmedReplacementAssignmentId: string | null;
    connectionId: string;
    providerCalendarId: string;
    resourceId: string;
  },
): Promise<void> {
  const [currentDestination] = await tx
    .select({
      assignmentId: bookingResourceCalendarAssignments.id,
      connectionId: bookingResourceCalendarAssignments.calendarConnectionId,
      providerCalendarId: bookingResourceCalendarAssignments.providerCalendarId,
    })
    .from(bookingResourceCalendarAssignments)
    .where(
      and(
        eq(bookingResourceCalendarAssignments.resourceId, input.resourceId),
        eq(bookingResourceCalendarAssignments.status, "active"),
        eq(bookingResourceCalendarAssignments.acceptsBookings, true),
      ),
    )
    .limit(1)
    .for("update");

  const error = getBookingDestinationChangeError({
    acceptsBookings: input.acceptsBookings,
    confirmedReplacementAssignmentId: input.confirmedReplacementAssignmentId,
    currentDestination: currentDestination ?? null,
    requestedConnectionId: input.connectionId,
    requestedProviderCalendarId: input.providerCalendarId,
  });
  if (error) {
    throw new Error(error);
  }
}
