import { buildBookingSlots } from "@/lib/booking/availability";
import {
  getActiveHoldBusyEvents,
  type BookingHoldRecord,
} from "@/lib/booking/holds";
import { buildAvailabilityWindowsFromHours } from "@/lib/booking/schedule-windows";
import { toServiceBookingTypeConfig } from "@/lib/booking/service-config";
import type {
  BookingSettings,
  BookingSlot,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
import type { TService } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BookingAvailabilityGetHandlerDependencies {
  getBookableServiceBySlug: (slug: string) => Promise<TService | null>;
  getBookingSettings: () => Promise<BookingSettings | null>;
  listActiveAppointmentHolds: (input: {
    offeringId: string;
    timeMin: Date;
    timeMax: Date;
    now: Date;
  }) => Promise<BookingHoldRecord[]>;
  listCalendarEvents: (input: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
  }) => Promise<CalendarEventWindow[]>;
  buildBookingSlots: (input: {
    bookingType: BookingTypeConfig;
    availabilityWindows: CalendarEventWindow[];
    busyEvents: CalendarEventWindow[];
    now: Date;
    minimumLeadTimeHours: number;
    horizonEnd: Date;
  }) => BookingSlot[];
}

interface BookingAvailabilityInput {
  serviceSlug: string | null;
}

export function createBookingAvailabilityGetHandler(
  dependencies: BookingAvailabilityGetHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingAvailabilityGetHandler(req: Request): Promise<Response> {
    try {
      return await handleBookingAvailabilityRequest(
        { serviceSlug: getServiceSlug(new URL(req.url).searchParams) },
        dependencies,
      );
    } catch (error) {
      console.error("[booking availability] Failed:", getErrorMessage(error));

      return Response.json(
        { error: "Availability is temporarily unavailable" },
        { status: 503 },
      );
    }
  };
}

export function createBookingAvailabilityPostHandler(
  dependencies: BookingAvailabilityGetHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingAvailabilityPostHandler(req: Request): Promise<Response> {
    try {
      const body: unknown = await req.json();

      if (!isAvailabilityPostBody(body)) {
        return Response.json(
          { error: "Invalid availability request" },
          { status: 400 },
        );
      }

      return await handleBookingAvailabilityRequest(
        { serviceSlug: optionalString(body.service) ?? optionalString(body.serviceSlug) ?? optionalString(body.offering) ?? optionalString(body.offeringSlug) ?? null },
        dependencies,
      );
    } catch (error) {
      console.error("[booking availability] Failed:", getErrorMessage(error));

      return Response.json(
        { error: "Availability is temporarily unavailable" },
        { status: 503 },
      );
    }
  };
}

async function handleBookingAvailabilityRequest(
  input: BookingAvailabilityInput,
  dependencies: BookingAvailabilityGetHandlerDependencies,
): Promise<Response> {
  const serviceSlug = input.serviceSlug;

  if (!serviceSlug) {
    return Response.json(
      { error: "A valid service is required" },
      { status: 400 },
    );
  }

  const [settings, service] = await Promise.all([
    dependencies.getBookingSettings(),
    dependencies.getBookableServiceBySlug(serviceSlug),
  ]);

  if (settings === null || service === null || settings.calendarId.trim().length === 0 || settings.bookingHorizonDays <= 0) {
    return Response.json(
      { error: "Booking is not configured" },
      { status: 400 },
    );
  }

  const now = new Date();
  const horizonEnd = new Date(now.getTime() + settings.bookingHorizonDays * DAY_MS);
  const bookingTypeConfig = toServiceBookingTypeConfig(settings, service);
  const [calendarEvents, activeHolds] = await Promise.all([
    dependencies.listCalendarEvents({
      calendarId: settings.calendarId,
      timeMin: now,
      timeMax: horizonEnd,
    }),
    dependencies.listActiveAppointmentHolds({
      offeringId: service._id,
      timeMin: now,
      timeMax: horizonEnd,
      now,
    }),
  ]);
  const availabilityWindows = buildAvailabilityWindowsFromHours({ horizonEnd, now, settings });
  const activeHoldBusyEvents = getActiveHoldBusyEvents({ holds: activeHolds, now });
  const slots = dependencies.buildBookingSlots({
    bookingType: bookingTypeConfig,
    availabilityWindows,
    busyEvents: [...calendarEvents, ...activeHoldBusyEvents],
    now,
    minimumLeadTimeHours: settings.minimumLeadTimeHours,
    horizonEnd,
  });

  return Response.json({ slots });
}

const availabilityDependencies: BookingAvailabilityGetHandlerDependencies = {
  getBookableServiceBySlug: async (slug) => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookableServiceBySlug(slug);
  },
  getBookingSettings: async () => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookingSettings();
  },
  listActiveAppointmentHolds: async (input) => {
    const { listActiveAppointmentHolds } = await import("@/lib/booking/holds");

    return listActiveAppointmentHolds(input);
  },
  listCalendarEvents: async (input) => {
    const { listCalendarEvents } = await import("@/lib/booking/google-calendar");

    return listCalendarEvents(input);
  },
  buildBookingSlots,
};

export const GET = createBookingAvailabilityGetHandler(availabilityDependencies);
export const POST = createBookingAvailabilityPostHandler(availabilityDependencies);

function isAvailabilityPostBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getServiceSlug(searchParams: URLSearchParams): string | null {
  return optionalString(searchParams.get("service"))
    ?? optionalString(searchParams.get("serviceSlug"))
    ?? optionalString(searchParams.get("offering"))
    ?? optionalString(searchParams.get("offeringSlug"))
    ?? null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
