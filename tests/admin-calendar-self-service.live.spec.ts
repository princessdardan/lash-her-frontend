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
  "Employee busy calendar live browser smoke";

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

  test("employee discovers a live calendar and owner can promote it", async ({
    browser,
  }) => {
    await disablePriorLiveAssignment(browser);

    const employeePage = await newAuthenticatedPage(
      browser,
      EMPLOYEE_STORAGE_STATE!,
    );
    await employeePage.goto("/admin/my-calendar");

    const employeeAccountCard = employeePage.locator("article").filter({
      hasText: EMPLOYEE_CONNECTION_EMAIL!,
    });
    await expect(employeeAccountCard).toBeVisible();
    const employeeAssignmentForm = employeeAccountCard.locator("form").filter({
      hasText: "Add busy calendar",
    });
    await employeeAssignmentForm.getByLabel("Provider resource").selectOption({
      label: RESOURCE_NAME!,
    });
    await selectOptionContaining(
      employeeAssignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL!,
    );
    await employeeAssignmentForm
      .getByLabel("Display label")
      .fill(ASSIGNMENT_LABEL);
    await employeeAssignmentForm
      .getByRole("button", { name: "Add busy calendar" })
      .click();

    await expect(
      employeePage.getByText("Busy calendar assignment saved."),
    ).toBeVisible();
    const busyAssignment = employeeAccountCard
      .locator("div.rounded-xl")
      .filter({ hasText: ASSIGNMENT_LABEL });
    await expect(
      busyAssignment.getByText("Blocks busy time", { exact: true }),
    ).toBeVisible();
    await expect(busyAssignment.getByText(/Receives bookings/)).toHaveCount(0);
    await employeePage.context().close();

    const ownerPage = await newAuthenticatedPage(browser, OWNER_STORAGE_STATE!);
    await ownerPage.goto("/admin/calendar-connections");
    const ownerAccountCard = ownerPage.locator("article").filter({
      hasText: EMPLOYEE_CONNECTION_EMAIL!,
    });
    const ownerAssignmentForm = ownerAccountCard.locator("form").filter({
      hasText: "Assign calendar",
    });
    await ownerAssignmentForm.getByLabel("Resource").selectOption({
      label: RESOURCE_NAME!,
    });
    await selectOptionContaining(
      ownerAssignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL!,
    );
    await ownerAssignmentForm
      .getByLabel("Display label")
      .fill(ASSIGNMENT_LABEL);
    await ownerAssignmentForm.getByLabel("Receives new bookings").check();
    await ownerAssignmentForm
      .getByRole("button", { name: "Save assignment" })
      .click();

    await expect(
      ownerPage.getByText("Calendar assignment saved."),
    ).toBeVisible();
    const writeAssignment = ownerAccountCard
      .locator("div.rounded-xl")
      .filter({ hasText: ASSIGNMENT_LABEL });
    await expect(writeAssignment.getByText(/Receives bookings/)).toBeVisible();
    await ownerPage.context().close();
  });
});

async function disablePriorLiveAssignment(browser: Browser): Promise<void> {
  const page = await newAuthenticatedPage(browser, OWNER_STORAGE_STATE!);
  await page.goto("/admin/calendar-connections");
  const accountCard = page.locator("article").filter({
    hasText: EMPLOYEE_CONNECTION_EMAIL!,
  });
  const priorAssignment = accountCard
    .locator("div.rounded-xl")
    .filter({ hasText: ASSIGNMENT_LABEL })
    .first();

  const disableButton = priorAssignment.getByRole("button", {
    name: "Disable",
  });
  if ((await disableButton.count()) > 0) {
    page.once("dialog", (dialog) => dialog.accept());
    await disableButton.click();
    await expect(page.getByText("Calendar assignment disabled.")).toBeVisible();
  }

  await page.context().close();
}

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
