import "server-only";

import {
  listConnectionGoogleCalendars,
  type GoogleCalendarOption,
} from "@/lib/booking/google-calendar";

import { requirePermission } from "./auth";

export type AdminGoogleCalendarOption = GoogleCalendarOption;

export async function listConnectedGoogleCalendars(
  connectionId: string,
): Promise<AdminGoogleCalendarOption[]> {
  await requirePermission("calendar-connections:view");
  return listConnectionGoogleCalendars(connectionId);
}

export { canGoogleCalendarAcceptBookings } from "./calendar-capabilities";
