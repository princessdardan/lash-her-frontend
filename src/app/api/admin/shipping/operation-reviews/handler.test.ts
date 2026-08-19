import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createOperationReviewHandler } from "./handler";

const actorId = "11111111-1111-4111-8111-111111111111";
const entityId = "22222222-2222-4222-8222-222222222222";

test("operation review binds step-up to the exact action, version, evidence, and rationale", async () => {
  const targets: string[] = [];
  const handler = createOperationReviewHandler({
    audit: async () => undefined,
    requireConfiguredOwner: async () => ({
      id: actorId,
      displayName: null,
      email: "owner@example.test",
    }),
    requireEnforce: () => undefined,
    requireManage: async () => ({ user: { id: actorId } }),
    requireStepUp: async (scope) => {
      targets.push(scope.target);
      throw new Error("Step-up proof is required for this action");
    },
  });

  const first = await handler(request(payload()), {
    entityId,
    kind: "provider_job",
  });
  const changed = await handler(
    request({ ...payload(), rationale: "A different reviewed rationale" }),
    { entityId, kind: "provider_job" },
  );
  const changedEvidence = await handler(
    request({ ...payload(), evidenceReference: "provider-case-456" }),
    { entityId, kind: "provider_job" },
  );
  const changedVersion = await handler(
    request({ ...payload(), expectedStateVersion: 4 }),
    { entityId, kind: "provider_job" },
  );
  assert.equal(first.status, 409);
  assert.equal(changed.status, 409);
  assert.equal(changedEvidence.status, 409);
  assert.equal(changedVersion.status, 409);
  assert.equal(targets.length, 4);
  assert.equal(new Set(targets).size, 4);
  const body = (await first.json()) as {
    stepUp: { action: string; target: string; targetLabel: string };
  };
  assert.equal(
    body.stepUp.action,
    "operations:provider_job:request_reconciliation",
  );
  assert.equal(body.stepUp.target, targets[0]);
  assert.match(body.stepUp.target, /^sha256:[0-9a-f]{64}$/);
  assert.match(body.stepUp.targetLabel, new RegExp(entityId));
});

test("operation review rejects an action mismatch before step-up or mutation", async () => {
  let stepUpCalled = false;
  let mutationCalled = false;
  const handler = createOperationReviewHandler({
    audit: async () => undefined,
    requireConfiguredOwner: async () => ({
      id: actorId,
      displayName: null,
      email: "owner@example.test",
    }),
    requireEnforce: () => undefined,
    requireManage: async () => ({ user: { id: actorId } }),
    requireStepUp: async () => {
      stepUpCalled = true;
      return new Date();
    },
    reviewOperation: async () => {
      mutationCalled = true;
      return { id: entityId, stateVersion: 2, status: "queued" };
    },
  });
  const response = await handler(
    request({ ...payload(), action: "blind_retry" }),
    { entityId, kind: "provider_job" },
  );
  assert.equal(response.status, 400);
  assert.equal(stepUpCalled, false);
  assert.equal(mutationCalled, false);
});

test("operation review enforces configured owner, same origin, and enforce mode", async () => {
  const notOwner = createOperationReviewHandler({
    requireConfiguredOwner: async () => {
      throw new Error("not owner");
    },
    requireManage: async () => ({ user: { id: actorId } }),
  });
  assert.equal(
    (await notOwner(request(payload()), { entityId, kind: "refund" })).status,
    403,
  );

  const base = {
    audit: async () => undefined,
    requireConfiguredOwner: async () => ({
      id: actorId,
      displayName: null,
      email: "owner@example.test",
    }),
    requireManage: async () => ({ user: { id: actorId } }),
  };
  const wrongOrigin = createOperationReviewHandler({
    ...base,
    requireEnforce: () => undefined,
  });
  assert.equal(
    (
      await wrongOrigin(request(payload(), "https://attacker.example"), {
        entityId,
        kind: "refund",
      })
    ).status,
    403,
  );

  const observe = createOperationReviewHandler({
    ...base,
    requireEnforce: () => {
      throw new Error("observe");
    },
  });
  assert.equal(
    (await observe(request(payload()), { entityId, kind: "refund" })).status,
    409,
  );
});

test("dead-letter review requests reconciliation without accepting a retry action", async () => {
  const captured: Record<string, unknown>[] = [];
  const handler = createOperationReviewHandler({
    audit: async () => undefined,
    requireConfiguredOwner: async () => ({
      id: actorId,
      displayName: null,
      email: "owner@example.test",
    }),
    requireEnforce: () => undefined,
    requireManage: async () => ({ user: { id: actorId } }),
    requireStepUp: async () => new Date("2026-08-15T12:00:00.000Z"),
    reviewOperation: async (input) => {
      captured.push(input as unknown as Record<string, unknown>);
      return { id: entityId, stateVersion: 4, status: "queued" };
    },
  });
  const response = await handler(request(payload()), {
    entityId,
    kind: "provider_job",
  });
  assert.equal(response.status, 202);
  assert.equal(captured[0]?.kind, "provider_job");
  assert.equal(captured[0]?.expectedStateVersion, 3);
  assert.equal(captured[0]?.evidenceReference, "provider-case-123");
});

test("return observation uses its dedicated resolution dependency", async () => {
  let returnCalled = false;
  let genericCalled = false;
  const handler = createOperationReviewHandler({
    audit: async () => undefined,
    requireConfiguredOwner: async () => ({
      id: actorId,
      displayName: null,
      email: "owner@example.test",
    }),
    requireEnforce: () => undefined,
    requireManage: async () => ({ user: { id: actorId } }),
    requireStepUp: async () => new Date("2026-08-15T12:00:00.000Z"),
    resolveReturn: async () => {
      returnCalled = true;
      return { id: entityId, stateVersion: 2 };
    },
    reviewOperation: async () => {
      genericCalled = true;
      return { id: entityId, stateVersion: 2, status: "unexpected" };
    },
  });
  const response = await handler(
    request({ ...payload(), action: "escalate_unmatched_return" }),
    { entityId, kind: "return_observation" },
  );
  assert.equal(response.status, 200);
  assert.equal(returnCalled, true);
  assert.equal(genericCalled, false);
});

function payload(): Record<string, unknown> {
  return {
    action: "request_reconciliation",
    evidenceReference: "provider-case-123",
    expectedStateVersion: 3,
    rationale: "Provider evidence was reviewed and reconciliation is required.",
  };
}

function request(
  body: Record<string, unknown>,
  origin = "https://admin.example.test",
): NextRequest {
  return new NextRequest(
    "https://admin.example.test/api/admin/shipping/operation-reviews/provider_job/22222222-2222-4222-8222-222222222222",
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    },
  );
}
