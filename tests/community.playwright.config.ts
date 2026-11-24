import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "community.e2e.ts",
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    actionTimeout: 15_000,
    baseURL: "http://127.0.0.1:3120",
  },
});
