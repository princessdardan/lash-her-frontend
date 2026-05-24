import type { BookingSettings, BookingWeekday, CalendarEventWindow } from "./types";

const WEEKDAYS: BookingWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function buildAvailabilityWindowsFromHours(input: {
  horizonEnd: Date;
  now: Date;
  settings: Pick<BookingSettings, "hoursOfOperation" | "timezone">;
}): CalendarEventWindow[] {
  const startParts = getTimeZoneDateParts(input.now, input.settings.timezone);
  const windows: CalendarEventWindow[] = [];

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const localDate = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day + dayOffset));
    const year = localDate.getUTCFullYear();
    const month = localDate.getUTCMonth() + 1;
    const day = localDate.getUTCDate();
    const weekday = WEEKDAYS[localDate.getUTCDay()];
    const hours = input.settings.hoursOfOperation.find((item) => item.day === weekday);

    if (!hours) {
      continue;
    }

    const opensAt = parseTime(hours.opensAt);
    const closesAt = parseTime(hours.closesAt);

    if (!hours.isOpen || opensAt === null || closesAt === null || timeToMinutes(closesAt) <= timeToMinutes(opensAt)) {
      continue;
    }

    const start = localTimeToDate({ ...opensAt, day, month, timeZone: input.settings.timezone, year });
    const end = localTimeToDate({ ...closesAt, day, month, timeZone: input.settings.timezone, year });

    if (start >= input.horizonEnd) {
      break;
    }

    if (end <= input.now) {
      continue;
    }

    windows.push({
      id: `${weekday}-${year}-${month}-${day}`,
      title: "Open for booking",
      start: start < input.now ? input.now : start,
      end: end > input.horizonEnd ? input.horizonEnd : end,
    });
  }

  return windows;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function timeToMinutes(value: { hour: number; minute: number }): number {
  return value.hour * 60 + value.minute;
}

function getTimeZoneDateParts(date: Date, timeZone: string): { day: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);

  return {
    day: readPart(parts, "day"),
    month: readPart(parts, "month"),
    year: readPart(parts, "year"),
  };
}

function localTimeToDate(input: {
  day: number;
  hour: number;
  minute: number;
  month: number;
  timeZone: string;
  year: number;
}): Date {
  const wallTimeMs = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  let utcMs = wallTimeMs;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    utcMs = wallTimeMs - getTimeZoneOffsetMs(new Date(utcMs), input.timeZone);
  }

  return new Date(utcMs);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);

  const localAsUtcMs = Date.UTC(
    readPart(parts, "year"),
    readPart(parts, "month") - 1,
    readPart(parts, "day"),
    readPart(parts, "hour"),
    readPart(parts, "minute"),
    readPart(parts, "second"),
  );

  return localAsUtcMs - date.getTime();
}

function readPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  return value === undefined ? 0 : Number(value);
}
