import "server-only";

import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";

import type {
  OperationalOfferingAvailabilityConfiguration,
  OperationalResourceAvailability,
} from "@/lib/booking/operations/availability";
import type { ResourceIsoWeekday } from "@/lib/booking/schedule-windows";

import { getPrivateDb } from "./client";
import {
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
  bookingResources,
  bookingResourceScheduleExceptions,
  bookingResourceSchedules,
  bookingServiceOfferingResources,
} from "./schema";

export interface BookingAvailabilityRepository {
  getOfferingAvailabilityConfiguration(input: {
    offeringId: string;
    primaryResourceId: string;
    timeMax: Date;
    timeMin: Date;
  }): Promise<OperationalOfferingAvailabilityConfiguration>;
}

export function createDrizzleBookingAvailabilityRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): BookingAvailabilityRepository {
  return {
    async getOfferingAvailabilityConfiguration(input) {
      const requiredResourceRows = await db
        .select({ resourceId: bookingServiceOfferingResources.resourceId })
        .from(bookingServiceOfferingResources)
        .where(
          and(
            eq(bookingServiceOfferingResources.offeringId, input.offeringId),
            eq(bookingServiceOfferingResources.isRequired, true),
          ),
        );
      const requiredResourceIds = uniqueSorted([
        input.primaryResourceId,
        ...requiredResourceRows.map((row) => row.resourceId),
      ]);

      if (requiredResourceIds.length === 0) {
        return { requiredResourceIds: [], resources: [] };
      }

      const [resourceRows, scheduleRows, exceptionRows, assignmentRows] =
        await Promise.all([
          db
            .select({
              resourceId: bookingResources.id,
              timezone: bookingResources.timezone,
            })
            .from(bookingResources)
            .where(
              and(
                inArray(bookingResources.id, requiredResourceIds),
                eq(bookingResources.status, "active"),
              ),
            )
            .orderBy(asc(bookingResources.id)),
          db
            .select({
              effectiveFrom: bookingResourceSchedules.effectiveFrom,
              effectiveUntil: bookingResourceSchedules.effectiveUntil,
              endsAt: bookingResourceSchedules.endsAt,
              resourceId: bookingResourceSchedules.resourceId,
              startsAt: bookingResourceSchedules.startsAt,
              timezone: bookingResourceSchedules.timezone,
              weekday: bookingResourceSchedules.weekday,
            })
            .from(bookingResourceSchedules)
            .where(
              and(
                inArray(
                  bookingResourceSchedules.resourceId,
                  requiredResourceIds,
                ),
                eq(bookingResourceSchedules.status, "active"),
              ),
            )
            .orderBy(
              asc(bookingResourceSchedules.resourceId),
              asc(bookingResourceSchedules.weekday),
              asc(bookingResourceSchedules.startsAt),
            ),
          db
            .select({
              endsAt: bookingResourceScheduleExceptions.endsAt,
              kind: bookingResourceScheduleExceptions.kind,
              resourceId: bookingResourceScheduleExceptions.resourceId,
              startsAt: bookingResourceScheduleExceptions.startsAt,
            })
            .from(bookingResourceScheduleExceptions)
            .where(
              and(
                inArray(
                  bookingResourceScheduleExceptions.resourceId,
                  requiredResourceIds,
                ),
                eq(bookingResourceScheduleExceptions.status, "active"),
                lt(bookingResourceScheduleExceptions.startsAt, input.timeMax),
                gt(bookingResourceScheduleExceptions.endsAt, input.timeMin),
              ),
            )
            .orderBy(
              asc(bookingResourceScheduleExceptions.resourceId),
              asc(bookingResourceScheduleExceptions.startsAt),
            ),
          db
            .select({
              calendarId:
                bookingResourceCalendarAssignments.providerCalendarId,
              connectionId:
                bookingResourceCalendarAssignments.calendarConnectionId,
              id: bookingResourceCalendarAssignments.id,
              resourceId: bookingResourceCalendarAssignments.resourceId,
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
                  requiredResourceIds,
                ),
                eq(bookingResourceCalendarAssignments.status, "active"),
                eq(
                  bookingResourceCalendarAssignments.contributesBusy,
                  true,
                ),
                eq(bookingCalendarConnections.provider, "google"),
                eq(bookingCalendarConnections.status, "active"),
              ),
            )
            .orderBy(
              asc(bookingResourceCalendarAssignments.resourceId),
              asc(bookingResourceCalendarAssignments.id),
            ),
        ]);

      const resources: OperationalResourceAvailability[] = resourceRows.map(
        (resource) => ({
          busyCalendarAssignments: assignmentRows
            .filter((assignment) => assignment.resourceId === resource.resourceId)
            .map((assignment) => ({
              calendarId: assignment.calendarId,
              connectionId: assignment.connectionId,
              id: assignment.id,
            })),
          exceptions: exceptionRows
            .filter((exception) => exception.resourceId === resource.resourceId)
            .map((exception) => ({
              end: exception.endsAt,
              kind: exception.kind,
              start: exception.startsAt,
            })),
          recurringWindows: scheduleRows
            .filter((schedule) => schedule.resourceId === resource.resourceId)
            .map((schedule) => ({
              effectiveFrom: schedule.effectiveFrom,
              ...(schedule.effectiveUntil
                ? { effectiveUntil: schedule.effectiveUntil }
                : {}),
              endsAt: normalizeDatabaseTime(schedule.endsAt),
              isoWeekday: schedule.weekday as ResourceIsoWeekday,
              startsAt: normalizeDatabaseTime(schedule.startsAt),
              timezone: schedule.timezone,
            })),
          resourceId: resource.resourceId,
          timezone: resource.timezone,
        }),
      );

      return { requiredResourceIds, resources };
    },
  };
}

function normalizeDatabaseTime(value: string): string {
  return value.slice(0, 5);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((first, second) =>
    first.localeCompare(second),
  );
}
