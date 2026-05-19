export type BookingType = "training-call" | "in-person-appointment";

export type BookingQuestionInputType = "text" | "textarea" | "select";

export interface BookingQuestion {
  _key?: string;
  id: string;
  label: string;
  inputType: BookingQuestionInputType;
  required: boolean;
  options?: string[];
}

export interface BookingTypeConfig {
  _key?: string;
  type: BookingType;
  label: string;
  description: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  questions: BookingQuestion[];
}

export interface BookingSettings {
  calendarId: string;
  availabilityMarkerTitle: string;
  bookingHorizonDays: number;
  minimumLeadTimeHours: number;
  timezone: string;
  bookingTypes: BookingTypeConfig[];
  marketingOptInLabel: string;
}

export interface CalendarEventWindow {
  id: string;
  title: string;
  start: Date;
  end: Date;
}

export interface BookingSlot {
  start: string;
  end: string;
}

export interface BookingAnswerInput {
  questionId: string;
  answer: string;
}

export interface BookingRequestInput {
  bookingType: BookingType;
  start: string;
  name: string;
  email: string;
  phone: string;
  answers: BookingAnswerInput[];
  marketingOptIn: boolean;
  marketingConsentText?: string;
  sourcePath?: string;
  idempotencyKey: string;
  paidTrainingOrderId?: string;
  offeringSlug?: string;
}

export interface PaidTrainingBookingContext {
  enrollmentId: string;
  programTitle: string;
  publicOrderId: string;
}
