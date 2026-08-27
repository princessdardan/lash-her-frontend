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
const commerceProviderFixturePreload = path.resolve(
  "tests/support/commerce-provider-fetch-fixture.cjs",
);
const adminCalendarE2EDatabaseUrl = getAdminCalendarE2EDatabaseUrl();
const commerceEnabledE2E =
  process.env.COMMERCE_E2E_ENABLED_MODE === "1" &&
  adminCalendarE2EDatabaseUrl !== null;

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
  reporter: process.env.CI
    ? [
        ["line"],
        ["json", { outputFile: "test-results/playwright-results.json" }],
        ["html", { open: "never" }],
      ]
    : "html",
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
      // The Google Calendar fixture must be required LAST so it is the outermost
      // globalThis.fetch wrapper. Both fixtures answer the shared mock Upstash
      // origin (https://e2e-redis.invalid); only the Google fixture returns the
      // Redis "OK" reply the calendar OAuth-state store requires, and it is
      // selective — it delegates every command it does not own (commerce
      // Redis/Chit Chats/Resend traffic) to the inner commerce fixture. Loading
      // commerce outermost instead makes it swallow the OAuth-state SET and the
      // calendar connect flow 503s (see admin-calendar-self-service OAuth).
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${commerceProviderFixturePreload}`,
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
      ...(commerceEnabledE2E
        ? {
            ADDRESS_CHANGE_TOKEN_SECRET:
              "e2e-address-change-token-secret-0123456789ABCDEF",
            ADMIN_OWNER_EMAILS: "commerce-e2e-owner@example.invalid",
            CHECKOUT_PII_ENCRYPTION_KEY:
              "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=",
            CHECKOUT_SECRET_ENCRYPTION_KEY:
              "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
            CHITCHATS_ACCESS_TOKEN: "e2e-chitchats-access-token",
            CHITCHATS_CHECKOUT_ENABLED: "true",
            CHITCHATS_CLIENT_ID: "commerce-e2e-client",
            CHITCHATS_ENVIRONMENT: "staging",
            CHITCHATS_QUOTE_SIGNING_SECRET:
              "e2e-quote-signing-secret-0123456789-ABCDEFGH",
            CHITCHATS_REGION: "ontario_manitoba",
            CHITCHATS_SHIPPING_ENABLED: "true",
            CHITCHATS_TRACKED_POSTAGE_TYPES:
              "chit_chats_canada_tracked,chit_chats_us_edge",
            CHITCHATS_US_SHIPPING_ENABLED: "true",
            CHITCHATS_WORKER_CRON_SECRET:
              "e2e-worker-cron-secret-0123456789-ABCDEFGHIJ",
            COMMERCE_E2E_CATALOG_FIXTURE: "1",
            COMMERCE_E2E_ENABLED_MODE: "1",
            COMMERCE_E2E_ISOLATED_TEST_DATABASE: "1",
            COMMERCE_E2E_PROVIDER_FIXTURE: "1",
            CRON_SECRET: "e2e-cron-secret-0123456789-ABCDEFGHIJKLMNOP",
            ADMIN_EMAIL: "commerce-e2e-owner@example.invalid",
            FROM_EMAIL: "Lash Her E2E <e2e@example.invalid>",
            MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
            NEXT_PUBLIC_SANITY_API_VERSION: "2026-03-24",
            NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
            NEXT_PUBLIC_SANITY_PROJECT_ID: "3auncj84",
            NEXT_PUBLIC_SITE_URL: "https://e2e.lashher.invalid",
            PAYMENT_GATEWAY_MODE: "live",
            RESEND_API_KEY: "re_e2e_deterministic_fixture",
            SERVICE_BOOKING_SQUARE_ENABLED: "true",
            SHIPPING_DECISION_TOKEN_SECRET:
              "e2e-shipping-decision-secret-0123456789-ABCDEFGH",
            SHIPPING_POLICY_ENFORCEMENT_MODE: "enforce",
            // Deterministic sandbox-shaped Square fixtures. Product/training
            // (SQUARE_COMMERCE_ENABLED) and service-booking
            // (SERVICE_BOOKING_SQUARE_ENABLED) checkout are both enabled so the
            // storefront and booking availability gates open. Values are inert
            // fixtures (never real credentials) and the *.invalid return/webhook
            // URLs never resolve; the commerce provider preload
            // (tests/support/commerce-provider-fetch-fixture.cjs) refuses any
            // outbound Square API call so no test reaches Square's endpoints.
            SQUARE_ACCESS_TOKEN: "EAAAe2e-sandbox-square-access-token-fixture",
            SQUARE_APPLICATION_ID: "sandbox-sq0idb-e2e-fixture-application-id",
            SQUARE_COMMERCE_ENABLED: "true",
            SQUARE_ENVIRONMENT: "sandbox",
            SQUARE_LOCATION_ID: "E2ELOCATIONFIXTURE1",
            SQUARE_SERVICE_BOOKING_RETURN_URL:
              "https://e2e.lashher.invalid/api/booking/square/return",
            SQUARE_SERVICE_BOOKING_WEBHOOK_URL:
              "https://e2e.lashher.invalid/api/webhooks/square",
            SQUARE_WEBHOOK_SIGNATURE_KEY:
              "e2e-square-webhook-signature-key-fixture",
            SUPPLEMENTAL_PRODUCT_PAYMENTS_ENABLED: "true",
          }
        : {}),
    },
    url: "http://localhost:3000",
    // The spawned process carries deterministic server-side transport fixtures.
    // Reusing an arbitrary dev server could silently send fixture OAuth codes
    // to Google's real endpoints.
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
});
