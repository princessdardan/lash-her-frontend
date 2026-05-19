import { isSlotAvailable } from "@/lib/booking/availability";
import {
  createAppointmentHold,
  getActiveHoldBusyEvents,
  type BookingHoldRecord,
  type CreateBookingHoldResult,
} from "@/lib/booking/holds";
import type {
  BookingSettings,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
import type { TBookingOffering } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface BookingHoldRequestInput {
  email: string;
  name: string;
  offeringSlug: string;
  phone: string;
  start: string;
}

export interface BookingHoldsPostHandlerDependencies {
  createAppointmentHold: (input: {
    bookingType: TBookingOffering["bookingType"];
    customer: { email: string; name: string; phone: string };
    offeringId: string;
    offeringSnapshot: Record<string, unknown>;
    selectedEnd: Date;
    selectedStart: Date;
    timezone: string;
    now: Date;
  }) => Promise<CreateBookingHoldResult>;
  getBookingOfferingBySlug: (slug: string) => Promise<TBookingOffering | null>;
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
}

export function createBookingHoldsPostHandler(
  dependencies: BookingHoldsPostHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingHoldsPostHandler(req: Request): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch (error) {
      console.warn("[booking holds] Invalid JSON:", getErrorMessage(error));

      return Response.json(
        { error: "Invalid hold request" },
        { status: 400 },
      );
    }

    const input = toBookingHoldRequestInput(body);
    const fieldErrors = validateHoldRequestInput(input);
    const selectedStart = new Date(input.start);

    if (Object.keys(fieldErrors).length > 0 || Number.isNaN(selectedStart.getTime())) {
      if (Number.isNaN(selectedStart.getTime())) {
        fieldErrors.start = "Please select a valid booking time";
      }

      return Response.json(
        { error: "Please fix the hold details and try again.", fieldErrors },
        { status: 400 },
      );
    }

    try {
      const [settings, offering] = await Promise.all([
        dependencies.getBookingSettings(),
        dependencies.getBookingOfferingBySlug(input.offeringSlug),
      ]);

      if (settings === null || offering === null) {
        return Response.json(
          { error: "Booking is not configured" },
          { status: 400 },
        );
      }

      const bookingTypeConfig = toOfferingBookingTypeConfig(settings, offering);
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
      const horizonEnd = new Date(now.getTime() + settings.bookingHorizonDays * DAY_MS);
      const selectedEnd = new Date(
        selectedStart.getTime() + bookingTypeConfig.durationMinutes * MINUTE_MS,
      );
      const [calendarEvents, activeHolds] = await Promise.all([
        dependencies.listCalendarEvents({
          calendarId: settings.calendarId,
          timeMin: now,
          timeMax: horizonEnd,
        }),
        dependencies.listActiveAppointmentHolds({
          offeringId: offering._id,
          timeMin: now,
          timeMax: horizonEnd,
          now,
        }),
      ]);
      const { availabilityWindows, busyEvents } = partitionCalendarEvents(
        calendarEvents,
        markerTitle,
      );
      const activeHoldBusyEvents = getActiveHoldBusyEvents({ holds: activeHolds, now });
      const minimumLeadTimeHours = offering.minimumLeadTimeHoursOverride ?? settings.minimumLeadTimeHours;

      if (!isSlotAvailable({
        bookingType: bookingTypeConfig,
        requestedStart: selectedStart,
        availabilityWindows,
        busyEvents: [...busyEvents, ...activeHoldBusyEvents],
        now,
        minimumLeadTimeHours,
        horizonEnd,
      })) {
        return Response.json(
          {
            error: "That time is no longer available. Please choose another slot.",
            fieldErrors: { start: "That time is no longer available" },
          },
          { status: 409 },
        );
      }

      const holdResult = await dependencies.createAppointmentHold({
        bookingType: offering.bookingType,
        customer: {
          email: input.email,
          name: input.name,
          phone: input.phone,
        },
        offeringId: offering._id,
        offeringSnapshot: toOfferingSnapshot(offering),
        selectedEnd,
        selectedStart,
        timezone: settings.timezone,
        now,
      });

      if (!holdResult.ok) {
        return Response.json(
          {
            error: "That time is no longer available. Please choose another slot.",
            fieldErrors: { start: "That time is no longer available" },
          },
          { status: 409 },
        );
      }

      return Response.json(
        {
          hold: {
            reference: holdResult.hold.publicReference,
            expiresAt: holdResult.hold.expiresAt.toISOString(),
            start: holdResult.hold.selectedStart.toISOString(),
            end: holdResult.hold.selectedEnd.toISOString(),
            offering: {
              slug: offering.slug,
              title: offering.title,
            },
            paymentMode: offering.paymentMode,
          },
        },
        { status: 201 },
      );
    } catch (error) {
      console.error("[booking holds] Failed:", getErrorMessage(error));

      return Response.json(
        { error: "Booking holds are temporarily unavailable" },
        { status: 503 },
      );
    }
  };
}

export const POST = createBookingHoldsPostHandler({
  createAppointmentHold,
  getBookingOfferingBySlug: async (slug) => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookingOfferingBySlug(slug);
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
});

function toBookingHoldRequestInput(input: unknown): BookingHoldRequestInput {
  const record = isRecord(input) ? input : {};

  return {
    email: toStringValue(record.email).trim(),
    name: toStringValue(record.name).trim(),
    offeringSlug: (toStringValue(record.offeringSlug) || toStringValue(record.offering)).trim(),
    phone: toStringValue(record.phone).trim(),
    start: toStringValue(record.start).trim(),
  };
}

function validateHoldRequestInput(input: BookingHoldRequestInput): Record<string, string> {
  const fieldErrors: Record<string, string> = {};

  if (input.offeringSlug.length === 0) {
    fieldErrors.offeringSlug = "Please select a booking offering";
  }

  if (input.start.length === 0) {
    fieldErrors.start = "Please select a booking time";
  }

  if (input.name.length === 0) {
    fieldErrors.name = "Name is required";
  }

  if (input.phone.length === 0) {
    fieldErrors.phone = "Phone number is required";
  }

  if (input.email.length === 0) {
    fieldErrors.email = "Email is required";
  } else if (!EMAIL_PATTERN.test(input.email)) {
    fieldErrors.email = "Please enter a valid email address";
  }

  return fieldErrors;
}

function toOfferingBookingTypeConfig(
  settings: BookingSettings,
  offering: TBookingOffering,
): BookingTypeConfig | undefined {
  const baseConfig = settings.bookingTypes.find((config) => config.type === offering.bookingType);

  if (baseConfig === undefined) {
    return undefined;
  }

  return {
    ...baseConfig,
    type: offering.bookingType,
    label: offering.title,
    description: offering.description,
    durationMinutes: offering.durationMinutes,
    slotIntervalMinutes: offering.slotIntervalMinutes,
    bufferBeforeMinutes: offering.bufferBeforeMinutes,
    bufferAfterMinutes: offering.bufferAfterMinutes,
  };
}

function toOfferingSnapshot(offering: TBookingOffering): Record<string, unknown> {
  return {
    id: offering._id,
    slug: offering.slug,
    title: offering.title,
    bookingType: offering.bookingType,
    durationMinutes: offering.durationMinutes,
    paymentMode: offering.paymentMode,
    ...(offering.depositProduct ? { depositProductId: offering.depositProduct._id } : {}),
    ...(offering.fullProduct ? { fullProductId: offering.fullProduct._id } : {}),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
