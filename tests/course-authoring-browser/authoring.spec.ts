import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
const enabled = process.env.COURSE_AUTHORING_BROWSER_FIXTURE === "1";
test.skip(!enabled, "Run only through the owned authoring browser launcher.");
const storagePath = process.env.COURSE_AUTHORING_STORAGE_PATH;
const externalOrigins = new Set<string>();
async function ownedContext(
  browser: Browser,
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
) {
  const origin = process.env.COURSE_AUTHORING_BROWSER_ORIGIN;
  if (!origin || !/^http:\/\/localhost:\d+$/u.test(origin))
    throw new Error("Owned browser origin required");
  const context = await browser.newContext({ storageState });
  await context.route("**/*", async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) await route.continue();
    else if (
      requested.origin === "https://va.vercel-scripts.com" &&
      [
        "/v1/speed-insights/script.debug.js",
        "/v1/speed-insights/script.js",
      ].includes(requested.pathname)
    )
      await route.fulfill({
        contentType: "application/javascript",
        body: "/* Owned telemetry fixture: no collection. */",
      });
    else {
      externalOrigins.add(requested.origin);
      await route.abort("blockedbyclient");
    }
  });
  return context;
}
test.afterEach(() => {
  try {
    expect(
      [...externalOrigins],
      "Browser must not request external providers",
    ).toEqual([]);
  } finally {
    externalOrigins.clear();
  }
});
test("owner authors, grades publication readiness and publishes with actual Course persistence", async ({
  browser,
}) => {
  if (!storagePath) throw new Error("Owned storage fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const page = await context.newPage();
  try {
    await page.goto("/admin/courses");
    await expect(
      page.getByRole("heading", { name: "Courses", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Course title", { exact: true })
      .fill("Browser authoring fixture");
    await page
      .getByRole("textbox", { name: /^URL name/ })
      .fill("browser-authoring-fixture");
    await page
      .getByLabel("Approved tax classification")
      .fill("fixture-reviewed");
    await page
      .getByRole("button", { name: "Create draft", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/courses\/[a-f0-9-]{36}$/);
    const courseId = page.url().split("/").pop();
    await page
      .getByRole("button", { name: "Review publication readiness" })
      .click();
    await expect(
      page.getByText("Resolve these items before publishing"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add module", exact: true }).click();
    let editor = page.getByRole("region", { name: "Open course editor" });
    await editor.getByLabel("Title", { exact: true }).fill("Foundations");
    await editor
      .getByRole("textbox", { name: /^URL name/ })
      .fill("foundations");
    await editor.getByRole("button", { name: "Save module" }).click();
    await expect(
      page.getByRole("status").getByText("Module saved."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add lesson", exact: true }).click();
    editor = page.getByRole("region", { name: "Open course editor" });
    await editor.getByLabel("Title", { exact: true }).fill("Safe technique");
    await editor
      .getByRole("textbox", { name: /^URL name/ })
      .fill("safe-technique");
    await editor.getByRole("button", { name: "Add content block" }).click();
    await editor
      .getByLabel("Text 1", { exact: true })
      .fill("Practice the reviewed technique safely.");
    await editor
      .getByLabel("Transcript", { exact: true })
      .fill("Practice the reviewed technique safely.");
    await editor.getByRole("button", { name: "Save lesson" }).click();
    await expect(
      page.getByRole("status").getByText("Lesson saved."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Assessment", exact: true }).click();
    await editor
      .getByRole("button", { name: "Add question", exact: true })
      .click();
    await editor
      .getByLabel("Question", { exact: true })
      .fill("Which technique is safe?");
    await editor
      .getByLabel("Question 1 option 1", { exact: true })
      .fill("The reviewed technique");
    await editor
      .getByLabel("Question 1 option 2", { exact: true })
      .fill("Skip the review");
    await editor
      .getByLabel("Feedback after answering", { exact: true })
      .fill("Follow the reviewed technique.");
    await editor
      .getByRole("button", { name: "Save new quiz revision" })
      .click();
    await expect(
      page.getByText(
        "Quiz revision saved. Previous attempts remain in history.",
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Review publication readiness" })
      .click();
    await expect(
      page.getByText("Ready to publish", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Publish course", exact: true })
      .click();
    await expect(
      page.getByText("Course published.", { exact: true }),
    ).toBeVisible();
    const response = await page.request.get(`/api/admin/courses/${courseId}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    const persisted = (await response.json()).course;
    expect(persisted.status).toBe("published");
    expect(
      persisted.modules[0].lessons[0].contentDocument.blocks[0].children[0]
        .text,
    ).toBe("Practice the reviewed technique safely.");
    const quiz = await page.request.get(
      `/api/admin/lessons/${persisted.modules[0].lessons[0].id}/quiz`,
    );
    expect((await quiz.json()).quiz.document.passingPercent).toBe(80);
    await page
      .getByRole("button", { name: "Move to draft", exact: true })
      .click();
    await expect(
      page.getByText("Course moved to draft.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Course details", exact: true })
      .click();
    await page
      .getByLabel("Course title", { exact: true })
      .fill("Unsaved owner edit");
    const current = (
      await (await page.request.get(`/api/admin/courses/${courseId}`)).json()
    ).course;
    const concurrent = await page.request.patch(
      `/api/admin/courses/${courseId}`,
      {
        headers: { origin: new URL(page.url()).origin, "x-lash-csrf": "1" },
        data: {
          expectedRevision: current.revision,
          title: "Other editor commit",
        },
      },
    );
    expect(concurrent.status()).toBe(200);
    await page
      .getByRole("button", { name: "Save course details", exact: true })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "changed",
    );
    await expect(page.getByLabel("Course title", { exact: true })).toHaveValue(
      "Unsaved owner edit",
    );
    const missingCsrf = await page.request.post("/api/admin/courses", {
      data: { title: "Forbidden" },
    });
    expect(missingCsrf.status()).toBe(403);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("mobile-authoring.png"),
      fullPage: true,
    });
  } finally {
    await context.close().catch(() => {});
  }
});
test("customer-facing authoring routes isolate unauthenticated and non-editor staff", async ({
  browser,
  request,
}) => {
  expect((await request.get("/api/admin/courses")).status()).toBe(401);
  if (!storagePath) throw new Error("Owned storage fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.admin);
  try {
    const response = await context.request.get("/api/admin/courses");
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    const page = await context.newPage();
    await page.goto("/admin/courses");
    await expect(page).toHaveURL(/\/admin\/not-authorized$/);
  } finally {
    await context.close().catch(() => {});
  }
});

test("keyboard ordering, archival identity and dirty-editor cancellation remain consistent", async ({
  browser,
  baseURL,
}) => {
  if (!storagePath || !baseURL)
    throw new Error("Owned browser fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const page = await context.newPage();
  const headers = { origin: baseURL, "x-lash-csrf": "1" };
  async function post(path: string, data: object) {
    const response = await context.request.post(path, { headers, data });
    expect(response.status()).toBe(200);
    return response.json();
  }
  try {
    const created = await post("/api/admin/courses", {
      title: "Ordering fixture",
      slug: "ordering-fixture",
      status: "draft",
      taxClassification: "fixture-reviewed",
    });
    const courseId = created.course.id;
    const first = (
      await post(`/api/admin/courses/${courseId}/modules`, {
        expectedCourseRevision: 1,
        title: "First module",
        slug: "first",
        position: 1,
      })
    ).module;
    const second = (
      await post(`/api/admin/courses/${courseId}/modules`, {
        expectedCourseRevision: 2,
        title: "Second module",
        slug: "second",
        position: 2,
      })
    ).module;
    for (const [index, title] of ["Lesson A", "Lesson B"].entries())
      await post(`/api/admin/modules/${first.id}/lessons`, {
        expectedCourseRevision: 3 + index,
        title,
        slug: `lesson-${index}`,
        position: index + 1,
        contentDocument: {
          version: 1,
          blocks: [
            {
              _type: "block",
              _key: "fixture-block",
              children: [
                {
                  _type: "span",
                  _key: "fixture-text",
                  text: "Reviewed lesson text",
                },
              ],
            },
          ],
        },
      });
    await page.goto(`/admin/courses/${courseId}`);
    const moveModule = page.getByRole("button", {
      name: "Move module Second module up",
      exact: true,
    });
    await moveModule.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Curriculum order saved.", { exact: true }),
    ).toBeVisible();
    const modules = (
      await (await context.request.get(`/api/admin/courses/${courseId}`)).json()
    ).course.modules;
    expect(modules.map((module: { id: string }) => module.id)).toEqual([
      second.id,
      first.id,
    ]);
    const moveLesson = page.getByRole("button", {
      name: "Move lesson Lesson B up",
      exact: true,
    });
    await moveLesson.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(async () =>
        (
          await (
            await context.request.get(`/api/admin/courses/${courseId}`)
          ).json()
        ).course.modules
          .find((module: { id: string }) => module.id === first.id)
          .lessons.map((lesson: { title: string }) => lesson.title),
      )
      .toEqual(["Lesson B", "Lesson A"]);
    const lessonRow = page
      .getByRole("heading", { name: "Lesson A", exact: true })
      .locator("..");
    await lessonRow
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    await expect(
      page.getByText("Lesson archived.", { exact: true }),
    ).toBeVisible();
    const archivedRow = page
      .getByRole("heading", { name: "Lesson A (archived)", exact: true })
      .locator("..");
    await archivedRow
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(
      page.getByText("Lesson restored.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("heading", { name: "Lesson A", exact: true })
      .locator("..")
      .getByRole("button", { name: "Edit lesson", exact: true })
      .click();
    const editor = page.getByRole("region", { name: "Open course editor" });
    await editor
      .getByLabel("Title", { exact: true })
      .fill("Unsaved lesson title");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "Course details", exact: true })
      .click();
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
      "Unsaved lesson title",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Course details", exact: true })
      .click();
    await expect(
      editor.getByLabel("Course title", { exact: true }),
    ).toHaveValue("Ordering fixture");
    const after = (
      await (await context.request.get(`/api/admin/courses/${courseId}`)).json()
    ).course.modules.find((module: { id: string }) => module.id === first.id);
    expect(
      after.lessons.map((lesson: { id: string }) => lesson.id).sort(),
    ).toEqual(
      modules
        .find((module: { id: string }) => module.id === first.id)
        .lessons.map((lesson: { id: string }) => lesson.id)
        .sort(),
    );
    await page
      .getByRole("heading", { name: "Lesson A", exact: true })
      .locator("..")
      .getByRole("button", { name: "Video and captions", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText(
      "Video status could not be loaded",
    );
    await expect(
      editor.getByText("Waiting for video status.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByRole("button", { name: "Upload video", exact: true }),
    ).toBeDisabled();
  } finally {
    await context.close().catch(() => {});
  }
});

test("paid CAD catalog publication warns before archive and requires validated restoration", async ({
  browser,
  baseURL,
}) => {
  if (!storagePath || !baseURL)
    throw new Error("Owned browser fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const page = await context.newPage();
  const headers = { origin: baseURL, "x-lash-csrf": "1" };
  try {
    await page.goto("/admin/courses");
    await page
      .getByLabel("Course title", { exact: true })
      .fill("Paid browser catalog fixture");
    await page
      .getByRole("textbox", { name: /^URL name/ })
      .fill("paid-browser-catalog-fixture");
    await page
      .getByRole("combobox", { name: "Access", exact: true })
      .selectOption("paid");
    await page.getByLabel("Price (CAD)", { exact: false }).fill("10.00");
    await page
      .getByLabel("Approved tax classification")
      .fill("fixture-reviewed");
    await page
      .getByRole("button", { name: "Create draft", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/courses\/[a-f0-9-]{36}$/);
    const courseId = page.url().split("/").pop();
    async function course() {
      return (
        await (
          await context.request.get(`/api/admin/courses/${courseId}`)
        ).json()
      ).course;
    }
    const draft = await course();
    expect(draft).toMatchObject({
      status: "draft",
      accessMode: "paid",
      currency: "CAD",
      priceCents: 1000,
    });
    const createdModule = await context.request.post(
      `/api/admin/courses/${courseId}/modules`,
      {
        headers,
        data: {
          expectedCourseRevision: 1,
          title: "Paid module",
          slug: "paid-module",
          position: 1,
        },
      },
    );
    expect(createdModule.status()).toBe(200);
    const moduleId = (await createdModule.json()).module.id;
    const contentDocument = {
      version: 1,
      blocks: [
        {
          _type: "block",
          _key: "paid-block",
          children: [
            {
              _type: "span",
              _key: "paid-text",
              text: "PRIVATE_PAID_LESSON_FIXTURE",
            },
          ],
        },
      ],
    };
    const createdLesson = await context.request.post(
      `/api/admin/modules/${moduleId}/lessons`,
      {
        headers,
        data: {
          expectedCourseRevision: 2,
          title: "Paid lesson",
          slug: "paid-lesson",
          position: 1,
          contentDocument,
        },
      },
    );
    expect(createdLesson.status()).toBe(200);
    const lessonId = (await createdLesson.json()).lesson.id;
    await page.reload();
    const mutations: Record<string, unknown>[] = [];
    const mutationPaths: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
        mutationPaths.push(new URL(request.url()).pathname);
      if (
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === `/api/admin/courses/${courseId}`
      )
        mutations.push(request.postDataJSON());
    });
    await page
      .getByRole("button", { name: "Review publication readiness" })
      .click();
    await expect(
      page.getByText("Ready to publish", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Publish course", exact: true })
      .click();
    await expect(
      page.getByText("Course published.", { exact: true }),
    ).toBeVisible();
    const catalog = await context.request.get(
      "/api/academy/catalog/paid-browser-catalog-fixture",
    );
    expect(catalog.status()).toBe(200);
    expect((await catalog.json()).course).toMatchObject({
      id: courseId,
      accessMode: "paid",
      currency: "CAD",
      priceCents: 1000,
    });
    expect(await catalog.text()).not.toContain("PRIVATE_PAID_LESSON_FIXTURE");
    const publicPage = await context.newPage();
    await publicPage.goto("/courses/paid-browser-catalog-fixture");
    await expect(
      publicPage.getByRole("heading", {
        name: "Paid browser catalog fixture",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      publicPage.getByRole("button", { name: /buy|pay|checkout/i }),
    ).toHaveCount(0);
    expect(await publicPage.content()).not.toContain(
      "PRIVATE_PAID_LESSON_FIXTURE",
    );
    await page
      .getByRole("button", { name: "Archive course", exact: true })
      .click();
    const warning = page.getByRole("region", {
      name: "Before archiving this paid course",
    });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      "including access from existing purchases",
    );
    await expect(warning).toContainText("600 seconds");
    await expect(warning).toContainText("independent grants, progress");
    await expect(warning).toContainText(
      "Community access depends on remaining eligible courses and grants",
    );
    await expect(warning).toContainText(
      "does not issue a refund or cancel a payment",
    );
    await expect(warning).toContainText(
      "existing applicable terms and owner review",
    );
    await expect(warning).toContainText(
      "cannot override revoked or expired grants, suspension or account deletion",
    );
    expect(mutations).toHaveLength(1);
    await warning
      .getByRole("button", { name: "Cancel archive", exact: true })
      .click();
    await expect(warning).toHaveCount(0);
    expect((await course()).status).toBe("published");
    expect(mutations).toHaveLength(1);
    await page
      .getByRole("button", { name: "Archive course", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: test.info().outputPath("paid-archive-warning.png"),
      fullPage: true,
    });
    await warning
      .getByRole("button", { name: "Archive paid course", exact: true })
      .click();
    await expect(
      page.getByText(
        "Course archived. Historical references remain available.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(mutations).toEqual([
      { expectedRevision: 3, status: "published" },
      { expectedRevision: 4, status: "archived" },
    ]);
    expect(mutationPaths).toEqual([
      `/api/admin/courses/${courseId}`,
      `/api/admin/courses/${courseId}`,
    ]);
    const archived = await course();
    expect(archived.modules[0].id).toBe(moduleId);
    expect(archived.modules[0].lessons[0].id).toBe(lessonId);
    expect(
      (
        await context.request.get(
          "/api/academy/catalog/paid-browser-catalog-fixture",
        )
      ).status(),
    ).toBe(404);
    await page
      .getByRole("button", { name: "Move to draft", exact: true })
      .click();
    await expect(
      page.getByText("Course moved to draft.", { exact: true }),
    ).toBeVisible();
    const removed = await context.request.patch(
      `/api/admin/lessons/${lessonId}`,
      { headers, data: { expectedCourseRevision: 6, contentDocument: null } },
    );
    expect(removed.status()).toBe(200);
    await page.reload();
    await page
      .getByRole("button", { name: "Review publication readiness" })
      .click();
    await expect(
      page.getByText("Resolve these items before publishing"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publish course", exact: true }),
    ).toHaveCount(0);
    const repaired = await context.request.patch(
      `/api/admin/lessons/${lessonId}`,
      { headers, data: { expectedCourseRevision: 7, contentDocument } },
    );
    expect(repaired.status()).toBe(200);
    await page.reload();
    await page
      .getByRole("button", { name: "Review publication readiness" })
      .click();
    await expect(
      page.getByText("Ready to publish", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Publish course", exact: true })
      .click();
    await expect(
      page.getByText("Course published.", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await context.request.get(
          "/api/academy/catalog/paid-browser-catalog-fixture",
        )
      ).status(),
    ).toBe(200);
    expect((await course()).modules[0].lessons[0].id).toBe(lessonId);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close().catch(() => {});
  }
});
