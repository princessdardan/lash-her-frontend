import { expect, test, type Page } from "@playwright/test";

// This suite needs editorial fixtures and a disabled operational database.
// CI runs it separately after the ordinary multi-browser coverage checks.
test.skip(
  ({ baseURL }) => baseURL !== "http://127.0.0.1:3119",
  "Run with tests/tracking-consent.playwright.config.ts for isolated consent coverage",
);

const key = "lh_cookie_consent";
const requests = new WeakMap<Page, string[]>();
const operationalWrites = new WeakMap<Page, string[]>();
const highlevel = /msgsndr|leadconnector|gohighlevel|external-tracking/;
const analyticsScript =
  /\/_vercel\/insights\/script\.js|va\.vercel-scripts\.com/;
const banner = (page: Page) =>
  page.getByRole("region", { name: "Cookie consent" });
const choice = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), key);
const current = (analytics: boolean, crmTracking: boolean) => ({
  required: true,
  analytics,
  crmTracking,
  decidedAt: "2026-10-20T12:00:00.000Z",
  version: 2,
});

// These assert the site's disabled boundary, not vendor ingestion or teardown.
test.beforeEach(async ({ page, context }) => {
  const observed: string[] = [];
  requests.set(page, observed);
  const writes: string[] = [];
  operationalWrites.set(page, writes);
  context.on("request", (request) => {
    if (highlevel.test(request.url())) observed.push(request.url());
    if (
      request.method() !== "GET" &&
      (request.headers()["next-action"] ||
        new URL(request.url()).pathname.startsWith("/api/"))
    ) {
      writes.push(request.url());
    }
  });
  await context.route(highlevel, (route) => route.abort("blockedbyclient"));
  await context.route(analyticsScript, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "/* isolated Vercel analytics transport */",
    }),
  );
  await page.goto("/");
});

test.afterEach(async ({ page, context }) => {
  // Conditional suite skips can run teardown before beforeEach establishes observers.
  if (!requests.has(page)) return;
  expect(requests.get(page)).toEqual([]);
  expect(operationalWrites.get(page)).toEqual([]);
  await expect(page.locator('script[src*="external-tracking"]')).toHaveCount(0);
  expect(
    (await context.cookies()).filter((cookie) =>
      /^lc_session_/.test(cookie.name),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() =>
      [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(
        (key) => key === "_ud" || key.startsWith("lc_session_"),
      ),
    ),
  ).toEqual([]);
});

test("no consent defaults both optional choices off and sends no tracker requests", async ({
  page,
}) => {
  await expect(banner(page)).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Analytics", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "CRM/marketing tracking", exact: true }),
  ).not.toBeChecked();
  expect(await choice(page)).toBeNull();
});

test("rejection persists across reload with required functionality retained", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "lh_course_test",
      value: "synthetic-access",
      url: "http://127.0.0.1:3119",
      httpOnly: true,
    },
  ]);
  await page.evaluate(() => {
    localStorage.setItem("commerce-test-cart", "keep");
    sessionStorage.setItem("auth-test-state", "keep");
  });
  await page.getByRole("button", { name: "Reject optional cookies" }).click();
  expect(await choice(page)).toMatchObject({
    required: true,
    analytics: false,
    crmTracking: false,
    version: 2,
  });
  await page.reload();
  await expect(banner(page)).toBeHidden();
  expect(
    await page.evaluate(() => [
      localStorage.getItem("commerce-test-cart"),
      sessionStorage.getItem("auth-test-state"),
    ]),
  ).toEqual(["keep", "keep"]);
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "lh_course_test",
    ),
  ).toBe(true);
});

test("analytics acceptance does not authorize CRM tracking", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Accept analytics only" }).click();
  expect(await choice(page)).toMatchObject({
    analytics: true,
    crmTracking: false,
    version: 2,
  });
  await expect(
    page.locator('script[data-sdkn^="@vercel/analytics"]'),
  ).toHaveCount(1);
});

test("CRM grant and withdrawal preserve the independent analytics choice", async ({
  page,
}) => {
  await page
    .getByRole("checkbox", { name: "CRM/marketing tracking", exact: true })
    .check();
  await page.getByRole("button", { name: "Save choices" }).click();
  expect(await choice(page)).toMatchObject({
    analytics: false,
    crmTracking: true,
  });
  await expect(
    page.locator('script[data-sdkn^="@vercel/analytics"]'),
  ).toHaveCount(0);
  await page.reload();
  await expect(banner(page)).toBeHidden();
  await page.getByRole("button", { name: "Manage cookie preferences" }).click();
  await page.getByRole("checkbox", { name: "Analytics", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "CRM/marketing tracking", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Save choices" }).click();
  expect(await choice(page)).toMatchObject({
    analytics: true,
    crmTracking: false,
  });
  await page.reload();
  expect(await choice(page)).toMatchObject({
    analytics: true,
    crmTracking: false,
  });
});

test("legacy analytics consent migrates without widening permission or changing its date", async ({
  page,
}) => {
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          required: true,
          analytics: true,
          crmTracking: true,
          decidedAt: "2026-06-03T12:00:00.000Z",
          version: 1,
        }),
      ),
    key,
  );
  await page.reload();
  await expect
    .poll(() => choice(page))
    .toEqual({
      required: true,
      analytics: true,
      crmTracking: false,
      decidedAt: "2026-06-03T12:00:00.000Z",
      version: 2,
    });
  await expect(banner(page)).toBeHidden();
});

test("cross-tab grant, withdrawal, and storage clearing update an open preference panel", async ({
  page,
  context,
}) => {
  await page.getByRole("button", { name: "Reject optional cookies" }).click();
  await page.getByRole("button", { name: "Manage cookie preferences" }).click();
  const other = await context.newPage();
  await other.goto("/gallery");
  await other.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key, value: current(true, true) },
  );
  await expect(
    page.getByRole("checkbox", { name: "CRM/marketing tracking", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Analytics", exact: true }),
  ).toBeChecked();
  await other.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key, value: current(true, false) },
  );
  await expect(
    page.getByRole("checkbox", { name: "CRM/marketing tracking", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Analytics", exact: true }),
  ).toBeChecked();
  await other.evaluate(() => localStorage.clear());
  await expect(
    page.getByRole("checkbox", { name: "Analytics", exact: true }),
  ).not.toBeChecked();
  await other.close();
});

test("initial, Next.js, Back/Forward and sensitive-query navigation never starts the blocked tracker", async ({
  page,
}) => {
  await page
    .getByRole("checkbox", { name: "CRM/marketing tracking", exact: true })
    .check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.evaluate(() => {
    (window as unknown as { navigationCanary: boolean }).navigationCanary =
      true;
  });
  const gallery = page.getByRole("link", { name: "Gallery", exact: true });
  if (!(await gallery.isVisible())) {
    await page.getByRole("button", { name: "Toggle menu" }).click();
  }
  await gallery.click();
  await expect(page).toHaveURL(/\/gallery$/);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { navigationCanary: boolean }).navigationCanary,
    ),
  ).toBe(true);
  await page.goBack();
  await page.goForward();
  for (const path of [
    "/?token=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT",
    "/checkout",
    "/courses/course-e2e",
    "/policies/privacy",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("button", { name: "Manage cookie preferences" }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("region", { name: "Website tracking preferences" }),
  ).toContainText("currently disabled");
});

test("tracking choices and blocked vendors leave email/SMS permissions and form inputs unchanged", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Reject optional cookies" }).click();
  await page.goto("/contact");
  const email = page.getByRole("checkbox", {
    name: /I agree to receive marketing emails/,
  });
  const sms = page.getByRole("checkbox", {
    name: /I agree to receive recurring marketing text/,
  });
  await expect(email).not.toBeChecked();
  await expect(sms).not.toBeChecked();
  await page.locator('input[name="name"]').fill("Synthetic Visitor");
  await page
    .locator('textarea[name="message"]')
    .fill("SYNTHETIC_PRIVATE_INTAKE");
  await page.getByRole("button", { name: "Manage cookie preferences" }).click();
  await page
    .getByRole("checkbox", { name: "CRM/marketing tracking", exact: true })
    .check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await expect(email).not.toBeChecked();
  await expect(sms).not.toBeChecked();
  await email.check();
  await sms.check();
  await page.getByRole("button", { name: "Manage cookie preferences" }).click();
  await page.getByRole("button", { name: "Reject optional cookies" }).click();
  await expect(email).toBeChecked();
  await expect(sms).toBeChecked();
  await expect(page.locator('textarea[name="message"]')).toHaveValue(
    "SYNTHETIC_PRIVATE_INTAKE",
  );
  await expect(page.locator('input[name="name"]')).toHaveValue(
    "Synthetic Visitor",
  );
  await page.locator('input[name="email"]').fill("invalid");
  await page.getByRole("button", { name: "Send Inquiry" }).click();
  expect(
    await page
      .locator('input[name="email"]')
      .evaluate((input: HTMLInputElement) => input.validity.valid),
  ).toBe(false);
});

test("storage failures honor in-session choices without disrupting the page", async ({
  page,
}) => {
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
  });
  await page
    .getByRole("checkbox", { name: "CRM/marketing tracking", exact: true })
    .check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await expect(banner(page)).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Preferences apply" }),
  ).toContainText("this tab only");
  await page.getByRole("button", { name: "Manage cookie preferences" }).click();
  await expect(
    page.getByRole("checkbox", { name: "CRM/marketing tracking", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Reject optional cookies" }).click();
  await page.getByRole("button", { name: "Manage cookie preferences" }).click();
  await expect(
    page.getByRole("checkbox", { name: "CRM/marketing tracking", exact: true }),
  ).not.toBeChecked();
});
