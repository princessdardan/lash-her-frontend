import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import {
  createCourseAccessToken,
  courseCookieName,
} from "../src/lib/courses/access-token";

const database = process.env.COURSE_E2E_DATABASE_URL;
if (
  database &&
  !["127.0.0.1", "localhost"].includes(new URL(database).hostname)
)
  throw new Error("Course browser tests require an isolated local database");
test.skip(
  ({ baseURL }) => !database || baseURL !== "http://127.0.0.1:3107",
  "Run with tests/courses.playwright.config.ts and an isolated local PostgreSQL database",
);
const pool = database ? new Pool({ connectionString: database }) : null;
const emails: string[] = [];
const coursePath = "/courses/course-e2e";
const cookieName = courseCookieName("course-e2e");

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() =>
    localStorage.setItem(
      "lh_cookie_consent",
      JSON.stringify({
        required: true,
        analytics: false,
        decidedAt: new Date().toISOString(),
        version: 1,
      }),
    ),
  );
  await context.route(
    "https://course-media.example.invalid/**",
    async (route) => {
      if (route.request().url().endsWith(".vtt"))
        await route.fulfill({
          contentType: "text/vtt",
          headers: { "access-control-allow-origin": "*" },
          body: "WEBVTT\n\n00:00.000 --> 00:07.000\nUse a gentle cleanser.\n",
        });
      else {
        const bytes = readFileSync(
          path.resolve("tests/fixtures/course-test.mp4"),
        );
        const range = /^bytes=(\d+)-(\d*)$/.exec(
          route.request().headers().range ?? "",
        );
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2]
          ? Math.min(Number(range[2]), bytes.length - 1)
          : bytes.length - 1;
        await route.fulfill({
          status: range ? 206 : 200,
          body: bytes.subarray(start, end + 1),
          contentType: "video/mp4",
          headers: {
            "access-control-allow-origin": "*",
            "accept-ranges": "bytes",
            "content-length": String(end - start + 1),
            ...(range
              ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
              : {}),
          },
        });
      }
    },
  );
});

test.afterEach(async () => {
  if (!pool) return;
  for (const email of emails.splice(0)) {
    for (const table of [
      "marketing_contact_sync_jobs",
      "marketing_consent_events",
      "marketing_contact_submissions",
      "marketing_contacts",
    ])
      await pool.query(`DELETE FROM ${table} WHERE email_normalized = $1`, [
        email,
      ]);
  }
});
test.afterAll(async () => {
  await pool?.end();
});

async function signup(page: Page) {
  const email = `course-browser-${randomUUID()}@example.invalid`;
  emails.push(email);
  await page.goto(coursePath);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Phone number").fill("+1 (416) 555-0123");
  await expect(
    page.getByRole("checkbox", { name: /I agree to receive/ }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: /I agree to receive/ }).check();
  await page.getByRole("button", { name: "Sign up and access course" }).click();
  await expect(
    page.getByRole("navigation", { name: "Course modules" }),
  ).toBeVisible();
  return email;
}

test("unauthorized HTML and RSC contain only the teaser; popup is suppressed", async ({
  page,
  request,
}) => {
  const response = await request.get(coursePath);
  expect(response.status()).toBe(200);
  expect(await response.text()).not.toMatch(
    /PRIVATE_LESSON|course-media\.example|Which cleanser/,
  );
  const rsc = await request.get(`${coursePath}?_rsc=test`, {
    headers: { RSC: "1" },
  });
  expect(await rsc.text()).not.toMatch(
    /PRIVATE_LESSON|course-media\.example|Which cleanser/,
  );
  await page.goto(coursePath);
  await expect(
    page.getByRole("heading", { name: "Start your free course" }),
  ).toBeVisible();
  await page.waitForTimeout(3200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Email address").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Phone number")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Instagram handle (optional)")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("checkbox", { name: /I agree to receive/ }),
  ).toBeFocused();
});

test("signup requires a valid phone and saves the optional Instagram handle", async ({
  page,
}) => {
  const email = `course-fields-${randomUUID()}@example.invalid`;
  emails.push(email);
  await page.goto(coursePath);
  await page.getByLabel("Email address").fill(email);
  const phone = page.getByLabel("Phone number");
  const instagram = page.getByLabel("Instagram handle (optional)");
  await expect(phone).toHaveAttribute("required", "");
  await expect(instagram).not.toHaveAttribute("required");
  await page.getByRole("checkbox", { name: /I agree to receive/ }).check();
  const submit = page.getByRole("button", {
    name: "Sign up and access course",
  });
  await submit.click();
  await expect(phone).toBeFocused();
  await phone.fill("123");
  await submit.click();
  await expect(page.getByText("Enter a valid phone number.")).toBeVisible();
  await phone.fill("+1 (416) 555-0123");
  await instagram.fill("invalid handle");
  await submit.click();
  await expect(
    page.getByText("Enter a valid Instagram handle or leave it blank."),
  ).toBeVisible();
  expect(
    (
      await pool!.query(
        "SELECT count(*)::int AS count FROM marketing_contact_submissions WHERE email_normalized=$1",
        [email],
      )
    ).rows[0].count,
  ).toBe(0);
  await instagram.fill("@lash.learner");
  await submit.click();
  await expect(
    page.getByRole("navigation", { name: "Course modules" }),
  ).toBeVisible();
  for (const table of ["marketing_contacts", "marketing_contact_submissions"]) {
    const result = await pool!.query(
      `SELECT phone, instagram FROM ${table} WHERE email_normalized=$1`,
      [email],
    );
    expect(result.rows).toEqual([
      { phone: "+1 (416) 555-0123", instagram: "@lash.learner" },
    ]);
  }
});

test("signup survives refresh and restart, and quiz/video progress resumes", async ({
  page,
  browser,
  context,
}) => {
  const email = await signup(page);
  const cookie = (await context.cookies()).find(
    (item) => item.name === cookieName,
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 364 * 86400);
  const video = page.locator("video");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video.locator("track")).toHaveAttribute("srclang", "en");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThan(0);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
    element.currentTime = 3;
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThanOrEqual(3);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith("lh_course_progress:"),
        );
        return key
          ? JSON.parse(localStorage.getItem(key)!).modules.cleaning.position
          : 0;
      }),
    )
    .toBeGreaterThan(2);
  await page.getByLabel("An oil cleanser", { exact: true }).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(
    page.getByText("0 of 1 correct. Module complete."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("0 of 1 correct. Module complete."),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(2);
  await page.getByRole("button", { name: "Try quiz again" }).click();
  await expect(
    page.getByText("1 of 2 modules complete", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("A gentle lash cleanser", { exact: true }).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(
    page.getByText("1 of 1 correct. Module complete."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Module 2/ }).click();
  await page.getByLabel("When dry", { exact: true }).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(
    page.getByText("Course complete", { exact: true }),
  ).toBeVisible();
  // The UI updates before the Web Locks persistence queue finishes. Capture
  // restart state only after both completed modules have reached storage.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith("lh_course_progress:"),
        );
        if (!key) return false;
        const modules = JSON.parse(localStorage.getItem(key)!).modules;
        return modules.cleaning.completed && modules.brushing.completed;
      }),
    )
    .toBe(true);
  const state = await context.storageState();
  const restored = await browser.newContext({ storageState: state });
  try {
    const reopened = await restored.newPage();
    await reopened.goto(coursePath);
    await expect(
      reopened.getByRole("heading", { name: "Gentle brushing", exact: true }),
    ).toBeVisible();
    await expect(
      reopened.getByText("Course complete", { exact: true }),
    ).toBeVisible();
  } finally {
    await restored.close();
  }
  const records = await pool!.query(
    "SELECT count(*)::int AS count FROM marketing_contact_submissions WHERE email_normalized=$1",
    [email],
  );
  expect(records.rows[0].count).toBe(1);
});

for (const { delayedEvents, withoutLocks } of [
  { delayedEvents: false, withoutLocks: false },
  { delayedEvents: true, withoutLocks: false },
  { delayedEvents: true, withoutLocks: true },
]) {
  test(`course tabs preserve shared progress with ${delayedEvents ? "delayed" : "live"} storage events${withoutLocks ? " and unavailable locks" : ""}`, async ({
    page,
    context,
  }) => {
    if (delayedEvents)
      await context.addInitScript((withoutLocks) => {
        window.addEventListener("storage", (event) =>
          event.stopImmediatePropagation(),
        );
        if (withoutLocks)
          Object.defineProperty(navigator, "locks", { value: undefined });
      }, withoutLocks);
    await signup(page);
    const other = await context.newPage();
    try {
      await other.goto(coursePath);
      await expect(
        other.getByRole("navigation", { name: "Course modules" }),
      ).toBeVisible();

      await page.getByLabel("A gentle lash cleanser", { exact: true }).check();
      await page.getByRole("button", { name: "Check answers" }).click();
      await expect(
        page.getByText("1 of 1 correct. Module complete."),
      ).toBeVisible();
      await expect(
        other.getByText(`${delayedEvents ? 0 : 1} of 2 modules complete`, {
          exact: true,
        }),
      ).toBeVisible();

      // The second tab changes only its active module, preserving the quiz
      // completed in the first tab even if its storage event has not arrived.
      await other.getByRole("button", { name: /Module 2/ }).click();
      await expect(
        other.getByText("1 of 2 modules complete", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Daily cleansing", exact: true }),
      ).toBeVisible();
      await other.getByLabel("When dry", { exact: true }).check();
      await other.getByRole("button", { name: "Check answers" }).click();
      await expect(
        other.getByText("Course complete", { exact: true }),
      ).toBeVisible();
      if (!delayedEvents)
        await expect(
          page.getByText("Course complete", { exact: true }),
        ).toBeVisible();

      // Retrying in the second tab must survive a stale video save in the
      // first tab, without clearing either module's completion.
      await other.getByRole("button", { name: "Try quiz again" }).click();
      await expect(
        other.getByLabel("When dry", { exact: true }),
      ).not.toBeChecked();
      const video = page.locator("video");
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => element.readyState),
        )
        .toBeGreaterThan(0);
      await video.evaluate((element: HTMLVideoElement) => {
        element.currentTime = 3;
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const key = Object.keys(localStorage).find((key) =>
              key.startsWith("lh_course_progress:"),
            );
            return key
              ? JSON.parse(localStorage.getItem(key)!).modules.cleaning.position
              : 0;
          }),
        )
        .toBeGreaterThan(2);

      await other.reload();
      await expect(
        other.getByText("Course complete", { exact: true }),
      ).toBeVisible();
      await other.getByRole("button", { name: /Module 2/ }).click();
      await expect(
        other.getByLabel("When dry", { exact: true }),
      ).not.toBeChecked();
      await page.reload();
      await expect(
        page.getByText("Course complete", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /Module 1/ }).click();
      await expect(
        page.getByText("1 of 1 correct. Module complete."),
      ).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator("video")
            .evaluate((element: HTMLVideoElement) => element.currentTime),
        )
        .toBeGreaterThan(2);
    } finally {
      await other.close();
    }
  });
}

test("quizzes stay responsive and preserve both tabs' updates while writes are queued", async ({
  page,
  context,
}) => {
  await signup(page);
  const other = await context.newPage();
  try {
    await other.goto(coursePath);
    await other.getByRole("button", { name: /Module 2/ }).click();
    await expect(other.getByLabel("When dry", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        other.evaluate(() =>
          Object.keys(localStorage).some((key) =>
            key.startsWith("lh_course_progress:"),
          ),
        ),
      )
      .toBe(true);

    // Force real cross-tab write contention while learners answer and submit.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const key = Object.keys(localStorage).find((key) =>
            key.startsWith("lh_course_progress:"),
          )!;
          void navigator.locks.request(
            key,
            () =>
              new Promise<void>((release) => {
                window.addEventListener(
                  "release-course-test-lock",
                  () => release(),
                  { once: true },
                );
                resolve();
              }),
          );
        }),
    );
    await page.getByLabel("A gentle lash cleanser", { exact: true }).check();
    await other.getByLabel("When dry", { exact: true }).check();
    await page.getByRole("button", { name: "Check answers" }).click();
    await other.getByRole("button", { name: "Check answers" }).click();
    await expect(
      page.getByText("1 of 1 correct. Module complete."),
    ).toBeVisible();
    await expect(
      other.getByText("1 of 1 correct. Module complete."),
    ).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("release-course-test-lock")),
    );

    await expect(
      page.getByText("Course complete", { exact: true }),
    ).toBeVisible();
    await expect(
      other.getByText("Course complete", { exact: true }),
    ).toBeVisible();
    await other.reload();
    await expect(
      other.getByText("Course complete", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() =>
      window.dispatchEvent(new Event("release-course-test-lock")),
    );
    await other.close();
  }
});

test("unsubscribe preserves access; another browser and cleared cookies remain gated", async ({
  page,
  context,
  browser,
}) => {
  const email = await signup(page);
  await pool!.query(
    "UPDATE marketing_contacts SET unsubscribed_at=now() WHERE email_normalized=$1",
    [email],
  );
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Course modules" }),
  ).toBeVisible();
  const records = await pool!.query(
    "SELECT unsubscribed_at FROM marketing_contacts WHERE email_normalized=$1",
    [email],
  );
  expect(records.rows[0].unsubscribed_at).not.toBeNull();
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto(coursePath);
    await expect(other.getByLabel("Email address")).toBeVisible();
  } finally {
    await fresh.close();
  }
  await context.clearCookies();
  await page.reload();
  await expect(page.getByLabel("Email address")).toBeVisible();
});

test("invalid and expired cookies cannot unlock the course", async ({
  page,
  context,
}) => {
  const secret = "course-e2e-only-secret-012345678901234567890123456789";
  const expired = createCourseAccessToken(
    "course-e2e",
    secret,
    Date.now() - 366 * 86400_000,
  ).token;
  const otherCourse = createCourseAccessToken("another-course", secret).token;
  for (const value of ["true", expired, otherCourse]) {
    await context.addCookies([
      { name: cookieName, value, url: "http://127.0.0.1:3107", httpOnly: true },
    ]);
    await page.goto(coursePath);
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
  }
});

test("video failures have a retry and blocked progress storage is explained", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("lh_course_progress:"))
        throw new DOMException("Blocked", "SecurityError");
      original.call(this, key, value);
    };
  });
  await page.route("https://course-media.example.invalid/lesson.mp4", (route) =>
    route.abort(),
  );
  await signup(page);
  await expect(
    page.getByText(
      "The video could not load. Check your connection and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry video" })).toBeVisible();
  await page.getByLabel("A gentle lash cleanser", { exact: true }).check();
  await expect(
    page.getByText(/Your browser is blocking progress storage/),
  ).toBeVisible();
});

test("discarded access cookies show a persistence error without repeated signups", async ({
  page,
  context,
}) => {
  await page.route("**/courses/course-e2e", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["set-cookie"];
    await context.clearCookies();
    await route.fulfill({ response, headers });
  });
  const email = `course-blocked-${randomUUID()}@example.invalid`;
  emails.push(email);
  await page.goto(coursePath);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Phone number").fill("4165550123");
  await page.getByRole("checkbox", { name: /I agree to receive/ }).check();
  await page.getByRole("button", { name: "Sign up and access course" }).click();
  await expect(
    page
      .getByText(
        /Your browser did not save the access cookie|your browser blocked the access cookie/,
      )
      .first(),
  ).toBeVisible();
  expect(
    (
      await pool!.query(
        "SELECT count(*)::int AS count FROM marketing_contact_submissions WHERE email_normalized=$1",
        [email],
      )
    ).rows[0].count,
  ).toBe(1);
});
