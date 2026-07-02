import { execFileSync } from "node:child_process";
import test from "node:test";

// NOTE: This file sits under a `[id]` dynamic segment. Node's test runner
// treats `--test` arguments as globs, so a focused command like:
//
//   npx tsx --test "src/app/api/admin/appointments/[id]/no-show/route.test.ts"
//
// will match zero files and silently report success. Run the suite through the
// non-bracketed proxy instead:
//
//   npx tsx --test "src/app/api/admin/appointments/no-show-route-proxy.test.ts"
//
// See `no-show-route-proxy.test.ts` for details.

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createAdminNoShowPostHandler,
    defaultChargeNoShowCommand,
  } from "./src/app/api/admin/appointments/[id]/no-show/route.ts";

  function createRequest(appointmentId, body, headers) {
    const authHeaders = headers === null ? undefined : (headers || { authorization: "Bearer admin-secret" });
    return new Request("https://lash.test/api/admin/appointments/" + appointmentId + "/no-show", {
      method: "POST",
      headers: authHeaders,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function bookedAppointmentFixture() {
    return {
      appointmentId: "appt-123",
      holdId: "hold-123",
      noShowChargeRecordId: "nsr-123",
      chargeStatus: "provider_draft_created",
      hasSavedCard: true,
      maxChargeCents: 15000,
      allowedChargeAmountCents: 15000,
      selectedEnd: new Date("2026-06-20T13:00:00Z"),
    };
  }

  function createMinimalNoShowRepository(overrides = {}) {
    return {
      async getNoShowChargeRecordById() { return null; },
      async recordNoShowAdminAction() { return { recorded: true }; },
      async findNoShowChargeAttempt() { return null; },
      async createNoShowChargeAttempt() { throw new Error("unexpected createNoShowChargeAttempt"); },
      async updateNoShowChargeAttempt() { throw new Error("unexpected updateNoShowChargeAttempt"); },
      async claimNoShowChargeAttempt() { throw new Error("unexpected claimNoShowChargeAttempt"); },
      async updateNoShowChargeRecord() { throw new Error("unexpected updateNoShowChargeRecord"); },
      ...overrides,
    };
  }

  function runScenario(options) {
    options = options || {};
    const errors = [];
    const warnings = [];
    const chargeCalls = [];
    const now = options.now || new Date("2026-06-20T14:00:00Z");
    const appointment = options.appointment || bookedAppointmentFixture();
    const handler = createAdminNoShowPostHandler({
      getAdminSecret: options.getAdminSecret || (() => "admin-secret"),
      getNow: () => now,
      findBookedAppointmentWithNoShowRecord: options.findBookedAppointmentWithNoShowRecord || (async () => appointment),
      chargeNoShow: async (input) => {
        chargeCalls.push(input);
        if (options.chargeNoShow) {
          return options.chargeNoShow(input);
        }
        return {
          appointmentId: input.appointmentId,
          noShowChargeRecordId: input.noShowChargeRecordId,
          chargeStatus: "charged",
        };
      },
      logError: (message, context) => errors.push({ context, message }),
      logWarn: (message, context) => warnings.push({ context, message }),
    });

    return { chargeCalls, errors, handler, warnings };
  }
`;

test("admin no-show route rejects missing operator identity", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects appointments that have not ended", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      appointment: {
        ...bookedAppointmentFixture(),
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      },
      now: new Date("2026-06-20T12:00:00Z"),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Appointment is not eligible for no-show charge",
      code: "NO_SHOW_APPOINTMENT_NOT_ENDED",
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects missing bearer secret before charging", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, null));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns not found when admin secret is missing", () => {
  runRouteScenario(`
    const { errors, handler, chargeCalls, warnings } = runScenario({
      getAdminSecret: () => null,
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.deepEqual(chargeCalls, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [{
      context: undefined,
      message: "[admin:no-show] Admin payment action secret is not configured",
    }]);
  `);
});

test("admin no-show route returns not found when appointment does not exist", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => null,
    });

    const response = await handler(createRequest("missing-appt", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Appointment not found" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns conflict when booked appointment has no saved card or no-show record", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "",
        chargeStatus: "ready",
        hasSavedCard: false,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Appointment has no saved card or no-show charge record" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns conflict and does not duplicate a succeeded charge", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "charged",
        hasSavedCard: true,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "No-show charge already succeeded" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route short-circuits charge_pending and does not call charge command", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "charge_pending",
        hasSavedCard: true,
        maxChargeCents: 15000,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      appointmentId: "appt-123",
      chargeStatus: "charge_pending",
      noShowChargeRecordId: "nsr-123",
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route reaches charge command for stale publish_pending retry", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "charge_pending",
        providerStatus: "publish_pending",
        updatedAt: new Date("2026-06-20T10:00:00Z"),
        hasSavedCard: true,
        maxChargeCents: 15000,
        allowedChargeAmountCents: 15000,
        selectedEnd: new Date("2026-06-20T11:00:00Z"),
      }),
      chargeNoShow: async (input) => ({
        appointmentId: input.appointmentId,
        noShowChargeRecordId: input.noShowChargeRecordId,
        chargeStatus: "charge_pending",
      }),
      now: new Date("2026-06-20T12:00:00Z"),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-stale",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      appointmentId: "appt-123",
      chargeStatus: "charge_pending",
      noShowChargeRecordId: "nsr-123",
    });
    assert.equal(chargeCalls.length, 1);
    assert.deepEqual(chargeCalls[0], {
      appointmentId: "appt-123",
      holdId: "hold-123",
      noShowChargeRecordId: "nsr-123",
      amountCents: 15000,
      idempotencyKey: "idem-stale",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    });
  `);
});

test("admin no-show route rejects not-ended appointment even when charge is pending", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      appointment: {
        ...bookedAppointmentFixture(),
        chargeStatus: "charge_pending",
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      },
      now: new Date("2026-06-20T12:00:00Z"),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Appointment is not eligible for no-show charge",
      code: "NO_SHOW_APPOINTMENT_NOT_ENDED",
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns 400 with stable code and allowed amount for lower charge amount", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "provider_draft_created",
        hasSavedCard: true,
        maxChargeCents: 15000,
        allowedChargeAmountCents: 15000,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 14000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Invalid no-show charge amount",
      code: "NO_SHOW_AMOUNT_MUST_EQUAL_REMAINING_BALANCE",
      allowedAmountCents: 15000,
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns 400 with stable code and allowed amount for higher charge amount", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "provider_draft_created",
        hasSavedCard: true,
        maxChargeCents: 15000,
        allowedChargeAmountCents: 15000,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 20000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Invalid no-show charge amount",
      code: "NO_SHOW_AMOUNT_MUST_EQUAL_REMAINING_BALANCE",
      allowedAmountCents: 15000,
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route maps chargeNoShow amount error to 400 stable response", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "provider_draft_created",
        hasSavedCard: true,
        maxChargeCents: 15000,
        allowedChargeAmountCents: 15000,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
      chargeNoShow: async () => {
        const error = new Error("Amount does not match max charge");
        error.name = "NoShowInvoiceAmountError";
        error.context = { allowedAmountCents: 15000 };
        throw error;
      },
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Invalid no-show charge amount",
      code: "NO_SHOW_AMOUNT_MUST_EQUAL_REMAINING_BALANCE",
      allowedAmountCents: 15000,
    });
    assert.deepEqual(chargeCalls.length, 1);
  `);
});

test("admin no-show route exposes the tax-inclusive remaining balance as the allowed charge amount", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "provider_draft_created",
        hasSavedCard: true,
        maxChargeCents: 15500,
        allowedChargeAmountCents: 11865,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15500,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Invalid no-show charge amount",
      code: "NO_SHOW_AMOUNT_MUST_EQUAL_REMAINING_BALANCE",
      allowedAmountCents: 11865,
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects full-payment booking with zero remaining balance", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      findBookedAppointmentWithNoShowRecord: async () => ({
        appointmentId: "appt-123",
        holdId: "hold-123",
        noShowChargeRecordId: "nsr-123",
        chargeStatus: "ready",
        hasSavedCard: true,
        maxChargeCents: 15500,
        allowedChargeAmountCents: 0,
        selectedEnd: new Date("2026-06-20T13:00:00Z"),
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 100,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: "Invalid no-show charge amount",
      code: "NO_SHOW_AMOUNT_MUST_EQUAL_REMAINING_BALANCE",
      allowedAmountCents: 0,
    });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns 400 for invalid request body", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: -1,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects unsafe integer amountCents", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: Number.MAX_SAFE_INTEGER + 1,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route returns 400 for malformed json", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", "not-json"));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects reason with control characters", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not arrive" + String.fromCharCode(0),
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects reason exceeding maximum length", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "x".repeat(501),
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects missing reason", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid no-show charge request" });
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route dispatches charge command and returns charge status", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      chargeNoShow: async (input) => ({
        appointmentId: input.appointmentId,
        noShowChargeRecordId: input.noShowChargeRecordId,
        chargeStatus: "charge_pending",
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not arrive",
    }));

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      appointmentId: "appt-123",
      chargeStatus: "charge_pending",
      noShowChargeRecordId: "nsr-123",
    });
    assert.deepEqual(chargeCalls, [{
      appointmentId: "appt-123",
      holdId: "hold-123",
      noShowChargeRecordId: "nsr-123",
      amountCents: 15000,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not arrive",
    }]);
  `);
});

test("admin no-show route returns charge_failed without unhandled exception when provider charge fails", () => {
  runRouteScenario(`
    const { errors, handler, chargeCalls } = runScenario({
      chargeNoShow: async (input) => ({
        appointmentId: input.appointmentId,
        noShowChargeRecordId: input.noShowChargeRecordId,
        chargeStatus: "charge_failed",
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(body, {
      appointmentId: "appt-123",
      chargeStatus: "charge_failed",
      noShowChargeRecordId: "nsr-123",
    });
    assert.deepEqual(chargeCalls.length, 1);
    assert.deepEqual(errors, []);
  `);
});

test("admin no-show route returns 202 when charge command returns manual_followup", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario({
      chargeNoShow: async (input) => ({
        appointmentId: input.appointmentId,
        noShowChargeRecordId: input.noShowChargeRecordId,
        chargeStatus: "manual_followup",
      }),
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(body, {
      appointmentId: "appt-123",
      chargeStatus: "manual_followup",
      noShowChargeRecordId: "nsr-123",
    });
    assert.deepEqual(chargeCalls.length, 1);
  `);
});

test("admin no-show route handles charge command errors as charge_failed without leaking error text", () => {
  runRouteScenario(`
    const { errors, handler, chargeCalls } = runScenario({
      chargeNoShow: async () => {
        throw new Error("Square invoice publish declined");
      },
    });

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }));

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(body, {
      appointmentId: "appt-123",
      chargeStatus: "charge_failed",
      noShowChargeRecordId: "nsr-123",
    });
    assert.deepEqual(chargeCalls.length, 1);
    assert.deepEqual(errors, [{
      context: { error: "redacted" },
      message: "[admin:no-show] No-show charge command failed",
    }]);
  `);
});

test("admin no-show route rejects wrong bearer token", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, { authorization: "Bearer wrong-secret" }));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(chargeCalls, []);
  `);
});

test("admin no-show route rejects authorization header without bearer prefix", () => {
  runRouteScenario(`
    const { handler, chargeCalls } = runScenario();

    const response = await handler(createRequest("appt-123", {
      amountCents: 15000,
      confirmPolicyCharge: true,
      idempotencyKey: "idem-1",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, { authorization: "admin-secret" }));

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
    assert.deepEqual(chargeCalls, []);
  `);
});

test("default charge command persists admin audit and returns manual_followup when Square env is disabled", () => {
  runRouteScenario(`
    const adminActions = [];
    const now = new Date("2026-06-20T14:00:00Z");
    const result = await defaultChargeNoShowCommand({
      amountCents: 15000,
      appointmentId: "appt-123",
      holdId: "hold-123",
      idempotencyKey: "idem-1",
      noShowChargeRecordId: "nsr-123",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, {
      getSquareServiceBookingEnv: () => null,
      getNow: () => now,
      createRepository: async () => createMinimalNoShowRepository({
        async getNoShowChargeRecordById(id) {
          return {
            id,
            status: "provider_draft_created",
            maxChargeCents: 15000,
            currency: "CAD",
          };
        },
        async recordNoShowAdminAction(input) {
          adminActions.push(input);
          return { recorded: true };
        },
      }),
      createSquareInvoicesClient: () => { throw new Error("Square client should not be created"); },
      createAlerts: () => ({ alert: () => {} }),
      logError: () => {},
    });

    assert.deepEqual(result, {
      appointmentId: "appt-123",
      chargeStatus: "manual_followup",
      noShowChargeRecordId: "nsr-123",
    });
    assert.equal(adminActions.length, 1);
    assert.deepEqual(adminActions[0], {
      noShowChargeRecordId: "nsr-123",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
      now,
    });
  `);
});

test("default charge command returns charge_failed when audit persistence fails and Square env is disabled", () => {
  runRouteScenario(`
    const errors = [];
    const result = await defaultChargeNoShowCommand({
      amountCents: 15000,
      appointmentId: "appt-123",
      holdId: "hold-123",
      idempotencyKey: "idem-1",
      noShowChargeRecordId: "nsr-123",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, {
      getSquareServiceBookingEnv: () => null,
      getNow: () => new Date("2026-06-20T14:00:00Z"),
      createRepository: async () => createMinimalNoShowRepository({
        async recordNoShowAdminAction() {
          throw new Error("Audit persistence failed");
        },
      }),
      createSquareInvoicesClient: () => { throw new Error("Square client should not be created"); },
      createAlerts: () => ({ alert: () => {} }),
      logError: (message, context) => errors.push({ message, context }),
    });

    assert.deepEqual(result, {
      appointmentId: "appt-123",
      chargeStatus: "charge_failed",
      noShowChargeRecordId: "nsr-123",
    });
    assert.equal(errors.length, 1);
  `);
});

test("default charge command preserves original admin audit on manual-followup replay", () => {
  runRouteScenario(`
    const record = {
      id: "nsr-123",
      status: "provider_draft_created",
      maxChargeCents: 15000,
      currency: "CAD",
      adminActionAt: undefined,
      adminOperatorId: undefined,
      adminReason: undefined,
      adminEligibilityCheckedAt: undefined,
    };
    const repository = createMinimalNoShowRepository({
      async getNoShowChargeRecordById(id) {
        return { ...record, id };
      },
      async recordNoShowAdminAction(input) {
        // Simulate the original repository behaviour: unconditional overwrite.
        record.adminActionAt = input.now;
        record.adminOperatorId = input.operatorId;
        record.adminReason = input.reason;
        record.adminEligibilityCheckedAt = input.now;
        return { recorded: true };
      },
    });
    const now = new Date("2026-06-20T14:00:00Z");

    const firstResult = await defaultChargeNoShowCommand({
      amountCents: 15000,
      appointmentId: "appt-123",
      holdId: "hold-123",
      idempotencyKey: "idem-1",
      noShowChargeRecordId: "nsr-123",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, {
      getSquareServiceBookingEnv: () => null,
      getNow: () => now,
      createRepository: async () => repository,
      createSquareInvoicesClient: () => { throw new Error("Square client should not be created"); },
      createAlerts: () => ({ alert: () => {} }),
      logError: () => {},
    });

    assert.deepEqual(firstResult, {
      appointmentId: "appt-123",
      chargeStatus: "manual_followup",
      noShowChargeRecordId: "nsr-123",
    });
    assert.equal(record.adminOperatorId, "staff-nataliea");
    assert.equal(record.adminReason, "Client did not attend");
    assert.deepEqual(record.adminActionAt, now);
    assert.deepEqual(record.adminEligibilityCheckedAt, now);

    const replayNow = new Date("2026-06-20T14:01:00Z");
    const secondResult = await defaultChargeNoShowCommand({
      amountCents: 15000,
      appointmentId: "appt-123",
      holdId: "hold-123",
      idempotencyKey: "idem-2",
      noShowChargeRecordId: "nsr-123",
      operatorId: "staff-other",
      reason: "Different reason",
    }, {
      getSquareServiceBookingEnv: () => null,
      getNow: () => replayNow,
      createRepository: async () => repository,
      createSquareInvoicesClient: () => { throw new Error("Square client should not be created"); },
      createAlerts: () => ({ alert: () => {} }),
      logError: () => {},
    });

    assert.deepEqual(secondResult, {
      appointmentId: "appt-123",
      chargeStatus: "manual_followup",
      noShowChargeRecordId: "nsr-123",
    });
    assert.equal(record.adminOperatorId, "staff-nataliea");
    assert.equal(record.adminReason, "Client did not attend");
    assert.deepEqual(record.adminActionAt, now);
    assert.deepEqual(record.adminEligibilityCheckedAt, now);
  `);
});

test("default charge command returns charge_failed when no-show record is missing during manual followup", () => {
  runRouteScenario(`
    const errors = [];
    const result = await defaultChargeNoShowCommand({
      amountCents: 15000,
      appointmentId: "appt-123",
      holdId: "hold-123",
      idempotencyKey: "idem-1",
      noShowChargeRecordId: "missing-nsr",
      operatorId: "staff-nataliea",
      reason: "Client did not attend",
    }, {
      getSquareServiceBookingEnv: () => null,
      getNow: () => new Date("2026-06-20T14:00:00Z"),
      createRepository: async () => createMinimalNoShowRepository({
        async recordNoShowAdminAction() {
          throw new Error("No-show charge record not found");
        },
      }),
      createSquareInvoicesClient: () => { throw new Error("Square client should not be created"); },
      createAlerts: () => ({ alert: () => {} }),
      logError: (message, context) => errors.push({ message, context }),
    });

    assert.deepEqual(result, {
      appointmentId: "appt-123",
      chargeStatus: "charge_failed",
      noShowChargeRecordId: "missing-nsr",
    });
    assert.equal(errors.length, 1);
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario =
    helperScript + "\nvoid (async () => {\n" + assertions + "\n})()";
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
