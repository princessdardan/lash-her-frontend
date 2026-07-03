import assert from "node:assert/strict";
import test from "node:test";

import {
  createServiceBookingPromotionCodePostHandler,
  createInMemoryRateLimiter,
  type ServiceBookingPromotionCodeHandlerDependencies,
} from "./route";
import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";
import type { PromotionCode } from "@/lib/commerce/discounts";

const baseSession: ServiceBookingPaymentSessionDisplay = {
  currency: "CAD",
  expiresAt: "2026-07-02T15:30:00.000Z",
  paymentSessionReference: "session-123",
  pricing: {
    addOnPriceCents: 0,
    customAmountMaximumCents: 10000,
    customAmountMinimumCents: 5000,
    depositAmountCents: 5000,
    fullPriceCents: 10000,
  },
  selectedEnd: "2026-07-03T16:00:00.000Z",
  selectedStart: "2026-07-03T15:00:00.000Z",
  serviceSlug: "classic-fill",
  serviceTitle: "Classic Fill",
  timezone: "America/Toronto",
};

const promotionCode: PromotionCode = {
  _id: "promo-1",
  code: "SAVE10",
  isEnabled: true,
  discountType: "percentage",
  amount: 10,
  appliesTo: "specificItems",
  services: [{ _id: "service-1" }],
};

test("service booking promotion handler normalizes and applies service code", async () => {
  let requestedCode = "";
  let updatedSnapshot: unknown;

  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    // Held price intentionally differs from the current Sanity service price;
    // discounts must be calculated against the immutable hold snapshot.
    getHoldContext: async () => ({
      basePriceCents: 12000,
      serviceId: "service-1",
      serviceSlug: "classic-fill",
    }),
    getPromotionCode: async (code) => {
      requestedCode = code;
      return promotionCode;
    },
    resolveSession: async () => ({
      status: "active",
      session: {
        ...baseSession,
        pricing: {
          ...baseSession.pricing,
          discountedBasePriceCents: 10800,
          promotionCode: "SAVE10",
          promotionDiscountCents: 1200,
        },
      },
    }),
    updateHoldPromotionSnapshot: async ({ promotionSnapshot }) => {
      updatedSnapshot = promotionSnapshot;
      return { ok: true };
    },
  });

  const response = await handler(
    jsonRequest({
      action: "apply",
      code: " save10 ",
      paymentSessionReference: "session-123",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(requestedCode, "SAVE10");
  assert.deepEqual(updatedSnapshot, {
    code: "SAVE10",
    discountType: "percentage",
    discountAmount: 10,
    discountCents: 1200,
    originalBasePriceCents: 12000,
    discountedBasePriceCents: 10800,
  });
  assert.equal(body.session.pricing.promotionCode, "SAVE10");
});

test("service booking promotion handler removes applied service code", async () => {
  let updatedSnapshot: unknown = "not-called";

  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    updateHoldPromotionSnapshot: async ({ promotionSnapshot }) => {
      updatedSnapshot = promotionSnapshot;
      return { ok: true };
    },
  });

  const response = await handler(
    jsonRequest({
      action: "remove",
      paymentSessionReference: "session-123",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(updatedSnapshot, null);
  assert.equal(body.session.pricing.promotionCode, undefined);
});

test("apply attempts are rate limited after exceeding the threshold", async () => {
  let applyCount = 0;
  const limiter = createInMemoryRateLimiter({
    windowMs: 60_000,
    maxAttempts: 2,
  });
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: limiter.check.bind(limiter),
    getPromotionCode: async () => {
      applyCount += 1;
      return promotionCode;
    },
  });

  const body = {
    action: "apply",
    code: "SAVE10",
    paymentSessionReference: "session-123",
  } as const;

  const first = await handler(jsonRequest(body));
  assert.equal(first.status, 200);
  assert.equal(applyCount, 1);

  const second = await handler(jsonRequest(body));
  assert.equal(second.status, 200);
  assert.equal(applyCount, 2);

  const third = await handler(jsonRequest(body));
  assert.equal(third.status, 429);
  assert.equal(applyCount, 2);
  const thirdBody = await third.json();
  assert.equal(
    thirdBody.error,
    "Too many promotion code attempts. Please try again later.",
  );
});

test("remove attempts are not rate limited", async () => {
  const limiter = createInMemoryRateLimiter({
    windowMs: 60_000,
    maxAttempts: 1,
  });
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: limiter.check.bind(limiter),
  });

  const apply = await handler(
    jsonRequest({
      action: "apply",
      code: "SAVE10",
      paymentSessionReference: "session-123",
    }),
  );
  assert.equal(apply.status, 200);

  const remove = await handler(
    jsonRequest({ action: "remove", paymentSessionReference: "session-123" }),
  );
  assert.equal(remove.status, 200);
});

test("rate limiter uses a sliding window and reports retry after", async () => {
  const limiter = createInMemoryRateLimiter({
    windowMs: 60_000,
    maxAttempts: 1,
  });

  const first = limiter.check("key");
  assert.deepEqual(first, { ok: true });

  const second = limiter.check("key");
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.retryAfterSeconds > 0, true);
});

function createBaseDependencies(): ServiceBookingPromotionCodeHandlerDependencies {
  return {
    getHoldContext: async () => ({
      basePriceCents: 10000,
      serviceId: "service-1",
      serviceSlug: "classic-fill",
    }),
    getPromotionCode: async () => promotionCode,
    resolveSession: async () => ({ status: "active", session: baseSession }),
    updateHoldPromotionSnapshot: async () => ({ ok: true }),
  };
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/booking/payment/promotion-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as Parameters<
    ReturnType<typeof createServiceBookingPromotionCodePostHandler>
  >[0];
}
