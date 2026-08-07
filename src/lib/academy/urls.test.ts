import assert from "node:assert/strict";
import test from "node:test";

import { getAcademyPrincipal } from "./auth";
import { normalizeAcademyBasePath } from "./config";
import {
  academyCourseApiUrl,
  academyCourseUrl,
  academyLessonApiUrl,
  academyLessonUrl,
  academyPlaybackApiUrl,
  academyProgressApiUrl,
  getSafeAcademyReturnTo,
} from "./urls";

test("academy URL helpers encode every dynamic identifier", () => {
  assert.equal(
    academyCourseUrl("course/one?draft", "/academy"),
    "/academy/courses/course%2Fone%3Fdraft",
  );
  assert.equal(
    academyLessonUrl("course one", "lesson/#1", "/academy"),
    "/academy/courses/course%20one/lessons/lesson%2F%231",
  );
  assert.equal(
    academyCourseApiUrl("course/one"),
    "/api/academy/courses/course%2Fone",
  );
  assert.equal(
    academyLessonApiUrl("course/one", "lesson one"),
    "/api/academy/courses/course%2Fone/lessons/lesson%20one",
  );
  assert.equal(
    academyPlaybackApiUrl("course/one", "lesson one"),
    "/api/academy/courses/course%2Fone/lessons/lesson%20one/playback",
  );
  assert.equal(
    academyProgressApiUrl("course/one", "lesson one"),
    "/api/academy/courses/course%2Fone/lessons/lesson%20one/progress",
  );
});

test("academy configuration rejects unsafe base paths", () => {
  assert.equal(normalizeAcademyBasePath(undefined), "/academy");
  assert.equal(normalizeAcademyBasePath("/learning/"), "/academy");
  assert.equal(normalizeAcademyBasePath("/academy"), "/academy");
  assert.equal(normalizeAcademyBasePath("https://attacker.test"), "/academy");
  assert.equal(normalizeAcademyBasePath("//attacker.test"), "/academy");
  assert.equal(normalizeAcademyBasePath("/academy/../admin"), "/academy");
});

test("academy return targets remain within the configured academy base", () => {
  assert.equal(
    getSafeAcademyReturnTo("/academy/courses/c-1?tab=notes", "/academy"),
    "/academy/courses/c-1?tab=notes",
  );
  assert.equal(
    getSafeAcademyReturnTo("https://attacker.test/academy", "/academy"),
    "/academy",
  );
  assert.equal(getSafeAcademyReturnTo("/admin", "/academy"), "/academy");
});

test("academy authentication requires canonical id and verified email", () => {
  assert.deepEqual(
    getAcademyPrincipal({
      user: {
        email: " student@example.test ",
        id: " user-1 ",
        isEmailVerified: true,
      },
    }),
    { email: "student@example.test", userId: "user-1" },
  );
  assert.equal(
    getAcademyPrincipal({
      user: { email: "student@example.test", isEmailVerified: true },
    }),
    null,
  );
  assert.equal(
    getAcademyPrincipal({
      user: {
        email: "student@example.test",
        id: "user-1",
        isEmailVerified: false,
      },
    }),
    null,
  );
});
