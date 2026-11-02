import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "landing-pages.spec.ts",
  reporter: "list",
  use: { ...devices["Desktop Chrome"], screenshot: "only-on-failure" },
});
