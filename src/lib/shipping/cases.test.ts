import assert from "node:assert/strict";
import test from "node:test";

import { nextOperatorCaseStatus } from "./cases";

test("operator shipping-case transitions keep active states directed", () => {
  assert.equal(nextOperatorCaseStatus("open", "acknowledge"), "open");
  assert.equal(
    nextOperatorCaseStatus("waiting_customer", "claim"),
    "waiting_provider",
  );
  assert.equal(
    nextOperatorCaseStatus("waiting_provider", "inspect"),
    "remedy_pending",
  );
  assert.equal(nextOperatorCaseStatus("remedy_pending", "resolve"), "resolved");
  assert.equal(nextOperatorCaseStatus("remedy_pending", "claim"), null);
});

test("operator shipping-case transitions never reopen terminal cases", () => {
  for (const status of ["resolved", "cancelled"] as const) {
    for (const action of [
      "acknowledge",
      "claim",
      "inspect",
      "resolve",
    ] as const) {
      assert.equal(nextOperatorCaseStatus(status, action), null);
    }
  }
});
