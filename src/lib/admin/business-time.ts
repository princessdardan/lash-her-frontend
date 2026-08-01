import { localDateTimeToUtc } from "./local-time";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface BusinessDateRange {
  endExclusive: Date;
  from: string;
  start: Date;
  to: string;
}

export function getBusinessTodayRange(
  now: Date,
  timezone: string,
): BusinessDateRange {
  const today = formatDateInTimezone(now, timezone);
  return getBusinessDateRange(today, today, timezone);
}

export function getBusinessRollingDateRange(
  now: Date,
  timezone: string,
  calendarDays: number,
): BusinessDateRange {
  if (!Number.isSafeInteger(calendarDays) || calendarDays < 1) {
    throw new Error("Reporting days must be a positive whole number");
  }

  const to = formatDateInTimezone(now, timezone);
  const from = addCalendarDays(to, -(calendarDays - 1));
  return getBusinessDateRange(from, to, timezone);
}

export function getBusinessDateRange(
  from: string,
  to: string,
  timezone: string,
): BusinessDateRange {
  assertDate(from);
  assertDate(to);
  if (from > to) {
    throw new Error("The start date must not be after the end date");
  }

  return {
    endExclusive: localDateTimeToUtc(
      `${addCalendarDays(to, 1)}T00:00`,
      timezone,
    ),
    from,
    start: localDateTimeToUtc(`${from}T00:00`, timezone),
    to,
  };
}

export function addCalendarDays(value: string, days: number): string {
  assertDate(value);
  if (!Number.isSafeInteger(days)) {
    throw new Error("Calendar day adjustment must be a whole number");
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

export function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function assertDate(value: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new Error("A valid calendar date is required");
  }

  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error("A valid calendar date is required");
  }
}
