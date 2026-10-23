import assert from "node:assert/strict";
import test from "node:test";
import { parseApiClaims, parseBoundary } from "./boundary-validation";

const id = "11111111-1111-4111-8111-111111111111";
const claims = {
  version: 1,
  iss: "lash-her-frontend",
  aud: "lash-her-course-api:learner",
  sub: id,
  iat: 1000,
  exp: 1300,
  jti: id,
};

test("learner/member/admin claims bind audience, canonical identity and capabilities", () => {
  assert.equal(parseApiClaims("CourseLearnerClaims", claims, 1000).sub, id);
  assert.throws(() => parseApiClaims("CommunityMemberClaims", claims, 1000));
  assert.throws(() =>
    parseApiClaims(
      "CourseAdminClaims",
      { ...claims, aud: "lash-her-course-api:admin" },
      1000,
    ),
  );
  assert.deepEqual(
    parseApiClaims(
      "CourseAdminClaims",
      {
        ...claims,
        aud: "lash-her-course-api:admin",
        capabilities: ["course-support"],
      },
      1000,
    ).capabilities,
    ["course-support"],
  );
  for (const patch of [
    { sub: "USER-1" },
    { sub: id.toUpperCase().replace("11111111", "ABCDEFAB") },
    { iss: "another-service" },
    { email: "private@example.test" },
    { exp: undefined },
    { version: 2 },
  ]) {
    assert.throws(() =>
      parseApiClaims("CourseLearnerClaims", { ...claims, ...patch }, 1000),
    );
  }
  assert.throws(() =>
    parseApiClaims(
      "CourseAdminClaims",
      {
        ...claims,
        aud: "lash-her-course-api:admin",
        capabilities: ["community-moderator"],
      },
      1000,
    ),
  );
});

test("JWT lifetime rejects missing, unbounded, fractional, expired and future claims", () => {
  for (const patch of [
    { exp: 1301 },
    { iat: 1031 },
    { exp: 1000 },
    { iat: 1000.5 },
    { iat: undefined },
    { exp: -1 },
  ]) {
    assert.throws(() =>
      parseApiClaims("CourseLearnerClaims", { ...claims, ...patch }, 1000),
    );
  }
  assert.throws(() => parseApiClaims("CourseLearnerClaims", claims, 1330));
  assert.throws(() => parseApiClaims("CourseLearnerClaims", claims, NaN));
  assert.equal(parseApiClaims("CourseLearnerClaims", claims, 1329).exp, 1300);
});

test("durable lifecycle commands reject private data and invalid sequence numbers", () => {
  const command = {
    version: 1,
    commandId: id,
    userId: id,
    accountVersion: 1,
    action: "suspend",
    issuedAt: "2026-10-04T12:00:00Z",
  };
  assert.equal(
    parseBoundary("AccountLifecycleCommand", command).action,
    "suspend",
  );
  for (const patch of [
    { accountVersion: 0 },
    { accountVersion: 1.2 },
    { accountVersion: "1" },
    { action: "erase_audit" },
    { email: "private@example.test" },
  ]) {
    assert.throws(() =>
      parseBoundary("AccountLifecycleCommand", { ...command, ...patch }),
    );
  }
});
