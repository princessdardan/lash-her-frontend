import assert from "node:assert/strict";
import test from "node:test";
import { createCourseClient } from "./course-client";
import { createAcademyHandler } from "./academy-handler";
import { courseCapabilitiesForActor, communityCapabilitiesForActor } from "./staff-capabilities";
import { validateCandidateRequest, validateCandidateResponse } from "./candidate-validation";
import { integrationErrorResponse } from "./service-errors";
import type { AdminActor } from "@/lib/admin/types";
import type { GatewayRequest } from "./gateway-transport";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import courseContract from "../../../contracts/api-integration/p2-candidate/course-api.json";
import communityContract from "../../../contracts/api-integration/p2-candidate/community-api.json";
import { ApiContractError } from "./api-contract-error";
import { GET as catalogRoute } from "@/app/api/academy/catalog/route";
import { GET as myCoursesRoute } from "@/app/api/academy/courses/route";
import { GET as progressRoute } from "@/app/api/academy/progress/route";
import { GET as adminCoursesRoute } from "@/app/api/admin/courses/route";

const customerId = "11111111-1111-4111-8111-111111111111";
const lessonId = "22222222-2222-4222-8222-222222222222";
const adminId = "33333333-3333-4333-8333-333333333333";
const at = "2026-11-05T12:00:00.000Z";
const actor = (role: "owner" | "admin" | "employee", status: "active" | "disabled" = "active"): AdminActor => ({ bookingProviderResourceIds: [], bookingResourceIds: [], user: { id: adminId, email: "staff@example.com", emailNormalized: "staff@example.com", displayName: null, providerUserId: "google-provider-subject", role, status } });
const progress = { id: lessonId, userId: customerId, lessonId, enrollmentId: null, maxPositionSeconds: 10, resumePositionSeconds: 3, revision: 1, completedQuizRevision: null, completedAt: null, lastWatchedAt: at, createdAt: at, updatedAt: at };
const customer = async () => ({ id: customerId, email: "customer@example.com", name: null });
const allowed = () => true;
const direct = async <T>(_kind: "new-work" | "recovery", work: () => Promise<T>) => work();

test("actual static route exports ignore Next context rather than parsing it as domain parameters", async t => {
  const saved = process.env.INTEGRATION_COURSE_READS_ENABLED;
  process.env.INTEGRATION_COURSE_READS_ENABLED = "false";
  t.after(() => { if (saved === undefined) delete process.env.INTEGRATION_COURSE_READS_ENABLED; else process.env.INTEGRATION_COURSE_READS_ENABLED = saved; });
  for (const route of [catalogRoute, myCoursesRoute, progressRoute, adminCoursesRoute]) {
    const response = await Reflect.apply(route, undefined, [new Request("https://site.example.com/api/academy/catalog"), { params: Promise.resolve({}) }]);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "feature_disabled");
  }
});

test("disabled capabilities stop before sessions, credentials, admission or workload transport", async () => {
  const client = createCourseClient({ enabled: () => false, getCustomer: async () => { assert.fail("read customer"); },
    mintToken: () => { assert.fail("minted token"); }, getTransport: () => { assert.fail("started transport"); }, run: async () => { assert.fail("entered admission"); } });
  await assert.rejects(client.listCatalog(), { code: "feature_disabled" });
  await assert.rejects(client.recordProgress(lessonId, { expectedProgressRevision: 0, event: "lesson_started" }), { code: "feature_disabled" });
});

test("learner identity is server-derived and public calls use no application credentials", async () => {
  const calls: GatewayRequest[] = [], principals: unknown[] = [];
  const client = createCourseClient({ enabled: allowed, getCustomer: customer, run: direct, mintToken: principal => { principals.push(principal); return "server.minted.jwt"; },
    getTransport: () => async request => { calls.push(request); return Response.json(request.path === "/v1/courses" ? { courses: [], nextCursor: null } : { courses: [] }); } });
  assert.deepEqual(await client.listCatalog(), { courses: [], nextCursor: null });
  assert.equal(calls[0].applicationToken, undefined);
  await client.listMyCourses();
  assert.deepEqual(principals, [{ profile: "course-learner", customerId }]);
  assert.equal(calls[1].applicationToken, "server.minted.jwt");
  assert.equal(calls[1].path, "/v1/student/courses");
  await assert.rejects(client.listProgress({ userId: adminId } as never), { code: "invalid_request" });
  assert.equal(calls.length, 2);
  const anonymous = createCourseClient({ enabled: allowed, getCustomer: async () => null, getTransport: () => { assert.fail("anonymous upstream call"); } });
  await assert.rejects(anonymous.listMyCourses(), { code: "sign_in_required" });
});

test("learner access requires the issued customer in direct page reads and same-origin lesson reads", async () => {
  const courseId = adminId, site = "https://site.example.com", token = "scoped.learner.jwt";
  const course = { id: courseId, slug: "owned-paid", title: "Owned paid course", description: null, priceCents: 100, currency: "CAD",
    introduction: null, cover: null, seo: null, accessMode: "paid", modules: [] };
  const lesson = { id: lessonId, moduleId: courseId, slug: "lesson", title: "Lesson", content: null, contentDocument: null,
    transcript: null, captions: [], isPreview: false, position: 1 };
  let scope: { actorId: string; lessonId: string } | undefined = { actorId: customerId, lessonId };
  let issued: { customerId: string; token: string } | null = { customerId: adminId, token };
  let issuances = 0;
  const requests: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getLearnerAccess: async () => scope, issueCustomerToken: async () => { issuances++; return issued; },
    run: async () => assert.fail("read-only scope entered write admission"), getTransport: () => async request => {
      requests.push(request);
      return Response.json(request.path.startsWith("/v1/student/courses/") ? { course } : { lesson });
    } });
  const lessonHandler = createAcademyHandler("lesson", { client: () => client });
  const getLesson = (selectedLesson: string) => lessonHandler(new Request(`${site}/api/academy/lessons/${selectedLesson}`), { lessonId: selectedLesson });
  await assert.rejects(client.getMyCourse(courseId), { code: "forbidden", status: 403 });
  const refused = await getLesson(lessonId);
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("cache-control"), "private, no-store");
  assert.equal(requests.length, 0);
  issued = { customerId, token };
  const before = issuances;
  assert.equal((await getLesson(courseId)).status, 403);
  await assert.rejects(client.recordProgress(lessonId, { expectedProgressRevision: 0, event: "lesson_started" }), { code: "forbidden", status: 403 });
  assert.equal(issuances, before);
  assert.deepEqual(await client.getMyCourse(courseId), { course });
  const admitted = await getLesson(lessonId);
  assert.equal(admitted.status, 200);
  assert.equal(admitted.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await admitted.json(), { lesson });
  assert.deepEqual(requests.map(request => [request.method, request.path, request.applicationToken]), [
    ["GET", `/v1/student/courses/${courseId}`, token], ["GET", `/v1/student/lessons/${lessonId}`, token],
  ]);
  issued = null;
  await assert.rejects(client.getMyCourse(courseId), { code: "sign_in_required", status: 401 });
  scope = undefined;
  issued = { customerId: adminId, token };
  assert.deepEqual(await client.getMyCourse(courseId), { course });
});

test("lesson entry binds the active customer, exact reads and first progress write before Course transport", async () => {
  const courseId = adminId, origin = "https://site.example.com", token = "scoped.learner.jwt";
  const scope = { actorId: customerId, courseId, lessonId };
  const course = { id: courseId, slug: "owned-entry", title: "Owned course", description: null, priceCents: 0, currency: "CAD",
    introduction: null, cover: null, seo: null, accessMode: "free", modules: [] };
  const lesson = { id: lessonId, moduleId: courseId, slug: "lesson", title: "Lesson", content: null, contentDocument: null,
    transcript: null, captions: [], isPreview: false, position: 1 };
  const initialProgress = { ...progress, maxPositionSeconds: 0, resumePositionSeconds: 0 };
  const quiz = { id: customerId, lessonId, revision: 1, document: { version: 1, mode: "graded", passingPercent: 80,
    questions: [{ id: "q", prompt: "What comes first?", options: [{ id: "a", text: "Preparation" }, { id: "b", text: "Review" }] }] } };
  const playback = { playbackId: "owned-playback", playbackToken: "fixture-playback", thumbnailToken: "fixture-thumbnail", expiresAt: at, thumbnailExpiresAt: at };
  const lessonTarget = `/v1/student/lessons/${lessonId}`;
  const progressTarget = `${lessonTarget}/progress`;
  const expected = new Map<string, object>([
    [`/v1/student/courses/${courseId}`, { course }], [`/v1/student/progress?courseId=${courseId}`, { progress: [] }],
    [lessonTarget, { lesson }], [`/v1/student/progress?lessonId=${lessonId}`, { progress: [] }], [`${lessonTarget}/quiz`, { quiz }],
    [`${lessonTarget}/quiz/attempts`, { attempts: [] }], [`${lessonTarget}/playback`, playback], [progressTarget, { progress: initialProgress }],
  ]);
  let issued = { customerId: adminId, token };
  let issuances = 0, admitted = 0;
  const calls: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getLessonEntry: async () => scope,
    issueCustomerToken: async () => { issuances++; return issued; },
    run: async (kind, work) => { assert.equal(kind, "new-work"); admitted++; return work(); },
    getTransport: () => async input => {
      calls.push(input);
      const result = expected.get(input.path);
      assert.ok(result, input.path);
      return Response.json(result);
    },
  });
  const denied = { code: "forbidden", status: 403 };
  await assert.rejects(client.getMyCourse(courseId), denied);
  issued = { customerId, token };
  const before = issuances;
  for (const request of [() => client.listMyCourses(), () => client.getMyCourse(customerId), () => client.getLesson(courseId),
    () => client.listProgress({ lessonId: courseId }), () => client.listProgress(),
    () => client.recordProgress(lessonId, { event: "lesson_started", expectedProgressRevision: 1 }),
    () => client.recordProgress(lessonId, { event: "lesson_started", expectedProgressRevision: 0, resumePositionSeconds: 0 }),
    () => client.recordProgress(lessonId, { expectedProgressRevision: 0, event: "lesson_started" })]) {
    await assert.rejects(request(), denied);
  }
  assert.equal(issuances, before);
  assert.equal(admitted, 0);
  assert.equal(calls.length, 0);
  await client.getMyCourse(courseId);
  await client.listProgress({ courseId });
  await client.getLesson(lessonId);
  await client.listProgress({ lessonId });
  await client.getQuiz(lessonId);
  await client.listQuizAttempts(lessonId);
  await client.authorizePlayback(lessonId);
  const handle = createAcademyHandler("record-progress", { client: () => client, origin: () => origin });
  const headers = { "content-type": "application/json", "x-lash-csrf": "1", origin };
  const startBody = '{"event":"lesson_started","expectedProgressRevision":0}';
  const route = `${origin}/api/academy/lessons/${lessonId}/progress`;
  const crossOrigin = await handle(new Request(route, { method: "POST", headers: { ...headers, origin: "https://foreign.example.test" }, body: startBody }), { lessonId });
  assert.equal(crossOrigin.status, 403);
  const response = await handle(new Request(route, { method: "POST", headers, body: startBody }), { lessonId });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { progress: initialProgress });
  assert.equal(admitted, 1);
  assert.deepEqual(calls.map(request => [request.method, request.path, request.applicationToken, request.body]),
    [...expected.keys()].map(path => path === progressTarget ? ["POST", path, token, startBody] : ["GET", path, token, undefined]));
});

test("lesson assessment binds the enrolled customer and canonical progress and quiz requests", async () => {
  const courseId = adminId, token = "scoped.learner.jwt";
  const scope = { actorId: customerId, courseId, lessonId };
  const attemptId = "44444444-4444-4444-8444-444444444444";
  const attempt = { quizRevision: 2, requestId: attemptId, answers: [{ questionId: "q", optionId: "a" }] };
  const start = { event: "lesson_started", expectedProgressRevision: 0 } as const;
  let issued = { customerId: adminId, token }, admissions = 0;
  const calls: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getLessonAssessment: async () => scope,
    issueCustomerToken: async () => issued,
    run: async (kind, task) => { assert.equal(kind, "new-work"); admissions++; return task(); },
    getTransport: () => async request => {
      calls.push(request);
      return Response.json({ error: { code: "LESSON_NOT_FOUND", message: "Lesson not found" } }, { status: 404 });
    },
  });
  const forbidden = { code: "forbidden", status: 403 };
  await assert.rejects(client.authorizePlayback(lessonId), forbidden);
  issued = { customerId, token };
  for (const call of [
    () => client.getMyCourse(customerId), () => client.getLesson(courseId), () => client.listMyCourses(),
    () => client.listProgress({ courseId }), () => client.listProgress({ lessonId: courseId }),
    () => client.enrollFree(courseId, { idempotencyKey: attemptId }),
    () => client.recordProgress(lessonId, { ...start, expectedProgressRevision: 1 }),
    () => client.submitQuizAttempt(courseId, attempt),
    () => client.submitQuizAttempt(lessonId, { ...attempt, requestId: attemptId.replace("-4444-8444-", "-5444-8444-") }),
    () => client.submitQuizAttempt(lessonId, { ...attempt, answers: [...attempt.answers, ...attempt.answers] }),
    () => client.submitQuizAttempt(lessonId, { requestId: attempt.requestId, quizRevision: attempt.quizRevision, answers: attempt.answers }),
  ]) await assert.rejects(call(), forbidden);
  assert.equal(admissions, 0);
  assert.deepEqual(calls, []);
  await assert.rejects(client.authorizePlayback(lessonId), { code: "not_found", status: 404 });
  await assert.rejects(client.recordProgress(lessonId, start));
  await assert.rejects(client.submitQuizAttempt(lessonId, attempt));
  assert.equal(admissions, 2);
  const lesson = `/v1/student/lessons/${lessonId}`;
  assert.deepEqual(calls.map(({ method, path, body, applicationToken }) => [method, path, body, applicationToken]), [
    ["GET", `${lesson}/playback`, undefined, token],
    ["POST", `${lesson}/progress`, JSON.stringify(start), token],
    ["POST", `${lesson}/quiz/attempts`, JSON.stringify(attempt), token],
  ]);
});

for (const restore of [false, true]) {
  test(`lesson ${restore ? "restore" : "resume"} binds the learner and only writes the selected native position body`, async () => {
    const courseId = adminId, token = "scoped.learner.jwt";
    const scope = { actorId: customerId, courseId, lessonId };
    const position = restore ? { resumePositionSeconds: 4, maxPositionSeconds: 14, expectedProgressRevision: 5 } :
      { resumePositionSeconds: 10, maxPositionSeconds: 10, expectedProgressRevision: 1 };
    const started = { event: "lesson_started", expectedProgressRevision: restore ? 4 : 0 } as const;
    let issued = { customerId: adminId, token }, admissions = 0;
    const calls: GatewayRequest[] = [];
    const client = createCourseClient({ enabled: allowed,
      ...(restore ? { getLessonRestore: async () => scope } : { getLessonResume: async () => scope }),
      issueCustomerToken: async () => issued,
      run: async (kind, task) => { assert.equal(kind, "new-work"); admissions++; return task(); },
      getTransport: () => async request => {
        calls.push(request);
        if (request.method === "GET") return Response.json({ progress: [] });
        return Response.json({ progress: { ...progress, resumePositionSeconds: request.body === JSON.stringify(started) && !restore ? 0 : position.resumePositionSeconds } });
      },
    });
    const forbidden = { code: "forbidden", status: 403 };
    await assert.rejects(client.listProgress({ lessonId }), forbidden);
    issued = { customerId, token };
    for (const call of [
      () => client.getMyCourse(customerId), () => client.getLesson(courseId), () => client.listProgress({ courseId }),
      () => client.enrollFree(courseId, { idempotencyKey: lessonId }),
      () => client.recordProgress(courseId, position), () => client.recordProgress(lessonId, { ...position, resumePositionSeconds: 9 }),
      () => client.recordProgress(lessonId, { ...position, expectedProgressRevision: 4 }),
      () => client.recordProgress(lessonId, { ...position, event: "lesson_completed" }),
      () => client.recordProgress(lessonId, { ...started, expectedProgressRevision: 1 }),
    ]) await assert.rejects(call(), forbidden);
    assert.equal(admissions, 0);
    assert.deepEqual(calls, []);
    await client.listProgress({ lessonId });
    await client.recordProgress(lessonId, started);
    await client.recordProgress(lessonId, position);
    assert.equal(admissions, 2);
    const lesson = `/v1/student/lessons/${lessonId}`;
    assert.deepEqual(calls.map(({ method, path, body, applicationToken }) => [method, path, body, applicationToken]), [
      ["GET", `/v1/student/progress?lessonId=${lessonId}`, undefined, token],
      ["POST", `${lesson}/progress`, JSON.stringify(started), token],
      ["POST", `${lesson}/progress`, JSON.stringify(position), token],
    ]);
  });
}

test("lesson acknowledgement loss scopes the authority read and all five writes to one learner and lesson", async () => {
  const courseId = adminId, token = "scoped.learner.jwt";
  const scope = { actorId: customerId, courseId, lessonId };
  const bodies = [
    { event: "lesson_started", expectedProgressRevision: 6 },
    { resumePositionSeconds: 4, maxPositionSeconds: 14, expectedProgressRevision: 7 },
    { resumePositionSeconds: 14, maxPositionSeconds: 14, expectedProgressRevision: 8 },
    { event: "lesson_started", expectedProgressRevision: 9 },
    { resumePositionSeconds: 14, maxPositionSeconds: 14, expectedProgressRevision: 10 },
  ] as const;
  let issued = { customerId: adminId, token }, admissions = 0;
  const calls: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getLessonAckLoss: async () => scope,
    issueCustomerToken: async () => issued,
    run: async (kind, task) => { assert.equal(kind, "new-work"); admissions++; return task(); },
    getTransport: () => async request => {
      calls.push(request);
      return request.method === "GET" ? Response.json({ progress: [progress] }) : Response.json({ progress });
    },
  });
  const forbidden = { code: "forbidden", status: 403 };
  await assert.rejects(client.listProgress({ lessonId }), forbidden);
  issued = { customerId, token };
  for (const attempt of [
    () => client.getMyCourse(customerId), () => client.getLesson(courseId), () => client.listProgress({ courseId }),
    () => client.recordProgress(courseId, bodies[0]),
    () => client.recordProgress(lessonId, { event: "lesson_started", expectedProgressRevision: 8 }),
    () => client.recordProgress(lessonId, { ...bodies[2], resumePositionSeconds: 4 }),
    () => client.recordProgress(lessonId, { ...bodies[1], maxPositionSeconds: 13 }),
    () => client.recordProgress(lessonId, { ...bodies[4], event: "lesson_completed" }),
  ]) await assert.rejects(attempt(), forbidden);
  assert.equal(admissions, 0);
  assert.deepEqual(calls, []);
  await client.listProgress({ lessonId });
  for (const body of bodies) await client.recordProgress(lessonId, body);
  assert.equal(admissions, 5);
  assert.deepEqual(calls.map(({ method, path, body, applicationToken }) => [method, path, body, applicationToken]), [
    ["GET", `/v1/student/progress?lessonId=${lessonId}`, undefined, token],
    ...bodies.map(body => ["POST", `/v1/student/lessons/${lessonId}/progress`, JSON.stringify(body), token]),
  ]);
});

test("lesson exit save bounds both reads and all three writes to the selected learner and course", async () => {
  const courseId = adminId, token = "scoped.learner.jwt";
  const scope = { actorId: customerId, courseId, lessonId };
  const bodies = [
    { event: "lesson_started", expectedProgressRevision: 6 },
    { resumePositionSeconds: 4, maxPositionSeconds: 14, expectedProgressRevision: 7 },
    { resumePositionSeconds: 7, maxPositionSeconds: 14, expectedProgressRevision: 8 },
  ] as const;
  let issued = { customerId: adminId, token }, admissions = 0;
  const calls: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getLessonExitSave: async () => scope,
    issueCustomerToken: async () => issued,
    run: async (kind, task) => { assert.equal(kind, "new-work"); admissions++; return task(); },
    getTransport: () => async request => {
      calls.push(request);
      return request.method === "GET" ? Response.json({ progress: [progress] }) : Response.json({ progress });
    },
  });
  const forbidden = { code: "forbidden", status: 403 };
  await assert.rejects(client.listProgress({ courseId }), forbidden);
  issued = { customerId, token };
  for (const attempt of [
    () => client.getMyCourse(customerId), () => client.listProgress({ courseId: customerId }),
    () => client.listProgress({ courseId, lessonId }), () => client.recordProgress(courseId, bodies[0]),
    () => client.recordProgress(lessonId, { event: "lesson_started", expectedProgressRevision: 8 }),
    () => client.recordProgress(lessonId, { ...bodies[2], resumePositionSeconds: 5 }),
    () => client.recordProgress(lessonId, { ...bodies[2], resumePositionSeconds: 10 }),
    () => client.recordProgress(lessonId, { ...bodies[2], expectedProgressRevision: 9 }),
  ]) await assert.rejects(attempt(), forbidden);
  assert.equal(admissions, 0);
  assert.deepEqual(calls, []);
  await client.listProgress({ courseId });
  for (const body of bodies) await client.recordProgress(lessonId, body);
  assert.equal(admissions, 3);
  assert.deepEqual(calls.map(({ method, path, body, applicationToken }) => [method, path, body, applicationToken]), [
    ["GET", `/v1/student/progress?courseId=${courseId}`, undefined, token],
    ...bodies.map(body => ["POST", `/v1/student/lessons/${lessonId}/progress`, JSON.stringify(body), token]),
  ]);
});

test("lesson denial binds the selected customer and returns only safe protected read denials", async () => {
  const courseId = adminId, token = "scoped.denied.jwt", requestId = "44444444-4444-4444-8444-444444444444";
  const selected = { actorId: customerId, courseId, lessonId };
  let issued = { customerId: adminId, token }, issuances = 0;
  const calls: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getLessonDenial: async () => selected,
    issueCustomerToken: async () => { issuances++; return issued; },
    run: async () => assert.fail("denial scope entered write admission"),
    getTransport: () => async request => {
      calls.push(request);
      return Response.json({ error: { code: "ACTIVE_ENROLLMENT_REQUIRED", message: "private upstream detail" } },
        { status: 403, headers: { "x-request-id": requestId } });
    },
  });
  const forbidden = { code: "forbidden", status: 403 };
  await assert.rejects(client.getMyCourse(courseId), forbidden);
  assert.equal(issuances, 1);
  issued = { customerId, token };
  for (const call of [() => client.getMyCourse(customerId), () => client.getLesson(courseId),
    () => client.listMyCourses(), () => client.listCourseLessons(courseId), () => client.listProgress(),
    () => client.listProgress({ courseId }), () => client.listProgress({ lessonId: courseId }),
    () => client.recordProgress(lessonId, { event: "lesson_started", expectedProgressRevision: 0 }),
    () => client.enrollFree(courseId, { idempotencyKey: requestId }),
  ]) await assert.rejects(call(), forbidden);
  assert.equal(issuances, 1);
  assert.deepEqual(calls, []);
  await assert.rejects(client.getMyCourse(courseId), { code: "access_required", status: 403, requestId });
  const lesson = `/api/academy/lessons/${lessonId}`;
  for (const [operation, target] of [["lesson", lesson], ["playback", `${lesson}/playback`],
    ["progress", `/api/academy/progress?lessonId=${lessonId}`], ["quiz", `${lesson}/quiz`], ["quiz-attempts", `${lesson}/quiz/attempts`]] as const) {
    const handler = createAcademyHandler(operation, { client: () => client });
    const response = await handler(new Request("https://site.example.com" + target), operation === "progress" ? {} : { lessonId });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-request-id"), requestId);
    assert.deepEqual(await response.json(), { error: { code: "access_required", message: "Course access is required." }, requestId });
  }
  assert.deepEqual(calls.map(({ method, path, applicationToken, body, idempotencyKey }) => [method, path, applicationToken, body, idempotencyKey]), [
    `/v1/student/courses/${courseId}`, `/v1/student/lessons/${lessonId}`, `/v1/student/lessons/${lessonId}/playback`,
    `/v1/student/progress?lessonId=${lessonId}`, `/v1/student/lessons/${lessonId}/quiz`, `/v1/student/lessons/${lessonId}/quiz/attempts`,
  ].map(path => ["GET", path, token, undefined, undefined]));
});

test("request/response validation rejects unknown fields and accepts composed learner curriculum objects", () => {
  assert.throws(() => validateCandidateRequest("course", "/v1/student/lessons/{lessonId}/progress", "post", { params: { lessonId }, body: { event: "lesson_started", userId: adminId } }));
  assert.throws(() => validateCandidateResponse("course", "/v1/courses", "get", 200, { courses: [], nextCursor: null, privateToken: "must-not-leak" }));
  assert.throws(() => validateCandidateResponse("course", "/v1/courses", "get", 202, { courses: [], nextCursor: null }));
  const course = { id: lessonId, slug: "intro", title: "Intro", description: null, priceCents: 0, currency: "CAD", introduction: null, cover: null, seo: null, accessMode: "free", modules: [] };
  assert.doesNotThrow(() => validateCandidateResponse("course", "/v1/student/courses/{courseId}", "get", 200, { course }));
  assert.throws(() => validateCandidateResponse("course", "/v1/student/courses/{courseId}", "get", 200, { course: { ...course, customerEmail: "must-not-leak" } }));
});

test("every candidate JSON response schema compiles, including composed objects and response references", () => {
  for (const [service, document] of Object.entries({ course: courseContract, community: communityContract })) {
    for (const [path, operations] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(operations)) {
      const responses = (operation as { responses: Record<string, { content?: { "application/json"?: object }; $ref?: string }> }).responses;
      for (const [status, response] of Object.entries(responses)) if (response.content?.["application/json"] || response.$ref) {
        assert.throws(() => validateCandidateResponse(service as "course" | "community", path, method as "get" | "post" | "patch", Number(status), undefined), ApiContractError);
      }
    }
  }
});

test("only database-authorized owner permissions map to new domain capabilities", () => {
  assert.deepEqual(courseCapabilitiesForActor(actor("owner")), ["course-editor", "course-support"]);
  assert.deepEqual(communityCapabilitiesForActor(actor("owner")), ["community-moderator"]);
  for (const staff of [actor("admin"), actor("employee"), actor("owner", "disabled")]) {
    assert.deepEqual(courseCapabilitiesForActor(staff), []); assert.deepEqual(communityCapabilitiesForActor(staff), []);
  }
});

test("named admin methods require domain permission, mint canonical admin subjects and accept documented201", async () => {
  const permissions: string[] = [], principals: unknown[] = [];
  const course = { id: lessonId, slug: "intro", title: "Intro", description: null, status: "draft", priceCents: 0, currency: "CAD", introduction: null, cover: null, seo: null, accessMode: "free", taxClassification: null, revision: 1, modules: [] };
  const client = createCourseClient({ enabled: allowed, run: direct, getAdmin: async action => { permissions.push(action); return actor("owner"); }, mintToken: principal => { principals.push(principal); return "admin.jwt"; },
    getTransport: () => async request => { assert.equal(request.path, "/v1/admin/courses"); assert.equal(request.applicationToken, "admin.jwt"); return Response.json({ course }, { status: 201 }); } });
  assert.deepEqual(await client.createCourse({ slug: "intro", title: "Intro" }), { course });
  assert.deepEqual(permissions, ["courses:edit"]);
  assert.deepEqual(principals, [{ profile: "course-admin", adminId, capabilities: ["course-editor", "course-support"] }]);
  const denied = createCourseClient({ enabled: allowed, run: direct, getAdmin: async () => actor("admin"), mintToken: () => { assert.fail("unauthorized admin token"); } });
  await assert.rejects(denied.createCourse({ slug: "intro", title: "Intro" }), { code: "forbidden" });
});

test("documented access errors are safe, unknown successes are denied, and mutation ambiguity survives catching", async () => {
  const client = createCourseClient({ enabled: allowed, getCustomer: customer, mintToken: () => "learner.jwt", getTransport: () => async () => Response.json({ error: { code: "ENTITLEMENT_REVOKED", message: "private-provider-value" } }, { status: 403, headers: { "x-request-id": customerId } }) });
  await assert.rejects(client.getLesson(lessonId), error => {
    const response = integrationErrorResponse(error); assert.equal(response.status, 403); assert.equal(response.headers.get("x-request-id"), customerId);
    assert.equal((error as Error).message.includes("private-provider-value"), false); return true;
  });
  const uncertain = createCourseClient({ enabled: allowed, getCustomer: customer, mintToken: () => "learner.jwt", run: async (_kind, work) => withWriterOperationContext(work),
    getTransport: () => async () => Response.json({ unexpected: "must-not-leak" }, { status: 200 }) });
  await assert.rejects(uncertain.recordProgress(lessonId, { expectedProgressRevision: 0, event: "lesson_started" }), /WRITER_OPERATION_REQUIRES_REVIEW/u);
});

test("academy handlers isolate caching, reject forged identity/query input and enforce mutation CSRF", async () => {
  let calls = 0;
  const real = createCourseClient({ enabled: allowed, getCustomer: customer, mintToken: () => "learner.jwt", run: direct,
    getTransport: () => async request => { calls++; return Response.json(request.method === "POST" ? { progress } : request.path.startsWith("/v1/courses") ? { courses: [], nextCursor: null } : { courses: [] }); } });
  const dependencies = { client: () => real, origin: () => "https://site.example.com" };
  const publicResponse = await createAcademyHandler("catalog", dependencies)(new Request("https://site.example.com/api/academy/catalog"));
  assert.equal(publicResponse.headers.get("cache-control")?.startsWith("public"), true);
  const privateResponse = await createAcademyHandler("my-courses", dependencies)(new Request("https://site.example.com/api/academy/courses"));
  assert.equal(privateResponse.headers.get("cache-control"), "private, no-store");
  const write = createAcademyHandler("record-progress", dependencies);
  const post = (headers = {}) => new Request("https://site.example.com/api/academy/lessons/a/progress", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ expectedProgressRevision: 0, event: "lesson_started" }) });
  assert.equal((await write(post(), { lessonId })).status, 403);
  assert.equal((await write(post({ origin: "https://evil.test", "x-lash-csrf": "1" }), { lessonId })).status, 403);
  assert.equal(calls, 2);
  assert.equal((await write(post({ origin: "https://site.example.com", "x-lash-csrf": "1" }), { lessonId })).status, 200);
  assert.equal((await createAcademyHandler("progress", dependencies)(new Request(`https://site.example.com/api/academy/progress?userId=${adminId}`))).status, 400);
  assert.equal((await createAcademyHandler("catalog", dependencies)(new Request("https://site.example.com/api/academy/catalog?limit=1&limit=2"))).status, 400);
});

test("scoped free enrollment matches the signed key and customer before Course while ordinary keys still work", async () => {
  const site = "https://site.example.com";
  const courseId = lessonId, key = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const receipt = { courseId, enrollmentId: customerId, grantId: adminId, source: "free", status: "active", idempotentReplay: false };
  let selected: { actorId: string; idempotencyKey: string } | undefined = { actorId: customerId, idempotencyKey: key };
  let activeCustomer: Awaited<ReturnType<typeof customer>> | null = await customer();
  let permitReads = 0, scopedActorReads = 0;
  const calls: GatewayRequest[] = [];
  const client = createCourseClient({ enabled: allowed, getCustomer: async () => activeCustomer, mintToken: () => "learner.jwt", run: direct,
    getTransport: () => async request => { calls.push(request); return Response.json(receipt, { status: 201 }); } });
  const enroll = createAcademyHandler("free-enrollment", { client: () => client, origin: () => site,
    getLearningEnrollment: async () => { permitReads++; return selected; },
    getCustomer: async () => { scopedActorReads++; return activeCustomer; } });
  const post = (body: unknown, origin = site) => enroll(new Request(`${site}/api/academy/courses/${courseId}/enrollments`, {
    method: "POST", headers: { "content-type": "application/json", origin, "x-lash-csrf": "1" }, body: JSON.stringify(body),
  }), { courseId });
  assert.equal((await post({ idempotencyKey: key }, "https://other.invalid")).status, 403);
  assert.equal(permitReads, 0);
  for (const body of [null, [], {}, { idempotencyKey: adminId }, { idempotencyKey: key, userId: customerId }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(scopedActorReads, 0);
  activeCustomer = { ...await customer(), id: adminId };
  assert.equal((await post({ idempotencyKey: key })).status, 403);
  activeCustomer = null;
  assert.equal((await post({ idempotencyKey: key })).status, 401);
  assert.equal(calls.length, 0);
  activeCustomer = await customer();
  const admitted = await post({ idempotencyKey: key });
  assert.equal(admitted.status, 200);
  assert.equal(admitted.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await admitted.json(), receipt);
  selected = undefined;
  const ordinaryKey = "owned:random-or-legacy-key";
  assert.equal((await post({ idempotencyKey: ordinaryKey })).status, 200);
  assert.equal(scopedActorReads, 3);
  assert.deepEqual(calls.map(({ path, applicationToken, idempotencyKey, body }) => ({ path, applicationToken, idempotencyKey, body })),
    [key, ordinaryKey].map(idempotencyKey => ({ path: `/v1/student/courses/${courseId}/enrollments`, applicationToken: "learner.jwt",
      idempotencyKey, body: JSON.stringify({ idempotencyKey }) })));
});

test("closed gateway rate-limit and pre-forward maintenance envelopes remain safe and deterministic", async () => {
  for (const [status, code] of [[429, "rate_limit_exceeded"], [503, "release_maintenance"]] as const) {
    const client = createCourseClient({ enabled: allowed, getCustomer: customer, mintToken: () => "learner.jwt", run: async (_kind, work) => withWriterOperationContext(work),
      getTransport: () => async () => Response.json({ error: { code, message: code.replaceAll("_", " ") }, requestId: customerId }, { status, headers: { "x-request-id": customerId, "retry-after": "30" } }) });
    await assert.rejects(client.recordProgress(lessonId, { expectedProgressRevision: 0, event: "lesson_started" }), error => {
      assert.equal((error as { code: string }).code, status === 429 ? "rate_limited" : "service_unavailable");
      assert.equal((error as { requestId: string }).requestId, customerId);
      assert.equal((error as Error).message.includes(code), false); return true;
    });
  }
  const mismatchedOwner = createCourseClient({ enabled: allowed, getCustomer: customer, mintToken: () => "learner.jwt", getTransport: () => async () => Response.json({ progress: [{ ...progress, userId: adminId }] }) });
  await assert.rejects(mismatchedOwner.listProgress(), { code: "service_unavailable" });
});
