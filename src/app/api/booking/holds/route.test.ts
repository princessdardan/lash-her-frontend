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
      bookingHorizonDays: 10,
      bufferMinutes: 0,
      hoursOfOperation: [
        { day: "monday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "tuesday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "wednesday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "thursday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "friday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "saturday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
        { day: "sunday", isOpen: true, opensAt: "00:00", closesAt: "23:59" },
      ],
      calendarId: "calendar-1",
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
      depositAmount: 50,
      fullPrice: 150,
      currency: "CAD",
      addOns: [
        { _key: "addon-lash-bath", name: "Lash Bath", description: "A gentle cleansing add-on", price: 25 },
      ],
      isAvailable: true,
      ...overrides,
    };
  }

  function createHoldHandler(overrides = {}) {
    return createBookingHoldsPostHandler({
      createAppointmentHold: async () => ({ ok: false, reason: "slot_conflict", conflictingHoldId: "default" }),
      getBookableServiceBySlug: async () => createService(),
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

test("booking hold route revalidates a slot and returns payment page handoff", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    const expiresAt = new Date("2026-06-01T12:10:00.000Z");
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async (input) => {
        assert.equal(input.calendarId, "calendar-1");
        assert.ok(input.timeMin instanceof Date);
        assert.ok(input.timeMax instanceof Date);

        return [];
      },
      createAppointmentHold: async (input) => {
        createInputs.push(input);

        return {
          ok: true,
          hold: {
            publicReference: "hold_public_1",
            paymentSessionReference: "pay_sess_test_1",
            expiresAt,
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: " classic-fill ",
      start: selectedStart.toISOString(),
      name: " Client Name ",
      email: " client@example.com ",
      phone: " 555-0100 ",
      paymentOption: "deposit",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 201);
    assert.equal(createInputs.length, 1);
    assert.equal(createInputs[0].offeringId, "service-classic-fill");
    assert.equal(createInputs[0].customer.email, "client@example.com");
    assert.equal(createInputs[0].selectedStart.toISOString(), selectedStart.toISOString());
    assert.equal(createInputs[0].selectedEnd.toISOString(), selectedEnd.toISOString());
    assert.deepEqual(createInputs[0].offeringSnapshot, {
      id: "service-classic-fill",
      slug: "classic-fill",
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      bookingType: "in-person-appointment",
      durationMinutes: 60,
      depositAmount: 50,
      fullPrice: 150,
      currency: "CAD",
      payment: {
        amount: 50,
        currency: "CAD",
      },
      selectedPayment: {
        amount: 50,
        description: "Classic Fill deposit",
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
      answers: [],
      marketingOptIn: false,
    });
    assert.equal(body.hold.paymentSessionReference, "pay_sess_test_1");
    assert.equal(
      body.hold.paymentPageUrl,
      "/services/classic-fill/booking/payment?session=pay_sess_test_1",
    );
    assert.equal(body.hold.reference, undefined);
    assert.deepEqual(body, {
      hold: {
        paymentSessionReference: "pay_sess_test_1",
        paymentPageUrl: "/services/classic-fill/booking/payment?session=pay_sess_test_1",
        expiresAt: expiresAt.toISOString(),
        start: selectedStart.toISOString(),
        end: selectedEnd.toISOString(),
        service: {
          slug: "classic-fill",
          title: "Classic Fill",
        },
      },
    });
  `);
});

test("booking hold route snapshots a validated custom partial payment choice", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async (input) => {
        createInputs.push(input);

        return {
          ok: true,
          hold: {
            publicReference: "hold_public_2",
            paymentSessionReference: "pay_sess_custom_partial",
            expiresAt: new Date("2026-06-01T12:10:00.000Z"),
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "customPartial",
      customAmount: 100,
    }));

    assert.equal(response.status, 201);
    assert.doesNotMatch(response.headers.get("location") ?? "", /undefined/);
    const body = await parseJson(response);
    assert.equal(body.hold.paymentSessionReference, "pay_sess_custom_partial");
    assert.match(body.hold.paymentPageUrl, /session=pay_sess_custom_partial/);
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedPayment, {
      amount: 100,
      description: "Classic Fill custom partial payment",
      option: "customPartial",
      purpose: "appointment_custom_partial",
      sku: "BOOKING-CUSTOM-PARTIAL",
    });
    assert.deepEqual(createInputs[0].offeringSnapshot.payment, {
      amount: 100,
      currency: "CAD",
    });
  `);
});

test("booking hold route rejects invalid custom partial payment choices before creating a hold", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Open",
        start: selectedStart,
        end: selectedEnd,
      }],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "customPartial",
      customAmount: 50,
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, { error: "Booking payment is not configured" });
  `);
});

test("booking hold route rejects missing purchaser payment choices before creating a hold", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Open",
        start: selectedStart,
        end: selectedEnd,
      }],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, { error: "Booking payment is not configured" });
  `);
});

test("booking hold route snapshots purchaser-selected full payments", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async (input) => {
        createInputs.push(input);
        return {
          ok: true,
          hold: {
            publicReference: "hold_public_3",
            paymentSessionReference: "pay_sess_full",
            expiresAt: new Date("2026-06-01T12:10:00.000Z"),
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "full",
    }));

    assert.equal(response.status, 201);
    const body = await parseJson(response);
    assert.equal(body.hold.paymentSessionReference, "pay_sess_full");
    assert.doesNotMatch(body.hold.paymentPageUrl, /undefined/);
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedPayment, {
      amount: 150,
      description: "Classic Fill full payment",
      option: "full",
      purpose: "appointment_full",
      sku: "BOOKING-FULL",
    });
    assert.deepEqual(createInputs[0].offeringSnapshot.payment, {
      amount: 150,
      currency: "CAD",
    });
  `);
});

test("booking hold route snapshots full payments with selected add-ons", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async (input) => {
        createInputs.push(input);
        return {
          ok: true,
          hold: {
            publicReference: "hold_public_4",
            paymentSessionReference: "pay_sess_addon_full",
            expiresAt: new Date("2026-06-01T12:10:00.000Z"),
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      selectedAddOnKey: "addon-lash-bath",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "full",
    }));

    assert.equal(response.status, 201);
    const body = await parseJson(response);
    assert.equal(body.hold.paymentSessionReference, "pay_sess_addon_full");
    assert.match(body.hold.paymentPageUrl, /session=pay_sess_addon_full/);
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedAddOn, {
      key: "addon-lash-bath",
      name: "Lash Bath",
      description: "A gentle cleansing add-on",
      price: 25,
      currency: "CAD",
    });
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedPayment, {
      amount: 175,
      description: "Classic Fill full payment with Lash Bath",
      option: "full",
      purpose: "appointment_full",
      sku: "BOOKING-FULL",
    });
    assert.deepEqual(createInputs[0].offeringSnapshot.payment, {
      amount: 175,
      currency: "CAD",
    });
  `);
});

test("booking hold route keeps deposit and custom partial amounts service-only with selected add-ons", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async (input) => {
        createInputs.push(input);
        return {
          ok: true,
          hold: {
            publicReference: "hold_public_5",
            paymentSessionReference: "pay_sess_deposit_addon",
            expiresAt: new Date("2026-06-01T12:10:00.000Z"),
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const depositResponse = await handler(createRequest({
      serviceSlug: "classic-fill",
      selectedAddOnKey: "addon-lash-bath",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "deposit",
    }));

    const customResponse = await handler(createRequest({
      serviceSlug: "classic-fill",
      selectedAddOnKey: "addon-lash-bath",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "customPartial",
      customAmount: 100,
    }));

    const depositBody = await parseJson(depositResponse);
    const customBody = await parseJson(customResponse);
    assert.equal(depositBody.hold.paymentSessionReference, "pay_sess_deposit_addon");
    assert.match(depositBody.hold.paymentPageUrl, /session=pay_sess_deposit_addon/);
    assert.doesNotMatch(customBody.hold.paymentPageUrl, /undefined/);

    assert.equal(depositResponse.status, 201);
    assert.equal(customResponse.status, 201);
    assert.equal(createInputs[0].offeringSnapshot.selectedPayment.amount, 50);
    assert.match(createInputs[0].offeringSnapshot.selectedPayment.description, /add-on balance due later/);
    assert.equal(createInputs[1].offeringSnapshot.selectedPayment.amount, 100);
    assert.match(createInputs[1].offeringSnapshot.selectedPayment.description, /add-on balance due later/);
  `);
});

test("booking hold route rejects stale selected add-on keys", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [{
        id: "available-window",
        title: "Open",
        start: selectedStart,
        end: selectedEnd,
      }],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      selectedAddOnKey: "addon-stale",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "full",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, {
      error: "Please fix the hold details and try again.",
      fieldErrors: { selectedAddOnKey: "That add-on is no longer available. Please review your selection." },
    });
  `);
});

test("booking hold route rejects settings with no parseable calendar IDs", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    let createCalled = false;
    let calendarLoaded = false;
    const handler = createHoldHandler({
      getBookingSettings: async () => createSettings({
        calendarId: "  ,  ,  ",
      }),
      listCalendarEvents: async () => {
        calendarLoaded = true;
        return [];
      },
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "deposit",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(calendarLoaded, false);
    assert.equal(createCalled, false);
    assert.deepEqual(body, { error: "Booking is not configured" });
  `);
});

test("booking hold route queries multiple calendar IDs and combines busy events", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const selectedEnd = new Date(selectedStart.getTime() + 60 * 60 * 1000);
    const calendarCalls = [];
    const handler = createHoldHandler({
      getBookingSettings: async () => createSettings({
        calendarId: "calendar-1, calendar-2, calendar-3",
      }),
      listCalendarEvents: async (input) => {
        calendarCalls.push(input.calendarId);
        return [];
      },
      createAppointmentHold: async (input) => {
        return {
          ok: false,
          reason: "slot_conflict",
          conflictingHoldId: "hold-1",
        };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "deposit",
    }));

    assert.deepEqual(calendarCalls.sort(), ["calendar-1", "calendar-2", "calendar-3"]);
    assert.equal(response.status, 409);
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
        title: "Open",
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
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "deposit",
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
        title: "Open",
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
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "deposit",
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
