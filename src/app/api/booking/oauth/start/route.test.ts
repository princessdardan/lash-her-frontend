import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { consumeBookingCalendarOAuthState } from "@/lib/booking/operational-store";
import { GET } from "./route";

test("legacy Calendar OAuth start refuses before the consent redirect when admission is unavailable", async () => {
  const original = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-owned-fixture";
  try {
    const response = await GET(new NextRequest("https://owned.example.invalid/api/booking/oauth/start"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    if (original === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = original;
  }
});

test("Calendar OAuth state transport never retries a lost consume receipt", async (context) => {
  const state = "calendar_abcdefghijklmnopqrstuvwxyz123456";
  const fixtureEnv = {
    GOOGLE_CLIENT_ID: "owned-client",
    GOOGLE_CLIENT_SECRET: "owned-client-secret",
    GOOGLE_REDIRECT_URI: "https://owned.example.invalid/api/booking/oauth/callback",
    BOOKING_ADMIN_SETUP_SECRET: "owned-booking-setup",
    KV_REST_API_URL: "https://owned-redis.example.invalid",
    KV_REST_API_TOKEN: "owned-redis-token",
  };
  const original = Object.entries(fixtureEnv).map(([key, value]) => {
    const previous = process.env[key];
    process.env[key] = value;
    return [key, previous] as const;
  });
  let attempts = 0;
  context.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    assert.equal(new URL(input).origin, fixtureEnv.KV_REST_API_URL);
    const payload = JSON.parse(String(options.body));
    const pipelined = Array.isArray(payload[0]);
    const command = pipelined ? payload[0] : payload;
    assert.equal(command[0], "eval");
    assert.equal(command[3], `booking:calendar-oauth-state:${state}`);
    if (++attempts === 1) throw new Error("owned transport lost the consume receipt");
    return Response.json(pipelined ? [{ result: [0] }] : { result: [0] });
  });

  try {
    await assert.rejects(
      consumeBookingCalendarOAuthState(state),
      /owned transport lost the consume receipt/,
    );
    assert.equal(attempts, 1);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
