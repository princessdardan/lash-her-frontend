import type {
  BookingRequestInput,
  BookingSettings,
  BookingType,
  BookingTypeConfig,
} from "./types";

export interface BookingValidationSuccess {
  success: true;
  bookingTypeConfig: BookingTypeConfig;
  selectedStart: Date;
}

export interface BookingValidationFailure {
  success: false;
  fieldErrors: Record<string, string>;
}

export type BookingValidationResult =
  | BookingValidationSuccess
  | BookingValidationFailure;

const BOOKING_TYPES: readonly BookingType[] = [
  "training-call",
  "in-person-appointment",
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function findBookingTypeConfig(
  settings: BookingSettings,
  bookingType: BookingType,
): BookingTypeConfig {
  const config = settings.bookingTypes.find((item) => item.type === bookingType);

  if (config === undefined) {
    throw new Error(`Missing booking type config: ${bookingType}`);
  }

  return config;
}

export function validateBookingRequest(
  settings: BookingSettings,
  input: BookingRequestInput,
): BookingValidationResult {
  const fieldErrors: Record<string, string> = {};
  const bookingTypeConfig = validateBookingType(settings, input, fieldErrors);
  const selectedStart = validateStart(input.start, fieldErrors);

  requireText(input.name, "name", "Name is required", fieldErrors);
  requireText(input.phone, "phone", "Phone number is required", fieldErrors);
  requireText(
    input.idempotencyKey,
    "idempotencyKey",
    "Booking request key is required",
    fieldErrors,
  );
  validateEmail(input.email, fieldErrors);

  if (bookingTypeConfig !== null) {
    validateRequiredAnswers(bookingTypeConfig, input, fieldErrors);
  }

  if (Object.keys(fieldErrors).length > 0 || bookingTypeConfig === null || selectedStart === null) {
    return { success: false, fieldErrors };
  }

  return { success: true, bookingTypeConfig, selectedStart };
}

function validateBookingType(
  settings: BookingSettings,
  input: BookingRequestInput,
  fieldErrors: Record<string, string>,
): BookingTypeConfig | null {
  if (!isBookingType(input.bookingType)) {
    fieldErrors.bookingType = "Please select a valid booking type";
    return null;
  }

  try {
    return findBookingTypeConfig(settings, input.bookingType);
  } catch (error) {
    fieldErrors.bookingType = "Please select a valid booking type";
    return null;
  }
}

function isBookingType(value: string): value is BookingType {
  return BOOKING_TYPES.some((bookingType) => bookingType === value);
}

function requireText(
  value: string,
  field: string,
  message: string,
  fieldErrors: Record<string, string>,
): void {
  if (value.trim().length === 0) {
    fieldErrors[field] = message;
  }
}

function validateEmail(
  email: string,
  fieldErrors: Record<string, string>,
): void {
  if (email.trim().length === 0) {
    fieldErrors.email = "Email is required";
    return;
  }

  if (!EMAIL_PATTERN.test(email.trim())) {
    fieldErrors.email = "Please enter a valid email address";
  }
}

function validateStart(
  start: string,
  fieldErrors: Record<string, string>,
): Date | null {
  if (start.trim().length === 0) {
    fieldErrors.start = "Please select a booking time";
    return null;
  }

  const selectedStart = new Date(start);

  if (Number.isNaN(selectedStart.getTime())) {
    fieldErrors.start = "Please select a valid booking time";
    return null;
  }

  return selectedStart;
}

function validateRequiredAnswers(
  bookingTypeConfig: BookingTypeConfig,
  input: BookingRequestInput,
  fieldErrors: Record<string, string>,
): void {
  const answersByQuestionId = new Map(
    input.answers.map((answer) => [answer.questionId, answer.answer.trim()]),
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
}
