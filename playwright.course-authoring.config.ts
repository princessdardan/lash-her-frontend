import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/course-authoring-browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: "test-results/course-authoring-browser",
  use: {
    baseURL: process.env.COURSE_AUTHORING_BROWSER_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
