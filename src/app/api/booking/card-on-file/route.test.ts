import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import test from "node:test";

import type {
  CardOnFileBookingRequestBody,
  CardOnFileBookingResult,
} from "@/lib/booking/payments/service-card-on-file";

import { createCardOnFilePostHandler } from "./route";

const defaultPostScript = String.raw`
  import assert from "node:assert/strict";

  import { POST } from "./src/app/api/booking/card-on-file/route.ts";

  (async () => {
    const request = new Request("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cardholderName: "Client Name",
        holdReference: "hold_public_1",
        idempotencyKey: "idem-key-1",
        policy: {
          accepted: true,
          maxChargeCents: 15000,
          policyTextHash: "hash",
          policyVersion: "v1",
        },
        sourceId: "cnon:card-token",
      }),
    });

    const response = await POST(request);

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Card-on-file booking is not enabled");
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

test("default POST returns 404 when card-on-file booking is disabled", () => {
  const result = runTsx(defaultPostScript, { ...process.env });

  assert.equal(result.status, 0);
});

test("factory returns 400 for invalid JSON body", async () => {
  const { handler, alertCalls } = createHandler();

  const response = await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      body: "not-json",
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
  assert.equal(alertCalls.length, 0);
});

test("factory returns 400 for missing policy acceptance", async () => {
  const { handler, alertCalls } = createHandler();

  const response = await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cardholderName: "Client Name",
        holdReference: "hold_public_1",
        idempotencyKey: "idem-key-1",
        policy: {
          accepted: false,
          maxChargeCents: 15000,
          policyTextHash: "hash",
          policyVersion: "v1",
        },
        sourceId: "cnon:card-token",
      }),
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(alertCalls.length, 0);
});

test("factory returns 409 when hold is unavailable", async () => {
  const { handler, alertCalls } = createHandler({
    runCardOnFileBooking: async () => ({
      ok: false,
      error: "hold_unavailable",
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

test("factory returns 502 on Square card/customer API failure", async () => {
  const { handler, alertCalls } = createHandler({
    runCardOnFileBooking: async () => ({
      ok: false,
      error: "square_api_error",
      message: "Square card save failed",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Unable to save card with payment provider",
  });
  assert.equal(alertCalls.length, 1);
  const alert = alertCalls[0] as { category: string; severity: string };
  assert.equal(alert.category, "square_card_save_failed");
  assert.equal(alert.severity, "warning");
});

test("factory returns 503 on infrastructure failure", async () => {
  const { handler, alertCalls } = createHandler({
    runCardOnFileBooking: async () => ({
      ok: false,
      error: "infrastructure_error",
      message: "Database unavailable",
    }),
  });

  const response = await handler(createValidRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Unable to complete booking confirmation",
  });
  assert.equal(alertCalls.length, 1);
  const alert = alertCalls[0] as { category: string; severity: string };
  assert.equal(alert.category, "stuck_payment_state");
  assert.equal(alert.severity, "error");
});

test("factory returns 200 with safe response on successful card-on-file booking", async () => {
  const { handler } = createHandler({
    runCardOnFileBooking: async () => ({
      ok: true,
      bookingStatus: "booked",
      card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
      holdReference: "hold_public_1",
      noShowChargeStatus: "ready",
    }),
  });

  const response = await handler(createValidRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    bookingStatus: "booked",
    card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
    holdReference: "hold_public_1",
    noShowChargeStatus: "ready",
  });
  const bodyText = JSON.stringify(body);
  assert.ok(!bodyText.includes("sourceId"));
  assert.ok(!bodyText.includes("cnon:card-token"));
  assert.ok(!bodyText.includes("verificationToken"));
  assert.ok(!bodyText.includes("squareCustomerId"));
  assert.ok(!bodyText.includes("squareCardId"));
});

function createValidRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/booking/card-on-file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cardholderName: "Client Name",
      holdReference: "hold_public_1",
      idempotencyKey: "idem-key-1",
      policy: {
        accepted: true,
        maxChargeCents: 15000,
      },
      sourceId: "cnon:card-token",
      verificationToken: "verf-token",
    }),
  });
}

test("factory accepts policy without client-supplied text hash or version", async () => {
  const { handler } = createHandler();

  const response = await handler(createValidRequest());

  assert.equal(response.status, 200);
});

test("factory passes IP and user-agent audit inputs to runner", async () => {
  let capturedInput: CardOnFileBookingRequestBody | undefined;

  const { handler } = createHandler({
    runCardOnFileBooking: async (input) => {
      capturedInput = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      };
    },
  });

  const response = await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.1, 198.51.100.2",
        "user-agent": "LashHerTest/1.0",
      },
      body: JSON.stringify({
        cardholderName: "Client Name",
        holdReference: "hold_public_1",
        idempotencyKey: "idem-key-1",
        policy: { accepted: true, maxChargeCents: 15000 },
        sourceId: "cnon:card-token",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(capturedInput?.ipAddress, "203.0.113.1");
  assert.equal(capturedInput?.userAgent, "LashHerTest/1.0");
});

test("factory falls back to x-real-ip for audit input", async () => {
  let capturedInput: CardOnFileBookingRequestBody | undefined;

  const { handler } = createHandler({
    runCardOnFileBooking: async (input) => {
      capturedInput = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      };
    },
  });

  await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "198.51.100.9",
      },
      body: JSON.stringify({
        cardholderName: "Client Name",
        holdReference: "hold_public_1",
        idempotencyKey: "idem-key-1",
        policy: { accepted: true, maxChargeCents: 15000 },
        sourceId: "cnon:card-token",
      }),
    }),
  );

  assert.equal(capturedInput?.ipAddress, "198.51.100.9");
});

test("factory ignores client-supplied policyTextHash and policyVersion", async () => {
  let capturedInput: CardOnFileBookingRequestBody | undefined;

  const { handler } = createHandler({
    runCardOnFileBooking: async (input) => {
      capturedInput = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      };
    },
  });

  const response = await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cardholderName: "Client Name",
        holdReference: "hold_public_1",
        idempotencyKey: "idem-key-1",
        policy: {
          accepted: true,
          maxChargeCents: 15000,
          policyTextHash: "client-hash",
          policyVersion: "client-version",
        },
        sourceId: "cnon:card-token",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    (capturedInput?.policy as { policyTextHash?: string }).policyTextHash,
    undefined,
  );
  assert.equal(
    (capturedInput?.policy as { policyVersion?: string }).policyVersion,
    undefined,
  );
});

test("factory ignores client-supplied billingPostalCode", async () => {
  let capturedInput: CardOnFileBookingRequestBody | undefined;

  const { handler } = createHandler({
    runCardOnFileBooking: async (input) => {
      capturedInput = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      };
    },
  });

  const response = await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cardholderName: "Client Name",
        holdReference: "hold_public_1",
        idempotencyKey: "idem-key-1",
        policy: { accepted: true, maxChargeCents: 15000 },
        sourceId: "cnon:card-token",
        billingPostalCode: "M5H 2N2",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal("billingPostalCode" in (capturedInput ?? {}), false);
});

function createHandler(
  overrides: Partial<{
    runCardOnFileBooking: (
      input: CardOnFileBookingRequestBody,
    ) => Promise<CardOnFileBookingResult>;
  }> = {},
) {
  const alertCalls: unknown[] = [];
  const handler = createCardOnFilePostHandler({
    alerts: {
      alert(input) {
        alertCalls.push(input);
      },
    },
    runCardOnFileBooking:
      overrides.runCardOnFileBooking ??
      (async () => ({
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      })),
  });

  return { alertCalls, handler };
}

function runTsx(
  script: string,
  env: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
} {
  const result = spawnSync("./node_modules/.bin/tsx", ["--eval", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: "pipe",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combinedOutput: `${result.stdout}${result.stderr}`,
  };
}
