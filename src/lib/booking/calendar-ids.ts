import type { BookingSettings } from "./types";

export function parseBookingCalendarIds(
  settingsOrString: BookingSettings | string,
): string[] {
  const raw =
    typeof settingsOrString === "string"
      ? settingsOrString
      : settingsOrString.calendarId;

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}


