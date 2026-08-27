import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";

import {
  createAdminCalendarAuthFixture,
  type AdminCalendarAuthFixture,
} from "./support/admin-calendar-auth-fixture";
import { getAdminCalendarE2EDatabaseUrl } from "./support/admin-calendar-e2e-config";

const BASE_URL =
  process.env.BOOKING_ADMIN_E2E_BASE_URL ?? "http://localhost:3000";
const ASSIGNMENT_LABEL =
  process.env.BOOKING_ADMIN_E2E_ASSIGNMENT_LABEL ??
  "Contractor busy calendar browser test";
const GOOGLE_CALENDAR_LABEL = "Browser fixture calendar";
const GOOGLE_REPLACEMENT_CALENDAR_LABEL =
  "Browser fixture replacement calendar";
const REPLACEMENT_ASSIGNMENT_LABEL =
  "Contractor replacement booking calendar browser test";
const GOOGLE_FIXTURE_PRELOAD = path.resolve(
  "tests/support/google-calendar-fetch-fixture.cjs",
);
const hasTestDatabase = getAdminCalendarE2EDatabaseUrl() !== null;
let adminFixture: AdminCalendarAuthFixture | undefined;

test("Google Calendar browser fixture refuses production activation", () => {
  const result = spawnSync(
    process.execPath,
    ["--require", GOOGLE_FIXTURE_PRELOAD, "--eval", "process.exitCode = 0"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BOOKING_ADMIN_E2E_GOOGLE_FIXTURE: "1",
        NODE_ENV: "production",
      },
    },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "The Google Calendar Playwright fixture cannot run in production.",
  );
});

test.describe("employee calendar self-service", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasTestDatabase,
    "Requires a migrated, isolated TEST_DATABASE_URL.",
  );
  test.beforeAll(async () => {
    adminFixture = await createAdminCalendarAuthFixture();
  });
  test.afterAll(async () => {
    await adminFixture?.cleanup();
  });

  test("employee completes OAuth and assigns the persisted calendar as busy-only", async ({
    browser,
  }) => {
    const fixture = requireAdminFixture();
    const page = await newAuthenticatedPage(
      browser,
      fixture.employeeStorageState,
    );
    await page.goto("/admin/my-calendar");

    await expect(
      page.getByRole("heading", { name: "My availability" }),
    ).toBeVisible();
    await expect(
      page.getByText("Showing calendars for Calendar E2E Contractor."),
    ).toBeVisible();
    await expect(page.getByText(/\bEmployees?\b/i)).toHaveCount(0);

    const oauthRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.origin === "https://accounts.google.com" &&
        url.pathname === "/o/oauth2/v2/auth"
      );
    });
    await page
      .getByRole("button", { name: "Connect Google account" })
      .click({ noWaitAfter: true });

    const oauthState = new URL((await oauthRequest).url()).searchParams.get(
      "state",
    );
    expect(oauthState).toMatch(/^(calendar|employee)_[A-Za-z0-9_-]+$/);
    await fixture.persistOAuthState(oauthState!);
    await page.goto(
      `/api/booking/oauth/callback?code=${encodeURIComponent(fixture.oauthCode)}&state=${encodeURIComponent(oauthState!)}`,
    );
    await expect(page).toHaveURL(/\/admin\/my-calendar\?notice=/);
    await expect(
      page.getByText("Google Calendar account connected."),
    ).toBeVisible();

    const storedCredential = await fixture.loadPersistedCredential();
    expect(storedCredential.status).toBe("active");
    expect(storedCredential.credentialSecretRef).toBeNull();
    expect(storedCredential.credentialCiphertext).toMatch(
      /^v1:[^:]+:[^:]+:[^:]+$/,
    );
    expect(storedCredential.credentialCiphertext).not.toBe(
      fixture.expectedRefreshToken,
    );
    expect(storedCredential.credentialCiphertext).not.toContain(
      fixture.expectedRefreshToken,
    );

    const accountCard = page.locator("article").filter({
      hasText: fixture.employeeConnectionEmail,
    });
    await expect(accountCard).toBeVisible();
    const assignmentForm = accountCard.locator("form").filter({
      hasText: "Assign calendar",
    });
    await selectOptionContaining(
      assignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL,
    );
    await assignmentForm.getByLabel("Calendar name").fill(ASSIGNMENT_LABEL);
    await assignmentForm.getByLabel("Blocks busy time only").check();
    await assignmentForm
      .getByRole("button", { name: "Save assignment" })
      .click();

    await expect(page.getByText("Calendar assignment saved.")).toBeVisible();
    const assignment = accountCard.locator("div.rounded-xl").filter({
      hasText: ASSIGNMENT_LABEL,
    });
    await expect(
      assignment.getByText("Blocks busy time", { exact: true }),
    ).toBeVisible();
    await expect(assignment.getByText(/Receives bookings/)).toHaveCount(0);
    await page.context().close();
  });

  test("employee is denied owner calendar administration", async ({
    browser,
  }) => {
    const page = await newAuthenticatedPage(
      browser,
      requireAdminFixture().employeeStorageState,
    );
    await page.goto("/admin/calendar-connections");

    await expect(page).toHaveURL(/\/admin\/not-authorized$/);
    await expect(
      page.getByRole("heading", {
        name: "This account does not have access",
      }),
    ).toBeVisible();
    await page.context().close();
  });

  test("employee removes a busy calendar assignment from My availability", async ({
    browser,
  }) => {
    const fixture = requireAdminFixture();
    const page = await newAuthenticatedPage(
      browser,
      fixture.employeeStorageState,
    );
    await page.goto("/admin/my-calendar");

    const accountCard = page.locator("article").filter({
      hasText: fixture.employeeConnectionEmail,
    });
    const assignment = accountCard.locator("div.rounded-xl").filter({
      hasText: ASSIGNMENT_LABEL,
    });
    await expect(assignment).toBeVisible();

    await assignment.getByRole("button", { name: "Remove" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove" })
      .click();

    await expect(
      page.getByText("Busy calendar assignment removed."),
    ).toBeVisible();
    await expect(assignment).toHaveCount(0);
    await expect(accountCard.getByText("No calendars assigned.")).toBeVisible();
    await page.context().close();
  });

  test("employee can promote an owned calendar for the assigned provider resource", async ({
    browser,
  }) => {
    const fixture = requireAdminFixture();
    const page = await newAuthenticatedPage(
      browser,
      fixture.employeeStorageState,
    );
    await page.goto("/admin/my-calendar");

    const accountCard = page.locator("article").filter({
      hasText: fixture.employeeConnectionEmail,
    });
    await expect(accountCard).toBeVisible();
    const assignmentForm = accountCard.locator("form").filter({
      hasText: "Assign calendar",
    });
    await selectOptionContaining(
      assignmentForm.getByLabel("Google calendar"),
      GOOGLE_CALENDAR_LABEL,
    );
    await assignmentForm.getByLabel("Calendar name").fill(ASSIGNMENT_LABEL);
    await assignmentForm
      .getByLabel("Receives bookings and blocks busy time")
      .check();
    await assignmentForm
      .getByRole("button", { name: "Save assignment" })
      .click();

    await expect(page.getByText("Calendar assignment saved.")).toBeVisible();
    const assignment = accountCard.locator("div.rounded-xl").filter({
      hasText: ASSIGNMENT_LABEL,
    });
    await expect(assignment.getByText(/Receives bookings/)).toBeVisible();
    await page.context().close();
  });

  test("employee confirms replacement before moving the booking destination", async ({
    browser,
  }) => {
    const fixture = requireAdminFixture();
    const page = await newAuthenticatedPage(
      browser,
      fixture.employeeStorageState,
    );
    await page.goto("/admin/my-calendar");

    const accountCard = page.locator("article").filter({
      hasText: fixture.employeeConnectionEmail,
    });
    const assignmentForm = accountCard.locator("form").filter({
      hasText: "Assign calendar",
    });
    await selectOptionContaining(
      assignmentForm.getByLabel("Google calendar"),
      GOOGLE_REPLACEMENT_CALENDAR_LABEL,
    );
    await assignmentForm
      .getByLabel("Calendar name")
      .fill(REPLACEMENT_ASSIGNMENT_LABEL);
    await assignmentForm
      .getByLabel("Receives bookings and blocks busy time")
      .check();
    await assignmentForm
      .getByRole("button", { name: "Save assignment" })
      .click();

    const replacementDialog = page.getByRole("dialog", {
      name: "Move booking destination?",
    });
    await expect(replacementDialog).toBeVisible();
    await expect(replacementDialog).toContainText(ASSIGNMENT_LABEL);
    await expect(replacementDialog).toContainText(
      GOOGLE_REPLACEMENT_CALENDAR_LABEL,
    );
    await replacementDialog
      .getByRole("button", { name: "Move booking destination" })
      .click();

    await expect(page.getByText("Calendar assignment saved.")).toBeVisible();
    const replacementAssignment = accountCard.locator("div.rounded-xl").filter({
      hasText: REPLACEMENT_ASSIGNMENT_LABEL,
    });
    await expect(
      replacementAssignment.getByText(/Receives bookings/),
    ).toBeVisible();
    const previousAssignment = accountCard.locator("div.rounded-xl").filter({
      hasText: ASSIGNMENT_LABEL,
    });
    await expect(
      previousAssignment.getByText("Blocks busy time", { exact: true }),
    ).toBeVisible();
    await page.context().close();
  });

  test("owner cannot disable a calendar assignment that receives bookings", async ({
    browser,
  }) => {
    const fixture = requireAdminFixture();
    const page = await newAuthenticatedPage(browser, fixture.ownerStorageState);
    await page.goto("/admin/calendar-connections");

    // Per-account assignment controls live inside the collapsed "Advanced
    // account management" disclosure; expand it before inspecting them.
    await page.locator("details#calendar-account-management > summary").click();

    const accountCard = page.locator("article").filter({
      hasText: fixture.employeeConnectionEmail,
    });
    const assignment = accountCard.locator("div.rounded-xl").filter({
      hasText: REPLACEMENT_ASSIGNMENT_LABEL,
    });
    await expect(assignment).toBeVisible();
    await expect(
      assignment.getByText("Move the booking destination before disabling."),
    ).toBeVisible();
    await expect(
      assignment.getByRole("button", { name: "Disable" }),
    ).toHaveCount(0);
    await expect(
      accountCard.getByText(
        // Names the resource that currently receives bookings (the employee's
        // promoted destination), so match the message rather than a fixed name.
        /Move the booking destination for .+ before disabling this account/,
      ),
    ).toBeVisible();
    await expect(
      accountCard.getByRole("button", { name: "Disable connection" }),
    ).toHaveCount(0);
    await page.context().close();
  });

  test("employee reconnects but cannot disconnect the booking destination", async ({
    browser,
  }) => {
    const fixture = requireAdminFixture();
    const page = await newAuthenticatedPage(
      browser,
      fixture.employeeStorageState,
    );
    await page.goto("/admin/my-calendar");

    const oauthRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.origin === "https://accounts.google.com" &&
        url.pathname === "/o/oauth2/v2/auth"
      );
    });
    await page
      .getByRole("button", { name: "Connect Google account" })
      .click({ noWaitAfter: true });

    const oauthState = new URL((await oauthRequest).url()).searchParams.get(
      "state",
    );
    expect(oauthState).toMatch(/^(calendar|employee)_[A-Za-z0-9_-]+$/);
    await fixture.persistOAuthState(oauthState!);
    await page.goto(
      `/api/booking/oauth/callback?code=${encodeURIComponent(fixture.oauthCode)}&state=${encodeURIComponent(oauthState!)}`,
    );
    await expect(
      page.getByText("Google Calendar account connected."),
    ).toBeVisible();

    const accountCard = page.locator("article").filter({
      hasText: fixture.employeeConnectionEmail,
    });
    await expect(accountCard).toBeVisible();
    await expect(
      accountCard.getByText(
        "This account receives bookings. Move that destination to another calendar before disconnecting it.",
      ),
    ).toBeVisible();
    await expect(
      accountCard.getByRole("button", { name: "Disconnect" }),
    ).toHaveCount(0);
    await page.context().close();
  });
});

async function newAuthenticatedPage(
  browser: Browser,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState,
  });
  return context.newPage();
}

function requireAdminFixture(): AdminCalendarAuthFixture {
  if (adminFixture === undefined) {
    throw new Error("The deterministic admin calendar fixture was not created");
  }
  return adminFixture;
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
