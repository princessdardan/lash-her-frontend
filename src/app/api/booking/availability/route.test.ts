import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { buildBookingSlots } from "./src/lib/booking/availability.ts";
  import { createBookingAvailabilityGetHandler } from "./src/app/api/booking/availability/route.ts";

  function createRequest(searchParams) {
    const url = new URL("http://localhost:3000/api/booking/availability");

    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }

    return new Request(url);
  }

  function createSettings(overrides = {}) {
    return {
      availabilityMarkerTitle: "Available",
      bookingHorizonDays: 10,
      bookingTypes: [
        {
          type: "training-call",
          label: "Training call",
          description: "Training call",
          durationMinutes: 60,
          slotIntervalMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          questions: [],
        },
        {
          type: "in-person-appointment",
          label: "Appointment",
          description: "Appointment",
          durationMinutes: 60,
          slotIntervalMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          questions: [],
        },
      ],
      calendarId: "calendar-1",
      marketingOptInLabel: "Send me updates",
      minimumLeadTimeHours: 0,
      timezone: "America/Toronto",
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
      findPendingTrainingEnrollmentByToken: async () => ({ id: "enrollment-1" }),
      getBookingSettings: async () => createSettings(),
      listCalendarEvents: async () => [],
      buildBookingSlots,
      ...overrides,
    });
  }
`;

test("booking availability returns slots for a configured booking type", () => {
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

        return [
          {
            id: "available-window",
            title: "Available",
            start: availabilityStart,
            end: availabilityEnd,
          },
          {
            id: "busy-event",
            title: "Existing appointment",
            start: busyStart,
            end: busyEnd,
          },
        ];
      },
    });

    const response = await handler(createRequest({ type: "training-call" }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      slots: [
        {
          start: availabilityStart.toISOString(),
          end: busyStart.toISOString(),
        },
      ],
    });
  `);
});

test("booking availability rejects invalid booking types", () => {
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
    assert.deepEqual(body, { error: "A valid booking type is required" });
  `);
});

test("booking availability rejects invalid paid scheduling tokens", () => {
  runRouteScenario(`
    let settingsLoaded = false;
    const handler = createHandler({
      findPendingTrainingEnrollmentByToken: async (input) => {
        assert.deepEqual(input, { schedulingToken: "expired-token" });
        return null;
      },
      getBookingSettings: async () => {
        settingsLoaded = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest({ token: " expired-token " }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(settingsLoaded, false);
    assert.deepEqual(body, {
      error: "This training scheduling link is invalid or has expired",
    });
  `);
});

test("booking availability returns retryable status when calendar provider fails", () => {
  runRouteScenario(`
    const handler = createHandler({
      listCalendarEvents: async () => {
        throw new Error("Google Calendar unavailable");
      },
    });

    const response = await handler(createRequest({ type: "training-call" }));
    const body = await parseJson(response);

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Availability is temporarily unavailable" });
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
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
