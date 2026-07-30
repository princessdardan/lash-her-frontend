import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAdminMutationFailure,
  executeAdminMutationAttempt,
  getCommittedAdminAuditOutcome,
} from "./admin-transaction-policy";
import { AdminAuthError } from "./types";

test("a failure audit cannot mask the original mutation error", async () => {
  const original = new Error("Calendar connection not found");
  const auditFailure = new Error("audit database unavailable");

  await assert.rejects(
    executeAdminMutationAttempt(
      async () => {
        throw original;
      },
      async (error) => {
        assert.equal(error, original);
        throw auditFailure;
      },
    ),
    (error) => error === original,
  );
});

test("successful mutations do not write failure activity", async () => {
  let failureWriteCalled = false;
  const result = await executeAdminMutationAttempt(
    async () => "saved",
    async () => {
      failureWriteCalled = true;
    },
  );

  assert.equal(result, "saved");
  assert.equal(failureWriteCalled, false);
});

test("admin mutation failures use allowlisted outcome and reason codes", () => {
  assert.deepEqual(
    classifyAdminMutationFailure(new AdminAuthError("forbidden")),
    { outcome: "denied", reason: "insufficient_permission" },
  );
  assert.deepEqual(
    classifyAdminMutationFailure(
      Object.assign(new Error("duplicate"), { code: "23505" }),
    ),
    { outcome: "failure", reason: "conflict" },
  );
  assert.deepEqual(
    classifyAdminMutationFailure(new Error("Appointment not found")),
    { outcome: "failure", reason: "not_found" },
  );
  assert.deepEqual(
    classifyAdminMutationFailure(
      new Error("Google Calendar access could not be verified"),
    ),
    { outcome: "failure", reason: "dependency_unavailable" },
  );
  assert.deepEqual(
    classifyAdminMutationFailure(new Error("Invalid appointment state")),
    { outcome: "failure", reason: "validation_failed" },
  );
  assert.deepEqual(classifyAdminMutationFailure(new Error("unexpected")), {
    outcome: "failure",
    reason: "operation_failed",
  });
});

test("OAuth failure events are not presented as successful authorizations", () => {
  assert.equal(
    getCommittedAdminAuditOutcome("calendar_connection_authorization_failed"),
    "failure",
  );
  assert.equal(
    getCommittedAdminAuditOutcome("employee_calendar_authorization_failed"),
    "failure",
  );
  assert.equal(getCommittedAdminAuditOutcome("staff_created"), "success");
});
