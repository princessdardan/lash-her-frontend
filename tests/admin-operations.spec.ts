import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createAdminCalendarAuthFixture,
  type AdminCalendarAuthFixture,
} from "./support/admin-calendar-auth-fixture";
import { getAdminCalendarE2EDatabaseUrl } from "./support/admin-calendar-e2e-config";

const hasTestDatabase = getAdminCalendarE2EDatabaseUrl() !== null;
let fixture: AdminCalendarAuthFixture | undefined;

test.describe("admin fulfillment operations", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasTestDatabase,
    "Requires a migrated, isolated TEST_DATABASE_URL.",
  );

  test.beforeAll(async () => {
    fixture = await createAdminCalendarAuthFixture();
  });

  test.afterAll(async () => {
    await fixture?.cleanup();
  });

  test("renders every actionable queue with versioned evidence state", async ({
    browser,
  }) => {
    const page = await newOwnerPage(browser);
    await page.goto("/admin/operations");

    await expect(
      page.getByRole("heading", { name: "Operations", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Payment risk" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Calendar, tax, and policy readiness",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Customer notifications" }),
    ).toBeVisible();
    await expect(page.getByText("Stable ID").first()).toBeVisible();
    await expect(page.getByText("Conflict token").first()).toBeVisible();
    await page.context().close();
  });

  test("shows the exact step-up action and target without executing it", async ({
    browser,
  }) => {
    const page = await newOwnerPage(browser);
    await page.goto(
      "/admin/step-up?returnTo=%2Fadmin%2Foperations&action=risk&target=risk-target-123",
    );

    await expect(
      page.getByRole("heading", { name: "Reauthenticate" }),
    ).toBeVisible();
    await expect(page.getByText("risk", { exact: true })).toBeVisible();
    await expect(
      page.getByText("risk-target-123", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Verify with Google" }),
    ).toBeVisible();
    await page.context().close();
  });
});

async function newOwnerPage(browser: Browser): Promise<Page> {
  if (!fixture) throw new Error("Admin operations fixture is unavailable");
  const context = await browser.newContext({
    storageState: fixture.ownerStorageState,
  });
  return context.newPage();
}
