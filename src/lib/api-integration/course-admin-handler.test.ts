import assert from "node:assert/strict";
import test from "node:test";
import { createCourseAdminHandler } from "./course-admin-handler";
import { createCourseClient } from "./course-client";
import { createAdminAuth } from "@/lib/admin/auth-service";
import type { AdminActor } from "@/lib/admin/types";
import { markWriterOperationUncertain, withWriterOperationContext, type WriterAuthoringOperation } from "@/lib/writer-admission/context";
import { IntegrationServiceError } from "./service-errors";

const id = "11111111-1111-4111-8111-111111111111";
const origin = "https://site.example.invalid";
const actor: AdminActor = { bookingProviderResourceIds: [], bookingResourceIds: [], user: { id, email: "owner@example.invalid", emailNormalized: "owner@example.invalid", displayName: null, providerUserId: "provider-sub", role: "owner", status: "active" } };
const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(origin + path, { method, headers: { origin, "content-type": "application/json", "x-lash-csrf": "1", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("admin boundaries require configured origin/CSRF before invoking staff authentication or mutation", async () => {
  let calls = 0;
  const handler = createCourseAdminHandler("update-course", { enabled: () => true, client: () => { calls++; return {} as never; }, origin: () => origin });
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { origin: "https://attacker.invalid" }), { courseId: id })).status, 403);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { "x-lash-csrf": "" }), { courseId: id })).status, 403);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { "sec-fetch-site": "cross-site" }), { courseId: id })).status, 403);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { "content-length": "1048577" }), { courseId: id })).status, 413);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}), { courseId: "not-an-id" })).status, 400);
  assert.equal(calls, 0);
});

test("scoped authoring refuses non-drafts before invoking the authenticated Course client", async () => {
  const path = "/api/admin/courses", statuses: unknown[] = [];
  const makeHandler = (authoringActorId?: string) => createCourseAdminHandler("create-course", {
    enabled: () => true, origin: () => origin,
    run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, authoringActorId),
    client: () => ({ async createCourse(input: { status: unknown }) { statuses.push(input.status); return {}; } }) as never,
  });
  const scoped = makeHandler(id);
  for (const body of [{ status: "published" }, {}, null, []]) assert.equal((await scoped(req(path, "POST", body))).status, 400);
  assert.deepEqual(statuses, []);
  assert.equal((await scoped(req(path, "POST", { status: "draft" }))).status, 200);
  assert.equal((await makeHandler()(req(path, "POST", { status: "published" }))).status, 200);
  assert.deepEqual(statuses, ["draft", "published"]);
});

test("scoped draft edits require a positive revision and reject any publication status", async () => {
  const path = `/api/admin/courses/${id}`, updates: unknown[] = [];
  const makeHandler = (authoringActorId?: string) => createCourseAdminHandler("update-course", {
    enabled: () => true, origin: () => origin,
    run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, authoringActorId,
      authoringActorId ? "edit-draft" : undefined),
    client: () => ({ async updateCourse(courseId: string, input: unknown) { assert.equal(courseId, id); updates.push(input); return {}; } }) as never,
  });
  const scoped = makeHandler(id);
  const details = { title: "Revised draft", expectedRevision: 3 };
  for (const body of [null, {}, [], { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: "3" },
    { ...details, status: "draft" }, { ...details, status: "published" }, { ...details, status: "archived" }, { ...details, status: null }]) {
    assert.equal((await scoped(req(path, "PATCH", body), { courseId: id })).status, 400);
  }
  assert.deepEqual(updates, []);
  assert.equal((await scoped(req(path, "PATCH", details), { courseId: id })).status, 200);
  const ordinaryStatusChange = { expectedRevision: 4, status: "published" };
  assert.equal((await makeHandler()(req(path, "PATCH", ordinaryStatusChange), { courseId: id })).status, 200);
  assert.deepEqual(updates, [details, ordinaryStatusChange]);
});

test("scoped publication forwards only a revisioned publish and refuses writes under readiness scope", async () => {
  const path = `/api/admin/courses/${id}`, updates: unknown[] = [];
  const handler = (scope: WriterAuthoringOperation) => createCourseAdminHandler("update-course", {
    enabled: () => true, origin: () => origin,
    run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, id, scope),
    client: () => ({ async updateCourse(courseId: string, input: unknown) { assert.equal(courseId, id); updates.push(input); return {}; } }) as never,
  });
  const publish = { expectedRevision: 3, status: "published" };
  const scoped = handler("publish-course");
  for (const body of [null, {}, { expectedRevision: 3 }, { status: "published" }, { ...publish, expectedRevision: 0 },
    { ...publish, expectedRevision: 2_147_483_648 }, { ...publish, expectedRevision: 1.5 }, { ...publish, expectedRevision: "3" },
    { ...publish, status: "draft" }, { ...publish, status: "archived" }, { ...publish, title: "Unexpected change" }]) {
    assert.equal((await scoped(req(path, "PATCH", body), { courseId: id })).status, 400);
  }
  const review = handler("review-publication");
  for (const body of [publish, { expectedRevision: 3, title: "Draft edit" }]) {
    assert.equal((await review(req(path, "PATCH", body), { courseId: id })).status, 400);
  }
  assert.deepEqual(updates, []);
  assert.equal((await scoped(req(path, "PATCH", publish), { courseId: id })).status, 200);
  assert.deepEqual(updates, [publish]);
});

test("scoped paid archive accepts only the revisioned status change from the reviewed owner", async () => {
  const path = `/api/admin/courses/${id}`;
  const archive = { expectedRevision: 3, status: "archived" };
  let sessionOwner = { ...actor.user, id: "8e2280dc-0389-4248-b21c-f87427f9e85c" };
  let identityRefreshes = 0;
  const writes: string[] = [];
  const auth = createAdminAuth({
    getIdentity: async () => ({ displayName: null, email: sessionOwner.email, emailVerified: true, providerUserId: sessionOwner.providerUserId }),
    getOwnerEmails: () => new Set(),
    userStore: {
      async findByEmailNormalized() { return sessionOwner; },
      async findByProviderUserId() { return sessionOwner; },
      async recordSignIn() { identityRefreshes++; return sessionOwner; },
      async bindIdentity() { assert.fail("archive scope cannot bind an identity"); },
      async createBootstrapOwner() { assert.fail("archive scope cannot bootstrap an owner"); },
      async listBookingProviderResourceIds() { return []; },
      async listBookingResourceIds() { return []; },
    },
  });
  const client = createCourseClient({ enabled: () => true, getAdmin: auth.requirePermission, mintToken: () => "owner.jwt",
    invalidateCatalog: () => {}, getTransport: () => async request => {
      assert.equal(request.method, "PATCH");
      assert.equal(request.path, `/v1/admin/courses/${id}`);
      writes.push(request.body!);
      return Response.json({ course: { id, title: "Paid course", slug: "paid-course", description: null, status: "archived", accessMode: "paid",
        priceCents: 100, currency: "CAD", revision: 4, modules: [], introduction: null, cover: null, seo: null, taxClassification: "reviewed" } });
    } });
  const handler = createCourseAdminHandler("update-course", { enabled: () => true, origin: () => origin, client: () => client,
    run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, id, "archive-paid-course") });
  for (const body of [null, {}, { expectedRevision: 3 }, { status: "archived" }, { ...archive, expectedRevision: 0 },
    { ...archive, expectedRevision: 1.5 }, { ...archive, expectedRevision: 2_147_483_648 }, { ...archive, expectedRevision: "3" },
    { ...archive, status: "draft" }, { ...archive, status: "published" }, { ...archive, title: "Unreviewed change" }]) {
    assert.equal((await handler(req(path, "PATCH", body), { courseId: id })).status, 400);
  }
  assert.equal((await handler(req(path, "PATCH", archive), { courseId: id })).status, 403);
  assert.equal(identityRefreshes, 0);
  assert.deepEqual(writes, []);
  sessionOwner = actor.user;
  assert.equal((await handler(req(path, "PATCH", archive), { courseId: id })).status, 200);
  assert.equal(identityRefreshes, 1);
  assert.deepEqual(writes, [JSON.stringify(archive)]);
});

test("scoped curriculum reorders accept only a revision and unique canonical IDs before client calls", async () => {
  const other = "8e2280dc-0389-4248-b21c-f87427f9e85c";
  const valid = { expectedCourseRevision: 3, ids: [other, id] };
  for (const [operation, method, path, params] of [
    ["reorder-modules", "reorderModules", `/api/admin/courses/${id}/modules/reorder`, { courseId: id }],
    ["reorder-lessons", "reorderLessons", `/api/admin/modules/${id}/lessons/reorder`, { moduleId: id }],
  ] as const) {
    const calls: unknown[] = [];
    const handler = createCourseAdminHandler(operation, {
      enabled: () => true, origin: () => origin,
      run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, id),
      client: () => ({ async [method](parent: string, input: unknown) { assert.equal(parent, id); calls.push(input); return {}; } }) as never,
    });
    for (const body of [null, { ids: valid.ids }, { ...valid, expectedCourseRevision: 0 }, { ...valid, expectedCourseRevision: 2_147_483_648 },
      { ...valid, ids: [] }, { ...valid, ids: [id] }, { ...valid, ids: [id, id] }, { ...valid, ids: [id, "not-a-uuid"] },
      { ...valid, ids: [id, other.toUpperCase()] }, { ...valid, status: "draft" }]) {
      assert.equal((await handler(req(path, "POST", body), params)).status, 400);
    }
    assert.deepEqual(calls, []);
    assert.equal((await handler(req(path, "POST", valid), params)).status, 200);
    assert.deepEqual(calls, [valid]);
  }
});

test("scoped curriculum creation accepts normal forms with empty or validated v1 lesson content", async () => {
  const fields = { expectedCourseRevision: 3, title: "Scaffold", slug: "scaffold", position: 1 };
  const moduleBody = { ...fields, description: null };
  const lessonBody = { ...fields, contentDocument: { version: 1, blocks: [] }, transcript: null, isPreview: false, captions: [] };
  const block = { _type: "block", _key: "block", style: "normal", listItem: "bullet", level: 1,
    children: [{ _type: "span", _key: "span", text: "Lesson", marks: ["strong", "reference"] }],
    markDefs: [{ _type: "link", _key: "reference", href: "https://owned.invalid/lesson" }] };
  const populatedLesson = { ...lessonBody, contentDocument: { version: 1, blocks: [block] }, transcript: "Lesson transcript", isPreview: true };
  for (const [operation, method, path, params, valid, invalid] of [
    ["create-module", "createModule", `/api/admin/courses/${id}/modules`, { courseId: id }, [moduleBody],
      [null, fields, { ...moduleBody, position: 0 }, { ...moduleBody, archived: false }]],
    ["create-lesson", "createLesson", `/api/admin/modules/${id}/lessons`, { moduleId: id }, [lessonBody, populatedLesson],
      [null, fields, { ...lessonBody, transcript: undefined }, { ...lessonBody, isPreview: undefined },
        { ...lessonBody, content: null }, { ...lessonBody, contentDocument: null }, { ...lessonBody, captions: undefined },
        { ...lessonBody, contentDocument: { version: 2, blocks: [block] } },
        { ...lessonBody, contentDocument: { version: 1, blocks: [{ ...block, children: [] }] } },
        { ...lessonBody, contentDocument: { version: 1, blocks: [{ ...block, markDefs: [{ ...block.markDefs[0], unexpected: true }] }] } },
        { ...lessonBody, captions: [{ language: "en", label: "English", url: "https://owned.invalid/en.vtt" }] }]],
  ] as const) {
    const calls: unknown[] = [];
    const makeHandler = (ownerId?: string) => createCourseAdminHandler(operation, {
      enabled: () => true, origin: () => origin,
      run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, ownerId),
      client: () => ({ async [method](parent: string, input: unknown) { assert.equal(parent, id); calls.push(input); return {}; } }) as never,
    });
    const handler = makeHandler(id);
    for (const body of invalid) assert.equal((await handler(req(path, "POST", body), params)).status, 400);
    assert.deepEqual(calls, []);
    for (const body of valid) assert.equal((await handler(req(path, "POST", body), params)).status, 200);
    assert.equal((await makeHandler()(req(path, "POST", fields), params)).status, 200);
    assert.deepEqual(calls, [...valid, fields]);
  }
});

test("admin paginated reads are private, validated and authorized through the real named client", async () => {
  let calls = 0;
  const client = createCourseClient({ enabled: () => true, getAdmin: async permission => { assert.equal(permission, "courses:edit"); return actor; }, mintToken: () => "server.admin.jwt", getTransport: () => async input => {
    calls++; assert.equal(input.path, "/v1/admin/courses?limit=10"); assert.equal(input.applicationToken, "server.admin.jwt"); return Response.json({ courses: [], nextCursor: null });
  } });
  const handler = createCourseAdminHandler("list-courses", { enabled: () => true, client: () => client });
  const response = await handler(req("/api/admin/courses?limit=10"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await handler(req("/api/admin/courses?limit=101"))).status, 400);
  assert.equal((await handler(req("/api/admin/courses?limit=1&limit=2"))).status, 400);
  assert.equal((await handler(req("/api/admin/courses?userId=" + id))).status, 400);
  assert.equal(calls, 1);
});

test("quiz PUT passes only validated aggregate revision/document and admits one whole mutation", async () => {
  let writes = 0, invalidated = 0;
  const document = { version: 1 as const, mode: "graded" as const, passingPercent: 80, questions: [{ id: "q1", prompt: "Choose", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionId: "a", feedback: "Review the lesson." }] };
  const body = { expectedCourseRevision: 3, document };
  const quiz = { id, lessonId: id, courseRevision: 4, revision: 1, document, createdBy: id, createdAt: new Date().toISOString() };
  const client = createCourseClient({ enabled: () => true, invalidateCatalog: () => { invalidated++; }, getAdmin: async () => actor, mintToken: () => "server.admin.jwt", run: async (kind, work) => { assert.equal(kind, "new-work"); writes++; return work(); }, getTransport: () => async input => {
    assert.equal(input.method, "PUT"); assert.equal(input.path, `/v1/admin/lessons/${id}/quiz`); assert.deepEqual(JSON.parse(input.body!), body); return Response.json({ quiz });
  } });
  const handler = createCourseAdminHandler("update-quiz", { enabled: () => true, run: async (_kind, work) => { writes++; return work(); }, client: () => client, origin: () => origin });
  assert.equal((await handler(req(`/api/admin/lessons/${id}/quiz`, "PUT", body), { lessonId: id })).status, 200);
  assert.equal(writes, 1); assert.equal(invalidated, 1);
  assert.equal((await handler(req(`/api/admin/lessons/${id}/quiz`, "PUT", { ...body, userId: id }), { lessonId: id })).status, 400);
  assert.equal(writes, 2); assert.equal(invalidated, 1);
});

test("scoped quiz saves require an explicit candidate quiz document and bounded course revision", async () => {
  const path = `/api/admin/lessons/${id}/quiz`, calls: unknown[] = [];
  const document = { version: 1, mode: "graded", passingPercent: 80,
    questions: [{ id: "q1", prompt: "Choose", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionId: "a", feedback: "Review." }] };
  const body = { expectedCourseRevision: 3, document };
  const makeHandler = (scope?: WriterAuthoringOperation) => createCourseAdminHandler("update-quiz", {
    enabled: () => true, origin: () => origin,
    run: (_kind, work) => withWriterOperationContext(work, undefined, undefined, undefined, undefined, scope ? id : undefined, scope),
    client: () => ({ async updateQuiz(lessonId: string, input: unknown) { assert.equal(lessonId, id); calls.push(input); return {}; } }) as never,
  });
  const scoped = makeHandler("save-quiz-revision");
  const withoutMode = { ...body, document: { ...document, mode: undefined } };
  for (const invalid of [null, { document }, { ...body, expectedCourseRevision: 0 }, { ...body, expectedCourseRevision: 1.5 },
    { ...body, expectedCourseRevision: 2_147_483_648 }, { ...body, expectedCourseRevision: "3" }, withoutMode,
    { ...body, document: { ...document, passingPercent: undefined } }, { ...body, document: { ...document, passingPercent: 101 } },
    { ...body, document: { ...document, mode: "unknown" } }, { ...body, document: { ...document, questions: [] } },
    { ...body, document: { ...document, questions: [{ ...document.questions[0], feedback: "" }] } }, { ...body, userId: id }]) {
    assert.equal((await scoped(req(path, "PUT", invalid), { lessonId: id })).status, 400);
  }
  assert.equal((await makeHandler("review-publication")(req(path, "PUT", body), { lessonId: id })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await scoped(req(path, "PUT", body), { lessonId: id })).status, 200);
  assert.equal((await makeHandler()(req(path, "PUT", withoutMode), { lessonId: id })).status, 200);
  assert.deepEqual(calls, [body, JSON.parse(JSON.stringify(withoutMode))]);
});

test("media authoring requires the current aggregate revision before admission and forwards exact DELETE bodies", async () => {
  const calls: Array<{ method: string; body?: string }> = [];
  const state = { id, lessonId: id, status: "ready", generation: 1, isCurrent: true, lastErrorCode: null, captionTracks: [] };
  const client = createCourseClient({ enabled: () => true, getAdmin: async () => actor, mintToken: () => "admin.jwt", invalidateCatalog: () => {}, run: async (_kind, work) => work(), getTransport: () => async input => {
    calls.push(input); return Response.json(state);
  } });
  await assert.rejects(client.createVideoUpload(id, {} as never), { code: "invalid_request" });
  await assert.rejects(client.addVideoCaption(id, id, { url: "https://media.example.invalid/caption.vtt", language: "en", label: "English" } as never), { code: "invalid_request" });
  await assert.rejects(client.deleteVideoCaption(id, id, "mux_track", {} as never), { code: "invalid_request" });
  assert.equal(calls.length, 0);
  const handler = createCourseAdminHandler("delete-caption", { enabled: () => true, client: () => client, origin: () => origin });
  assert.equal((await handler(req(`/api/admin/lessons/${id}/video/${id}/captions/mux_track`, "DELETE", { expectedCourseRevision: 3 }), { lessonId: id, videoAssetId: id, trackId: "mux_track" })).status, 200);
  assert.equal(calls[0].method, "DELETE"); assert.deepEqual(JSON.parse(calls[0].body!), { expectedCourseRevision: 3 });
});

test("direct admin reads and the whole handler cover staff resolution through outbound validation in one semantic admission", async () => {
  let active = false, entries = 0;
  const run = async <T>(kind: "new-work" | "recovery", work: () => Promise<T>) => {
    assert.equal(kind, "new-work"); assert.equal(active, false); entries++; active = true;
    try { return await withWriterOperationContext(work); } finally { active = false; }
  };
  const client = createCourseClient({ enabled: () => true, run, getAdmin: async () => { assert.equal(active, true); return actor; }, mintToken: () => { assert.equal(active, true); return "admin.jwt"; }, getTransport: () => async () => {
    assert.equal(active, true); return Response.json({ courses: [], nextCursor: null });
  }, onResponse: () => { assert.equal(active, true); } });
  await withWriterOperationContext(() => client.listAdminCourses());
  assert.equal(entries, 1, "an unrelated parent uncertainty context does not replace semantic admission");
  const handler = createCourseAdminHandler("list-courses", { enabled: () => true, client: () => client, run });
  assert.equal((await handler(req("/api/admin/courses"))).status, 200);
  assert.equal(entries, 2, "the client reuses the matching enclosing handler instead of opening another entry");
  assert.equal(active, false);
});

test("deterministic staff denial settles cleanly while caught identity uncertainty poisons the whole admin operation", async () => {
  let settled = 0;
  const run = async <T>(_kind: "new-work" | "recovery", work: () => Promise<T>) => { const result = await withWriterOperationContext(work); settled++; return result; };
  const denied = createCourseClient({ enabled: () => true, run, getAdmin: async () => { throw new IntegrationServiceError("forbidden", 403); }, getTransport: () => { assert.fail("denied outbound call"); } });
  const denyHandler = createCourseAdminHandler("list-courses", { enabled: () => true, client: () => denied, run });
  assert.equal((await denyHandler(req("/api/admin/courses"))).status, 403); assert.equal(settled, 1);
  const uncertain = createCourseClient({ enabled: () => true, run, getAdmin: async () => { markWriterOperationUncertain(); return actor; }, mintToken: () => "admin.jwt", getTransport: () => async () => Response.json({ courses: [], nextCursor: null }) });
  const uncertainHandler = createCourseAdminHandler("list-courses", { enabled: () => true, client: () => uncertain, run });
  assert.equal((await uncertainHandler(req("/api/admin/courses"))).status, 503); assert.equal(settled, 1);
});
