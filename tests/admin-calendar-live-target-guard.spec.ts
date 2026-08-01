import { expect, test } from "@playwright/test";

import {
  ADMIN_CALENDAR_LIVE_TARGET_CONFIRMATION,
  assertAdminCalendarLiveTarget,
} from "./support/admin-calendar-live-target-guard";

const confirmation = {
  confirmation: ADMIN_CALENDAR_LIVE_TARGET_CONFIRMATION,
  environment: {},
};

test("live calendar target guard refuses production runtime markers", () => {
  expect(() =>
    assertAdminCalendarLiveTarget({
      ...confirmation,
      baseUrl: "https://calendar-e2e.example.test",
      confirmedIsolatedOrigin: "https://calendar-e2e.example.test",
      environment: { VERCEL_ENV: "production" },
    }),
  ).toThrow("cannot run in a production-like runtime");
});

test("live calendar target guard refuses known and production-like targets", () => {
  for (const baseUrl of [
    "https://lashher.com",
    "https://www.lashher.com",
    "https://lash-her-frontend.vercel.app",
    "https://staging.lashher.com",
    "https://calendar-prod.example.com",
  ]) {
    expect(() =>
      assertAdminCalendarLiveTarget({
        ...confirmation,
        baseUrl,
        confirmedIsolatedOrigin: baseUrl,
      }),
    ).toThrow("refuses production-like target");
  }
});

test("live calendar target guard refuses an arbitrary remote target", () => {
  expect(() =>
    assertAdminCalendarLiveTarget({
      ...confirmation,
      baseUrl: "https://calendar.example.com",
      confirmedIsolatedOrigin: "https://calendar.example.com",
    }),
  ).toThrow("refuses arbitrary remote target");
});

test("live calendar target guard requires exact target-bound confirmation", () => {
  expect(() =>
    assertAdminCalendarLiveTarget({
      baseUrl: "https://calendar-e2e.example.com",
      confirmedIsolatedOrigin: "https://other-e2e.example.com",
      confirmation: ADMIN_CALENDAR_LIVE_TARGET_CONFIRMATION,
      environment: {},
    }),
  ).toThrow("must exactly match");

  expect(() =>
    assertAdminCalendarLiveTarget({
      baseUrl: "https://calendar-e2e.example.com",
      confirmedIsolatedOrigin: "https://calendar-e2e.example.com",
      environment: {},
    }),
  ).toThrow("BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_LIVE_TARGET");
});

test("live calendar target guard accepts an explicitly confirmed isolated target", () => {
  expect(
    assertAdminCalendarLiveTarget({
      ...confirmation,
      baseUrl: "https://calendar-e2e.example.com/",
      confirmedIsolatedOrigin: "https://calendar-e2e.example.com",
    }),
  ).toBe("https://calendar-e2e.example.com");

  expect(
    assertAdminCalendarLiveTarget({
      ...confirmation,
      baseUrl: "http://[::1]:3000",
      confirmedIsolatedOrigin: "http://[::1]:3000",
    }),
  ).toBe("http://[::1]:3000");
});
