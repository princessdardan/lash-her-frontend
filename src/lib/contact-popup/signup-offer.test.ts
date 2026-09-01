import assert from "node:assert/strict";
import test from "node:test";

import type { ContactPopupSignupOfferConfigSource } from "@/data/loaders";

import {
  resolveContactPopupSignupOffer,
  type ContactPopupSignupOfferInvalidReason,
} from "./signup-offer";

const NOW = new Date("2026-08-31T15:30:00.000Z");

test("resolves a validated published sitewide signup offer snapshot", async () => {
  const result = await resolve(createConfig());

  assert.deepEqual(result, {
    status: "available",
    offer: {
      promotionId: "promotion-1",
      promotionRevision: "revision-1",
      promotionCode: "WELCOME20",
      discountType: "percentage",
      discountAmount: 20,
      appliesTo: "all",
      offerLabel: "20% off your first order",
      offerTerms: "Valid on products and training programs.",
      ctaLabel: "Shop now",
      ctaUrl: "https://example.com/products",
      resolvedAt: NOW.toISOString(),
    },
  });
});

test("treats an absent or explicitly disabled offer as disabled", async () => {
  assert.deepEqual(await resolve(null), { status: "disabled" });
  assert.deepEqual(
    await resolve({ ...createConfig(), signupOfferEnabled: undefined }),
    { status: "disabled" },
  );
  assert.deepEqual(
    await resolve({ ...createConfig(), signupOfferEnabled: false }),
    { status: "disabled" },
  );
});

test("returns invalid when the fresh configuration read fails", async () => {
  const result = await resolveContactPopupSignupOffer({
    loadConfig: async () => {
      throw new Error("Sanity unavailable");
    },
    now: () => NOW,
  });

  assert.deepEqual(result, {
    status: "invalid",
    reason: "configuration_unavailable",
  });
});

test("rejects malformed offer copy, promotion state, and discount data", async () => {
  const cases: Array<{
    reason: ContactPopupSignupOfferInvalidReason;
    mutate: (config: ContactPopupSignupOfferConfigSource) => void;
  }> = [
    {
      reason: "invalid_enabled_flag",
      mutate: (config) => {
        config.signupOfferEnabled = "true";
      },
    },
    {
      reason: "missing_promotion_reference",
      mutate: (config) => {
        config.signupPromotionReferenceId = undefined;
      },
    },
    {
      reason: "promotion_unavailable",
      mutate: (config) => {
        config.promotion = null;
      },
    },
    {
      reason: "promotion_reference_mismatch",
      mutate: (config) => {
        config.signupPromotionReferenceId = "promotion-2";
      },
    },
    {
      reason: "invalid_promotion_revision",
      mutate: (config) => {
        if (config.promotion) config.promotion._rev = " ";
      },
    },
    {
      reason: "invalid_offer_label",
      mutate: (config) => {
        config.signupOfferLabel = " ";
      },
    },
    {
      reason: "invalid_offer_terms",
      mutate: (config) => {
        config.signupOfferTerms = undefined;
      },
    },
    {
      reason: "invalid_offer_cta_label",
      mutate: (config) => {
        config.signupOfferCtaLabel = "";
      },
    },
    {
      reason: "invalid_offer_cta_url",
      mutate: (config) => {
        config.signupOfferCtaUrl = "http://example.com/products";
      },
    },
    {
      reason: "invalid_promotion_code",
      mutate: (config) => {
        if (config.promotion) config.promotion.code = "welcome20";
      },
    },
    {
      reason: "promotion_code_not_unique",
      mutate: (config) => {
        if (config.promotion) {
          config.promotion.matchingPromotionIds = [
            "promotion-1",
            "promotion-2",
          ];
        }
      },
    },
    {
      reason: "promotion_disabled",
      mutate: (config) => {
        if (config.promotion) config.promotion.isEnabled = false;
      },
    },
    {
      reason: "promotion_not_sitewide",
      mutate: (config) => {
        if (config.promotion) config.promotion.appliesTo = "products";
      },
    },
    {
      reason: "invalid_discount_type",
      mutate: (config) => {
        if (config.promotion) config.promotion.discountType = "bogus";
      },
    },
    {
      reason: "invalid_discount_amount",
      mutate: (config) => {
        if (config.promotion) config.promotion.amount = 101;
      },
    },
  ];

  for (const { reason, mutate } of cases) {
    const config = createConfig();
    mutate(config);
    assert.deepEqual(await resolve(config), { status: "invalid", reason });
  }
});

test("rejects editor fields that exceed the durable email payload bounds", async () => {
  for (const [field, length, reason] of [
    ["signupOfferLabel", 501, "invalid_offer_label"],
    ["signupOfferTerms", 2_001, "invalid_offer_terms"],
    ["signupOfferCtaLabel", 201, "invalid_offer_cta_label"],
    ["signupOfferCtaUrl", 2_001, "invalid_offer_cta_url"],
  ] as const) {
    const config = createConfig();
    config[field] =
      field === "signupOfferCtaUrl"
        ? `https://example.com/${"x".repeat(length)}`
        : "x".repeat(length);

    assert.deepEqual(await resolve(config), { status: "invalid", reason });
  }
});

function createConfig(): ContactPopupSignupOfferConfigSource {
  return {
    signupOfferEnabled: true,
    signupPromotionReferenceId: "promotion-1",
    signupOfferLabel: " 20% off your first order ",
    signupOfferTerms: " Valid on products and training programs. ",
    signupOfferCtaLabel: " Shop now ",
    signupOfferCtaUrl: " https://example.com/products ",
    promotion: {
      _id: "promotion-1",
      _rev: "revision-1",
      code: "WELCOME20",
      isEnabled: true,
      discountType: "percentage",
      amount: 20,
      appliesTo: "all",
      matchingPromotionIds: ["promotion-1"],
    },
  };
}

function resolve(config: ContactPopupSignupOfferConfigSource | null) {
  return resolveContactPopupSignupOffer({
    loadConfig: async () => config,
    now: () => NOW,
  });
}
