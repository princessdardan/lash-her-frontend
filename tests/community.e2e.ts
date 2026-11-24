import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { encode } from "next-auth/jwt";
import { Pool } from "pg";

const origin = "http://127.0.0.1:3120";
const courseOrigin = "http://127.0.0.1:4107";
const communityOrigin = "http://127.0.0.1:4108";
const authorityFixture = "http://127.0.0.1:4109";
const mini = "e9fc3a24-e440-5a63-badc-098caab9de56";
const otherCourse = "00000000-0000-4000-8000-000000000001";
const adminApi = "/api/admin/community";
const feed = (courseId: string) => `/api/community/spaces/${courseId}/posts`;
const csrf = { origin, "x-lash-csrf": "1" };
const authorText = "Revision 7 practice question";
const reportReason = "Fixture report of an off-topic discussion";
const adminReason = "Audited fixture moderation review";
const publisher = promisify(execFile);

function databaseUrl(role: "frontend" | "course" | "community") {
  const url = new URL(
    process.env[`COMMUNITY_E2E_${role.toUpperCase()}_DATABASE_URL`] ?? "",
  );
  expect(url.protocol).toBe("postgresql:");
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.pathname).toBe(`/lash_community_${role}_test`);
  expect(url.search).toBe("?sslmode=disable");
  return url.href;
}

async function deliverEnrollmentEvents() {
  await publisher(
    process.execPath,
    ["--import", "tsx", resolve("tests/support/community-publisher-once.mjs")],
    {
      cwd: process.env.COMMUNITY_E2E_COURSE_ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_TARGET: "test",
        DOTENV_CONFIG_PATH: "/dev/null",
        TEST_DATABASE_URL: databaseUrl("course"),
        COMMUNITY_ENROLLMENT_PUBLISHER_JWT_CURRENT_SECRET:
          "synthetic-community-course-enrollment-publisher-fixture-key",
      },
    },
  );
}

async function customer(db: Pool, context: BrowserContext) {
  const id = randomUUID();
  const email = `${id}@community-fixture.invalid`;
  const token = randomUUID();
  await db.query(
    "insert into customer_users (id,email,name) values ($1,$2,'Community fixture')",
    [id, email],
  );
  await db.query(
    "insert into customer_sessions (user_id,token_hash,expires) values ($1,$2,now()+interval '1 hour')",
    [id, createHash("sha256").update(token).digest("hex")],
  );
  await context.addCookies([
    {
      url: origin,
      name: "lash-customer.session-token",
      value: token,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return id;
}

async function administrator(
  db: Pool,
  context: BrowserContext,
  role: "owner" | "admin" | "employee",
) {
  const id = randomUUID();
  const subject = `community-fixture-${id}`;
  const email = `${id}@community-fixture.invalid`;
  await db.query(
    "insert into admin_users (id,provider_user_id,email,email_normalized,role,status) values ($1,$2,$3,$3,$4,'active')",
    [id, subject, email, role],
  );
  const name = "authjs.session-token";
  const value = await encode({
    secret: "synthetic-community-authjs-local-moderator-session-fixture",
    salt: name,
    maxAge: 3600,
    token: {
      sub: subject,
      providerUserId: subject,
      email,
      googleEmailVerified: true,
      adminAuthenticatedAt: Math.floor(Date.now() / 1000),
    },
  });
  await context.addCookies([
    { url: origin, name, value, httpOnly: true, sameSite: "Lax" },
  ]);
  return id;
}

function signFixtureJwt(payload: object, key: string) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

function token(
  profile:
    | "course-support"
    | "member"
    | "moderator"
    | "admin-without-capability",
  subject: string,
) {
  const iat = Math.floor(Date.now() / 1000);
  const key =
    profile === "course-support"
      ? "synthetic-community-course-support-signer-for-revocation-fixture"
      : profile === "member"
        ? "synthetic-community-member-signer-and-api-session-fixture"
        : "synthetic-community-moderator-signer-and-api-session-fixture";
  return signFixtureJwt(
    {
      version: 1,
      iss: "lash-her-frontend",
      aud:
        profile === "course-support"
          ? "lash-her-course-api:admin"
          : profile === "member"
            ? "lash-her-community-api:member"
            : "lash-her-community-api:admin",
      sub: subject,
      iat,
      exp: iat + 300,
      jti: randomUUID(),
      ...(profile === "member"
        ? {}
        : {
            capabilities: [
              profile === "moderator"
                ? "community-moderator"
                : "course-support",
            ],
          }),
    },
    key,
  );
}

function enroll(request: APIRequestContext, courseId: string) {
  return request.post(`/api/academy/courses/${courseId}/enrollments`, {
    headers: csrf,
    data: { idempotencyKey: randomUUID() },
  });
}

async function setupPage(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "lh_cookie_consent",
      JSON.stringify({
        required: true,
        analytics: false,
        version: 1,
        decidedAt: new Date().toISOString(),
      }),
    ),
  );
}

test("course spaces enforce live Course access during discussions, moderation, outage and revocation", async ({
  page,
  context,
  browser,
  request,
}) => {
  const frontendDb = new Pool({ connectionString: databaseUrl("frontend") });
  const courseDb = new Pool({ connectionString: databaseUrl("course") });
  const communityDb = new Pool({ connectionString: databaseUrl("community") });
  const peer = await browser.newContext({ baseURL: origin });
  const outsider = await browser.newContext({ baseURL: origin });
  const staff = await browser.newContext({ baseURL: origin });
  const employee = await browser.newContext({ baseURL: origin });
  const regularAdmin = await browser.newContext({ baseURL: origin });
  try {
    const learnerId = await customer(frontendDb, context);
    await customer(frontendDb, peer);
    const outsiderId = await customer(frontendDb, outsider);
    const moderatorId = await administrator(frontendDb, staff, "owner");
    await administrator(frontendDb, employee, "employee");
    await administrator(frontendDb, regularAdmin, "admin");
    const mod = await staff.newPage();
    const peerPage = await peer.newPage();
    await Promise.all([setupPage(page), setupPage(peerPage), setupPage(mod)]);

    const anonymous = await request.get("/api/community/spaces");
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()["cache-control"]).toBe("private, no-store");
    await test.step("ordinary access fails with fixture admission closed", async () => {
      const fixture = process.env.COMMUNITY_E2E_FIXTURE_DIRECTORY;
      expect(fixture).toMatch(
        /^\/(?:private\/)?tmp\/lash-p506-browser\.[A-Za-z0-9]+$/u,
      );
      const path = resolve(fixture!, "admission.json");
      const original = await readFile(path, "utf8");
      const setAdmission = async (value: string) => {
        const pending = path + ".next";
        await writeFile(pending, value, { mode: 0o600 });
        await rename(pending, path);
      };
      try {
        await setAdmission(
          JSON.stringify({ ...JSON.parse(original), newWork: false }),
        );
        const closed = await Promise.all([
          page.request.get("/api/community/spaces"),
          staff.request.get(adminApi + "/reports"),
        ]);
        for (const response of closed) {
          expect(response.status()).toBe(503);
          expect(response.headers()["cache-control"]).toBe("private, no-store");
          expect(await response.json()).toMatchObject({
            error: { code: "service_unavailable" },
          });
        }
      } finally {
        await setAdmission(original);
      }
    });
    for (const denied of [employee, regularAdmin]) {
      const response = await denied.request.get(adminApi + "/reports");
      expect(response.status()).toBe(403);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
    }
    expect(
      (
        await request.get(communityOrigin + "/v1/moderation/reports", {
          headers: { authorization: "Bearer " + token("member", learnerId) },
        })
      ).status(),
    ).toBe(401);
    await mod.goto("/admin/community");
    await expect(
      mod.getByRole("heading", { name: "Community moderation" }),
    ).toBeVisible();
    await mod.getByText("Configure course space", { exact: true }).click();
    for (const [id, title] of [
      [mini, "Free Mini Course discussions"],
      [otherCourse, "Other course discussions"],
    ]) {
      await mod.getByLabel("Course ID").fill(id);
      await mod.getByLabel("Space title").fill(title);
      const saved = mod.waitForResponse(
        (response) =>
          response.url().endsWith(`/spaces/${id}`) &&
          response.request().method() === "PUT",
      );
      await mod.getByRole("button", { name: "Save space" }).click();
      expect((await saved).status()).toBe(200);
    }
    expect((await page.request.get(feed(mini))).status()).toBe(403);
    expect((await enroll(page.request, mini)).status()).toBe(200);
    expect((await enroll(peer.request, mini)).status()).toBe(200);
    expect((await enroll(outsider.request, otherCourse)).status()).toBe(200);

    // Direct course entry allows a freshly enrolled learner before projection catches up.
    expect(
      (await (await page.request.get("/api/community/spaces")).json()).spaces,
    ).toEqual([]);
    await page.goto(`/academy/courses/${mini}`);
    await page.getByRole("link", { name: "Course discussions" }).click();
    await expect(
      page.getByRole("heading", { name: "Free Mini Course discussions" }),
    ).toBeVisible();
    await deliverEnrollmentEvents();
    await page.goto("/community");
    await expect(
      page.getByRole("link", { name: "Free Mini Course discussions" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Other course discussions" }),
    ).toHaveCount(0);
    await page.getByLabel("Community display name").fill("Fixture learner");
    await page.getByRole("button", { name: "Save display name" }).click();
    await expect(page.getByText("Changes saved.")).toBeVisible();
    await page
      .getByRole("link", { name: "Free Mini Course discussions" })
      .click();
    expect(
      (
        await page.request.post(feed(mini), {
          headers: { ...csrf, origin: "https://foreign.invalid" },
          data: { body: "invalid" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post(feed(mini), {
          headers: csrf,
          data: { body: "  " },
        })
      ).status(),
    ).toBe(400);
    await page.getByLabel("New discussion").fill(authorText);
    await page.getByRole("button", { name: "Post discussion" }).click();
    await expect(page.getByText(authorText)).toBeVisible();
    await expect(page.getByText("Fixture learner")).toBeVisible();
    const listed = await page.request.get(feed(mini) + "?search=Revision");
    expect(listed.status()).toBe(200);
    expect(listed.headers()["cache-control"]).toBe("private, no-store");
    const postId = (await listed.json()).posts[0].id as string;
    expect(
      (await (await page.request.get(feed(mini) + "?search=absent")).json())
        .posts,
    ).toEqual([]);
    const thread = `/api/community/discussions/${postId}`;
    const content = `/api/community/content/${postId}`;
    expect((await outsider.request.get(thread)).status()).toBe(403);
    expect(
      (
        await outsider.request.post(thread + "/comments", {
          headers: csrf,
          data: { body: "Cross-course comment" },
        })
      ).status(),
    ).toBe(403);
    expect((await outsider.request.get(feed(otherCourse))).status()).toBe(200);
    expect(
      (
        await peer.request.patch(content, {
          headers: csrf,
          data: { body: "Someone else's content" },
        })
      ).status(),
    ).toBe(403);

    await page
      .getByRole("article")
      .filter({ hasText: authorText })
      .getByRole("link", { name: "Open discussion" })
      .click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Edit message").fill(authorText + " edited");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(authorText + " edited")).toBeVisible();
    await peerPage.goto(`/community/discussions/${postId}`);
    await peerPage.getByLabel("Reply", { exact: true }).fill("Fixture answer");
    await peerPage.getByRole("button", { name: "Post reply" }).click();
    await expect(peerPage.getByText("Fixture answer")).toBeVisible();
    await peerPage.getByRole("button", { name: "Like", exact: true }).click();
    await expect(peerPage.getByText("1 reaction")).toBeVisible();
    await peerPage.reload();
    await expect(peerPage.getByText(authorText + " edited")).toBeVisible();
    await expect(
      peerPage.getByText("Fixture answer", { exact: true }),
    ).toBeVisible();
    const reaction = peerPage.getByRole("button", {
      name: "Remove like",
      exact: true,
    });
    await expect(reaction).toHaveAttribute("aria-pressed", "true");
    await expect(
      peerPage.getByText("1 reaction", { exact: true }),
    ).toBeVisible();
    await peerPage.getByRole("button", { name: "Report", exact: true }).click();
    await peerPage.getByLabel("Report reason").fill(reportReason);
    await peerPage.getByRole("button", { name: "Send report" }).click();
    await expect(peerPage.getByText("Report sent.")).toBeVisible();

    // The moderator has no Course enrollment. The learner participates in both spaces.
    expect((await enroll(page.request, otherCourse)).status()).toBe(200);
    await mod.reload();
    const report = mod.getByRole("article").filter({ hasText: reportReason });
    await expect(report).toBeVisible();
    const reportId = (
      await (await staff.request.get(adminApi + "/reports")).json()
    ).reports.find(({ reason }: { reason: string }) => reason === reportReason)
      .id as string;
    const sanction = {
      actionId: randomUUID(),
      reportId,
      action: "suspend",
      reason: adminReason,
    };
    expect(
      (
        await employee.request.post(adminApi + "/actions", {
          headers: csrf,
          data: sanction,
        })
      ).status(),
    ).toBe(403);
    for (const [profile, subject] of [
      ["member", learnerId],
      ["admin-without-capability", moderatorId],
    ] as const) {
      const rejected = await request.post(
        communityOrigin + "/v1/moderation/actions",
        {
          headers: { authorization: "Bearer " + token(profile, subject) },
          data: sanction,
        },
      );
      expect(rejected.status()).toBe(401);
    }
    expect(
      (
        await staff.request.post(adminApi + "/actions", {
          headers: csrf,
          data: { ...sanction, reason: " " },
        })
      ).status(),
    ).toBe(400);
    async function action(
      value:
        | "hide"
        | "restore"
        | "lock"
        | "unlock"
        | "pin"
        | "suspend"
        | "unsuspend"
        | "resolve",
    ) {
      await report.getByLabel("Action").selectOption(value);
      await report.getByLabel("Moderation reason").fill(adminReason);
      const committed = mod.waitForResponse((response) =>
        response.url().endsWith("/api/admin/community/actions"),
      );
      await report.getByRole("button", { name: "Apply action" }).click();
      expect((await committed).status()).toBe(200);
    }
    await action("hide");
    expect((await peer.request.get(thread)).status()).toBe(404);
    await action("restore");
    expect((await peer.request.get(thread)).status()).toBe(200);
    await action("lock");
    expect(
      (
        await peer.request.post(thread + "/comments", {
          headers: csrf,
          data: { body: "A locked reply" },
        })
      ).status(),
    ).toBe(409);
    await action("unlock");
    await action("pin");
    expect((await (await page.request.get(thread)).json()).post.pinned).toBe(
      true,
    );
    await action("suspend");
    expect((await page.request.get(thread)).status()).toBe(200);
    const suspendedFeed = await page.request.get(
      feed(mini) + "?search=Revision",
    );
    expect(suspendedFeed.status()).toBe(200);
    expect((await suspendedFeed.json()).posts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: postId })]),
    );
    for (const [method, url, data] of [
      ["POST", feed(mini), { body: "Blocked discussion" }],
      ["POST", thread + "/comments", { body: "Blocked reply" }],
      ["PUT", thread + "/reaction", { active: true }],
      ["PATCH", content, { body: "Blocked edit" }],
      ["DELETE", content, {}],
      ["POST", content + "/reports", { reason: "Blocked report" }],
    ] as const) {
      const suspended = await page.request.fetch(url, {
        method,
        headers: csrf,
        data,
      });
      expect(suspended.status(), `${method} ${url}`).toBe(403);
      expect((await suspended.json()).error.code).toBe(
        "participation_suspended",
      );
    }
    expect(
      (
        await page.request.post(feed(otherCourse), {
          headers: csrf,
          data: { body: "Participation continues in the other course" },
        })
      ).status(),
    ).toBe(201);
    expect(
      (await page.request.get(`/api/academy/courses/${mini}`)).status(),
    ).toBe(200);
    expect(
      (
        await courseDb.query(
          "select user_id, status from entitlement_grants where user_id=any($1::uuid[]) and course_id=$2",
          [[learnerId, moderatorId], mini],
        )
      ).rows,
    ).toEqual([{ user_id: learnerId, status: "active" }]);
    await action("unsuspend");
    expect(
      (
        await page.request.put(thread + "/reaction", {
          headers: csrf,
          data: { active: true },
        })
      ).status(),
    ).toBe(200);

    const replay = {
      actionId: randomUUID(),
      reportId,
      action: "resolve",
      reason: adminReason,
    };
    for (const body of [
      replay,
      replay,
      { ...replay, reason: "Conflicting replay" },
    ]) {
      const result = await staff.request.post(adminApi + "/actions", {
        headers: csrf,
        data: body,
      });
      expect(result.status()).toBe(body.reason === adminReason ? 200 : 409);
    }
    expect(
      (
        await communityDb.query(
          "select actor_id, action, reason from community_moderation_actions where report_id=$1 order by created_at,id",
          [reportId],
        )
      ).rows,
    ).toEqual(
      [
        "hide",
        "restore",
        "lock",
        "unlock",
        "pin",
        "suspend",
        "unsuspend",
        "resolve",
      ].map((action) => ({
        actor_id: moderatorId,
        action,
        reason: adminReason,
      })),
    );

    const temporaryReply = await peer.request.post(thread + "/comments", {
      headers: csrf,
      data: { body: "Delete this fixture reply" },
    });
    expect(temporaryReply.status()).toBe(201);
    const temporaryId = (await temporaryReply.json()).id;
    expect(
      (
        await peer.request.delete(`/api/community/content/${temporaryId}`, {
          headers: csrf,
          data: {},
        })
      ).status(),
    ).toBe(200);
    expect(
      (await (await peer.request.get(thread)).json()).comments.map(
        ({ body }: { body: string }) => body,
      ),
    ).toEqual(["Fixture answer"]);
    const search = `Pagination-${randomUUID()}`;
    const foreign = await outsider.request.post(feed(otherCourse), {
      headers: csrf,
      data: { body: `${search} from another course` },
    });
    expect(foreign.status()).toBe(201);
    const foreignId = (await foreign.json()).id;
    expect(
      (await page.request.get(feed(mini) + "?after=" + foreignId)).status(),
    ).toBe(404);
    const seeded = await communityDb.query<{ id: string }>(
      `with seeded as (
         insert into community_content (course_id, author_id, body, pinned, status, created_at)
         select $1, $2, $3 || ' ' || n, n = 1,
           case when n = 22 then 'hidden' else 'visible' end,
           now() + interval '1 hour' + ((n - 2) / 3) * interval '1 millisecond'
         from generate_series(1,22) n
         returning id, status, pinned, created_at
       )
       select id from seeded where status = 'visible'
       order by pinned desc, created_at desc, id desc`,
      [mini, learnerId, search],
    );
    const searchQuery = "?search=" + search.toUpperCase();
    const results = await page.request.get(feed(mini) + searchQuery);
    const firstPage = await results.json();
    const ids = (posts: { id: string }[]) => posts.map(({ id }) => id);
    const expected = ids(seeded.rows);
    expect(results.status()).toBe(200);
    expect(firstPage.space.courseId).toBe(mini);
    expect(ids(firstPage.posts)).toEqual(expected.slice(0, 20));
    expect(firstPage.next).toBe(expected[19]);
    expect(firstPage.posts[0].pinned).toBe(true);
    const second = await page.request.get(
      feed(mini) + searchQuery + "&after=" + firstPage.next,
    );
    expect(second.status()).toBe(200);
    const secondPage = await second.json();
    expect(ids(secondPage.posts)).toEqual(expected.slice(20));
    expect(secondPage.next).toBeNull();
    const otherResults = await page.request.get(
      feed(otherCourse) + searchQuery,
    );
    expect(otherResults.status()).toBe(200);
    expect(ids((await otherResults.json()).posts)).toEqual([foreignId]);
    expect(
      (await outsider.request.get(feed(mini) + searchQuery)).status(),
    ).toBe(403);
    const plainFirst = await page.request.get(feed(mini));
    expect(plainFirst.status()).toBe(200);
    const plain = await plainFirst.json();
    expect(ids(plain.posts)).toEqual([
      expected[0],
      postId,
      ...expected.slice(1, 19),
    ]);
    const plainSecond = await page.request.get(
      feed(mini) + "?after=" + plain.next,
    );
    expect(plainSecond.status()).toBe(200);
    expect(ids((await plainSecond.json()).posts)).toEqual(expected.slice(19));

    await page.goto(`/community/courses/${mini}`);
    await page
      .getByRole("searchbox", { name: "Search discussions" })
      .fill(search);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const feedPages = page.getByRole("navigation", {
      name: "Discussion pages",
    });
    await expect(page.getByRole("article")).toHaveCount(20);
    await feedPages.getByRole("button", { name: "Next page" }).press("Enter");
    await expect(
      page.getByRole("heading", { name: "Free Mini Course discussions" }),
    ).toBeFocused();
    await expect(page.getByRole("article")).toHaveCount(1);
    await feedPages.getByRole("button", { name: "First page" }).click();
    await expect(page.getByRole("article")).toHaveCount(20);

    await communityDb.query(
      `insert into community_content (course_id, author_id, parent_id, body, created_at)
       select $1, $2, $3, 'Fixture paginated reply ' || n,
         now() + n * interval '1 millisecond'
       from generate_series(1,21) n`,
      [mini, learnerId, expected[0]],
    );
    await page.goto(`/community/discussions/${expected[0]}`);
    const replyPages = page.getByRole("navigation", { name: "Reply pages" });
    const oldestReply = page.getByText("Fixture paginated reply 1", {
      exact: true,
    });
    const newestReply = page.getByText("Fixture paginated reply 21", {
      exact: true,
    });
    await expect(newestReply).toBeVisible();
    await replyPages.getByRole("button", { name: "Next page" }).click();
    await expect(oldestReply).toBeVisible();
    await expect(newestReply).toHaveCount(0);
    await replyPages.getByRole("button", { name: "First page" }).click();
    await expect(newestReply).toBeVisible();

    await page.goto(`/community/discussions/${postId}`);
    await page.reload();
    await expect(page.getByText(authorText + " edited")).toBeVisible();
    expect(
      (await request.put(authorityFixture + "/fixture/offline")).status(),
    ).toBe(204);
    const outage = await page.request.get(thread);
    expect(outage.status()).toBe(503);
    expect(await outage.text()).not.toContain(authorText);
    expect((await page.request.get("/api/community/spaces")).status()).toBe(
      503,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByText("The service is temporarily unavailable."),
    ).toBeVisible();
    await expect(page.getByText(authorText + " edited")).toHaveCount(0);
    expect(
      (await request.put(authorityFixture + "/fixture/online")).status(),
    ).toBe(204);
    await page.getByRole("button", { name: "Check access again" }).click();
    await expect(page.getByText(authorText + " edited")).toBeVisible();

    const grant = (
      await courseDb.query<{ id: string }>(
        "select id from entitlement_grants where user_id=$1 and course_id=$2 and status='active'",
        [learnerId, mini],
      )
    ).rows[0];
    expect(grant).toBeTruthy();
    const idempotencyKey = "community-fixture-" + randomUUID();
    const revoked = await request.post(
      courseOrigin + "/v1/admin/entitlements/revocations",
      {
        headers: {
          authorization: "Bearer " + token("course-support", moderatorId),
          "x-idempotency-key": idempotencyKey,
        },
        data: {
          scope: "grantId",
          grantId: grant.id,
          reason: "Isolated Course access revocation",
          idempotencyKey,
        },
      },
    );
    expect(revoked.status()).toBe(200);
    const projection = () =>
      communityDb.query<{ state: string }>(
        "select state from course_enrollment_projections where user_id=$1 and course_id=$2",
        [learnerId, mini],
      );
    expect((await projection()).rows).toEqual([{ state: "active" }]);
    expect((await page.request.get(feed(mini))).status()).toBe(403);
    expect((await page.request.get(thread)).status()).toBe(403);
    expect(
      (
        await page.request.post(thread + "/comments", {
          headers: csrf,
          data: { body: "Blocked after revocation" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await (await page.request.get("/api/community/spaces")).json()).spaces,
    ).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Course access is required.")).toBeVisible();
    await expect(page.getByText(authorText + " edited")).toHaveCount(0);
    expect((await peer.request.get(thread)).status()).toBe(200);
    expect((await outsider.request.get(feed(otherCourse))).status()).toBe(200);
    expect(
      (
        await communityDb.query(
          "select user_id from course_enrollment_projections where user_id=$1 and course_id=$2",
          [outsiderId, mini],
        )
      ).rows,
    ).toEqual([]);
    await deliverEnrollmentEvents();
    expect((await projection()).rows).toEqual([{ state: "revoked" }]);
  } finally {
    await request.put(authorityFixture + "/fixture/online");
    await Promise.all([
      peer.close(),
      outsider.close(),
      staff.close(),
      regularAdmin.close(),
      employee.close(),
      frontendDb.end(),
      courseDb.end(),
      communityDb.end(),
    ]);
  }
});

const objectOrigin = "http://127.0.0.1:4110";
const listMedia = (id: string) => `/api/community/discussions/${id}/media`;
const viewMedia = (id: string) => `/api/community/media/${id}/view`;
const completePath = (id: string) => `/api/community/media/${id}/complete`;
const rawUrl = (id: string) =>
  `${objectOrigin}/community-media-fixture/quarantine/${id}`;

async function processMediaOnce() {
  const { stdout } = await publisher(
    process.execPath,
    ["--import", "tsx", "src/media/run-once.ts"],
    {
      cwd: process.env.COMMUNITY_E2E_COMMUNITY_ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_TARGET: "test",
        DOTENV_CONFIG_PATH: "/dev/null",
        TEST_DATABASE_URL: databaseUrl("community"),
        COMMUNITY_MEDIA_BUCKET: "community-media-fixture",
        COMMUNITY_MEDIA_REGION: "us-east-1",
        COMMUNITY_MEDIA_TEST_ENDPOINT: objectOrigin,
        AWS_ACCESS_KEY_ID: "community-media-test",
        AWS_SECRET_ACCESS_KEY: "synthetic-private-media-object-storage-key",
        AWS_EC2_METADATA_DISABLED: "true",
      },
    },
  );
  return JSON.parse(stdout) as {
    ready: number;
    rejected: number;
    retried: number;
    cleanup: number;
  };
}

test("Community image uploads are processed privately and new view links stop on Course revocation", async ({
  page,
  context,
  browser,
  request,
}) => {
  test.skip(
    process.env.COMMUNITY_MEDIA_E2E !== "1",
    "Requires the isolated signed media fixture",
  );
  const { default: sharp } = await import("sharp");
  const frontendDb = new Pool({ connectionString: databaseUrl("frontend") });
  const courseDb = new Pool({ connectionString: databaseUrl("course") });
  const communityDb = new Pool({ connectionString: databaseUrl("community") });
  const reader = await browser.newContext({ baseURL: origin });
  const outsider = await browser.newContext({ baseURL: origin });
  const staff = await browser.newContext({ baseURL: origin });
  const imageBytes = await sharp({
    create: {
      width: 80,
      height: 50,
      channels: 3,
      background: "#726e54",
    },
  })
    .withExif({ IFD0: { Artist: "Synthetic metadata to remove" } })
    .jpeg()
    .toBuffer();

  async function reserve(
    post: string,
    buffer: Buffer,
    mime = "image/jpeg",
    size = buffer.length,
    id: string = randomUUID(),
  ) {
    return page.request.post(listMedia(post), {
      headers: csrf,
      data: {
        id,
        type: mime,
        bytes: size,
        checksum: createHash("sha256").update(buffer).digest("base64"),
      },
    });
  }
  async function postImage(post: string, bytes: Buffer, mime = "image/jpeg") {
    const result = await reserve(post, bytes, mime);
    expect(result.status(), await result.text()).toBe(201);
    const upload = await result.json();
    expect(
      (
        await request.put(upload.url, { headers: upload.headers, data: bytes })
      ).status(),
    ).toBe(200);
    return upload.id as string;
  }
  async function complete(id: string) {
    return page.request.post(completePath(id), { headers: csrf, data: {} });
  }
  const stored = async () =>
    (await (await request.get(objectOrigin + "/fixture/objects")).json()).map(
      ({ key }: { key: string }) => key,
    ) as string[];
  const read = async (id: string) =>
    (
      await communityDb.query(
        "select status,attempts,original_removed_at,derivative_removed_at from community_discussion_media where id=$1",
        [id],
      )
    ).rows[0];

  try {
    await customer(frontendDb, context);
    const readerId = await customer(frontendDb, reader);
    await customer(frontendDb, outsider);
    const moderator = await administrator(frontendDb, staff, "owner");
    const readerPage = await reader.newPage();
    await Promise.all([setupPage(page), setupPage(readerPage)]);
    expect(
      (
        await staff.request.put(`${adminApi}/spaces/${mini}`, {
          headers: csrf,
          data: {
            title: "Free Mini Course images",
            enabled: true,
          },
        })
      ).status(),
    ).toBe(200);
    for (const session of [page.request, reader.request])
      expect((await enroll(session, mini)).status()).toBe(200);
    await deliverEnrollmentEvents();
    const postReply = await page.request.post(feed(mini), {
      headers: csrf,
      data: { body: "Private media discussion fixture" },
    });
    expect(postReply.status()).toBe(201);
    const postId = (await postReply.json()).id;
    const discussion = `/community/discussions/${postId}`;

    expect((await request.get(listMedia(postId))).status()).toBe(401);
    expect((await outsider.request.get(listMedia(postId))).status()).toBe(403);
    expect((await reserve(postId, imageBytes, "image/gif")).status()).toBe(400);
    expect(
      (
        await reserve(postId, imageBytes, "image/jpeg", 10 * 1024 * 1024 + 1)
      ).status(),
    ).toBe(400);
    await page.goto(discussion);
    const file = {
      name: "fixture.jpg",
      mimeType: "image/jpeg",
      buffer: imageBytes,
    };
    await page.getByLabel("Add images").setInputFiles(file);
    const start = page.waitForResponse(
      (response) =>
        response.url().endsWith(listMedia(postId)) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Upload images" }).click();
    const started = await start;
    expect(started.status(), await started.text()).toBe(201);
    expect(started.headers()["cache-control"]).toBe("private, no-store");
    const ticket = await started.json();
    const [mediaId, put] = [ticket.id as string, new URL(ticket.url)];
    expect(put.pathname).toContain("/quarantine/");
    expect(put.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining([
        "content-length",
        "content-type",
        "if-none-match",
        "x-amz-checksum-sha256",
      ]),
    );
    await expect(page.getByText("Image queued for processing.")).toBeVisible();
    expect(await read(mediaId)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect((await request.get(rawUrl(mediaId))).status()).toBe(403);
    expect((await request.get(ticket.url)).status()).toBe(403);
    expect(
      (
        await request.put(ticket.url, {
          headers: ticket.headers,
          data: imageBytes,
        })
      ).status(),
    ).toBe(412);
    expect((await reader.request.get(viewMedia(mediaId))).status()).toBe(404);
    expect(
      (
        await reader.request.post(completePath(mediaId), {
          headers: csrf,
          data: {},
        })
      ).status(),
    ).toBe(403);
    expect(
      (await (await reader.request.get(listMedia(postId))).json()).images,
    ).toEqual([]);

    // Make the worker recover a stale lease, then fail its first storage read.
    await communityDb.query(
      "update community_discussion_media set status='processing',attempts=1,lease_until=now()-interval '1 minute',lease_id=$2 where id=$1",
      [mediaId, randomUUID()],
    );
    await request.put(objectOrigin + "/fixture/fail-read");
    expect(await processMediaOnce()).toMatchObject({ ready: 0, retried: 1 });
    expect(await read(mediaId)).toMatchObject({
      status: "queued",
      attempts: 2,
    });
    await communityDb.query(
      "update community_discussion_media set available_at=now() where id=$1",
      [mediaId],
    );

    const malformed = await postImage(
      postId,
      Buffer.concat([imageBytes, Buffer.from("<svg onload='alert(1)'/>")]),
    );
    const largeRaster = await sharp({
      create: { width: 4097, height: 2, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const oversizeRaster = await postImage(postId, largeRaster, "image/png");
    const truncated = await postImage(postId, imageBytes.subarray(0, -2));
    const contenders = await Promise.all([
      reserve(postId, imageBytes),
      reserve(postId, imageBytes),
    ]);
    expect(contenders.map((result) => result.status()).sort()).toEqual([
      201, 409,
    ]);
    const orphanTicket = await contenders
      .find((result) => result.status() === 201)!
      .json();
    const orphan = orphanTicket.id as string;
    expect((await complete(orphan)).status()).toBe(409);
    expect(
      (
        await reserve(
          postId,
          imageBytes,
          "image/jpeg",
          imageBytes.length,
          orphan,
        )
      ).status(),
    ).toBe(201);
    expect(
      (
        await reserve(
          postId,
          imageBytes,
          "image/png",
          imageBytes.length,
          orphan,
        )
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.put(orphanTicket.url, {
          headers: orphanTicket.headers,
          data: imageBytes.subarray(0, -1),
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.put(orphanTicket.url, {
          headers: orphanTicket.headers,
          data: Buffer.alloc(imageBytes.length),
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.put(orphanTicket.url, {
          headers: orphanTicket.headers,
          data: imageBytes,
        })
      ).status(),
    ).toBe(200);
    for (const id of [malformed, oversizeRaster, truncated])
      expect((await complete(id)).status()).toBe(202);
    expect(await processMediaOnce()).toMatchObject({
      ready: 1,
      rejected: 3,
      retried: 0,
    });
    expect(await read(mediaId)).toMatchObject({ status: "ready", attempts: 3 });
    for (const id of [malformed, oversizeRaster, truncated]) {
      expect(await read(id)).toMatchObject({ status: "rejected" });
      expect((await page.request.get(viewMedia(id))).status()).toBe(404);
      expect(await stored()).not.toContain(`processed/${id}.webp`);
    }
    expect((await complete(mediaId)).status()).toBe(202);
    await readerPage.goto(discussion);
    const image = readerPage.getByRole("img", {
      name: "Discussion attachment",
    });
    await expect
      .poll(async () =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBe(80);
    const result = await reader.request.get(viewMedia(mediaId));
    expect(result.status()).toBe(200);
    expect(result.headers()["cache-control"]).toBe("private, no-store");
    const { url, expiresIn } = await result.json();
    expect(expiresIn).toBe(30);
    const derivative = await request.get(url);
    expect(derivative.status()).toBe(200);
    expect(derivative.headers()["content-type"]).toBe("image/webp");
    expect(derivative.headers()["cache-control"]).toContain("no-store");
    const metadata = await sharp(await derivative.body()).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 80, height: 50 });
    expect(metadata.exif).toBeUndefined();
    expect((await request.get(url.split("?")[0])).status()).toBe(403);
    expect((await outsider.request.get(viewMedia(mediaId))).status()).toBe(403);

    const report = await reader.request.post(
      `/api/community/content/${postId}/reports`,
      {
        headers: csrf,
        data: { reason: "Test media visibility during moderation" },
      },
    );
    expect(report.status()).toBe(201);
    const reportId = (await report.json()).id;
    for (const action of ["hide", "restore"]) {
      const moderated = await staff.request.post(adminApi + "/actions", {
        headers: csrf,
        data: {
          action,
          actionId: randomUUID(),
          reportId,
          reason: "Fixture visibility review",
        },
      });
      expect(moderated.status()).toBe(200);
      expect((await reader.request.get(viewMedia(mediaId))).status()).toBe(
        action === "hide" ? 404 : 200,
      );
    }

    const readerPost = await reader.request.post(feed(mini), {
      headers: csrf,
      data: { body: "Participation fixture" },
    });
    expect(readerPost.status()).toBe(201);
    const readerPostId = (await readerPost.json()).id;
    const sanction = await page.request.post(
      `/api/community/content/${readerPostId}/reports`,
      {
        headers: csrf,
        data: { reason: "Test independent participation suspension" },
      },
    );
    expect(sanction.status()).toBe(201);
    const sanctionReport = (await sanction.json()).id;
    for (const action of ["suspend", "unsuspend"]) {
      const status = await staff.request.post(adminApi + "/actions", {
        headers: csrf,
        data: {
          action,
          actionId: randomUUID(),
          reportId: sanctionReport,
          reason: "Fixture participation review",
        },
      });
      expect(status.status()).toBe(200);
      const view = await reader.request.get(viewMedia(mediaId));
      expect(view.status()).toBe(action === "suspend" ? 403 : 200);
      if (action === "suspend")
        expect((await view.json()).error.code).toBe("participation_suspended");
    }

    // Reserve capacity without uploading bytes to confirm the shared quarantine limit.
    const capacityPost = await page.request.post(feed(mini), {
      headers: csrf,
      data: { body: "Storage capacity fixture" },
    });
    expect(capacityPost.status()).toBe(201);
    const bulk = await communityDb.query<{ id: string }>(
      "insert into community_discussion_media (id,post_id,owner_id,type,bytes,checksum,upload_until,clean_original_after) select gen_random_uuid(),$1,gen_random_uuid(),'image/jpeg',10485760,$2,now()+interval '5 minutes',now()+interval '6 minutes' from generate_series(1,13) returning id",
      [readerPostId, createHash("sha256").update(imageBytes).digest("base64")],
    );
    try {
      expect(
        (await reserve((await capacityPost.json()).id, imageBytes)).status(),
      ).toBe(503);
    } finally {
      await communityDb.query(
        "delete from community_discussion_media where id=any($1::uuid[])",
        [bulk.rows.map(({ id }) => id)],
      );
    }

    const [grant] = (
      await courseDb.query(
        "select id from entitlement_grants where user_id=$1 and course_id=$2 and status='active'",
        [readerId, mini],
      )
    ).rows;
    const idempotencyKey = "community-media-" + randomUUID();
    const revoked = await request.post(
      courseOrigin + "/v1/admin/entitlements/revocations",
      {
        headers: {
          authorization: "Bearer " + token("course-support", moderator),
          "x-idempotency-key": idempotencyKey,
        },
        data: {
          scope: "grantId",
          grantId: grant.id,
          reason: "Isolated image viewer revocation",
          idempotencyKey,
        },
      },
    );
    expect(revoked.status()).toBe(200);
    expect(
      (
        await communityDb.query(
          "select state from course_enrollment_projections where user_id=$1 and course_id=$2",
          [readerId, mini],
        )
      ).rows,
    ).toEqual([{ state: "active" }]);
    for (const path of [listMedia(postId), viewMedia(mediaId)])
      expect((await reader.request.get(path)).status()).toBe(403);
    expect((await page.request.get(viewMedia(mediaId))).status()).toBe(200);
    await readerPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      readerPage.getByText("Course access is required."),
    ).toBeVisible();
    await expect(image).toHaveCount(0);
    expect(
      (await request.put(objectOrigin + "/fixture/time?advance=yes")).status(),
    ).toBe(204);
    expect((await request.get(url)).status()).toBe(403);
    await request.put(objectOrigin + "/fixture/time");

    // A bounded cleanup pass removes the abandoned upload, expired originals,
    // and the deterministic derivative for an owner-deleted post.
    await communityDb.query(
      "update community_discussion_media set upload_until=now()-interval '2 minutes',clean_original_after=now()-interval '1 minute' where post_id=$1",
      [postId],
    );
    expect(
      (
        await page.request.delete(`/api/community/content/${postId}`, {
          headers: csrf,
          data: {},
        })
      ).status(),
    ).toBe(200);
    expect((await page.request.get(viewMedia(mediaId))).status()).toBe(404);
    await processMediaOnce();
    expect(await read(orphan)).toMatchObject({ status: "removed" });
    expect(await read(mediaId)).toMatchObject({
      status: "removed",
      derivative_removed_at: expect.any(Date),
    });
    expect(
      (await stored()).filter((key) =>
        [mediaId, malformed, oversizeRaster, truncated, orphan].some((id) =>
          key.includes(id),
        ),
      ),
    ).toEqual([]);
  } finally {
    await request.put(objectOrigin + "/fixture/time");
    await Promise.all([
      reader.close(),
      outsider.close(),
      staff.close(),
      frontendDb.end(),
      courseDb.end(),
      communityDb.end(),
    ]);
  }
});

const inboxPath = "/api/community/notifications";
const preferencePath = inboxPath + "/preferences";

test("Community reply and moderation notifications honor preferences, unread counts and replay", async ({
  page,
  context,
  browser,
  request,
}) => {
  const frontendDb = new Pool({ connectionString: databaseUrl("frontend") });
  const courseDb = new Pool({ connectionString: databaseUrl("course") });
  const communityDb = new Pool({ connectionString: databaseUrl("community") });
  const peer = await browser.newContext({ baseURL: origin });
  const outsider = await browser.newContext({ baseURL: origin });
  const staff = await browser.newContext({ baseURL: origin });
  const replyText = "Reply committed before the browser received its response";
  const readPath = (id: string) => `${inboxPath}/${id}/read`;

  async function list(session: APIRequestContext, path = inboxPath) {
    const response = await session.get(path);
    expect(response.status(), await response.text()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    return response.json();
  }

  async function write(
    session: APIRequestContext,
    path: string,
    body: object,
    expected = 200,
  ) {
    const response = await session.put(path, { headers: csrf, data: body });
    expect(response.status(), await response.text()).toBe(expected);
    return response.json();
  }

  try {
    const authorId = await customer(frontendDb, context);
    const peerId = await customer(frontendDb, peer);
    await customer(frontendDb, outsider);
    const moderatorId = await administrator(frontendDb, staff, "owner");
    const peerPage = await peer.newPage();
    await Promise.all([setupPage(page), setupPage(peerPage)]);
    expect((await request.get(inboxPath)).status()).toBe(401);
    for (const [courseId, title] of [
      [mini, "Mini Course notification fixture"],
      [otherCourse, "Other course notification fixture"],
    ]) {
      await write(staff.request, `${adminApi}/spaces/${courseId}`, {
        title,
        enabled: true,
      });
      for (const session of [page.request, peer.request])
        expect((await enroll(session, courseId)).status()).toBe(200);
    }
    expect((await enroll(outsider.request, otherCourse)).status()).toBe(200);
    await deliverEnrollmentEvents();
    expect(await list(page.request, preferencePath)).toEqual({
      replies: true,
      moderation: true,
    });

    async function newPost(courseId: string, body: string) {
      const response = await page.request.post(feed(courseId), {
        headers: csrf,
        data: { body },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    }
    const post = await newPost(mini, "Notification fixture discussion");
    const alternate = await newPost(
      otherCourse,
      "Separate subject for the unread count",
    );
    const commentPath = (id: string) =>
      `/api/community/discussions/${id}/comments`;

    async function sendReply(
      postId: string,
      data: { body: string; replyId: string },
      expected = 201,
      session = peer.request,
    ) {
      const response = await session.post(commentPath(postId), {
        headers: csrf,
        data,
      });
      expect(response.status(), await response.text()).toBe(expected);
      return response.json();
    }

    const sent: { body: string; replyId: string }[] = [];
    await peerPage.route(`**${commentPath(post)}`, async (route) => {
      sent.push(route.request().postDataJSON());
      if (sent.length === 1) {
        const committed = await route.fetch();
        expect(committed.status(), await committed.text()).toBe(201);
        await route.abort();
      } else await route.continue();
    });
    await peerPage.goto(`/community/discussions/${post}`);
    await peerPage.getByLabel("Reply", { exact: true }).fill(replyText);
    await peerPage.getByRole("button", { name: "Post reply" }).click();
    await expect(
      peerPage.getByText("Failed to fetch", { exact: true }),
    ).toBeVisible();
    await expect(peerPage.getByLabel("Reply", { exact: true })).toHaveValue(
      replyText,
    );
    await peerPage.getByRole("button", { name: "Post reply" }).click();
    await expect(
      peerPage.getByText("Changes saved.", { exact: true }),
    ).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    await expect(peerPage.getByText(replyText, { exact: true })).toHaveCount(1);
    const first = sent[0]!;
    await sendReply(post, { ...first, body: "Conflicting payload" }, 409);
    expect(
      (
        await peer.request.patch(`/api/community/content/${first.replyId}`, {
          headers: csrf,
          data: { body: "Edited reply" },
        })
      ).status(),
    ).toBe(200);
    expect(await sendReply(post, first)).toEqual({ id: first.replyId });
    await sendReply(
      post,
      { replyId: randomUUID(), body: "My own reply" },
      201,
      page.request,
    );
    expect(
      (
        await communityDb.query(
          "select count(*)::int as count from community_notifications where recipient_id=$1 and kind='reply'",
          [authorId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(await list(peer.request, inboxPath + "/unread")).toEqual({
      unreadCount: 0,
    });

    await page.goto("/community");
    await page
      .getByRole("link", { name: "Notifications (1)", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Someone replied to your discussion.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("1 unread", { exact: true })).toBeVisible();
    const replyNotice = (await list(page.request)).notifications[0];
    expect(replyNotice).toMatchObject({
      kind: "reply",
      action: null,
      postId: post,
      read: false,
    });
    expect(JSON.stringify(replyNotice)).not.toContain(replyText);
    expect(await list(outsider.request)).toEqual({
      notifications: [],
      unreadCount: 0,
      next: null,
    });
    await write(
      outsider.request,
      readPath(replyNotice.id),
      { read: true },
      404,
    );
    expect(
      (
        await outsider.request.get(inboxPath + "?after=" + replyNotice.id)
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.put(readPath(replyNotice.id), {
          headers: { ...csrf, origin: "https://different.invalid" },
          data: { read: true },
        })
      ).status(),
    ).toBe(403);

    await page
      .getByRole("button", { name: "Mark as read", exact: true })
      .click();
    await expect(page.getByText("0 unread", { exact: true })).toBeVisible();
    const readAt = async () =>
      (
        await communityDb.query(
          "select read_at from community_notifications where id=$1",
          [replyNotice.id],
        )
      ).rows[0].read_at;
    const originalRead = await readAt();
    expect(originalRead).toBeInstanceOf(Date);
    await write(page.request, readPath(replyNotice.id), { read: true });
    expect(await readAt()).toEqual(originalRead);
    await page
      .getByRole("button", { name: "Mark as unread", exact: true })
      .click();
    await expect(page.getByText("1 unread", { exact: true })).toBeVisible();
    expect(await readAt()).toBeNull();

    await page.getByLabel("Replies to my discussions").uncheck();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(
      page.getByText("Preferences saved.", { exact: true }),
    ).toBeVisible();
    expect(await list(page.request, preferencePath)).toEqual({
      replies: false,
      moderation: true,
    });
    const suppressed = {
      replyId: randomUUID(),
      body: "Reply while preferences are off",
    };
    await sendReply(post, suppressed);
    expect((await list(page.request)).unreadCount).toBe(1);
    await page.getByLabel("Replies to my discussions").check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(
      page.getByText("Preferences saved.", { exact: true }),
    ).toBeVisible();
    await sendReply(post, suppressed);
    expect((await list(page.request)).unreadCount).toBe(1);

    const report = await peer.request.post(
      `/api/community/content/${post}/reports`,
      {
        headers: csrf,
        data: { reason: "Private report for notification isolation" },
      },
    );
    expect(report.status()).toBe(201);
    const reportId = (await report.json()).id;
    async function moderate(
      action: string,
      actionId = randomUUID(),
      expected = 200,
      reason = "Private moderation reason",
    ) {
      const response = await staff.request.post(adminApi + "/actions", {
        headers: csrf,
        data: { reportId, action, actionId, reason },
      });
      expect(response.status(), await response.text()).toBe(expected);
      return response.json();
    }

    const hide = await moderate("hide");
    expect(await moderate("hide", hide.id)).toEqual(hide);
    await moderate("hide", hide.id, 409, "Different payload");
    await moderate("hide"); // The independent no-op action still must not send a second notice.
    const hidden = await list(page.request);
    expect(hidden.unreadCount).toBe(1);
    expect(hidden.notifications).toHaveLength(1);
    const moderation = hidden.notifications[0];
    expect(moderation).toMatchObject({
      kind: "moderation",
      action: "hide",
      postId: null,
      read: false,
    });
    expect(JSON.stringify(moderation)).not.toContain(
      "Private moderation reason",
    );
    expect((await list(peer.request)).notifications).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByText("A moderator hid your message.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open discussion" }),
    ).toHaveCount(0);

    await page.getByLabel("Moderation updates").uncheck();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(
      page.getByText("Preferences saved.", { exact: true }),
    ).toBeVisible();
    expect(await list(page.request, preferencePath)).toEqual({
      replies: true,
      moderation: false,
    });
    const restore = await moderate("restore");
    await write(page.request, preferencePath, {
      replies: true,
      moderation: true,
    });
    await moderate("restore", restore.id);
    expect(
      (await list(page.request)).notifications.map(
        (entry: { action: string | null }) => entry.action,
      ),
    ).toEqual(["hide", null]);

    const resolved = await moderate("resolve");
    await moderate("resolve", resolved.id);
    expect((await list(peer.request)).notifications).toEqual([
      expect.objectContaining({
        kind: "moderation",
        action: "resolve",
        postId: post,
        read: false,
      }),
    ]);
    expect(
      (
        await communityDb.query(
          "select count(*)::int as count from community_notifications where recipient_id=$1 and kind='moderation'",
          [peerId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    await sendReply(alternate, {
      replyId: randomUUID(),
      body: "Reply in the other course",
    });
    expect(await list(page.request, inboxPath + "/unread")).toEqual({
      unreadCount: 3,
    });
    await request.put(authorityFixture + "/fixture/offline");
    for (const path of [inboxPath, inboxPath + "/unread"])
      expect((await page.request.get(path)).status()).toBe(503);
    await request.put(authorityFixture + "/fixture/online");

    const [grant] = (
      await courseDb.query(
        "select id from entitlement_grants where user_id=$1 and course_id=$2 and status='active'",
        [authorId, mini],
      )
    ).rows;
    const idempotencyKey = "community-inbox-" + randomUUID();
    const revoked = await request.post(
      courseOrigin + "/v1/admin/entitlements/revocations",
      {
        headers: {
          authorization: "Bearer " + token("course-support", moderatorId),
          "x-idempotency-key": idempotencyKey,
        },
        data: {
          scope: "grantId",
          grantId: grant.id,
          reason: "Fixture inbox revocation",
          idempotencyKey,
        },
      },
    );
    expect(revoked.status()).toBe(200);
    expect(
      (
        await communityDb.query(
          "select state from course_enrollment_projections where user_id=$1 and course_id=$2",
          [authorId, mini],
        )
      ).rows,
    ).toEqual([{ state: "active" }]);
    expect(await list(page.request, inboxPath + "/unread")).toEqual({
      unreadCount: 1,
    });
    const remaining = (await list(page.request)).notifications;
    expect(remaining).toEqual([
      expect.objectContaining({
        postId: alternate,
        kind: "reply",
        read: false,
      }),
    ]);
    await write(page.request, readPath(replyNotice.id), { read: true }, 404);
    // Put all 21 visible notices at the same stored timestamp to exercise the ID tie-break across pages.
    const seeded = await communityDb.query(
      `insert into community_notifications (recipient_id,course_id,post_id,kind,event_id,action,created_at)
       select $1,$2,$3,'moderation',gen_random_uuid(),'lock',source.created_at
       from community_notifications source cross join generate_series(1,20)
       where source.id=$4`,
      [authorId, otherCourse, alternate, remaining[0].id],
    );
    expect(seeded.rowCount).toBe(20);
    const { rows: expected } = await communityDb.query<{ id: string }>(
      `select id from community_notifications where recipient_id=$1 and course_id=$2
       order by created_at desc, id desc`,
      [authorId, otherCourse],
    );
    expect(expected).toHaveLength(21);
    const firstPage = await list(page.request);
    expect(firstPage.notifications).toHaveLength(20);
    expect(firstPage.notifications.map(({ id }: { id: string }) => id)).toEqual(
      expected.slice(0, 20).map(({ id }) => id),
    );
    expect(firstPage.unreadCount).toBe(21);
    expect(typeof firstPage.next).toBe("string");
    const lastPage = await list(
      page.request,
      inboxPath + "?after=" + firstPage.next,
    );
    expect(lastPage.notifications).toHaveLength(1);
    expect(lastPage.unreadCount).toBe(21);
    expect(lastPage.next).toBeNull();
    const lastId = lastPage.notifications[0].id;
    expect(
      firstPage.notifications.map(({ id }: { id: string }) => id),
    ).not.toContain(lastId);
    expect(lastId).toBe(expected[20].id);

    await page.goto("/community/notifications");
    await expect(
      page.getByRole("heading", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("21 unread", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "First page", exact: true }),
    ).toBeVisible();
    const markRead = page.getByRole("button", {
      name: "Mark as read",
      exact: true,
    });
    await expect(markRead).toHaveCount(1);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === readPath(lastId),
    );
    await markRead.click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("20 unread", { exact: true })).toBeVisible();
    expect(await list(page.request, inboxPath + "/unread")).toEqual({
      unreadCount: 20,
    });
  } finally {
    await request.put(authorityFixture + "/fixture/online");
    await Promise.all([
      peer.close(),
      outsider.close(),
      staff.close(),
      frontendDb.end(),
      courseDb.end(),
      communityDb.end(),
    ]);
  }
});

test("Community member profiles are visible only in a shared course and disappear on live revocation", async ({
  page,
  context,
  browser,
  request,
}) => {
  const frontendDb = new Pool({ connectionString: databaseUrl("frontend") });
  const courseDb = new Pool({ connectionString: databaseUrl("course") });
  const communityDb = new Pool({ connectionString: databaseUrl("community") });
  const target = await browser.newContext({ baseURL: origin });
  const other = await browser.newContext({ baseURL: origin });
  const staff = await browser.newContext({ baseURL: origin });
  const api = (courseId: string) => `/api/community/spaces/${courseId}/members`;
  const directory = (courseId: string) =>
    `/community/courses/${courseId}/members`;
  const miniSearch = api(mini) + "?search=Lina";
  const displayName = "Lina Profile Fixture";
  const newName = "Lina Updated Fixture";
  const otherName = `Other room profile fixture ${randomUUID().slice(0, 8)}`;

  async function privateGet(
    session: APIRequestContext,
    path: string,
    status = 200,
  ) {
    const response = await session.get(path);
    expect(response.status(), await response.text()).toBe(status);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    return response.json();
  }

  try {
    await customer(frontendDb, context);
    const targetId = await customer(frontendDb, target);
    await customer(frontendDb, other);
    const moderatorId = await administrator(frontendDb, staff, "owner");
    const targetPage = await target.newPage();
    await Promise.all([setupPage(page), setupPage(targetPage)]);
    await frontendDb.query("update customer_users set name=$2 where id=$1", [
      targetId,
      "Private fixture sign-in name",
    ]);
    const targetEmail = `${targetId}@community-fixture.invalid`;
    const miniTitle = "Free Mini Course members fixture";
    const otherTitle = "Other course members fixture";

    await privateGet(request, "/api/community/profile", 401);
    await privateGet(request, api(mini), 401);
    for (const [courseId, title] of [
      [mini, miniTitle],
      [otherCourse, otherTitle],
    ]) {
      const saved = await staff.request.put(`${adminApi}/spaces/${courseId}`, {
        headers: csrf,
        data: { title, enabled: true },
      });
      expect(saved.status()).toBe(200);
      expect((await enroll(page.request, courseId)).status()).toBe(200);
    }
    expect((await enroll(target.request, mini)).status()).toBe(200);
    expect((await enroll(other.request, otherCourse)).status()).toBe(200);
    expect(await privateGet(target.request, "/api/community/profile")).toEqual({
      profile: null,
    });
    expect(await privateGet(page.request, "/api/community/profile")).toEqual({
      profile: null,
    });

    await targetPage.goto("/community");
    await targetPage.getByLabel("Community display name").fill(displayName);
    await targetPage.getByRole("button", { name: "Save display name" }).click();
    await expect(
      targetPage.getByText("Changes saved.", { exact: true }),
    ).toBeVisible();
    expect(await privateGet(target.request, "/api/community/profile")).toEqual({
      profile: { displayName },
    });
    await targetPage.reload();
    await expect(targetPage.getByLabel("Community display name")).toHaveValue(
      displayName,
    );
    expect(
      (
        await other.request.put("/api/community/profile", {
          headers: csrf,
          data: { displayName: otherName },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await other.request.put("/api/community/profile", {
          headers: csrf,
          data: { displayName: "Spoofed name", userId: targetId },
        })
      ).status(),
    ).toBe(400);

    // A saved profile has no directory entry until its enrollment projection arrives.
    expect(await privateGet(page.request, miniSearch)).toEqual({
      space: { title: miniTitle, courseId: mini },
      members: [],
      next: null,
    });
    await deliverEnrollmentEvents();
    const shared = await privateGet(page.request, miniSearch);
    expect(shared).toEqual({
      space: { title: miniTitle, courseId: mini },
      members: [{ id: expect.any(String), displayName }],
      next: null,
    });
    const memberId: string = shared.members[0].id;
    expect(memberId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(memberId).not.toBe(targetId);
    expect(JSON.stringify(shared)).not.toContain(targetEmail);
    expect(JSON.stringify(shared)).not.toContain(
      "Private fixture sign-in name",
    );
    const profileApi = `${api(mini)}/${memberId}`;
    const expected = {
      space: { title: miniTitle, courseId: mini },
      member: { id: memberId, displayName },
    };
    expect(await privateGet(page.request, profileApi)).toEqual(expected);
    await privateGet(page.request, `${api(otherCourse)}/${memberId}`, 404);
    await privateGet(page.request, `${api(mini)}/${targetId}`, 404);
    await privateGet(other.request, profileApi, 403);
    const otherSpace = await privateGet(page.request, api(otherCourse));
    const otherMatching = await privateGet(
      page.request,
      `${api(otherCourse)}?search=${encodeURIComponent(otherName)}`,
    );
    expect(otherMatching.members).toEqual([
      { id: expect.any(String), displayName: otherName },
    ]);
    expect(
      (await privateGet(page.request, `${api(otherCourse)}?search=Lina`))
        .members,
    ).toEqual([]);
    await privateGet(
      target.request,
      `${api(otherCourse)}/${otherMatching.members[0].id}`,
      403,
    );

    // Force one whole candidate batch to fail live authority before the allowed member.
    const stale = await communityDb.query<{ user_id: string }>(
      `with old_profiles as (
        insert into community_profiles (user_id,id,display_name)
        select gen_random_uuid(), ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid, 'Lina stale member ' || i
        from generate_series(1,12) i returning user_id
      )
      insert into course_enrollment_projections
        (stream_id,user_id,course_id,state,applied_version,highest_observed_version,status,source,effective_at)
      select gen_random_uuid(),user_id,$1,'active',1,1,'current','event',now() from old_profiles returning user_id`,
      [mini],
    );
    try {
      expect(await privateGet(page.request, miniSearch)).toEqual(shared);
    } finally {
      const ids = stale.rows.map(({ user_id }) => user_id);
      await communityDb.query(
        "delete from course_enrollment_projections where user_id=any($1::uuid[])",
        [ids],
      );
      await communityDb.query(
        "delete from community_profiles where user_id=any($1::uuid[])",
        [ids],
      );
    }

    await page.goto(`/community/courses/${mini}`);
    await page.getByRole("link", { name: "Members", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Search members by name").fill("other room");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByText("No matching members.", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Search members by name").fill("lINA");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const found = page.getByRole("link", { name: displayName, exact: true });
    await expect(found).toBeVisible();
    await expect(found).toHaveAttribute(
      "href",
      directory(mini) + "/" + memberId,
    );
    await found.click();
    await expect(
      page.getByRole("heading", { name: displayName, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(targetEmail, { exact: false })).toHaveCount(0);

    await targetPage.getByLabel("Community display name").fill(newName);
    await targetPage.getByRole("button", { name: "Save display name" }).click();
    await expect(
      targetPage.getByText("Changes saved.", { exact: true }),
    ).toBeVisible();
    expect(await privateGet(page.request, profileApi)).toEqual({
      ...expected,
      member: { id: memberId, displayName: newName },
    });
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("heading", { name: newName, exact: true }),
    ).toBeVisible();

    await request.put(authorityFixture + "/fixture/offline");
    await privateGet(page.request, profileApi, 503);
    await privateGet(page.request, api(mini), 503);
    await request.put(authorityFixture + "/fixture/online");

    const [grant] = (
      await courseDb.query(
        "select id from entitlement_grants where user_id=$1 and course_id=$2 and status='active'",
        [targetId, mini],
      )
    ).rows;
    const key = "community-members-" + randomUUID();
    const revoked = await request.post(
      courseOrigin + "/v1/admin/entitlements/revocations",
      {
        headers: {
          authorization: "Bearer " + token("course-support", moderatorId),
          "x-idempotency-key": key,
        },
        data: {
          scope: "grantId",
          grantId: grant.id,
          reason: "Isolated member profile revocation",
          idempotencyKey: key,
        },
      },
    );
    expect(revoked.status()).toBe(200);
    expect(
      (
        await communityDb.query(
          "select state from course_enrollment_projections where user_id=$1 and course_id=$2",
          [targetId, mini],
        )
      ).rows,
    ).toEqual([{ state: "active" }]);
    expect((await privateGet(page.request, miniSearch)).members).toEqual([]);
    await privateGet(page.request, profileApi, 404);
    await privateGet(target.request, api(mini), 403);
    expect(await privateGet(target.request, "/api/community/profile")).toEqual({
      profile: { displayName: newName },
    });
    expect(await privateGet(page.request, api(otherCourse))).toEqual(
      otherSpace,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByText("This resource is unavailable.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: newName, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Members", exact: true }).click();
    await page.getByLabel("Search members by name").fill("Lina");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByText("No matching members.", { exact: true }),
    ).toBeVisible();
  } finally {
    await request.put(authorityFixture + "/fixture/online");
    await Promise.all([
      target.close(),
      other.close(),
      staff.close(),
      frontendDb.end(),
      courseDb.end(),
      communityDb.end(),
    ]);
  }
});

test("Community mobile learner and moderator journeys support keyboard access", async ({
  browser,
}) => {
  const frontendDb = new Pool({ connectionString: databaseUrl("frontend") });
  const mobile = { ...devices["Pixel 7"], baseURL: origin };
  const learner = await browser.newContext(mobile);
  const staff = await browser.newContext(mobile);
  const employee = await browser.newContext(mobile);
  const peer = await browser.newContext({ baseURL: origin });

  async function tabTo(page: Page, target: Locator) {
    await expect(target).toBeVisible();
    for (let step = 0; step < 70; step += 1) {
      if (
        await target.evaluate(
          (node) => node === node.ownerDocument.activeElement,
        )
      ) {
        return;
      }
      await page.keyboard.press("Tab");
    }
    await expect(target).toBeFocused();
  }

  async function fitViewport(page: Page) {
    const width = page.viewportSize()?.width;
    await expect
      .poll(() =>
        page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          overflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        })),
      )
      .toEqual({ width, overflow: 0 });
  }

  const title = "Keyboard course discussions";
  const peerName = "P5-06 keyboard peer " + randomUUID().slice(0, 8);
  const message = "Keyboard discussion " + randomUUID();
  const reason = "Keyboard moderation report " + randomUUID();
  const course = "/community/courses/" + mini;
  try {
    const page = await learner.newPage();
    const mod = await staff.newPage();
    const denied = await employee.newPage();
    const duplicateKeys: string[] = [];
    page.on("console", (entry) => {
      if (entry.text().includes("two children with the same key")) {
        duplicateKeys.push(entry.text());
      }
    });
    await Promise.all([setupPage(page), setupPage(mod), setupPage(denied)]);
    await administrator(frontendDb, staff, "owner");
    await administrator(frontendDb, employee, "employee");
    const moderatorCsrf = await staff.request.post(adminApi + "/actions", {
      headers: { ...csrf, origin: "https://foreign.invalid" },
      data: {
        actionId: randomUUID(),
        reportId: randomUUID(),
        action: "hide",
        reason: "Cross-origin synthetic moderation attempt",
      },
    });
    expect(moderatorCsrf.status()).toBe(403);
    expect(moderatorCsrf.headers()["cache-control"]).toBe("private, no-store");

    await page.goto("/community");
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/sign-in" &&
        url.searchParams.get("callbackUrl") === "/community",
    );
    const anonymous = await learner.request.get("/api/community/spaces");
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()["cache-control"]).toBe("private, no-store");
    await denied.goto("/admin/community");
    await expect(
      denied.getByRole("heading", { name: "Community moderation" }),
    ).toHaveCount(0);
    const forbidden = await employee.request.get(adminApi + "/reports");
    expect(forbidden.status()).toBe(403);
    expect(forbidden.headers()["cache-control"]).toBe("private, no-store");

    await customer(frontendDb, learner);
    await customer(frontendDb, peer);
    const space = await staff.request.put(adminApi + "/spaces/" + mini, {
      headers: csrf,
      data: { title, enabled: true },
    });
    expect(space.status()).toBe(200);
    expect((await enroll(learner.request, mini)).status()).toBe(200);
    expect((await enroll(peer.request, mini)).status()).toBe(200);
    expect(
      (
        await peer.request.put("/api/community/profile", {
          headers: csrf,
          data: { displayName: peerName },
        })
      ).status(),
    ).toBe(200);
    await deliverEnrollmentEvents();

    await page.goto("/community");
    const courseLink = page.getByRole("link", { name: title });
    await tabTo(page, courseLink);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(origin + course);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await fitViewport(page);

    const noCsrf = await learner.request.post(feed(mini), {
      headers: { origin },
      data: { body: message },
    });
    expect(noCsrf.status()).toBe(403);
    expect(noCsrf.headers()["cache-control"]).toBe("private, no-store");
    await tabTo(page, page.getByLabel("New discussion"));
    await page.keyboard.type(message);
    await tabTo(page, page.getByRole("button", { name: "Post discussion" }));
    const posted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === feed(mini) &&
        response.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    const created = await posted;
    expect(created.status()).toBe(201);
    expect(created.headers()["cache-control"]).toBe("private, no-store");
    const { id } = await created.json();
    await tabTo(
      page,
      page.getByRole("link", { name: "Open posted discussion" }),
    );
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Replies" })).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(message, { exact: true })).toBeVisible();

    await test.step("reject a malformed upstream response", async (step) => {
      step.skip(
        process.env.COMMUNITY_E2E_INVALID_RESPONSE !== "1",
        "Requires the scratch gateway fault injection",
      );
      await page.goto(course);
      await tabTo(
        page,
        page.getByRole("searchbox", { name: "Search discussions" }),
      );
      await page.keyboard.type("p5-06-invalid-response");
      const failed = page.waitForResponse((response) =>
        response.url().endsWith(feed(mini) + "?search=p5-06-invalid-response"),
      );
      await page.keyboard.press("Enter");
      const invalid = await failed;
      expect(invalid.status()).toBe(503);
      expect(invalid.headers()["cache-control"]).toBe("private, no-store");
      expect(await invalid.text()).not.toContain(
        "Must not render upstream payload",
      );
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "The service is temporarily unavailable." }),
      ).toBeVisible();
      await expect(page.getByText(message, { exact: true })).toHaveCount(0);
      await page.goto(`/community/discussions/${id}`);
    });

    await expect(page.getByRole("heading", { name: "Replies" })).toBeVisible();
    if (process.env.COMMUNITY_MEDIA_E2E === "1") {
      await expect(page.getByLabel("Add images")).toBeVisible();
    }
    expect(duplicateKeys).toEqual([]);
    await tabTo(page, page.getByRole("link", { name: "Back to discussions" }));
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("link", { name: "Members", exact: true }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await fitViewport(page);
    await tabTo(
      page,
      page.getByRole("searchbox", { name: "Search members by name" }),
    );
    await page.keyboard.type(peerName);
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("link", { name: peerName }));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: peerName })).toBeVisible();
    await fitViewport(page);

    await page.goto("/community");
    await tabTo(page, page.getByRole("link", { name: /^Notifications/u }));
    await page.keyboard.press("Enter");
    const preference = page.getByRole("checkbox", {
      name: "Replies to my discussions",
    });
    await tabTo(page, preference);
    await expect(preference).toBeChecked();
    await page.keyboard.press("Space");
    await expect(preference).not.toBeChecked();
    await tabTo(page, page.getByRole("button", { name: "Save preferences" }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({ hasText: "Preferences saved." }),
    ).toBeVisible();
    await fitViewport(page);

    const report = await peer.request.post(
      "/api/community/content/" + id + "/reports",
      {
        headers: csrf,
        data: { reason },
      },
    );
    expect(report.status()).toBe(201);
    await mod.goto("/admin/community");
    await expect(
      mod.getByRole("heading", { name: "Community moderation" }),
    ).toBeVisible();
    const article = mod.getByRole("article").filter({ hasText: reason });
    const action = article.getByLabel("Action");
    await tabTo(mod, action);
    await expect(action).toHaveValue("hide");
    await tabTo(mod, article.getByLabel("Moderation reason"));
    await mod.keyboard.type("Hide a synthetic discussion by keyboard");
    await tabTo(mod, article.getByRole("button", { name: "Apply action" }));
    await mod.keyboard.press("Enter");
    await expect(
      mod
        .getByRole("status")
        .filter({ hasText: "Moderation action recorded." }),
    ).toBeVisible();
    await expect(
      action.getByRole("option", { name: "Restore content" }),
    ).toHaveCount(1);
    await fitViewport(mod);

    await page.goto("/community/discussions/" + id);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "This resource is unavailable." }),
    ).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toHaveCount(0);
    await tabTo(mod, action);
    await mod.keyboard.press("Home");
    await expect(action).toHaveValue("restore");
    await tabTo(mod, article.getByLabel("Moderation reason"));
    await mod.keyboard.type("Restore the synthetic discussion by keyboard");
    await tabTo(mod, article.getByRole("button", { name: "Apply action" }));
    const restored = mod.waitForResponse(
      (response) =>
        response.url().endsWith(adminApi + "/actions") &&
        response.request().method() === "POST",
    );
    await mod.keyboard.press("Enter");
    expect((await restored).status()).toBe(200);
    await page.reload();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await fitViewport(page);
  } finally {
    await Promise.all([
      learner.close(),
      staff.close(),
      employee.close(),
      peer.close(),
      frontendDb.end(),
    ]);
  }
});
