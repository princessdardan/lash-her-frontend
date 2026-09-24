import path from "node:path";
import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { MuxPlayerRefAttributes } from "@mux/mux-player-react";
import {
  createCourseAccessToken,
  courseCookieName,
} from "../src/lib/courses/access-token";

const courseId = "course-mux-e2e";
const coursePath = `/courses/${courseId}`;
test.skip(
  ({ baseURL }) => baseURL !== "http://127.0.0.1:3108",
  "Use courses-mux.playwright.config.ts",
);

async function unlock(context: BrowserContext) {
  const { token, grant } = createCourseAccessToken(
    courseId,
    "course-mux-test-secret-012345678901234567890123456789",
  );
  await context.addCookies([
    {
      name: courseCookieName(courseId),
      value: token,
      url: "http://127.0.0.1:3108",
      httpOnly: true,
      sameSite: "Lax",
      expires: grant.expiresAt,
    },
  ]);
}

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
  await context.route("https://stream.mux.com/**", async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    if (name.endsWith(".m3u8"))
      await route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync("tests/fixtures/course-mux.m3u8"),
      });
    else if (/^course-mux-\d+\.mpegts$/.test(name))
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
  await context.route(
    "https://course-media.example.invalid/**",
    async (route) => {
      await route.fulfill({
        contentType: route.request().url().endsWith(".vtt")
          ? "text/vtt"
          : "video/mp4",
        headers: { "access-control-allow-origin": "*" },
        body: route.request().url().endsWith(".vtt")
          ? "WEBVTT\n\n00:00.000 --> 00:07.000\nUse a gentle cleanser.\n"
          : readFileSync("tests/fixtures/course-test.mp4"),
      });
    },
  );
});

async function savedPosition(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("lh_course_progress:"),
    );
    return key
      ? JSON.parse(localStorage.getItem(key)!).modules.cleaning.position
      : 0;
  });
}

test("gate hides Mux playback IDs until access is granted", async ({
  request,
  page,
}) => {
  for (const headers of [{} as Record<string, string>, { RSC: "1" }]) {
    const response = await request.get(coursePath, { headers });
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toMatch(
      /courseMuxPublicPlaybackId|PRIVATE_LESSON/,
    );
  }
  await page.goto(coursePath);
  await expect(
    page.getByRole("heading", { name: "Start your free course" }),
  ).toBeVisible();
  await expect(page.locator("mux-player")).toHaveCount(0);
});

test("Mux HLS playback, captions, saved position, and legacy module switching", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  const streams: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("stream.mux.com")) streams.push(request.url());
  });
  await unlock(context);
  await page.goto(coursePath);
  const player = page.locator("mux-player");
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute(
    "playback-id",
    "courseMuxPublicPlaybackId",
  );
  await expect(player).toHaveAttribute("disable-tracking", "");
  await expect
    .poll(() => player.evaluate((el: MuxPlayerRefAttributes) => el.readyState))
    .toBeGreaterThan(0);
  await player.evaluate(async (el: MuxPlayerRefAttributes) => {
    el.muted = true;
    await el.play();
    el.currentTime = 3;
  });
  await expect
    .poll(() => player.evaluate((el: MuxPlayerRefAttributes) => el.currentTime))
    .toBeGreaterThanOrEqual(3);
  await player.evaluate((el: MuxPlayerRefAttributes) => el.pause());
  await expect.poll(() => savedPosition(page)).toBeGreaterThan(2);
  await expect
    .poll(() =>
      player.evaluate((el: MuxPlayerRefAttributes) =>
        Array.from(el.textTracks ?? []).some(
          (track) => track.language === "en" && (track.cues?.length ?? 0) > 0,
        ),
      ),
    )
    .toBe(true);
  expect(streams.some((url) => url.includes(".m3u8"))).toBe(true);
  expect(streams.some((url) => url.includes(".mpegts"))).toBe(true);
  await page.reload();
  await expect
    .poll(() => player.evaluate((el: MuxPlayerRefAttributes) => el.currentTime))
    .toBeGreaterThan(2);
  await page.getByRole("button", { name: /Module 2/ }).click();
  await expect(player).toHaveCount(0);
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await page.getByRole("button", { name: /Module 1/ }).click();
  await expect
    .poll(() => player.evaluate((el: MuxPlayerRefAttributes) => el.currentTime))
    .toBeGreaterThan(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("processing, signed-only and deleted Mux assets show usable lesson pages", async ({
  page,
  context,
}) => {
  await unlock(context);
  await page.goto(coursePath);
  for (let moduleNumber = 3; moduleNumber <= 5; moduleNumber++) {
    await page
      .getByRole("button", { name: new RegExp(`Module ${moduleNumber}`) })
      .click();
    await expect(page.locator("mux-player")).toHaveCount(0);
    await expect(
      page.getByText(
        moduleNumber === 3
          ? "This video is still processing. Please check back shortly."
          : "This video is currently unavailable. Please try again later.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check answers" }),
    ).toBeVisible();
  }
});

test("Mux network failure retries the stream successfully", async ({
  page,
  context,
}) => {
  await unlock(context);
  await page.route("https://stream.mux.com/**", (route) =>
    route.fulfill({
      status: 404,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.goto(coursePath);
  const retry = page.getByRole("button", { name: "Retry video", exact: true });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  await page.unroute("https://stream.mux.com/**");
  await retry.click();
  await expect
    .poll(() =>
      page
        .locator("mux-player")
        .evaluate((el: MuxPlayerRefAttributes) => el.readyState),
    )
    .toBeGreaterThan(0);
  await expect(retry).toHaveCount(0);
});
