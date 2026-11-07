import { readFile } from "node:fs/promises";
import pg from "pg";
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
test("owner manual access uses real auth/Course SQL audit and explicit lost-ack reconciliation", async ({ browser, baseURL }) => {
  if (!storagePath || !baseURL) throw new Error("Owned browser setup required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const page = await context.newPage();
  const database = new URL(process.env.COURSE_AUTHORING_GRANT_DATABASE_URL ?? "");
  if (database.hostname !== "127.0.0.1" || database.pathname !== "/lash_authoring_course_integration") throw new Error("Owned Course DB required");
  const sql = new pg.Client({ connectionString: database.href });
  await sql.connect();
  const headers = { origin: baseURL, "x-lash-csrf": "1" };
  try {
    const create = await context.request.post("/api/admin/courses", { headers, data: { title: "Manual support course", slug: "manual-support-course", currency: "CAD", accessMode: "paid", priceCents: 1000, taxClassification: "fixture-reviewed" } });
    expect(create.status()).toBe(200);
    const id = (await create.json()).course.id;
    const createdSupportModule = await context.request.post(`/api/admin/courses/${id}/modules`, { headers, data: { expectedCourseRevision: 1, title: "Support module", slug: "support-module", position: 1 } });
    const moduleId = (await createdSupportModule.json()).module.id;
    const lesson = await context.request.post(`/api/admin/modules/${moduleId}/lessons`, { headers, data: { expectedCourseRevision: 2, title: "Text lesson", slug: "text-lesson", position: 1,
      contentDocument: { version: 1, blocks: [{ _type: "block", _key: "b", children: [{ _type: "span", _key: "s", text: "Owned manual grant content" }] }] } } });
    expect(lesson.status()).toBe(200);
    expect((await context.request.patch(`/api/admin/courses/${id}`, { headers, data: { expectedRevision: 3, status: "published" } })).status()).toBe(200);
    await page.goto(`/admin/courses/${id}/manual-grants`);
    await expect(page.getByRole("heading", { name: "Manual access: Manual support course" })).toBeVisible();
    await page.getByLabel("Customer UUID").fill(states.manualGrantCustomerIds[0]);
    await page.getByLabel("Grant reason").fill("Owned normal owner support");
    const pendingGrant = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/admin/courses/${id}/manual-grants`);
    await page.getByRole("button", { name: "Grant manual access", exact: true }).click();
    const grantResponse = await pendingGrant;
    expect(grantResponse.status()).toBe(200);
    expect(await grantResponse.headerValue("cache-control")).toBe("private, no-store");
    expect(await grantResponse.headerValue("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
    const form = grantResponse.request().postDataJSON();
    expect(form).toMatchObject({ userId: states.manualGrantCustomerIds[0], reason: "Owned normal owner support", expectedCourseRevision: 4 });
    expect(form.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/u);
    const confirmed = await grantResponse.json();
    expect(confirmed).toMatchObject({ state: "confirmed", idempotencyKey: form.idempotencyKey, courseRevision: 4,
      mutationRetried: false, communityDeliveryVerified: false,
      grant: { courseId: id, status: "active", grantReason: "manual", orderId: null, externalPaymentId: null, provider: null } });
    await expect(page.getByRole("region", { name: "Manual course access" }).getByRole("status")).toContainText("Manual grant and audit confirmed");
    await expect(page.getByRole("button", { name: "Grant manual access", exact: true })).toBeDisabled();
    const rows = (await sql.query("select g.id,g.external_order_id,g.external_payment_id,g.provider,g.grant_reason,c.id command_id,c.effect_count,e.effect_type from entitlement_grants g join admin_entitlement_commands c on c.idempotency_key=g.idempotency_key join admin_entitlement_command_effects e on e.command_id=c.id where g.user_id=$1 and g.course_id=$2", [states.manualGrantCustomerIds[0], id])).rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ external_order_id: null, external_payment_id: null, provider: null, grant_reason: "manual", effect_count: 1, effect_type: "grant_created" });
    expect(confirmed.command.commandId).toBe(rows[0].command_id);
    expect(confirmed.grant.grantId).toBe(rows[0].id);
    const events = (await sql.query("select o.canonical_body,o.state,o.attempts_in_cycle from community_enrollment_outbox o join community_enrollment_streams s on s.id=o.stream_id where s.user_id=$1 and s.course_id=$2", [states.manualGrantCustomerIds[0], id])).rows;
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ state: "pending", attempts_in_cycle: 0 });
    expect(JSON.parse(events[0].canonical_body)).toMatchObject({ eventType: "enrollment.activated", data: { userId: states.manualGrantCustomerIds[0], courseId: id, state: "active" } });
    await page.reload(); await page.getByRole("button", { name: "Check recorded outcome" }).click();
    await expect(page.getByRole("region", { name: "Manual course access" }).getByRole("status")).toContainText("Manual grant and audit confirmed");
    expect((await sql.query("select id from entitlement_grants where user_id=$1 and course_id=$2", [states.manualGrantCustomerIds[0], id])).rows).toHaveLength(1);
    await page.getByRole("button", { name: "Prepare another grant" }).click();
    await page.getByLabel("Customer UUID").fill(states.manualGrantCustomerIds[1]); await page.getByLabel("Grant reason").fill("Owned response loss");
    let posts = 0;
    await page.route(`**/api/admin/courses/${id}/manual-grants`, async route => {
      if (route.request().method() === "POST") { posts++; await route.fetch(); await route.abort("failed"); } else await route.continue();
    });
    await page.locator("section[aria-label=\"Manual course access\"] form").evaluate(form => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await expect(page.getByRole("region", { name: "Manual course access" }).getByRole("status")).toContainText(/fetch|unknown|outcome/i);
    await page.getByRole("button", { name: "Check recorded outcome" }).click(); await expect(page.getByRole("region", { name: "Manual course access" }).getByRole("status")).toContainText("Manual grant and audit confirmed");
    expect(posts).toBe(1); expect((await sql.query("select id from entitlement_grants where user_id=$1 and course_id=$2", [states.manualGrantCustomerIds[1], id])).rows).toHaveLength(1);
    // Model only the safe unknown envelope here. Schema-valid mismatched Course
    // receipts are independently exercised through the actual named client.
    await page.unroute(`**/api/admin/courses/${id}/manual-grants`);
    await page.getByRole("button", { name: "Prepare another grant" }).click();
    await page.getByLabel("Customer UUID").fill(states.manualGrantCustomerIds[0]); await page.getByLabel("Grant reason").fill("Owned unknown outcome presentation");
    let unknownPosts = 0;
    await page.route(`**/api/admin/courses/${id}/manual-grants`, async route => {
      unknownPosts++;
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ state: "outcome-unknown",
        idempotencyKey: route.request().postDataJSON().idempotencyKey, command: null, mutationRetried: false, communityDeliveryVerified: false }) });
    });
    await page.getByRole("button", { name: "Grant manual access", exact: true }).click();
    await expect(page.getByRole("region", { name: "Manual course access" }).getByRole("status")).toHaveText("The grant outcome is unknown. Check the recorded outcome; no grant was retried.");
    await expect(page.getByText("Command receipt", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Grant manual access", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Prepare another grant" })).toHaveCount(0); expect(unknownPosts).toBe(1);
    const staff = await ownedContext(browser, states.admin);
    try {
      const denied = await staff.request.post(`/api/admin/courses/${id}/manual-grants`, { headers, data: { userId: states.manualGrantCustomerIds[1], expectedCourseRevision: 4, reason: "Unauthorized", idempotencyKey: crypto.randomUUID() } });
      expect(denied.status()).toBe(403);
    } finally { await staff.close(); }
    expect((await context.request.post(`/api/admin/courses/${id}/manual-grants`, { headers: { origin: baseURL }, data: {} })).status()).toBe(403);
    const anonymous = await ownedContext(browser, { cookies: [], origins: [] });
    try {
      expect((await anonymous.request.post(`/api/admin/courses/${id}/manual-grants`, { headers, data: { userId: states.manualGrantCustomerIds[0], reason: "Unauthorized customer", expectedCourseRevision: 4, idempotencyKey: crypto.randomUUID() } })).status()).toBe(401);
      expect((await anonymous.request.get(`/api/admin/courses/${id}/manual-grants?idempotencyKey=${crypto.randomUUID()}`)).status()).toBe(401); }
    finally { await anonymous.close(); }
  } finally { await sql.end(); await context.close(); }
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
    const detail = `/api/admin/courses/${courseId}`;
    const review = async () => {
      const pending = page.waitForResponse(response => response.request().method() === "GET" &&
        new URL(response.url()).pathname === detail + "/publication-readiness");
      await page.getByRole("button", { name: "Review publication readiness" }).click();
      const response = await pending;
      expect(response.status()).toBe(200);
      expect(await response.headerValue("cache-control")).toBe("private, no-store");
      expect(await response.headerValue("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
      return response.json();
    };
    const publish = async (revision: number) => {
      const pending = page.waitForResponse(response => response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === detail);
      await page.getByRole("button", { name: "Publish course", exact: true }).click();
      const response = await pending;
      expect(response.request().postData()).toBe(JSON.stringify({ expectedRevision: revision, status: "published" }));
      return response;
    };
    expect(await review()).toMatchObject({ courseId, courseRevision: 1, ready: false, issues: [{ code: "MODULE_REQUIRED" }] });
    await expect(
      page.getByText("Resolve these items before publishing"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish course", exact: true })).toHaveCount(0);
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
    const { course: beforeQuiz } = await (await page.request.get(detail)).json();
    const lessonId = beforeQuiz.modules[0].lessons[0].id;
    const quizPath = `/api/admin/lessons/${lessonId}/quiz`;
    const openAssessment = async (priorStatus: 200 | 404) => {
      const pending = page.waitForResponse(response => response.request().method() === "GET" &&
        new URL(response.url()).pathname === quizPath);
      await page.getByRole("button", { name: "Assessment", exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(priorStatus);
      expect(await response.headerValue("cache-control")).toBe("private, no-store");
      return response;
    };
    const saveAssessment = async (expectedCourseRevision: number, document: object) => {
      const pending = page.waitForResponse(response => response.request().method() === "PUT" &&
        new URL(response.url()).pathname === quizPath);
      await editor.getByRole("button", { name: "Save new quiz revision" }).click();
      const response = await pending;
      expect(response.status()).toBe(200);
      expect(response.request().postData()).toBe(JSON.stringify({ expectedCourseRevision, document }));
      await expect(page.getByRole("status").getByText("Quiz revision saved. Previous attempts remain in history.")).toBeVisible();
      return (await response.json()).quiz;
    };
    await openAssessment(404);
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
    const firstOption = `option-${beforeQuiz.revision}-1`;
    const firstDocument = { version: 1, mode: "graded", passingPercent: 80, questions: [
      { id: `question-${beforeQuiz.revision}-1`, prompt: "Which technique is safe?",
        options: [{ id: firstOption, text: "The reviewed technique" }, { id: `option-${beforeQuiz.revision}-2`, text: "Skip the review" }],
        correctOptionId: firstOption, feedback: "Follow the reviewed technique." },
    ] };
    const originalQuiz = await saveAssessment(beforeQuiz.revision, firstDocument);
    expect(originalQuiz).toMatchObject({ lessonId, revision: 1, courseRevision: beforeQuiz.revision + 1, document: firstDocument });
    await expect(editor.getByText(/^Revision 1\./u)).toBeVisible();

    await page.getByRole("button", { name: "Course details", exact: true }).click();
    const prior = await openAssessment(200);
    expect((await prior.json()).quiz).toMatchObject({ id: originalQuiz.id, revision: 1, document: firstDocument });
    await editor.getByRole("combobox", { name: /^Assessment mode/u }).selectOption("practice", { timeout: 5_000 });
    await editor.getByRole("button", { name: "Add option", exact: true }).click();
    await editor.getByLabel("Question 1 option 3", { exact: true }).fill("Check the guide first");
    const revisedQuestion = firstDocument.questions[0];
    const revisedDocument = { ...firstDocument, mode: "practice", questions: [
      { ...revisedQuestion, options: [...revisedQuestion.options, { id: `option-${beforeQuiz.revision + 1}-1`, text: "Check the guide first" }] },
    ] };
    const revisedQuiz = await saveAssessment(beforeQuiz.revision + 1, revisedDocument);
    expect(revisedQuiz).toMatchObject({ lessonId, revision: 2, courseRevision: beforeQuiz.revision + 2, document: revisedDocument });
    expect(revisedQuiz.id).not.toBe(originalQuiz.id);
    await expect(editor.getByText(/^Revision 2\./u)).toBeVisible();
    const { course: draft } = await (await page.request.get(detail)).json();
    expect(await review()).toEqual({ courseId, courseRevision: draft.revision, ready: true, issues: [] });
    await expect(
      page.getByText("Ready to publish", { exact: true }),
    ).toBeVisible();

    const database = new URL(process.env.COURSE_AUTHORING_GRANT_DATABASE_URL ?? "");
    if (database.hostname !== "127.0.0.1" || database.pathname !== "/lash_authoring_course_integration")
      throw new Error("Owned Course DB required for publication failure injection");
    const sql = new pg.Client({ connectionString: database.href });
    const lesson = draft.modules[0].lessons[0];
    await sql.connect();
    try {
      // Preserve the root revision to exercise publication revalidation after a ready snapshot.
      const injected = await sql.query("UPDATE lessons SET content_document=$2::jsonb WHERE id=$1", [
        lesson.id, JSON.stringify({ version: 1, blocks: [{ _type: "invalid" }] }),
      ]);
      expect(injected.rowCount).toBe(1);
      const refused = await publish(draft.revision);
      expect(refused.status()).toBe(409);
      const requestId = await refused.headerValue("x-request-id");
      const conflict = `This course changed or is not ready for this operation. Reload before trying again. Reference: ${requestId}`;
      await expect(page.getByRole("alert").getByText(conflict, { exact: true })).toBeVisible();
      expect((await sql.query("SELECT revision, status FROM courses WHERE id=$1", [courseId])).rows)
        .toEqual([{ revision: draft.revision, status: "draft" }]);
      expect(await review()).toMatchObject({ courseRevision: draft.revision, ready: false,
        issues: [{ code: "INVALID_CONTENT", lessonId: lesson.id }] });
      await expect(page.getByRole("button", { name: "Publish course", exact: true })).toHaveCount(0);
    } finally {
      try {
        await sql.query("UPDATE lessons SET content_document=$2::jsonb WHERE id=$1", [lesson.id, JSON.stringify(lesson.contentDocument)]);
      } finally {
        await sql.end();
      }
    }
    expect(await review()).toEqual({ courseId, courseRevision: draft.revision, ready: true, issues: [] });
    const published = await publish(draft.revision);
    expect(published.status()).toBe(200);
    expect((await published.json()).course).toMatchObject({ id: courseId, revision: draft.revision + 1, status: "published" });
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
test("two owner tabs preserve the stale form after the winning draft edit", async ({ browser }) => {
  if (!storagePath) throw new Error("Owned storage fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const database = new URL(process.env.COURSE_AUTHORING_GRANT_DATABASE_URL ?? "");
  if (database.hostname !== "127.0.0.1" || database.pathname !== "/lash_authoring_course_integration") throw new Error("Owned Course DB required");
  const db = new pg.Client({ connectionString: database.href });
  try {
    const winner = await context.newPage();
    await winner.goto("/admin/courses");
    await winner.getByLabel("Course title", { exact: true }).fill("Owned two-tab draft");
    await winner.getByRole("textbox", { name: /^URL name/ }).fill("owned-two-tab-draft");
    await winner.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(winner).toHaveURL(/\/admin\/courses\/[a-f0-9-]{36}$/u);
    const courseId = new URL(winner.url()).pathname.split("/").pop();
    const stale = await context.newPage();
    await stale.goto(winner.url());
    const winningTitle = winner.getByLabel("Course title", { exact: true });
    const staleTitle = stale.getByLabel("Course title", { exact: true });
    await expect(winningTitle).toHaveValue("Owned two-tab draft");
    await expect(staleTitle).toHaveValue("Owned two-tab draft");
    await winningTitle.fill("Owned winning title");
    await staleTitle.fill("Owned stale title");

    const editPath = `/api/admin/courses/${courseId}`;
    const save = async (tab: typeof winner) => {
      const pending = tab.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === editPath);
      await tab.getByRole("button", { name: "Save course details", exact: true }).click();
      return pending;
    };
    const saved = await save(winner);
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON().expectedRevision).toBe(1);
    await expect(winner.getByRole("status").getByText("Course details saved.")).toBeVisible();
    const rejected = await save(stale);
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON().expectedRevision).toBe(1);
    const requestId = await rejected.headerValue("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
    const conflictMessage = `This course changed or is not ready for this operation. Reload before trying again. Reference: ${requestId}`;
    await expect(stale.getByRole("alert").getByText(conflictMessage, { exact: true })).toBeVisible();
    await expect(staleTitle).toHaveValue("Owned stale title");

    await db.connect();
    const { rows } = await db.query("SELECT title, revision, status FROM courses WHERE id=$1", [courseId]);
    expect(rows).toEqual([{ title: "Owned winning title", revision: 2, status: "draft" }]);
  } finally {
    await db.end().catch(() => {});
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

test("owner curriculum forms create a scaffold and populated Portable Text with exact request bytes", async ({ browser }) => {
  if (!storagePath) throw new Error("Owned storage fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const page = await context.newPage();
  try {
    await page.goto("/admin/courses");
    await page.getByLabel("Course title", { exact: true }).fill("Curriculum creation fixture");
    await page.getByRole("textbox", { name: /^URL name/ }).fill("curriculum-create-fixture");
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/courses\/[a-f0-9-]{36}$/u);
    const courseId = new URL(page.url()).pathname.split("/").pop();
    const editor = page.getByRole("region", { name: "Open course editor" });
    const save = async (kind: "module" | "lesson", pathname: string, body: object) => {
      const pending = page.waitForResponse(response => response.request().method() === "POST" &&
        new URL(response.url()).pathname === pathname);
      await editor.getByRole("button", { name: `Save ${kind}`, exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(200);
      expect(response.request().postData()).toBe(JSON.stringify(body));
      expect(await response.headerValue("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
      expect(await response.headerValue("cache-control")).toBe("private, no-store");
      const notice = kind === "module" ? "Module saved." : "Lesson saved.";
      await expect(page.getByRole("status").getByText(notice, { exact: true })).toBeVisible();
      return response.json();
    };
    await page.getByRole("button", { name: "Add module", exact: true }).click();
    const moduleInput = {
      expectedCourseRevision: 1, title: "Reviewed module", slug: "reviewed-module",
      description: "Owned module description.", position: 1,
    };
    await editor.getByLabel("Title", { exact: true }).fill(moduleInput.title);
    await editor.getByRole("textbox", { name: /^URL name/ }).fill(moduleInput.slug);
    await editor.getByLabel("Description", { exact: true }).fill(moduleInput.description);
    const { module: savedModule } = await save("module", `/api/admin/courses/${courseId}/modules`, moduleInput);
    expect(savedModule).toMatchObject({ courseId, slug: moduleInput.slug, courseRevision: 2, position: 1, lessons: [] });

    await page.getByRole("button", { name: "Add lesson", exact: true }).click();
    const lessonInput = {
      expectedCourseRevision: 2, title: "Reviewed lesson", slug: "reviewed-lesson", position: 1,
      contentDocument: { version: 1, blocks: [] }, transcript: "Owned initial transcript.", isPreview: true, captions: [],
    };
    await editor.getByLabel("Title", { exact: true }).fill(lessonInput.title);
    await editor.getByRole("textbox", { name: /^URL name/ }).fill(lessonInput.slug);
    await editor.getByLabel("Transcript", { exact: true }).fill(lessonInput.transcript);
    await editor.getByRole("checkbox", { name: "Public preview text (assessments still require enrollment)" }).check();
    const { lesson } = await save("lesson", `/api/admin/modules/${savedModule.id}/lessons`, lessonInput);
    expect(lesson).toMatchObject({ moduleId: savedModule.id, slug: lessonInput.slug, courseRevision: 3,
      transcript: lessonInput.transcript, isPreview: true, contentDocument: lessonInput.contentDocument, captions: [] });
    const response = await page.request.get(`/api/admin/courses/${courseId}`);
    expect(response.status()).toBe(200);
    const { course } = await response.json();
    expect(course).toMatchObject({ revision: 3, status: "draft", modules: [
      { id: savedModule.id, description: moduleInput.description, lessons: [{ id: lesson.id, transcript: lessonInput.transcript }] },
    ] });

    await page.getByRole("button", { name: "Add lesson", exact: true }).click();
    await editor.getByLabel("Title", { exact: true }).fill("Rich text lesson");
    await editor.getByRole("textbox", { name: /^URL name/ }).fill("reviewed-rich-text");
    await editor.getByLabel("Position", { exact: true }).fill("2");
    await editor.getByLabel("Transcript", { exact: true }).fill("Reviewed transcript for rich text.");
    await editor.getByRole("checkbox", { name: "Public preview text (assessments still require enrollment)" }).uncheck();
    const addBlock = editor.getByRole("button", { name: "Add content block", exact: true });
    await addBlock.click();
    const first = editor.getByRole("group", { name: "Content block 1", exact: true });
    await first.getByRole("combobox").selectOption("h2", { timeout: 5_000 });
    await first.getByLabel("Text 1", { exact: true }).fill("Reviewed first section");
    await first.getByRole("checkbox", { name: "Bold", exact: true }).check();
    await first.getByRole("button", { name: "Add text section", exact: true }).click();
    await first.getByLabel("Text 2", { exact: true }).fill("Reviewed second section");
    await first.getByRole("button", { name: "Link first text section", exact: true }).click();
    await first.getByLabel("Link address", { exact: true }).fill("/courses");
    await addBlock.click();
    const second = editor.getByRole("group", { name: "Content block 2", exact: true });
    await second.getByLabel("Text 1", { exact: true }).fill("Another reviewed block");
    await second.getByRole("button", { name: "Move content block 2 up", exact: true }).click();
    const richInput = {
      expectedCourseRevision: 3, title: "Rich text lesson", slug: "reviewed-rich-text", position: 2,
      contentDocument: { version: 1, blocks: [
        { _type: "block", _key: "block-3-2", style: "normal", children: [
          { _type: "span", _key: "span-3-1", text: "Another reviewed block", marks: [] },
        ], markDefs: [] },
        { _type: "block", _key: "block-3-1", style: "h2", children: [
          { _type: "span", _key: "span-3-1", text: "Reviewed first section", marks: ["strong", "link-3-1"] },
          { _type: "span", _key: "span-3-2", text: "Reviewed second section", marks: [] },
        ], markDefs: [{ _type: "link", _key: "link-3-1", href: "/courses" }] },
      ] },
      transcript: "Reviewed transcript for rich text.", isPreview: false, captions: [],
    };
    const { lesson: richLesson } = await save("lesson", `/api/admin/modules/${savedModule.id}/lessons`, richInput);
    expect(richLesson).toMatchObject({ moduleId: savedModule.id, courseRevision: 4, slug: richInput.slug,
      contentDocument: richInput.contentDocument, transcript: richInput.transcript, isPreview: false });
    const { course: reloaded } = await (await page.request.get(`/api/admin/courses/${courseId}`)).json();
    expect(reloaded).toMatchObject({ revision: 4, modules: [{ id: savedModule.id, lessons: [
      { id: lesson.id, contentDocument: lessonInput.contentDocument },
      { id: richLesson.id, contentDocument: richInput.contentDocument },
    ] }] });
  } finally {
    await context.close().catch(() => {});
  }
});

test("two owner tabs submit complete module and lesson orders by keyboard and reject stale revisions", async ({
  browser,
  baseURL,
}) => {
  if (!storagePath || !baseURL) throw new Error("Owned browser fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const headers = { origin: baseURL, "x-lash-csrf": "1" };
  try {
    const created = await context.request.post("/api/admin/courses", {
      headers,
      data: { title: "Two-tab curriculum", slug: "owned-two-tab-curriculum", status: "draft" },
    });
    expect(created.status()).toBe(200);
    const courseId: string = (await created.json()).course.id;
    const detail = `/api/admin/courses/${courseId}`;
    let revision = 1;
    const moduleIds: string[] = [];
    const lessonIds: string[] = [];
    for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
      const response = await context.request.post(`${detail}/modules`, {
        headers,
        data: { title: `Module ${name}`, slug: `module-${name.toLowerCase()}`,
          expectedCourseRevision: revision, position: index + 1 },
      });
      expect(response.status()).toBe(200);
      moduleIds.push((await response.json()).module.id);
      revision++;
    }
    for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
      const response = await context.request.post(`/api/admin/modules/${moduleIds[0]}/lessons`, {
        headers,
        data: { title: `Lesson ${name}`, slug: `lesson-${name.toLowerCase()}`,
          expectedCourseRevision: revision, position: index + 1,
          contentDocument: { version: 1, blocks: [{ _type: "block", _key: "b",
            children: [{ _type: "span", _key: "s", text: "Owned curriculum fixture" }] }] } },
      });
      expect(response.status()).toBe(200);
      lessonIds.push((await response.json()).lesson.id);
      revision++;
    }
    for (const path of [`/api/admin/modules/${moduleIds[2]}`, `/api/admin/lessons/${lessonIds[2]}`]) {
      const response = await context.request.patch(path, {
        headers,
        data: { expectedCourseRevision: revision, archived: true },
      });
      expect(response.status()).toBe(200);
      revision++;
    }

    const winner = await context.newPage();
    const stale = await context.newPage();
    for (const kind of ["module", "lesson"] as const) {
      const path = kind === "module" ? `${detail}/modules/reorder` : `/api/admin/modules/${moduleIds[0]}/lessons/reorder`;
      const label = kind === "module" ? "Module" : "Lesson";
      const [first, second, archived] = kind === "module" ? moduleIds : lessonIds;
      await Promise.all([winner.goto(`/admin/courses/${courseId}`), stale.goto(`/admin/courses/${courseId}`)]);
      const press = async (tab: typeof winner, name: string, key: "Enter" | "Space") => {
        const button = tab.getByRole("button", { name, exact: true });
        await expect(button).toBeEnabled();
        const pending = tab.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path);
        await button.focus();
        await tab.keyboard.press(key);
        return pending;
      };
      const saved = await press(winner, `Move ${kind} ${label} Beta up`, "Enter");
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual({ expectedCourseRevision: revision, ids: [second, first, archived] });
      await expect(winner.getByText("Curriculum order saved.", { exact: true })).toBeVisible();
      const reply = await saved.json();
      expect(Object.keys(reply)).toEqual([kind === "module" ? "course" : "module"]);
      expect(kind === "module" ? reply.course.revision : reply.module.courseRevision).toBe(revision + 1);
      const rejected = await press(stale, `Move ${kind} ${label} Beta down`, "Space");
      expect(rejected.status()).toBe(409);
      expect(rejected.request().postDataJSON()).toEqual({ expectedCourseRevision: revision, ids: [first, archived, second] });
      const requestId = await rejected.headerValue("x-request-id");
      expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
      const conflict = `This course changed or is not ready for this operation. Reload before trying again. Reference: ${requestId}`;
      await expect(stale.getByRole("alert").getByText(conflict, { exact: true })).toBeVisible();

      const { course } = await (await context.request.get(detail)).json();
      revision++;
      expect(course.revision).toBe(revision);
      const siblings = kind === "module" ? course.modules : course.modules.find((module: { id: string }) => module.id === moduleIds[0]).lessons;
      expect(siblings.map(({ id, position }: { id: string; position: number }) => [id, position])).toEqual([
        [second, 1], [first, 2], [archived, 3],
      ]);
      expect(siblings[2].archivedAt).toBeTruthy();
    }
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

test("paid archive preserves a real manual grant and validated republish restores learner access", async ({
  browser,
  baseURL,
}) => {
  if (!storagePath || !baseURL)
    throw new Error("Owned browser fixture required");
  const states = JSON.parse(await readFile(storagePath, "utf8"));
  const context = await ownedContext(browser, states.owner);
  const learner = await ownedContext(browser, states.manualGrantLearner);
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
    const lessonPath = `/academy/courses/${courseId}/lessons/${lessonId}`;
    const learnerPage = await learner.newPage();
    const privateContent = learnerPage.getByText("PRIVATE_PAID_LESSON_FIXTURE", { exact: true });
    await learnerPage.goto(lessonPath);
    await expect(learnerPage.getByRole("heading", { name: "Enrollment required", exact: true })).toBeVisible();
    await expect(privateContent).toHaveCount(0);
    const grantPage = await context.newPage();
    await grantPage.goto(`/admin/courses/${courseId}/manual-grants`);
    await grantPage.getByLabel("Customer UUID").fill(states.manualGrantCustomerIds[0]);
    await grantPage.getByLabel("Grant reason").fill("Owned paid archive qualification");
    await grantPage.getByRole("button", { name: "Grant manual access", exact: true }).click();
    const grantStatus = grantPage.getByRole("region", { name: "Manual course access" }).getByRole("status");
    await expect(grantStatus).toContainText("Manual grant and audit confirmed");
    await grantPage.close();
    await learnerPage.reload();
    await expect(privateContent).toBeVisible();
    const protectedLessonPath = `/api/academy/lessons/${lessonId}`;
    expect((await learner.request.get(protectedLessonPath)).status()).toBe(200);
    // Give the development server's newly compiled learner routes a stable
    // owner document before exercising transient warning state.
    await page.reload();
    await expect(page.getByText("published · Revision 4", { exact: true })).toBeVisible();
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
    expect((await learner.request.get(protectedLessonPath)).status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Archive course", exact: true })
      .click();
    await expect(warning).toBeVisible();
    expect(await warning.evaluate((section) => {
      const bounds = section.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
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
    await learnerPage.reload();
    await expect(learnerPage.getByRole("heading", { name: "This course is archived", exact: true })).toBeVisible();
    await expect(privateContent).toHaveCount(0);
    const protectedLesson = await learner.request.get(protectedLessonPath);
    expect(protectedLesson.status()).toBe(410);
    expect(protectedLesson.headers()["cache-control"]).toBe("private, no-store");
    expect(await protectedLesson.json()).toMatchObject({ error: { code: "course_archived" } });
    const progressWrite = await learner.request.post(`/api/academy/lessons/${lessonId}/progress`, {
      headers,
      data: { expectedProgressRevision: 0, event: "lesson_started" },
    });
    expect(progressWrite.status()).toBe(410);
    expect(await progressWrite.json()).toMatchObject({ error: { code: "course_archived" } });
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
    await learnerPage.reload();
    await expect(privateContent).toHaveCount(0);
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
    await learnerPage.reload();
    await expect(privateContent).toBeVisible();
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
  } finally {
    await learner.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
