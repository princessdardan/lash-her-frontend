import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const database = process.env.LEARNING_E2E_DATABASE_URL;
if (!database || !["127.0.0.1", "localhost"].includes(new URL(database).hostname)) throw new Error("Set LEARNING_E2E_DATABASE_URL to an isolated migrated local PostgreSQL database");
const token = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url")}.fixture`;
export default defineConfig({
  testDir: ".", testMatch: "learning.spec.ts", outputDir: "../test-results/learning", workers: 1, timeout: 60_000, reporter: "list",
  use: { baseURL: "http://127.0.0.1:3111", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }],
  webServer: {
    command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3111", cwd: path.resolve(__dirname, ".."), url: "http://127.0.0.1:3111/courses", reuseExistingServer: false, timeout: 120_000,
    env: {
      LEARNING_E2E_FIXTURE: "1", DATABASE_URL: database, FRONTEND_WRITER_ADMISSION_MODE: "off", CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true", INTEGRATION_COURSE_READS_ENABLED: "true", INTEGRATION_LEARNING_ROUTES_ENABLED: "true",
      CUSTOMER_AUTH_URL: "http://127.0.0.1:3111", CUSTOMER_AUTH_SECRET: "learning-e2e-customer-auth-secret-0123456789", CUSTOMER_AUTH_GOOGLE_ID: "learning-e2e-google-client", CUSTOMER_AUTH_GOOGLE_SECRET: "learning-e2e-google-secret", CUSTOMER_AUTH_RESEND_KEY: "learning-e2e-resend-key", CUSTOMER_AUTH_EMAIL_FROM: "Learning <test@example.invalid>",
      AUTH_URL: "http://127.0.0.1:3111", AUTH_SECRET: "learning-e2e-admin-auth-secret-0123456789", AUTH_GOOGLE_ID: "learning-e2e-admin-google-client", AUTH_GOOGLE_SECRET: "learning-e2e-admin-google-secret",
      COURSE_LEARNER_JWT_CURRENT_SECRET: "learning-e2e-course-learner-secret-0123456789", COURSE_LEARNER_JWT_PREVIOUS_SECRET: "", API_GATEWAY_STAGING_ORIGIN: "https://learning-gateway.example.invalid", VERCEL_OIDC_TOKEN: token, VERCEL_OIDC_TOKEN_FILE: "",
      APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", APP_VERCEL_TEAM_ID: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", VERCEL_PROJECT_ID: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
      NEXT_PUBLIC_SANITY_PROJECT_ID: "7o23yrvk", NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10", SANITY_API_READ_TOKEN: "", SANITY_WRITE_TOKEN: "", RESEND_API_KEY: "", KV_REST_API_URL: "", KV_REST_API_TOKEN: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      NODE_OPTIONS: `--require=${path.resolve(__dirname, "support/learning-fetch-fixture.cjs")}`,
    },
  },
});
