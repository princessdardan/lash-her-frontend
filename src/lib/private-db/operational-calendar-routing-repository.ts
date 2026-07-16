import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getPrivateDb } from "./client";
import {
  appointmentHolds,
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
} from "./schema";

export interface OperationalCalendarRoute {
  assignmentId: string;
  calendarId: string;
  connectionId: string;
  resourceId: string;
}

export interface OperationalAppointmentCalendarRouting {
  busyCalendars: OperationalCalendarRoute[];
  writeCalendar: OperationalCalendarRoute;
}

export async function getOperationalAppointmentCalendarRouting(
  holdId: string,
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): Promise<OperationalAppointmentCalendarRouting> {
  const [hold] = await db
    .select({
      bookingModelVersion: appointmentHolds.bookingModelVersion,
      calendarAssignmentId: appointmentHolds.calendarAssignmentId,
      googleCalendarId: appointmentHolds.googleCalendarId,
      offeringSnapshot: appointmentHolds.offeringSnapshot,
      primaryResourceId: appointmentHolds.primaryResourceId,
    })
    .from(appointmentHolds)
    .where(eq(appointmentHolds.id, holdId))
    .limit(1);

  if (
    hold === undefined ||
    hold.bookingModelVersion !== 2 ||
    hold.calendarAssignmentId === null ||
    hold.googleCalendarId === null ||
    hold.googleCalendarId === "primary" ||
    hold.primaryResourceId === null
  ) {
    throw new Error("Operational booking calendar routing is incomplete");
  }

  const reservedResourceIds = readReservedResourceIds(hold.offeringSnapshot);
  if (!reservedResourceIds.includes(hold.primaryResourceId)) {
    throw new Error(
      "Operational booking calendar routing does not include the primary resource",
    );
  }

  const rows = await db
    .select({
      acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
      assignmentId: bookingResourceCalendarAssignments.id,
      calendarId: bookingResourceCalendarAssignments.providerCalendarId,
      connectionId:
        bookingResourceCalendarAssignments.calendarConnectionId,
      contributesBusy: bookingResourceCalendarAssignments.contributesBusy,
      resourceId: bookingResourceCalendarAssignments.resourceId,
      status: bookingResourceCalendarAssignments.status,
    })
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
        inArray(
          bookingResourceCalendarAssignments.resourceId,
          reservedResourceIds,
        ),
        eq(bookingCalendarConnections.status, "active"),
        eq(bookingCalendarConnections.provider, "google"),
      ),
    );

  const writeRow = rows.find(
    (row) => row.assignmentId === hold.calendarAssignmentId,
  );
  if (
    writeRow === undefined ||
    writeRow.resourceId !== hold.primaryResourceId ||
    writeRow.calendarId !== hold.googleCalendarId
  ) {
    throw new Error(
      "Persisted operational write-calendar assignment is no longer valid",
    );
  }

  const busyCalendars = deduplicateCalendarRoutes(
    rows
      .filter(
        (row) =>
          row.contributesBusy &&
          (row.status === "active" ||
            row.assignmentId === hold.calendarAssignmentId),
      )
      .map(toOperationalCalendarRoute),
  );
  const writeCalendar = toOperationalCalendarRoute(writeRow);

  if (
    !busyCalendars.some(
      (route) =>
        route.connectionId === writeCalendar.connectionId &&
        route.calendarId === writeCalendar.calendarId,
    )
  ) {
    throw new Error(
      "Operational write calendar must contribute to busy-time checks",
    );
  }

  return { busyCalendars, writeCalendar };
}

function readReservedResourceIds(
  offeringSnapshot: Record<string, unknown>,
): string[] {
  const value = offeringSnapshot.reservedResourceIds;
  const expectedCount = offeringSnapshot.reservedResourceCount;

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (resourceId): resourceId is string =>
        typeof resourceId === "string" && resourceId.trim().length > 0,
    ) ||
    !Number.isInteger(expectedCount) ||
    expectedCount !== value.length
  ) {
    throw new Error(
      "Operational booking hold is missing its reserved-resource routing set",
    );
  }

  const resourceIds = [...value].sort((first, second) =>
    first.localeCompare(second),
  );
  if (new Set(resourceIds).size !== resourceIds.length) {
    throw new Error("Operational booking reserved-resource routing is invalid");
  }

  return resourceIds;
}

function toOperationalCalendarRoute(row: {
  assignmentId: string;
  calendarId: string;
  connectionId: string;
  resourceId: string;
}): OperationalCalendarRoute {
  return {
    assignmentId: row.assignmentId,
    calendarId: row.calendarId,
    connectionId: row.connectionId,
    resourceId: row.resourceId,
  };
}

function deduplicateCalendarRoutes(
  routes: OperationalCalendarRoute[],
): OperationalCalendarRoute[] {
  const seen = new Set<string>();

  return routes.filter((route) => {
    const key = `${route.connectionId}\u0000${route.calendarId}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
