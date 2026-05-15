import "server-only";

import { nanoid } from "nanoid";

import { loaders } from "@/data/loaders";
import {
  findPendingTrainingEnrollmentByToken,
  markTrainingEnrollmentScheduled,
} from "@/lib/commerce/training-enrollment-store";
import { formClient } from "@/sanity/lib/form-client";
import { isSlotAvailable } from "./availability";
import {
  buildBookingEventPayload,
  insertBookingEvent,
  listCalendarEvents,
} from "./google-calendar";
import {
  acquireCalendarLock,
  claimIdempotencyKey,
  releaseCalendarLock,
} from "./operational-store";
import { sendBookingConfirmationEmail } from "./email";
import { resolvePaidTrainingBookingContext } from "./paid-training-context";
import { validateBookingRequest } from "./booking-validation";
import type {
  BookingAnswerInput,
  BookingRequestInput,
  BookingTypeConfig,
  CalendarEventWindow,
  PaidTrainingBookingContext,
} from "./types";

export interface BookingActionSuccess {
  success: true;
  eventId: string;
}

export interface BookingActionFailure {
  success: false;
  error: string;
  fieldErrors?: Record<string, string>;
}

export type BookingActionResult = BookingActionSuccess | BookingActionFailure;

interface BookingAnswerWithLabel {
  questionId: string;
  questionLabel: string;
  answer: string;
}

const IDEMPOTENCY_TTL_SECONDS = 30 * 60;
const CALENDAR_LOCK_TTL_SECONDS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export async function createBooking(
  input: BookingRequestInput,
): Promise<BookingActionResult> {
  try {
    const settings = await loaders.getBookingSettings();

    if (settings === null) {
      return {
        success: false,
        error: "Booking is not configured yet. Please try again later.",
      };
    }

    const paidContextResolution = await resolvePaidTrainingBookingContext(
      input,
      findPendingTrainingEnrollmentByToken,
    );

    if (!paidContextResolution.ok) {
      return {
        success: false,
        error: paidContextResolution.error,
        fieldErrors: paidContextResolution.fieldErrors,
      };
    }

    const validation = validateBookingRequest(
      paidContextResolution.input,
      settings,
    );

    if (!validation.success) {
      return {
        success: false,
        error: "Please fix the booking details and try again.",
        fieldErrors: validation.fieldErrors,
      };
    }

    const lockId = nanoid();
    const lockAcquired = await acquireCalendarLock(
      lockId,
      CALENDAR_LOCK_TTL_SECONDS,
    );

    if (!lockAcquired) {
      return {
        success: false,
        error: "Booking is busy right now. Please try again in a moment.",
      };
    }

    try {
      const idempotencyClaimed = await claimIdempotencyKey(
        validation.data.idempotencyKey,
        IDEMPOTENCY_TTL_SECONDS,
      );

      if (!idempotencyClaimed) {
        return {
          success: false,
          error: "This booking request is already being processed.",
        };
      }

      const now = new Date();
      const horizonEnd = new Date(
        now.getTime() + settings.bookingHorizonDays * DAY_MS,
      );
      const selectedStart = new Date(validation.data.start);
      const selectedEnd = new Date(
        selectedStart.getTime() +
          validation.bookingTypeConfig.durationMinutes * MINUTE_MS,
      );
      const calendarEvents = await listCalendarEvents({
        calendarId: settings.calendarId,
        timeMin: now,
        timeMax: horizonEnd,
      });
      const { availabilityWindows, busyEvents } = partitionCalendarEvents(
        calendarEvents,
        settings.availabilityMarkerTitle,
      );

      if (
        !isSlotAvailable({
          bookingType: validation.bookingTypeConfig,
          requestedStart: selectedStart,
          availabilityWindows,
          busyEvents,
          now,
          minimumLeadTimeHours: settings.minimumLeadTimeHours,
          horizonEnd,
        })
      ) {
        return {
          success: false,
          error: "That time is no longer available. Please choose another slot.",
          fieldErrors: {
            start: "That time is no longer available",
          },
        };
      }

      const answers = buildAnswersWithLabels(
        validation.bookingTypeConfig,
        validation.data.answers,
      );
      const eventId = await insertGoogleCalendarBooking({
        input: validation.data,
        bookingTypeConfig: validation.bookingTypeConfig,
        answers,
        selectedStart,
        selectedEnd,
        timezone: settings.timezone,
        calendarId: settings.calendarId,
        paidTrainingContext: paidContextResolution.context ?? undefined,
      });

      if (paidContextResolution.context !== null) {
        await markTrainingEnrollmentScheduled({
          enrollmentId: paidContextResolution.context.enrollmentId,
          scheduledAt: selectedStart,
        });
      }

      if (validation.data.marketingOptIn) {
        try {
          await createMarketingOptIn({
            input: validation.data,
            answers,
          });
        } catch (error) {
          console.error(
            "[createBooking] Marketing opt-in write failed:",
            getErrorMessage(error),
          );
        }
      }

      try {
        await sendBookingConfirmationEmail({
          name: validation.data.name,
          email: validation.data.email,
          bookingTypeLabel: validation.bookingTypeConfig.label,
          start: selectedStart,
          timezone: settings.timezone,
        });
      } catch (error) {
        console.error(
          "[createBooking] Confirmation email failed:",
          getErrorMessage(error),
        );
      }

      return { success: true, eventId };
    } finally {
      try {
        await releaseCalendarLock(lockId);
      } catch (error) {
        console.error(
          "[createBooking] Calendar lock release failed:",
          getErrorMessage(error),
        );
      }
    }
  } catch (error) {
    console.error("[createBooking] Booking failed:", getErrorMessage(error));

    return {
      success: false,
      error: "Something went wrong while creating your booking. Please try again.",
    };
  }
}

function partitionCalendarEvents(
  events: CalendarEventWindow[],
  availabilityMarkerTitle: string,
): {
  availabilityWindows: CalendarEventWindow[];
  busyEvents: CalendarEventWindow[];
} {
  const trimmedMarkerTitle = availabilityMarkerTitle.trim();
  const availabilityWindows: CalendarEventWindow[] = [];
  const busyEvents: CalendarEventWindow[] = [];

  for (const event of events) {
    if (event.title.trim() === trimmedMarkerTitle) {
      availabilityWindows.push(event);
      continue;
    }

    busyEvents.push(event);
  }

  return { availabilityWindows, busyEvents };
}

function buildAnswersWithLabels(
  bookingTypeConfig: BookingTypeConfig,
  answers: BookingAnswerInput[],
): BookingAnswerWithLabel[] {
  const questionsById = new Map(
    bookingTypeConfig.questions.map((question) => [question.id, question.label]),
  );
  const answersWithLabels: BookingAnswerWithLabel[] = [];

  for (const answer of answers) {
    const trimmedAnswer = answer.answer.trim();
    const questionLabel = questionsById.get(answer.questionId);

    if (questionLabel === undefined || trimmedAnswer.length === 0) {
      continue;
    }

    answersWithLabels.push({
      questionId: answer.questionId,
      questionLabel,
      answer: trimmedAnswer,
    });
  }

  return answersWithLabels;
}

async function insertGoogleCalendarBooking(input: {
  input: BookingRequestInput;
  bookingTypeConfig: BookingTypeConfig;
  answers: BookingAnswerWithLabel[];
  selectedStart: Date;
  selectedEnd: Date;
  timezone: string;
  calendarId: string;
  paidTrainingContext?: PaidTrainingBookingContext;
}): Promise<string> {
  const event = buildBookingEventPayload({
    bookingTypeLabel: input.bookingTypeConfig.label,
    customer: {
      name: input.input.name,
      email: input.input.email,
      phone: input.input.phone,
    },
    answers: input.answers.map((answer) => ({
      questionLabel: answer.questionLabel,
      answer: answer.answer,
    })),
    start: input.selectedStart,
    end: input.selectedEnd,
    timezone: input.timezone,
    paidTrainingContext: input.paidTrainingContext,
  });

  return insertBookingEvent({
    calendarId: input.calendarId,
    event,
  });
}

async function createMarketingOptIn(input: {
  input: BookingRequestInput;
  answers: BookingAnswerWithLabel[];
}): Promise<void> {
  await formClient.create({
    _type: "bookingMarketingOptIn",
    name: input.input.name,
    email: input.input.email,
    phone: input.input.phone,
    bookingType: input.input.bookingType,
    answers: input.answers.map((answer) => ({
      _type: "bookingAnswer",
      questionId: answer.questionId,
      questionLabel: answer.questionLabel,
      answer: answer.answer,
    })),
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
