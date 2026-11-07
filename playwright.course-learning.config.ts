import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/course-learning-browser",
  testMatch: "learning.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "test-results/course-learning-browser",
  use: {
    baseURL: process.env.COURSE_LEARNING_BROWSER_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
