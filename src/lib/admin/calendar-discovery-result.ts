export type CalendarDiscoveryResult<T> =
  | { calendars: T[]; kind: "ready" }
  | { kind: "error" };

export async function loadCalendarDiscoveryResult<T>(
  load: () => Promise<T[]>,
): Promise<CalendarDiscoveryResult<T>> {
  try {
    return { calendars: await load(), kind: "ready" };
  } catch {
    return { kind: "error" };
  }
}
