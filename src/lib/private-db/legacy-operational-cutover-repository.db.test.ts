import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, beforeEach } from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  importLegacyOperationalCutover,
  prepareLegacyOperationalCutover,
} from "./legacy-operational-cutover-repository";
import { createPrivateDbPoolConfig } from "./pool-config";
import {
  bookingBusinessSettings,
  bookingProviders,
  bookingResources,
  bookingServices,
  bookingServiceOfferings,
  bookingServicePromotionCodes,
  bookingServicePromotionOfferings,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run operational cutover DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
type BusinessSettingsRow = typeof bookingBusinessSettings.$inferSelect;
let testIds: {
  offeringId: string;
  promotionSourceId: string;
  providerId: string;
  resourceId: string;
  serviceId: string;
} | null = null;
let previousSettings: {
  intakeQuestions: BusinessSettingsRow["intakeQuestions"];
  marketingOptInLabel: string;
  version: number;
} | null = null;
let hadSettings = false;

beforeEach(async () => {
  if (!db) return;
  const [settings] = await db
    .select({
      intakeQuestions: bookingBusinessSettings.intakeQuestions,
      marketingOptInLabel: bookingBusinessSettings.marketingOptInLabel,
      version: bookingBusinessSettings.version,
    })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"));
  previousSettings = settings ?? null;
  hadSettings = settings !== undefined;
});

afterEach(async () => {
  if (!db || !testIds) return;
  await db
    .delete(bookingServicePromotionCodes)
    .where(
      eq(
        bookingServicePromotionCodes.sourceSanityDocumentId,
        testIds.promotionSourceId,
      ),
    );
  await db
    .delete(bookingServiceOfferings)
    .where(eq(bookingServiceOfferings.id, testIds.offeringId));
  await db
    .delete(bookingServices)
    .where(eq(bookingServices.id, testIds.serviceId));
  await db
    .delete(bookingProviders)
    .where(eq(bookingProviders.id, testIds.providerId));
  await db
    .delete(bookingResources)
    .where(eq(bookingResources.id, testIds.resourceId));

  if (previousSettings) {
    await db
      .update(bookingBusinessSettings)
      .set(previousSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"));
  } else if (!hadSettings) {
    await db
      .delete(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"));
  }
  testIds = null;
  previousSettings = null;
  hadSettings = false;
});

after(async () => {
  await pool?.end();
});

test(
  "operational cutover import is idempotent, exact, and disables stale Sanity promotions",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const promotionSourceId = `cutover-promo-${suffix}`;
    const sanityServiceId = `cutover-service-${suffix}`;
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: "Cutover Test Provider",
        resourceKey: `cutover-resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning({ id: bookingResources.id });
    const [provider] = await database
      .insert(bookingProviders)
      .values({
        displayName: "Cutover Test Provider",
        primaryResourceId: resource.id,
        providerKey: `cutover-provider-${suffix}`,
        publicSlug: `cutover-provider-${suffix}`,
        status: "active",
      })
      .returning({ id: bookingProviders.id });
    const [service] = await database
      .insert(bookingServices)
      .values({
        displayTitle: "Legacy Cutover Service",
        ownerProviderId: provider.id,
        publicSlug: `cutover-service-${suffix}`,
        sanityDocumentId: sanityServiceId,
        serviceKey: `cutover-service-${suffix}`,
        status: "active",
      })
      .returning({ id: bookingServices.id });
    const [offering] = await database
      .insert(bookingServiceOfferings)
      .values({
        depositAmountCents: 5_000,
        durationMinutes: 90,
        fullPriceCents: 12_000,
        offeringKey: `cutover-offering-${suffix}`,
        primaryResourceId: resource.id,
        providerId: provider.id,
        publicSummary:
          "Book Legacy Cutover Service with Cutover Test Provider.",
        publicTitle: "Legacy Cutover Service",
        serviceId: service.id,
        status: "active",
      })
      .returning({ id: bookingServiceOfferings.id });
    testIds = {
      offeringId: offering.id,
      promotionSourceId,
      providerId: provider.id,
      resourceId: resource.id,
      serviceId: service.id,
    };

    const source = buildSource({
      amount: 10,
      promotionSourceId,
      sanityServiceId,
    });
    const dryRun = await prepareLegacyOperationalCutover({
      db: database,
      source,
    });
    assert.equal(dryRun.plan.counts.promotionEligibilityCount, 1);
    assert.equal(dryRun.plan.counts.offeringCopyUpdateCount, 1);

    await importLegacyOperationalCutover({ db: database, source });
    const [enrichedOffering] = await database
      .select({
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
      })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, offering.id));
    assert.deepEqual(enrichedOffering, {
      publicSummary: "Imported public service summary.",
      publicSummaryProvenance: "legacy",
      publicTitle: "Imported public service title",
      publicTitleProvenance: "legacy",
    });

    await database
      .update(bookingServiceOfferings)
      .set({
        publicTitle: "Legacy Cutover Service",
        publicTitleProvenance: "admin",
      })
      .where(eq(bookingServiceOfferings.id, offering.id));
    const rerunResult = await importLegacyOperationalCutover({
      db: database,
      source: buildSource({
        amount: 12.5,
        promotionSourceId,
        publicSummary: "Changed Sanity summary.",
        publicTitle: "Changed Sanity title",
        sanityServiceId,
      }),
    });
    assert.equal(rerunResult.offeringCopyUpdateCount, 1);

    const [partiallyEnrichedOffering] = await database
      .select({
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
      })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, offering.id));
    assert.deepEqual(partiallyEnrichedOffering, {
      publicSummary: "Changed Sanity summary.",
      publicSummaryProvenance: "legacy",
      publicTitle: "Legacy Cutover Service",
      publicTitleProvenance: "admin",
    });

    await database
      .update(bookingServiceOfferings)
      .set({
        publicSummary:
          "Book Legacy Cutover Service with Cutover Test Provider.",
        publicSummaryProvenance: "admin",
      })
      .where(eq(bookingServiceOfferings.id, offering.id));
    const exactFallbackRerunResult = await importLegacyOperationalCutover({
      db: database,
      source: buildSource({
        amount: 12.5,
        promotionSourceId,
        publicSummary: "Third Sanity summary.",
        publicTitle: "Third Sanity title",
        sanityServiceId,
      }),
    });
    assert.equal(exactFallbackRerunResult.offeringCopyUpdateCount, 0);

    const [promotion] = await database
      .select({
        discountValue: bookingServicePromotionCodes.discountValue,
        id: bookingServicePromotionCodes.id,
        status: bookingServicePromotionCodes.status,
      })
      .from(bookingServicePromotionCodes)
      .where(
        eq(
          bookingServicePromotionCodes.sourceSanityDocumentId,
          promotionSourceId,
        ),
      );
    const eligibility = await database
      .select({ offeringId: bookingServicePromotionOfferings.offeringId })
      .from(bookingServicePromotionOfferings)
      .where(
        eq(bookingServicePromotionOfferings.promotionCodeId, promotion.id),
      );
    const [updatedOffering] = await database
      .select({
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
      })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, offering.id));

    assert.equal(promotion.discountValue, 1_250);
    assert.equal(promotion.status, "active");
    assert.deepEqual(eligibility, [{ offeringId: offering.id }]);
    assert.deepEqual(updatedOffering, {
      publicSummary: "Book Legacy Cutover Service with Cutover Test Provider.",
      publicSummaryProvenance: "admin",
      publicTitle: "Legacy Cutover Service",
      publicTitleProvenance: "admin",
    });

    const staleResult = await importLegacyOperationalCutover({
      db: database,
      source: { ...source, promotions: [] },
    });
    const [disabled] = await database
      .select({ status: bookingServicePromotionCodes.status })
      .from(bookingServicePromotionCodes)
      .where(eq(bookingServicePromotionCodes.id, promotion.id));
    const staleEligibility = await database
      .select({ id: bookingServicePromotionOfferings.id })
      .from(bookingServicePromotionOfferings)
      .where(
        eq(bookingServicePromotionOfferings.promotionCodeId, promotion.id),
      );

    assert.equal(staleResult.stalePromotionDisableCount, 1);
    assert.equal(disabled.status, "disabled");
    assert.equal(staleEligibility.length, 0);
  },
);

function buildSource(input: {
  amount: number;
  promotionSourceId: string;
  publicSummary?: string;
  publicTitle?: string;
  sanityServiceId: string;
}) {
  return {
    promotions: [
      {
        _id: input.promotionSourceId,
        amount: input.amount,
        appliesTo: "specificItems",
        code: "CUTOVER_TEST",
        discountType: "percentage",
        isEnabled: true,
        serviceIds: [input.sanityServiceId],
        title: "Cutover test promotion",
      },
    ],
    services: [
      {
        _id: input.sanityServiceId,
        shortDescription:
          input.publicSummary ?? "Imported public service summary.",
        title: input.publicTitle ?? "Imported public service title",
      },
    ],
    settings: {
      intakeQuestions: [],
      marketingOptInLabel: "Cutover test marketing consent.",
    },
  };
}

function requireDb(): NonNullable<typeof db> {
  assert.ok(db, skipReason);
  return db;
}
