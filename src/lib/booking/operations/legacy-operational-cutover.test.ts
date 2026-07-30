import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLegacyOperationalCutoverPlan,
  type LegacyOperationalCutoverSource,
  validateLegacyOperationalPromotionLineage,
} from "./legacy-operational-cutover";

const settings = {
  intakeQuestions: [
    {
      _key: "question-key",
      id: "allergies",
      inputType: "textarea",
      label: "List any allergies",
      required: true,
    },
  ],
  marketingOptInLabel: "Send me occasional service updates.",
};

const offerings = [
  {
    id: "offering-nataliea",
    offeringKey: "classic-nataliea",
    providerDisplayName: "Nataliea",
    publicSummary: "Book Classic lashes with Nataliea.",
    publicSummaryProvenance: "legacy" as const,
    publicTitle: "Classic lashes",
    publicTitleProvenance: "legacy" as const,
    serviceId: "service-classic",
    serviceDisplayTitle: "Classic lashes",
    serviceSanityDocumentId: "sanity-classic",
  },
  {
    id: "offering-riley",
    offeringKey: "classic-riley",
    providerDisplayName: "Riley",
    publicSummary: "Book Classic lashes with Riley.",
    publicSummaryProvenance: "legacy" as const,
    publicTitle: "Classic lashes",
    publicTitleProvenance: "legacy" as const,
    serviceId: "service-classic",
    serviceDisplayTitle: "Classic lashes",
    serviceSanityDocumentId: "sanity-classic",
  },
  {
    id: "offering-volume",
    offeringKey: "volume-nataliea",
    providerDisplayName: "Nataliea",
    publicSummary: "Book Volume lashes with Nataliea.",
    publicSummaryProvenance: "legacy" as const,
    publicTitle: "Volume lashes",
    publicTitleProvenance: "legacy" as const,
    serviceId: "service-volume",
    serviceDisplayTitle: "Volume lashes",
    serviceSanityDocumentId: "sanity-volume",
  },
];

test("maps legacy settings and promotions to exact operational offerings", () => {
  const plan = buildLegacyOperationalCutoverPlan({
    offerings,
    source: {
      promotions: [
        {
          _id: "promo-classic",
          amount: 12.5,
          appliesTo: "specificItems",
          code: "CLASSIC12",
          discountType: "percentage",
          isEnabled: true,
          serviceIds: ["sanity-classic"],
          title: "Classic promotion",
        },
        {
          _id: "promo-all",
          amount: 20,
          appliesTo: "services",
          code: "ALL20",
          discountType: "fixed",
          isEnabled: false,
          serviceIds: [],
          title: "All service promotion",
        },
      ],
      services: [
        {
          _id: "sanity-classic",
          description: "A provider-specific classic lash service.",
          title: "Classic lashes",
        },
      ],
      settings,
    },
  });

  assert.deepEqual(plan.settings, {
    intakeQuestions: [
      {
        id: "allergies",
        inputType: "textarea",
        label: "List any allergies",
        required: true,
      },
    ],
    marketingOptInLabel: "Send me occasional service updates.",
  });
  assert.deepEqual(plan.promotions[0], {
    code: "CLASSIC12",
    discountType: "percentage",
    discountValue: 1_250,
    internalTitle: "Classic promotion",
    offeringIds: ["offering-nataliea", "offering-riley"],
    sourceSanityDocumentId: "promo-classic",
    status: "active",
  });
  assert.deepEqual(plan.promotions[1]?.offeringIds, [
    "offering-nataliea",
    "offering-riley",
    "offering-volume",
  ]);
  assert.deepEqual(plan.offeringCopyUpdates, [
    {
      offeringId: "offering-nataliea",
      publicSummary: "A provider-specific classic lash service.",
    },
    {
      offeringId: "offering-riley",
      publicSummary: "A provider-specific classic lash service.",
    },
  ]);
  assert.equal(plan.promotions[1]?.status, "disabled");
  assert.deepEqual(plan.counts, {
    intakeQuestionCount: 1,
    offeringCopyUpdateCount: 2,
    promotionCount: 2,
    promotionEligibilityCount: 5,
    referencedServiceCount: 1,
    targetOfferingCount: 3,
  });
});

test("fails closed when settings or an exact service mapping is missing", () => {
  assert.throws(
    () =>
      buildLegacyOperationalCutoverPlan({
        offerings,
        source: { promotions: [], services: [], settings: null },
      }),
    /cutover is blocked/,
  );

  assert.throws(
    () =>
      buildLegacyOperationalCutoverPlan({
        offerings,
        source: sourceWithPromotion({
          serviceIds: ["sanity-missing"],
        }),
      }),
    /no operational offering maps/,
  );
});

test("fails closed on ambiguous mappings, duplicate codes, and lossy discounts", () => {
  assert.throws(
    () =>
      buildLegacyOperationalCutoverPlan({
        offerings: [
          ...offerings,
          {
            ...offerings[0],
            id: "offering-ambiguous",
            offeringKey: "ambiguous",
            serviceId: "different-service",
          },
        ],
        source: sourceWithPromotion(),
      }),
    /maps to multiple operational services/,
  );

  const duplicateCodeSource = sourceWithPromotion();
  duplicateCodeSource.promotions.push({
    ...duplicateCodeSource.promotions[0],
    _id: "another-promotion",
  });
  assert.throws(
    () =>
      buildLegacyOperationalCutoverPlan({
        offerings,
        source: duplicateCodeSource,
      }),
    /Duplicate Sanity service promotion code/,
  );

  assert.throws(
    () =>
      buildLegacyOperationalCutoverPlan({
        offerings,
        source: sourceWithPromotion({ amount: 12.345 }),
      }),
    /at most two decimal places/,
  );
});

test("enriches legacy-owned fields independently", () => {
  const plan = buildLegacyOperationalCutoverPlan({
    offerings: [
      {
        ...offerings[0],
        publicSummary: "Book Classic lashes with Nataliea.",
        publicTitle: "Administrator-authored title",
        publicTitleProvenance: "admin",
      },
      {
        ...offerings[1],
        publicSummary: "Administrator-authored summary.",
        publicSummaryProvenance: "admin",
        publicTitle: "Classic lashes",
      },
    ],
    source: {
      promotions: [],
      services: [
        {
          _id: "sanity-classic",
          shortDescription: "Imported source summary.",
          title: "Imported source title",
        },
      ],
      settings,
    },
  });

  assert.deepEqual(plan.offeringCopyUpdates, [
    {
      offeringId: "offering-nataliea",
      publicSummary: "Imported source summary.",
    },
    {
      offeringId: "offering-riley",
      publicTitle: "Imported source title",
    },
  ]);
  assert.equal(plan.counts.offeringCopyUpdateCount, 2);
});

test("preserves admin-owned copy even when it exactly matches migration fallbacks", () => {
  const plan = buildLegacyOperationalCutoverPlan({
    offerings: [
      {
        ...offerings[0],
        publicSummary: "Book Classic lashes with Nataliea.",
        publicSummaryProvenance: "admin",
        publicTitle: "Classic lashes",
        publicTitleProvenance: "admin",
      },
    ],
    source: {
      promotions: [],
      services: [
        {
          _id: "sanity-classic",
          shortDescription: "Changed source summary.",
          title: "Changed source title",
        },
      ],
      settings,
    },
  });

  assert.deepEqual(plan.offeringCopyUpdates, []);
  assert.equal(plan.counts.offeringCopyUpdateCount, 0);
});

test("does not plan a copy write when imported copy is already present", () => {
  const plan = buildLegacyOperationalCutoverPlan({
    offerings: [
      {
        ...offerings[0],
        publicSummary: "Imported source summary.",
        publicTitle: "Imported source title",
      },
    ],
    source: {
      promotions: [],
      services: [
        {
          _id: "sanity-classic",
          shortDescription: "Imported source summary.",
          title: "Imported source title",
        },
      ],
      settings,
    },
  });

  assert.deepEqual(plan.offeringCopyUpdates, []);
  assert.equal(plan.counts.offeringCopyUpdateCount, 0);
});

test("tracks imported lineage idempotently and rejects operational code collisions", () => {
  const plan = buildLegacyOperationalCutoverPlan({
    offerings,
    source: sourceWithPromotion(),
  });
  assert.deepEqual(
    validateLegacyOperationalPromotionLineage({
      existingPromotions: [
        {
          code: "CLASSIC10",
          id: "existing-current",
          sourceSanityDocumentId: "promo-classic",
        },
        {
          code: "STALE10",
          id: "existing-stale",
          sourceSanityDocumentId: "promo-stale",
        },
      ],
      plan,
    }),
    {
      existingImportedPromotionCount: 2,
      stalePromotionIds: ["existing-stale"],
    },
  );

  assert.throws(
    () =>
      validateLegacyOperationalPromotionLineage({
        existingPromotions: [
          {
            code: "CLASSIC10",
            id: "admin-created",
            sourceSanityDocumentId: null,
          },
        ],
        plan,
      }),
    /without Sanity import lineage/,
  );
});

function sourceWithPromotion(
  overrides: Partial<LegacyOperationalCutoverSource["promotions"][number]> = {},
): LegacyOperationalCutoverSource {
  return {
    promotions: [
      {
        _id: "promo-classic",
        amount: 10,
        appliesTo: "specificItems",
        code: "CLASSIC10",
        discountType: "percentage",
        isEnabled: true,
        serviceIds: ["sanity-classic"],
        title: "Classic promotion",
        ...overrides,
      },
    ],
    services: [],
    settings,
  };
}
