import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createFundingApprovalHandlers,
  fundingApprovalStepUpScope,
  type FundingApprovalRouteDependencies,
} from "./[reviewId]/approve/handler";

const reviewId = "11111111-1111-4111-8111-111111111111";
const actor = { user: { id: "22222222-2222-4222-8222-222222222222" } };

test("funding approval rejects non-owner and observe mode before step-up", async () => {
  let stepUps = 0;
  const nonOwner = createFundingApprovalHandlers(
    dependencies({
      requireConfiguredOwner: async () => {
        throw new Error("not owner");
      },
      requireStepUp: async () => {
        stepUps += 1;
        return new Date();
      },
    }),
  );
  assert.equal((await post(nonOwner, true)).status, 403);

  const observe = createFundingApprovalHandlers(
    dependencies({
      assertMutationAllowed: () => {
        throw new Error("observe");
      },
      requireStepUp: async () => {
        stepUps += 1;
        return new Date();
      },
    }),
  );
  assert.equal((await post(observe, true)).status, 409);
  assert.equal(stepUps, 0);
});

test("funding approval proof distinguishes approval from application", () => {
  const approve = fundingApprovalStepUpScope(reviewId, false);
  const apply = fundingApprovalStepUpScope(reviewId, true);
  assert.equal(approve.action, "shipping_funding:approve");
  assert.match(approve.target, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(approve.target, apply.target);
  assert.notEqual(
    approve.target,
    fundingApprovalStepUpScope("33333333-3333-4333-8333-333333333333", false)
      .target,
  );
});

test("funding approval forwards the exact review, owner, and application decision", async () => {
  let captured: Record<string, unknown> | undefined;
  const handlers = createFundingApprovalHandlers(
    dependencies({
      approve: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return { id: reviewId, status: "applied" } as never;
      },
    }),
  );
  const response = await post(handlers, true);
  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    actorAdminUserId: actor.user.id,
    markApplied: true,
    reviewId,
  });
});

test("funding approval rejects cross-origin requests and records CAS failures", async () => {
  const audits: Array<Record<string, unknown>> = [];
  const handlers = createFundingApprovalHandlers(
    dependencies({
      approve: async () => {
        throw new Error("Funding review is not awaiting approval");
      },
      recordAudit: async (input) => {
        audits.push(input as unknown as Record<string, unknown>);
      },
    }),
  );
  assert.equal(
    (await post(handlers, false, "https://attacker.invalid")).status,
    403,
  );
  const response = await post(handlers, false);
  assert.equal(response.status, 409);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.outcome, "failure");
  assert.equal(audits[0]?.targetId, reviewId);
});

function dependencies(
  overrides: Partial<FundingApprovalRouteDependencies> = {},
): FundingApprovalRouteDependencies {
  return {
    approve: async () => ({ id: reviewId, status: "approved" }) as never,
    assertMutationAllowed: () => undefined,
    recordAudit: async () => undefined,
    requireConfiguredOwner: async () => ({
      displayName: "Nataliea Lavoie",
      email: "owner@example.invalid",
      id: actor.user.id,
    }),
    requirePermission: async () => actor as never,
    requireStepUp: async () => new Date(),
    ...overrides,
  };
}

async function post(
  handlers: ReturnType<typeof createFundingApprovalHandlers>,
  markApplied: boolean,
  origin = "https://admin.example.test",
) {
  return handlers.POST(
    new NextRequest(
      `https://admin.example.test/api/admin/shipping/funding-reviews/${reviewId}/approve`,
      {
        body: JSON.stringify({ markApplied }),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      },
    ),
    { params: Promise.resolve({ reviewId }) },
  );
}
