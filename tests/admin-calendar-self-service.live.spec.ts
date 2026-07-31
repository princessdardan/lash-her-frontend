import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

import { assertAdminCalendarLiveTarget } from "./support/admin-calendar-live-target-guard";

const LIVE_GOOGLE_ENABLED = process.env.BOOKING_ADMIN_E2E_LIVE_GOOGLE === "1";
const CONFIGURED_BASE_URL =
  process.env.BOOKING_ADMIN_E2E_BASE_URL ?? "http://localhost:3000";
const BASE_URL = LIVE_GOOGLE_ENABLED
  ? assertAdminCalendarLiveTarget({
      baseUrl: CONFIGURED_BASE_URL,
      confirmation: process.env.BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_LIVE_TARGET,
      confirmedIsolatedOrigin:
        process.env.BOOKING_ADMIN_E2E_ISOLATED_LIVE_ORIGIN,
      environment: process.env,
    })
  : CONFIGURED_BASE_URL;
const EMPLOYEE_STORAGE_STATE = process.env.BOOKING_ADMIN_EMPLOYEE_STORAGE_STATE;
const OWNER_STORAGE_STATE = process.env.BOOKING_ADMIN_OWNER_STORAGE_STATE;
const EMPLOYEE_CONNECTION_EMAIL =
  process.env.BOOKING_ADMIN_E2E_EMPLOYEE_CONNECTION_EMAIL;
const RESOURCE_NAME = process.env.BOOKING_ADMIN_E2E_RESOURCE_NAME;
const GOOGLE_CALENDAR_LABEL =
  process.env.BOOKING_ADMIN_E2E_GOOGLE_CALENDAR_LABEL;
const ASSIGNMENT_LABEL =
  process.env.BOOKING_ADMIN_E2E_ASSIGNMENT_LABEL ??
  "Contractor busy calendar live browser smoke";

const hasLiveFixture = Boolean(
  LIVE_GOOGLE_ENABLED &&
  EMPLOYEE_STORAGE_STATE &&
  OWNER_STORAGE_STATE &&
  EMPLOYEE_CONNECTION_EMAIL &&
  RESOURCE_NAME &&
  GOOGLE_CALENDAR_LABEL,
);

test.describe("employee calendar self-service live Google smoke", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "The stateful live Google workflow runs once in Chromium.",
  );
  test.skip(
    !hasLiveFixture,
    "Requires the explicitly enabled, isolated live Google Calendar fixture.",
  );

  test("employee discovers a live calendar and can make it the booking destination", async ({
    browser,
  }) => {
    const employeePage = await newAuthenticatedPage(
      browser,
      EMPLOYEE_STORAGE_STATE!,
    );
    await employeePage.goto("/admin/my-calendar");
    const resourceSwitcher = employeePage.getByLabel("Availability for");
    if ((await resourceSwitcher.count()) > 0) {
      await resourceSwitcher.selectOption({ label: RESOURCE_NAME! });
      await employeePage
        .getByRole("button", { name: "Switch resource" })
        .click();
    }

    const employeeAccountCard = employeePage.locator("article").filter({
      hasText: EMPLOYEE_CONNECTION_EMAIL!,
    });
    await expect(employeeAccountCard).toBeVisible();
    const employeeAssignmentForm = employeeAccountCard.locator("form").filter({
      hasText: "Assign calendar",
    });
    const existingAssignment = employeeAccountCard
      .locator("div.rounded-xl")
      .filter({ hasText: ASSIGNMENT_LABEL });
    await selectOptionContaining(
      employeeAssignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL!,
    );
    await employeeAssignmentForm
      .getByLabel("Calendar name")
      .fill(ASSIGNMENT_LABEL);
    await employeeAssignmentForm
      .getByLabel("Receives bookings and blocks busy time")
      .check();
    await employeeAssignmentForm
      .getByRole("button", { name: "Save assignment" })
      .click();

    const replacementDialog = employeePage.getByRole("dialog", {
      name: "Move booking destination?",
    });
    if (await replacementDialog.isVisible()) {
      await replacementDialog
        .getByRole("button", { name: "Move booking destination" })
        .click();
    }

    await expect(
      employeePage.getByText("Calendar assignment saved."),
    ).toBeVisible();
    await expect(
      existingAssignment.getByText(/Receives bookings/),
    ).toBeVisible();
    await employeePage.context().close();

    const ownerPage = await newAuthenticatedPage(browser, OWNER_STORAGE_STATE!);
    await ownerPage.goto("/admin/calendar-connections");
    const ownerAccountCard = ownerPage.locator("article").filter({
      hasText: EMPLOYEE_CONNECTION_EMAIL!,
    });
    const writeAssignment = ownerAccountCard
      .locator("div.rounded-xl")
      .filter({ hasText: ASSIGNMENT_LABEL });
    await expect(writeAssignment.getByText(/Receives bookings/)).toBeVisible();
    await ownerPage.context().close();
  });
});

async function newAuthenticatedPage(
  browser: Browser,
  storageState: string,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState,
  });
  return context.newPage();
}

async function selectOptionContaining(
  select: Locator,
  visibleText: string,
): Promise<void> {
  const value = await select
    .locator("option")
    .filter({ hasText: visibleText })
    .first()
    .getAttribute("value");
  expect(value, `No calendar option contained ${visibleText}`).not.toBeNull();
  await select.selectOption(value!);
}
