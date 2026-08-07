import assert from "node:assert/strict";
import test from "node:test";

import {
  AcademyCourseApiError,
  type AcademyCourseApi,
} from "@/lib/academy/course-api";
import { createAcademyCourseGetHandler } from "@/app/api/academy/courses/[courseId]/handler";
import { createAcademyProgressPostHandler } from "@/app/api/academy/courses/[courseId]/lessons/[lessonId]/progress/handler";

function createApi(
  overrides: Partial<AcademyCourseApi> = {},
): AcademyCourseApi {
  return {
    getCourse: async ({ courseId }) => ({
      id: courseId,
      lessons: [],
      title: "Course",
    }),
    getLesson: async ({ courseId, lessonId }) => ({
      courseId,
      id: lessonId,
      title: "Lesson",
    }),
    getPlayback: async () => ({
      expiresAt: "2026-08-07T12:00:00.000Z",
      playbackId: "playback-1",
      playbackToken: "playback-token",
    }),
    updateProgress: async ({ progress }) => ({
      completed: progress.completed ?? false,
      positionSeconds: progress.positionSeconds ?? 0,
    }),
    ...overrides,
  };
}

test("academy course handler requires a canonical verified session", async () => {
  let calls = 0;
  const handler = createAcademyCourseGetHandler({
    authenticate: async () => ({
      user: { email: "student@example.test", isEmailVerified: true },
    }),
    courseApi: createApi({
      getCourse: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    }),
    enabled: true,
    isCustomerActive: async () => true,
  });

  const response = await handler(
    new Request(
      "https://lash.test/api/academy/courses/course-1?userId=attacker",
    ),
    { params: Promise.resolve({ courseId: "course-1" }) },
  );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
  assert.match(response.headers.get("Cache-Control") ?? "", /private/);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
});

test("academy course handler derives user id only from the session", async () => {
  const calls: Array<{ courseId: string; userId: string }> = [];
  const handler = createAcademyCourseGetHandler({
    authenticate: async () => ({
      user: {
        email: "student@example.test",
        id: "canonical-user",
        isEmailVerified: true,
      },
    }),
    courseApi: createApi({
      getCourse: async (input) => {
        calls.push(input);
        return { id: input.courseId, lessons: [], title: "Course" };
      },
    }),
    enabled: true,
    isCustomerActive: async () => true,
  });

  const response = await handler(
    new Request(
      "https://lash.test/api/academy/courses/course-1?userId=attacker",
    ),
    { params: Promise.resolve({ courseId: "course-1" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ courseId: "course-1", userId: "canonical-user" }]);
  assert.equal(response.headers.get("Vary"), "Cookie");
});

test("academy course handler rejects a customer disabled after sign-in", async () => {
  let calls = 0;
  const handler = createAcademyCourseGetHandler({
    authenticate: async () => ({
      user: {
        email: "student@example.test",
        id: "disabled-customer",
        isEmailVerified: true,
      },
    }),
    courseApi: createApi({
      getCourse: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    }),
    enabled: true,
    isCustomerActive: async () => false,
  });

  const response = await handler(new Request("https://lash.test"), {
    params: Promise.resolve({ courseId: "course-1" }),
  });

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test("academy course handler fails closed when customer status cannot be read", async () => {
  const logs: unknown[] = [];
  const handler = createAcademyCourseGetHandler({
    authenticate: async () => ({
      user: {
        email: "student@example.test",
        id: "customer-1",
        isEmailVerified: true,
      },
    }),
    courseApi: createApi(),
    enabled: true,
    isCustomerActive: async () => {
      throw new Error("private database detail");
    },
    logError: (message, error) => logs.push({ message, error }),
  });

  const response = await handler(new Request("https://lash.test"), {
    params: Promise.resolve({ courseId: "course-1" }),
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "COURSE_API_UNAVAILABLE");
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /private database detail/);
});

for (const [code, status] of [
  ["ACCESS_REVOKED", 403],
  ["ARCHIVED_UNSUPPORTED", 409],
  ["COURSE_API_UNAVAILABLE", 503],
  ["NOT_FOUND", 404],
  ["PAYMENT_ACCESS_PROCESSING", 409],
  ["VIDEO_PROCESSING", 409],
] as const) {
  test(`academy course handler safely maps ${code}`, async () => {
    const handler = createAcademyCourseGetHandler({
      authenticate: async () => ({
        user: {
          email: "student@example.test",
          id: "user-1",
          isEmailVerified: true,
        },
      }),
      courseApi: createApi({
        getCourse: async () => {
          throw new AcademyCourseApiError(code, "private upstream detail");
        },
      }),
      enabled: true,
      isCustomerActive: async () => true,
    });
    const response = await handler(new Request("https://lash.test"), {
      params: Promise.resolve({ courseId: "course-1" }),
    });
    const body = await response.json();

    assert.equal(response.status, status);
    assert.equal(body.code, code);
    assert.doesNotMatch(JSON.stringify(body), /private upstream detail/);
  });
}

test("academy progress handler validates input and derives the user id", async () => {
  const calls: unknown[] = [];
  const handler = createAcademyProgressPostHandler({
    authenticate: async () => ({
      user: {
        email: "student@example.test",
        id: "canonical-user",
        isEmailVerified: true,
      },
    }),
    courseApi: createApi({
      updateProgress: async (input) => {
        calls.push(input);
        return {
          completed: false,
          positionSeconds: input.progress.positionSeconds ?? 0,
        };
      },
    }),
    enabled: true,
    isCustomerActive: async () => true,
  });
  const response = await handler(
    new Request("https://lash.test/api/academy/progress?userId=attacker", {
      method: "POST",
      body: JSON.stringify({ positionSeconds: 25 }),
    }),
    { params: Promise.resolve({ courseId: "course-1", lessonId: "lesson-1" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      courseId: "course-1",
      lessonId: "lesson-1",
      progress: { positionSeconds: 25 },
      userId: "canonical-user",
    },
  ]);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
});
