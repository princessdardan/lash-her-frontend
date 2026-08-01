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

export interface GoogleCalendarOption {
  accessRole: string;
  id: string;
  label: string;
  primary: boolean;
}

export function createOAuthClient(): InstanceType<typeof google.auth.OAuth2> {
  const env = getBookingEnv();

  return new google.auth.OAuth2({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
    transporterOptions: {
      fetchImplementation: globalThis.fetch,
    },
  });
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

export function getCalendarConnectionOAuthConsentUrl(state: string): string {
  const oauthClient = createOAuthClient();

  return oauthClient.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "consent",
    scope: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ],
    state,
  });
}

export async function revokeGoogleTokenBestEffort(token: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      body: new URLSearchParams({ token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    // Local credential deletion remains authoritative when Google is unavailable.
  }
}

export async function getAuthorizedCalendarClient(): Promise<calendar_v3.Calendar> {
  const refreshToken = await getGoogleRefreshToken();

  if (refreshToken === null) {
    throw new Error("Google Calendar is not connected");
  }

  return createAuthorizedCalendarClient(refreshToken);
}

function createAuthorizedCalendarClient(
  refreshToken: string,
): calendar_v3.Calendar {
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
  return listEventsWithClient(calendar, input);
}

/**
 * Reads one assigned calendar with the credential belonging to its server-side
 * connection. Neither identifier is accepted from the public booking client;
 * callers resolve both through the operational resource configuration.
 */
export async function listConnectionCalendarEvents(input: {
  calendarId: string;
  connectionId: string;
  timeMin: Date;
  timeMax: Date;
}): Promise<CalendarEventWindow[]> {
  const calendar = await getConnectionCalendarClient(input.connectionId);

  return listEventsWithClient(calendar, input);
}

export async function findConnectionBookingEventForHold(input: {
  calendarId: string;
  connectionId: string;
  hold: { id: string; selectedEnd: Date; selectedStart: Date };
}): Promise<string | null> {
  const calendar = await getConnectionCalendarClient(input.connectionId);
  return findBookingEventWithClient(calendar, input);
}

export async function insertConnectionBookingEvent(input: {
  calendarId: string;
  connectionId: string;
  event: calendar_v3.Schema$Event;
}): Promise<string> {
  const calendar = await getConnectionCalendarClient(input.connectionId);
  return insertBookingEventWithClient(calendar, input);
}

/**
 * Returns canonical CalendarList IDs for an authenticated admin setup flow.
 * The contextual alias `primary` is never returned as a durable assignment.
 */
export async function listConnectionGoogleCalendars(
  connectionId: string,
): Promise<GoogleCalendarOption[]> {
  const { createDrizzleCalendarConnectionRepository } =
    await import("@/lib/private-db/calendar-connection-repository");
  const credential =
    await createDrizzleCalendarConnectionRepository().getActiveGoogleCredential(
      connectionId,
    );
  const calendar = createAuthorizedCalendarClient(credential.refreshToken);
  const calendars: GoogleCalendarOption[] = [];
  let pageToken: string | undefined;

  do {
    const response = await calendar.calendarList.list({
      maxResults: 250,
      minAccessRole: "freeBusyReader",
      pageToken,
      showDeleted: false,
      showHidden: false,
    });

    for (const item of response.data.items ?? []) {
      const id = item.id?.trim();

      if (!id || id === "primary") {
        continue;
      }

      calendars.push({
        accessRole: item.accessRole ?? "none",
        id,
        label: item.summaryOverride?.trim() || item.summary?.trim() || id,
        primary: item.primary === true,
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken !== undefined);

  return calendars.sort((first, second) => {
    if (first.primary !== second.primary) {
      return first.primary ? -1 : 1;
    }

    return first.label.localeCompare(second.label);
  });
}

async function listEventsWithClient(
  calendar: calendar_v3.Calendar,
  input: { calendarId: string; timeMin: Date; timeMax: Date },
): Promise<CalendarEventWindow[]> {
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
  return findBookingEventWithClient(calendar, input);
}

async function findBookingEventWithClient(
  calendar: calendar_v3.Calendar,
  input: {
    calendarId: string;
    hold: { id: string; selectedEnd: Date; selectedStart: Date };
  },
): Promise<string | null> {
  const response = await calendar.events.list({
    calendarId: input.calendarId,
    maxResults: 1,
    privateExtendedProperty: [toBookingHoldExtendedProperty(input.hold.id)],
    singleEvents: true,
    timeMax: input.hold.selectedEnd.toISOString(),
    timeMin: input.hold.selectedStart.toISOString(),
  });
  const event = response.data.items?.find(
    (candidate) => typeof candidate.id === "string" && candidate.id.length > 0,
  );

  return event?.id ?? null;
}

export async function insertBookingEvent(input: {
  calendarId: string;
  event: calendar_v3.Schema$Event;
}): Promise<string> {
  const calendar = await getAuthorizedCalendarClient();
  return insertBookingEventWithClient(calendar, input);
}

async function insertBookingEventWithClient(
  calendar: calendar_v3.Calendar,
  input: { calendarId: string; event: calendar_v3.Schema$Event },
): Promise<string> {
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

async function getConnectionCalendarClient(
  connectionId: string,
): Promise<calendar_v3.Calendar> {
  const { createDrizzleCalendarConnectionRepository } =
    await import("@/lib/private-db/calendar-connection-repository");
  const credential =
    await createDrizzleCalendarConnectionRepository().getActiveGoogleCredential(
      connectionId,
    );

  return createAuthorizedCalendarClient(credential.refreshToken);
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
