import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createBookingCreatePostHandler } from "./src/app/api/booking/create/route.ts";

  function createRequest(body) {
    return new Request("http://localhost:3000/api/booking/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  function createBookingPayload(overrides = {}) {
    return {
      bookingType: "training-call",
      start: "2026-06-01T14:00:00.000Z",
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      answers: [{ questionId: "goal", answer: "Classic lashes" }],
      marketingOptIn: true,
      marketingConsentText: "Send me booking updates",
      sourcePath: "/booking",
      idempotencyKey: "booking-idempotency-key",
      paidSchedulingToken: "training-scheduling-token",
      paidTrainingSlug: "lash-training",
      ...overrides,
    };
  }

  async function parseJson(response) {
    return response.json();
  }
`;

test("booking create returns success and passes normalized input", () => {
  runRouteScenario(`
    const receivedInputs = [];
    const handler = createBookingCreatePostHandler({
      createBooking: async (input) => {
        receivedInputs.push(input);
        return { success: true, eventId: "calendar-event-1" };
      },
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload())));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { success: true, eventId: "calendar-event-1" });
    assert.deepEqual(receivedInputs, [createBookingPayload()]);
  `);
});

test("booking create rejects invalid JSON before calling createBooking", () => {
  runRouteScenario(`
    let createBookingCalled = false;
    const handler = createBookingCreatePostHandler({
      createBooking: async () => {
        createBookingCalled = true;
        return { success: true, eventId: "calendar-event-1" };
      },
    });

    const response = await handler(createRequest("{bad-json"));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createBookingCalled, false);
    assert.deepEqual(body, { success: false, error: "Invalid booking request" });
  `);
});

test("booking create accepts paid scheduling token payloads", () => {
  runRouteScenario(`
    const receivedInputs = [];
    const handler = createBookingCreatePostHandler({
      createBooking: async (input) => {
        receivedInputs.push(input);
        return { success: true, eventId: "calendar-event-1" };
      },
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload({
      paidSchedulingToken: " token-from-schedule-link ",
      paidTrainingSlug: " lash-training ",
    }))));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.equal(receivedInputs[0].paidSchedulingToken, "token-from-schedule-link");
    assert.equal(receivedInputs[0].paidTrainingSlug, "lash-training");
    assert.deepEqual(body, { success: true, eventId: "calendar-event-1" });
  `);
});

test("booking create rejects direct unpaid in-person appointments before calling createBooking", () => {
  runRouteScenario(`
    let createBookingCalled = false;
    const handler = createBookingCreatePostHandler({
      createBooking: async () => {
        createBookingCalled = true;
        return { success: true, eventId: "calendar-event-1" };
      },
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload({
      bookingType: "in-person-appointment",
    }))));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createBookingCalled, false);
    assert.deepEqual(body, {
      success: false,
      error: "In-person appointments require secure payment before confirmation.",
    });
  `);
});

test("booking create maps field validation failures to bad requests", () => {
  runRouteScenario(`
    const receivedInputs = [];
    const handler = createBookingCreatePostHandler({
      createBooking: async (input) => {
        receivedInputs.push(input);
        return {
          success: false,
          error: "Please fix the booking details and try again.",
          fieldErrors: { email: "Enter a valid email" },
        };
      },
    });

    const response = await handler(createRequest(JSON.stringify({
      bookingType: 42,
      start: null,
      name: "Client Name",
      email: "not-an-email",
      phone: undefined,
      answers: [{ questionId: "goal", answer: "Classic lashes" }, null],
      marketingOptIn: "yes",
      idempotencyKey: "booking-idempotency-key",
      paidTrainingOrderId: "",
      paidSchedulingToken: "",
      paidTrainingSlug: "",
    })));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.deepEqual(receivedInputs, [
      {
        bookingType: "",
        start: "",
        name: "Client Name",
        email: "not-an-email",
        phone: "",
        answers: [
          { questionId: "goal", answer: "Classic lashes" },
          { questionId: "", answer: "" },
        ],
        marketingOptIn: false,
        idempotencyKey: "booking-idempotency-key",
      },
    ]);
    assert.deepEqual(body, {
      success: false,
      error: "Please fix the booking details and try again.",
      fieldErrors: { email: "Enter a valid email" },
    });
  `);
});

test("booking create maps unavailable slots to conflicts", () => {
  runRouteScenario(`
    const handler = createBookingCreatePostHandler({
      createBooking: async () => ({
        success: false,
        error: "That time is no longer available. Please choose another slot.",
      }),
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload())));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      success: false,
      error: "That time is no longer available. Please choose another slot.",
    });
  `);
});

test("booking create maps idempotency failures to conflicts", () => {
  runRouteScenario(`
    const handler = createBookingCreatePostHandler({
      createBooking: async () => ({
        success: false,
        error: "This booking request is already being processed.",
      }),
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload())));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      success: false,
      error: "This booking request is already being processed.",
    });
  `);
});

test("booking create maps provider failures represented by createBooking to conflicts", () => {
  runRouteScenario(`
    const handler = createBookingCreatePostHandler({
      createBooking: async () => ({
        success: false,
        error: "Something went wrong while creating your booking. Please try again.",
      }),
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload())));
    const body = await parseJson(response);

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      success: false,
      error: "Something went wrong while creating your booking. Please try again.",
    });
  `);
});

test("booking create keeps success status when email failures are absorbed by createBooking", () => {
  runRouteScenario(`
    const handler = createBookingCreatePostHandler({
      createBooking: async () => ({ success: true, eventId: "calendar-event-after-email-failure" }),
    });

    const response = await handler(createRequest(JSON.stringify(createBookingPayload())));
    const body = await parseJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      success: true,
      eventId: "calendar-event-after-email-failure",
    });
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
