import { buildBookingSlots } from "@/lib/booking/availability";
import {
  getActiveHoldBusyEvents,
  type BookingHoldRecord,
} from "@/lib/booking/holds";
import { resolveTrainingIntroCallEligibility } from "@/lib/booking/paid-training-context";
import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type {
  BookingSettings,
  BookingSlot,
  BookingType,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
import type { TBookingOffering } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKING_TYPES: readonly BookingType[] = [
  "training-call",
  "in-person-appointment",
];

export interface BookingAvailabilityGetHandlerDependencies {
  findPaidTrainingIntroEligibility: (input: {
    schedulingToken: string;
  }) => Promise<PendingTrainingEnrollmentRecord | null>;
  getBookingSettings: () => Promise<BookingSettings | null>;
  getBookingOfferingBySlug: (slug: string) => Promise<TBookingOffering | null>;
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
    bookingType: BookingSettings["bookingTypes"][number];
    availabilityWindows: CalendarEventWindow[];
    busyEvents: CalendarEventWindow[];
    now: Date;
    minimumLeadTimeHours: number;
    horizonEnd: Date;
  }) => BookingSlot[];
}

interface BookingAvailabilityInput {
  bookingType: string | null;
  offeringSlug: string | null;
  paidSchedulingToken?: string;
  paidTrainingSlug?: string;
}

export function createBookingAvailabilityGetHandler(
  dependencies: BookingAvailabilityGetHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingAvailabilityGetHandler(
    req: Request,
  ): Promise<Response> {
    try {
      const searchParams = new URL(req.url).searchParams;

      if (searchParams.has("email")) {
        return Response.json(
          { error: "Checkout email must not be sent in the availability URL" },
          { status: 400 },
        );
      }

      if (searchParams.has("order")) {
        return Response.json(
          { error: "Paid training availability requires a secure request body" },
          { status: 405 },
        );
      }

      return await handleBookingAvailabilityRequest(
        {
          bookingType: searchParams.get("type"),
          offeringSlug: getOfferingSlug(searchParams),
          paidSchedulingToken: optionalString(searchParams.get("token")),
          paidTrainingSlug: getTrainingSlug(searchParams),
        },
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
  return async function bookingAvailabilityPostHandler(
    req: Request,
  ): Promise<Response> {
    try {
      const body: unknown = await req.json();

      if (!isAvailabilityPostBody(body)) {
        return Response.json(
          { error: "Invalid availability request" },
          { status: 400 },
        );
      }

      return await handleBookingAvailabilityRequest(
        {
          bookingType: optionalString(body.type) ?? null,
          offeringSlug: optionalString(body.offering) ?? optionalString(body.offeringSlug) ?? null,
          paidSchedulingToken: optionalString(body.token) ?? optionalString(body.paidSchedulingToken),
          paidTrainingSlug: optionalString(body.slug) ?? optionalString(body.trainingSlug) ?? optionalString(body.paidTrainingSlug),
        },
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
  const offeringSlug = input.offeringSlug;
  const paidSchedulingToken = input.paidSchedulingToken;
  const paidTrainingSlug = input.paidTrainingSlug;
  let bookingType = input.bookingType;

  if (!offeringSlug && (paidSchedulingToken || paidTrainingSlug)) {
    const eligibility = await resolveTrainingIntroCallEligibility(
      {
        programSlug: paidTrainingSlug ?? "",
        schedulingToken: paidSchedulingToken ?? "",
      },
      dependencies.findPaidTrainingIntroEligibility,
    );

    if (!eligibility.ok) {
      return Response.json(
        {
          error: eligibility.error,
          fieldErrors: eligibility.fieldErrors,
        },
        { status: 400 },
      );
    }

    bookingType = "training-call";
  }

  if (!offeringSlug && !isBookingType(bookingType)) {
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

  const offering = offeringSlug
    ? await dependencies.getBookingOfferingBySlug(offeringSlug)
    : null;
  const bookingTypeConfig = offering
    ? toOfferingBookingTypeConfig(settings, offering)
    : settings.bookingTypes.find((config) => config.type === bookingType);
  const markerTitle = settings.availabilityMarkerTitle.trim();
  const minimumLeadTimeHours = offering?.minimumLeadTimeHoursOverride ?? settings.minimumLeadTimeHours;

  if (
    (offeringSlug && offering === null) ||
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
  const activeHoldBusyEvents = offering
    ? getActiveHoldBusyEvents({
        holds: await dependencies.listActiveAppointmentHolds({
          offeringId: offering._id,
          timeMin: now,
          timeMax: horizonEnd,
          now,
        }),
        now,
      })
    : [];
  const slots = dependencies.buildBookingSlots({
    bookingType: bookingTypeConfig,
    availabilityWindows,
    busyEvents: [...busyEvents, ...activeHoldBusyEvents],
    now,
    minimumLeadTimeHours,
    horizonEnd,
  });

  return Response.json({ slots });
}

const availabilityDependencies: BookingAvailabilityGetHandlerDependencies = {
  findPaidTrainingIntroEligibility: async (input) => {
    const { findPendingTrainingEnrollmentByToken } = await import(
      "@/lib/commerce/training-enrollment-store"
    );

    return findPendingTrainingEnrollmentByToken({ schedulingToken: input.schedulingToken });
  },
  getBookingSettings: async () => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookingSettings();
  },
  getBookingOfferingBySlug: async (slug) => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookingOfferingBySlug(slug);
  },
  listActiveAppointmentHolds: async (input) => {
    const { listActiveAppointmentHolds } = await import("@/lib/booking/holds");

    return listActiveAppointmentHolds(input);
  },
  listCalendarEvents: async (input) => {
    const { listCalendarEvents } = await import(
      "@/lib/booking/google-calendar"
    );

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

function isBookingType(value: string | null): value is BookingType {
  return value !== null && BOOKING_TYPES.includes(value as BookingType);
}

function getOfferingSlug(searchParams: URLSearchParams): string | null {
  const offeringSlug = searchParams.get("offering")?.trim() ?? searchParams.get("offeringSlug")?.trim();
  return offeringSlug && offeringSlug.length > 0 ? offeringSlug : null;
}

function getTrainingSlug(searchParams: URLSearchParams): string | undefined {
  return optionalString(searchParams.get("slug"))
    ?? optionalString(searchParams.get("trainingSlug"))
    ?? optionalString(searchParams.get("paidTrainingSlug"));
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
