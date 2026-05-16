import { buildBookingSlots } from "@/lib/booking/availability";
import type {
  BookingSettings,
  BookingSlot,
  BookingType,
  CalendarEventWindow,
} from "@/lib/booking/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKING_TYPES: readonly BookingType[] = [
  "training-call",
  "in-person-appointment",
];

export interface BookingAvailabilityGetHandlerDependencies {
  findPendingTrainingEnrollmentByToken: (input: {
    schedulingToken: string;
  }) => Promise<unknown | null>;
  getBookingSettings: () => Promise<BookingSettings | null>;
  listCalendarEvents: (input: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
  }) => Promise<CalendarEventWindow[]>;
  buildBookingSlots: (input: {
    bookingType: BookingSettings["bookingTypes"][number];
    availabilityWindows: CalendarEventWindow[];
    busyEvents: CalendarEventWindow[];
    now: Date;
    minimumLeadTimeHours: number;
    horizonEnd: Date;
  }) => BookingSlot[];
}

export function createBookingAvailabilityGetHandler(
  dependencies: BookingAvailabilityGetHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingAvailabilityGetHandler(
    req: Request,
  ): Promise<Response> {
    try {
      const searchParams = new URL(req.url).searchParams;
      const paidSchedulingToken = searchParams.get("token")?.trim();
      let bookingType = searchParams.get("type");

      if (paidSchedulingToken) {
        const enrollment = await dependencies.findPendingTrainingEnrollmentByToken({
          schedulingToken: paidSchedulingToken,
        });

        if (enrollment === null) {
          return Response.json(
            { error: "This training scheduling link is invalid or has expired" },
            { status: 400 },
          );
        }

        bookingType = "training-call";
      }

      if (!isBookingType(bookingType)) {
        return Response.json(
          { error: "A valid booking type is required" },
          { status: 400 },
        );
      }

      const settings = await dependencies.getBookingSettings();

      if (settings === null) {
        return Response.json(
          { error: "Booking is not configured" },
          { status: 400 },
        );
      }

      const bookingTypeConfig = settings.bookingTypes.find(
        (config) => config.type === bookingType,
      );
      const markerTitle = settings.availabilityMarkerTitle.trim();

      if (
        bookingTypeConfig === undefined ||
        settings.calendarId.trim().length === 0 ||
        markerTitle.length === 0 ||
        settings.bookingHorizonDays <= 0
      ) {
        return Response.json(
          { error: "Booking is not configured" },
          { status: 400 },
        );
      }

      const now = new Date();
      const horizonEnd = new Date(
        now.getTime() + settings.bookingHorizonDays * DAY_MS,
      );
      const calendarEvents = await dependencies.listCalendarEvents({
        calendarId: settings.calendarId,
        timeMin: now,
        timeMax: horizonEnd,
      });
      const { availabilityWindows, busyEvents } = partitionCalendarEvents(
        calendarEvents,
        markerTitle,
      );
      const slots = dependencies.buildBookingSlots({
        bookingType: bookingTypeConfig,
        availabilityWindows,
        busyEvents,
        now,
        minimumLeadTimeHours: settings.minimumLeadTimeHours,
        horizonEnd,
      });

      return Response.json({ slots });
    } catch (error) {
      console.error("[booking availability] Failed:", getErrorMessage(error));

      return Response.json(
        { error: "Availability is temporarily unavailable" },
        { status: 503 },
      );
    }
  };
}

export const GET = createBookingAvailabilityGetHandler({
  findPendingTrainingEnrollmentByToken: async (input) => {
    const { findPendingTrainingEnrollmentByToken } = await import(
      "@/lib/commerce/training-enrollment-store"
    );

    return findPendingTrainingEnrollmentByToken(input);
  },
  getBookingSettings: async () => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookingSettings();
  },
  listCalendarEvents: async (input) => {
    const { listCalendarEvents } = await import(
      "@/lib/booking/google-calendar"
    );

    return listCalendarEvents(input);
  },
  buildBookingSlots,
});

function isBookingType(value: string | null): value is BookingType {
  return value !== null && BOOKING_TYPES.includes(value as BookingType);
}

function partitionCalendarEvents(
  events: CalendarEventWindow[],
  markerTitle: string,
): {
  availabilityWindows: CalendarEventWindow[];
  busyEvents: CalendarEventWindow[];
} {
  const availabilityWindows: CalendarEventWindow[] = [];
  const busyEvents: CalendarEventWindow[] = [];

  for (const event of events) {
    if (event.title.trim() === markerTitle) {
      availabilityWindows.push(event);
      continue;
    }

    busyEvents.push(event);
  }

  return { availabilityWindows, busyEvents };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
