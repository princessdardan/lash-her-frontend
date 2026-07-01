import { log } from "@/lib/logging/logger";
import { isSlotAvailable } from "@/lib/booking/availability";
import { parseBookingCalendarIds } from "@/lib/booking/calendar-ids";
import {
  createAppointmentHold,
  getActiveHoldBusyEvents,
  type BookingHoldRecord,
  type CreateBookingHoldResult,
} from "@/lib/booking/holds";
import { buildAvailabilityWindowsFromHours } from "@/lib/booking/schedule-windows";
import {
  SERVICE_BOOKING_TYPE,
  toServiceBookingTypeConfig,
} from "@/lib/booking/service-config";
import { recordBookingMarketingChoice } from "@/lib/marketing-contact/marketing-contact-store";
import type {
  BookingAnswerInput,
  BookingSettings,
  BookingType,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";
import type { TService } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface BookingHoldRequestInput {
  answers: BookingAnswerInput[];
  customAmount?: number;
  email: string;
  marketingConsentText?: string;
  marketingOptIn: boolean;
  name: string;
  paymentOption?: "deposit" | "full" | "customPartial";
  phone: string;
  serviceSlug: string;
  selectedAddOnKey?: string;
  sourcePath?: string;
  start: string;
}

interface BookingPaymentSelectionSnapshot {
  amount: number;
  description: string;
  option: "deposit" | "full" | "customPartial";
  purpose:
    | "appointment_deposit"
    | "appointment_full"
    | "appointment_custom_partial";
  sku: "BOOKING-DEPOSIT" | "BOOKING-FULL" | "BOOKING-CUSTOM-PARTIAL";
}

interface BookingAddOnSelectionSnapshot {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: "CAD";
}

export interface BookingHoldsPostHandlerDependencies {
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
  recordBookingMarketingChoice?: typeof recordBookingMarketingChoice;
}

export function createBookingHoldsPostHandler(
  dependencies: BookingHoldsPostHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingHoldsPostHandler(
    req: Request,
  ): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch (error) {
      log("warn", "[booking holds] Invalid JSON", {
        error: getErrorMessage(error),
      });

      return Response.json({ error: "Invalid hold request" }, { status: 400 });
    }

    const input = toBookingHoldRequestInput(body);
    const fieldErrors = validateHoldRequestInput(input);
    const selectedStart = new Date(input.start);

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
      const [settings, service] = await Promise.all([
        dependencies.getBookingSettings(),
        dependencies.getBookableServiceBySlug(input.serviceSlug),
      ]);

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

      const now = new Date();
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
      const paymentSelection = getPaymentSelection(
        service,
        input,
        selectedAddOn,
      );

      if (paymentSelection === null) {
        return Response.json(
          { error: "Booking payment is not configured" },
          { status: 400 },
        );
      }

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

      const holdResult = await dependencies.createAppointmentHold({
        bookingType: SERVICE_BOOKING_TYPE,
        customer: {
          email: input.email,
          name: input.name,
          phone: input.phone,
        },
        offeringId: service._id,
        offeringSnapshot: toServiceSnapshot(
          service,
          input,
          paymentSelection,
          selectedAddOn,
        ),
        selectedEnd,
        selectedStart,
        timezone: settings.timezone,
        now,
      });

      if (!holdResult.ok) {
        return Response.json(
          {
            error:
              "That time is no longer available. Please choose another slot.",
            fieldErrors: { start: "That time is no longer available" },
          },
          { status: 409 },
        );
      }

      if (dependencies.recordBookingMarketingChoice !== undefined) {
        try {
          await dependencies.recordBookingMarketingChoice({
            answers: toBookingAnswerSnapshots(input.answers, bookingTypeConfig),
            bookingType: SERVICE_BOOKING_TYPE,
            consentText: input.marketingConsentText,
            email: input.email,
            marketingOptIn: input.marketingOptIn,
            name: input.name,
            phone: input.phone,
            sourcePath: input.sourcePath,
          });
        } catch (error) {
          log("error", "[booking holds] Marketing consent persistence failed", {
            error: getErrorMessage(error),
          });
        }
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

export const POST = createBookingHoldsPostHandler({
  createAppointmentHold,
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
  listActiveAppointmentHolds: async (input) => {
    const { listActiveAppointmentHolds } = await import("@/lib/booking/holds");

    return listActiveAppointmentHolds(input);
  },
  listCalendarEvents: async (input) => {
    const { listCalendarEvents } =
      await import("@/lib/booking/google-calendar");

    return listCalendarEvents(input);
  },
  recordBookingMarketingChoice,
});

function toBookingHoldRequestInput(input: unknown): BookingHoldRequestInput {
  const record = isRecord(input) ? input : {};
  const customAmount = parseOptionalAmount(record.customAmount);
  const paymentOption = parsePaymentOption(record.paymentOption);
  const marketingConsentText = toOptionalStringValue(
    record.marketingConsentText,
  );
  const selectedAddOnKey = toOptionalStringValue(record.selectedAddOnKey);
  const sourcePath = toOptionalStringValue(record.sourcePath);

  return {
    ...(customAmount !== undefined && customAmount !== null
      ? { customAmount }
      : {}),
    answers: toBookingAnswers(record.answers),
    email: toStringValue(record.email).trim(),
    marketingOptIn: record.marketingOptIn === true,
    ...(marketingConsentText ? { marketingConsentText } : {}),
    name: toStringValue(record.name).trim(),
    ...(paymentOption ? { paymentOption } : {}),
    phone: toStringValue(record.phone).trim(),
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

  if (input.serviceSlug.length === 0) {
    fieldErrors.serviceSlug = "Please select a booking service";
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

function getPaymentSelection(
  service: TService,
  input: BookingHoldRequestInput,
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): BookingPaymentSelectionSnapshot | null {
  if (input.paymentOption === "deposit") {
    return resolveFixedPaymentSelection(service, "deposit", selectedAddOn);
  }

  if (input.paymentOption === "full") {
    return resolveFixedPaymentSelection(service, "full", selectedAddOn);
  }

  if (input.paymentOption === "customPartial") {
    if (input.customAmount === undefined) {
      return null;
    }

    const depositAmount = toPositiveAmount(service.depositAmount);
    const fullPrice = toPositiveAmount(service.fullPrice);
    const customAmount = toPositiveAmount(input.customAmount);

    if (
      customAmount === null ||
      depositAmount === null ||
      fullPrice === null ||
      customAmount <= depositAmount ||
      customAmount >= fullPrice
    ) {
      return null;
    }

    return {
      amount: customAmount,
      description: selectedAddOn
        ? `${service.title} custom partial payment; ${selectedAddOn.name} add-on balance due later`
        : `${service.title} custom partial payment`,
      option: "customPartial",
      purpose: "appointment_custom_partial",
      sku: "BOOKING-CUSTOM-PARTIAL",
    };
  }

  return null;
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

function resolveFixedPaymentSelection(
  service: TService,
  option: "deposit" | "full",
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): BookingPaymentSelectionSnapshot | null {
  if (option === "deposit") {
    const amount = toPositiveAmount(service.depositAmount);

    return amount === null
      ? null
      : {
          amount,
          description: selectedAddOn
            ? `${service.title} deposit; ${selectedAddOn.name} add-on balance due later`
            : `${service.title} deposit`,
          option: "deposit",
          purpose: "appointment_deposit",
          sku: "BOOKING-DEPOSIT",
        };
  }

  const fullPrice = toPositiveAmount(service.fullPrice);
  const amount =
    fullPrice === null ? null : fullPrice + (selectedAddOn?.price ?? 0);

  return amount === null
    ? null
    : {
        amount,
        description: selectedAddOn
          ? `${service.title} full payment with ${selectedAddOn.name}`
          : `${service.title} full payment`,
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      };
}

function toServiceSnapshot(
  service: TService,
  input: BookingHoldRequestInput,
  paymentSelection: BookingPaymentSelectionSnapshot,
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): Record<string, unknown> {
  return {
    id: service._id,
    slug: service.slug,
    title: service.title,
    bookingType: SERVICE_BOOKING_TYPE,
    durationMinutes: service.durationMinutes,
    depositAmount: service.depositAmount,
    fullPrice: service.fullPrice,
    currency: service.currency,
    ...(selectedAddOn ? { selectedAddOn } : {}),
    selectedPayment: paymentSelection,
    answers: normalizeAnswers(input.answers),
    marketingOptIn: input.marketingOptIn,
    ...(input.marketingConsentText
      ? { marketingConsentText: input.marketingConsentText }
      : {}),
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

function toBookingAnswerSnapshots(
  answers: BookingAnswerInput[],
  bookingTypeConfig: BookingTypeConfig,
) {
  const questionsById = new Map(
    bookingTypeConfig.questions.map((question) => [question.id, question]),
  );

  return normalizeAnswers(answers).map((answer) => ({
    answer: answer.answer,
    questionId: answer.questionId,
    questionLabel:
      questionsById.get(answer.questionId)?.label ?? answer.questionId,
  }));
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

function parsePaymentOption(
  value: unknown,
): "deposit" | "full" | "customPartial" | null {
  return value === "deposit" || value === "full" || value === "customPartial"
    ? value
    : null;
}

function parseOptionalAmount(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return toPositiveAmount(value);
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
