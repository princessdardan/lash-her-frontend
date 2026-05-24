export type BookingType = "in-person-appointment";

export type BookingQuestionInputType = "text" | "textarea" | "select";

export interface BookingQuestion {
  _key?: string;
  id: string;
  label: string;
  inputType: BookingQuestionInputType;
  required: boolean;
  options?: string[];
}

export type BookingWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface BookingHoursWindow {
  _key?: string;
  day: BookingWeekday;
  isOpen: boolean;
  opensAt: string;
  closesAt: string;
}

export interface BookingTypeConfig {
  _key?: string;
  type: BookingType;
  label: string;
  description: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  bufferMinutes: number;
  questions: BookingQuestion[];
}

export interface BookingSettings {
  calendarId: string;
  bookingHorizonDays: number;
  minimumLeadTimeHours: number;
  timezone: string;
  bufferMinutes: number;
  slotIntervalMinutes: number;
  hoursOfOperation: BookingHoursWindow[];
  intakeQuestions: BookingQuestion[];
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
  serviceSlug?: string;
}
