export interface ShippingCalendarSettings {
  timezone: string;
  orderCutoff: string;
  coverageStartsAt: string;
  coverageEndsAt: string;
  beforeCutoffHandoffBusinessDays: number;
  afterCutoffHandoffBusinessDays: number;
  autoRefundBusinessDays: number;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function computeShippingDeadlines(input: {
  clearedAt: Date;
  settings: ShippingCalendarSettings;
  closedDates: ReadonlySet<string>;
}): { handoffDeadlineAt: Date; autoRefundDeadlineAt: Date } {
  const parts = zonedParts(input.clearedAt, input.settings.timezone);
  const localDate = toDateKey(parts);
  const paidOnBusinessDay = isBusinessDate(localDate, input.closedDates);
  const beforeCutoff =
    paidOnBusinessDay &&
    minutes(parts.hour, parts.minute) < parseTime(input.settings.orderCutoff);
  const businessDays = beforeCutoff
    ? input.settings.beforeCutoffHandoffBusinessDays
    : input.settings.afterCutoffHandoffBusinessDays;
  const handoffDate = addBusinessDays(
    localDate,
    businessDays,
    input.closedDates,
  );
  const handoffDeadlineAt = localDateTimeToInstant(
    handoffDate,
    input.settings.coverageEndsAt,
    input.settings.timezone,
  );
  const autoRefundDate = addBusinessDays(
    handoffDate,
    input.settings.autoRefundBusinessDays,
    input.closedDates,
  );
  return {
    handoffDeadlineAt,
    autoRefundDeadlineAt: localDateTimeToInstant(
      autoRefundDate,
      input.settings.coverageEndsAt,
      input.settings.timezone,
    ),
  };
}

export function addCoverageHours(input: {
  from: Date;
  coverageHours: number;
  settings: Pick<
    ShippingCalendarSettings,
    "timezone" | "coverageStartsAt" | "coverageEndsAt"
  >;
  closedDates: ReadonlySet<string>;
}): Date {
  let remainingMinutes = Math.max(0, input.coverageHours * 60);
  let dateKey = toDateKey(zonedParts(input.from, input.settings.timezone));
  let cursor = new Date(input.from);
  while (remainingMinutes > 0) {
    if (!isBusinessDate(dateKey, input.closedDates)) {
      dateKey = addCalendarDays(dateKey, 1);
      cursor = localDateTimeToInstant(
        dateKey,
        input.settings.coverageStartsAt,
        input.settings.timezone,
      );
      continue;
    }
    const start = localDateTimeToInstant(
      dateKey,
      input.settings.coverageStartsAt,
      input.settings.timezone,
    );
    const end = localDateTimeToInstant(
      dateKey,
      input.settings.coverageEndsAt,
      input.settings.timezone,
    );
    if (cursor < start) cursor = start;
    if (cursor >= end) {
      dateKey = addCalendarDays(dateKey, 1);
      continue;
    }
    const available = Math.floor((end.getTime() - cursor.getTime()) / 60_000);
    if (remainingMinutes <= available)
      return new Date(cursor.getTime() + remainingMinutes * 60_000);
    remainingMinutes -= available;
    dateKey = addCalendarDays(dateKey, 1);
    cursor = localDateTimeToInstant(
      dateKey,
      input.settings.coverageStartsAt,
      input.settings.timezone,
    );
  }
  return cursor;
}

export function addBusinessDays(
  dateKey: string,
  count: number,
  closedDates: ReadonlySet<string>,
): string {
  let current = dateKey;
  let remaining = Math.max(0, count);
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (isBusinessDate(current, closedDates)) remaining -= 1;
  }
  return current;
}

export function isBusinessDate(
  dateKey: string,
  closedDates: ReadonlySet<string>,
): boolean {
  if (closedDates.has(dateKey)) return false;
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

export function localDateTimeToInstant(
  dateKey: string,
  timeValue: string,
  timezone: string,
): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute, second = 0] = timeValue.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    guess += target - represented;
  }
  return new Date(guess);
}

function zonedParts(value: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

function toDateKey(parts: ZonedParts): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function addCalendarDays(dateKey: string, count: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function parseTime(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return minutes(hour, minute);
}

function minutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}
