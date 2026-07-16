import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { buildBookingSlots } from "./src/lib/booking/availability.ts";
  import {
    createBookingAvailabilityGetHandler,
    createBookingAvailabilityPostHandler,
  } from "./src/app/api/booking/availability/handler.ts";

  function createRequest(searchParams, headers = {}) {
    const url = new URL("http://localhost:3000/api/booking/availability");

    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }

    return new Request(url, { headers });
  }

  function createPostRequest(body, headers = {}) {
    return new Request("http://localhost:3000/api/booking/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
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

  const OPERATIONAL_OFFERING_ID = "00000000-0000-4000-8000-000000000001";

  function createOperationalOffering() {
    return {
      addOns: [{
        description: "Extended lash bath",
        durationDeltaMinutes: 30,
        key: "lash-bath",
        name: "Lash bath",
        priceCents: 1500,
        status: "active",
      }],
      bookingType: "in-person-appointment",
      bufferAfterMinutes: 15,
      bufferBeforeMinutes: 15,
      calendar: {
        assignmentId: "assignment-server",
        calendarId: "provider-calendar@example.com",
        connectionId: "connection-server",
      },
      currency: "CAD",
      depositAmountCents: 5000,
      durationMinutes: 60,
      fullPriceCents: 15000,
      horizonDays: 1,
      id: OPERATIONAL_OFFERING_ID,
      minimumLeadTimeHours: 0,
      offeringKey: "classic-fill-nataliea",
      provider: {
        displayName: "Nataliea",
        id: "provider-server",
        providerKey: "nataliea",
        publicSlug: "nataliea",
        status: "active",
      },
      resource: {
        id: "resource-server",
        name: "Nataliea",
        resourceKey: "provider-nataliea",
        status: "active",
        timezone: "UTC",
      },
      service: {
        displayTitle: "Classic Fill",
        id: "service-server",
        publicSlug: "classic-fill",
        serviceKey: "classic-fill",
        status: "active",
      },
      slotIntervalMinutes: 30,
      status: "active",
      version: 3,
    };
  }

  function createOperationalAvailabilityDependencies(overrides = {}) {
    const offering = createOperationalOffering();
    return {
      findActiveOfferingById: async ({ id }) => id === offering.id ? offering : null,
      getOfferingAvailabilityConfiguration: async ({ offeringId, primaryResourceId }) => {
        assert.equal(offeringId, OPERATIONAL_OFFERING_ID);
        assert.equal(primaryResourceId, "resource-server");
        return {
          requiredResourceIds: ["resource-server"],
          resources: [{
            busyCalendarAssignments: [{
              calendarId: "provider-calendar@example.com",
              connectionId: "connection-server",
              id: "assignment-server",
            }],
            exceptions: [],
            recurringWindows: [{
              effectiveFrom: "2030-01-01",
              endsAt: "17:00",
              isoWeekday: 1,
              startsAt: "09:00",
              timezone: "UTC",
            }],
            resourceId: "resource-server",
            timezone: "UTC",
          }],
        };
      },
      listConnectionCalendarEvents: async (input) => {
        assert.equal(input.calendarId, "provider-calendar@example.com");
        assert.equal(input.connectionId, "connection-server");
        return [];
      },
      listReservationBusyWindows: async ({ resourceId }) => {
        assert.equal(resourceId, "resource-server");
        return [];
      },
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

test("V2 availability resolves schedules, reservations, and calendar connection by offeringId", () => {
  runRouteScenario(`
    const now = new Date("2030-06-03T08:00:00.000Z");
    let legacyServiceLoaded = false;
    const handler = createHandler({
      getBookableServiceBySlug: async () => {
        legacyServiceLoaded = true;
        return createService();
      },
      getNow: () => now,
      operationalAvailability: createOperationalAvailabilityDependencies({
        listReservationBusyWindows: async ({ resourceId }) => {
          assert.equal(resourceId, "resource-server");
          return [{
            end: new Date("2030-06-03T13:00:00.000Z"),
            id: "reservation-server",
            start: new Date("2030-06-03T12:00:00.000Z"),
          }];
        },
      }),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
      selectedAddOnKey: "lash-bath",
      resourceId: "attacker-selected-resource",
      calendarId: "attacker-calendar@example.com",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.equal(legacyServiceLoaded, false);
    assert.ok(body.slots.length > 0);
    assert.equal(body.slots[0].start, "2030-06-03T09:30:00.000Z");
    assert.equal(body.slots[0].end, "2030-06-03T11:00:00.000Z");
    assert.equal(
      body.slots.some((slot) => slot.start === "2030-06-03T12:00:00.000Z"),
      false,
    );
  `);
});

test("V2 availability fails closed for an unknown or inactive offering", () => {
  runRouteScenario(`
    let resourceConfigurationLoaded = false;
    const handler = createHandler({
      getNow: () => new Date("2030-06-03T08:00:00.000Z"),
      operationalAvailability: createOperationalAvailabilityDependencies({
        findActiveOfferingById: async () => null,
        getOfferingAvailabilityConfiguration: async () => {
          resourceConfigurationLoaded = true;
          throw new Error("must not load");
        },
      }),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(resourceConfigurationLoaded, false);
    assert.deepEqual(body, { error: "Booking is not configured" });
  `);
});

test("V2 availability rejects a stale add-on key before returning slots", () => {
  runRouteScenario(`
    const handler = createHandler({
      getNow: () => new Date("2030-06-03T08:00:00.000Z"),
      operationalAvailability: createOperationalAvailabilityDependencies(),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
      selectedAddOnKey: "removed-addon",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Invalid availability request",
      fieldErrors: {
        selectedAddOnKey: "That add-on is no longer available",
      },
    });
  `);
});

test("V2 availability fails closed for malformed active add-on configuration", () => {
  runRouteScenario(`
    const offering = createOperationalOffering();
    offering.addOns[0].durationDeltaMinutes = -30;
    const handler = createHandler({
      getNow: () => new Date("2030-06-03T08:00:00.000Z"),
      operationalAvailability: createOperationalAvailabilityDependencies({
        findActiveOfferingById: async ({ id }) =>
          id === OPERATIONAL_OFFERING_ID ? offering : null,
      }),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
      selectedAddOnKey: "lash-bath",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

test("operational rollout rejects new V1 availability requests", () => {
  runRouteScenario(`
    let legacyLoaded = false;
    const handler = createHandler({
      getBookingModelMode: () => "operational",
      getBookableServiceBySlug: async () => {
        legacyLoaded = true;
        return createService();
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));

    assert.equal(response.status, 400);
    assert.equal(legacyLoaded, false);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

test("legacy rollout rejects new V2 availability requests", () => {
  runRouteScenario(`
    let operationalLoaded = false;
    const handler = createHandler({
      getBookingModelMode: () => "legacy",
      operationalAvailability: createOperationalAvailabilityDependencies({
        findActiveOfferingById: async () => {
          operationalLoaded = true;
          return createOperationalOffering();
        },
      }),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
    }));

    assert.equal(response.status, 400);
    assert.equal(operationalLoaded, false);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

test("dual rollout blocks crafted V1 availability for a migrated service", () => {
  runRouteScenario(`
    let legacyCalendarLoaded = false;
    const handler = createHandler({
      getNow: () => new Date("2030-06-03T08:00:00.000Z"),
      hasOperationalOfferingIntent: async ({
        sanityServiceId,
        servicePublicSlug,
      }) => {
        assert.equal(sanityServiceId, "service-classic-fill");
        assert.equal(servicePublicSlug, "classic-fill");
        return true;
      },
      listCalendarEvents: async () => {
        legacyCalendarLoaded = true;
        return [];
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));

    assert.equal(response.status, 400);
    assert.equal(legacyCalendarLoaded, false);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

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

test("booking availability rejects incomplete booking settings", () => {
  runRouteScenario(`
    let calendarLoaded = false;
    let holdsLoaded = false;
    const handler = createHandler({
      getBookingSettings: async () => createSettings({
        bufferMinutes: null,
        hoursOfOperation: null,
        slotIntervalMinutes: null,
      }),
      listCalendarEvents: async () => {
        calendarLoaded = true;
        return [];
      },
      listActiveAppointmentHolds: async () => {
        holdsLoaded = true;
        return [];
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(calendarLoaded, false);
    assert.equal(holdsLoaded, false);
    assert.deepEqual(body, { error: "Booking is not configured" });
  `);
});

test("booking availability rejects settings with no parseable calendar IDs", () => {
  runRouteScenario(`
    let calendarLoaded = false;
    let holdsLoaded = false;
    const handler = createHandler({
      getBookingSettings: async () => createSettings({
        calendarId: "  ,  ,  ",
      }),
      listCalendarEvents: async () => {
        calendarLoaded = true;
        return [];
      },
      listActiveAppointmentHolds: async () => {
        holdsLoaded = true;
        return [];
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(calendarLoaded, false);
    assert.equal(holdsLoaded, false);
    assert.deepEqual(body, { error: "Booking is not configured" });
  `);
});

test("booking availability queries multiple calendar IDs and combines busy events", () => {
  runRouteScenario(`
    const availabilityStart = createFutureDate(2, 0);
    const availabilityEnd = createFutureDate(2, 3);
    const busyStart1 = createFutureDate(2, 1);
    const busyEnd1 = createFutureDate(2, 2);
    const busyStart2 = createFutureDate(2, 2);
    const busyEnd2 = createFutureDate(2, 3);
    const calendarCalls = [];
    const handler = createHandler({
      getBookingSettings: async () => createSettings({
        calendarId: "calendar-1, calendar-2, calendar-3",
      }),
      listCalendarEvents: async (input) => {
        calendarCalls.push(input.calendarId);

        if (input.calendarId === "calendar-1") {
          return [{ id: "busy-1", title: "Appointment 1", start: busyStart1, end: busyEnd1 }];
        }

        if (input.calendarId === "calendar-2") {
          return [{ id: "busy-2", title: "Appointment 2", start: busyStart2, end: busyEnd2 }];
        }

        return [];
      },
      buildBookingSlots: (input) => {
        assert.deepEqual(calendarCalls.sort(), ["calendar-1", "calendar-2", "calendar-3"]);
        assert.equal(input.busyEvents.length, 2);
        assert.equal(input.busyEvents[0].id, "busy-1");
        assert.equal(input.busyEvents[1].id, "busy-2");
        return [{ start: availabilityStart.toISOString(), end: availabilityEnd.toISOString() }];
      },
    });

    const response = await handler(createRequest({ service: "classic-fill" }));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { slots: [{ start: availabilityStart.toISOString(), end: availabilityEnd.toISOString() }] });
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

test("booking availability returns 429 with Retry-After before provider fan-out", () => {
  runRouteScenario(`
    let settingsRead = false;
    let capturedKey = "";
    const handler = createHandler({
      checkRateLimit: async ({ key }) => {
        capturedKey = key;
        return { allowed: false, retryAfterSeconds: 17 };
      },
      getBookingSettings: async () => {
        settingsRead = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest(
      { service: "classic-fill" },
      { "x-vercel-forwarded-for": "203.0.113.8" },
    ));
    const body = await parseJson(response);

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "17");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(settingsRead, false);
    assert.equal(capturedKey.includes("203.0.113.8"), false);
    assert.deepEqual(body, {
      error: "Too many availability requests. Please wait and try again.",
    });
  `);
});

test("booking availability returns 503 when durable limiter storage fails", () => {
  runRouteScenario(`
    let settingsRead = false;
    const handler = createHandler({
      checkRateLimit: async () => {
        throw new Error("Redis unavailable");
      },
      getBookingSettings: async () => {
        settingsRead = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest(
      { service: "classic-fill" },
      { "x-vercel-forwarded-for": "203.0.113.8" },
    ));
    const body = await parseJson(response);

    assert.equal(response.status, 503);
    assert.equal(settingsRead, false);
    assert.deepEqual(body, { error: "Availability is temporarily unavailable" });
  `);
});

test("booking availability uses one IP bucket across arbitrary service identifiers", () => {
  runRouteScenario(`
    const keys = [];
    const handler = createHandler({
      checkRateLimit: async ({ key }) => {
        keys.push(key);
        return { allowed: false, retryAfterSeconds: 10 };
      },
    });
    const headers = { "x-vercel-forwarded-for": "203.0.113.8" };

    const first = await handler(createRequest({ service: "classic-fill" }, headers));
    const second = await handler(createRequest({
      offeringId: "attacker-rotated-offering-id",
    }, headers));

    assert.equal(first.status, 429);
    assert.equal(second.status, 429);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  `);
});

test("booking availability fails closed when Vercel trusted IP is absent", () => {
  runRouteScenario(`
    process.env.VERCEL = "1";
    let limiterCalled = false;
    const handler = createHandler({
      checkRateLimit: async () => {
        limiterCalled = true;
        return { allowed: true, remaining: 29 };
      },
    });

    const response = await handler(createRequest(
      { service: "classic-fill" },
      { "x-forwarded-for": "203.0.113.8" },
    ));

    assert.equal(response.status, 503);
    assert.equal(limiterCalled, false);
  `);
});

test("booking availability POST rejects oversized JSON before rate limiting", () => {
  runRouteScenario(`
    let limiterCalled = false;
    const handler = createPostHandler({
      checkRateLimit: async () => {
        limiterCalled = true;
        return { allowed: true, remaining: 29 };
      },
    });

    const response = await handler(createPostRequest({
      padding: "x".repeat(9 * 1024),
      service: "classic-fill",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 413);
    assert.equal(limiterCalled, false);
    assert.deepEqual(body, { error: "Availability request is too large" });
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
