import { createHmac, randomUUID, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  test,
  expect,
  devices,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { setRequiredOnlyCookieConsent } from "../support/required-only-cookie-consent";

type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
type Scenario = {
  courseId: string;
  slug: string;
  lessonIds: { practice: string; graded: string };
  users: Record<"learner" | "other", { id: string; storage: State }>;
};
type Fixture = {
  origin: string;
  apiOrigin: string;
  adminKey: string;
  frontendDatabaseUrl: string;
  courseDatabaseUrl: string;
  muxPublicKey: string;
  scenarios: Record<string, Record<string, Scenario>>;
};
const enabled = process.env.COURSE_LEARNING_BROWSER_FIXTURE === "1";
test.skip(!enabled, "Run through the owned actual learner driver.");
const storagePath = process.env.COURSE_LEARNING_STORAGE_PATH;
const fixture: Fixture | null =
  enabled && storagePath ? JSON.parse(readFileSync(storagePath, "utf8")) : null;
function owned(): Fixture {
  if (!fixture || !/^http:\/\/localhost:\d+$/u.test(fixture.origin))
    throw new Error("Owned actual learner fixture required");
  return fixture;
}
function scenario(project: string, name: string): Scenario {
  const value = owned().scenarios[project]?.[name];
  if (!value) throw new Error("Missing owned learner scenario");
  return value;
}
const externalOrigins = new Set<string>();
const frontendPool = fixture
  ? new Pool({ connectionString: fixture.frontendDatabaseUrl, max: 2 })
  : null;
if (fixture) {
  for (const [value, database] of [
    [fixture.frontendDatabaseUrl, "lash_learning_frontend_integration"],
    [fixture.courseDatabaseUrl, "lash_learning_course_integration"],
  ]) {
    const url = new URL(value);
    if (
      url.protocol !== "postgresql:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== `/${database}` ||
      url.username !== "postgres" ||
      url.password ||
      url.searchParams.get("sslmode") !== "disable"
    )
      throw new Error("Owned disposable learner database required");
  }
  const api = new URL(fixture.apiOrigin);
  if (
    api.protocol !== "http:" ||
    api.hostname !== "127.0.0.1" ||
    api.username ||
    api.password ||
    api.pathname !== "/"
  )
    throw new Error("Owned Course HTTP origin required");
}
const coursePool = fixture
  ? new Pool({ connectionString: fixture.courseDatabaseUrl, max: 2 })
  : null;
test.afterEach(() => {
  try {
    expect(
      [...externalOrigins],
      "Unexpected external browser traffic is blocked",
    ).toEqual([]);
  } finally {
    externalOrigins.clear();
  }
});
test.afterAll(async () => {
  const results = await Promise.allSettled([
    frontendPool?.end(),
    coursePool?.end(),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
});
async function contextFor(browser: Browser, state: State) {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } =
    devices[
      test.info().project.name === "mobile" ? "iPhone 13" : "Desktop Chrome"
    ];
  const context = await browser.newContext({
    storageState: state,
    baseURL: owned().origin,
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    userAgent,
  });
  await setRequiredOnlyCookieConsent(context);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === owned().origin) {
      await route.continue();
      return;
    }
    if (url.hostname === "stream.mux.com") {
      const name = path.basename(url.pathname);
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
      return;
    }
    if (url.hostname === "image.mux.com") {
      await route.fulfill({ status: 404 });
      return;
    }
    if (url.hostname === "learning-media.example.invalid") {
      await route.fulfill({
        contentType: "text/vtt",
        headers: { "access-control-allow-origin": "*" },
        body: "WEBVTT\n\n00:00.000 --> 00:07.000\nA gentle approach protects the natural lash.\n",
      });
      return;
    }
    if (
      url.origin === "https://va.vercel-scripts.com" &&
      [
        "/v1/speed-insights/script.debug.js",
        "/v1/speed-insights/script.js",
      ].includes(url.pathname)
    ) {
      await route.fulfill({
        contentType: "application/javascript",
        body: "/* Owned telemetry fixture: no collection. */",
      });
      return;
    }
    externalOrigins.add(url.origin);
    await route.abort("blockedbyclient");
  });
  return context;
}
async function close(...contexts: (BrowserContext | undefined)[]) {
  const results = await Promise.allSettled(
    contexts.map((context) => context?.close()),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}
const lessonPath = (
  value: Scenario,
  mode: "practice" | "graded" = "practice",
) => `/academy/courses/${value.courseId}/lessons/${value.lessonIds[mode]}`;
async function enroll(page: Page, value: Scenario) {
  await page.goto(`/courses/${value.slug}`);
  await page
    .getByRole("button", { name: "Enroll for free", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Actual learning foundations",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Practice lesson Open lesson", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Practice lesson", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Progress saved to your account.", { exact: true }),
  ).toBeVisible();
}
async function readyPlayer(page: Page) {
  const player = page.locator("mux-player");
  await expect(player).toHaveAttribute("disable-tracking", "");
  await expect
    .poll(() =>
      player.evaluate(
        (element: HTMLElement & { readyState: number }) => element.readyState,
      ),
    )
    .toBeGreaterThan(0);
  return player;
}
async function progress(page: Page, lessonId: string) {
  const response = await page.request.get(
    `/api/academy/progress?lessonId=${lessonId}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()).progress[0];
}
async function answer(page: Page, correct: boolean) {
  await page
    .getByRole("radio", {
      name: correct ? "Use gentle care" : "Pull the extensions",
      exact: true,
    })
    .check();
  await page
    .getByRole("radio", {
      name: correct ? "At your own pace" : "Only once",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Submit answers", exact: true })
    .click();
}
async function revoke(value: Scenario) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      iss: "lash-her-frontend",
      aud: "lash-her-course-api:admin",
      sub: "11111111-1111-4111-8111-111111111111",
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      capabilities: ["course-support"],
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", owned().adminKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const idempotencyKey = randomUUID();
  const response = await fetch(
    new URL("/v1/admin/entitlements/revocations", owned().apiOrigin),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${header}.${payload}.${signature}`,
        "x-idempotency-key": idempotencyKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "userCourse",
        userId: value.users.learner.id,
        courseId: value.courseId,
        reason: "Owned explicit access revocation",
        idempotencyKey,
      }),
    },
  );
  expect(response.ok).toBe(true);
}

test("actual free enrollment, locally signed media, resume and both assessment modes persist", async ({
  browser,
}, info) => {
  const value = scenario(info.project.name, "journey");
  const context = await contextFor(browser, value.users.learner.storage);
  let second: BrowserContext | undefined;
  const page = await context.newPage();
  const browserErrors: string[] = [],
    leakedBoundaries: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (
      request.url().startsWith(owned().apiOrigin) ||
      request.url().includes("learning-gateway.invalid") ||
      request.headers().authorization
    )
      leakedBoundaries.push(new URL(request.url()).origin);
  });
  try {
    await enroll(page, value);
    await expect(
      page
        .getByRole("main")
        .getByText("Private actual practice lesson content.", { exact: true }),
    ).toBeVisible();
    const player = await readyPlayer(page);
    const authorization = await page.request.get(
      `/api/academy/lessons/${value.lessonIds.practice}/playback`,
    );
    expect(authorization.status()).toBe(200);
    expect(authorization.headers()["cache-control"]).toBe("private, no-store");
    const signed = await authorization.json();
    for (const [token, audience] of [
      [signed.playbackToken, "v"],
      [signed.thumbnailToken, "t"],
    ]) {
      const [header, payload, signature] = token.split(".");
      expect(
        verifySignature(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          owned().muxPublicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      expect(claims.aud).toBe(audience);
      expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(claims.exp).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 600,
      );
    }
    await player.evaluate(
      (element: HTMLElement & { currentTime: number; pause: () => void }) => {
        element.currentTime = 4;
        element.pause();
      },
    );
    await expect
      .poll(
        async () =>
          (await progress(page, value.lessonIds.practice))
            .resumePositionSeconds,
      )
      .toBeGreaterThanOrEqual(3);
    await page.getByText("Read the transcript", { exact: true }).click();
    await expect(
      page
        .getByRole("main")
        .getByText("A gentle approach protects the natural lash.", {
          exact: true,
        }),
    ).toBeVisible();
    await answer(page, false);
    await expect(
      page.getByRole("heading", { name: "Practice complete", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("main")
        .getByText("Lesson complete. Progress saved.", { exact: true }),
    ).toBeVisible();
    expect(
      (await progress(page, value.lessonIds.practice)).completedQuizRevision,
    ).toBe(1);
    await page
      .getByRole("link", { name: "Next: Graded lesson", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Graded lesson", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mark lesson complete" }),
    ).toHaveCount(0);
    await answer(page, false);
    await expect(
      page.getByRole("heading", { name: "Keep practising", exact: true }),
    ).toBeVisible();
    expect(
      (await progress(page, value.lessonIds.graded)).completedAt,
    ).toBeNull();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await answer(page, true);
    await expect(
      page.getByRole("heading", { name: "Assessment passed", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("main")
        .getByText("Lesson complete. Progress saved.", { exact: true }),
    ).toBeVisible();
    second = await contextFor(browser, value.users.learner.storage);
    const otherDevice = await second.newPage();
    await otherDevice.goto(lessonPath(value));
    const resumed = await readyPlayer(otherDevice);
    await expect
      .poll(() =>
        resumed.evaluate(
          (element: HTMLElement & { currentTime: number }) =>
            element.currentTime,
        ),
      )
      .toBeGreaterThanOrEqual(3);
    await expect(
      otherDevice.getByRole("main").getByText(/^Lesson complete\./),
    ).toBeVisible();
    expect(
      await otherDevice.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("lh_course_progress:"),
        ),
      ),
    ).toEqual([]);
    const rows = await coursePool!.query(
      "select qa.completed,qa.passed,qa.correct_count,qr.document->>'mode' mode from quiz_attempts qa join quiz_revisions qr on qr.id=qa.quiz_revision_id where qa.user_id=$1 order by qa.created_at",
      [value.users.learner.id],
    );
    expect(rows.rows).toEqual([
      { completed: true, passed: false, correct_count: 0, mode: "practice" },
      { completed: false, passed: false, correct_count: 0, mode: "graded" },
      { completed: true, passed: true, correct_count: 2, mode: "graded" },
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(browserErrors).toEqual([]);
    expect(leakedBoundaries).toEqual([]);
    await page.screenshot({
      path: info.outputPath("actual-learning-complete.png"),
      fullPage: true,
    });
  } finally {
    await close(context, second);
  }
});

test("actual Course CAS conflict preserves the other device position until authoritative reload", async ({
  browser,
}, info) => {
  const value = scenario(info.project.name, "conflict");
  const context = await contextFor(browser, value.users.learner.storage);
  const page = await context.newPage();
  try {
    await enroll(page, value);
    const player = await readyPlayer(page);
    await player.evaluate(
      (element: HTMLElement & { currentTime: number; pause: () => void }) => {
        element.currentTime = 4;
        element.pause();
      },
    );
    await expect
      .poll(
        async () =>
          (await progress(page, value.lessonIds.practice))
            .resumePositionSeconds,
      )
      .toBeGreaterThanOrEqual(3);
    const current = await progress(page, value.lessonIds.practice);
    const concurrent = await page.request.post(
      `/api/academy/lessons/${value.lessonIds.practice}/progress`,
      {
        headers: { origin: owned().origin, "x-lash-csrf": "1" },
        data: {
          expectedProgressRevision: current.revision,
          resumePositionSeconds: 6,
          maxPositionSeconds: 6,
        },
      },
    );
    expect(concurrent.status()).toBe(200);
    await player.evaluate(
      (element: HTMLElement & { currentTime: number; pause: () => void }) => {
        element.currentTime = 2;
        element.pause();
      },
    );
    await expect(
      page.getByRole("button", { name: "Load latest progress", exact: true }),
    ).toBeVisible();
    expect(
      (await progress(page, value.lessonIds.practice)).resumePositionSeconds,
    ).toBe(6);
    await page
      .getByRole("button", { name: "Load latest progress", exact: true })
      .click();
    const reloaded = await readyPlayer(page);
    await expect
      .poll(() =>
        reloaded.evaluate(
          (element: HTMLElement & { currentTime: number }) =>
            element.currentTime,
        ),
      )
      .toBeGreaterThanOrEqual(5);
    const stored = await coursePool!.query(
      "select resume_position_seconds,max_position_seconds from lesson_progress where user_id=$1 and lesson_id=$2",
      [value.users.learner.id, value.lessonIds.practice],
    );
    expect(stored.rows[0]).toMatchObject({
      resume_position_seconds: 6,
      max_position_seconds: 6,
    });
  } finally {
    await close(context);
  }
});

test("actual Course account isolation and grant revocation plus frontend suspension deny protected access", async ({
  browser,
}, info) => {
  const value = scenario(info.project.name, "boundaries");
  const context = await contextFor(browser, value.users.learner.storage);
  let second: BrowserContext | undefined;
  const page = await context.newPage();
  try {
    await enroll(page, value);
    await answer(page, false);
    await expect(
      page.getByRole("heading", { name: "Practice complete", exact: true }),
    ).toBeVisible();
    second = await contextFor(browser, value.users.other.storage);
    const other = await second.newPage();
    await other.goto(lessonPath(value));
    await expect(
      other.getByRole("heading", { name: "Enrollment required", exact: true }),
    ).toBeVisible();
    for (const endpoint of [
      `/api/academy/progress?lessonId=${value.lessonIds.practice}`,
      `/api/academy/lessons/${value.lessonIds.practice}/quiz/attempts`,
      `/api/academy/lessons/${value.lessonIds.practice}/playback`,
    ])
      expect((await other.request.get(endpoint)).status()).toBe(403);
    expect(await other.content()).not.toContain(
      "Private actual practice lesson content.",
    );
    await enroll(other, value);
    expect((await progress(other, value.lessonIds.practice)).userId).toBe(
      value.users.other.id,
    );
    expect(
      (
        await (
          await other.request.get(
            `/api/academy/lessons/${value.lessonIds.practice}/quiz/attempts`,
          )
        ).json()
      ).attempts,
    ).toEqual([]);
    await revoke(value);
    const revoked = await page.request.get(
      `/api/academy/lessons/${value.lessonIds.practice}/playback`,
    );
    expect(revoked.status()).toBe(403);
    expect(revoked.headers()["cache-control"]).toBe("private, no-store");
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "Course access has ended",
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.content()).not.toContain(
      "Private actual practice lesson content.",
    );
    await frontendPool!.query(
      "update customer_users set status='suspended' where id=$1",
      [value.users.other.id],
    );
    expect(
      (
        await other.request.get(
          `/api/academy/lessons/${value.lessonIds.practice}/playback`,
        )
      ).status(),
    ).toBe(401);
    await other.reload();
    await expect(
      other.getByRole("heading", { name: "Sign in to continue", exact: true }),
    ).toBeVisible();
    expect(await other.content()).not.toContain(
      "Private actual practice lesson content.",
    );
    const grants = await coursePool!.query(
      "select user_id,status,grant_reason from entitlement_grants where course_id=$1 order by user_id",
      [value.courseId],
    );
    expect(grants.rows).toContainEqual({
      user_id: value.users.learner.id,
      status: "revoked",
      grant_reason: "free",
    });
    expect(grants.rows).toContainEqual({
      user_id: value.users.other.id,
      status: "active",
      grant_reason: "free",
    });
  } finally {
    await close(context, second);
  }
});
