import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBookingHoldsPostHandler } from "./src/app/api/booking/holds/route.ts";

  function createRequest(body) {
    return new Request("http://localhost:3000/api/booking/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function createFutureDate(dayOffset, hourOffset = 0) {
    const date = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
    date.setUTCHours(10 + hourOffset, 0, 0, 0);
    return date;
  }

  function createSettings(overrides = {}) {
    return {
      availabilityMarkerTitle: "Available",
      bookingHorizonDays: 10,
      bookingTypes: [
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

  function createOffering(overrides = {}) {
    return {
      _id: "bookingOffering-classic-fill",
      title: "Classic Fill",
      description: "Classic fill appointment",
      slug: "classic-fill",
      isActive: true,
      bookingType: "in-person-appointment",
      durationMinutes: 60,
      slotIntervalMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      paymentMode: "deposit",
      depositProduct: { _id: "deposit-product-1" },
      ...overrides,
    };
  }

  function createHoldHandler(overrides = {}) {
    return createBookingHoldsPostHandler({
      createAppointmentHold: async () => ({ ok: false, reason: "slot_conflict", conflictingHoldId: "default" }),
      getBookingOfferingBySlug: async () => createOffering(),
      getBookingSettings: async () => createSettings(),
      listActiveAppointmentHolds: async () => [],
      listCalendarEvents: async () => [],
      ...overrides,
    });
  }

  async function parseJson(response) {
    return response.json();
  }
`;

test("booking hold route revalidates a slot and returns a public hold reference", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    const availabilityEnd = new Date(selectedStart.getTime() + 2 * 60 * 60 * 1000);
    const expiresAt = new Date("2026-06-01T12:10:00.000Z");
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async (input) => {
        assert.equal(input.calendarId, "calendar-1");
        assert.ok(input.timeMin instanceof Date);
        assert.ok(input.timeMax instanceof Date);

        return [{
          id: "available-window",
          title: "Available",
          start: selectedStart,
          end: availabilityEnd,
        }];
      },
      createAppointmentHold: async (input) => {
        createInputs.push(input);

        return {
          ok: true,
          hold: {
            publicReference: "hold_public_1",
            expiresAt,
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const response = await handler(createRequest({
      offeringSlug: " classic-fill ",
      start: selectedStart.toISOString(),
      name: " Client Name ",
      email: " client@example.com ",
      phone: " 555-0100 ",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 201);
    assert.equal(createInputs.length, 1);
    assert.equal(createInputs[0].offeringId, "bookingOffering-classic-fill");
    assert.equal(createInputs[0].customer.email, "client@example.com");
    assert.equal(createInputs[0].selectedStart.toISOString(), selectedStart.toISOString());
    assert.equal(createInputs[0].selectedEnd.toISOString(), selectedEnd.toISOString());
    assert.deepEqual(createInputs[0].offeringSnapshot, {
      id: "bookingOffering-classic-fill",
      slug: "classic-fill",
      title: "Classic Fill",
      bookingType: "in-person-appointment",
      durationMinutes: 60,
      paymentMode: "deposit",
      depositProductId: "deposit-product-1",
    });
    assert.deepEqual(body, {
      hold: {
        reference: "hold_public_1",
        expiresAt: expiresAt.toISOString(),
        start: selectedStart.toISOString(),
        end: selectedEnd.toISOString(),
        offering: {
          slug: "classic-fill",
          title: "Classic Fill",
        },
        paymentMode: "deposit",
      },
    });
  `);
});

test("booking hold route rejects slots blocked by active private holds", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Available",
        start: selectedStart,
        end: selectedEnd,
      }],
      listActiveAppointmentHolds: async () => [{
        id: "hold-1",
        state: "held",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        selectedStart,
        selectedEnd,
      }],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      offeringSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.equal(createCalled, false);
    assert.deepEqual(body, {
      error: "That time is no longer available. Please choose another slot.",
      fieldErrors: { start: "That time is no longer available" },
    });
  `);
});

test("booking hold route maps conflict-safe hold rejection to a slot conflict", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    const handler = createHoldHandler({
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Available",
        start: selectedStart,
        end: selectedEnd,
      }],
      createAppointmentHold: async () => ({
        ok: false,
        reason: "slot_conflict",
        conflictingHoldId: "hold-2",
      }),
    });

    const response = await handler(createRequest({
      offeringSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      error: "That time is no longer available. Please choose another slot.",
      fieldErrors: { start: "That time is no longer available" },
    });
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
