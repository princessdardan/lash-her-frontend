import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { buildBookingSlots } from "./src/lib/booking/availability.ts";
  import {
    createBookingAvailabilityGetHandler,
    createBookingAvailabilityPostHandler,
  } from "./src/app/api/booking/availability/route.ts";

  const paidTrainingEnrollment = {
    checkoutEmail: "client@example.com",
    checkoutOrder: {
      orderId: "LH-TRAINING-123",
    },
    enrollmentId: "training-enrollment-1",
    productSnapshot: {
      currency: "CAD",
      id: "product-training-full",
      priceCents: 149900,
      sku: "TRAINING-FULL",
      title: "Lash Training Full Payment",
    },
    programSnapshot: {
      id: "program-lash-training",
      slug: "lash-training",
      title: "Lash Training Program",
    },
    staffAlertedAt: null,
    tokenExpiresAt: null,
  };

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
      findPaidTrainingIntroEligibility: async () => paidTrainingEnrollment,
      getBookingOfferingBySlug: async () => null,
      getBookingSettings: async () => createSettings(),
      listActiveAppointmentHolds: async () => [],
      listCalendarEvents: async () => [],
      buildBookingSlots,
      ...overrides,
    });
  }

  function createPostHandler(overrides = {}) {
    return createBookingAvailabilityPostHandler({
      findPaidTrainingIntroEligibility: async () => paidTrainingEnrollment,
      getBookingOfferingBySlug: async () => null,
      getBookingSettings: async () => createSettings(),
      listActiveAppointmentHolds: async () => [],
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

test("booking availability verifies paid training order and checkout email before returning slots", () => {
  runRouteScenario(`
    const availabilityStart = createFutureDate(2, 0);
    const availabilityEnd = createFutureDate(2, 1);
    const handler = createPostHandler({
      findPaidTrainingIntroEligibility: async (input) => {
        assert.deepEqual(input, { publicOrderId: "LH-TRAINING-123" });
        return paidTrainingEnrollment;
      },
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Available",
        start: availabilityStart,
        end: availabilityEnd,
      }],
      buildBookingSlots: (input) => {
        assert.equal(input.bookingType.type, "training-call");
        return buildBookingSlots(input);
      },
    });

    const response = await handler(createPostRequest({ order: " LH-TRAINING-123 ", email: " Client@Example.com " }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      slots: [
        {
          start: availabilityStart.toISOString(),
          end: availabilityEnd.toISOString(),
        },
      ],
    });
  `);
});

test("booking availability uses offering configuration and active holds", () => {
  runRouteScenario(`
    const availabilityStart = createFutureDate(2, 0);
    const availabilityEnd = createFutureDate(2, 2);
    const holdStart = new Date(availabilityStart.getTime() + 60 * 60 * 1000);
    const holdEnd = new Date(holdStart.getTime() + 30 * 60 * 1000);
    const handler = createHandler({
      getBookingOfferingBySlug: async (slug) => {
        assert.equal(slug, "classic-fill");

        return {
          _id: "bookingOffering-classic-fill",
          title: "Classic Fill",
          description: "Classic fill appointment",
          slug: "classic-fill",
          isActive: true,
          bookingType: "in-person-appointment",
          durationMinutes: 30,
          slotIntervalMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          minimumLeadTimeHoursOverride: 0,
          paymentMode: "deposit",
        };
      },
      listActiveAppointmentHolds: async (input) => {
        assert.equal(input.offeringId, "bookingOffering-classic-fill");
        assert.ok(input.timeMin instanceof Date);
        assert.ok(input.timeMax instanceof Date);

        return [{
          id: "hold-1",
          state: "held",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          selectedStart: holdStart,
          selectedEnd: holdEnd,
        }];
      },
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Available",
        start: availabilityStart,
        end: availabilityEnd,
      }],
    });

    const response = await handler(createRequest({ offering: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      slots: [
        {
          start: availabilityStart.toISOString(),
          end: new Date(availabilityStart.getTime() + 30 * 60 * 1000).toISOString(),
        },
        {
          start: new Date(availabilityStart.getTime() + 30 * 60 * 1000).toISOString(),
          end: holdStart.toISOString(),
        },
        {
          start: holdEnd.toISOString(),
          end: availabilityEnd.toISOString(),
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

test("booking availability rejects legacy paid scheduling tokens", () => {
  runRouteScenario(`
    let settingsLoaded = false;
    const handler = createHandler({
      getBookingSettings: async () => {
        settingsLoaded = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest({ token: "expired-token" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(settingsLoaded, false);
    assert.deepEqual(body, {
      error: "Legacy training scheduling links are no longer supported",
    });
  `);
});

test("booking availability rejects paid training orders in GET requests", () => {
  runRouteScenario(`
    let settingsLoaded = false;
    const handler = createHandler({
      getBookingSettings: async () => {
        settingsLoaded = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest({ order: "LH-TRAINING-123" }));
    const body = await parseJson(response);

    assert.equal(response.status, 405);
    assert.equal(settingsLoaded, false);
    assert.deepEqual(body, {
      error: "Paid training availability requires a secure request body",
    });
  `);
});

test("booking availability rejects paid training POST bodies without checkout email", () => {
  runRouteScenario(`
    let settingsLoaded = false;
    const handler = createPostHandler({
      getBookingSettings: async () => {
        settingsLoaded = true;
        return createSettings();
      },
    });

    const response = await handler(createPostRequest({ order: "LH-TRAINING-123" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(settingsLoaded, false);
    assert.deepEqual(body, {
      error: "Please enter the checkout email used for this training purchase",
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
