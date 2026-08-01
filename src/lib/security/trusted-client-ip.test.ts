import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBookingAbuseKey,
  getTrustedClientIp,
} from "./trusted-client-ip";

test("Vercel-controlled forwarding is authoritative in launch environments", () => {
  const headers = new Headers({
    "x-forwarded-for": "192.0.2.4",
    "x-real-ip": "192.0.2.5",
    "x-vercel-forwarded-for": "203.0.113.8, 198.51.100.4",
  });
  assert.equal(getTrustedClientIp(headers, { VERCEL: "1" }), "203.0.113.8");
  assert.equal(getTrustedClientIp(new Headers({
    "x-forwarded-for": "192.0.2.4",
  }), { VERCEL_ENV: "production" }), null);
});

test("local and test environments explicitly retain existing fallbacks", () => {
  assert.equal(getTrustedClientIp(new Headers({
    "x-forwarded-for": "203.0.113.8, 198.51.100.4",
    "x-real-ip": "198.51.100.9",
  }), {}), "203.0.113.8");
  assert.equal(getTrustedClientIp(new Headers({
    "x-forwarded-for": "not-an-ip",
    "x-real-ip": "198.51.100.9",
  }), {}), "198.51.100.9");
});

test("untrusted headers are ignored and rate-limit keys never contain raw IPs", () => {
  const headers = new Headers({
    "cf-connecting-ip": "192.0.2.2",
    "x-client-ip": "192.0.2.3",
    "x-forwarded-for": "203.0.113.8",
  });
  const key = buildBookingAbuseKey({
    environment: {},
    headers,
    scope: "availability",
    subject: "Classic-Fill",
  });

  assert.equal(getTrustedClientIp(new Headers({
    "cf-connecting-ip": "192.0.2.2",
  })), null);
  assert.ok(key);
  assert.match(key, /^booking:abuse:availability:[a-f0-9]{32}:[a-f0-9]{32}$/);
  assert.equal(key.includes("203.0.113.8"), false);
  assert.equal(key.includes("classic-fill"), false);
});

test("missing Vercel client identity fails closed instead of sharing a global key", () => {
  assert.equal(buildBookingAbuseKey({
    environment: { VERCEL_ENV: "production" },
    headers: new Headers({ "x-forwarded-for": "203.0.113.8" }),
    scope: "hold-attempts",
    subject: "classic-fill",
  }), null);
});
