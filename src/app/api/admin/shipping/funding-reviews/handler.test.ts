import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createFundingReviewHandlers,
  fundingRecordStepUpScope,
  type FundingReviewRouteDependencies,
} from "./handler";

const actor = { user: { id: "11111111-1111-4111-8111-111111111111" } };

test("funding route rejects a non-owner before step-up and mutation", async () => {
  let stepUpCalled = false;
  let mutationCalled = false;
  const handlers = createFundingReviewHandlers(
    dependencies({
      requireConfiguredOwner: async () => {
        throw new Error("not owner");
      },
      requireStepUp: async () => {
        stepUpCalled = true;
        return new Date();
      },
      recordControl: async () => {
        mutationCalled = true;
        return {} as never;
      },
    }),
  );

  const response = await handlers.POST(request(balancePayload()));
  assert.equal(response.status, 403);
  assert.equal(stepUpCalled, false);
  assert.equal(mutationCalled, false);
});

test("funding route is mutation-free in observe mode", async () => {
  let stepUpCalled = false;
  const handlers = createFundingReviewHandlers(
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

  const response = await handlers.POST(request(balancePayload()));
  assert.equal(response.status, 409);
  assert.equal(stepUpCalled, false);
});

test("funding route rejects cross-origin and malformed or cross-kind payloads", async () => {
  const handlers = createFundingReviewHandlers(dependencies());
  assert.equal(
    (
      await handlers.POST(
        request(balancePayload(), "https://attacker.example.invalid"),
      )
    ).status,
    403,
  );
  assert.equal((await handlers.POST(request({ kind: "unknown" }))).status, 400);
  assert.equal(
    (
      await handlers.POST(
        request({ ...balancePayload(), topUpAmountCents: 5_000 }),
      )
    ).status,
    400,
  );
});

test("funding step-up scope normalizes and binds every persisted balance field", () => {
  let captured: Record<string, unknown> | undefined;
  const payload = balancePayload();
  const scope = fundingRecordStepUpScope(payload, ((value: unknown) => {
    captured = value as Record<string, unknown>;
    return "sha256:captured";
  }) as never);

  assert.deepEqual(scope, {
    action: "shipping_funding:record",
    target: "sha256:captured",
  });
  assert.deepEqual(captured, {
    balanceCents: 50_000,
    calculatedFiveBusinessDaySpendCents: null,
    calculatedTwoBusinessDaySpendCents: null,
    dedicatedBusinessCardConfirmed: true,
    externalEvidenceReference: "evidence://balance/current",
    forecastReviewId: "22222222-2222-4222-8222-222222222222",
    issuerAlertsConfirmed: true,
    kind: "balance_check",
    observedAt: "2026-08-15T12:00:00.000Z",
    reloadAmountCents: null,
    reloadThresholdCents: null,
    successful: true,
    topUpAmountCents: null,
    validUntil: "2026-08-16T11:00:00.000Z",
  });

  for (const [field, value] of Object.entries({
    balanceCents: 50_001,
    dedicatedBusinessCardConfirmed: false,
    externalEvidenceReference: "evidence://balance/different",
    forecastReviewId: "33333333-3333-4333-8333-333333333333",
    issuerAlertsConfirmed: false,
    observedAt: "2026-08-15T12:00:01.000Z",
    validUntil: "2026-08-16T11:00:01.000Z",
  })) {
    assert.notEqual(
      fundingRecordStepUpScope({ ...payload, [field]: value }).target,
      fundingRecordStepUpScope(payload).target,
      `${field} must change the proof digest`,
    );
  }
});

test("funding balance route forwards the approved forecast and exact evidence dates", async () => {
  let captured: Record<string, unknown> | undefined;
  const handlers = createFundingReviewHandlers(
    dependencies({
      recordControl: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return {
          id: "44444444-4444-4444-8444-444444444444",
          kind: "balance_check",
          reloadAmountCents: null,
          status: "recorded",
          topUpAmountCents: null,
        } as never;
      },
    }),
  );

  const response = await handlers.POST(request(balancePayload()));
  assert.equal(response.status, 201);
  assert.equal(captured?.actorAdminUserId, actor.user.id);
  assert.equal(captured?.balanceCents, 50_000);
  assert.equal(
    captured?.forecastReviewId,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(
    (captured?.observedAt as Date).toISOString(),
    "2026-08-15T12:00:00.000Z",
  );
  assert.equal(
    (captured?.validUntil as Date).toISOString(),
    "2026-08-16T11:00:00.000Z",
  );
});

test("funding initial forecast route accepts only its exact shape", async () => {
  let captured: Record<string, unknown> | undefined;
  const handlers = createFundingReviewHandlers(
    dependencies({
      recordInitialForecast: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return {
          id: "55555555-5555-4555-8555-555555555555",
          status: "recommended",
        } as never;
      },
    }),
  );
  const payload = {
    calculatedFiveBusinessDaySpendCents: 20_000,
    calculatedTwoBusinessDaySpendCents: 8_000,
    dedicatedBusinessCardConfirmed: true,
    externalEvidenceReference: "evidence://forecast/current",
    issuerAlertsConfirmed: true,
    kind: "initial_forecast",
    reloadAmountCents: 10_000,
    reloadThresholdCents: 2_500,
  };

  const response = await handlers.POST(request(payload));
  assert.equal(response.status, 201);
  assert.deepEqual(captured, {
    actorAdminUserId: actor.user.id,
    calculatedFiveBusinessDaySpendCents: 20_000,
    calculatedTwoBusinessDaySpendCents: 8_000,
    dedicatedBusinessCardConfirmed: true,
    evidenceReference: "evidence://forecast/current",
    issuerAlertsConfirmed: true,
    reloadAmountCents: 10_000,
    reloadThresholdCents: 2_500,
  });
});

test("funding mutation errors do not report a successful record", async () => {
  const handlers = createFundingReviewHandlers(
    dependencies({
      recordControl: async () => {
        throw new Error("Balance attestation evidence is incomplete or stale");
      },
    }),
  );
  const response = await handlers.POST(request(balancePayload()));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Balance attestation evidence is incomplete or stale",
  });
});

function dependencies(
  overrides: Partial<FundingReviewRouteDependencies> = {},
): FundingReviewRouteDependencies {
  return {
    assertMutationAllowed: () => undefined,
    createStepUpTarget: ((value: unknown) =>
      `sha256:${JSON.stringify(value)}`) as never,
    recordAudit: async () => undefined,
    recordControl: async () =>
      ({
        id: "default-control",
        kind: "balance_check",
        reloadAmountCents: null,
        status: "recorded",
        topUpAmountCents: null,
      }) as never,
    recordInitialForecast: async () =>
      ({
        id: "default-forecast",
        status: "recommended",
      }) as never,
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

function balancePayload(): Record<string, unknown> {
  return {
    balanceCents: 50_000,
    dedicatedBusinessCardConfirmed: true,
    externalEvidenceReference: " evidence://balance/current ",
    forecastReviewId: "22222222-2222-4222-8222-222222222222",
    issuerAlertsConfirmed: true,
    kind: "balance_check",
    observedAt: "2026-08-15T12:00:00.000Z",
    validUntil: "2026-08-16T11:00:00.000Z",
  };
}

function request(
  body: Record<string, unknown>,
  origin = "https://admin.example.test",
): NextRequest {
  return new NextRequest(
    "https://admin.example.test/api/admin/shipping/funding-reviews",
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    },
  );
}
