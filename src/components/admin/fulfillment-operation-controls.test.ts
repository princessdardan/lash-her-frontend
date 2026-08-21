import assert from "node:assert/strict";
import test from "node:test";

import type { AdminFulfillmentOperationRow } from "@/lib/admin/operations-workspaces";

import {
  buildFulfillmentOperationRequest,
  getFulfillmentOperationActionKind,
} from "./fulfillment-operation-controls";

test("return observations use the dedicated return endpoint and never the case endpoint", () => {
  const item = operation({
    kind: "return-observation",
    queue: "cases-claims-replacements-returns",
  });
  const kind = getFulfillmentOperationActionKind(item);
  assert.equal(kind, "return-review");
  assert.ok(kind);
  const form = new FormData();
  form.set("action", "escalate_unmatched_return");
  form.set("evidenceReference", "provider-case-123");
  form.set(
    "rationale",
    "The unmatched provider return was escalated for reconciliation.",
  );
  const request = buildFulfillmentOperationRequest(kind, item, form);
  assert.equal(
    request.url,
    `/api/admin/shipping/return-observations/${item.id}/resolve`,
  );
  assert.equal(request.body.expectedStateVersion, item.stateVersion);
  assert.equal(request.body.action, "escalate_unmatched_return");
  assert.doesNotMatch(request.url, /shipping-cases/);
});

test("unknown jobs, shipment review, decisions, and refunds map to typed controls", () => {
  const rows = [
    [
      "provider-job-dead-letter",
      "provider-job-review",
      "provider_job",
      "request_reconciliation",
    ],
    [
      "shipment-manual-review",
      "shipment-review",
      "shipment_generation",
      "acknowledge_manual_review",
    ],
    [
      "customer-decision-follow-up",
      "decision-review",
      "customer_decision",
      "record_legal_follow_up",
    ],
    [
      "refund-manual-review",
      "refund-review",
      "refund",
      "record_external_manual_handoff",
    ],
  ] as const;
  for (const [rowKind, expectedKind, pathKind, action] of rows) {
    const item = operation({ kind: rowKind, queue: queueFor(rowKind) });
    const kind = getFulfillmentOperationActionKind(item);
    assert.equal(kind, expectedKind);
    assert.ok(kind);
    const form = new FormData();
    form.set("evidenceReference", "evidence-reference-123");
    form.set(
      "rationale",
      "The exact entity evidence was reviewed for legal follow-up.",
    );
    const request = buildFulfillmentOperationRequest(kind, item, form);
    assert.equal(
      request.url,
      `/api/admin/shipping/operation-reviews/${pathKind}/${item.id}`,
    );
    assert.equal(request.body.action, action);
    assert.equal(request.body.expectedStateVersion, 7);
  }
});

test("quarantined entities remain reconciliation-only", () => {
  const item = operation({
    kind: "quarantine-provider-conflict",
    queue: "risk",
  });
  assert.equal(getFulfillmentOperationActionKind(item), null);
});

test("address apply binds the current version to its step-up proof", () => {
  const item = operation({
    kind: "address-change",
    queue: "addresses-and-supplements",
  });
  const kind = getFulfillmentOperationActionKind(item);
  assert.equal(kind, "address");
  assert.ok(kind);
  const form = new FormData();
  form.set("action", "apply");
  const request = buildFulfillmentOperationRequest(kind, item, form);
  assert.equal(request.url, `/api/admin/address-changes/${item.id}/apply`);
  assert.deepEqual(request.body, { expectedStateVersion: 7 });
  assert.deepEqual(request.stepUpScope, {
    action: "fulfillment.address_change_apply",
    target: JSON.stringify({ requestId: item.id, expectedStateVersion: 7 }),
  });
});

test("unresolved Square initialization exposes the typed reconciliation endpoint", () => {
  const item = operation({
    kind: "payment-initialization-outcome_unknown",
    queue: "provider-jobs",
  });
  const kind = getFulfillmentOperationActionKind(item);
  assert.equal(kind, "payment-initialization-reconciliation");
  assert.ok(kind);
  const form = new FormData();
  form.set("action", "reconcile_and_retry");
  form.set("evidenceReference", "square://payment-link/obligation-check");
  form.set(
    "rationale",
    "Square shows no completed payment; safe to re-queue for an idempotent re-mint.",
  );
  const request = buildFulfillmentOperationRequest(kind, item, form);
  assert.equal(
    request.url,
    `/api/admin/orders/${item.orderReference}/payment-obligations/${item.id}/reconcile`,
  );
  assert.deepEqual(request.body, {
    action: "reconcile_and_retry",
    evidenceReference: "square://payment-link/obligation-check",
    expectedStateVersion: 7,
    rationale:
      "Square shows no completed payment; safe to re-queue for an idempotent re-mint.",
  });
});

test("manual-review initialization supports retry and manual handoff while deterministic failure is display-only", () => {
  const manual = operation({
    kind: "payment-initialization-manual_review",
    queue: "provider-jobs",
  });
  const kind = getFulfillmentOperationActionKind(manual);
  assert.equal(kind, "payment-initialization-reconciliation");
  assert.ok(kind);
  for (const action of ["reconcile_and_retry", "record_manual_handoff"]) {
    const form = new FormData();
    form.set("action", action);
    form.set("evidenceReference", "square://reconciliation/reviewed");
    form.set(
      "rationale",
      "Owner review confirms the selected reconciliation action.",
    );
    const request = buildFulfillmentOperationRequest(kind, manual, form);
    assert.equal(request.body.action, action);
    assert.equal(request.body.expectedStateVersion, 7);
    assert.equal(request.body.providerInvoiceId, undefined);
  }
  assert.equal(
    getFulfillmentOperationActionKind(
      operation({
        kind: "payment-initialization-failed",
        queue: "provider-jobs",
      }),
    ),
    null,
  );
});

function operation(
  overrides: Pick<AdminFulfillmentOperationRow, "kind" | "queue">,
): AdminFulfillmentOperationRow {
  return {
    conflictToken: "token",
    deadlineAt: null,
    detail: "detail",
    evidence: ["provider evidence"],
    id: "22222222-2222-4222-8222-222222222222",
    legalNextActions: ["review"],
    orderReference: "LH-123",
    stateVersion: 7,
    title: "operation",
    ...overrides,
  };
}

function queueFor(kind: string): AdminFulfillmentOperationRow["queue"] {
  if (kind === "provider-job-dead-letter") return "provider-jobs";
  if (kind === "shipment-manual-review") return "shipment-generations";
  if (kind === "customer-decision-follow-up") return "decisions-and-extensions";
  return "refunds";
}
