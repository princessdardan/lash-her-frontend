import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "header-scroll.spec.ts",
  fullyParallel: true,
  reporter: "list",
  use: { ...devices["Desktop Chrome"] },
});
