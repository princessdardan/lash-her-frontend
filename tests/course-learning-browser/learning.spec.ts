import { createHmac, randomUUID, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  test,
  expect,
  devices,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
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
if (production && fixture) {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(fixture.browserCertificateSpki ?? ""))
    throw new Error("Owned loopback browser certificate required");
  test.use({ launchOptions: { args: [
    `--ignore-certificate-errors-spki-list=${fixture.browserCertificateSpki}`,
    "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND",
  ] } });
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
const readOwnedGatewayJournal = () => readFileSync(owned().gatewayJournal, "utf8").trim().split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as { method: string; target: string; status: number });
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
        documentBody: window.document.documentElement.textContent ?? "",
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
    for (const body of [evidence.documentBody, evidence.flight.body]) {
      for (const privateText of ["Private actual practice lesson content.", "A gentle approach protects the natural lash.",
        "Which approach protects the natural lash?", before.media[0].mux_playback_id])
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
    expect(gatewayRows.every(row => row.method === "GET" && row.status === 403)).toBe(true);
    const indexes = gatewayRows.map(row => upstream.indexOf(row.target));
    for (const start of [0, 5]) expect(indexes.slice(start, start + 5).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(indexes.slice(10)).toEqual([1, 5, 2, 3, 4]);
    expect(await readState()).toEqual(before);
    return { documentStatus: document?.status(), flightStatus: evidence.flight.status, reads, gatewayIndexes: indexes, unchanged: true };
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
