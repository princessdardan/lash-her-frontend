import assert from "node:assert/strict";
import test from "node:test";
import { createCourseAdminHandler } from "./course-admin-handler";
import { createCourseClient } from "./course-client";
import type { AdminActor } from "@/lib/admin/types";

const id = "11111111-1111-4111-8111-111111111111";
const origin = "https://site.example.invalid";
const actor: AdminActor = { bookingProviderResourceIds: [], bookingResourceIds: [], user: { id, email: "owner@example.invalid", emailNormalized: "owner@example.invalid", displayName: null, providerUserId: "provider-sub", role: "owner", status: "active" } };
const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(origin + path, { method, headers: { origin, "content-type": "application/json", "x-lash-csrf": "1", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("admin boundaries require configured origin/CSRF before invoking staff authentication or mutation", async () => {
  let calls = 0;
  const handler = createCourseAdminHandler("update-course", { client: () => { calls++; return {} as never; }, origin: () => origin });
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { origin: "https://attacker.invalid" }), { courseId: id })).status, 403);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { "x-lash-csrf": "" }), { courseId: id })).status, 403);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { "sec-fetch-site": "cross-site" }), { courseId: id })).status, 403);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}, { "content-length": "1048577" }), { courseId: id })).status, 413);
  assert.equal((await handler(req("/api/admin/courses/1", "PATCH", {}), { courseId: "not-an-id" })).status, 400);
  assert.equal(calls, 0);
});

test("admin paginated reads are private, validated and authorized through the real named client", async () => {
  let calls = 0;
  const client = createCourseClient({ enabled: () => true, getAdmin: async permission => { assert.equal(permission, "courses:edit"); return actor; }, mintToken: () => "server.admin.jwt", getTransport: () => async input => {
    calls++; assert.equal(input.path, "/v1/admin/courses?limit=10"); assert.equal(input.applicationToken, "server.admin.jwt"); return Response.json({ courses: [], nextCursor: null });
  } });
  const handler = createCourseAdminHandler("list-courses", { client: () => client });
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
  const handler = createCourseAdminHandler("update-quiz", { client: () => client, origin: () => origin });
  assert.equal((await handler(req(`/api/admin/lessons/${id}/quiz`, "PUT", body), { lessonId: id })).status, 200);
  assert.equal(writes, 1); assert.equal(invalidated, 1);
  assert.equal((await handler(req(`/api/admin/lessons/${id}/quiz`, "PUT", { ...body, userId: id }), { lessonId: id })).status, 400);
  assert.equal(writes, 1); assert.equal(invalidated, 1);
});
