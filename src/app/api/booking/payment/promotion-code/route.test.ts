import assert from "node:assert/strict";
import test from "node:test";

import {
  createServiceBookingPromotionCodePostHandler,
  readServiceBookingPromotionHoldContext,
  type ServiceBookingPromotionCodeHandlerDependencies,
} from "./handler";
import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";
import type { PromotionCode } from "@/lib/commerce/discounts";
import type { TPromotionCode } from "@/types";

const baseSession: ServiceBookingPaymentSessionDisplay = {
  currency: "CAD",
  expiresAt: "2026-07-02T15:30:00.000Z",
  marketingOptInLabel: "Send me booking updates.",
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
      bookingModelVersion: 1,
      serviceIds: ["service-1"],
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

test("V1 applies a loader-shaped specific-service promotion", async () => {
  const legacyLoaderPromotion: TPromotionCode = {
    _id: "promo-specific-service",
    title: "Legacy specific service",
    code: "LEGACY10",
    isEnabled: true,
    discountType: "percentage",
    amount: 10,
    appliesTo: "specificItems",
    products: [],
    trainingPrograms: [],
    services: [{ _id: "sanity-service-1" }],
  };
  let updatedSnapshot: unknown;

  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    getHoldContext: async () => ({
      basePriceCents: 12000,
      bookingModelVersion: 1,
      serviceIds: ["sanity-service-1"],
      serviceSlug: "classic-fill",
    }),
    getPromotionCode: async () => legacyLoaderPromotion,
    updateHoldPromotionSnapshot: async ({ promotionSnapshot }) => {
      updatedSnapshot = promotionSnapshot;
      return { ok: true };
    },
  });

  const response = await handler(
    jsonRequest({
      action: "apply",
      code: "legacy10",
      paymentSessionReference: "session-123",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(updatedSnapshot, {
    code: "LEGACY10",
    discountAmount: 10,
    discountedBasePriceCents: 10800,
    discountCents: 1200,
    discountType: "percentage",
    originalBasePriceCents: 12000,
  });
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
  let rateLimitChecks = 0;
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async () => {
      rateLimitChecks += 1;
      return rateLimitChecks <= 2
        ? { allowed: true, remaining: 2 - rateLimitChecks }
        : { allowed: false, retryAfterSeconds: 47 };
    },
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

  const headers = { "x-vercel-forwarded-for": "203.0.113.8" };
  const first = await handler(jsonRequest(body, headers));
  assert.equal(first.status, 200);
  assert.equal(applyCount, 1);

  const second = await handler(jsonRequest(body, headers));
  assert.equal(second.status, 200);
  assert.equal(applyCount, 2);

  const third = await handler(jsonRequest(body, headers));
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("Cache-Control"), "no-store");
  assert.equal(third.headers.get("Retry-After"), "47");
  assert.equal(applyCount, 2);
  const thirdBody = await third.json();
  assert.equal(
    thirdBody.error,
    "Too many promotion code attempts. Please try again later.",
  );
});

test("remove attempts are not rate limited", async () => {
  let rateLimitChecks = 0;
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async () => {
      rateLimitChecks += 1;
      return { allowed: false, retryAfterSeconds: 60 };
    },
  });

  const remove = await handler(
    jsonRequest({ action: "remove", paymentSessionReference: "session-123" }),
  );
  assert.equal(remove.status, 200);
  assert.equal(rateLimitChecks, 0);
});

test("trusted client identity cannot be rotated with spoofed headers, codes, or session references", async () => {
  const keys: string[] = [];
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async ({ key }) => {
      keys.push(key);
      return { allowed: true, remaining: 9 };
    },
  });

  const first = await handler(
    jsonRequest(
      {
        action: "apply",
        code: "SAVE10",
        paymentSessionReference: "session-123",
      },
      {
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "192.0.2.2",
        "x-vercel-forwarded-for": "203.0.113.8",
      },
    ),
  );
  const second = await handler(
    jsonRequest(
      {
        action: "apply",
        code: "SAVE20",
        paymentSessionReference: "session-rotated",
      },
      {
        "x-forwarded-for": "198.51.100.1",
        "x-real-ip": "198.51.100.2",
        "x-vercel-forwarded-for": "203.0.113.8",
      },
    ),
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(
    keys[0] ?? "",
    /^booking:abuse:promotion-attempts:[a-f0-9]{32}:[a-f0-9]{32}$/,
  );
  assert.equal(keys[0]?.includes("203.0.113.8"), false);
  assert.equal(keys[0]?.includes("session-123"), false);
});

test("distinct trusted client identities receive distinct limiter keys", async () => {
  const keys: string[] = [];
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async ({ key }) => {
      keys.push(key);
      return { allowed: true, remaining: 9 };
    },
  });
  const body = {
    action: "apply",
    code: "SAVE10",
    paymentSessionReference: "session-123",
  } as const;

  await handler(jsonRequest(body, { "x-vercel-forwarded-for": "203.0.113.8" }));
  await handler(jsonRequest(body, { "x-vercel-forwarded-for": "203.0.113.9" }));

  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("rate limiter storage failure fails closed before hold or promotion lookups", async () => {
  let holdLookups = 0;
  let promotionLookups = 0;
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async () => {
      throw new Error("redis unavailable");
    },
    getHoldContext: async () => {
      holdLookups += 1;
      return null;
    },
    getPromotionCode: async () => {
      promotionLookups += 1;
      return promotionCode;
    },
  });

  const response = await handler(
    jsonRequest(
      {
        action: "apply",
        code: "SAVE10",
        paymentSessionReference: "session-123",
      },
      { "x-vercel-forwarded-for": "203.0.113.8" },
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(body, {
    error: "Promotion codes are temporarily unavailable",
  });
  assert.equal(holdLookups, 0);
  assert.equal(promotionLookups, 0);
});

test("missing trusted client identity in a Vercel environment fails closed", async () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = "1";
  let rateLimitChecks = 0;

  try {
    const handler = createServiceBookingPromotionCodePostHandler({
      ...createBaseDependencies(),
      checkRateLimit: async () => {
        rateLimitChecks += 1;
        return { allowed: true, remaining: 9 };
      },
    });
    const response = await handler(
      jsonRequest(
        {
          action: "apply",
          code: "SAVE10",
          paymentSessionReference: "session-123",
        },
        { "x-forwarded-for": "203.0.113.8" },
      ),
    );

    assert.equal(response.status, 503);
    assert.equal(rateLimitChecks, 0);
  } finally {
    if (previousVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = previousVercel;
    }
  }
});

test("rejects oversized references and codes before limiter or storage work", async () => {
  let rateLimitChecks = 0;
  let holdLookups = 0;
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async () => {
      rateLimitChecks += 1;
      return { allowed: true, remaining: 9 };
    },
    getHoldContext: async () => {
      holdLookups += 1;
      return null;
    },
  });

  const oversizedReference = await handler(
    jsonRequest({
      action: "apply",
      code: "SAVE10",
      paymentSessionReference: "s".repeat(129),
    }),
  );
  const oversizedCode = await handler(
    jsonRequest({
      action: "apply",
      code: "S".repeat(33),
      paymentSessionReference: "session-123",
    }),
  );

  assert.equal(oversizedReference.status, 400);
  assert.equal(oversizedCode.status, 400);
  assert.equal(rateLimitChecks, 0);
  assert.equal(holdLookups, 0);
});

test("rejects an oversized JSON body before limiter or storage work", async () => {
  let rateLimitChecks = 0;
  let holdLookups = 0;
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    checkRateLimit: async () => {
      rateLimitChecks += 1;
      return { allowed: true, remaining: 9 };
    },
    getHoldContext: async () => {
      holdLookups += 1;
      return null;
    },
  });

  const response = await handler(
    jsonRequest({
      action: "apply",
      code: "SAVE10",
      padding: "x".repeat(1024),
      paymentSessionReference: "session-123",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.deepEqual(body, { error: "Promotion code request is too large" });
  assert.equal(rateLimitChecks, 0);
  assert.equal(holdLookups, 0);
});

test("reads the immutable offering id from a V2 hold snapshot", () => {
  assert.deepEqual(
    readServiceBookingPromotionHoldContext({
      bookingModelVersion: 2,
      offeringId: "provider-offering-1",
      pricing: { fullPrice: 120 },
      serviceSlug: "classic-fill",
    }),
    {
      basePriceCents: 12000,
      bookingModelVersion: 2,
      offeringId: "provider-offering-1",
      serviceSlug: "classic-fill",
    },
  );
});

test("rejects a malformed V2 snapshot without an immutable offering id", () => {
  assert.equal(
    readServiceBookingPromotionHoldContext({
      bookingModelVersion: 2,
      pricing: { fullPrice: 120 },
      service: { serviceId: "service-id-must-not-be-used" },
      serviceSlug: "classic-fill",
    }),
    null,
  );
});

test("continues to read the Sanity service id from a legacy hold snapshot", () => {
  assert.deepEqual(
    readServiceBookingPromotionHoldContext({
      id: "sanity-service-1",
      pricing: { fullPrice: 120 },
      serviceSlug: "classic-fill",
    }),
    {
      basePriceCents: 12000,
      bookingModelVersion: 1,
      serviceIds: ["sanity-service-1"],
      serviceSlug: "classic-fill",
    },
  );
});

test("V2 apply resolves eligibility by held offering without querying Sanity", async () => {
  let operationalInput: unknown;
  let sanityLookups = 0;
  let updatedSnapshot: unknown;
  const handler = createServiceBookingPromotionCodePostHandler({
    ...createBaseDependencies(),
    getHoldContext: async () => ({
      basePriceCents: 12000,
      bookingModelVersion: 2,
      offeringId: "provider-offering-1",
      serviceSlug: "classic-fill",
    }),
    getPromotionCode: async () => {
      sanityLookups += 1;
      return null;
    },
    resolveOperationalPromotionCode: async (input) => {
      operationalInput = input;
      return {
        _id: "operational-promo-1",
        amount: 10,
        appliesTo: "services",
        code: "SAVE10",
        discountType: "percentage",
        isEnabled: true,
      };
    },
    updateHoldPromotionSnapshot: async ({ promotionSnapshot }) => {
      updatedSnapshot = promotionSnapshot;
      return { ok: true };
    },
  });

  const response = await handler(
    jsonRequest({
      action: "apply",
      code: "save10",
      paymentSessionReference: "session-123",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(sanityLookups, 0);
  assert.deepEqual(operationalInput, {
    code: "SAVE10",
    now: operationalInputNow(operationalInput),
    offeringId: "provider-offering-1",
  });
  assert.deepEqual(updatedSnapshot, {
    code: "SAVE10",
    discountAmount: 10,
    discountedBasePriceCents: 10800,
    discountCents: 1200,
    discountType: "percentage",
    originalBasePriceCents: 12000,
  });
});

function createBaseDependencies(): ServiceBookingPromotionCodeHandlerDependencies {
  return {
    getHoldContext: async () => ({
      basePriceCents: 10000,
      bookingModelVersion: 1,
      serviceIds: ["service-1"],
      serviceSlug: "classic-fill",
    }),
    getPromotionCode: async () => promotionCode,
    resolveOperationalPromotionCode: async () => null,
    resolveSession: async () => ({ status: "active", session: baseSession }),
    updateHoldPromotionSnapshot: async () => ({ ok: true }),
  };
}

function operationalInputNow(value: unknown): Date {
  if (
    typeof value !== "object" ||
    value === null ||
    !("now" in value) ||
    !(value.now instanceof Date)
  ) {
    assert.fail("operational resolver input should contain a Date");
  }
  return value.now;
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/booking/payment/promotion-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as Parameters<
    ReturnType<typeof createServiceBookingPromotionCodePostHandler>
  >[0];
}
