import assert from "node:assert/strict";
import test from "node:test";
import { loadCourseAuthoringPage } from "./page-data";

test("authoring page admission refuses before staff resolution or Course loading and exposes a safe error", async () => {
  const prior = process.env.FRONTEND_WRITER_ADMISSION_MODE;
  // Invalid configuration refuses before opening SQL or requiring a Next
  // request scope. Calling staff resolution first would throw outside a request.
  process.env.FRONTEND_WRITER_ADMISSION_MODE = "invalid-test-mode";
  try {
    let loaded = false;
    const result = await loadCourseAuthoringPage(async () => {
      loaded = true;
      return "unreachable";
    });
    assert.equal(loaded, false);
    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") assert.fail("Expected safe refusal");
    assert.equal(result.error.status, 503);
    assert.equal(result.error.code, "service_unavailable");
    assert.equal(
      result.error.message,
      "The service is temporarily unavailable.",
    );
    assert.match(result.error.requestId, /^[a-f0-9-]{36}$/u);
    assert.doesNotMatch(
      result.error.message,
      /configuration|Writer admission/u,
    );
  } finally {
    if (prior === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
    else process.env.FRONTEND_WRITER_ADMISSION_MODE = prior;
  }
});
