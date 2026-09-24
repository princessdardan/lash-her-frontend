import assert from "node:assert/strict";
import test from "node:test";
import {
  createCourseAccessToken,
  courseCookieName,
  verifyCourseAccessToken,
} from "./access-token";
import { COURSE_ACCESS_SECONDS } from "./contract";

const secret = "test-course-secret-012345678901234567890123456789";
const now = Date.parse("2026-09-23T12:00:00Z");

test("course cookies persist for exactly one year without contact information", () => {
  const { token, grant } = createCourseAccessToken("course-one", secret, now);
  assert.equal(grant.expiresAt, now / 1000 + COURSE_ACCESS_SECONDS);
  assert.deepEqual(
    verifyCourseAccessToken(token, "course-one", secret, now + 86_400_000),
    grant,
  );
  assert.deepEqual(Object.keys(grant).sort(), [
    "courseId",
    "expiresAt",
    "grantId",
    "version",
  ]);
  assert.match(courseCookieName("course-one"), /^lh_course_[a-f0-9]{24}$/);
  assert.notEqual(
    courseCookieName("course-one"),
    courseCookieName("course-two"),
  );
});

test("tampered, expired, malformed, wrong-course and wrong-key tokens fail closed", () => {
  const { token, grant } = createCourseAccessToken("course-one", secret, now);
  for (const bad of [
    undefined,
    "true",
    "{}",
    token + ".extra",
    token.slice(0, -1),
    "!" + token,
    "x".repeat(3000),
  ]) {
    assert.equal(verifyCourseAccessToken(bad, "course-one", secret, now), null);
  }
  const payload = Buffer.from(
    JSON.stringify({ ...grant, courseId: "course-two" }),
  ).toString("base64url");
  assert.equal(
    verifyCourseAccessToken(
      payload + "." + token.split(".")[1],
      "course-two",
      secret,
      now,
    ),
    null,
  );
  assert.equal(verifyCourseAccessToken(token, "course-two", secret, now), null);
  assert.equal(
    verifyCourseAccessToken(token, "course-one", secret + "rotated", now),
    null,
  );
  assert.equal(
    verifyCourseAccessToken(
      token,
      "course-one",
      secret,
      grant.expiresAt * 1000,
    ),
    null,
  );
  assert.throws(() => createCourseAccessToken("course-one", "short", now));
});
