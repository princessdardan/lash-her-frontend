import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBookingHoldsPostHandler } from "./src/app/api/booking/holds/handler.ts";

  function createRequest(body, headers = {}) {
    return new Request("http://localhost:3000/api/booking/holds", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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

  const OPERATIONAL_OFFERING_ID = "00000000-0000-4000-8000-000000000001";

  function createOperationalOffering(overrides = {}) {
    return {
      addOns: [
        {
          description: "Extended lash bath",
          durationDeltaMinutes: 30,
          key: "lash-bath",
          name: "Lash bath",
          priceCents: 1500,
          status: "active",
        },
      ],
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
      horizonDays: 10,
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
      ...overrides,
    };
  }

  function createOperationalAvailabilityDependencies(offering, overrides = {}) {
    return {
      findActiveOfferingById: async ({ id }) => id === offering.id ? offering : null,
      getOfferingAvailabilityConfiguration: async ({ offeringId, primaryResourceId }) => {
        assert.equal(offeringId, offering.id);
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

test("V2 hold resolves offering, add-on, resources, and calendar server-side", () => {
  runRouteScenario(`
    const now = new Date("2030-06-03T08:00:00.000Z");
    const selectedStart = new Date("2030-06-03T10:00:00.000Z");
    const offering = createOperationalOffering();
    const createInputs = [];
    let legacyServiceLoaded = false;
    let legacySettingsLoaded = false;
    const handler = createHoldHandler({
      createOperationalHold: async (input) => {
        createInputs.push(input);
        return {
          ok: true,
          resourceIds: [input.booking.resourceId],
          hold: {
            expiresAt: input.expiresAt,
            paymentSessionReference: "pay_sess_v2",
            selectedEnd: input.booking.selectedEnd,
            selectedStart: input.booking.selectedStart,
          },
        };
      },
      getBookableServiceBySlug: async () => {
        legacyServiceLoaded = true;
        return createService();
      },
      getBookingSettings: async () => {
        legacySettingsLoaded = true;
        return createSettings();
      },
      getOperationalBookingUiSettings: async () => createSettings({
        intakeQuestions: [
          { id: "notes", label: "Notes", inputType: "text", required: false },
        ],
      }),
      getNow: () => now,
      operationalAvailability: createOperationalAvailabilityDependencies(offering),
    });

    const response = await handler(createRequest({
      answers: [{ questionId: " notes ", answer: " Sensitive eyes " }],
      offeringId: OPERATIONAL_OFFERING_ID,
      selectedAddOnKey: "lash-bath",
      start: selectedStart.toISOString(),
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 201);
    assert.equal(legacyServiceLoaded, false);
    assert.equal(legacySettingsLoaded, false);
    assert.equal(createInputs.length, 1);
    assert.deepEqual(createInputs[0].answers, [
      { questionId: "notes", answer: "Sensitive eyes" },
    ]);
    assert.equal(createInputs[0].marketingOptInLabel, "Send me updates");
    assert.equal(createInputs[0].booking.offeringId, OPERATIONAL_OFFERING_ID);
    assert.equal(createInputs[0].booking.providerId, "provider-server");
    assert.equal(createInputs[0].booking.resourceId, "resource-server");
    assert.deepEqual(createInputs[0].booking.calendar, {
      assignmentId: "assignment-server",
      calendarId: "provider-calendar@example.com",
      connectionId: "connection-server",
    });
    assert.equal(createInputs[0].booking.durationMinutes, 90);
    assert.equal(createInputs[0].booking.pricing.addOnPriceCents, 1500);
    assert.equal(
      createInputs[0].booking.occupiedStart.toISOString(),
      "2030-06-03T09:45:00.000Z",
    );
    assert.equal(
      createInputs[0].booking.occupiedEnd.toISOString(),
      "2030-06-03T11:45:00.000Z",
    );
    assert.deepEqual(body, {
      hold: {
        paymentSessionReference: "pay_sess_v2",
        paymentPageUrl: "/services/classic-fill/booking/payment?session=pay_sess_v2",
        expiresAt: "2030-06-03T08:10:00.000Z",
        start: "2030-06-03T10:00:00.000Z",
        end: "2030-06-03T11:30:00.000Z",
        service: { slug: "classic-fill", title: "Classic Fill" },
      },
    });
  `);
});

test("V2 hold rejects client-selected operational routing identifiers", () => {
  runRouteScenario(`
    let operationalRead = false;
    const offering = createOperationalOffering();
    const operationalAvailability = createOperationalAvailabilityDependencies(offering, {
      findActiveOfferingById: async () => {
        operationalRead = true;
        return offering;
      },
    });
    const handler = createHoldHandler({
      getNow: () => new Date("2030-06-03T08:00:00.000Z"),
      operationalAvailability,
    });

    const response = await handler(createRequest({
      calendarId: "attacker-calendar@example.com",
      connectionId: "attacker-connection",
      offeringId: OPERATIONAL_OFFERING_ID,
      providerId: "attacker-provider",
      resourceId: "attacker-resource",
      start: "2030-06-03T10:00:00.000Z",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(operationalRead, false);
    assert.equal(body.error, "Booking resources are selected by the server.");
    assert.deepEqual(Object.keys(body.fieldErrors).sort(), [
      "calendarId",
      "connectionId",
      "providerId",
      "resourceId",
    ]);
  `);
});

test("V2 hold rejects an add-on removed from the active offering", () => {
  runRouteScenario(`
    const offering = createOperationalOffering();
    let createCalled = false;
    const handler = createHoldHandler({
      createOperationalHold: async () => {
        createCalled = true;
        throw new Error("must not create");
      },
      getNow: () => new Date("2030-06-03T08:00:00.000Z"),
      operationalAvailability: createOperationalAvailabilityDependencies(offering),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
      selectedAddOnKey: "removed-addon",
      start: "2030-06-03T10:00:00.000Z",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body.fieldErrors, {
      selectedAddOnKey: "That add-on is no longer available. Please review your selection.",
    });
  `);
});

test("operational rollout rejects new V1 holds without reading Sanity", () => {
  runRouteScenario(`
    let legacyLoaded = false;
    const handler = createHoldHandler({
      getBookingModelMode: () => "operational",
      getBookableServiceBySlug: async () => {
        legacyLoaded = true;
        return createService();
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }));

    assert.equal(response.status, 400);
    assert.equal(legacyLoaded, false);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

test("legacy rollout rejects new V2 holds before operational reads", () => {
  runRouteScenario(`
    let operationalLoaded = false;
    const offering = createOperationalOffering();
    const handler = createHoldHandler({
      getBookingModelMode: () => "legacy",
      operationalAvailability: createOperationalAvailabilityDependencies(offering, {
        findActiveOfferingById: async () => {
          operationalLoaded = true;
          return offering;
        },
      }),
    });

    const response = await handler(createRequest({
      offeringId: OPERATIONAL_OFFERING_ID,
      start: createFutureDate(2).toISOString(),
    }));

    assert.equal(response.status, 400);
    assert.equal(operationalLoaded, false);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

test("dual rollout blocks crafted V1 holds for a migrated service", () => {
  runRouteScenario(`
    let legacyCalendarLoaded = false;
    let legacyHoldCreated = false;
    const handler = createHoldHandler({
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
      createAppointmentHold: async () => {
        legacyHoldCreated = true;
        throw new Error("must not create");
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: "2030-06-03T10:00:00.000Z",
    }));

    assert.equal(response.status, 400);
    assert.equal(legacyCalendarLoaded, false);
    assert.equal(legacyHoldCreated, false);
    assert.deepEqual(await parseJson(response), {
      error: "Booking is not configured",
    });
  `);
});

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
      marketingOptInLabel: "Send me updates",
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

test("booking hold route returns 429 with Retry-After before booking fan-out", () => {
  runRouteScenario(`
    let settingsRead = false;
    let capturedKey = "";
    const handler = createHoldHandler({
      checkRateLimit: async ({ key }) => {
        capturedKey = key;
        return { allowed: false, retryAfterSeconds: 43 };
      },
      getBookingSettings: async () => {
        settingsRead = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }, { "x-vercel-forwarded-for": "203.0.113.8" }));
    const body = await parseJson(response);

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "43");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(settingsRead, false);
    assert.equal(capturedKey.includes("203.0.113.8"), false);
    assert.deepEqual(body, {
      error: "Too many hold requests. Please wait before trying again.",
    });
  `);
});

test("booking hold route fails closed when durable limiter storage fails", () => {
  runRouteScenario(`
    let settingsRead = false;
    const handler = createHoldHandler({
      checkRateLimit: async () => {
        throw new Error("Redis unavailable");
      },
      getBookingSettings: async () => {
        settingsRead = true;
        return createSettings();
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }, { "x-vercel-forwarded-for": "203.0.113.8" }));
    const body = await parseJson(response);

    assert.equal(response.status, 503);
    assert.equal(settingsRead, false);
    assert.deepEqual(body, { error: "Booking holds are temporarily unavailable" });
  `);
});

test("booking hold attempts use one IP bucket across arbitrary service identifiers", () => {
  runRouteScenario(`
    const keys = [];
    const handler = createHoldHandler({
      checkRateLimit: async ({ key }) => {
        keys.push(key);
        return { allowed: false, retryAfterSeconds: 10 };
      },
    });
    const headers = { "x-vercel-forwarded-for": "203.0.113.8" };

    const first = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }, headers));
    const second = await handler(createRequest({
      offeringId: "attacker-rotated-offering-id",
      start: createFutureDate(2).toISOString(),
    }, headers));

    assert.equal(first.status, 429);
    assert.equal(second.status, 429);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  `);
});

test("booking holds fail closed when Vercel trusted IP is absent", () => {
  runRouteScenario(`
    process.env.VERCEL = "1";
    let limiterCalled = false;
    const handler = createHoldHandler({
      checkRateLimit: async () => {
        limiterCalled = true;
        return { allowed: true, remaining: 4 };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }, { "x-forwarded-for": "203.0.113.8" }));

    assert.equal(response.status, 503);
    assert.equal(limiterCalled, false);
  `);
});

test("booking hold route enforces the active-hold quota before creation", () => {
  runRouteScenario(`
    let holdCreated = false;
    const handler = createHoldHandler({
      acquireActiveHoldQuota: async () => ({
        allowed: false,
        retryAfterSeconds: 120,
      }),
      checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
      createAppointmentHold: async () => {
        holdCreated = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "x" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }, { "x-vercel-forwarded-for": "203.0.113.8" }));
    const body = await parseJson(response);

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "120");
    assert.equal(holdCreated, false);
    assert.deepEqual(body, {
      error: "You already have the maximum number of active holds for this service.",
    });
  `);
});

test("booking hold route releases an active-hold lease after a slot conflict", () => {
  runRouteScenario(`
    const released = [];
    const handler = createHoldHandler({
      acquireActiveHoldQuota: async () => ({
        allowed: true,
        leaseId: "lease-conflict",
        remaining: 1,
      }),
      checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
      createAppointmentHold: async () => ({
        ok: false,
        reason: "slot_conflict",
        conflictingHoldId: "x",
      }),
      releaseActiveHoldQuota: async (input) => released.push(input),
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }, { "x-vercel-forwarded-for": "203.0.113.8" }));

    assert.equal(response.status, 409);
    assert.equal(released.length, 1);
    assert.equal(released[0].leaseId, "lease-conflict");
    assert.equal(released[0].key.includes("203.0.113.8"), false);
  `);
});

test("booking hold route rejects excessive intake count before rate limiting", () => {
  runRouteScenario(`
    let limiterCalled = false;
    const handler = createHoldHandler({
      checkRateLimit: async () => {
        limiterCalled = true;
        return { allowed: true, remaining: 4 };
      },
    });

    const response = await handler(createRequest({
      answers: Array.from({ length: 21 }, (_, index) => ({
        answer: "No",
        questionId: "question-" + index,
      })),
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 413);
    assert.equal(limiterCalled, false);
    assert.deepEqual(body, { error: "Too many intake answers were submitted." });
  `);
});

test("booking hold route rejects oversized JSON before rate limiting", () => {
  runRouteScenario(`
    let limiterCalled = false;
    const handler = createHoldHandler({
      checkRateLimit: async () => {
        limiterCalled = true;
        return { allowed: true, remaining: 4 };
      },
    });

    const response = await handler(createRequest({
      padding: "x".repeat(25 * 1024),
      serviceSlug: "classic-fill",
      start: createFutureDate(2).toISOString(),
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 413);
    assert.equal(limiterCalled, false);
    assert.deepEqual(body, { error: "Hold request is too large" });
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
