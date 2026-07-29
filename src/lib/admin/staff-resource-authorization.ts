import "server-only";

import { and, eq, sql } from "drizzle-orm";

import {
  adminUserResources,
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
  bookingResources,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";
import {
  lockEmployeeCalendarInvariant,
  requireEmployeeStatusUnderInvariantLock,
} from "./employee-calendar-invariant";

export async function assertStaffResourceMutationAllowed(
  tx: AdminWriteTransaction,
  input: {
    operation: "assign" | "unassign";
    resourceId: string;
    userId: string;
  },
): Promise<void> {
  await lockEmployeeCalendarInvariant(tx, input.userId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.resourceId}::text, 0))`,
  );
  await requireEmployeeStatusUnderInvariantLock(tx, {
    employeeUserId: input.userId,
    requireActive: input.operation === "assign",
  });

  const [resource] = await tx
    .select({ id: bookingResources.id })
    .from(bookingResources)
    .where(eq(bookingResources.id, input.resourceId))
    .limit(1)
    .for("update");

  if (resource === undefined) {
    throw new Error("Booking resource not found");
  }

  await tx
    .select({ id: adminUserResources.id })
    .from(adminUserResources)
    .where(
      and(
        eq(adminUserResources.adminUserId, input.userId),
        eq(adminUserResources.bookingResourceId, input.resourceId),
      ),
    )
    .limit(1)
    .for("update");

  const [ownedActiveAssignment] = await tx
    .select({ id: bookingResourceCalendarAssignments.id })
    .from(bookingResourceCalendarAssignments)
    .innerJoin(
      bookingCalendarConnections,
      eq(
        bookingCalendarConnections.id,
        bookingResourceCalendarAssignments.calendarConnectionId,
      ),
    )
    .where(
      and(
        eq(bookingCalendarConnections.credentialOwnerAdminUserId, input.userId),
        eq(bookingResourceCalendarAssignments.resourceId, input.resourceId),
        eq(bookingResourceCalendarAssignments.status, "active"),
      ),
    )
    .limit(1)
    .for("update");

  if (input.operation === "unassign" && ownedActiveAssignment !== undefined) {
    throw new Error(
      "Transfer or disconnect the contractor's active calendar assignment before removing this resource",
    );
  }
}
