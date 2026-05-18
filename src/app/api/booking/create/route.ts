import type {
  BookingAnswerInput,
  BookingRequestInput,
  BookingType,
} from "@/lib/booking/types";

const BOOKING_TYPES: readonly BookingType[] = [
  "training-call",
  "in-person-appointment",
];

interface BookingActionSuccess {
  success: true;
  eventId: string;
}

interface BookingActionFailure {
  success: false;
  error: string;
  fieldErrors?: Record<string, string>;
}

type BookingActionResult = BookingActionSuccess | BookingActionFailure;

export interface BookingCreatePostHandlerDependencies {
  createBooking: (input: BookingRequestInput) => Promise<BookingActionResult>;
}

export function createBookingCreatePostHandler(
  dependencies: BookingCreatePostHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async function bookingCreatePostHandler(
    req: Request,
  ): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch (error) {
      console.warn("[booking create] Invalid JSON:", getErrorMessage(error));

      return Response.json(
        { success: false, error: "Invalid booking request" },
        { status: 400 },
      );
    }

    const input = toBookingRequestInput(body);
    const result = await dependencies.createBooking(input);

    if (!result.success) {
      return Response.json(result, {
        status: result.fieldErrors === undefined ? 409 : 400,
      });
    }

    return Response.json(result);
  };
}

export const POST = createBookingCreatePostHandler({
  createBooking: async (input) => {
    const { createBooking } = await import("@/lib/booking/booking-service");

    return createBooking(input);
  },
});

function toBookingRequestInput(input: unknown): BookingRequestInput {
  const record = isRecord(input) ? input : {};

  const marketingConsentText = toOptionalStringValue(record.marketingConsentText);
  const sourcePath = toOptionalStringValue(record.sourcePath);

  return {
    bookingType: toBookingType(record.bookingType),
    start: toStringValue(record.start),
    name: toStringValue(record.name),
    email: toStringValue(record.email),
    phone: toStringValue(record.phone),
    answers: toBookingAnswers(record.answers),
    marketingOptIn: record.marketingOptIn === true,
    idempotencyKey: toStringValue(record.idempotencyKey),
    ...(marketingConsentText ? { marketingConsentText } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    paidSchedulingToken: toOptionalStringValue(record.paidSchedulingToken),
  };
}

function toBookingType(value: unknown): BookingType {
  if (typeof value !== "string") {
    return "" as BookingType;
  }

  if (BOOKING_TYPES.includes(value as BookingType)) {
    return value as BookingType;
  }

  return value as BookingType;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
