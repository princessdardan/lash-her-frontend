import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createShippingReadinessControlHandlers,
  readinessStepUpScope,
  type ReadinessControlDependencies,
} from "./handler";

const actor = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
};

test("readiness control GET returns the owner configuration without caching", async () => {
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      getState: async () => emptyState(),
    }),
  );
  const response = await handlers.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), emptyState());
});

test("readiness control GET rejects a non-configured owner before loading state", async () => {
  let stateLoaded = false;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      getState: async () => {
        stateLoaded = true;
        return emptyState();
      },
      requireConfiguredOwner: async () => {
        throw new Error(
          "Only the sole configured fulfillment owner may perform this action",
        );
      },
    }),
  );
  const response = await handlers.GET();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(stateLoaded, false);
});

test("readiness mutation returns the exact canonical step-up scope before changing state", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  let mutationCalled = false;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      requireStepUp: async () => {
        throw new Error("Step-up proof is required for this action");
      },
      savePackageProfile: async () => {
        mutationCalled = true;
        return { id: "unexpected" } as never;
      },
    }),
  );
  const body = packagePayload();
  const response = await handlers.POST(request(body));
  assert.equal(response.status, 409);
  const result = (await response.json()) as {
    stepUp: { action: string; target: string; targetLabel: string };
  };
  assert.deepEqual(
    result.stepUp,
    readinessStepUpScope("package_profile", body),
  );
  assert.match(result.stepUp.target, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.stepUp.targetLabel, "Package profile: verified-package");
  assert.equal(mutationCalled, false);
});

test("readiness package mutation is owner-proof bound and returns a durable record id", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  const captured: Array<Record<string, unknown>> = [];
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      requireStepUp: async () => new Date("2026-08-15T12:00:00.000Z"),
      savePackageProfile: async (input) => {
        captured.push(input as unknown as Record<string, unknown>);
        return { id: "22222222-2222-4222-8222-222222222222" } as never;
      },
    }),
  );
  const response = await handlers.POST(request(packagePayload()));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    id: "22222222-2222-4222-8222-222222222222",
    ok: true,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.actorAdminUserId, actor.user.id);
  assert.equal(captured[0]?.enabled, true);
  assert.equal(captured[0]?.maxWeightGrams, 2000);
});

test("readiness controls reject cross-origin mutations", async () => {
  const handlers = createShippingReadinessControlHandlers(dependencies());
  const response = await handlers.POST(
    new NextRequest(
      "https://admin.example.test/api/admin/shipping/readiness-controls",
      {
        body: JSON.stringify(packagePayload()),
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        method: "POST",
      },
    ),
  );
  assert.equal(response.status, 403);
});

test("readiness controls do not mutate operational state in observe mode", async () => {
  const previous = process.env.SHIPPING_POLICY_ENFORCEMENT_MODE;
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "observe";
  let mutationCalled = false;
  try {
    const handlers = createShippingReadinessControlHandlers(
      dependencies({
        savePackageProfile: async () => {
          mutationCalled = true;
          return { id: "unexpected" } as never;
        },
      }),
    );
    const response = await handlers.POST(request(packagePayload()));
    assert.equal(response.status, 409);
    assert.equal(mutationCalled, false);
  } finally {
    if (previous === undefined) {
      delete process.env.SHIPPING_POLICY_ENFORCEMENT_MODE;
    } else {
      process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = previous;
    }
  }
});

test("readiness mutation rejects a non-configured owner before step-up or mutation", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  let stepUpCalled = false;
  let mutationCalled = false;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      requireConfiguredOwner: async () => {
        throw new Error("not the configured owner");
      },
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
      savePackageProfile: async () => {
        mutationCalled = true;
        return { id: "unexpected" } as never;
      },
    }),
  );

  const response = await handlers.POST(request(packagePayload()));
  assert.equal(response.status, 403);
  assert.equal(stepUpCalled, false);
  assert.equal(mutationCalled, false);
});

test("readiness mutation rejects invalid actions without requesting step-up", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  let stepUpCalled = false;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
    }),
  );

  const response = await handlers.POST(request({ action: "unknown" }));
  assert.equal(response.status, 400);
  assert.equal(stepUpCalled, false);
});

test("readiness tax approval preserves the complete coverage and CAS snapshot", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  let captured: Record<string, unknown> | undefined;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      approveTaxPolicy: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return { id: "33333333-3333-4333-8333-333333333333" } as never;
      },
      requireStepUp: async () => new Date("2026-08-15T12:00:00.000Z"),
    }),
  );
  const body = {
    action: "tax_policy",
    coverage: {
      componentRefunds: true,
      merchandise: true,
      shipping: true,
      supplements: true,
      usOrders: true,
      ignoredTruthiness: "true",
    },
    evidenceReference: "evidence://tax/approved",
    expectedCurrentEffectiveId: "44444444-4444-4444-8444-444444444444",
    version: "tax-2026-08-15",
  };

  const response = await handlers.POST(request(body));
  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    actorAdminUserId: actor.user.id,
    coverage: {
      componentRefunds: true,
      merchandise: true,
      shipping: true,
      supplements: true,
      usOrders: true,
      ignoredTruthiness: false,
    },
    evidenceReference: body.evidenceReference,
    expectedCurrentEffectiveId: body.expectedCurrentEffectiveId,
    stepUpAuthenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
    version: body.version,
  });
});

test("readiness manual-policy approval binds policy text, version, evidence, and CAS token", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  let captured: Record<string, unknown> | undefined;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      approveManualPolicy: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return { id: "55555555-5555-4555-8555-555555555555" } as never;
      },
      requireStepUp: async () => new Date("2026-08-15T12:00:00.000Z"),
    }),
  );
  const body = {
    action: "manual_policy",
    cancellationPolicyText:
      "Cancellation is approved unless irreversible custom work is evidenced.",
    evidenceReference: "evidence://manual-policy/approved",
    expectedCurrentEffectiveId: "66666666-6666-4666-8666-666666666666",
    version: "manual-2026-08-15",
  };

  const response = await handlers.POST(request(body));
  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    actorAdminUserId: actor.user.id,
    cancellationPolicyText: body.cancellationPolicyText,
    evidenceReference: body.evidenceReference,
    expectedCurrentEffectiveId: body.expectedCurrentEffectiveId,
    stepUpAuthenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
    version: body.version,
  });
});

test("readiness package update forwards the exact conflict token and returns 200", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  let captured: Record<string, unknown> | undefined;
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      requireStepUp: async () => new Date("2026-08-15T12:00:00.000Z"),
      savePackageProfile: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return { id: "77777777-7777-4777-8777-777777777777" } as never;
      },
    }),
  );
  const body = {
    ...packagePayload(),
    expectedUpdatedAt: "2026-08-15T11:59:00.000Z",
    id: "77777777-7777-4777-8777-777777777777",
  };

  const response = await handlers.POST(request(body));
  assert.equal(response.status, 200);
  assert.equal(
    (captured?.expectedUpdatedAt as Date).toISOString(),
    body.expectedUpdatedAt,
  );
  assert.equal(captured?.id, body.id);
});

test("readiness step-up digest changes for every material package-profile field", () => {
  const base = packagePayload();
  const baseTarget = readinessStepUpScope("package_profile", base).target;
  const mutations: Array<[string, unknown]> = [
    ["id", "88888888-8888-4888-8888-888888888888"],
    ["expectedUpdatedAt", "2026-08-15T12:00:00.000Z"],
    ["slug", "different-package"],
    ["name", "Different package"],
    ["rank", 11],
    ["packageType", "box"],
    ["lengthCm", 31],
    ["widthCm", 21],
    ["heightCm", 9],
    ["tareWeightGrams", 81],
    ["maxWeightGrams", 2001],
    ["capacityUnits", 5],
    ["enabled", false],
    ["evidenceReference", "evidence://different"],
  ];

  for (const [field, value] of mutations) {
    const target = readinessStepUpScope("package_profile", {
      ...base,
      [field]: value,
    }).target;
    assert.notEqual(target, baseTarget, `${field} must be bound to the proof`);
  }
});

test("readiness mutation failure is durable in the audit response path", async () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  const audits: Array<Record<string, unknown>> = [];
  const handlers = createShippingReadinessControlHandlers(
    dependencies({
      recordAudit: async (input) => {
        audits.push(input as unknown as Record<string, unknown>);
      },
      savePackageProfile: async () => {
        throw new Error("The package profile changed; refresh before retrying");
      },
    }),
  );

  const response = await handlers.POST(request(packagePayload()));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "The package profile changed; refresh before retrying",
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.outcome, "failure");
  assert.equal(
    audits[0]?.reason,
    "The package profile changed; refresh before retrying",
  );
});

function dependencies(
  overrides: Partial<ReadinessControlDependencies> = {},
): ReadinessControlDependencies {
  return {
    approveManualPolicy: async () => ({ id: "manual" }) as never,
    approveTaxPolicy: async () => ({ id: "tax" }) as never,
    getState: async () => emptyState(),
    recordAudit: async () => undefined,
    requireConfiguredOwner: async () => ({
      displayName: "Nataliea Lavoie",
      email: "owner@example.invalid",
      id: actor.user.id,
    }),
    requirePermission: async () => actor as never,
    requireStepUp: async () => new Date(),
    savePackageProfile: async () => ({ id: "package" }) as never,
    ...overrides,
  };
}

function emptyState() {
  return {
    calendarExceptions: [],
    calendarVersions: [],
    fulfillmentPolicies: [],
    fundingReviews: [],
    helcimContract: null,
    manualPolicies: [],
    packageProfiles: [],
    policyAssignments: [],
    policySettings: null,
    providerCertifications: [],
    servicePolicies: [],
    taxPolicies: [],
  };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    "https://admin.example.test/api/admin/shipping/readiness-controls",
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

function packagePayload(): Record<string, unknown> {
  return {
    action: "package_profile",
    capacityUnits: 4,
    enabled: true,
    evidenceReference: "evidence://verified-package",
    heightCm: 8,
    lengthCm: 30,
    maxWeightGrams: 2000,
    name: "Verified package",
    packageType: "parcel",
    rank: 10,
    slug: "verified-package",
    tareWeightGrams: 80,
    widthCm: 20,
  };
}
