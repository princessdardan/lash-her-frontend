import assert from "node:assert/strict";
import test from "node:test";
import { authoringRequest, AuthoringRequestError } from "./browser";
test("authoring browser requests stay on explicit same-origin admin handlers with CSRF and private fetch settings", async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (path, options) => {
    count++;
    assert.equal(path, "/api/admin/courses");
    assert.equal(options?.method, "POST");
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("x-lash-csrf"), "1");
    assert.equal(options?.body, JSON.stringify({ title: "Course" }));
    return Response.json({ course: { id: "fixture" } });
  };
  try {
    assert.deepEqual(
      await authoringRequest("/api/admin/courses", "POST", { title: "Course" }),
      { course: { id: "fixture" } },
    );
    for (const path of [
      "https://example.com/api/admin/courses",
      "//example.com/api/admin/courses",
      "/api/admin/../accounts",
      "/api/admin/%2e%2e/accounts",
      "/api/admin/courses?credentials=1",
    ])
      await assert.rejects(
        authoringRequest(path),
        (error) =>
          error instanceof AuthoringRequestError && error.status === 400,
      );
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("unconfirmed writes are never automatically replayed and raw responses or transport details stay out of UI errors", async () => {
  const original = globalThis.fetch;
  let count = 0;
  try {
    globalThis.fetch = async () => {
      count++;
      return Response.json(
        { error: { message: "private provider body" } },
        { status: 503, headers: { "x-request-id": "private-reference" } },
      );
    };
    await assert.rejects(
      authoringRequest("/api/admin/courses", "POST", {}),
      (error) =>
        error instanceof AuthoringRequestError &&
        error.status === 503 &&
        error.requestId === undefined &&
        !error.message.includes("private"),
    );
    assert.equal(count, 1);
    globalThis.fetch = async () =>
      new Response("private invalid json", {
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      authoringRequest("/api/admin/courses"),
      (error) =>
        error instanceof AuthoringRequestError &&
        !error.message.includes("private"),
    );
    globalThis.fetch = async () => {
      throw new Error("private network URL");
    };
    await assert.rejects(
      authoringRequest("/api/admin/courses"),
      (error) =>
        error instanceof AuthoringRequestError &&
        !error.message.includes("private"),
    );
  } finally {
    globalThis.fetch = original;
  }
});
