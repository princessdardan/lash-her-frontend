import "server-only";

import { and, eq, sql } from "drizzle-orm";

import {
  adminUserResources,
  adminUsers,
  bookingResources,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

export async function lockEmployeeCalendarInvariant(
  tx: AdminWriteTransaction,
  employeeUserId: string,
): Promise<void> {
  await lockEmployeeCalendarInvariants(tx, [employeeUserId]);
}

export async function lockEmployeeCalendarInvariants(
  tx: AdminWriteTransaction,
  employeeUserIds: readonly (string | null | undefined)[],
): Promise<void> {
  const orderedIds = [
    ...new Set(
      employeeUserIds.filter((id): id is string => typeof id === "string"),
    ),
  ].sort();

  for (const employeeUserId of orderedIds) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`employee-calendar:${employeeUserId}`}::text, 0))`,
    );
  }
}

export async function requireEmployeeStatusUnderInvariantLock(
  tx: AdminWriteTransaction,
  input: {
    employeeUserId: string;
    requireActive: boolean;
  },
): Promise<void> {
  const [employee] = await tx
    .select({
      role: adminUsers.role,
      status: adminUsers.status,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.employeeUserId))
    .limit(1)
    .for("update");

  if (
    employee?.role !== "employee" ||
    (input.requireActive && employee.status !== "active")
  ) {
    throw new Error(
      input.requireActive
        ? "Calendar access requires an active employee account"
        : "Employee account not found",
    );
  }
}

export async function requireActiveEmployeeProviderResourceUnderInvariantLock(
  tx: AdminWriteTransaction,
  input: {
    employeeUserId: string;
    resourceId: string;
  },
): Promise<void> {
  const [resource] = await tx
    .select({ id: bookingResources.id })
    .from(adminUsers)
    .innerJoin(
      adminUserResources,
      eq(adminUserResources.adminUserId, adminUsers.id),
    )
    .innerJoin(
      bookingResources,
      eq(bookingResources.id, adminUserResources.bookingResourceId),
    )
    .where(
      and(
        eq(adminUsers.id, input.employeeUserId),
        eq(adminUsers.role, "employee"),
        eq(adminUsers.status, "active"),
        eq(adminUserResources.bookingResourceId, input.resourceId),
        eq(bookingResources.kind, "provider"),
      ),
    )
    .limit(1);

  if (!resource) {
    throw new Error(
      "Calendar access requires an active employee assigned to this provider resource",
    );
  }
}
