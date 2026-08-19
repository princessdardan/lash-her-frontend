export interface ShippingCalendarClosure {
  date: string;
  kind: string;
  label: string;
}

export function calendarCoverageComplete(
  calendar: {
    coverageStartsOn: string;
    coverageEndsOn: string;
    closureDates: ShippingCalendarClosure[];
  },
  now: Date,
): boolean {
  const startsOn = now.toISOString().slice(0, 10);
  const requiredEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 21, now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
  if (
    calendar.coverageStartsOn > startsOn ||
    calendar.coverageEndsOn < requiredEnd ||
    !Array.isArray(calendar.closureDates)
  )
    return false;

  const configuredOntario = new Set<string>();
  const identities = new Set<string>();
  for (const entry of calendar.closureDates) {
    if (
      !entry ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
      !["ontario_holiday", "branch_closure"].includes(entry.kind) ||
      !entry.label?.trim() ||
      entry.date < calendar.coverageStartsOn ||
      entry.date > calendar.coverageEndsOn
    )
      return false;
    const identity = `${entry.kind}/${entry.date}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (entry.kind === "ontario_holiday") configuredOntario.add(entry.date);
  }

  for (
    let year = Number(calendar.coverageStartsOn.slice(0, 4));
    year <= Number(calendar.coverageEndsOn.slice(0, 4));
    year += 1
  ) {
    for (const holiday of expectedOntarioClosureDates(year)) {
      if (
        holiday >= calendar.coverageStartsOn &&
        holiday <= calendar.coverageEndsOn &&
        !configuredOntario.has(holiday)
      )
        return false;
    }
  }
  return true;
}

export function expectedOntarioClosureDates(year: number): Set<string> {
  const dates = new Set<string>();
  addObservedFixedHoliday(dates, year, 0, 1);
  dates.add(nthWeekday(year, 1, 1, 3));
  const easter = easterSunday(year);
  easter.setUTCDate(easter.getUTCDate() - 2);
  dates.add(dateKey(easter));
  dates.add(lastWeekdayBefore(year, 4, 25, 1));
  addObservedFixedHoliday(dates, year, 6, 1);
  dates.add(nthWeekday(year, 8, 1, 1));
  dates.add(nthWeekday(year, 9, 1, 2));
  addChristmasAndBoxingDay(dates, year);
  return dates;
}

function addObservedFixedHoliday(
  dates: Set<string>,
  year: number,
  month: number,
  day: number,
): void {
  const value = new Date(Date.UTC(year, month, day));
  dates.add(dateKey(value));
  if (value.getUTCDay() === 6 || value.getUTCDay() === 0) {
    dates.add(nextUnusedWeekday(value, dates));
  }
}

function addChristmasAndBoxingDay(dates: Set<string>, year: number): void {
  const christmas = new Date(Date.UTC(year, 11, 25));
  const boxing = new Date(Date.UTC(year, 11, 26));
  dates.add(dateKey(christmas));
  dates.add(dateKey(boxing));
  if (christmas.getUTCDay() === 6 || christmas.getUTCDay() === 0)
    dates.add(nextUnusedWeekday(christmas, dates));
  if (boxing.getUTCDay() === 6 || boxing.getUTCDay() === 0)
    dates.add(nextUnusedWeekday(boxing, dates));
}

function nextUnusedWeekday(value: Date, used: ReadonlySet<string>): string {
  const candidate = new Date(value);
  do candidate.setUTCDate(candidate.getUTCDate() + 1);
  while (
    candidate.getUTCDay() === 0 ||
    candidate.getUTCDay() === 6 ||
    used.has(dateKey(candidate))
  );
  return dateKey(candidate);
}

function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  occurrence: number,
): string {
  const value = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - value.getUTCDay() + 7) % 7;
  value.setUTCDate(1 + offset + (occurrence - 1) * 7);
  return dateKey(value);
}

function lastWeekdayBefore(
  year: number,
  month: number,
  day: number,
  weekday: number,
): string {
  const value = new Date(Date.UTC(year, month, day - 1));
  while (value.getUTCDay() !== weekday)
    value.setUTCDate(value.getUTCDate() - 1);
  return dateKey(value);
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
