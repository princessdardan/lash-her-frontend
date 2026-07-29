import "server-only";

import { and, eq } from "drizzle-orm";

import { bookingResourceCalendarAssignments } from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

export async function assertEmployeeBusyAssignmentCanBeSaved(
  tx: AdminWriteTransaction,
  input: {
    connectionId: string;
    providerCalendarId: string;
    resourceId: string;
  },
): Promise<void> {
  const [existingAssignment] = await tx
    .select({
      acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
    })
    .from(bookingResourceCalendarAssignments)
    .where(
      and(
        eq(
          bookingResourceCalendarAssignments.calendarConnectionId,
          input.connectionId,
        ),
        eq(
          bookingResourceCalendarAssignments.providerCalendarId,
          input.providerCalendarId,
        ),
        eq(bookingResourceCalendarAssignments.resourceId, input.resourceId),
      ),
    )
    .limit(1)
    .for("update");

  if (existingAssignment?.acceptsBookings === true) {
    throw new Error(
      "Contractors cannot change a calendar that receives bookings",
    );
  }
}
