import assert from "node:assert/strict";
import test from "node:test";

import {
  addressApprovalStepUpScope,
  addressRevocationStepUpScope,
} from "./address-approval-step-up";

const base = {
  action: "address_approval" as const,
  callbackEvidenceReference: "callback-evidence-123",
  expectedStateVersion: 4,
  rationale: "Verified against the original order phone call.",
  responsibility: "customer" as const,
};

test("address approval step-up binds the complete reviewed command", () => {
  const scope = addressApprovalStepUpScope("request-1", base);
  assert.equal(scope.action, "address:address_approval");
  assert.equal(
    scope.targetLabel,
    "Address request request-1: address approval",
  );
  for (const changed of [
    { ...base, action: "fraud_clearance" as const },
    { ...base, callbackEvidenceReference: "callback-evidence-456" },
    { ...base, expectedStateVersion: 5 },
    { ...base, rationale: "A different reviewed rationale was submitted." },
    { ...base, responsibility: "lash_her" as const },
  ]) {
    assert.notEqual(
      addressApprovalStepUpScope("request-1", changed).target,
      scope.target,
    );
  }
  assert.notEqual(
    addressApprovalStepUpScope("request-2", base).target,
    scope.target,
  );
});

test("address approval step-up is stable for the exact same payload", () => {
  assert.deepEqual(
    addressApprovalStepUpScope("request-1", base),
    addressApprovalStepUpScope("request-1", { ...base }),
  );
});

test("address revocation step-up binds request, version, rationale, and evidence", () => {
  const command = {
    evidenceReference: "provider-and-ledger-evidence-1",
    expectedStateVersion: 7,
    orderReference: "LH-1001",
    rationale: "Owner reviewed the exact paid supplement refund.",
    requestId: "request-7",
  };
  const scope = addressRevocationStepUpScope(command);
  assert.equal(scope.action, "address:revoke");
  for (const changed of [
    { ...command, evidenceReference: "provider-and-ledger-evidence-2" },
    { ...command, expectedStateVersion: 8 },
    { ...command, orderReference: "LH-1002" },
    { ...command, rationale: "Different revocation rationale and evidence." },
    { ...command, requestId: "request-8" },
  ]) {
    assert.notEqual(addressRevocationStepUpScope(changed).target, scope.target);
  }
});
