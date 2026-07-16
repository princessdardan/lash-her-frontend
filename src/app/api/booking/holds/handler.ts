import { log } from "@/lib/logging/logger";
import { isSlotAvailable } from "@/lib/booking/availability";
import { parseBookingCalendarIds } from "@/lib/booking/calendar-ids";
import {
  createAppointmentHold,
  getActiveHoldBusyEvents,
  HOLD_DURATION_MINUTES,
  type BookingHoldRecord,
  type CreateBookingHoldResult,
} from "@/lib/booking/holds";
import {
  BOOKING_HOLD_BODY_MAX_BYTES,
  validateHoldRequestBounds,
} from "@/lib/booking/hold-request-limits";
import {
  isResolvedOperationalBookingAvailable,
  loadOperationalAvailabilityContext,
  type OperationalAvailabilityDependencies,
} from "@/lib/booking/operations/availability";
import { resolveOperationalBooking } from "@/lib/booking/operations/offering";
import {
  getServiceBookingModelMode,
  permitsLegacyBookingCreation,
  permitsOperationalBookingCreation,
  type ServiceBookingModelMode,
} from "@/lib/booking/operations/model-mode";
import { buildAvailabilityWindowsFromHours } from "@/lib/booking/schedule-windows";
import {
  SERVICE_BOOKING_TYPE,
  toServiceBookingTypeConfig,
} from "@/lib/booking/service-config";
import type {
  BookingAnswerInput,
  BookingSettings,
  BookingType,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
import type { TService } from "@/types";
import type {
  CreateV2BookingHoldInput,
  CreateV2BookingHoldResult,
} from "@/lib/private-db/booking-reservation-repository";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import type {
  ExpiringQuotaDecision,
  RateLimitDecision,
} from "@/lib/security/kv-rate-limiter";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const PENDING_CUSTOMER = {
  email: "pending-service-booking@example.invalid",
  name: "Pending service booking customer",
  phone: "0000000000",
} as const;

interface BookingHoldRequestInput {
  answers: BookingAnswerInput[];
  offeringId?: string;
  rejectedStepFields: Record<string, string>;
  rejectedRoutingFields: Record<string, string>;
  serviceSlug: string;
  selectedAddOnKey?: string;
  sourcePath?: string;
  start: string;
}

interface BookingAddOnSelectionSnapshot {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: "CAD";
}

export interface BookingHoldsPostHandlerDependencies {
  acquireActiveHoldQuota?: (input: {
    key: string;
    now: Date;
    ttlMs: number;
  }) => Promise<ExpiringQuotaDecision>;
  checkRateLimit?: (input: {
    key: string;
    now: Date;
  }) => Promise<RateLimitDecision>;
  createAppointmentHold: (input: {
    bookingType: BookingType;
    customer: { email: string; name: string; phone: string };
    offeringId: string;
    offeringSnapshot: Record<string, unknown>;
    selectedEnd: Date;
    selectedStart: Date;
    timezone: string;
    now: Date;
  }) => Promise<CreateBookingHoldResult>;
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
  createOperationalHold?: (
    input: CreateV2BookingHoldInput,
  ) => Promise<CreateV2BookingHoldResult>;
  getBookingModelMode?: () => ServiceBookingModelMode;
  getNow?: () => Date;
  operationalAvailability?: OperationalAvailabilityDependencies;
  releaseActiveHoldQuota?: (input: {
    key: string;
    leaseId: string;
  }) => Promise<void>;
}

export function createBookingHoldsPostHandler(
  dependencies: BookingHoldsPostHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingHoldsPostHandler(
    req: Request,
  ): Promise<Response> {
    const parsedBody = await readBoundedJsonBody(
      req,
      BOOKING_HOLD_BODY_MAX_BYTES,
    );
    if (!parsedBody.ok) {
      return parsedBody.reason === "too_large"
        ? Response.json(
            { error: "Hold request is too large" },
            { status: 413 },
          )
        : Response.json({ error: "Invalid hold request" }, { status: 400 });
    }
    const body = parsedBody.value;
    const bounds = validateHoldRequestBounds(body);
    if (!bounds.ok) {
      return Response.json({ error: bounds.error }, { status: bounds.status });
    }

    const input = toBookingHoldRequestInput(body);
    const abuseControlsEnabled = Boolean(
      dependencies.checkRateLimit || dependencies.acquireActiveHoldQuota,
    );
    const abuseKeys = abuseControlsEnabled
      ? buildHoldAbuseKeys(req, input)
      : {
          activeHoldQuotaKey: "booking:abuse:active-holds:test-disabled",
          rateLimitKey: "booking:abuse:hold-attempts:test-disabled",
        };
    if (!abuseKeys) return holdServiceUnavailableResponse();
    const rateLimitResponse = await enforceHoldRateLimit({
      dependencies,
      key: abuseKeys.rateLimitKey,
    });
    if (rateLimitResponse) return rateLimitResponse;
    const fieldErrors = validateHoldRequestInput(input);
    const selectedStart = new Date(input.start);

    if (Object.keys(input.rejectedStepFields).length > 0) {
      return Response.json(
        {
          error: "Contact and payment details belong on the payment step.",
          fieldErrors,
        },
        { status: 400 },
      );
    }

    if (Object.keys(input.rejectedRoutingFields).length > 0) {
      return Response.json(
        {
          error: "Booking resources are selected by the server.",
          fieldErrors: input.rejectedRoutingFields,
        },
        { status: 400 },
      );
    }

    if (
      Object.keys(fieldErrors).length > 0 ||
      Number.isNaN(selectedStart.getTime())
    ) {
      if (Number.isNaN(selectedStart.getTime())) {
        fieldErrors.start = "Please select a valid booking time";
      }

      return Response.json(
        { error: "Please fix the hold details and try again.", fieldErrors },
        { status: 400 },
      );
    }

    try {
      const bookingModelMode =
        dependencies.getBookingModelMode?.() ?? "dual";

      if (input.offeringId) {
        if (
          !permitsOperationalBookingCreation(bookingModelMode)
        ) {
          return bookingNotConfiguredResponse();
        }

        return await handleOperationalBookingHold({
          activeHoldQuotaKey: abuseKeys.activeHoldQuotaKey,
          dependencies,
          input,
          selectedStart,
        });
      }

      if (
        !permitsLegacyBookingCreation(bookingModelMode)
      ) {
        return bookingNotConfiguredResponse();
      }

      const [settings, service] = await Promise.all([
        dependencies.getBookingSettings(),
        dependencies.getBookableServiceBySlug(input.serviceSlug),
      ]);
      const now = dependencies.getNow?.() ?? new Date();

      if (
        bookingModelMode === "dual" &&
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

      if (
        settings === null ||
        service === null ||
        parseBookingCalendarIds(settings).length === 0 ||
        settings.bookingHorizonDays <= 0
      ) {
        return Response.json(
          { error: "Booking is not configured" },
          { status: 400 },
        );
      }

      const bookingTypeConfig = toServiceBookingTypeConfig(settings, service);
      const answerErrors = validateRequiredAnswers(
        input.answers,
        bookingTypeConfig,
      );

      if (Object.keys(answerErrors).length > 0) {
        return Response.json(
          {
            error: "Please fix the hold details and try again.",
            fieldErrors: answerErrors,
          },
          { status: 400 },
        );
      }

      const selectedAddOn = getSelectedAddOn(service, input.selectedAddOnKey);

      if (selectedAddOn === "invalid") {
        return Response.json(
          {
            error: "Please fix the hold details and try again.",
            fieldErrors: {
              selectedAddOnKey:
                "That add-on is no longer available. Please review your selection.",
            },
          },
          { status: 400 },
        );
      }

      const horizonEnd = new Date(
        now.getTime() + settings.bookingHorizonDays * DAY_MS,
      );
      const selectedEnd = new Date(
        selectedStart.getTime() + bookingTypeConfig.durationMinutes * MINUTE_MS,
      );
      const calendarIds = parseBookingCalendarIds(settings);
      const [calendarEventsArrays, activeHolds] = await Promise.all([
        Promise.all(
          calendarIds.map((calendarId) =>
            dependencies.listCalendarEvents({
              calendarId,
              timeMin: now,
              timeMax: horizonEnd,
            }),
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
      const availabilityWindows = buildAvailabilityWindowsFromHours({
        horizonEnd,
        now,
        settings,
      });
      const activeHoldBusyEvents = getActiveHoldBusyEvents({
        holds: activeHolds,
        now,
      });

      if (
        !isSlotAvailable({
          bookingType: bookingTypeConfig,
          requestedStart: selectedStart,
          availabilityWindows,
          busyEvents: [...calendarEvents, ...activeHoldBusyEvents],
          now,
          minimumLeadTimeHours: settings.minimumLeadTimeHours,
          horizonEnd,
        })
      ) {
        return Response.json(
          {
            error:
              "That time is no longer available. Please choose another slot.",
            fieldErrors: { start: "That time is no longer available" },
          },
          { status: 409 },
        );
      }

      const quota = await acquireActiveHoldQuota({
        dependencies,
        key: abuseKeys.activeHoldQuotaKey,
        now,
      });
      if (!quota.ok) return quota.response;

      let holdResult: CreateBookingHoldResult;
      try {
        holdResult = await dependencies.createAppointmentHold({
          bookingType: SERVICE_BOOKING_TYPE,
          customer: PENDING_CUSTOMER,
          offeringId: service._id,
          offeringSnapshot: toServiceSnapshot(service, input, selectedAddOn),
          selectedEnd,
          selectedStart,
          timezone: settings.timezone,
          now,
        });
      } catch (error) {
        await releaseActiveHoldQuota(dependencies, quota.lease);
        throw error;
      }

      if (!holdResult.ok) {
        await releaseActiveHoldQuota(dependencies, quota.lease);
        return Response.json(
          {
            error:
              "That time is no longer available. Please choose another slot.",
            fieldErrors: { start: "That time is no longer available" },
          },
          { status: 409 },
        );
      }

      return Response.json(
        {
          hold: {
            paymentSessionReference: holdResult.hold.paymentSessionReference,
            paymentPageUrl: `/services/${service.slug}/booking/payment?${new URLSearchParams(
              {
                session: holdResult.hold.paymentSessionReference,
              },
            ).toString()}`,
            expiresAt: holdResult.hold.expiresAt.toISOString(),
            start: holdResult.hold.selectedStart.toISOString(),
            end: holdResult.hold.selectedEnd.toISOString(),
            service: {
              slug: service.slug,
              title: service.title,
            },
          },
        },
        { status: 201 },
      );
    } catch (error) {
      log("error", "[booking holds] Failed", { error: getErrorMessage(error) });

      return Response.json(
        { error: "Booking holds are temporarily unavailable" },
        { status: 503 },
      );
    }
  };
}

interface HoldAbuseKeys {
  activeHoldQuotaKey: string;
  rateLimitKey: string;
}

interface ActiveHoldQuotaLease {
  key: string;
  leaseId: string;
}

function buildHoldAbuseKeys(
  req: Request,
  input: BookingHoldRequestInput,
): HoldAbuseKeys | null {
  const subject = input.offeringId
    ? `offering:${input.offeringId}`
    : `service:${input.serviceSlug || "invalid"}`;
  const activeHoldQuotaKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "active-holds",
    subject,
  });
  const rateLimitKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "hold-attempts",
    subject: "all",
  });
  return activeHoldQuotaKey && rateLimitKey
    ? { activeHoldQuotaKey, rateLimitKey }
    : null;
}

async function enforceHoldRateLimit(input: {
  dependencies: BookingHoldsPostHandlerDependencies;
  key: string;
}): Promise<Response | null> {
  if (!input.dependencies.checkRateLimit) return null;

  try {
    const decision = await input.dependencies.checkRateLimit({
      key: input.key,
      now: input.dependencies.getNow?.() ?? new Date(),
    });
    return decision.allowed
      ? null
      : rateLimitedResponse(
          "Too many hold requests. Please wait before trying again.",
          decision.retryAfterSeconds,
        );
  } catch (error) {
    log("warn", "[booking holds] Rate limiter unavailable", {
      error: getErrorMessage(error),
    });
    return holdServiceUnavailableResponse();
  }
}

async function acquireActiveHoldQuota(input: {
  dependencies: BookingHoldsPostHandlerDependencies;
  key: string;
  now: Date;
}): Promise<
  | { ok: true; lease: ActiveHoldQuotaLease | null }
  | { ok: false; response: Response }
> {
  if (!input.dependencies.acquireActiveHoldQuota) {
    return { lease: null, ok: true };
  }

  try {
    const decision = await input.dependencies.acquireActiveHoldQuota({
      key: input.key,
      now: input.now,
      ttlMs: HOLD_DURATION_MINUTES * MINUTE_MS,
    });
    return decision.allowed
      ? {
          lease: { key: input.key, leaseId: decision.leaseId },
          ok: true,
        }
      : {
          ok: false,
          response: rateLimitedResponse(
            "You already have the maximum number of active holds for this service.",
            decision.retryAfterSeconds,
          ),
        };
  } catch (error) {
    log("warn", "[booking holds] Active hold quota unavailable", {
      error: getErrorMessage(error),
    });
    return { ok: false, response: holdServiceUnavailableResponse() };
  }
}

async function releaseActiveHoldQuota(
  dependencies: BookingHoldsPostHandlerDependencies,
  lease: ActiveHoldQuotaLease | null,
): Promise<void> {
  if (!lease || !dependencies.releaseActiveHoldQuota) return;
  try {
    await dependencies.releaseActiveHoldQuota(lease);
  } catch (error) {
    log("warn", "[booking holds] Active hold quota release failed", {
      error: getErrorMessage(error),
    });
  }
}

function rateLimitedResponse(error: string, retryAfterSeconds: number): Response {
  return Response.json(
    { error },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
      },
      status: 429,
    },
  );
}

function holdServiceUnavailableResponse(): Response {
  return Response.json(
    { error: "Booking holds are temporarily unavailable" },
    { headers: { "Cache-Control": "no-store" }, status: 503 },
  );
}

async function handleOperationalBookingHold(input: {
  activeHoldQuotaKey: string;
  dependencies: BookingHoldsPostHandlerDependencies;
  input: BookingHoldRequestInput;
  selectedStart: Date;
}): Promise<Response> {
  const { dependencies, selectedStart } = input;
  const offeringId = input.input.offeringId;

  if (
    offeringId === undefined ||
    dependencies.operationalAvailability === undefined ||
    dependencies.createOperationalHold === undefined
  ) {
    throw new Error("Operational booking dependencies are unavailable");
  }

  const now = dependencies.getNow?.() ?? new Date();
  const [settings, offering] = await Promise.all([
    dependencies.getBookingSettings(),
    dependencies.operationalAvailability.findActiveOfferingById({
      id: offeringId,
      now,
    }),
  ]);

  if (settings === null || offering === null || !offering.service.publicSlug) {
    return Response.json(
      { error: "Booking is not configured" },
      { status: 400 },
    );
  }

  const answerErrors = validateRequiredAnswers(input.input.answers, {
    bufferMinutes: 0,
    description: "",
    durationMinutes: offering.durationMinutes,
    label: offering.service.displayTitle,
    questions: settings.intakeQuestions,
    slotIntervalMinutes: offering.slotIntervalMinutes,
    type: offering.bookingType,
  });

  if (Object.keys(answerErrors).length > 0) {
    return Response.json(
      {
        error: "Please fix the hold details and try again.",
        fieldErrors: answerErrors,
      },
      { status: 400 },
    );
  }

  const resolution = resolveOperationalBooking({
    offering,
    selectedAddOnKey: input.input.selectedAddOnKey,
    selectedStart,
  });

  if (!resolution.ok) {
    if (resolution.reason === "selected_add_on_unavailable") {
      return Response.json(
        {
          error: "Please fix the hold details and try again.",
          fieldErrors: {
            selectedAddOnKey:
              "That add-on is no longer available. Please review your selection.",
          },
        },
        { status: 400 },
      );
    }

    return Response.json(
      { error: "Booking is not configured" },
      { status: 400 },
    );
  }

  const availability = await loadOperationalAvailabilityContext({
    dependencies: dependencies.operationalAvailability,
    now,
    offering,
    offeringId: offering.id,
  });

  if (!availability.ok) {
    return Response.json(
      { error: "Booking is not configured" },
      { status: 400 },
    );
  }

  if (
    !isResolvedOperationalBookingAvailable({
      booking: resolution.booking,
      context: availability.context,
    })
  ) {
    return slotConflictResponse();
  }

  const quota = await acquireActiveHoldQuota({
    dependencies,
    key: input.activeHoldQuotaKey,
    now,
  });
  if (!quota.ok) return quota.response;

  const normalizedAnswers = normalizeAnswers(input.input.answers);
  let holdResult: CreateV2BookingHoldResult;
  try {
    holdResult = await dependencies.createOperationalHold({
      answers: normalizedAnswers,
      booking: resolution.booking,
      customer: PENDING_CUSTOMER,
      expiresAt: new Date(now.getTime() + HOLD_DURATION_MINUTES * MINUTE_MS),
      now,
    });
  } catch (error) {
    await releaseActiveHoldQuota(dependencies, quota.lease);
    throw error;
  }

  if (!holdResult.ok) {
    await releaseActiveHoldQuota(dependencies, quota.lease);
    if (holdResult.reason === "square_team_attribution_required") {
      return bookingNotConfiguredResponse();
    }
    return slotConflictResponse();
  }

  const serviceSlug = offering.service.publicSlug;

  return Response.json(
    {
      hold: {
        paymentSessionReference: holdResult.hold.paymentSessionReference,
        paymentPageUrl: `/services/${serviceSlug}/booking/payment?${new URLSearchParams(
          { session: holdResult.hold.paymentSessionReference },
        ).toString()}`,
        expiresAt: holdResult.hold.expiresAt.toISOString(),
        start: holdResult.hold.selectedStart.toISOString(),
        end: holdResult.hold.selectedEnd.toISOString(),
        service: {
          slug: serviceSlug,
          title: offering.service.displayTitle,
        },
      },
    },
    { status: 201 },
  );
}

function slotConflictResponse(): Response {
  return Response.json(
    {
      error: "That time is no longer available. Please choose another slot.",
      fieldErrors: { start: "That time is no longer available" },
    },
    { status: 409 },
  );
}

function bookingNotConfiguredResponse(): Response {
  return Response.json(
    { error: "Booking is not configured" },
    { status: 400 },
  );
}

export const POST = createBookingHoldsPostHandler({
  acquireActiveHoldQuota: async (input) => {
    const { acquireBookingActiveHoldQuota } =
      await import("@/lib/security/booking-abuse-control");
    return acquireBookingActiveHoldQuota(input);
  },
  checkRateLimit: async (input) => {
    const { checkBookingHoldRateLimit } =
      await import("@/lib/security/booking-abuse-control");
    return checkBookingHoldRateLimit(input);
  },
  createAppointmentHold,
  createOperationalHold: async (input) => {
    const { createDrizzleBookingReservationRepository } =
      await import("@/lib/private-db/booking-reservation-repository");

    return createDrizzleBookingReservationRepository().createV2Hold(input);
  },
  getBookableServiceBySlug: async (slug) => {
    const { loaders } = await import("@/data/loaders");

    return loaders.getBookableServiceBySlug(slug, {
      mode: "published",
      stega: false,
    });
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
  getBookingModelMode: getServiceBookingModelMode,
  listActiveAppointmentHolds: async (input) => {
    const { listActiveAppointmentHolds } = await import("@/lib/booking/holds");

    return listActiveAppointmentHolds(input);
  },
  listCalendarEvents: async (input) => {
    const { listCalendarEvents } =
      await import("@/lib/booking/google-calendar");

    return listCalendarEvents(input);
  },
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
  releaseActiveHoldQuota: async (input) => {
    const { releaseBookingActiveHoldQuota } =
      await import("@/lib/security/booking-abuse-control");
    await releaseBookingActiveHoldQuota(input);
  },
});

function toBookingHoldRequestInput(input: unknown): BookingHoldRequestInput {
  const record = isRecord(input) ? input : {};
  const rejectedStepFields: Record<string, string> = {};
  const rejectedRoutingFields: Record<string, string> = {};

  if (
    record.name !== undefined &&
    (typeof record.name !== "string" || record.name.trim().length > 0)
  ) {
    rejectedStepFields.name = "Enter contact details on the payment page";
  }

  if (
    record.email !== undefined &&
    (typeof record.email !== "string" || record.email.trim().length > 0)
  ) {
    rejectedStepFields.email = "Enter contact details on the payment page";
  }

  if (
    record.phone !== undefined &&
    (typeof record.phone !== "string" || record.phone.trim().length > 0)
  ) {
    rejectedStepFields.phone = "Enter contact details on the payment page";
  }

  if (
    record.paymentOption !== undefined ||
    record.customAmount !== undefined ||
    record.selectedPayment !== undefined
  ) {
    rejectedStepFields.paymentOption =
      "Choose payment amount on the payment page";
  }

  if (
    record.marketingOptIn !== undefined ||
    record.marketingConsentText !== undefined
  ) {
    rejectedStepFields.marketingOptIn =
      "Choose marketing preferences on the payment page";
  }

  for (const field of [
    "calendarAssignmentId",
    "calendarId",
    "connectionId",
    "providerId",
    "resourceId",
  ]) {
    if (record[field] !== undefined) {
      rejectedRoutingFields[field] = "This value is selected by the server";
    }
  }

  const offeringId = toOptionalStringValue(record.offeringId);
  const selectedAddOnKey = toOptionalStringValue(record.selectedAddOnKey);
  const sourcePath = toSafeSourcePath(record.sourcePath);

  return {
    answers: toBookingAnswers(record.answers),
    ...(offeringId ? { offeringId } : {}),
    rejectedStepFields,
    rejectedRoutingFields,
    serviceSlug: (
      toStringValue(record.serviceSlug) ||
      toStringValue(record.service) ||
      toStringValue(record.offeringSlug) ||
      toStringValue(record.offering)
    ).trim(),
    ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    start: toStringValue(record.start).trim(),
  };
}

function validateHoldRequestInput(
  input: BookingHoldRequestInput,
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};

  if (!input.offeringId && input.serviceSlug.length === 0) {
    fieldErrors.serviceSlug = "Please select a booking service";
  }

  if (input.offeringId && input.serviceSlug.length > 0) {
    fieldErrors.offeringId = "Select one booking offering";
  }

  if (input.start.length === 0) {
    fieldErrors.start = "Please select a booking time";
  }

  Object.assign(fieldErrors, input.rejectedStepFields);

  return fieldErrors;
}

function validateRequiredAnswers(
  answers: BookingAnswerInput[],
  bookingTypeConfig: BookingTypeConfig,
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const answersByQuestionId = new Map(
    answers.map((answer) => [answer.questionId, answer.answer.trim()]),
  );

  for (const question of bookingTypeConfig.questions) {
    if (!question.required) {
      continue;
    }

    const answer = answersByQuestionId.get(question.id);

    if (answer === undefined || answer.length === 0) {
      fieldErrors[`answers.${question.id}`] = `${question.label} is required`;
    }
  }

  return fieldErrors;
}

function getSelectedAddOn(
  service: TService,
  selectedAddOnKey?: string,
): BookingAddOnSelectionSnapshot | null | "invalid" {
  if (!selectedAddOnKey) return null;

  const addOn = service.addOns?.find(
    (candidate) => candidate._key === selectedAddOnKey,
  );
  if (!addOn) return "invalid";

  const price = toPositiveAmount(addOn.price);
  if (price === null) return "invalid";

  return {
    key: addOn._key,
    name: addOn.name.trim(),
    description: addOn.description.trim(),
    price,
    currency: "CAD",
  };
}

function toServiceSnapshot(
  service: TService,
  input: BookingHoldRequestInput,
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): Record<string, unknown> {
  return {
    id: service._id,
    slug: service.slug,
    serviceSlug: service.slug,
    title: service.title,
    bookingType: SERVICE_BOOKING_TYPE,
    durationMinutes: service.durationMinutes,
    customerStatus: "pending",
    paymentStatus: "pending",
    pricing: {
      depositAmount: service.depositAmount,
      fullPrice: service.fullPrice,
      currency: service.currency,
      customAmountMinimum: service.depositAmount,
      customAmountMaximum: service.fullPrice,
      addOnPrice: selectedAddOn?.price ?? 0,
    },
    ...(selectedAddOn ? { selectedAddOn } : {}),
    answers: normalizeAnswers(input.answers),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
  };
}

function normalizeAnswers(answers: BookingAnswerInput[]): BookingAnswerInput[] {
  return answers
    .map((answer) => ({
      questionId: answer.questionId.trim(),
      answer: answer.answer.trim(),
    }))
    .filter(
      (answer) => answer.questionId.length > 0 && answer.answer.length > 0,
    );
}

function toBookingAnswers(value: unknown): BookingAnswerInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((answer) => {
    const record = isRecord(answer) ? answer : {};

    return {
      questionId: toStringValue(record.questionId),
      answer: toStringValue(record.answer),
    };
  });
}

function toPositiveAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toOptionalStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toSafeSourcePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  const pathOnly = trimmed.split(/[?#]/, 1)[0];

  if (!pathOnly.startsWith("/") || pathOnly.length === 0) {
    return undefined;
  }

  return pathOnly;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
