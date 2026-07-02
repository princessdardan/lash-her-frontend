import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import test from "node:test";

import type {
  ChargeAndStoreBookingRequestBody,
  ChargeAndStoreBookingResult,
} from "@/lib/booking/payments/service-charge-and-store";

import type { ServicePaymentAlertInput } from "@/lib/booking/payments/service-payment-alerts";

import { createServiceBookingPaymentConfirmPostHandler, POST } from "./route";

const VALID_CONFIRM_BODY = {
  paymentSessionReference: "pay_sess_1",
  customer: {
    name: "Client Name",
    email: "client@example.test",
    phone: "5551234567",
    marketingOptIn: false,
  },
  payment: {
    option: "full" as const,
    expectedAmountCents: 15500,
  },
  policy: {
    accepted: true,
    policyVersion: "v1",
    policyTextHash: "hash",
  },
  sourceId: "cnon:card-token",
  idempotencyKey: "idem-key-1",
  verificationToken: "verf-token",
};

function createValidRequest(
  bodyOverrides?: Record<string, unknown>,
): NextRequest {
  return new NextRequest("http://localhost:3000/api/booking/payment/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...VALID_CONFIRM_BODY, ...bodyOverrides }),
  });
}

function createHandler(
  overrides: Partial<{
    confirm: (
      input: ChargeAndStoreBookingRequestBody,
    ) => Promise<ChargeAndStoreBookingResult>;
  }> = {},
) {
  const alertCalls: ServicePaymentAlertInput[] = [];
  const handler = createServiceBookingPaymentConfirmPostHandler({
    alerts: {
      alert(input: ServicePaymentAlertInput) {
        alertCalls.push(input);
      },
    },
    confirm: async (input: ChargeAndStoreBookingRequestBody) =>
      overrides.confirm?.(input) ?? {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        paymentStatus: "captured",
      },
  });

  return { alertCalls, handler };
}

test("rejects missing customer details before orchestration", async () => {
  let called = false;
  const { handler, alertCalls } = createHandler({
    confirm: async () => {
      called = true;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { last4: "4242" },
        holdReference: "hold_public_1",
        paymentStatus: "captured",
      };
    },
  });

  const response = await handler(
    createValidRequest({
      customer: { ...VALID_CONFIRM_BODY.customer, name: "   " },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.equal(alertCalls.length, 0);
});

test("rejects unchecked consent before orchestration", async () => {
  let called = false;
  const { handler, alertCalls } = createHandler({
    confirm: async () => {
      called = true;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { last4: "4242" },
        holdReference: "hold_public_1",
        paymentStatus: "captured",
      };
    },
  });

  const response = await handler(
    createValidRequest({
      policy: { ...VALID_CONFIRM_BODY.policy, accepted: false },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.equal(alertCalls.length, 0);
});

test("passes client IP and user agent to orchestration", async () => {
  let captured: ChargeAndStoreBookingRequestBody | undefined;
  const { handler } = createHandler({
    confirm: async (input) => {
      captured = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { last4: "4242" },
        holdReference: "hold_public_1",
        paymentStatus: "captured",
      };
    },
  });

  const response = await handler(
    new NextRequest("http://localhost:3000/api/booking/payment/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.1, 198.51.100.2",
        "user-agent": "LashHerTest/1.0",
      },
      body: JSON.stringify(VALID_CONFIRM_BODY),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(captured?.ipAddress, "203.0.113.1");
  assert.equal(captured?.userAgent, "LashHerTest/1.0");
});

test("maps hold_unavailable to 409", async () => {
  const { handler, alertCalls } = createHandler({
    confirm: async () => ({
      ok: false,
      error: "hold_unavailable" as const,
      message: "Booking hold is no longer available",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Booking hold is no longer available",
  });
  assert.equal(alertCalls.length, 0);
});

test("maps payment_declined to 402", async () => {
  const { handler, alertCalls } = createHandler({
    confirm: async () => ({
      ok: false,
      error: "payment_declined" as const,
      message: "Payment was declined",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: "Payment was declined" });
  assert.equal(alertCalls.length, 0);
});

test("returns safe confirmation response without provider identifiers", async () => {
  const { handler, alertCalls } = createHandler({
    confirm: async () => ({
      ok: true,
      bookingStatus: "booked",
      card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
      holdReference: "hold_public_1",
      paymentStatus: "captured",
    }),
  });

  const response = await handler(createValidRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    bookingStatus: "booked",
    card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
    holdReference: "hold_public_1",
    paymentStatus: "captured",
  });

  const bodyText = JSON.stringify(body);
  assert.ok(!bodyText.includes("sourceId"));
  assert.ok(!bodyText.includes("verificationToken"));
  assert.ok(!bodyText.includes("squarePaymentId"));
  assert.ok(!bodyText.includes("squareCardId"));
  assert.equal(alertCalls.length, 0);
});

test("whitelists card fields in success response", async () => {
  const { handler } = createHandler({
    confirm: async () => ({
      ok: true,
      bookingStatus: "booked",
      card: {
        brand: "VISA",
        expMonth: 12,
        expYear: 2030,
        last4: "4242",
        id: "card_provider_id",
        fingerprint: "fp_123",
      },
      holdReference: "hold_public_1",
      paymentStatus: "captured",
    }),
  });

  const response = await handler(createValidRequest());
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body.card, {
    brand: "VISA",
    expMonth: 12,
    expYear: 2030,
    last4: "4242",
  });
});

test("passes retained marketing opt-in from payment page", async () => {
  let captured: ChargeAndStoreBookingRequestBody | null = null;
  const { handler } = createHandler({
    confirm: async (input) => {
      captured = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { last4: "1111" },
        holdReference: "hold_1",
        paymentStatus: "captured",
      };
    },
  });

  const response = await handler(
    createValidRequest({
      customer: { ...VALID_CONFIRM_BODY.customer, marketingOptIn: true },
    }),
  );

  assert.equal(response.status, 200);
  assert.ok(captured);
  assert.equal(
    (captured as ChargeAndStoreBookingRequestBody).customer.marketingOptIn,
    true,
  );
});

test("POST returns 404 when service booking Square feature is disabled", async () => {
  const original = process.env.SERVICE_BOOKING_SQUARE_ENABLED;
  process.env.SERVICE_BOOKING_SQUARE_ENABLED = "false";

  try {
    const response = await POST(createValidRequest());

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Service booking payment is not enabled",
    });
  } finally {
    if (original === undefined) {
      delete process.env.SERVICE_BOOKING_SQUARE_ENABLED;
    } else {
      process.env.SERVICE_BOOKING_SQUARE_ENABLED = original;
    }
  }
});

test("maps invalid_request to 400", async () => {
  const { handler, alertCalls } = createHandler({
    confirm: async () => ({
      ok: false,
      error: "invalid_request" as const,
      message: "Invalid payment selection",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Invalid payment selection",
  });
  assert.equal(alertCalls.length, 0);
});

test("maps square_api_error to 502 and alerts", async () => {
  const { handler, alertCalls } = createHandler({
    confirm: async () => ({
      ok: false,
      error: "square_api_error" as const,
      message: "Square API unavailable",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Unable to process payment with provider",
  });
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0]?.category, "square_card_save_failed");
});

test("maps infrastructure_error to 503 and alerts", async () => {
  const { handler, alertCalls } = createHandler({
    confirm: async () => ({
      ok: false,
      error: "infrastructure_error" as const,
      message: "Database connection lost",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Unable to complete booking confirmation",
  });
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0]?.category, "stuck_payment_state");
});
