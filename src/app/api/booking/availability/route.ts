import { NextRequest, NextResponse } from "next/server";

import { loaders } from "@/data/loaders";
import { findPendingTrainingEnrollmentByToken } from "@/lib/commerce/training-enrollment-store";
import { buildBookingSlots } from "@/lib/booking/availability";
import { listCalendarEvents } from "@/lib/booking/google-calendar";
import type {
  BookingType,
  CalendarEventWindow,
} from "@/lib/booking/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKING_TYPES: readonly BookingType[] = [
  "training-call",
  "in-person-appointment",
];

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const paidSchedulingToken = req.nextUrl.searchParams.get("token")?.trim();
    let bookingType = req.nextUrl.searchParams.get("type");

    if (paidSchedulingToken) {
      const enrollment = await findPendingTrainingEnrollmentByToken({
        schedulingToken: paidSchedulingToken,
      });

      if (enrollment === null) {
        return NextResponse.json(
          { error: "This training scheduling link is invalid or has expired" },
          { status: 400 },
        );
      }

      bookingType = "training-call";
    }

    if (!isBookingType(bookingType)) {
      return NextResponse.json(
        { error: "A valid booking type is required" },
        { status: 400 },
      );
    }

    const settings = await loaders.getBookingSettings();

    if (settings === null) {
      return NextResponse.json(
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
      return NextResponse.json(
        { error: "Booking is not configured" },
        { status: 400 },
      );
    }

    const now = new Date();
    const horizonEnd = new Date(
      now.getTime() + settings.bookingHorizonDays * DAY_MS,
    );
    const calendarEvents = await listCalendarEvents({
      calendarId: settings.calendarId,
      timeMin: now,
      timeMax: horizonEnd,
    });
    const { availabilityWindows, busyEvents } = partitionCalendarEvents(
      calendarEvents,
      markerTitle,
    );
    const slots = buildBookingSlots({
      bookingType: bookingTypeConfig,
      availabilityWindows,
      busyEvents,
      now,
      minimumLeadTimeHours: settings.minimumLeadTimeHours,
      horizonEnd,
    });

    return NextResponse.json({ slots });
  } catch (error) {
    console.error("[booking availability] Failed:", getErrorMessage(error));

    return NextResponse.json(
      { error: "Availability is temporarily unavailable" },
      { status: 503 },
    );
  }
}

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
