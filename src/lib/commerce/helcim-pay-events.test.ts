import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getHelcimPayEventOutcome } from "./helcim-pay-events";

describe("getHelcimPayEventOutcome", () => {
  it("classifies completed and dismissed HelcimPay iframe statuses", () => {
    assert.equal(getHelcimPayEventOutcome("SUCCESS"), "success");
    assert.equal(getHelcimPayEventOutcome("ABORTED"), "dismissed");
    assert.equal(getHelcimPayEventOutcome("HIDE"), "dismissed");
  });

  it("treats terminal non-success statuses as failed checkout attempts", () => {
    assert.equal(getHelcimPayEventOutcome("DECLINED"), "failed");
    assert.equal(getHelcimPayEventOutcome("ERROR"), "failed");
  });

  it("ignores malformed statuses", () => {
    assert.equal(getHelcimPayEventOutcome(undefined), "ignored");
    assert.equal(getHelcimPayEventOutcome(null), "ignored");
    assert.equal(getHelcimPayEventOutcome(""), "ignored");
    assert.equal(getHelcimPayEventOutcome("   "), "ignored");
    assert.equal(getHelcimPayEventOutcome(200), "ignored");
  });
});
