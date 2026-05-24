import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { buildBookingSlots } from "./src/lib/booking/availability.ts";
  import {
    createBookingAvailabilityGetHandler,
    createBookingAvailabilityPostHandler,
  } from "./src/app/api/booking/availability/route.ts";

  function createRequest(searchParams) {
    const url = new URL("http://localhost:3000/api/booking/availability");

    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }

    return new Request(url);
  }

  function createPostRequest(body) {
    return new Request("http://localhost:3000/api/booking/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function createSettings(overrides = {}) {
    return {
      bookingHorizonDays: 10,
      bufferMinutes: 0,
      calendarId: "calendar-1",
      hoursOfOperation: [
        { day: "monday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "tuesday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "wednesday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "thursday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "friday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "saturday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "sunday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
      ],
      intakeQuestions: [],
      marketingOptInLabel: "Send me updates",
      minimumLeadTimeHours: 0,
      slotIntervalMinutes: 60,
      timezone: "UTC",
      ...overrides,
    };
  }

  function createService(overrides = {}) {
    return {
      _id: "service-classic-fill",
      title: "Classic Fill",
      description: "Classic fill appointment",
      slug: "classic-fill",
      showDetailPage: true,
      durationMinutes: 60,
      fullPrice: 150,
      depositAmount: 50,
      currency: "CAD",
      isAvailable: true,
      ...overrides,
    };
  }

  function createFutureDate(dayOffset, hourOffset = 0) {
    const date = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
    date.setUTCHours(10 + hourOffset, 0, 0, 0);
    return date;
  }

  async function parseJson(response) {
    return response.json();
  }

  function createHandler(overrides = {}) {
    return createBookingAvailabilityGetHandler({
      getBookableServiceBySlug: async () => createService(),
      getBookingSettings: async () => createSettings(),
      listActiveAppointmentHolds: async () => [],
      listCalendarEvents: async () => [],
      buildBookingSlots,
      ...overrides,
    });
  }

  function createPostHandler(overrides = {}) {
    return createBookingAvailabilityPostHandler({
      getBookableServiceBySlug: async () => createService(),
      getBookingSettings: async () => createSettings(),
      listActiveAppointmentHolds: async () => [],
      listCalendarEvents: async () => [],
      buildBookingSlots,
      ...overrides,
    });
  }
`;

test("booking availability returns slots for a configured service", () => {
  runRouteScenario(`
    const availabilityStart = createFutureDate(2, 0);
    const availabilityEnd = createFutureDate(2, 2);
    const busyStart = createFutureDate(2, 1);
    const busyEnd = createFutureDate(2, 2);
    const handler = createHandler({
      listCalendarEvents: async (input) => {
        assert.equal(input.calendarId, "calendar-1");
        assert.ok(input.timeMin instanceof Date);
        assert.ok(input.timeMax instanceof Date);

        return [{ id: "busy-event", title: "Existing appointment", start: busyStart, end: busyEnd }];
      },
      buildBookingSlots: (input) => {
        assert.equal(input.bookingType.type, "in-person-appointment");
        assert.equal(input.bookingType.label, "Classic Fill");
        return [{ start: availabilityStart.toISOString(), end: busyStart.toISOString() }];
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { slots: [{ start: availabilityStart.toISOString(), end: busyStart.toISOString() }] });
  `);
});

test("booking availability supports service aliases in POST bodies", () => {
  runRouteScenario(`
    const availabilityStart = createFutureDate(2, 0);
    const availabilityEnd = createFutureDate(2, 1);
    const handler = createPostHandler({
      getBookableServiceBySlug: async (slug) => {
        assert.equal(slug, "classic-fill");
        return createService();
      },
      buildBookingSlots: (input) => {
        assert.equal(input.bookingType.type, "in-person-appointment");
        return [{ start: availabilityStart.toISOString(), end: availabilityEnd.toISOString() }];
      },
    });

    const response = await handler(createPostRequest({ offeringSlug: " classic-fill " }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { slots: [{ start: availabilityStart.toISOString(), end: availabilityEnd.toISOString() }] });
  `);
});

test("booking availability uses service configuration and active holds", () => {
  runRouteScenario(`
    const availabilityStart = createFutureDate(2, 0);
    const availabilityEnd = createFutureDate(2, 2);
    const holdStart = new Date(availabilityStart.getTime() + 60 * 60 * 1000);
    const holdEnd = new Date(holdStart.getTime() + 30 * 60 * 1000);
    const handler = createHandler({
      getBookableServiceBySlug: async (slug) => {
        assert.equal(slug, "classic-fill");
        return createService({ durationMinutes: 30 });
      },
      listActiveAppointmentHolds: async (input) => {
        assert.equal(input.offeringId, "service-classic-fill");
        assert.ok(input.timeMin instanceof Date);
        assert.ok(input.timeMax instanceof Date);

        return [{ id: "hold-1", state: "held", expiresAt: new Date(Date.now() + 10 * 60 * 1000), selectedStart: holdStart, selectedEnd: holdEnd }];
      },
      buildBookingSlots: (input) => {
        assert.equal(input.bookingType.durationMinutes, 30);
        assert.equal(input.busyEvents.length, 1);
        return buildBookingSlots({ ...input, availabilityWindows: [{ id: "window", title: "Open", start: availabilityStart, end: availabilityEnd }] });
      },
    });

    const response = await handler(createRequest({ offering: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      slots: [
        { start: availabilityStart.toISOString(), end: new Date(availabilityStart.getTime() + 30 * 60 * 1000).toISOString() },
      ],
    });
  `);
});

test("booking availability rejects missing service slugs", () => {
  runRouteScenario(`
    let settingsLoaded = false;
    const handler = createHandler({
      getBookingSettings: async () => {
        settingsLoaded = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest({ type: "not-a-booking-type" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(settingsLoaded, false);
    assert.deepEqual(body, { error: "A valid service is required" });
  `);
});

test("booking availability rejects POST bodies without a service", () => {
  runRouteScenario(`
    let settingsLoaded = false;
    const handler = createPostHandler({
      getBookingSettings: async () => {
        settingsLoaded = true;
        return createSettings();
      },
    });

    const response = await handler(createPostRequest({ token: "training-token" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(settingsLoaded, false);
    assert.deepEqual(body, { error: "A valid service is required" });
  `);
});

test("booking availability returns retryable status when calendar provider fails", () => {
  runRouteScenario(`
    const handler = createHandler({
      listCalendarEvents: async () => {
        throw new Error("Google Calendar unavailable");
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Availability is temporarily unavailable" });
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}
void (async () => {
${assertions}
})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
