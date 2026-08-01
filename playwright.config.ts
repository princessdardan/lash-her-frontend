import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  ADMIN_CALENDAR_E2E_AUTH_SECRET,
  ADMIN_CALENDAR_E2E_CREDENTIAL_KEY,
  ADMIN_CALENDAR_E2E_REDIS_ORIGIN,
  getAdminCalendarE2EDatabaseUrl,
} from "./tests/support/admin-calendar-e2e-config";

const googleCalendarFixturePreload = path.resolve(
  "tests/support/google-calendar-fetch-fixture.cjs",
);
const adminCalendarE2EDatabaseUrl = getAdminCalendarE2EDatabaseUrl();

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: "http://localhost:3000",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",

    /* Take screenshot on failure */
    screenshot: "only-on-failure",

    /* Capture video on first retry */
    video: "retain-on-failure",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },

    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },

    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: "npm run dev",
    env: {
      BOOKING_ADMIN_E2E_GOOGLE_FIXTURE: "1",
      NODE_ENV: "development",
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${googleCalendarFixturePreload}`,
      ]
        .filter(Boolean)
        .join(" "),
      ...(adminCalendarE2EDatabaseUrl === null
        ? {}
        : {
            AUTH_GOOGLE_ID: "calendar-e2e-google-client",
            AUTH_GOOGLE_SECRET: "calendar-e2e-google-secret",
            AUTH_SECRET: ADMIN_CALENDAR_E2E_AUTH_SECRET,
            AUTH_URL: "http://localhost:3000",
            BOOKING_ADMIN_SETUP_SECRET: "calendar-e2e-setup-secret",
            BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY:
              ADMIN_CALENDAR_E2E_CREDENTIAL_KEY,
            DATABASE_URL: adminCalendarE2EDatabaseUrl,
            GOOGLE_CLIENT_ID: "calendar-e2e-google-client",
            GOOGLE_CLIENT_SECRET: "calendar-e2e-google-secret",
            GOOGLE_REDIRECT_URI:
              "http://localhost:3000/api/booking/oauth/callback",
            KV_REST_API_TOKEN: "calendar-e2e-redis-token",
            KV_REST_API_URL: ADMIN_CALENDAR_E2E_REDIS_ORIGIN,
          }),
    },
    url: "http://localhost:3000",
    // The spawned process carries deterministic server-side transport fixtures.
    // Reusing an arbitrary dev server could silently send fixture OAuth codes
    // to Google's real endpoints.
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
});
