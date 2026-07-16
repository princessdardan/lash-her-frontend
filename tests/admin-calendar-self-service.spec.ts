import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

const BASE_URL = process.env.BOOKING_ADMIN_E2E_BASE_URL ?? "http://localhost:3000";
const EMPLOYEE_STORAGE_STATE =
  process.env.BOOKING_ADMIN_EMPLOYEE_STORAGE_STATE;
const OWNER_STORAGE_STATE = process.env.BOOKING_ADMIN_OWNER_STORAGE_STATE;
const EMPLOYEE_CONNECTION_EMAIL =
  process.env.BOOKING_ADMIN_E2E_EMPLOYEE_CONNECTION_EMAIL;
const RESOURCE_NAME = process.env.BOOKING_ADMIN_E2E_RESOURCE_NAME;
const GOOGLE_CALENDAR_LABEL =
  process.env.BOOKING_ADMIN_E2E_GOOGLE_CALENDAR_LABEL;
const ASSIGNMENT_LABEL =
  process.env.BOOKING_ADMIN_E2E_ASSIGNMENT_LABEL ??
  "Employee busy calendar browser test";

const hasLiveFixture = Boolean(
  EMPLOYEE_STORAGE_STATE &&
    OWNER_STORAGE_STATE &&
    EMPLOYEE_CONNECTION_EMAIL &&
    RESOURCE_NAME &&
    GOOGLE_CALENDAR_LABEL,
);

test.describe("employee calendar self-service", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasLiveFixture,
    "Requires employee/owner Auth.js storage states and an isolated active Google Calendar fixture.",
  );

  test("employee can begin OAuth and assign an owned calendar as busy-only", async ({
    browser,
  }) => {
    const page = await newAuthenticatedPage(browser, EMPLOYEE_STORAGE_STATE!);
    await page.goto("/admin/my-calendar");

    await expect(page.getByRole("heading", { name: "My Calendar" })).toBeVisible();

    await page.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({
        body: "<h1>Google authorization request</h1>",
        contentType: "text/html",
        status: 200,
      });
    });
    await page.getByRole("button", { name: "Connect Google account" }).click();
    await expect(
      page.getByRole("heading", { name: "Google authorization request" }),
    ).toBeVisible();

    await page.goto("/admin/my-calendar");
    const accountCard = page.locator("article").filter({
      hasText: EMPLOYEE_CONNECTION_EMAIL!,
    });
    const assignmentForm = accountCard.locator("form").filter({
      hasText: "Add busy calendar",
    });
    await assignmentForm.getByLabel("Provider resource").selectOption({
      label: RESOURCE_NAME!,
    });
    await selectOptionContaining(
      assignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL!,
    );
    await assignmentForm.getByLabel("Display label").fill(ASSIGNMENT_LABEL);
    await assignmentForm.getByRole("button", { name: "Add busy calendar" }).click();

    await expect(page.getByText("Busy calendar assignment saved.")).toBeVisible();
    const assignment = accountCard.locator("div.rounded-xl").filter({
      hasText: ASSIGNMENT_LABEL,
    });
    await expect(assignment.getByText("Blocks busy time", { exact: true })).toBeVisible();
    await expect(assignment.getByText(/Receives bookings/)).toHaveCount(0);
    await page.context().close();
  });

  test("employee is denied owner calendar administration", async ({ browser }) => {
    const page = await newAuthenticatedPage(browser, EMPLOYEE_STORAGE_STATE!);
    await page.goto("/admin/calendar-connections");

    await expect(page).toHaveURL(/\/admin\/not-authorized$/);
    await expect(page.getByRole("heading", { name: "Not authorized" })).toBeVisible();
    await page.context().close();
  });

  test("owner can promote the employee calendar to the booking destination", async ({
    browser,
  }) => {
    const page = await newAuthenticatedPage(browser, OWNER_STORAGE_STATE!);
    await page.goto("/admin/calendar-connections");

    const accountCard = page.locator("article").filter({
      hasText: EMPLOYEE_CONNECTION_EMAIL!,
    });
    const assignmentForm = accountCard.locator("form").filter({
      hasText: "Assign calendar",
    });
    await assignmentForm.getByLabel("Resource").selectOption({
      label: RESOURCE_NAME!,
    });
    await selectOptionContaining(
      assignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL!,
    );
    await assignmentForm.getByLabel("Display label").fill(ASSIGNMENT_LABEL);
    await assignmentForm.getByLabel("Receives new bookings").check();
    await assignmentForm.getByRole("button", { name: "Save assignment" }).click();

    await expect(page.getByText("Calendar assignment saved.")).toBeVisible();
    const assignment = accountCard.locator("div.rounded-xl").filter({
      hasText: ASSIGNMENT_LABEL,
    });
    await expect(assignment.getByText(/Receives bookings/)).toBeVisible();
    await page.context().close();
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
