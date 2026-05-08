import { NextRequest, NextResponse } from "next/server";

import { createBooking } from "@/lib/booking/booking-service";
import type {
  BookingAnswerInput,
  BookingRequestInput,
  BookingType,
} from "@/lib/booking/types";

const BOOKING_TYPES: readonly BookingType[] = [
  "training-call",
  "in-person-appointment",
];

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await req.json();
  } catch (error) {
    console.warn("[booking create] Invalid JSON:", getErrorMessage(error));

    return NextResponse.json(
      { success: false, error: "Invalid booking request" },
      { status: 400 },
    );
  }

  const input = toBookingRequestInput(body);
  const result = await createBooking(input);

  if (!result.success) {
    return NextResponse.json(result, {
      status: result.fieldErrors === undefined ? 409 : 400,
    });
  }

  return NextResponse.json(result);
}

function toBookingRequestInput(input: unknown): BookingRequestInput {
  const record = isRecord(input) ? input : {};

  return {
    bookingType: toBookingType(record.bookingType),
    start: toStringValue(record.start),
    name: toStringValue(record.name),
    email: toStringValue(record.email),
    phone: toStringValue(record.phone),
    answers: toBookingAnswers(record.answers),
    marketingOptIn: record.marketingOptIn === true,
    idempotencyKey: toStringValue(record.idempotencyKey),
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
