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

test("hold creation accepts service data without contact or payment selection", () => {
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
            publicReference: "hold_public_service_only",
            paymentSessionReference: "pay_sess_service_only",
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
      selectedAddOnKey: "addon-lash-bath",
      answers: [{ questionId: "allergies", answer: "No known allergies" }],
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 201);
    assert.equal(createInputs.length, 1);
    assert.deepEqual(createInputs[0].customer, {
      email: "pending-service-booking@example.invalid",
      name: "Pending service booking customer",
      phone: "0000000000",
    });
    assert.equal(createInputs[0].offeringSnapshot.customerStatus, "pending");
    assert.equal(createInputs[0].offeringSnapshot.paymentStatus, "pending");
    assert.equal(createInputs[0].offeringSnapshot.selectedPayment, undefined);
    assert.deepEqual(createInputs[0].offeringSnapshot.pricing, {
      depositAmount: 50,
      fullPrice: 150,
      currency: "CAD",
      customAmountMinimum: 50,
      customAmountMaximum: 150,
      addOnPrice: 25,
    });
    assert.equal(body.hold.paymentSessionReference, "pay_sess_service_only");
  `);
});

test("hold creation rejects contact and payment fields on the provisional endpoint", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => ({ ok: false, reason: "slot_conflict", conflictingHoldId: "x" }),
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "full",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Contact and payment details belong on the payment step.",
      fieldErrors: {
        email: "Enter contact details on the payment page",
        name: "Enter contact details on the payment page",
        paymentOption: "Choose payment amount on the payment page",
        phone: "Enter contact details on the payment page",
      },
    });
  `);
});

test("hold creation rejects marketing fields on the provisional endpoint", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => ({ ok: false, reason: "slot_conflict", conflictingHoldId: "x" }),
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      marketingOptIn: true,
      marketingConsentText: "Send me updates",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Contact and payment details belong on the payment step.",
      fieldErrors: {
        marketingOptIn: "Choose marketing preferences on the payment page",
      },
    });
  `);
});

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
      sourcePath: "/services/classic-fill/booking",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 201);
    assert.equal(createInputs.length, 1);
    assert.equal(createInputs[0].offeringId, "service-classic-fill");
    assert.deepEqual(createInputs[0].customer, {
      email: "pending-service-booking@example.invalid",
      name: "Pending service booking customer",
      phone: "0000000000",
    });
    assert.equal(createInputs[0].selectedStart.toISOString(), selectedStart.toISOString());
    assert.equal(createInputs[0].selectedEnd.toISOString(), selectedEnd.toISOString());
    assert.deepEqual(createInputs[0].offeringSnapshot, {
      id: "service-classic-fill",
      slug: "classic-fill",
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      bookingType: "in-person-appointment",
      durationMinutes: 60,
      customerStatus: "pending",
      paymentStatus: "pending",
      pricing: {
        depositAmount: 50,
        fullPrice: 150,
        currency: "CAD",
        customAmountMinimum: 50,
        customAmountMaximum: 150,
        addOnPrice: 0,
      },
      answers: [],
      sourcePath: "/services/classic-fill/booking",
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

test("booking hold route snapshots immutable pricing bounds with a selected add-on", () => {
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
            publicReference: "hold_public_addon",
            paymentSessionReference: "pay_sess_addon",
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
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 201);
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedAddOn, {
      key: "addon-lash-bath",
      name: "Lash Bath",
      description: "A gentle cleansing add-on",
      price: 25,
      currency: "CAD",
    });
    assert.deepEqual(createInputs[0].offeringSnapshot.pricing, {
      depositAmount: 50,
      fullPrice: 150,
      currency: "CAD",
      customAmountMinimum: 50,
      customAmountMaximum: 150,
      addOnPrice: 25,
    });
    assert.equal(createInputs[0].offeringSnapshot.selectedPayment, undefined);
    assert.match(body.hold.paymentPageUrl, /session=pay_sess_addon/);
  `);
});

test("booking hold route rejects payment amount selection on the provisional endpoint", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      paymentOption: "customPartial",
      customAmount: 100,
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, {
      error: "Contact and payment details belong on the payment step.",
      fieldErrors: {
        paymentOption: "Choose payment amount on the payment page",
      },
    });
  `);
});

test("booking hold route rejects selectedPayment on the provisional endpoint", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      selectedPayment: "full",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, {
      error: "Contact and payment details belong on the payment step.",
      fieldErrors: {
        paymentOption: "Choose payment amount on the payment page",
      },
    });
  `);
});

test("booking hold route rejects missing required intake answers", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    let createCalled = false;
    const handler = createHoldHandler({
      getBookingSettings: async () => createSettings({
        intakeQuestions: [
          { id: "allergies", label: "Allergies", inputType: "text", required: true },
        ],
      }),
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      answers: [],
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, {
      error: "Please fix the hold details and try again.",
      fieldErrors: { "answers.allergies": "Allergies is required" },
    });
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
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      error: "That time is no longer available. Please choose another slot.",
      fieldErrors: { start: "That time is no longer available" },
    });
  `);
});

test("booking hold route sanitizes sourcePath to pathname-only and drops query or hash", () => {
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
            publicReference: "hold_public_source_path",
            paymentSessionReference: "pay_sess_source_path",
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
      sourcePath: "/services/lash-fill/booking?email=client@example.test#payment",
    }));
    const body = await parseJson(response);
    const snapshot = createInputs[0].offeringSnapshot;

    assert.equal(response.status, 201);
    assert.equal(snapshot.sourcePath, "/services/lash-fill/booking");
    const snapshotJson = JSON.stringify(snapshot);
    assert.equal(snapshotJson.includes("client@example.test"), false);
    assert.equal(snapshotJson.includes("email="), false);
    assert.equal(snapshotJson.includes("#payment"), false);
    assert.equal(body.hold.paymentPageUrl, "/services/classic-fill/booking/payment?session=pay_sess_source_path");
  `);
});

test("booking hold route rejects non-string contact values on the provisional endpoint", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => ({ ok: false, reason: "slot_conflict", conflictingHoldId: "x" }),
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: 123,
      email: { value: "client@example.test" },
      phone: ["555"],
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Contact and payment details belong on the payment step.",
      fieldErrors: {
        name: "Enter contact details on the payment page",
        email: "Enter contact details on the payment page",
        phone: "Enter contact details on the payment page",
      },
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
