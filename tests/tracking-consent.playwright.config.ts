import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "../test-results/tracking-consent",
  testMatch: "cookie-consent.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3119",
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3119",
    cwd: path.resolve(__dirname, ".."),
    url: "http://127.0.0.1:3119",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      TRACKING_CONSENT_E2E: "1",
      NODE_ENV: "development",
      DATABASE_URL: "",
      TEST_DATABASE_URL: "",
      // Deliberately request tracking: unresolved vendor gates MUST still block it.
      HIGHLEVEL_TRACKING_ENABLED: "true",
      HIGHLEVEL_SYNC_ENABLED: "false",
      HIGHLEVEL_MARKETING_ENABLED: "false",
      HIGHLEVEL_LOCATION_ID: "",
      HIGHLEVEL_CLIENT_ID: "",
      HIGHLEVEL_CLIENT_SECRET: "",
      MARKETING_DELIVERY_PROVIDER: "resend",
      RESEND_API_KEY: "",
      KV_REST_API_URL: "",
      KV_REST_API_TOKEN: "",
      NEXT_PUBLIC_SANITY_PROJECT_ID: "3auncj84",
      NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
      SANITY_API_READ_TOKEN: "",
      SANITY_WRITE_TOKEN: "",
      SQUARE_COMMERCE_ENABLED: "false",
      SERVICE_BOOKING_SQUARE_ENABLED: "false",
      AUTH_SECRET: "isolated-tracking-consent-test-secret",
      VERCEL_ENV: "",
      VERCEL: "",
      NODE_OPTIONS: `--require=${path.resolve(__dirname, "support/tracking-consent-fetch-fixture.cjs")}`,
    },
  },
});
