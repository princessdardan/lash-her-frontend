import { buildBookingSlots } from "@/lib/booking/availability";
import { buildResourceAvailabilityWindows } from "@/lib/booking/schedule-windows";
import type {
  ResourceAvailabilityException,
  ResourceIsoWeekday,
} from "@/lib/booking/schedule-windows";
import type {
  BookingSlot,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";

import type {
  OperationalBookingOffering,
  ResolvedOperationalBooking,
} from "./offering";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface OperationalBusyCalendarAssignment {
  calendarId: string;
  connectionId: string;
  id: string;
}

export interface OperationalResourceRecurringWindow {
  effectiveFrom?: string;
  effectiveUntil?: string;
  endsAt: string;
  isoWeekday: ResourceIsoWeekday;
  startsAt: string;
  timezone: string;
}

export interface OperationalResourceAvailability {
  busyCalendarAssignments: OperationalBusyCalendarAssignment[];
  exceptions: ResourceAvailabilityException[];
  recurringWindows: OperationalResourceRecurringWindow[];
  resourceId: string;
  timezone: string;
}

export interface OperationalOfferingAvailabilityConfiguration {
  requiredResourceIds: string[];
  resources: OperationalResourceAvailability[];
}

export interface OperationalReservationBusyWindow {
  end: Date;
  id: string;
  start: Date;
}

export interface OperationalAvailabilityDependencies {
  findActiveOfferingById(input: {
    id: string;
    now: Date;
  }): Promise<OperationalBookingOffering | null>;
  getOfferingAvailabilityConfiguration(input: {
    offeringId: string;
    primaryResourceId: string;
    timeMax: Date;
    timeMin: Date;
  }): Promise<OperationalOfferingAvailabilityConfiguration>;
  listConnectionCalendarEvents(input: {
    calendarId: string;
    connectionId: string;
    timeMax: Date;
    timeMin: Date;
  }): Promise<CalendarEventWindow[]>;
  listReservationBusyWindows(input: {
    now: Date;
    resourceId: string;
    timeMax: Date;
    timeMin: Date;
  }): Promise<OperationalReservationBusyWindow[]>;
}

export interface OperationalAvailabilityContext {
  availabilityWindows: CalendarEventWindow[];
  busyEvents: CalendarEventWindow[];
  horizonEnd: Date;
  now: Date;
  offering: OperationalBookingOffering;
}

export type LoadOperationalAvailabilityResult =
  | { ok: true; context: OperationalAvailabilityContext }
  | { ok: false; reason: "invalid_configuration" | "not_found" };

export async function loadOperationalAvailabilityContext(input: {
  dependencies: OperationalAvailabilityDependencies;
  now: Date;
  offering?: OperationalBookingOffering;
  offeringId: string;
}): Promise<LoadOperationalAvailabilityResult> {
  const offering =
    input.offering ??
    (await input.dependencies.findActiveOfferingById({
      id: input.offeringId,
      now: input.now,
    }));

  if (offering === null) {
    return { ok: false, reason: "not_found" };
  }

  const horizonEnd = new Date(
    input.now.getTime() + offering.horizonDays * 24 * HOUR_MS,
  );

  if (
    !Number.isInteger(offering.horizonDays) ||
    offering.horizonDays <= 0 ||
    Number.isNaN(horizonEnd.getTime())
  ) {
    return { ok: false, reason: "invalid_configuration" };
  }

  const configuration =
    await input.dependencies.getOfferingAvailabilityConfiguration({
      offeringId: offering.id,
      primaryResourceId: offering.resource.id,
      timeMax: horizonEnd,
      timeMin: input.now,
    });
  const requiredResourceIds = uniqueSorted(configuration.requiredResourceIds);
  const configuredResourceIds = uniqueSorted(
    configuration.resources.map((resource) => resource.resourceId),
  );

  if (
    requiredResourceIds.length === 0 ||
    !requiredResourceIds.includes(offering.resource.id) ||
    !sameStrings(requiredResourceIds, configuredResourceIds) ||
    configuration.resources.some(
      (resource) =>
        resource.timezone.length === 0 ||
        resource.recurringWindows.some(
          (window) => window.timezone !== resource.timezone,
        ),
    )
  ) {
    return { ok: false, reason: "invalid_configuration" };
  }

  const resourceResults = await Promise.all(
    configuration.resources.map(async (resource) => {
      const availabilityWindows = buildResourceAvailabilityWindows({
        exceptions: resource.exceptions,
        horizonEnd,
        now: input.now,
        recurringWindows: resource.recurringWindows.map((window) => ({
          ...(window.effectiveFrom
            ? { effectiveFrom: window.effectiveFrom }
            : {}),
          ...(window.effectiveUntil
            ? { effectiveUntil: window.effectiveUntil }
            : {}),
          endsAt: window.endsAt,
          isoWeekday: window.isoWeekday,
          startsAt: window.startsAt,
        })),
        timezone: resource.timezone,
      });
      const [reservationBusyWindows, calendarEventGroups] = await Promise.all([
        input.dependencies.listReservationBusyWindows({
          now: input.now,
          resourceId: resource.resourceId,
          timeMax: horizonEnd,
          timeMin: input.now,
        }),
        Promise.all(
          resource.busyCalendarAssignments.map((assignment) =>
            input.dependencies.listConnectionCalendarEvents({
              calendarId: assignment.calendarId,
              connectionId: assignment.connectionId,
              timeMax: horizonEnd,
              timeMin: input.now,
            }),
          ),
        ),
      ]);
      const reservationEvents = reservationBusyWindows.map((window) => ({
        end: window.end,
        id: `reservation:${resource.resourceId}:${window.id}`,
        start: window.start,
        title: "Reserved booking resource",
      }));
      const calendarEvents = calendarEventGroups.flatMap((events, index) => {
        const assignment = resource.busyCalendarAssignments[index];

        return events.map((event) => ({
          ...event,
          id: `calendar:${assignment.id}:${event.id}`,
        }));
      });

      return {
        availabilityWindows,
        busyEvents: [...reservationEvents, ...calendarEvents],
      };
    }),
  );

  return {
    ok: true,
    context: {
      availabilityWindows: intersectAvailabilityWindows(
        resourceResults.map((result) => result.availabilityWindows),
      ),
      busyEvents: resourceResults.flatMap((result) => result.busyEvents),
      horizonEnd,
      now: input.now,
      offering,
    },
  };
}

export function buildOperationalBookingSlots(
  context: OperationalAvailabilityContext,
  options: { durationMinutes?: number } = {},
): BookingSlot[] {
  const durationMinutes = options.durationMinutes ?? context.offering.durationMinutes;
  const bookingType = toOperationalBookingTypeConfig(
    context.offering,
    durationMinutes,
  );
  const candidates = buildBookingSlots({
    availabilityWindows: context.availabilityWindows,
    bookingType,
    busyEvents: [],
    horizonEnd: context.horizonEnd,
    minimumLeadTimeHours: context.offering.minimumLeadTimeHours,
    now: context.now,
  });

  return candidates.filter((slot) => {
    const selectedStart = new Date(slot.start);
    const selectedEnd = new Date(slot.end);

    return isOperationalIntervalAvailable({
      context,
      occupiedEnd: addMinutes(
        selectedEnd,
        context.offering.bufferAfterMinutes,
      ),
      occupiedStart: addMinutes(
        selectedStart,
        -context.offering.bufferBeforeMinutes,
      ),
      selectedEnd,
      selectedStart,
    });
  });
}

export function isResolvedOperationalBookingAvailable(input: {
  booking: ResolvedOperationalBooking;
  context: OperationalAvailabilityContext;
}): boolean {
  return isOperationalIntervalAvailable({
    context: input.context,
    occupiedEnd: input.booking.occupiedEnd,
    occupiedStart: input.booking.occupiedStart,
    selectedEnd: input.booking.selectedEnd,
    selectedStart: input.booking.selectedStart,
  });
}

function isOperationalIntervalAvailable(input: {
  context: OperationalAvailabilityContext;
  occupiedEnd: Date;
  occupiedStart: Date;
  selectedEnd: Date;
  selectedStart: Date;
}): boolean {
  const earliestStart =
    input.context.now.getTime() +
    input.context.offering.minimumLeadTimeHours * HOUR_MS;

  if (
    !isValidDate(input.selectedStart) ||
    !isValidDate(input.selectedEnd) ||
    !isValidDate(input.occupiedStart) ||
    !isValidDate(input.occupiedEnd) ||
    input.selectedEnd <= input.selectedStart ||
    input.occupiedEnd <= input.occupiedStart ||
    input.selectedStart.getTime() < earliestStart ||
    input.occupiedEnd > input.context.horizonEnd
  ) {
    return false;
  }

  const fitsAvailability = input.context.availabilityWindows.some(
    (window) =>
      input.occupiedStart >= window.start && input.occupiedEnd <= window.end,
  );

  if (!fitsAvailability) {
    return false;
  }

  return !input.context.busyEvents.some(
    (event) =>
      input.occupiedStart < event.end && event.start < input.occupiedEnd,
  );
}

function toOperationalBookingTypeConfig(
  offering: OperationalBookingOffering,
  durationMinutes: number,
): BookingTypeConfig {
  return {
    bufferMinutes: 0,
    description: "",
    durationMinutes,
    label: offering.service.displayTitle,
    questions: [],
    slotIntervalMinutes: offering.slotIntervalMinutes,
    type: offering.bookingType,
  };
}

function intersectAvailabilityWindows(
  groups: CalendarEventWindow[][],
): CalendarEventWindow[] {
  if (groups.length === 0) {
    return [];
  }

  let intersections = groups[0].map((window) => ({
    end: window.end,
    start: window.start,
  }));

  for (const group of groups.slice(1)) {
    intersections = intersections.flatMap((existing) =>
      group.flatMap((candidate) => {
        const start = new Date(
          Math.max(existing.start.getTime(), candidate.start.getTime()),
        );
        const end = new Date(
          Math.min(existing.end.getTime(), candidate.end.getTime()),
        );

        return start < end ? [{ end, start }] : [];
      }),
    );
  }

  return intersections
    .sort((first, second) => first.start.getTime() - second.start.getTime())
    .map((window, index) => ({
      ...window,
      id: `operational-availability:${index}:${window.start.toISOString()}`,
      title: "All required resources available",
    }));
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * MINUTE_MS);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((first, second) =>
    first.localeCompare(second),
  );
}

function sameStrings(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function isValidDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}
