import { defineConfig, devices } from "@playwright/test";

// Actual React checkout components with deterministic SDK/API boundaries.
// No dev server, database, credentials, or outbound payment requests required.
export default defineConfig({
  testDir: ".",
  testMatch: "square-afterpay.spec.ts",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: { ...devices["Desktop Chrome"] },
});
