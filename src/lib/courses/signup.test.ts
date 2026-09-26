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
  name: "  Alex   Learner  ",
  email: " Learner@Example.COM ",
  phone: " +1 (416) 555-0123 ",
  instagram: " @lash.learner ",
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
      name: "Alex Learner",
      email: "Learner@Example.COM",
      phone: "+1 (416) 555-0123",
      instagram: "@lash.learner",
      courseId: "course-one",
      courseTitle: "Lash care",
      sourcePath: "/courses/lash-care",
      submittedAt: new Date(now),
    },
  ]);
});

test("invalid contact details, missing consent, honeypot and invalid course never write or grant", async () => {
  for (const change of [
    { name: "" },
    { name: "   " },
    { name: undefined },
    { name: 123 },
    { name: {} },
    { name: "Alex" },
    { name: "  Alex  " },
    { name: "Alex -" },
    { name: "123 456" },
    { name: "A".repeat(119) + " B" },
    { email: "invalid" },
    { email: "x".repeat(255) + "@example.com" },
    { phone: "" },
    { phone: "   " },
    { phone: undefined },
    { phone: 4165550123 },
    { phone: "123" },
    { phone: "1".repeat(16) },
    { phone: "416-555-0123 ext invalid" },
    { phone: "(".repeat(41) + "4165550123" },
    { instagram: "https://instagram.com/learner" },
    { instagram: "@" },
    { instagram: "x".repeat(31) },
    { instagram: {} },
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

test("full names support accents, apostrophes, hyphens and multiple parts", async () => {
  for (const name of [
    "Élodie O’Connor",
    "Anne-Marie van der Berg",
    "李 小龍",
    "A B",
    "A".repeat(118) + " B",
  ]) {
    const { dependencies, records } = fixture();
    assert.equal(
      (await signupForCourse({ ...input, name }, dependencies)).success,
      true,
    );
    assert.equal(records[0].name, name);
  }
});

test("full name whitespace is normalized before persistence", async () => {
  const { dependencies, records } = fixture();
  assert.equal(
    (
      await signupForCourse(
        { ...input, name: " \tAlex\u00a0 Marie\nLearner " },
        dependencies,
      )
    ).success,
    true,
  );
  assert.equal(records[0].name, "Alex Marie Learner");
});

test("missing or incomplete full names return an actionable field error", async () => {
  for (const name of ["", "Alex"]) {
    const { dependencies } = fixture();
    assert.deepEqual(await signupForCourse({ ...input, name }, dependencies), {
      success: false,
      fieldErrors: { name: "Enter your full name (first and last name)." },
    });
  }
});

test("Instagram is optional and common phone formats are accepted", async () => {
  for (const phone of ["4165550123", "+1 (416) 555-0123", "+44 20 7946 0123"]) {
    for (const instagram of [undefined, "", "  "]) {
      const { dependencies, records } = fixture();
      assert.equal(
        (await signupForCourse({ ...input, phone, instagram }, dependencies))
          .success,
        true,
      );
      assert.equal(records[0].phone, phone);
      assert.equal(records[0].instagram, undefined);
    }
  }
});

test("missing phone returns an actionable field error", async () => {
  const { dependencies } = fixture();
  assert.deepEqual(
    await signupForCourse({ ...input, phone: "" }, dependencies),
    {
      success: false,
      fieldErrors: { phone: "Enter a valid phone number." },
    },
  );
});

test("existing grants return without a new consent, rate-limit call or cookie renewal", async () => {
  const { dependencies, events } = fixture({
    getToken: async () =>
      createCourseAccessToken(input.courseId, secret, now).token,
  });
  assert.equal(
    (
      await signupForCourse(
        { ...input, name: "", phone: "", marketingConsent: false },
        dependencies,
      )
    ).success,
    true,
  );
  assert.deepEqual(events, []);
});

test("database failures report their stage and SQLSTATE without logging private data", async () => {
  const logged: unknown[] = [];
  const { dependencies, events } = fixture({
    recordSignup: async () => {
      throw new Error("Query contains private@example.com and a phone number", {
        cause: Object.assign(new Error("invalid course_signup enum value"), {
          code: "22P02",
          detail: "Private contact details",
        }),
      });
    },
    logError: (details) => {
      logged.push(details);
    },
  });
  assert.equal((await signupForCourse(input, dependencies)).success, false);
  assert.deepEqual(logged, [{ stage: "persistence", code: "22P02" }]);
  assert.ok(!events.includes("cookie"));
});

test("configuration, limiter, course and cookie failures have distinct diagnostics", async () => {
  for (const [method, stage] of [
    ["getSecret", "configuration"],
    ["getToken", "access"],
    ["checkRateLimit", "rate_limit"],
    ["getCourse", "course"],
    ["setCookie", "cookie"],
  ] as const) {
    const logged: unknown[] = [];
    const { dependencies } = fixture({
      [method]: () => {
        throw new Error("private failure details");
      },
      logError: (details) => {
        logged.push(details);
      },
    });
    assert.equal((await signupForCourse(input, dependencies)).success, false);
    assert.deepEqual(logged, [{ stage, code: undefined }]);
  }
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
