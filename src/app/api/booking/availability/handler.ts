import { buildBookingSlots } from "@/lib/booking/availability";
import { parseBookingCalendarIds } from "@/lib/booking/calendar-ids";
import {
  getActiveHoldBusyEvents,
  type BookingHoldRecord,
} from "@/lib/booking/holds";
import {
  buildOperationalBookingSlots,
  loadOperationalAvailabilityContext,
  type OperationalAvailabilityDependencies,
} from "@/lib/booking/operations/availability";
import {
  getServiceBookingModelMode,
  permitsLegacyBookingCreation,
  permitsOperationalBookingCreation,
  type ServiceBookingModelMode,
} from "@/lib/booking/operations/model-mode";
import { isValidOperationalBookingAddOn } from "@/lib/booking/operations/offering";
import { buildAvailabilityWindowsFromHours } from "@/lib/booking/schedule-windows";
import { toServiceBookingTypeConfig } from "@/lib/booking/service-config";
import type { RateLimitDecision } from "@/lib/security/kv-rate-limiter";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";
import type {
  BookingSettings,
  BookingSlot,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
import type { TService } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const AVAILABILITY_POST_BODY_MAX_BYTES = 8 * 1024;
const BOOKING_WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface BookingAvailabilityGetHandlerDependencies {
  checkRateLimit?: (input: {
    key: string;
    now: Date;
  }) => Promise<RateLimitDecision>;
  getBookableServiceBySlug: (slug: string) => Promise<TService | null>;
  getBookingSettings: () => Promise<BookingSettings | null>;
  hasOperationalOfferingIntent?: (input: {
    now: Date;
    sanityServiceId: string;
    servicePublicSlug: string;
  }) => Promise<boolean>;
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
  getBookingModelMode?: () => ServiceBookingModelMode;
  getNow?: () => Date;
  operationalAvailability?: OperationalAvailabilityDependencies;
}

interface BookingAvailabilityInput {
  offeringId: string | null;
  selectedAddOnKey: string | null;
  serviceSlug: string | null;
}

export function createBookingAvailabilityGetHandler(
  dependencies: BookingAvailabilityGetHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingAvailabilityGetHandler(req: Request): Promise<Response> {
    try {
      const searchParams = new URL(req.url).searchParams;
      const input = {
        offeringId: getOfferingId(searchParams),
        selectedAddOnKey: getSelectedAddOnKey(searchParams),
        serviceSlug: getServiceSlug(searchParams),
      };
      const limitedResponse = await enforceAvailabilityRateLimit(
        req,
        dependencies,
      );
      if (limitedResponse) return limitedResponse;

      return await handleBookingAvailabilityRequest(
        input,
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
      const parsedBody = await readBoundedJsonBody(
        req,
        AVAILABILITY_POST_BODY_MAX_BYTES,
      );
      if (!parsedBody.ok) {
        return parsedBody.reason === "too_large"
          ? Response.json(
              { error: "Availability request is too large" },
              { status: 413 },
            )
          : Response.json(
              { error: "Invalid availability request" },
              { status: 400 },
            );
      }
      const body = parsedBody.value;

      if (!isAvailabilityPostBody(body)) {
        return Response.json(
          { error: "Invalid availability request" },
          { status: 400 },
        );
      }

      const input = {
        offeringId: optionalString(body.offeringId) ?? null,
        selectedAddOnKey: optionalString(body.selectedAddOnKey) ?? null,
        serviceSlug:
          optionalString(body.service) ??
          optionalString(body.serviceSlug) ??
          optionalString(body.offering) ??
          optionalString(body.offeringSlug) ??
          null,
      };
      const limitedResponse = await enforceAvailabilityRateLimit(
        req,
        dependencies,
      );
      if (limitedResponse) return limitedResponse;

      return await handleBookingAvailabilityRequest(
        input,
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

async function enforceAvailabilityRateLimit(
  req: Request,
  dependencies: BookingAvailabilityGetHandlerDependencies,
): Promise<Response | null> {
  if (!dependencies.checkRateLimit) return null;

  const key = buildBookingAbuseKey({
    headers: req.headers,
    scope: "availability",
    subject: "all",
  });
  if (!key) {
    return Response.json(
      { error: "Availability is temporarily unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
  const decision = await dependencies.checkRateLimit({
    key,
    now: dependencies.getNow?.() ?? new Date(),
  });

  return decision.allowed
    ? null
    : Response.json(
        { error: "Too many availability requests. Please wait and try again." },
        {
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(decision.retryAfterSeconds),
          },
          status: 429,
        },
      );
}

async function handleBookingAvailabilityRequest(
  input: BookingAvailabilityInput,
  dependencies: BookingAvailabilityGetHandlerDependencies,
): Promise<Response> {
  const mode = dependencies.getBookingModelMode?.() ?? "dual";

  if (input.offeringId) {
    if (!permitsOperationalBookingCreation(mode)) {
      return bookingNotConfiguredResponse();
    }

    return handleOperationalBookingAvailability(
      input.offeringId,
      input.selectedAddOnKey,
      dependencies,
    );
  }

  if (!permitsLegacyBookingCreation(mode)) {
    return bookingNotConfiguredResponse();
  }

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
  const now = dependencies.getNow?.() ?? new Date();

  if (
    mode === "dual" &&
    service !== null &&
    dependencies.hasOperationalOfferingIntent !== undefined &&
    (await dependencies.hasOperationalOfferingIntent({
      now,
      sanityServiceId: service._id,
      servicePublicSlug: service.slug,
    }))
  ) {
    return bookingNotConfiguredResponse();
  }

  if (!isConfiguredBookingSettings(settings) || service === null) {
    return Response.json(
      { error: "Booking is not configured" },
      { status: 400 },
    );
  }

  const horizonEnd = new Date(now.getTime() + settings.bookingHorizonDays * DAY_MS);
  const bookingTypeConfig = toServiceBookingTypeConfig(settings, service);
  const calendarIds = parseBookingCalendarIds(settings);
  const [calendarEventsArrays, activeHolds] = await Promise.all([
    Promise.all(
      calendarIds.map((calendarId) =>
        dependencies.listCalendarEvents({
          calendarId,
          timeMin: now,
          timeMax: horizonEnd,
        })
      ),
    ),
    dependencies.listActiveAppointmentHolds({
      offeringId: service._id,
      timeMin: now,
      timeMax: horizonEnd,
      now,
    }),
  ]);
  const calendarEvents = calendarEventsArrays.flat();
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

function bookingNotConfiguredResponse(): Response {
  return Response.json(
    { error: "Booking is not configured" },
    { status: 400 },
  );
}

async function handleOperationalBookingAvailability(
  offeringId: string,
  selectedAddOnKey: string | null,
  dependencies: BookingAvailabilityGetHandlerDependencies,
): Promise<Response> {
  if (dependencies.operationalAvailability === undefined) {
    throw new Error("Operational availability dependencies are unavailable");
  }

  const result = await loadOperationalAvailabilityContext({
    dependencies: dependencies.operationalAvailability,
    now: dependencies.getNow?.() ?? new Date(),
    offeringId,
  });

  if (!result.ok) {
    return Response.json(
      { error: "Booking is not configured" },
      { status: 400 },
    );
  }

  const selectedAddOn = selectedAddOnKey
    ? result.context.offering.addOns.find(
        (addOn) =>
          addOn.key === selectedAddOnKey && addOn.status === "active",
      )
    : undefined;

  if (selectedAddOnKey && selectedAddOn === undefined) {
    return Response.json(
      {
        error: "Invalid availability request",
        fieldErrors: {
          selectedAddOnKey: "That add-on is no longer available",
        },
      },
      { status: 400 },
    );
  }

  if (
    selectedAddOn !== undefined &&
    !isValidOperationalBookingAddOn(selectedAddOn)
  ) {
    return bookingNotConfiguredResponse();
  }

  return Response.json({
    slots: buildOperationalBookingSlots(result.context, {
      durationMinutes:
        result.context.offering.durationMinutes +
        (selectedAddOn?.durationDeltaMinutes ?? 0),
    }),
  });
}

const availabilityDependencies: BookingAvailabilityGetHandlerDependencies = {
  checkRateLimit: async (input) => {
    const { checkBookingAvailabilityRateLimit } =
      await import("@/lib/security/booking-abuse-control");
    return checkBookingAvailabilityRateLimit(input);
  },
  getBookableServiceBySlug: async (slug) => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookableServiceBySlug(slug, { mode: "published", stega: false });
  },
  getBookingSettings: async () => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookingSettings({ mode: "published", stega: false });
  },
  hasOperationalOfferingIntent: async (input) => {
    const { createDrizzleOperationalBookingConfigurationRepository } =
      await import("@/lib/private-db/booking-configuration-repository");

    return createDrizzleOperationalBookingConfigurationRepository().hasActiveOfferingIntent(
      input,
    );
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
  getBookingModelMode: getServiceBookingModelMode,
  operationalAvailability: {
    findActiveOfferingById: async (input) => {
      const { createDrizzleOperationalBookingConfigurationRepository } =
        await import("@/lib/private-db/booking-configuration-repository");

      return createDrizzleOperationalBookingConfigurationRepository().findActiveOfferingById(
        input,
      );
    },
    getOfferingAvailabilityConfiguration: async (input) => {
      const { createDrizzleBookingAvailabilityRepository } =
        await import("@/lib/private-db/booking-availability-repository");

      return createDrizzleBookingAvailabilityRepository().getOfferingAvailabilityConfiguration(
        input,
      );
    },
    listConnectionCalendarEvents: async (input) => {
      const { listConnectionCalendarEvents } =
        await import("@/lib/booking/google-calendar");

      return listConnectionCalendarEvents(input);
    },
    listReservationBusyWindows: async (input) => {
      const { createDrizzleBookingReservationRepository } =
        await import("@/lib/private-db/booking-reservation-repository");

      return createDrizzleBookingReservationRepository().listActiveBusyWindows(
        input,
      );
    },
  },
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

function getOfferingId(searchParams: URLSearchParams): string | null {
  return optionalString(searchParams.get("offeringId")) ?? null;
}

function getSelectedAddOnKey(searchParams: URLSearchParams): string | null {
  return optionalString(searchParams.get("selectedAddOnKey")) ?? null;
}

function isConfiguredBookingSettings(
  settings: BookingSettings | null,
): settings is BookingSettings {
  if (settings === null) {
    return false;
  }

  return optionalString(settings.calendarId) !== undefined &&
    parseBookingCalendarIds(settings).length > 0 &&
    Number.isInteger(settings.bookingHorizonDays) &&
    settings.bookingHorizonDays > 0 &&
    Number.isInteger(settings.minimumLeadTimeHours) &&
    settings.minimumLeadTimeHours >= 0 &&
    optionalString(settings.timezone) !== undefined &&
    Number.isInteger(settings.bufferMinutes) &&
    settings.bufferMinutes >= 0 &&
    Number.isInteger(settings.slotIntervalMinutes) &&
    settings.slotIntervalMinutes > 0 &&
    Array.isArray(settings.hoursOfOperation) &&
    settings.hoursOfOperation.length === 7 &&
    settings.hoursOfOperation.every(isConfiguredHoursWindow);
}

function isConfiguredHoursWindow(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    closesAt?: unknown;
    day?: unknown;
    isOpen?: unknown;
    opensAt?: unknown;
  };
  const opensAt = optionalString(candidate.opensAt);
  const closesAt = optionalString(candidate.closesAt);

  return typeof candidate.day === "string" &&
    BOOKING_WEEKDAYS.has(candidate.day) &&
    typeof candidate.isOpen === "boolean" &&
    opensAt !== undefined &&
    TIME_PATTERN.test(opensAt) &&
    closesAt !== undefined &&
    TIME_PATTERN.test(closesAt);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
