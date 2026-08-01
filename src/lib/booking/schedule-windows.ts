import type {
  BookingSettings,
  BookingWeekday,
  CalendarEventWindow,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ResourceIsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ResourceRecurringAvailabilityWindow {
  /** ISO weekday: Monday = 1, Sunday = 7. */
  isoWeekday: ResourceIsoWeekday;
  startsAt: string;
  endsAt: string;
  /** Inclusive local calendar date in YYYY-MM-DD format. */
  effectiveFrom?: string;
  /** Inclusive local calendar date in YYYY-MM-DD format. */
  effectiveUntil?: string;
}

export interface ResourceAvailabilityException {
  /** Unavailable exceptions take precedence over all available windows. */
  kind: "available" | "unavailable";
  /** Absolute instant, not a resource-local wall time. */
  start: Date;
  /** Absolute instant, not a resource-local wall time. */
  end: Date;
}

export interface BuildResourceAvailabilityWindowsInput {
  exceptions?: ResourceAvailabilityException[];
  horizonEnd: Date;
  now: Date;
  recurringWindows: ResourceRecurringAvailabilityWindow[];
  timezone: string;
}

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

interface NormalizedRecurringWindow {
  effectiveFrom?: string;
  effectiveUntil?: string;
  endsAt: { hour: number; minute: number };
  isoWeekday: ResourceIsoWeekday;
  startsAt: { hour: number; minute: number };
}

interface TimeInterval {
  endMs: number;
  startMs: number;
}

const ISO_WEEKDAY_BY_BOOKING_WEEKDAY: Record<
  BookingWeekday,
  ResourceIsoWeekday
> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const BOOKING_WEEKDAY_BY_ISO: Record<ResourceIsoWeekday, BookingWeekday> = {
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
  7: "sunday",
};

/**
 * Builds resource availability from recurring local-time windows and absolute
 * exceptions.
 *
 * DST handling is deliberately conservative:
 * - A nonexistent local boundary produces no window for that occurrence.
 * - For a repeated local time, an opening boundary uses the later instant and
 *   a closing boundary uses the earlier instant. If that makes the interval
 *   empty, the occurrence is omitted. This prevents a DST fold from silently
 *   expanding bookable time.
 *
 * Available exceptions are unioned with recurring availability first. All
 * unavailable exceptions are then subtracted, so an explicit closure always
 * wins. Results are clipped to [now, horizonEnd], merged, and sorted.
 */
export function buildResourceAvailabilityWindows(
  input: BuildResourceAvailabilityWindowsInput,
): CalendarEventWindow[] {
  if (
    !isValidDate(input.now) ||
    !isValidDate(input.horizonEnd) ||
    input.horizonEnd.getTime() <= input.now.getTime()
  ) {
    return [];
  }

  const formatter = createTimeZoneFormatter(input.timezone);
  if (formatter === null) {
    return [];
  }

  const recurringWindows = input.recurringWindows
    .map(normalizeRecurringWindow)
    .filter(
      (window): window is NormalizedRecurringWindow => window !== null,
    );
  const recurringIntervals = buildRecurringIntervals({
    formatter,
    horizonEnd: input.horizonEnd,
    now: input.now,
    recurringWindows,
  });
  const exceptionIntervals = (input.exceptions ?? [])
    .map(toExceptionInterval)
    .filter(
      (
        exception,
      ): exception is TimeInterval & {
        kind: ResourceAvailabilityException["kind"];
      } => exception !== null,
    );
  const availableExceptions = exceptionIntervals
    .filter((exception) => exception.kind === "available")
    .map(({ startMs, endMs }) => ({ startMs, endMs }));
  const unavailableExceptions = exceptionIntervals
    .filter((exception) => exception.kind === "unavailable")
    .map(({ startMs, endMs }) => ({ startMs, endMs }));
  const available = mergeIntervals(
    clipIntervals(
      [...recurringIntervals, ...availableExceptions],
      input.now.getTime(),
      input.horizonEnd.getTime(),
    ),
  );
  const unavailable = mergeIntervals(
    clipIntervals(
      unavailableExceptions,
      input.now.getTime(),
      input.horizonEnd.getTime(),
    ),
  );

  return subtractIntervals(available, unavailable).map((interval) => {
    const start = new Date(interval.startMs);
    const end = new Date(interval.endMs);

    return {
      id: `resource-availability:${start.toISOString()}:${end.toISOString()}`,
      title: "Open for booking",
      start,
      end,
    };
  });
}

/**
 * V1 compatibility wrapper for the global Sanity booking-hours shape.
 */
export function buildAvailabilityWindowsFromHours(input: {
  horizonEnd: Date;
  now: Date;
  settings: Pick<BookingSettings, "hoursOfOperation" | "timezone">;
}): CalendarEventWindow[] {
  const firstWindowByDay = new Map<
    BookingWeekday,
    BookingSettings["hoursOfOperation"][number]
  >();

  for (const hours of input.settings.hoursOfOperation) {
    if (!firstWindowByDay.has(hours.day)) {
      firstWindowByDay.set(hours.day, hours);
    }
  }

  const recurringWindows: ResourceRecurringAvailabilityWindow[] = [];
  for (const [day, hours] of firstWindowByDay) {
    if (!hours.isOpen) {
      continue;
    }

    recurringWindows.push({
      endsAt: hours.closesAt,
      isoWeekday: ISO_WEEKDAY_BY_BOOKING_WEEKDAY[day],
      startsAt: hours.opensAt,
    });
  }

  const windows = buildResourceAvailabilityWindows({
    horizonEnd: input.horizonEnd,
    now: input.now,
    recurringWindows,
    timezone: input.settings.timezone,
  });
  const formatter = createTimeZoneFormatter(input.settings.timezone);

  if (formatter === null) {
    return [];
  }

  return windows.map((window) => {
    const localDate = getTimeZoneDateParts(window.start, formatter);
    const isoWeekday = getIsoWeekday(localDate);

    return {
      ...window,
      id: `${BOOKING_WEEKDAY_BY_ISO[isoWeekday]}-${localDate.year}-${localDate.month}-${localDate.day}`,
    };
  });
}

function buildRecurringIntervals(input: {
  formatter: Intl.DateTimeFormat;
  horizonEnd: Date;
  now: Date;
  recurringWindows: NormalizedRecurringWindow[];
}): TimeInterval[] {
  if (input.recurringWindows.length === 0) {
    return [];
  }

  const firstLocalDate = getTimeZoneDateParts(input.now, input.formatter);
  const lastLocalDate = getTimeZoneDateParts(
    input.horizonEnd,
    input.formatter,
  );
  const firstOrdinal = toLocalDateOrdinal(firstLocalDate);
  const lastOrdinal = toLocalDateOrdinal(lastLocalDate);
  const intervals: TimeInterval[] = [];

  for (
    let dateOrdinal = firstOrdinal;
    dateOrdinal <= lastOrdinal;
    dateOrdinal += DAY_MS
  ) {
    const date = fromLocalDateOrdinal(dateOrdinal);
    const isoWeekday = getIsoWeekday(date);
    const dateKey = toIsoDate(date);

    for (const recurringWindow of input.recurringWindows) {
      if (
        recurringWindow.isoWeekday !== isoWeekday ||
        (recurringWindow.effectiveFrom !== undefined &&
          dateKey < recurringWindow.effectiveFrom) ||
        (recurringWindow.effectiveUntil !== undefined &&
          dateKey > recurringWindow.effectiveUntil)
      ) {
        continue;
      }

      const startMs = resolveLocalBoundary(
        {
          ...date,
          ...recurringWindow.startsAt,
          second: 0,
        },
        input.formatter,
        "opening",
      );
      const endMs = resolveLocalBoundary(
        {
          ...date,
          ...recurringWindow.endsAt,
          second: 0,
        },
        input.formatter,
        "closing",
      );

      if (startMs === null || endMs === null || endMs <= startMs) {
        continue;
      }

      intervals.push({ startMs, endMs });
    }
  }

  return intervals;
}

function normalizeRecurringWindow(
  window: ResourceRecurringAvailabilityWindow,
): NormalizedRecurringWindow | null {
  if (
    !Number.isInteger(window.isoWeekday) ||
    window.isoWeekday < 1 ||
    window.isoWeekday > 7
  ) {
    return null;
  }

  const startsAt = parseTime(window.startsAt);
  const endsAt = parseTime(window.endsAt);
  if (
    startsAt === null ||
    endsAt === null ||
    timeToMinutes(endsAt) <= timeToMinutes(startsAt)
  ) {
    // Overnight and zero-length recurring windows are not inferred. An admin
    // must split an overnight shift into explicit windows on adjacent dates.
    return null;
  }

  const effectiveFrom =
    window.effectiveFrom === undefined
      ? undefined
      : normalizeIsoDate(window.effectiveFrom);
  const effectiveUntil =
    window.effectiveUntil === undefined
      ? undefined
      : normalizeIsoDate(window.effectiveUntil);

  if (
    (window.effectiveFrom !== undefined && effectiveFrom === null) ||
    (window.effectiveUntil !== undefined && effectiveUntil === null) ||
    (effectiveFrom !== undefined &&
      effectiveFrom !== null &&
      effectiveUntil !== undefined &&
      effectiveUntil !== null &&
      effectiveFrom > effectiveUntil)
  ) {
    return null;
  }

  return {
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(effectiveUntil ? { effectiveUntil } : {}),
    endsAt,
    isoWeekday: window.isoWeekday,
    startsAt,
  };
}

function toExceptionInterval(
  exception: ResourceAvailabilityException,
): (TimeInterval & { kind: ResourceAvailabilityException["kind"] }) | null {
  if (
    (exception.kind !== "available" && exception.kind !== "unavailable") ||
    !isValidDate(exception.start) ||
    !isValidDate(exception.end) ||
    exception.end.getTime() <= exception.start.getTime()
  ) {
    return null;
  }

  return {
    endMs: exception.end.getTime(),
    kind: exception.kind,
    startMs: exception.start.getTime(),
  };
}

function clipIntervals(
  intervals: TimeInterval[],
  minimumMs: number,
  maximumMs: number,
): TimeInterval[] {
  return intervals.flatMap((interval) => {
    const startMs = Math.max(interval.startMs, minimumMs);
    const endMs = Math.min(interval.endMs, maximumMs);

    return endMs > startMs ? [{ startMs, endMs }] : [];
  });
}

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const sorted = [...intervals].sort(compareIntervals);
  const merged: TimeInterval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];

    if (last === undefined || interval.startMs > last.endMs) {
      merged.push({ ...interval });
      continue;
    }

    last.endMs = Math.max(last.endMs, interval.endMs);
  }

  return merged;
}

function subtractIntervals(
  available: TimeInterval[],
  unavailable: TimeInterval[],
): TimeInterval[] {
  const result: TimeInterval[] = [];

  for (const window of available) {
    let cursorMs = window.startMs;

    for (const closure of unavailable) {
      if (closure.endMs <= cursorMs) {
        continue;
      }

      if (closure.startMs >= window.endMs) {
        break;
      }

      if (closure.startMs > cursorMs) {
        result.push({
          startMs: cursorMs,
          endMs: Math.min(closure.startMs, window.endMs),
        });
      }

      cursorMs = Math.max(cursorMs, closure.endMs);
      if (cursorMs >= window.endMs) {
        break;
      }
    }

    if (cursorMs < window.endMs) {
      result.push({ startMs: cursorMs, endMs: window.endMs });
    }
  }

  return result;
}

function compareIntervals(first: TimeInterval, second: TimeInterval): number {
  return first.startMs - second.startMs || first.endMs - second.endMs;
}

function resolveLocalBoundary(
  localDateTime: LocalDateTime,
  formatter: Intl.DateTimeFormat,
  boundary: "opening" | "closing",
): number | null {
  const wallTimeMs = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
  );
  const offsets = new Set<number>();

  // Sample both sides of any nearby offset transition, then verify candidate
  // instants by formatting them back to the requested wall time.
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(
      getTimeZoneOffsetMs(
        new Date(wallTimeMs + hours * HOUR_MS),
        formatter,
      ),
    );
  }

  const candidates = [...offsets]
    .map((offset) => wallTimeMs - offset)
    .filter((candidateMs) =>
      localDateTimesEqual(
        getTimeZoneDateTimeParts(new Date(candidateMs), formatter),
        localDateTime,
      ),
    )
    .sort((first, second) => first - second);

  if (candidates.length === 0) {
    return null;
  }

  return boundary === "opening"
    ? candidates[candidates.length - 1] ?? null
    : candidates[0] ?? null;
}

function createTimeZoneFormatter(timezone: string): Intl.DateTimeFormat | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });

    // Force invalid IANA timezone errors to surface here consistently.
    formatter.formatToParts(new Date(0));
    return formatter;
  } catch {
    return null;
  }
}

function getTimeZoneDateParts(
  date: Date,
  formatter: Intl.DateTimeFormat,
): LocalDate {
  const parts = getTimeZoneDateTimeParts(date, formatter);

  return { day: parts.day, month: parts.month, year: parts.year };
}

function getTimeZoneDateTimeParts(
  date: Date,
  formatter: Intl.DateTimeFormat,
): LocalDateTime {
  const parts = formatter.formatToParts(date);

  return {
    day: readPart(parts, "day"),
    hour: readPart(parts, "hour"),
    minute: readPart(parts, "minute"),
    month: readPart(parts, "month"),
    second: readPart(parts, "second"),
    year: readPart(parts, "year"),
  };
}

function getTimeZoneOffsetMs(
  date: Date,
  formatter: Intl.DateTimeFormat,
): number {
  const parts = getTimeZoneDateTimeParts(date, formatter);
  const localAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return localAsUtcMs - date.getTime();
}

function localDateTimesEqual(
  first: LocalDateTime,
  second: LocalDateTime,
): boolean {
  return (
    first.year === second.year &&
    first.month === second.month &&
    first.day === second.day &&
    first.hour === second.hour &&
    first.minute === second.minute &&
    first.second === second.second
  );
}

function parseTime(
  value: string,
): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(value.trim());

  return match
    ? { hour: Number(match[1]), minute: Number(match[2]) }
    : null;
}

function timeToMinutes(value: { hour: number; minute: number }): number {
  return value.hour * 60 + value.minute;
}

function normalizeIsoDate(value: string): string | null {
  const match = ISO_DATE_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }

  const date: LocalDate = {
    day: Number(match[3]),
    month: Number(match[2]),
    year: Number(match[1]),
  };
  const roundTrip = fromLocalDateOrdinal(toLocalDateOrdinal(date));

  return localDatesEqual(date, roundTrip) ? toIsoDate(date) : null;
}

function toLocalDateOrdinal(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function fromLocalDateOrdinal(ordinal: number): LocalDate {
  const date = new Date(ordinal);

  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

function getIsoWeekday(date: LocalDate): ResourceIsoWeekday {
  const utcWeekday = new Date(toLocalDateOrdinal(date)).getUTCDay();
  return (utcWeekday === 0 ? 7 : utcWeekday) as ResourceIsoWeekday;
}

function toIsoDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function localDatesEqual(first: LocalDate, second: LocalDate): boolean {
  return (
    first.year === second.year &&
    first.month === second.month &&
    first.day === second.day
  );
}

function readPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const value = parts.find((part) => part.type === type)?.value;
  return value === undefined ? Number.NaN : Number(value);
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
