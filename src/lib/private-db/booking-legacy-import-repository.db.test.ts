import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { buildLegacyBookingImportPlan } from "@/lib/booking/operations/legacy-import-plan";

import { importLegacyBookingConfiguration } from "./booking-legacy-import-repository";
import { createPrivateDbPoolConfig } from "./pool-config";
import {
  bookingBusinessSettings,
  bookingProviders,
  bookingResources,
  bookingResourceSchedules,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferings,
} from "./schema";
import * as schema from "./schema";

const TEST_PREFIX = "legacy-import-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run legacy booking import DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
let insertedSettings = false;
let previousSettings: {
  bookingHorizonDays: number;
  timezone: string;
} | null = null;

afterEach(async () => {
  await cleanupTestRows();
});

after(async () => {
  await pool?.end();
});

test(
  "legacy import is idempotent, preserves activation and settings, and refreshes service configuration",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const providerSlug = `${TEST_PREFIX}${suffix}`;
    const serviceSlug = `${TEST_PREFIX}service-${suffix}`;
    const [existingSettings] = await database
      .select({
        bookingHorizonDays: bookingBusinessSettings.bookingHorizonDays,
        timezone: bookingBusinessSettings.timezone,
      })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"));
    previousSettings = existingSettings ?? null;
    insertedSettings = existingSettings === undefined;
    await database
      .insert(bookingBusinessSettings)
      .values({
        bookingHorizonDays: 77,
        singletonKey: "default",
        timezone: "America/St_Johns",
      })
      .onConflictDoUpdate({
        target: bookingBusinessSettings.singletonKey,
        set: {
          bookingHorizonDays: 77,
          timezone: "America/St_Johns",
        },
      });
    const plan = buildPlan({
      addOnPriceCad: 25,
      fullPriceCad: 120,
      providerSlug,
      serviceSlug,
    });
    const first = await importLegacyBookingConfiguration({
      db: database,
      plan,
    });

    assert.equal(first.offeringCount, 1);
    assert.equal(first.scheduleCount, 1);

    const [firstResource] = await database
      .select({ status: bookingResources.status })
      .from(bookingResources)
      .where(eq(bookingResources.id, first.resourceId));
    const [firstProvider] = await database
      .select({ status: bookingProviders.status })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, first.providerId));
    const [firstOffering] = await database
      .select({
        id: bookingServiceOfferings.id,
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
      })
      .from(bookingServiceOfferings)
      .where(
        eq(
          bookingServiceOfferings.offeringKey,
          `${serviceSlug}-${providerSlug}`,
        ),
      );
    const [firstService] = await database
      .select({
        id: bookingServices.id,
        ownerProviderId: bookingServices.ownerProviderId,
      })
      .from(bookingServices)
      .where(eq(bookingServices.serviceKey, serviceSlug));

    assert.equal(firstResource.status, "draft");
    assert.equal(firstProvider.status, "draft");
    assert.ok(firstOffering);
    assert.ok(firstService);
    assert.equal(firstService.ownerProviderId, first.providerId);
    assert.equal(firstOffering.publicTitle, "Legacy Test Service");
    assert.equal(firstOffering.publicTitleProvenance, "legacy");
    assert.equal(
      firstOffering.publicSummary,
      "Book Legacy Test Service with Legacy Import Test.",
    );
    assert.equal(firstOffering.publicSummaryProvenance, "legacy");

    await Promise.all([
      database
        .update(bookingResources)
        .set({ status: "active" })
        .where(eq(bookingResources.id, first.resourceId)),
      database
        .update(bookingProviders)
        .set({ status: "active" })
        .where(eq(bookingProviders.id, first.providerId)),
      database
        .update(bookingServices)
        .set({ status: "active" })
        .where(eq(bookingServices.id, firstService.id)),
      database
        .update(bookingServiceOfferings)
        .set({ status: "active" })
        .where(eq(bookingServiceOfferings.id, firstOffering.id)),
    ]);

    const second = await importLegacyBookingConfiguration({
      db: database,
      plan: buildPlan({
        addOnPriceCad: 30,
        fullPriceCad: 130,
        providerSlug,
        serviceSlug,
      }),
    });
    const [updated] = await database
      .select({
        addOnPriceCents: bookingServiceOfferingAddOns.priceCents,
        fullPriceCents: bookingServiceOfferings.fullPriceCents,
        offeringStatus: bookingServiceOfferings.status,
        resourceStatus: bookingResources.status,
      })
      .from(bookingServiceOfferings)
      .innerJoin(
        bookingServiceOfferingAddOns,
        eq(bookingServiceOfferingAddOns.offeringId, bookingServiceOfferings.id),
      )
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingServiceOfferings.primaryResourceId),
      )
      .where(eq(bookingServiceOfferings.id, firstOffering.id));
    const scheduleRows = await database
      .select({ id: bookingResourceSchedules.id })
      .from(bookingResourceSchedules)
      .where(eq(bookingResourceSchedules.resourceId, first.resourceId));
    const [businessSettings] = await database
      .select({
        bookingHorizonDays: bookingBusinessSettings.bookingHorizonDays,
        timezone: bookingBusinessSettings.timezone,
      })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"));

    assert.equal(second.resourceId, first.resourceId);
    assert.equal(second.providerId, first.providerId);
    assert.equal(second.scheduleCount, 0);
    assert.equal(scheduleRows.length, 1);
    assert.deepEqual(updated, {
      addOnPriceCents: 3_000,
      fullPriceCents: 13_000,
      offeringStatus: "active",
      resourceStatus: "active",
    });
    assert.deepEqual(businessSettings, {
      bookingHorizonDays: 77,
      timezone: "America/St_Johns",
    });
  },
);

test(
  "legacy import refreshes only legacy-owned public copy fields",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const providerSlug = `${TEST_PREFIX}copy-provider-${suffix}`;
    const serviceSlug = `${TEST_PREFIX}copy-service-${suffix}`;
    const first = await importLegacyBookingConfiguration({
      db: database,
      plan: buildPlan({
        addOnPriceCad: 25,
        fullPriceCad: 120,
        providerSlug,
        serviceSlug,
      }),
    });
    const [offering] = await database
      .select({ id: bookingServiceOfferings.id })
      .from(bookingServiceOfferings)
      .where(
        eq(
          bookingServiceOfferings.offeringKey,
          `${serviceSlug}-${providerSlug}`,
        ),
      );

    await database
      .update(bookingServiceOfferings)
      .set({
        publicTitle: "Legacy Test Service",
        publicTitleProvenance: "admin",
      })
      .where(eq(bookingServiceOfferings.id, offering.id));
    await importLegacyBookingConfiguration({
      db: database,
      plan: buildPlan({
        addOnPriceCad: 25,
        fullPriceCad: 125,
        providerSlug,
        publicSummary: "Refreshed legacy summary.",
        publicTitle: "Refreshed legacy title",
        serviceSlug,
      }),
    });

    const [partiallyRefreshed] = await database
      .select({
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
      })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, offering.id));
    assert.deepEqual(partiallyRefreshed, {
      publicSummary: "Refreshed legacy summary.",
      publicSummaryProvenance: "legacy",
      publicTitle: "Legacy Test Service",
      publicTitleProvenance: "admin",
    });

    await database
      .update(bookingServiceOfferings)
      .set({
        publicSummary: "Book Legacy Test Service with Legacy Import Test.",
        publicSummaryProvenance: "admin",
      })
      .where(eq(bookingServiceOfferings.id, offering.id));
    await importLegacyBookingConfiguration({
      db: database,
      plan: buildPlan({
        addOnPriceCad: 25,
        fullPriceCad: 130,
        providerSlug,
        publicSummary: "Third legacy summary.",
        publicTitle: "Third legacy title",
        serviceSlug,
      }),
    });

    const [preserved] = await database
      .select({
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
      })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, offering.id));
    assert.deepEqual(preserved, {
      publicSummary: "Book Legacy Test Service with Legacy Import Test.",
      publicSummaryProvenance: "admin",
      publicTitle: "Legacy Test Service",
      publicTitleProvenance: "admin",
    });
    assert.equal(first.offeringCount, 1);
  },
);

test(
  "legacy import keeps matching service identities separate per provider",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const serviceSlug = `${TEST_PREFIX}shared-service-${suffix}`;
    const firstProviderSlug = `${TEST_PREFIX}provider-a-${suffix}`;
    const secondProviderSlug = `${TEST_PREFIX}provider-b-${suffix}`;

    const first = await importLegacyBookingConfiguration({
      db: database,
      plan: buildPlan({
        addOnPriceCad: 25,
        fullPriceCad: 120,
        providerSlug: firstProviderSlug,
        serviceSlug,
      }),
    });
    const [ownedService] = await database
      .select({ ownerProviderId: bookingServices.ownerProviderId })
      .from(bookingServices)
      .where(eq(bookingServices.serviceKey, serviceSlug));
    assert.equal(ownedService.ownerProviderId, first.providerId);

    const second = await importLegacyBookingConfiguration({
      db: database,
      plan: buildPlan({
        addOnPriceCad: 25,
        fullPriceCad: 125,
        providerSlug: secondProviderSlug,
        serviceSlug,
      }),
    });
    const matchingServices = await database
      .select({
        ownerProviderId: bookingServices.ownerProviderId,
        publicSlug: bookingServices.publicSlug,
        sanityDocumentId: bookingServices.sanityDocumentId,
      })
      .from(bookingServices)
      .where(eq(bookingServices.serviceKey, serviceSlug));

    assert.equal(matchingServices.length, 2);
    assert.deepEqual(
      new Set(matchingServices.map((service) => service.ownerProviderId)),
      new Set([first.providerId, second.providerId]),
    );
    assert.ok(
      matchingServices.every(
        (service) =>
          service.publicSlug === serviceSlug &&
          service.sanityDocumentId === `${serviceSlug}-sanity`,
      ),
    );
  },
);

function buildPlan(input: {
  addOnPriceCad: number;
  fullPriceCad: number;
  providerSlug: string;
  publicSummary?: string;
  publicTitle?: string;
  serviceSlug: string;
}) {
  return buildLegacyBookingImportPlan({
    effectiveFrom: "2032-01-15",
    providerName: "Legacy Import Test",
    providerSlug: input.providerSlug,
    services: [
      {
        addOns: [
          {
            key: "removal",
            name: "Removal",
            priceCad: input.addOnPriceCad,
          },
        ],
        depositCad: 40,
        description: input.publicSummary,
        durationMinutes: 90,
        fullPriceCad: input.fullPriceCad,
        sanityDocumentId: `${input.serviceSlug}-sanity`,
        slug: input.serviceSlug,
        title: input.publicTitle ?? "Legacy Test Service",
      },
    ],
    settings: {
      bookingHorizonDays: 30,
      bufferMinutes: 15,
      hoursOfOperation: [
        {
          closesAt: "18:00",
          day: "monday",
          isOpen: true,
          opensAt: "10:00",
        },
      ],
      minimumLeadTimeHours: 24,
      slotIntervalMinutes: 15,
      timezone: "America/Toronto",
    },
  });
}

function requireDb(): NonNullable<typeof db> {
  assert.ok(db, skipReason);
  return db;
}

async function cleanupTestRows(): Promise<void> {
  if (!db) return;

  const offerings = await db
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(like(bookingServiceOfferings.offeringKey, `${TEST_PREFIX}%`));

  for (const offering of offerings) {
    await db
      .delete(bookingServiceOfferingAddOns)
      .where(eq(bookingServiceOfferingAddOns.offeringId, offering.id));
  }
  await db
    .delete(bookingServiceOfferings)
    .where(like(bookingServiceOfferings.offeringKey, `${TEST_PREFIX}%`));

  const resources = await db
    .select({ id: bookingResources.id })
    .from(bookingResources)
    .where(like(bookingResources.resourceKey, `${TEST_PREFIX}%`));
  for (const resource of resources) {
    await db
      .delete(bookingResourceSchedules)
      .where(eq(bookingResourceSchedules.resourceId, resource.id));
  }

  await db
    .delete(bookingServices)
    .where(like(bookingServices.serviceKey, `${TEST_PREFIX}%`));
  await db
    .delete(bookingProviders)
    .where(like(bookingProviders.providerKey, `${TEST_PREFIX}%`));
  await db
    .delete(bookingResources)
    .where(like(bookingResources.resourceKey, `${TEST_PREFIX}%`));

  if (insertedSettings) {
    await db
      .delete(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"));
    insertedSettings = false;
  } else if (previousSettings !== null) {
    await db
      .update(bookingBusinessSettings)
      .set(previousSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"));
  }
  previousSettings = null;
}
