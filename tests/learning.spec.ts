import { test, expect, type BrowserContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { setRequiredOnlyCookieConsent } from "./support/required-only-cookie-consent";

const origin = "http://127.0.0.1:3111";
const courseId = "a1111111-1111-4111-8111-111111111111",
  lessonId = "a3333333-3333-4333-8333-333333333333";
const lessonPath = `/academy/courses/${courseId}/lessons/${lessonId}`;
test.skip(
  ({ baseURL }) => baseURL !== origin,
  "Use learning.playwright.config.ts with an isolated PostgreSQL database",
);
const pool = new Pool({
  connectionString: process.env.LEARNING_E2E_DATABASE_URL,
});
const ids: string[] = [];
test.afterAll(async () => {
  if (ids.length)
    await pool.query("DELETE FROM customer_users WHERE id=ANY($1::uuid[])", [
      ids,
    ]);
  await pool.end();
});
async function login(context: BrowserContext) {
  const id = randomUUID(),
    token = randomUUID();
  ids.push(id);
  await pool.query(
    "INSERT INTO customer_users(id,email,email_verified) VALUES($1,$2,now())",
    [id, `learning-e2e-${id}@example.invalid`],
  );
  await pool.query(
    "INSERT INTO customer_sessions(token_hash,user_id,expires) VALUES($1,$2,now()+interval '1 hour')",
    [createHash("sha256").update(token).digest("hex"), id],
  );
  await context.addCookies([
    {
      name: "lash-customer.session-token",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return token;
}
async function media(context: BrowserContext) {
  await setRequiredOnlyCookieConsent(context);
  await context.route("https://stream.mux.com/**", async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    if (name.endsWith(".m3u8"))
      await route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync("tests/fixtures/course-mux.m3u8"),
      });
    else if (/^course-mux-\d+\.mpegts$/u.test(name))
      await route.fulfill({
        contentType: "video/mp2t",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(path.join("tests/fixtures", name)),
      });
    else await route.abort();
  });
  await context.route("https://image.mux.com/**", (route) =>
    route.fulfill({ status: 404 }),
  );
  await context.route("https://learning-media.example.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00.000 --> 00:07.000\nA gentle approach protects the natural lash.\n",
    }),
  );
}
test.beforeEach(async ({ context }) => {
  await media(context);
});
async function enroll(page: import("@playwright/test").Page) {
  await page.goto("/courses/learning-fixture");
  await page.getByRole("button", { name: "Enroll for free" }).click();
  await expect(
    page.getByRole("heading", { name: "Lash foundations", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "The basics Open lesson" }).click();
  await expect(
    page.getByRole("heading", { name: "The basics", exact: true }),
  ).toBeVisible();
}

test("anonymous catalog/detail reveal public metadata, keep canonical URL and direct protected learning to customer sign-in", async ({
  page,
  request,
}) => {
  await page.goto("/courses");
  await expect(
    page.getByRole("heading", { name: "Learn with intention" }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Lash foundations/ }).click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /\/courses\/learning-fixture$/,
  );
  await expect(
    page.getByRole("link", { name: "Sign in to enroll" }),
  ).toHaveAttribute("href", /callbackUrl=%2Fcourses%2Flearning-fixture/);
  const response = await request.get("/api/academy/courses");
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(await page.content()).not.toContain("PRIVATE_LEARNING_CONTENT");
  await page.goto("/academy");
  await expect(
    page.getByRole("heading", { name: "Sign in to continue" }),
  ).toBeVisible();
});

test("free enrollment, signed player, keyboard assessment and another-device resume use the server account", async ({
  page,
  context,
  browser,
}) => {
  const token = await login(context);
  const errors: string[] = [],
    browserSecrets: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("learning-gateway"))
      browserSecrets.push(request.url());
  });
  await enroll(page);
  const player = page.locator("mux-player");
  await expect(player).toHaveAttribute("disable-tracking", "");
  await expect
    .poll(() =>
      player.evaluate(
        (element: HTMLElement & { readyState: number }) => element.readyState,
      ),
    )
    .toBeGreaterThan(0);
  await player.evaluate(
    (element: HTMLElement & { currentTime: number; pause: () => void }) => {
      element.currentTime = 4;
      element.pause();
    },
  );
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/academy/progress?lessonId=${lessonId}`)
          ).json()
        ).progress[0]?.resumePositionSeconds,
    )
    .toBeGreaterThanOrEqual(3);
  await page.getByText("Read the transcript", { exact: true }).click();
  await expect(
    page.getByText("A gentle approach protects the natural lash.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark lesson complete" }),
  ).toHaveCount(0);
  await page.getByRole("radio", { name: "Pull the extensions" }).check();
  await page.getByRole("radio", { name: "Only once" }).check();
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep practising" }),
  ).toBeVisible();
  const notPassed = (
    await (
      await page.request.get(`/api/academy/progress?lessonId=${lessonId}`)
    ).json()
  ).progress[0];
  expect(notPassed.completedAt).toBeNull();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  const first = page.getByRole("radio", { name: "Use gentle care" });
  await first.focus();
  await page.keyboard.press("Space");
  await page.getByRole("radio", { name: "At your own pace" }).check();
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(
    page.getByRole("heading", { name: "Assessment passed" }),
  ).toBeVisible();
  await expect(
    page.getByText("Lesson complete. Progress saved.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("lh_course_progress:"),
      ),
    ),
  ).toEqual([]);
  const second = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await media(second);
    await second.addCookies([
      {
        name: "lash-customer.session-token",
        value: token,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const other = await second.newPage();
    await other.goto(lessonPath);
    await expect
      .poll(() =>
        other
          .locator("mux-player")
          .evaluate(
            (element: HTMLElement & { currentTime: number }) =>
              element.currentTime,
          ),
      )
      .toBeGreaterThanOrEqual(3);
    await expect(other.getByText(/^Lesson complete\./)).toBeVisible();
    const confirmed = (
      await (
        await other.request.get(`/api/academy/progress?lessonId=${lessonId}`)
      ).json()
    ).progress[0];
    expect(confirmed.completedQuizRevision).toBe(1);
    expect(confirmed.completedAt).toBeTruthy();
  } finally {
    await second.close();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(browserSecrets).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("learner-complete.png"),
    fullPage: true,
  });
});

test("stale progress reloads the other device revision and never silently overwrites its saved position", async ({
  page,
  context,
}) => {
  await login(context);
  await enroll(page);
  await expect(
    page.getByText("Progress saved to your account.", { exact: true }),
  ).toBeVisible();
  const latest = (
    await (
      await page.request.get(`/api/academy/progress?lessonId=${lessonId}`)
    ).json()
  ).progress[0];
  const changed = await page.request.post(
    `/api/academy/lessons/${lessonId}/progress`,
    {
      headers: { origin, "x-lash-csrf": "1" },
      data: {
        expectedProgressRevision: latest.revision,
        resumePositionSeconds: 5,
        maxPositionSeconds: 5,
      },
    },
  );
  expect(changed.ok()).toBe(true);
  await expect
    .poll(() =>
      page
        .locator("mux-player")
        .evaluate(
          (element: HTMLElement & { readyState: number }) => element.readyState,
        ),
    )
    .toBeGreaterThan(0);
  await page
    .locator("mux-player")
    .evaluate(
      (element: HTMLElement & { currentTime: number; pause: () => void }) => {
        element.currentTime = 2;
        element.pause();
      },
    );
  await expect(
    page.getByText("Another session updated this lesson.", { exact: false }),
  ).toBeVisible();
  const stored = (
    await (
      await page.request.get(`/api/academy/progress?lessonId=${lessonId}`)
    ).json()
  ).progress[0];
  expect(stored.resumePositionSeconds).toBe(5);
});

test("media processing and access denial remain usable and provide explicit recovery", async ({
  page,
  context,
}) => {
  await login(context);
  await page.route(`**/api/academy/lessons/${lessonId}/playback`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "video_processing",
          message: "This video is still processing.",
        },
      }),
    }),
  );
  await enroll(page);
  await expect(
    page.getByText("This video is still processing.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry video" })).toBeVisible();
  await page.unroute(`**/api/academy/lessons/${lessonId}/playback`);
  await page.route(`**/api/academy/lessons/${lessonId}/playback`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "access_revoked",
          message: "Course access has been revoked.",
        },
      }),
    }),
  );
  await page.getByRole("button", { name: "Retry video" }).click();
  await expect(
    page.getByText("Your access has ended.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("mux-player")).toHaveCount(0);
});

test("scheduled playback renewal rechecks access and removes the player when access ends", async ({
  page,
  context,
}) => {
  await login(context);
  let initial = true;
  let renewals = 0;
  await page.route(
    `**/api/academy/lessons/${lessonId}/playback`,
    async (route) => {
      if (initial) {
        const response = await route.fetch(),
          body = await response.json();
        // Shorten only the fixture's browser expiry to exercise the renewal timer.
        await route.fulfill({
          response,
          json: {
            ...body,
            expiresAt: new Date(Date.now() + 4000).toISOString(),
            thumbnailExpiresAt: new Date(Date.now() + 4000).toISOString(),
          },
        });
      } else {
        renewals++;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "access_revoked",
              message: "Course access has been revoked.",
            },
          }),
        });
      }
    },
  );
  await enroll(page);
  await expect(page.locator("mux-player")).toHaveCount(1);
  initial = false;
  await expect(
    page.getByText("Your access has ended.", { exact: false }),
  ).toBeVisible();
  expect(renewals).toBe(1);
  await expect(page.locator("mux-player")).toHaveCount(0);
});

test("failed completion read can be retried without another assessment or progress write", async ({
  page,
  context,
}) => {
  await login(context);
  await enroll(page);
  await expect(
    page.getByText("Progress saved to your account.", { exact: true }),
  ).toBeVisible();
  let reads = 0;
  await page.route(
    `**/api/academy/progress?lessonId=${lessonId}`,
    async (route) => {
      if (++reads === 1)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "service_unavailable" } }),
        });
      else await route.continue();
    },
  );
  await page.getByRole("radio", { name: "Use gentle care" }).check();
  await page.getByRole("radio", { name: "At your own pace" }).check();
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(
    page.getByRole("heading", { name: "Assessment passed" }),
  ).toBeVisible();
  await expect(
    page.getByText("Progress has not been confirmed.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry saving progress" }).click();
  await expect(
    page.getByText("Lesson complete. Progress saved.", { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(2);
});

test("page-exit flush keeps its final position request keepalive behind an active heartbeat", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const calls: Array<{ keepalive: boolean; resume?: number }> = [];
    (window as unknown as { progressRequests: typeof calls }).progressRequests =
      calls;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (
        typeof input === "string" &&
        input.endsWith("/progress") &&
        init?.method === "POST"
      )
        calls.push({
          keepalive: init.keepalive === true,
          resume: JSON.parse(String(init.body)).resumePositionSeconds,
        });
      return original(input, init);
    };
  });
  await login(context);
  await enroll(page);
  await expect(
    page.getByText("Progress saved to your account.", { exact: true }),
  ).toBeVisible();
  const player = page.locator("mux-player");
  await expect
    .poll(() =>
      player.evaluate(
        (element: HTMLElement & { readyState: number }) => element.readyState,
      ),
    )
    .toBeGreaterThan(0);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(
    `**/api/academy/lessons/${lessonId}/progress`,
    async (route) => {
      if (first) {
        first = false;
        await held;
      }
      await route.continue();
    },
  );
  try {
    await player.evaluate(
      (element: HTMLElement & { currentTime: number; pause: () => void }) => {
        element.currentTime = 2;
        element.pause();
      },
    );
    await expect.poll(() => first).toBe(false);
    await player.evaluate(
      (element: HTMLElement & { currentTime: number; pause: () => void }) => {
        element.currentTime = 4;
        element.pause();
      },
    );
    await expect
      .poll(() =>
        player.evaluate(
          (element: HTMLElement & { currentTime: number }) =>
            element.currentTime,
        ),
      )
      .toBeGreaterThanOrEqual(3);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    release();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(
                `/api/academy/progress?lessonId=${lessonId}`,
              )
            ).json()
          ).progress[0]?.resumePositionSeconds,
      )
      .toBeGreaterThanOrEqual(3);
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            progressRequests: Array<{ keepalive: boolean; resume?: number }>;
          }
        ).progressRequests,
    );
    expect(
      calls.find((call) => call.resume !== undefined && call.resume >= 3)
        ?.keepalive,
    ).toBe(true);
  } finally {
    release();
  }
});

test("authorization expiry removes the player while renewal is stalled and refuses a late expired response", async ({
  page,
  context,
}) => {
  await login(context);
  let initial = true;
  let renewals = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let expired: Record<string, unknown>;
  await page.route(
    `**/api/academy/lessons/${lessonId}/playback`,
    async (route) => {
      if (initial) {
        const response = await route.fetch(),
          body = await response.json();
        expired = {
          ...body,
          expiresAt: new Date(Date.now() + 4000).toISOString(),
          thumbnailExpiresAt: new Date(Date.now() + 4000).toISOString(),
        };
        await route.fulfill({ response, json: expired });
      } else {
        renewals++;
        await held;
        // Aborting the expired request may already have closed this route.
        await route
          .fulfill({ contentType: "application/json", json: expired })
          .catch(() => {});
      }
    },
  );
  try {
    await enroll(page);
    await expect(page.locator("mux-player")).toHaveCount(1);
    initial = false;
    await expect.poll(() => renewals).toBe(1);
    await expect(page.locator("mux-player")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retry video" }),
    ).toBeVisible();
    release();
    await expect(page.locator("mux-player")).toHaveCount(0);
    expect(renewals).toBe(1);
  } finally {
    release();
  }
});

test("public preview does not offer assessment outage recovery or saved completion", async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(
    `/academy/courses/${courseId}/lessons/a5555555-5555-4555-8555-555555555555?course=learning-fixture`,
  );
  await expect(
    page.getByRole("heading", { name: "A public preview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Preview lesson.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Public preview lesson text.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Assessment unavailable" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Mark lesson complete|Submit answers|Reload assessment/,
    }),
  ).toHaveCount(0);
});

test("SPA navigation flushes the latest played position before its player ref is detached", async ({
  page,
  context,
}) => {
  await login(context);
  await enroll(page);
  await expect(
    page.getByText("Progress saved to your account.", { exact: true }),
  ).toBeVisible();
  const player = page.locator("mux-player");
  await expect
    .poll(() =>
      player.evaluate(
        (element: HTMLElement & { readyState: number }) => element.readyState,
      ),
    )
    .toBeGreaterThan(0);
  await player.evaluate(
    (element: HTMLElement & { play: () => Promise<void> }) => element.play(),
  );
  await expect
    .poll(() =>
      player.evaluate(
        (element: HTMLElement & { currentTime: number }) => element.currentTime,
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await page
    .getByRole("navigation", { name: "Learning", exact: true })
    .getByRole("link", { name: "My academy", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "My academy", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/academy/progress?lessonId=${lessonId}`)
          ).json()
        ).progress[0]?.resumePositionSeconds,
    )
    .toBeGreaterThanOrEqual(1);
});

test("another account cannot reuse learning state and a suspended session cannot renew playback", async ({
  page,
  context,
  browser,
}) => {
  await login(context);
  await enroll(page);
  await expect(
    page.getByText("Progress saved to your account.", { exact: true }),
  ).toBeVisible();
  const firstProgress = (
    await (
      await page.request.get(`/api/academy/progress?lessonId=${lessonId}`)
    ).json()
  ).progress[0];
  const firstAttempt = await page.request.post(
    `/api/academy/lessons/${lessonId}/quiz/attempts`,
    {
      headers: { origin, "x-lash-csrf": "1" },
      data: {
        quizRevision: 1,
        requestId: randomUUID(),
        answers: [
          { questionId: "q1", optionId: "pull" },
          { questionId: "q2", optionId: "never" },
        ],
      },
    },
  );
  expect(firstAttempt.ok()).toBe(true);
  const second = await browser.newContext({ baseURL: origin });
  try {
    await media(second);
    await login(second);
    const other = await second.newPage();
    await other.goto(lessonPath);
    await expect(
      other.getByRole("heading", { name: "Enrollment required" }),
    ).toBeVisible();
    expect(await other.content()).not.toContain("PRIVATE_LEARNING_CONTENT");
    for (const path of [
      `/api/academy/progress?lessonId=${lessonId}`,
      `/api/academy/lessons/${lessonId}/quiz/attempts`,
      `/api/academy/lessons/${lessonId}/playback`,
    ])
      expect((await other.request.get(path)).status()).toBe(403);
    await enroll(other);
    await expect(
      other.getByText("Progress saved to your account.", { exact: true }),
    ).toBeVisible();
    const secondProgress = (
      await (
        await other.request.get(`/api/academy/progress?lessonId=${lessonId}`)
      ).json()
    ).progress[0];
    expect(secondProgress.userId).not.toBe(firstProgress.userId);
    expect(
      (
        await (
          await other.request.get(
            `/api/academy/lessons/${lessonId}/quiz/attempts`,
          )
        ).json()
      ).attempts,
    ).toEqual([]);
    await pool.query(
      "UPDATE customer_users SET status='suspended' WHERE id=$1",
      [secondProgress.userId],
    );
    const denied = await other.request.get(
      `/api/academy/lessons/${lessonId}/playback`,
    );
    expect(denied.status()).toBe(401);
    expect(denied.headers()["cache-control"]).toBe("private, no-store");
    await other.reload();
    await expect(
      other.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    expect(await other.content()).not.toContain("PRIVATE_LEARNING_CONTENT");
  } finally {
    await second.close();
  }
});
