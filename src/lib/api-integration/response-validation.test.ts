import assert from "node:assert/strict";
import test from "node:test";
import course from "../../../contracts/api-integration/v1/course-api.json";
import community from "../../../contracts/api-integration/v1/community-api.json";
import {
  ApiContractError,
  parseCourseResponse,
  parseCommunityResponse,
  validateApiResponse,
} from "./response-validation";

test("generated response types are guarded by non-coercing runtime validation", () => {
  const value = {
    courses: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Course",
        slug: "course",
        description: null,
        priceCents: 100,
        currency: "CAD",
      },
    ],
  };
  assert.equal(
    parseCourseResponse("/v1/courses", "get", 200, value).courses[0].priceCents,
    100,
  );
  assert.throws(
    () =>
      parseCourseResponse("/v1/courses", "get", 200, {
        courses: [{ ...value.courses[0], priceCents: "100" }],
      }),
    ApiContractError,
  );
  assert.throws(
    () =>
      parseCourseResponse("/v1/courses", "get", 200, {
        courses: [{ ...value.courses[0], id: "invalid" }],
      }),
    ApiContractError,
  );
});

test("error validation preserves existing Course and Community wire shapes", () => {
  const error = {
    error: { code: "UNAUTHORIZED", message: "Authentication required" },
  };
  assert.equal(
    parseCourseResponse("/v1/internal/entitlements/grants", "post", 401, error)
      .error.code,
    "UNAUTHORIZED",
  );
  assert.throws(() =>
    parseCommunityResponse(
      "/v1/internal/course/enrollment-events",
      "post",
      401,
      error,
    ),
  );
  assert.equal(
    parseCommunityResponse(
      "/v1/internal/course/enrollment-events",
      "post",
      401,
      { ...error, requestId: "request-1" },
    ).requestId,
    "request-1",
  );
  assert.equal(
    parseCourseResponse("/v1/courses", "get", 429, {
      error: { code: "TOO_MANY_REQUESTS", message: "Retry later" },
    }).error.code,
    "TOO_MANY_REQUESTS",
  );
});

test("unexpected routes/statuses fail closed without disclosing the upstream body", () => {
  for (const [path, status] of [
    ["/arbitrary", 200],
    ["/v1/courses", 299],
  ] as const) {
    assert.throws(
      () =>
        validateApiResponse("course", path, "get", status, {
          token: "private-token",
        }),
      (error: unknown) =>
        error instanceof ApiContractError &&
        !error.message.includes("private-token"),
    );
  }
  const eventId = "11111111-1111-4111-8111-111111111111";
  const response = { eventId, status: "accepted", private: "sensitive" };
  assert.throws(() =>
    parseCommunityResponse(
      "/v1/internal/course/enrollment-events",
      "post",
      202,
      response,
    ),
  );
  assert.equal(response.private, "sensitive");
});

test("every documented JSON response schema compiles, including local references", () => {
  for (const [service, document] of [
    ["course", course],
    ["community", community],
  ] as const) {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (
          typeof operation !== "object" ||
          operation === null ||
          !("responses" in operation) ||
          typeof operation.responses !== "object" ||
          operation.responses === null
        )
          continue;
        for (const status of Object.keys(operation.responses)) {
          try {
            validateApiResponse(
              service,
              path,
              method as "get",
              Number(status),
              null,
            );
          } catch (error) {
            assert.ok(
              error instanceof ApiContractError,
              `${service} ${method} ${path} ${status}: ${String(error)}`,
            );
          }
        }
      }
    }
  }
});
