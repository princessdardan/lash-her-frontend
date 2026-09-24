import assert from "node:assert/strict";
import test from "node:test";
import { signupForCourse, type CourseSignupDependencies } from "./signup";
import {
  createCourseAccessToken,
  verifyCourseAccessToken,
} from "./access-token";
import type { RecordCourseSignupInput } from "@/lib/marketing-contact/marketing-contact-store";

const secret = "test-course-secret-012345678901234567890123456789";
const input = {
  courseId: "course-one",
  email: " Learner@Example.COM ",
  marketingConsent: true,
};
const now = Date.parse("2026-09-23T12:00:00Z");

function fixture(overrides: Partial<CourseSignupDependencies> = {}) {
  const events: string[] = [];
  const records: RecordCourseSignupInput[] = [];
  const dependencies: CourseSignupDependencies = {
    getCourse: async () => ({
      _id: "course-one",
      slug: "lash-care",
      title: "Lash care",
      introduction: "Learn",
      modules: [{ _key: "module-one", title: "First lesson" }],
    }),
    getSecret: () => secret,
    getToken: async () => undefined,
    checkRateLimit: async () => {
      events.push("limit");
      return true;
    },
    recordSignup: async (record) => {
      events.push("persist");
      records.push(record);
    },
    setCookie: async (id, token) => {
      events.push("cookie");
      assert.ok(verifyCourseAccessToken(token, id, secret, now));
    },
    now: () => now,
    logError: () => events.push("error"),
    ...overrides,
  };
  return { dependencies, events, records };
}

test("signup saves server-derived course and consent context before setting access", async () => {
  const { dependencies, events, records } = fixture();
  assert.deepEqual(await signupForCourse(input, dependencies), {
    success: true,
  });
  assert.deepEqual(events, ["limit", "persist", "cookie"]);
  assert.deepEqual(records, [
    {
      email: "Learner@Example.COM",
      courseId: "course-one",
      courseTitle: "Lash care",
      sourcePath: "/courses/lash-care",
      submittedAt: new Date(now),
    },
  ]);
});

test("invalid email, missing consent, honeypot and invalid course never write or grant", async () => {
  for (const change of [
    { email: "invalid" },
    { email: "x".repeat(255) + "@example.com" },
    { marketingConsent: false },
    { marketingConsent: "true" },
    { company: "bot" },
    { courseId: "" },
  ]) {
    const { dependencies, events } = fixture();
    const result = await signupForCourse(
      { ...input, ...change } as typeof input,
      dependencies,
    );
    assert.equal(result.success, false);
    assert.deepEqual(events, []);
  }
});

test("existing grants return without a new consent, rate-limit call or cookie renewal", async () => {
  const { dependencies, events } = fixture({
    getToken: async () =>
      createCourseAccessToken(input.courseId, secret, now).token,
  });
  assert.equal(
    (await signupForCourse({ ...input, marketingConsent: false }, dependencies))
      .success,
    true,
  );
  assert.deepEqual(events, []);
});

test("persistence failure never grants access; limiter/configuration failures also fail closed", async () => {
  for (const overrides of [
    {
      recordSignup: async () => {
        throw new Error("DB unavailable");
      },
    },
    { checkRateLimit: async () => false },
    {
      checkRateLimit: async () => {
        throw new Error("Redis unavailable");
      },
    },
    { getCourse: async () => null },
    {
      getSecret: () => {
        throw new Error("Missing secret");
      },
    },
  ]) {
    const { dependencies, events } = fixture(overrides);
    assert.equal((await signupForCourse(input, dependencies)).success, false);
    assert.ok(!events.includes("cookie"));
  }
});
