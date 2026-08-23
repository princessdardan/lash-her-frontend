import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { PackageProfileConflictError } from "@/lib/shipping/package-profiles";

import {
  createPackageProfileCreateHandler,
  createPackageProfileMutationHandler,
} from "./handler";

const actorId = "11111111-1111-4111-8111-111111111111";
const entityId = "22222222-2222-4222-8222-222222222222";
const updatedAt = "2026-08-23T12:00:00.000Z";

function owner() {
  return { id: actorId, displayName: null, email: "owner@example.test" };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    audit: async () => undefined,
    requireConfiguredOwner: async () => owner(),
    requireConfigMutation: () => undefined,
    requireManage: async () => ({ user: { id: actorId } }),
    requireStepUp: async () => new Date(),
    createDraft: async () => ({ id: entityId, updatedAt: new Date(updatedAt) }),
    editDraft: async () => ({ id: entityId, updatedAt: new Date(updatedAt) }),
    disableProfile: async () => ({
      id: entityId,
      updatedAt: new Date(updatedAt),
    }),
    approveProfile: async () => ({
      id: entityId,
      updatedAt: new Date(updatedAt),
      reviewEvidenceHash: "a".repeat(64),
    }),
    ...overrides,
  };
}

function fields(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug: "mailer-box-30x22x5",
    name: "Mailer box 30 × 22 × 5 cm",
    packageType: "parcel",
    rank: 10,
    lengthCm: 30,
    widthCm: 22,
    heightCm: 5,
    tareWeightGrams: 90,
    maxWeightGrams: 2_000,
    acceptsRigid: true,
    ...overrides,
  };
}

function request(
  body: Record<string, unknown>,
  origin = "https://admin.example.test",
): NextRequest {
  return new NextRequest(
    "https://admin.example.test/api/admin/shipping/package-profiles",
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    },
  );
}

// --- create -----------------------------------------------------------------

test("create rejects a non-owner, wrong origin, and observe mode", async () => {
  const notOwner = createPackageProfileCreateHandler(
    baseDeps({
      requireConfiguredOwner: async () => {
        throw new Error("not owner");
      },
    }) as never,
  );
  assert.equal((await notOwner(request(fields()))).status, 403);

  const wrongOrigin = createPackageProfileCreateHandler(baseDeps() as never);
  assert.equal(
    (await wrongOrigin(request(fields(), "https://attacker.example"))).status,
    403,
  );

  const observe = createPackageProfileCreateHandler(
    baseDeps({
      requireConfigMutation: () => {
        throw new Error("observe");
      },
    }) as never,
  );
  assert.equal((await observe(request(fields()))).status, 409);
});

test("create validates the body before touching the store", async () => {
  let created = false;
  const handler = createPackageProfileCreateHandler(
    baseDeps({
      createDraft: async () => {
        created = true;
        return { id: entityId, updatedAt: new Date(updatedAt) };
      },
    }) as never,
  );
  const response = await handler(request(fields({ lengthCm: 0 })));
  assert.equal(response.status, 400);
  assert.equal(created, false);
});

test("create stores a draft and audits on success", async () => {
  let auditAction: string | null = null;
  const handler = createPackageProfileCreateHandler(
    baseDeps({
      audit: async (entry: { action: string }) => {
        auditAction = entry.action;
      },
    }) as never,
  );
  const response = await handler(request(fields()));
  assert.equal(response.status, 201);
  assert.equal(auditAction, "fulfillment.package_profile.create");
  const body = (await response.json()) as { id: string; updatedAt: string };
  assert.equal(body.id, entityId);
  assert.equal(body.updatedAt, updatedAt);
});

test("create surfaces a duplicate slug as a 409 conflict", async () => {
  const handler = createPackageProfileCreateHandler(
    baseDeps({
      createDraft: async () => {
        throw new PackageProfileConflictError(
          "A package profile with that slug already exists",
        );
      },
    }) as never,
  );
  assert.equal((await handler(request(fields()))).status, 409);
});

// --- mutate -----------------------------------------------------------------

test("mutate rejects a bad id and an unparseable expectedUpdatedAt", async () => {
  const handler = createPackageProfileMutationHandler(baseDeps() as never);
  assert.equal(
    (
      await handler(
        request({ action: "disable", expectedUpdatedAt: updatedAt }),
        {
          entityId: "not-a-uuid",
        },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(request({ action: "disable", expectedUpdatedAt: "nope" }), {
        entityId,
      })
    ).status,
    400,
  );
});

test("mutate rejects an unsupported action without step-up or a store call", async () => {
  let stepUpCalled = false;
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
    }) as never,
  );
  const response = await handler(
    request({ action: "delete", expectedUpdatedAt: updatedAt }),
    { entityId },
  );
  assert.equal(response.status, 400);
  assert.equal(stepUpCalled, false);
});

test("disable succeeds without step-up", async () => {
  let stepUpCalled = false;
  let disabled = false;
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
      disableProfile: async () => {
        disabled = true;
        return { id: entityId, updatedAt: new Date(updatedAt) };
      },
    }) as never,
  );
  const response = await handler(
    request({ action: "disable", expectedUpdatedAt: updatedAt }),
    { entityId },
  );
  assert.equal(response.status, 200);
  assert.equal(disabled, true);
  assert.equal(stepUpCalled, false);
});

test("edit succeeds without step-up and validates fields", async () => {
  const handler = createPackageProfileMutationHandler(baseDeps() as never);
  const ok = await handler(
    request({ action: "edit", expectedUpdatedAt: updatedAt, ...fields() }),
    { entityId },
  );
  assert.equal(ok.status, 200);

  const invalid = await handler(
    request({
      action: "edit",
      expectedUpdatedAt: updatedAt,
      ...fields({ maxWeightGrams: 0 }),
    }),
    { entityId },
  );
  assert.equal(invalid.status, 400);
});

test("approve requires an evidence reference before requesting step-up", async () => {
  let stepUpCalled = false;
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
    }) as never,
  );
  const response = await handler(
    request({
      action: "approve",
      expectedUpdatedAt: updatedAt,
      evidenceReference: "no",
      ...fields(),
    }),
    { entityId },
  );
  assert.equal(response.status, 400);
  assert.equal(stepUpCalled, false);
});

test("approve returns the step-up scope on a step-up failure", async () => {
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => {
        throw new Error("Step-up proof is required for this action");
      },
    }) as never,
  );
  const response = await handler(
    request({
      action: "approve",
      expectedUpdatedAt: updatedAt,
      evidenceReference: "Measured box 2026-08-23",
      ...fields(),
    }),
    { entityId },
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as {
    stepUp?: { action: string; target: string; targetLabel: string };
  };
  assert.equal(body.stepUp?.action, "shipping:package-profile:approve");
  assert.match(body.stepUp?.target ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("approve binds the step-up target to each mutable field", async () => {
  const targets: string[] = [];
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async (scope: { target: string }) => {
        targets.push(scope.target);
        throw new Error("Step-up proof is required for this action");
      },
    }) as never,
  );
  const base = {
    action: "approve",
    expectedUpdatedAt: updatedAt,
    evidenceReference: "Measured box 2026-08-23",
    ...fields(),
  };
  await handler(request(base), { entityId });
  await handler(request({ ...base, lengthCm: 31 }), { entityId });
  await handler(request({ ...base, slug: "mailer-box-36x26x4" }), { entityId });
  await handler(
    request({ ...base, evidenceReference: "Different reference" }),
    {
      entityId,
    },
  );
  await handler(
    request({ ...base, expectedUpdatedAt: "2026-08-23T13:00:00.000Z" }),
    { entityId },
  );
  assert.equal(targets.length, 5);
  assert.equal(new Set(targets).size, 5);
});

test("approve maps a service conflict to 409 without a step-up scope", async () => {
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => new Date(),
      approveProfile: async () => {
        throw new PackageProfileConflictError(
          "The profile changed since it was reviewed; refresh and approve again",
        );
      },
    }) as never,
  );
  const response = await handler(
    request({
      action: "approve",
      expectedUpdatedAt: updatedAt,
      evidenceReference: "Measured box 2026-08-23",
      ...fields(),
    }),
    { entityId },
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { stepUp?: unknown };
  assert.equal(body.stepUp, undefined);
});

test("approve rethrows an unexpected error instead of masking it as 409", async () => {
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => new Date(),
      approveProfile: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    }) as never,
  );
  await assert.rejects(
    () =>
      handler(
        request({
          action: "approve",
          expectedUpdatedAt: updatedAt,
          evidenceReference: "Measured box 2026-08-23",
          ...fields(),
        }),
        { entityId },
      ),
    /connection terminated/,
  );
});

test("approve enables the box and audits with the evidence hash", async () => {
  let auditMeta: Record<string, unknown> | undefined;
  const handler = createPackageProfileMutationHandler(
    baseDeps({
      requireStepUp: async () => new Date("2026-08-23T12:00:00.000Z"),
      approveProfile: async (input: { submitted: { slug: string } }) => {
        assert.equal(input.submitted.slug, "mailer-box-30x22x5");
        return {
          id: entityId,
          updatedAt: new Date(updatedAt),
          reviewEvidenceHash: "b".repeat(64),
        };
      },
      audit: async (entry: { metadata?: Record<string, unknown> }) => {
        auditMeta = entry.metadata;
      },
    }) as never,
  );
  const response = await handler(
    request({
      action: "approve",
      expectedUpdatedAt: updatedAt,
      evidenceReference: "Measured box 2026-08-23",
      ...fields(),
    }),
    { entityId },
  );
  assert.equal(response.status, 200);
  assert.equal(auditMeta?.reviewEvidenceHash, "b".repeat(64));
});
