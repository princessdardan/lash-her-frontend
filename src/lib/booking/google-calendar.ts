import "server-only";

import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

import { getBookingEnv } from "@/sanity/env";
import { BOOKING_EVENT_HOLD_PROPERTY } from "./google-calendar-event-payload";
import { getGoogleRefreshToken } from "./operational-store";
import type { CalendarEventWindow } from "./types";

export { buildBookingEventPayload } from "./google-calendar-event-payload";
export type { BookingEventPayloadInput } from "./google-calendar-event-payload";

interface CalendarEventWithWindow {
  id: string;
  title: string;
  start: Date;
  end: Date;
}

export function createOAuthClient(): InstanceType<typeof google.auth.OAuth2> {
  const env = getBookingEnv();

  return new google.auth.OAuth2(
    env.googleClientId,
    env.googleClientSecret,
    env.googleRedirectUri,
  );
}

export function getOAuthConsentUrl(state: string): string {
  const oauthClient = createOAuthClient();

  return oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state,
  });
}

export async function getAuthorizedCalendarClient(): Promise<calendar_v3.Calendar> {
  const refreshToken = await getGoogleRefreshToken();

  if (refreshToken === null) {
    throw new Error("Google Calendar is not connected");
  }

  const oauthClient = createOAuthClient();
  oauthClient.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: "v3", auth: oauthClient });
}

export async function listCalendarEvents(input: {
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
}): Promise<CalendarEventWindow[]> {
  const calendar = await getAuthorizedCalendarClient();
  const response = await calendar.events.list({
    calendarId: input.calendarId,
    timeMin: input.timeMin.toISOString(),
    timeMax: input.timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items ?? [])
    .map(toCalendarEventWindow)
    .filter((event): event is CalendarEventWithWindow => event !== null);
}

export async function findBookingEventForHold(input: {
  calendarId: string;
  hold: { id: string; selectedEnd: Date; selectedStart: Date };
}): Promise<string | null> {
  const calendar = await getAuthorizedCalendarClient();
  const response = await calendar.events.list({
    calendarId: input.calendarId,
    maxResults: 1,
    privateExtendedProperty: [toBookingHoldExtendedProperty(input.hold.id)],
    singleEvents: true,
    timeMax: input.hold.selectedEnd.toISOString(),
    timeMin: input.hold.selectedStart.toISOString(),
  });
  const event = response.data.items?.find((candidate) => (
    typeof candidate.id === "string" && candidate.id.length > 0
  ));

  return event?.id ?? null;
}

export async function insertBookingEvent(input: {
  calendarId: string;
  event: calendar_v3.Schema$Event;
}): Promise<string> {
  const calendar = await getAuthorizedCalendarClient();
  const response = await calendar.events.insert({
    calendarId: input.calendarId,
    requestBody: input.event,
    sendUpdates: "all",
  });

  if (typeof response.data.id !== "string" || response.data.id.length === 0) {
    throw new Error("Google Calendar did not return an event ID");
  }

  return response.data.id;
}

function toBookingHoldExtendedProperty(holdId: string): string {
  return `${BOOKING_EVENT_HOLD_PROPERTY}=${holdId}`;
}

function toCalendarEventWindow(
  event: calendar_v3.Schema$Event,
): CalendarEventWithWindow | null {
  const startValue = event.start?.dateTime ?? event.start?.date;
  const endValue = event.end?.dateTime ?? event.end?.date;

  if (
    typeof event.id !== "string" ||
    event.id.length === 0 ||
    typeof startValue !== "string" ||
    typeof endValue !== "string"
  ) {
    return null;
  }

  const start = new Date(startValue);
  const end = new Date(endValue);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return {
    id: event.id,
    title: event.summary ?? "",
    start,
    end,
  };
}
