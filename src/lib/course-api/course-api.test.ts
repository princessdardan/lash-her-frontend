import { execFileSync } from "node:child_process";
import test from "node:test";

test("course API config and JWTs enforce the integration security contract", () => {
  runScenario(String.raw`
    import { createHmac } from "node:crypto";
    import { readCourseApiConfig, requireEnabledCourseApiConfig } from "./src/lib/course-api/config.ts";
    import { CourseApiError } from "./src/lib/course-api/errors.ts";
    import { createCourseServiceToken, createCourseUserToken } from "./src/lib/course-api/jwt.ts";

    const userSecret = "u".repeat(32);
    const serviceSecret = "s".repeat(32);
    const values = {
      ACADEMY_ENABLED: "true",
      COURSE_API_BASE_URL: "https://course.example.test/api",
      COURSE_API_USER_JWT_SECRET: userSecret,
      COURSE_API_USER_JWT_ISSUER: "lash-her-frontend",
      COURSE_API_USER_JWT_AUDIENCE: "lash-her-course-api",
      COURSE_API_SERVICE_JWT_SECRET: serviceSecret,
      COURSE_API_SERVICE_JWT_ISSUER: "lash-her-frontend-service",
      COURSE_API_SERVICE_JWT_AUDIENCE: "lash-her-course-api-internal",
      COURSE_API_SERVICE_JWT_SUBJECT: "lash-her-frontend",
      COURSE_API_TIMEOUT_MS: "1200",
      COURSE_API_USER_JWT_TTL_SECONDS: "120",
      COURSE_API_SERVICE_JWT_TTL_SECONDS: "180",
      AUTH_SECRET: "a".repeat(32),
    };
    const read = (name) => values[name];

    assert.deepEqual(readCourseApiConfig(() => undefined), { enabled: false });
    const config = requireEnabledCourseApiConfig(readCourseApiConfig(read));
    assert.equal(config.baseUrl, "https://course.example.test/api");
    assert.equal(config.timeoutMs, 1200);
    assert.equal(config.userJwt.ttlSeconds, 120);
    assert.equal(config.serviceJwt.ttlSeconds, 180);

    for (const overrides of [
      { ACADEMY_ENABLED: "TRUE" },
      { COURSE_API_BASE_URL: "http://course.example.test" },
      { COURSE_API_BASE_URL: "https://user:password@course.example.test" },
      { COURSE_API_BASE_URL: "https://course.example.test?token=secret" },
      { COURSE_API_USER_JWT_SECRET: "short" },
      { COURSE_API_SERVICE_JWT_SECRET: userSecret },
      { AUTH_SECRET: userSecret },
      { COURSE_API_TIMEOUT_MS: "99" },
      { COURSE_API_USER_JWT_TTL_SECONDS: "3601" },
    ]) {
      const candidate = { ...values, ...overrides };
      assert.throws(
        () => readCourseApiConfig((name) => candidate[name]),
        (error) => error instanceof CourseApiError && error.kind === "config",
      );
    }
    assert.equal(
      requireEnabledCourseApiConfig(readCourseApiConfig((name) => ({ ...values, COURSE_API_BASE_URL: "http://localhost:4000" })[name])).baseUrl,
      "http://localhost:4000",
    );

    function decode(token) {
      const parts = token.split(".");
      assert.equal(parts.length, 3);
      return {
        header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
        payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
        unsigned: parts.slice(0, 2).join("."),
        signature: parts[2],
      };
    }

    const userToken = decode(createCourseUserToken(config.userJwt, "user_canonical_123", {
      nowSeconds: () => 1_800_000_000,
      createJti: () => "user-jti",
    }));
    assert.deepEqual(userToken.header, { alg: "HS256", typ: "JWT" });
    assert.deepEqual(userToken.payload, {
      iss: "lash-her-frontend",
      aud: "lash-her-course-api",
      sub: "user_canonical_123",
      iat: 1_800_000_000,
      exp: 1_800_000_120,
      jti: "user-jti",
    });
    assert.equal("email" in userToken.payload, false);
    assert.equal(
      userToken.signature,
      createHmac("sha256", userSecret).update(userToken.unsigned).digest("base64url"),
    );

    const serviceToken = decode(createCourseServiceToken(config.serviceJwt, {
      nowSeconds: () => 1_800_000_000,
      createJti: () => "service-jti",
    }));
    assert.deepEqual(serviceToken.payload, {
      iss: "lash-her-frontend-service",
      aud: "lash-her-course-api-internal",
      sub: "lash-her-frontend",
      iat: 1_800_000_000,
      exp: 1_800_000_180,
      jti: "service-jti",
    });
    assert.equal(
      serviceToken.signature,
      createHmac("sha256", serviceSecret).update(serviceToken.unsigned).digest("base64url"),
    );
  `);
});

test("course API runtime parsers validate every response family", () => {
  runScenario(String.raw`
    import {
      CourseApiContractError,
      parseCourseApiErrorEnvelope,
      parseEntitlementCheckResponse,
      parseEntitlementGrantResponse,
      parseEntitlementRevokeResponse,
      parsePlaybackResponse,
      parseProgressListResponse,
      parsePublicCourseDetailResponse,
      parsePublicCourseListResponse,
      parseReconcileEntitlementsResponse,
      parseRecordProgressResponse,
      parseStudentCourseDetailResponse,
      parseStudentLessonResponse,
    } from "./src/lib/course-api/contracts.ts";

    const courseId = "11111111-1111-4111-8111-111111111111";
    const moduleId = "22222222-2222-4222-8222-222222222222";
    const lessonId = "33333333-3333-4333-8333-333333333333";
    const progressId = "44444444-4444-4444-8444-444444444444";
    const enrollmentId = "55555555-5555-4555-8555-555555555555";
    const now = "2026-08-07T10:20:30.000Z";
    const summary = { id: courseId, slug: "classic-lashes", title: "Classic Lashes", description: null, priceCents: 12500, currency: "CAD" };
    const publicLesson = { id: lessonId, slug: "welcome", title: "Welcome", isPreview: true, position: 1 };
    const studentLesson = { ...publicLesson, moduleId, content: "Lesson body" };
    const publicModule = { id: moduleId, slug: "intro", title: "Introduction", description: null, position: 1, lessons: [publicLesson] };
    const studentModule = { ...publicModule, lessons: [studentLesson] };
    const progress = { id: progressId, userId: "user_1", lessonId, enrollmentId, maxPositionSeconds: 42, completedAt: null, lastWatchedAt: now, createdAt: now, updatedAt: now };

    assert.deepEqual(parsePublicCourseListResponse({ courses: [summary] }).courses[0], summary);
    assert.equal(parsePublicCourseDetailResponse({ course: { ...summary, modules: [publicModule] } }).course.modules[0].lessons[0].isPreview, true);
    assert.equal(parseStudentCourseDetailResponse({ course: { ...summary, modules: [studentModule] } }).course.modules[0].lessons[0].content, "Lesson body");
    assert.deepEqual(parseStudentLessonResponse({ lesson: studentLesson }).lesson, studentLesson);
    assert.deepEqual(parseProgressListResponse({ progress: [progress] }).progress[0], progress);
    assert.deepEqual(parseRecordProgressResponse({ progress }).progress, progress);
    assert.deepEqual(parsePlaybackResponse({ playbackToken: "signed", playbackId: "mux-playback", expiresAt: now }), { playbackToken: "signed", playbackId: "mux-playback", expiresAt: now });
    assert.equal(parseEntitlementGrantResponse({ grantId: enrollmentId, userId: "user_1", courseId, status: "active", createdAt: now, idempotentReplay: true }).idempotentReplay, true);
    assert.equal(parseEntitlementRevokeResponse({ grantId: enrollmentId, userId: "user_1", courseId, status: "revoked", revokedAt: now }).status, "revoked");
    assert.deepEqual(parseEntitlementCheckResponse({ userId: "user_1", courseId, hasAccess: false, grantId: null, expiresAt: null }), { userId: "user_1", courseId, hasAccess: false, grantId: null, expiresAt: null });
    assert.equal(parseReconcileEntitlementsResponse({ checkpoint: now, mismatches: [{ userId: "user_1", courseId, orderId: "order_1", expectedStatus: "active", actualStatus: "missing", mismatchType: "missing_active_grant", suggestedAction: "grant" }] }).mismatches[0].suggestedAction, "grant");
    assert.deepEqual(parseCourseApiErrorEnvelope({ error: { code: "NOT_FOUND", message: "Not found" } }), { error: { code: "NOT_FOUND", message: "Not found" } });
    assert.equal(parseCourseApiErrorEnvelope({ error: { code: 4, message: "bad" } }), null);

    for (const invalid of [
      { courses: [{ ...summary, id: "not-a-uuid" }] },
      { courses: [{ ...summary, priceCents: 1.5 }] },
      { courses: [{ ...summary, currency: "cad" }] },
    ]) {
      assert.throws(() => parsePublicCourseListResponse(invalid), CourseApiContractError);
    }
      assert.throws(() => parseProgressListResponse({ progress: [{ ...progress, updatedAt: "yesterday" }] }), CourseApiContractError);
      assert.throws(() => parseProgressListResponse({ progress: [{ ...progress, updatedAt: "2026-02-30T10:00:00Z" }] }), CourseApiContractError);
    assert.throws(() => parseReconcileEntitlementsResponse({ checkpoint: now, mismatches: [{ userId: "u", courseId, orderId: "o", expectedStatus: "active", actualStatus: "unknown", mismatchType: "status_mismatch", suggestedAction: "investigate" }] }), CourseApiContractError);
  `);
});

test("course API clients use fixed routes, scoped auth, idempotency, and sanitized errors", () => {
  runScenario(String.raw`
    import { CourseApiError } from "./src/lib/course-api/errors.ts";
    import { createInternalEntitlementClient } from "./src/lib/course-api/internal-entitlement-client.ts";
    import { createPublicCourseClient } from "./src/lib/course-api/public-client.ts";
    import { createStudentCourseClient } from "./src/lib/course-api/student-client.ts";

    const courseId = "11111111-1111-4111-8111-111111111111";
    const moduleId = "22222222-2222-4222-8222-222222222222";
    const lessonId = "33333333-3333-4333-8333-333333333333";
    const grantId = "44444444-4444-4444-8444-444444444444";
    const now = "2026-08-07T10:20:30.000Z";
    const summary = { id: courseId, slug: "classic", title: "Classic", description: null, priceCents: 10000, currency: "CAD" };
    const studentCourse = { ...summary, modules: [{ id: moduleId, slug: "intro", title: "Intro", description: null, position: 1, lessons: [] }] };
    const config = {
      enabled: true,
      baseUrl: "https://course.example.test/base",
      timeoutMs: 100,
      userJwt: { secret: "u".repeat(32), issuer: "frontend", audience: "course-user", ttlSeconds: 120 },
      serviceJwt: { secret: "s".repeat(32), issuer: "frontend-service", audience: "course-internal", subject: "frontend", ttlSeconds: 120 },
    };
    const calls = [];
    const responses = [
      { courses: [summary] },
      { course: { ...summary, modules: [] } },
      { course: studentCourse },
      { grantId, userId: "user_1", courseId, status: "active", createdAt: now },
      { grantId, userId: "user_1", courseId, status: "revoked", revokedAt: now },
      { userId: "user/with space", courseId, hasAccess: true, grantId, expiresAt: null },
      { checkpoint: now, mismatches: [] },
    ];
    const fetcher = async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json(responses.shift(), { headers: { "x-request-id": "upstream-request-1" } });
    };
    const runtime = { fetch: fetcher, createRequestId: () => "frontend-request-1", nowSeconds: () => 1_800_000_000, createJti: () => "fixed-jti" };
    const publicClient = createPublicCourseClient(config, runtime);
    await publicClient.listCourses();
    await publicClient.getCourseBySlug("classic/lashes ?");
    const studentClient = createStudentCourseClient(config, "user_1", runtime);
    await studentClient.getCourse("course/id");
    const internalClient = createInternalEntitlementClient(config, runtime);
    const grant = { userId: "user_1", courseId, orderId: "order_1", externalPaymentId: "payment_1", provider: "helcim", idempotencyKey: "grant-key", grantReason: "purchase", grantedAt: now, expiresAt: null };
    const revoke = { userId: "user_1", courseId, orderId: "order_1", revokeReason: "refund", idempotencyKey: "revoke-key", revokedAt: now };
      await internalClient.grant(grant, { correlationId: "outbox-job-1" });
    await internalClient.revoke(revoke);
    await internalClient.check({ userId: "user/with space", courseId });
    await internalClient.reconcile({ checkpoint: now, pageSize: 10, snapshotComplete: false, scopes: [{ userId: "user_1", courseId }], grants: [{ userId: "user_1", courseId, orderId: "order_1", expectedStatus: "active" }] });

    assert.equal(calls[0].input, "https://course.example.test/base/v1/courses");
    assert.equal(calls[1].input, "https://course.example.test/base/v1/courses/classic%2Flashes%20%3F");
    assert.equal(calls[2].input, "https://course.example.test/base/v1/student/courses/course%2Fid");
    assert.equal(calls.some((call) => call.input.endsWith("/v1/student/courses")), false);
    assert.equal(calls[5].input, "https://course.example.test/base/v1/internal/entitlements?userId=user%2Fwith+space&courseId=11111111-1111-4111-8111-111111111111");
    assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
    assert.equal(new Headers(calls[0].init.headers).get("accept"), "application/json");
    assert.equal(new Headers(calls[0].init.headers).get("x-request-id"), "frontend-request-1");
    assert.match(new Headers(calls[2].init.headers).get("authorization"), /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    for (const call of calls.slice(2)) assert.equal(call.init.cache, "no-store");
      assert.equal(new Headers(calls[3].init.headers).get("x-request-id"), "outbox-job-1");
      assert.equal(new Headers(calls[3].init.headers).get("x-idempotency-key"), grant.idempotencyKey);
    assert.equal(JSON.parse(calls[3].init.body).idempotencyKey, grant.idempotencyKey);
    assert.deepEqual(JSON.parse(calls[3].init.body), grant);
    assert.equal(new Headers(calls[4].init.headers).get("x-idempotency-key"), revoke.idempotencyKey);
    assert.deepEqual(JSON.parse(calls[4].init.body), revoke);
    assert.equal(JSON.parse(calls[6].init.body).checkpoint, now);

    const statusCases = [
      [400, "request", false], [401, "auth", false], [403, "auth", false],
      [404, "request", false], [409, "request", false], [422, "request", false],
      [429, "rate_limit", true], [500, "upstream", true], [503, "upstream", true],
    ];
    for (const [status, kind, retryable] of statusCases) {
      const token = "secret-token-must-not-leak";
      const failing = createPublicCourseClient(config, {
        createRequestId: () => "local-request",
        fetch: async () => new Response(JSON.stringify({ error: { code: "UPSTREAM_CODE", message: token } }), {
          status,
          headers: { "retry-after": "7", "x-request-id": "provider-request" },
        }),
      });
      await assert.rejects(failing.listCourses(), (error) => {
        assert.ok(error instanceof CourseApiError);
        assert.equal(error.kind, kind);
        assert.equal(error.status, status);
        assert.equal(error.retryable, retryable);
        assert.equal(error.retryAfter, 7);
        assert.equal(error.requestId, "provider-request");
        assert.equal(error.upstreamCode, "UPSTREAM_CODE");
        const serialized = JSON.stringify(error) + error.message;
        assert.equal(serialized.includes(token), false);
        assert.equal(serialized.includes("https://course.example.test"), false);
        return true;
      });
    }

    const networkClient = createPublicCourseClient(config, { fetch: async () => { throw new Error("secret-token-must-not-leak"); } });
    await assert.rejects(networkClient.listCourses(), (error) => error instanceof CourseApiError && error.kind === "network" && error.retryable && !error.message.includes("secret"));

    const timeoutClient = createPublicCourseClient({ ...config, timeoutMs: 5 }, {
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    });
    await assert.rejects(timeoutClient.listCourses(), (error) => error instanceof CourseApiError && error.kind === "timeout" && error.retryable);

    const caller = new AbortController();
    caller.abort();
    const abortedClient = createPublicCourseClient(config, { fetch: async (_input, init) => { assert.equal(init.signal.aborted, true); throw new Error("aborted"); } });
      await assert.rejects(abortedClient.listCourses({ signal: caller.signal }), (error) => error instanceof CourseApiError && error.kind === "aborted" && !error.retryable);

    const malformedClient = createPublicCourseClient(config, { fetch: async () => Response.json({ courses: [{ ...summary, id: "invalid" }] }) });
    await assert.rejects(malformedClient.listCourses(), (error) => error instanceof CourseApiError && error.kind === "invalid_response");
  `);
});

function runScenario(source: string): void {
  const importBlock = source.match(/^\s*((?:import[\s\S]*?;\s*)+)/u);
  if (importBlock === null) {
    throw new Error("Course API test scenario must begin with imports");
  }
  const body = source.slice(importBlock[0].length);
  const script = String.raw`
    ${importBlock[1]}
    import assert from "node:assert/strict";
    void (async () => {
      ${body}
    })();
  `;

  execFileSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
}
