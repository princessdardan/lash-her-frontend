import { createHash, createHmac, randomUUID, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { QuizAttempt } from "@/lib/learning/types";
import {
  test,
  expect,
  devices,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { setRequiredOnlyCookieConsent } from "../support/required-only-cookie-consent";

type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
type Scenario = {
  courseId: string;
  courseRevision: number;
  slug: string;
  lessonIds: { practice: string; graded: string };
  users: Record<"learner" | "other", { id: string; storage: State }>;
  secondDevice?: State;
};
type Fixture = {
  origin: string;
  apiOrigin: string;
  adminKey: string;
  frontendDatabaseUrl: string;
  courseDatabaseUrl: string;
  muxPublicKey: string;
  browserCertificateSpki?: string;
  gatewayJournal: string;
  scenarios: Record<string, Record<string, Scenario>>;
};
const enabled = process.env.COURSE_LEARNING_BROWSER_FIXTURE === "1";
test.skip(!enabled, "Run through the owned actual learner driver.");
const storagePath = process.env.COURSE_LEARNING_STORAGE_PATH;
const fixture: Fixture | null =
  enabled && storagePath ? JSON.parse(readFileSync(storagePath, "utf8")) : null;
const production = process.env.COURSE_LEARNING_BROWSER_MODE === "production";
const ownedBrowserArguments = (spki: string) => [
  `--ignore-certificate-errors-spki-list=${spki}`,
  "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND",
];
if (production && fixture) {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(fixture.browserCertificateSpki ?? ""))
    throw new Error("Owned loopback browser certificate required");
  test.use({ launchOptions: { args: ownedBrowserArguments(fixture.browserCertificateSpki!) } });
}
function owned(): Fixture {
  if (!fixture || !(production ? /^https:\/\/localhost:\d+$/u : /^http:\/\/localhost:\d+$/u).test(fixture.origin))
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
async function contextFor(browser: Browser, state: State, longerMedia = false) {
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
          body: readFileSync(longerMedia ? "tests/fixtures/course-mux-long.m3u8" : "tests/fixtures/course-mux.m3u8"),
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
const readOwnedGatewayJournal = () => readFileSync(owned().gatewayJournal, "utf8").trim().split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as {
    method: string; target: string; status: number; requestId?: string; canonicalDenial?: boolean; canonicalNoMedia?: boolean;
  });
async function enroll(page: Page, value: Scenario) {
  const start = readOwnedGatewayJournal().length;
  const catalog = `/course/v1/courses/${value.slug}`;
  const student = `/course/v1/student/courses/${value.courseId}`;
  await page.goto(`/courses/${value.slug}`);
  const button = page.getByRole("button", { name: "Enroll for free", exact: true });
  await expect(button).toBeVisible();
  expect(readOwnedGatewayJournal().slice(start).filter(row => row.target === catalog || row.target === student)).toEqual([
    { method: "GET", target: catalog, status: 200 },
    { method: "GET", target: student, status: 403 },
  ]);
  const pending = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === `/api/academy/courses/${value.courseId}/enrollments`);
  await button.click();
  const response = await pending;
  expect(response.status()).toBe(200);
  expect(await response.headerValue("cache-control")).toBe("private, no-store");
  const first = await response.json();
  expect(first).toMatchObject({ courseId: value.courseId, source: "free", status: "active", idempotentReplay: false });
  await expect(page.getByRole("link", { name: "Course overview", exact: true })).toHaveAttribute("href", `/courses/${value.slug}`);
  expect(readOwnedGatewayJournal().slice(start)).toEqual(expect.arrayContaining([
    { method: "POST", target: student + "/enrollments", status: 201 },
    { method: "GET", target: student, status: 200 },
    { method: "GET", target: `/course/v1/student/progress?courseId=${value.courseId}`, status: 200 },
  ]));
  await expect(
    page.getByRole("heading", {
      name: "Actual learning foundations",
      exact: true,
    }),
  ).toBeVisible();
  const requestBody = response.request().postDataJSON();
  expect(requestBody).toEqual({ idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/u) });
  const replay = await page.evaluate(async ({ courseId, body }) => {
    const response = await fetch(`/api/academy/courses/${courseId}/enrollments`, {
      method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error",
      headers: { "content-type": "application/json", "x-lash-csrf": "1" }, body: JSON.stringify(body),
    });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  }, { courseId: value.courseId, body: requestBody });
  expect(replay).toEqual({ status: 200, cache: "private, no-store", body: { ...first, idempotentReplay: true } });
  expect(readOwnedGatewayJournal().slice(start).filter(row => row.method === "POST" && row.target === student + "/enrollments")).toEqual([
    { method: "POST", target: student + "/enrollments", status: 201 },
    { method: "POST", target: student + "/enrollments", status: 200 },
  ]);
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

type ResumeProgress = {
  id: string;
  enrollmentId: string;
  revision: number;
  resumePositionSeconds: number;
  maxPositionSeconds: number;
  completedAt: string | null;
};

test("production Academy native playback, rewind and separate-session resume", async ({ browser }, info) => {
  test.skip(!production, "Requires the owned Next production build.");
  const value = scenario(info.project.name, "resume");
  if (!value.secondDevice) throw new Error("A separately seeded device session is required");
  const learner = value.users.learner;
  const lessonId = value.lessonIds.practice;
  const pathname = lessonPath(value);
  const api = `/api/academy/lessons/${lessonId}`;
  const upstream = `/course/v1/student/lessons/${lessonId}`;
  const upstreamReads = [
    `/course/v1/student/courses/${value.courseId}`, upstream,
    `/course/v1/student/progress?lessonId=${lessonId}`, upstream + "/quiz", upstream + "/quiz/attempts", upstream + "/playback",
  ];
  const firstToken = learner.storage.cookies[0].value;
  const secondToken = value.secondDevice.cookies[0].value;
  expect(secondToken).not.toBe(firstToken);
  const { rows: sessionRows } = await frontendPool!.query(
    "select user_id from customer_sessions where token_hash=any($1::text[]) and expires>now()",
    [[firstToken, secondToken].map(token => createHash("sha256").update(token).digest("hex"))],
  );
  expect(sessionRows).toEqual([{ user_id: learner.id }, { user_id: learner.id }]);
  const persisted = async () => (await coursePool!.query(
    "select id, enrollment_id, revision, resume_position_seconds, max_position_seconds, completed_at from lesson_progress where user_id=$1 and lesson_id=$2",
    [learner.id, lessonId],
  )).rows;
  const capture = (page: Page) => {
    const requests: Request[] = [];
    const media = new Set<string>();
    page.on("request", request => {
      if (request.method() === "POST" && request.url() === owned().origin + api + "/progress") requests.push(request);
    });
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.hostname === "stream.mux.com" && response.ok()) {
        if (url.pathname.endsWith(".m3u8")) media.add("playlist");
        if (url.pathname.endsWith(".mpegts")) media.add("segment");
      }
    });
    return {
      requests, media,
      write: (expected: number) => page.waitForResponse(response => response.url() === owned().origin + api + "/progress" &&
        response.request().method() === "POST" && response.request().postDataJSON()?.expectedProgressRevision === expected,
      { timeout: 20_000 }),
      playback: () => page.waitForResponse(response => response.url() === owned().origin + api + "/playback" &&
        response.request().method() === "GET"),
    };
  };
  const receipt = async (response: Response, expected: number) => {
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    const progress = (await response.json()).progress as ResumeProgress;
    const requestId = response.headers()["x-request-id"];
    const body = response.request().postDataJSON();
    const canonical = body.event === "lesson_started" ?
      { event: body.event, expectedProgressRevision: expected } :
      { resumePositionSeconds: body.resumePositionSeconds, maxPositionSeconds: body.maxPositionSeconds, expectedProgressRevision: expected };
    expect(response.request().postData()).toBe(JSON.stringify(canonical));
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(progress).toMatchObject({ revision: expected + 1, completedAt: null });
    return {
      requestId,
      body,
      progress,
    };
  };
  const verifyGateway = (offset: number, playback: Response, writes: Awaited<ReturnType<typeof receipt>>[]) => {
    const rows = readOwnedGatewayJournal().slice(offset).filter(row =>
      upstreamReads.includes(row.target) || row.target === upstream + "/progress");
    expect(rows).toHaveLength(6 + writes.length);
    expect(rows.every(row => row.status === 200)).toBe(true);
    const indexes = rows.map(row => row.method === "POST" ? 6 + writes.findIndex(write => write.requestId === row.requestId)
      : upstreamReads.indexOf(row.target));
    expect(indexes.slice(0, 5).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(indexes.slice(5, 7).sort()).toEqual([5, 6]);
    expect(indexes.slice(7)).toEqual(writes.slice(1).map((_write, index) => index + 7));
    expect(rows.find(row => row.target === upstream + "/playback")?.requestId).toBe(playback.headers()["x-request-id"]);
    return indexes;
  };
  const first = await contextFor(browser, learner.storage, true);
  let secondBrowser: Browser | undefined;
  let second: BrowserContext | undefined;
  try {
    expect(await persisted()).toEqual([]);
    const page = await first.newPage();
    const observed = capture(page);
    const initialOffset = readOwnedGatewayJournal().length;
    const [opened, playback, document] = await Promise.all([observed.write(0), observed.playback(), page.goto(pathname)]);
    expect(document?.status()).toBe(200);
    expect(playback.status()).toBe(200);
    const started = await receipt(opened, 0);
    expect(started.body).toEqual({ event: "lesson_started", expectedProgressRevision: 0 });
    expect(started.progress).toMatchObject({ resumePositionSeconds: 0, maxPositionSeconds: 0 });
    const player = await readyPlayer(page);
    const mediaSample = () => player.evaluate((element: HTMLElement & {
      currentTime: number; duration: number; paused: boolean; readyState: number;
    }) => ({ currentTime: element.currentTime, duration: element.duration, paused: element.paused, readyState: element.readyState }));
    expect((await mediaSample()).duration).toBe(32);
    const button = (name: string) => player.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    const [played] = await Promise.all([observed.write(1), button("play").click()]);
    const heartbeat = await receipt(played, 1);
    expect(heartbeat.progress.resumePositionSeconds).toBeGreaterThanOrEqual(10);
    expect(heartbeat.progress.resumePositionSeconds).toBeLessThanOrEqual(12);
    expect(heartbeat.progress.maxPositionSeconds).toBe(heartbeat.progress.resumePositionSeconds);
    await expect.poll(async () => (await mediaSample()).currentTime, { intervals: [25, 50, 75] }).toBeGreaterThanOrEqual(14);
    const [stopped] = await Promise.all([observed.write(2), button("pause").press("Enter")]);
    const paused = await receipt(stopped, 2);
    expect(paused.progress.resumePositionSeconds).toBeGreaterThanOrEqual(14);
    expect(paused.progress.resumePositionSeconds).toBeLessThanOrEqual(17);
    expect(paused.progress.maxPositionSeconds).toBeGreaterThanOrEqual(heartbeat.progress.maxPositionSeconds);
    expect(paused.body.maxPositionSeconds).toBeGreaterThanOrEqual(heartbeat.progress.maxPositionSeconds);
    expect(paused.body.maxPositionSeconds).toBeLessThanOrEqual(paused.body.resumePositionSeconds);
    const pauseSample = await mediaSample();
    expect(pauseSample.paused).toBe(true);
    // The native player keyboard shortcut is available even when the responsive
    // layout hides the visible seek-back button.
    const [sought] = await Promise.all([observed.write(3), button("play").press("ArrowLeft")]);
    const rewound = await receipt(sought, 3);
    const rewindSample = await mediaSample();
    expect(rewindSample.paused).toBe(true);
    expect(rewound.progress.resumePositionSeconds).toBe(paused.progress.resumePositionSeconds - 10);
    expect(rewound.progress.maxPositionSeconds).toBe(paused.progress.maxPositionSeconds);
    expect(observed.requests.map(request => request.postDataJSON())).toEqual([
      started.body, heartbeat.body, paused.body, rewound.body,
    ]);
    expect([...observed.media].sort()).toEqual(["playlist", "segment"]);
    const firstWrites = [started, heartbeat, paused, rewound];
    const firstIndexes = verifyGateway(initialOffset, playback, firstWrites);
    expect(await persisted()).toEqual([{
      id: rewound.progress.id, enrollment_id: rewound.progress.enrollmentId, revision: 4,
      resume_position_seconds: rewound.progress.resumePositionSeconds, max_position_seconds: rewound.progress.maxPositionSeconds,
      completed_at: null,
    }]);

    // Separate browser processes keep the paused first device visible while the second device starts.
    secondBrowser = await browser.browserType().launch({ args: ownedBrowserArguments(owned().browserCertificateSpki!) });
    second = await contextFor(secondBrowser, value.secondDevice, true);
    const restoredPage = await second.newPage();
    const resumed = capture(restoredPage);
    const restoreOffset = readOwnedGatewayJournal().length;
    const [resumedStart, resumedPlayback, resumedSeek, resumedDocument] = await Promise.all([
      resumed.write(4), resumed.playback(), resumed.write(5), restoredPage.goto(pathname),
    ]);
    expect(resumedDocument?.status()).toBe(200);
    expect(resumedPlayback.status()).toBe(200);
    const restarted = await receipt(resumedStart, 4);
    const restored = await receipt(resumedSeek, 5);
    expect(restarted.body).toEqual({ event: "lesson_started", expectedProgressRevision: 4 });
    for (const next of [restarted.progress, restored.progress]) {
      expect(next).toMatchObject({
        id: rewound.progress.id, enrollmentId: rewound.progress.enrollmentId,
        resumePositionSeconds: rewound.progress.resumePositionSeconds, maxPositionSeconds: rewound.progress.maxPositionSeconds,
      });
    }
    const restoredPlayer = await readyPlayer(restoredPage);
    const restoredSample = await restoredPlayer.evaluate((element: HTMLElement & {
      currentTime: number; duration: number; paused: boolean; readyState: number;
    }) => ({ currentTime: element.currentTime, duration: element.duration, paused: element.paused, readyState: element.readyState }));
    expect(restoredSample.paused).toBe(true);
    expect(restoredSample.currentTime).toBeCloseTo(rewound.progress.resumePositionSeconds, 1);
    expect(resumed.requests.map(request => request.postDataJSON())).toEqual([restarted.body, restored.body]);
    expect(observed.requests).toHaveLength(4);
    expect([...resumed.media].sort()).toEqual(["playlist", "segment"]);
    const restoreWrites = [restarted, restored];
    const restoreIndexes = verifyGateway(restoreOffset, resumedPlayback, restoreWrites);
    expect(await persisted()).toEqual([{
      id: rewound.progress.id, enrollment_id: rewound.progress.enrollmentId, revision: 6,
      resume_position_seconds: rewound.progress.resumePositionSeconds, max_position_seconds: rewound.progress.maxPositionSeconds,
      completed_at: null,
    }]);
    const compact = (entry: Awaited<ReturnType<typeof receipt>>) => ({
      requestId: entry.requestId, body: entry.body,
      progress: {
        revision: entry.progress.revision, resumePositionSeconds: entry.progress.resumePositionSeconds,
        maxPositionSeconds: entry.progress.maxPositionSeconds,
      },
    });
    await writeFile(info.outputPath("resume.json"), JSON.stringify({
      syntheticHls: true, distinctDatabaseSessions: true,
      deviceOne: { writes: firstWrites.map(compact), gatewayIndexes: firstIndexes, pauseSample, rewindSample },
      deviceTwo: { writes: restoreWrites.map(compact), gatewayIndexes: restoreIndexes, restoredSample },
    }, null, 2) + "\n", { mode: 0o600 });
  } finally {
    await close(first, second);
    await secondBrowser?.close();
  }
});

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
function courseAdminBearer(capability: "course-editor" | "course-support") {
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
      capabilities: [capability],
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", owned().adminKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}
async function revoke(value: Scenario) {
  const idempotencyKey = randomUUID();
  const response = await fetch(
    new URL("/v1/admin/entitlements/revocations", owned().apiOrigin),
    {
      method: "POST",
      headers: {
        authorization: courseAdminBearer("course-support"),
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

async function advanceOwnedQuizRevision(value: Scenario) {
  const course = `/v1/admin/courses/${value.courseId}`;
  const quizPath = `/v1/admin/lessons/${value.lessonIds.graded}/quiz`;
  const edit = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, owned().apiOrigin), {
      method,
      headers: { authorization: courseAdminBearer("course-editor"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const initial = (await edit("GET", quizPath)).quiz;
  const draft = (await edit("PATCH", course, { expectedRevision: value.courseRevision, status: "draft" })).course;
  expect(draft).toMatchObject({ status: "draft", revision: value.courseRevision + 1 });
  const document = structuredClone(initial.document);
  document.questions[0].prompt += " Reviewed revision two.";
  const revised = (await edit("PUT", quizPath, { expectedCourseRevision: draft.revision, document })).quiz;
  expect(revised).toMatchObject({ revision: initial.revision + 1, courseRevision: draft.revision + 1 });
  const published = (await edit("PATCH", course, { expectedRevision: revised.courseRevision, status: "published" })).course;
  expect(published).toMatchObject({ status: "published", revision: revised.courseRevision + 1 });
  return revised.revision;
}

test("production Academy graded assessment fail, pass and stale form", async ({ browser }, info) => {
  test.skip(!production, "Requires the owned Next production build.");
  const value = scenario(info.project.name, "assessment");
  const lessonId = value.lessonIds.graded;
  const pathname = lessonPath(value, "graded");
  const lessonApi = `/api/academy/lessons/${lessonId}`;
  const progressApi = `/api/academy/progress?lessonId=${lessonId}`;
  const attemptApi = `${lessonApi}/quiz/attempts`;
  const context = await contextFor(browser, value.users.learner.storage);
  const page = await context.newPage();
  const gatewayOffset = readOwnedGatewayJournal().length;
  const upstreamLesson = `/course/v1/student/lessons/${lessonId}`;
  const upstream = [`/course/v1/student/courses/${value.courseId}`, upstreamLesson,
    `/course/v1/student/progress?lessonId=${lessonId}`, `${upstreamLesson}/quiz`, `${upstreamLesson}/quiz/attempts`,
    `${upstreamLesson}/playback`, `${upstreamLesson}/progress`];
  const waitFor = (target: string, method: string) => page.waitForResponse(response =>
    response.url() === owned().origin + target && response.request().method() === method);
  const readState = async () => (await coursePool!.query(
    `select
       (select jsonb_agg(to_jsonb(p) order by p.id) from lesson_progress p where p.lesson_id=$1 and p.user_id=$2) as progress,
       (select jsonb_agg(to_jsonb(a) order by a.id) from quiz_attempts a where a.lesson_id=$1 and a.user_id=$2) as attempts,
       (select count(*)::int from video_assets v where v.lesson_id=$1) as assets`,
    [lessonId, value.users.learner.id],
  )).rows[0];
  try {
    expect(await readState()).toEqual({ progress: null, attempts: null, assets: 0 });
    const [playback, started, document] = await Promise.all([
      waitFor(`${lessonApi}/playback`, "GET"), waitFor(`${lessonApi}/progress`, "POST"), page.goto(pathname),
    ]);
    expect(document?.status()).toBe(200);
    expect(playback.status()).toBe(404);
    expect(await playback.json()).toMatchObject({ error: { code: "not_found" } });
    expect(started.status()).toBe(200);
    expect(started.request().postDataJSON()).toEqual({ event: "lesson_started", expectedProgressRevision: 0 });
    const initial = (await started.json()).progress;
    expect(initial).toMatchObject({ revision: 1, completedAt: null, maxPositionSeconds: 0, resumePositionSeconds: 0 });
    await expect(page.getByRole("heading", { name: "Check your understanding", exact: true })).toBeVisible();

    const attempts: { attempt: QuizAttempt; payloadRequestId: string; requestId: string; progressRequestId: string }[] = [];
    for (const passed of [false, true]) {
      if (passed) await page.getByRole("button", { name: "Try again", exact: true }).click();
      const [saved, refresh] = await Promise.all([waitFor(attemptApi, "POST"), waitFor(progressApi, "GET"), answer(page, passed)]);
      expect(saved.status()).toBe(200);
      expect(refresh.status()).toBe(200);
      const submitted = saved.request().postDataJSON();
      const expectedAnswers = [{ questionId: "q1", optionId: passed ? "gentle" : "pull" },
        { questionId: "q2", optionId: passed ? "anytime" : "never" }];
      expect(submitted).toEqual({ quizRevision: 1, requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u), answers: expectedAnswers });
      const attempt = (await saved.json()).attempt;
      expect(attempt).toMatchObject({ quizRevision: 1, mode: "graded", passingPercent: 80, answers: expectedAnswers,
        correctCount: passed ? 2 : 0, totalCount: 2, passed, completed: passed });
      expect((await refresh.json()).progress).toEqual([expect.objectContaining({
        id: initial.id, enrollmentId: initial.enrollmentId, revision: passed ? 3 : 2,
        completedAt: passed ? attempt.createdAt : null, completedQuizRevision: passed ? 1 : null,
        maxPositionSeconds: 0, resumePositionSeconds: 0,
      })]);
      await expect(page.getByRole("heading", { name: passed ? "Assessment passed" : "Keep practising", exact: true })).toBeVisible();
      attempts.push({ attempt, payloadRequestId: submitted.requestId, requestId: saved.headers()["x-request-id"],
        progressRequestId: refresh.headers()["x-request-id"] });
    }
    expect(new Set(attempts.map(row => row.payloadRequestId)).size).toBe(2);
    await expect(page.getByText("Lesson complete. Progress saved.", { exact: true })).toBeVisible();
    await expect(page.locator("mux-player")).toHaveCount(0);
    const persisted = await readState();
    expect(persisted.progress).toEqual([expect.objectContaining({ id: initial.id, revision: 3, completed_quiz_revision: 1 })]);
    expect(persisted.attempts).toEqual(expect.arrayContaining(attempts.map(({ attempt, payloadRequestId }) =>
      expect.objectContaining({ id: attempt.id, request_id: payloadRequestId, quiz_revision_id: attempt.quizRevisionId,
        enrollment_id: initial.enrollmentId, correct_count: attempt.correctCount, passed: attempt.passed, completed: attempt.completed }))));
    expect(persisted.attempts).toHaveLength(2);
    const selectedRows = () => readOwnedGatewayJournal().slice(gatewayOffset).filter(row => upstream.includes(row.target));
    const rows = selectedRows();
    const indexes = rows.map(row => row.method === "POST" && row.target.endsWith("/attempts") ?
      (row.requestId === attempts[0].requestId ? 7 : 8) : upstream.indexOf(row.target));
    expect(rows).toHaveLength(11);
    expect(indexes.slice(0, 5).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(indexes.slice(5, 7).sort()).toEqual([5, 6]);
    expect(indexes.slice(7)).toEqual([7, 2, 8, 2]);
    expect(rows.every((row, index) => row.status === (indexes[index] === 5 ? 404 : 200))).toBe(true);
    expect(rows.find(row => row.target.endsWith("/playback"))?.canonicalNoMedia).toBe(true);
    expect(rows[indexes.indexOf(5)].requestId).toBe(playback.headers()["x-request-id"]);
    expect(rows[indexes.indexOf(6)].requestId).toBe(started.headers()["x-request-id"]);
    expect(rows.slice(7).map(row => row.requestId)).toEqual(attempts.flatMap(row => [row.requestId, row.progressRequestId]));

    const currentRevision = await advanceOwnedQuizRevision(value);
    expect(currentRevision).toBe(2);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    const [stale] = await Promise.all([waitFor(attemptApi, "POST"), answer(page, false)]);
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
    const staleBody = stale.request().postDataJSON();
    expect(staleBody.quizRevision).toBe(1);
    expect(attempts.map(row => row.payloadRequestId)).not.toContain(staleBody.requestId);
    await expect(page.getByRole("button", { name: "Load the latest assessment", exact: true })).toBeVisible();
    expect(await readState()).toEqual(persisted);
    expect(selectedRows().slice(11)).toEqual([expect.objectContaining({
      method: "POST", target: `${upstreamLesson}/quiz/attempts`, status: 409,
    })]);
    const currentProgress = await page.evaluate(async target => {
      const response = await fetch(target, { credentials: "same-origin", redirect: "error" });
      if (!response.ok) throw new Error("Owned assessment progress read failed");
      return (await response.json()).progress[0];
    }, progressApi);
    expect(currentProgress).toMatchObject({ id: initial.id, revision: 3, completedAt: null });
    expect(await readState()).toEqual(persisted);
    await writeFile(info.outputPath("assessment.json"), JSON.stringify({
      indexes, noMedia: true, progressRevisions: [1, 2, 3], failedScore: 0, passedScore: 2,
      stale: { status: stale.status(), priorRevision: staleBody.quizRevision, currentRevision,
        unchanged: true, currentRevisionCompletion: currentProgress.completedAt },
    }, null, 2) + "\n", { mode: 0o600 });
  } finally {
    await close(context);
  }
});

async function verifyProductionLessonDenial(browser: Browser, value: Scenario) {
  const pathname = lessonPath(value);
  const lessonId = value.lessonIds.practice;
  const lessonApi = `/api/academy/lessons/${lessonId}`;
  const targets = [
    lessonApi,
    `${lessonApi}/playback`,
    `/api/academy/progress?lessonId=${lessonId}`,
    `${lessonApi}/quiz`,
    `${lessonApi}/quiz/attempts`,
  ];
  const lessonUpstream = `/course/v1/student/lessons/${lessonId}`;
  const upstream = [
    `/course/v1/student/courses/${value.courseId}`,
    lessonUpstream,
    `/course/v1/student/progress?lessonId=${lessonId}`,
    `${lessonUpstream}/quiz`,
    `${lessonUpstream}/quiz/attempts`,
    `${lessonUpstream}/playback`,
  ];
  const readState = async () => (await coursePool!.query(
    `select
       (select jsonb_agg(to_jsonb(g) order by g.id) from entitlement_grants g where g.course_id=$1) as grants,
       (select jsonb_agg(to_jsonb(e) order by e.id) from enrollments e where e.course_id=$1) as enrollments,
       (select jsonb_agg(to_jsonb(p) order by p.id) from lesson_progress p where p.lesson_id=$2) as progress,
       (select jsonb_agg(to_jsonb(a) order by a.id) from quiz_attempts a where a.lesson_id=$2) as attempts,
       (select jsonb_agg(to_jsonb(v) order by v.id) from video_assets v where v.lesson_id=$2) as media`,
    [value.courseId, lessonId],
  )).rows[0];
  const before = await readState();
  expect(before.grants).toEqual([expect.objectContaining({ user_id: value.users.learner.id, status: "active", grant_reason: "free" })]);
  expect(before.enrollments).toEqual([expect.objectContaining({ user_id: value.users.learner.id, status: "active" })]);
  expect(before.progress).toEqual([expect.objectContaining({ user_id: value.users.learner.id, revision: 1 })]);
  expect(before.attempts).toBeNull();
  expect(before.media).toEqual([expect.objectContaining({
    status: "ready", managed_by_course: true, is_current: true, last_token_expires_at: expect.any(String),
  })]);

  const context = await contextFor(browser, value.users.other.storage);
  const page = await context.newPage();
  const gatewayOffset = readOwnedGatewayJournal().length;
  const academyWrites: string[] = [];
  const mediaRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === owned().origin && url.pathname.startsWith("/api/academy/") && request.method() !== "GET")
      academyWrites.push(request.method());
    if (["stream.mux.com", "image.mux.com", "learning-media.example.invalid"].includes(url.hostname))
      mediaRequests.push(url.hostname);
  });
  try {
    const document = await page.goto(pathname);
    expect(document?.status()).toBe(200);
    expect(document?.headers()["content-type"]).toMatch(/^text\/html(?:;|$)/u);
    expect(document?.headers()["cache-control"]).toMatch(/\bprivate\b.*\bno-store\b/u);
    await expect(page.getByRole("heading", { name: "Enrollment required", exact: true })).toBeVisible();
    await expect(page.locator("mux-player")).toHaveCount(0);
    const referencePattern = /^Reference: ([a-f0-9-]{36})$/u;
    const documentRequestId = referencePattern.exec(await page.getByRole("main").getByText(referencePattern).innerText())?.[1];
    const documentBody = await document!.text();
    expect(documentBody).toContain(documentRequestId);

    const evidence = await page.evaluate(async ({ pathname, targets }) => {
      const request = (path: string, headers?: HeadersInit) => fetch(path, {
        headers, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      // Next 16 uses a bare _rsc cache key when no router-state or prefetch headers are supplied.
      const flight = await request(`${pathname}?_rsc`, { RSC: "1" });
      const flightBody = await flight.text();
      const reads = [];
      for (const target of targets) {
        const response = await request(target);
        reads.push({
          status: response.status,
          cache: response.headers.get("cache-control"),
          requestId: response.headers.get("x-request-id"),
          body: await response.json(),
        });
      }
      return {
        flight: {
          status: flight.status,
          type: flight.headers.get("content-type"),
          cache: flight.headers.get("cache-control"),
          vary: flight.headers.get("vary"),
          body: flightBody,
        },
        reads,
      };
    }, { pathname, targets });
    expect(evidence.flight).toMatchObject({
      status: 200,
      type: expect.stringMatching(/^text\/x-component(?:;|$)/u),
      cache: expect.stringMatching(/\bprivate\b.*\bno-store\b/u),
      vary: expect.stringMatching(/(?:^|,\s*)rsc(?:,|$)/iu),
    });
    expect(evidence.flight.body).toContain("Enrollment required");
    expect(evidence.flight.body).toContain("learning-unavailable-title");
    expect(evidence.flight.body).toContain("Open the course page to enroll or check your access.");
    const flightRequestId = /"Reference: ","([a-f0-9-]{36})"/u.exec(evidence.flight.body)?.[1];
    for (const body of [documentBody, evidence.flight.body]) {
      for (const privateText of ["Private actual practice lesson content.", "A gentle approach protects the natural lash.",
        "Which approach protects the natural lash?", "p2q-s07-private-content", "p2q-s07-private-transcript",
        "p2q-s07-private-quiz", before.media[0].mux_playback_id])
        expect(body).not.toContain(privateText);
    }
    const reads = evidence.reads.map(({ status, cache, requestId, body }) => {
      expect(status).toBe(403);
      expect(cache).toBe("private, no-store");
      expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(body).toEqual({ error: { code: "access_required", message: "Course access is required." }, requestId });
      return { status, code: body.error.code, requestId };
    });
    expect(new Set(reads.map(read => read.requestId)).size).toBe(targets.length);
    expect(academyWrites).toEqual([]);
    expect(mediaRequests).toEqual([]);
    const gatewayRows = readOwnedGatewayJournal().slice(gatewayOffset).filter(row => upstream.includes(row.target));
    expect(gatewayRows).toHaveLength(15);
    expect(gatewayRows.every(row => row.method === "GET" && row.status === 403 && row.canonicalDenial)).toBe(true);
    const indexes = gatewayRows.map(row => upstream.indexOf(row.target));
    for (const start of [0, 5]) expect(indexes.slice(start, start + 5).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(indexes.slice(10)).toEqual([1, 5, 2, 3, 4]);
    expect(documentRequestId).toBe(gatewayRows[indexes.indexOf(0)].requestId);
    expect(flightRequestId).toBe(gatewayRows[indexes.indexOf(0, 5)].requestId);
    expect(reads.map(read => read.requestId)).toEqual(gatewayRows.slice(10).map(row => row.requestId));
    expect(new Set([documentRequestId, flightRequestId, ...reads.map(read => read.requestId)]).size).toBe(7);
    expect(await readState()).toEqual(before);
    return { documentStatus: document?.status(), flightStatus: evidence.flight.status, documentRequestId, flightRequestId,
      reads, gatewayIndexes: indexes, unchanged: true };
  } finally {
    await close(context);
  }
}

test("production Academy lesson Flight and first progress write", async ({ browser }, info) => {
  test.skip(!production, "Requires the owned Next production build.");
  const value = scenario(info.project.name, "flight");
  const lessonId = value.lessonIds.practice;
  const coursePath = `/academy/courses/${value.courseId}`;
  const lessonPath = `${coursePath}/lessons/${lessonId}`;
  const playbackPath = `/api/academy/lessons/${lessonId}/playback`;
  const progressPath = `/api/academy/lessons/${lessonId}/progress`;
  const context = await contextFor(browser, value.users.learner.storage);
  const page = await context.newPage();
  const lessonDocuments: Request[] = [];
  const prefetches: Request[] = [];
  const flightRequests: Request[] = [];
  const progressWrites: Request[] = [];
  const requestPath = (request: Request) => {
    const url = new URL(request.url());
    return url.origin === owned().origin ? url.pathname : null;
  };
  const isFlight = (request: Request) => requestPath(request) === lessonPath &&
    request.method() === "GET" && request.headers().rsc === "1";
  const isPrefetch = (request: Request) => {
    const headers = request.headers();
    return "next-router-prefetch" in headers || "next-router-segment-prefetch" in headers;
  };
  page.on("request", request => {
    if (requestPath(request) === progressPath && request.method() === "POST") progressWrites.push(request);
    if (requestPath(request) !== lessonPath) return;
    if (request.isNavigationRequest() && request.resourceType() === "document") lessonDocuments.push(request);
    if (isFlight(request)) (isPrefetch(request) ? prefetches : flightRequests).push(request);
  });
  const readProgress = async () => (await coursePool!.query(
    "select revision,resume_position_seconds,max_position_seconds,completed_at from lesson_progress where user_id=$1 and lesson_id=$2",
    [value.users.learner.id, lessonId],
  )).rows;
  try {
    await page.goto(`/courses/${value.slug}`);
    const enrollPath = `/api/academy/courses/${value.courseId}/enrollments`;
    const [enrollment] = await Promise.all([
      page.waitForResponse(response => requestPath(response.request()) === enrollPath && response.request().method() === "POST"),
      page.getByRole("button", { name: "Enroll for free", exact: true }).click(),
    ]);
    expect(enrollment.status()).toBe(200);
    await page.waitForURL(new URL(coursePath, owned().origin).href);
    const link = page.getByRole("link", { name: "Practice lesson Open lesson", exact: true });
    await expect(link).toHaveAttribute("href", lessonPath);
    expect(await readProgress()).toEqual([]);
    expect(progressWrites).toHaveLength(0);
    expect(flightRequests).toHaveLength(0);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const flightPending = page.waitForResponse(response => isFlight(response.request()) && !isPrefetch(response.request()));
    const playbackPending = page.waitForResponse(response => requestPath(response.request()) === playbackPath && response.request().method() === "GET");
    const writePending = page.waitForResponse(response => requestPath(response.request()) === progressPath && response.request().method() === "POST");
    const [flight, playback, write] = await Promise.all([flightPending, playbackPending, writePending, link.click()]);
    expect(flight.status()).toBe(200);
    expect(await flight.headerValue("content-type")).toMatch(/^text\/x-component(?:;|$)/u);
    expect(playback.status()).toBe(200);
    expect(await playback.headerValue("cache-control")).toBe("private, no-store");
    expect(write.status()).toBe(200);
    expect(await write.headerValue("cache-control")).toBe("private, no-store");
    expect(write.request().postDataJSON()).toEqual({ event: "lesson_started", expectedProgressRevision: 0 });
    await expect(page).toHaveURL(new URL(lessonPath, owned().origin).href);
    await expect(page.getByRole("heading", { name: "Practice lesson", exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText("Private actual practice lesson content.", { exact: true })).toBeVisible();
    await expect(page.getByText("Progress saved to your account.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(lessonDocuments).toHaveLength(0);
    expect(flightRequests).toEqual([flight.request()]);
    expect(progressWrites).toEqual([write.request()]);
    expect(await readProgress()).toEqual([{ revision: 1, resume_position_seconds: 0, max_position_seconds: 0, completed_at: null }]);
    await writeFile(info.outputPath("lesson-flight.json"), JSON.stringify({
      activation: { method: "GET", pathname: lessonPath, rsc: true, status: flight.status() },
      lessonPrefetchRequests: prefetches.length,
      lessonDocumentRequests: lessonDocuments.length,
      playback: { status: playback.status(), hlsMetadataReadyAtObservation: await page.evaluate(() => {
        const player = document.querySelector<HTMLElement & { readyState?: number }>("mux-player");
        return (player?.readyState ?? 0) > 0;
      }) },
      progress: { method: "POST", pathname: progressPath, event: "lesson_started", status: write.status(), persistedRevision: 1 },
    }, null, 2) + "\n", { mode: 0o600 });
  } finally {
    await close(context);
  }
  const denial = await verifyProductionLessonDenial(browser, value);
  await writeFile(info.outputPath("lesson-denial.json"), JSON.stringify(denial, null, 2) + "\n", { mode: 0o600 });
});

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
