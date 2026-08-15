import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  intakeLocationStepUpScope,
  parseIntakeLocationMutationPayload,
} from "@/app/admin/(protected)/shipping-readiness/actions";

import {
  createShippingIntakeLocationHandlers,
  type IntakeLocationHandlerDependencies,
} from "./handler";

const actor = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
};

test("stale ordinary authentication cannot attest an intake location", async () => {
  let mutationCalled = false;
  const handlers = createShippingIntakeLocationHandlers(
    dependencies({
      executeMutation: async () => {
        mutationCalled = true;
        return { id: "unexpected" };
      },
      requireStepUp: async () => {
        throw new Error("Step-up authentication has expired");
      },
    }),
  );
  const response = await handlers.POST(request(attestPayload()));
  assert.equal(response.status, 409);
  assert.equal(mutationCalled, false);
  assert.equal(
    (await response.json()).error,
    "Step-up authentication has expired",
  );
});

test("a fresh ordinary session without an action proof cannot mutate", async () => {
  let mutationCalled = false;
  const handlers = createShippingIntakeLocationHandlers(
    dependencies({
      executeMutation: async () => {
        mutationCalled = true;
        return { id: "unexpected" };
      },
      requireStepUp: async () => {
        throw new Error("Step-up proof is required for this action");
      },
    }),
  );
  const body = attestPayload();
  const response = await handlers.POST(request(body));
  const result = (await response.json()) as {
    error: string;
    stepUp: ReturnType<typeof intakeLocationStepUpScope>;
  };
  assert.equal(response.status, 409);
  assert.equal(result.error, "Step-up proof is required for this action");
  assert.deepEqual(
    result.stepUp,
    intakeLocationStepUpScope(parseIntakeLocationMutationPayload(body)),
  );
  assert.equal(mutationCalled, false);
});

test("an exact fresh step-up proof executes the unchanged attestation", async () => {
  const body = attestPayload();
  const expectedScope = intakeLocationStepUpScope(
    parseIntakeLocationMutationPayload(body),
  );
  const captured: Array<Record<string, unknown>> = [];
  const authenticatedAt = new Date("2026-08-15T16:00:00.000Z");
  const handlers = createShippingIntakeLocationHandlers(
    dependencies({
      executeMutation: async (input) => {
        captured.push(input as unknown as Record<string, unknown>);
        return { id: "22222222-2222-4222-8222-222222222222" };
      },
      requireStepUp: async (scope) => {
        assert.deepEqual(scope, expectedScope);
        return authenticatedAt;
      },
    }),
  );
  const response = await handlers.POST(request(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "22222222-2222-4222-8222-222222222222",
    ok: true,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.actorAdminUserId, actor.user.id);
  assert.equal(captured[0]?.stepUpAuthenticatedAt, authenticatedAt);
  assert.deepEqual(
    captured[0]?.payload,
    parseIntakeLocationMutationPayload(body),
  );
});

test("a proof for one payload rejects a changed full address", async () => {
  const original = attestPayload();
  const originalScope = intakeLocationStepUpScope(
    parseIntakeLocationMutationPayload(original),
  );
  let mutationCalled = false;
  const handlers = createShippingIntakeLocationHandlers(
    dependencies({
      executeMutation: async () => {
        mutationCalled = true;
        return { id: "unexpected" };
      },
      requireStepUp: async (scope) => {
        assert.notEqual(scope.target, originalScope.target);
        throw new Error("Step-up proof does not match this action");
      },
    }),
  );
  const response = await handlers.POST(
    request({
      ...original,
      locationAddress: "200 Changed Street, Toronto, ON",
    }),
  );
  assert.equal(response.status, 409);
  assert.equal(mutationCalled, false);
  assert.equal(
    (await response.json()).error,
    "Step-up proof does not match this action",
  );
});

test("revocation proof binds reason, current policy version, and record id", () => {
  const base = parseIntakeLocationMutationPayload(revokePayload());
  const scope = intakeLocationStepUpScope(base);
  for (const changed of [
    { ...revokePayload(), reason: "A different verified revocation reason." },
    { ...revokePayload(), expectedCurrentPolicyVersion: "policy-v2" },
    {
      ...revokePayload(),
      expectedCurrentAttestationId: "33333333-3333-4333-8333-333333333333",
    },
  ]) {
    assert.notEqual(
      intakeLocationStepUpScope(parseIntakeLocationMutationPayload(changed))
        .target,
      scope.target,
    );
  }
});

test("a non-configured owner is rejected before step-up or mutation", async () => {
  let stepUpCalled = false;
  let mutationCalled = false;
  const handlers = createShippingIntakeLocationHandlers(
    dependencies({
      executeMutation: async () => {
        mutationCalled = true;
        return { id: "unexpected" };
      },
      requireConfiguredOwner: async () => {
        throw new Error(
          "The sole configured fulfillment owner must perform this action",
        );
      },
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
    }),
  );
  const response = await handlers.POST(request(attestPayload()));
  assert.equal(response.status, 403);
  assert.equal(stepUpCalled, false);
  assert.equal(mutationCalled, false);
});

test("observe mode rejects intake mutations before step-up", async () => {
  let stepUpCalled = false;
  const handlers = createShippingIntakeLocationHandlers(
    dependencies({
      assertMutationAllowed: () => {
        throw new Error("observe");
      },
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
    }),
  );
  const response = await handlers.POST(request(attestPayload()));
  assert.equal(response.status, 409);
  assert.equal(stepUpCalled, false);
});

function dependencies(
  overrides: Partial<IntakeLocationHandlerDependencies> = {},
): IntakeLocationHandlerDependencies {
  return {
    assertMutationAllowed: () => undefined,
    executeMutation: async () => ({
      id: "22222222-2222-4222-8222-222222222222",
    }),
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

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    "https://admin.example.test/api/admin/shipping/intake-location",
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin: "https://admin.example.test",
      },
      method: "POST",
    },
  );
}

function attestPayload(): Record<string, unknown> {
  return {
    action: "attest",
    evidenceReference: "evidence://chitchats/intake/verified",
    expectedCurrentAttestationId: null,
    locationAddress: "100 Intake Street, Toronto, ON",
    locationName: "Toronto intake",
    locationType: "branch",
    rationale: "Verified against the controlled provider evidence.",
    statementConfirmed: true,
    statementVersion: "chitchats-intake-location/v1",
  };
}

function revokePayload(): Record<string, unknown> {
  return {
    action: "revoke",
    expectedCurrentAttestationId: "22222222-2222-4222-8222-222222222222",
    expectedCurrentPolicyVersion: "policy-v1",
    reason: "The verified physical intake location is no longer active.",
  };
}
