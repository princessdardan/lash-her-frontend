import "server-only";

import { and, eq } from "drizzle-orm";

import {
  adminUserResources,
  adminUsers,
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
  bookingResources,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

export async function assertStaffResourceMutationAllowed(
  tx: AdminWriteTransaction,
  input: {
    operation: "assign" | "unassign";
    resourceId: string;
    userId: string;
  },
): Promise<void> {
  const [employee] = await tx
    .select({ id: adminUsers.id, role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.userId))
    .limit(1)
    .for("update");

  if (employee === undefined || employee.role !== "employee") {
    throw new Error("Employee account not found");
  }

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
        eq(
          bookingCalendarConnections.credentialOwnerAdminUserId,
          input.userId,
        ),
        eq(
          bookingResourceCalendarAssignments.resourceId,
          input.resourceId,
        ),
        eq(bookingResourceCalendarAssignments.status, "active"),
      ),
    )
    .limit(1)
    .for("update");

  if (input.operation === "unassign" && ownedActiveAssignment !== undefined) {
    throw new Error(
      "Transfer or disconnect the employee's active calendar assignment before removing this resource",
    );
  }
}
