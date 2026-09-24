import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const database = process.env.COURSE_E2E_DATABASE_URL;
if (
  !database ||
  !["127.0.0.1", "localhost"].includes(new URL(database).hostname)
)
  throw new Error(
    "Set COURSE_E2E_DATABASE_URL to an isolated local PostgreSQL database",
  );

export default defineConfig({
  testDir: ".",
  testMatch: "courses.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3107",
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
      "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3107",
    cwd: path.resolve(__dirname, ".."),
    url: "http://127.0.0.1:3107/courses/course-e2e",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      COURSE_E2E_FIXTURE: "1",
      DATABASE_URL: database,
      COURSE_ACCESS_SIGNING_SECRET:
        "course-e2e-only-secret-012345678901234567890123456789",
      NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
      NEXT_PUBLIC_SANITY_PROJECT_ID: "3auncj84",
      SANITY_API_READ_TOKEN: "",
      SANITY_WRITE_TOKEN: "",
      VERCEL_ENV: "",
      VERCEL: "",
      RESEND_API_KEY: "",
      KV_REST_API_URL: "https://course-redis.example.invalid",
      KV_REST_API_TOKEN: "fixture",
      NODE_OPTIONS: `--require=${path.resolve(__dirname, "support/course-fetch-fixture.cjs")}`,
    },
  },
});
