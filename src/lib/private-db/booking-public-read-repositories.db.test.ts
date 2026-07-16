import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createDrizzleBookingAvailabilityRepository } from "./booking-availability-repository";
import { createDrizzleOperationalBookingConfigurationRepository } from "./booking-configuration-repository";
import { createPrivateDbPoolConfig } from "./pool-config";
import {
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResources,
  bookingResourceScheduleExceptions,
  bookingResourceSchedules,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
} from "./schema";
import * as schema from "./schema";

const TEST_PREFIX = "v2-public-read-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run booking public-read DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;

afterEach(async () => {
  if (db) await cleanupTestRows();
});

after(async () => {
  await pool?.end();
});

test(
  "configuration repository filters active/effective offerings and hydrates defaults, add-ons, and write calendar",
  { skip: skipReason },
  async () => {
    const fixture = await seedConfigurationFixture();
    const repository = createDrizzleOperationalBookingConfigurationRepository(
      requireDb(),
    );
    const [businessDefaults] = await requireDb()
      .select({
        bookingHorizonDays: bookingBusinessSettings.bookingHorizonDays,
        minimumLeadTimeHours: bookingBusinessSettings.minimumLeadTimeHours,
      })
      .from(bookingBusinessSettings)
      .limit(1);
    const expectedDefaults = businessDefaults ?? {
      bookingHorizonDays: 30,
      minimumLeadTimeHours: 24,
    };

    const offerings = await repository.listActiveOfferingsBySanityServiceId({
      now: fixture.now,
      sanityServiceId: fixture.sanityServiceId,
      servicePublicSlug: fixture.servicePublicSlug,
    });

    assert.equal(offerings.length, 1);
    assert.equal(offerings[0].id, fixture.activeOfferingId);
    assert.equal(
      offerings[0].horizonDays,
      expectedDefaults.bookingHorizonDays,
    );
    assert.equal(
      offerings[0].minimumLeadTimeHours,
      expectedDefaults.minimumLeadTimeHours,
    );
    assert.deepEqual(
      offerings[0].addOns.map((addOn) => addOn.key),
      ["active-addon"],
    );
    assert.deepEqual(offerings[0].calendar, {
      assignmentId: fixture.writeAssignmentId,
      calendarId: fixture.writeCalendarId,
      connectionId: fixture.writeConnectionId,
    });
    assert.equal(
      (await repository.listActiveOfferings({ now: fixture.now })).some(
        (offering) => offering.id === fixture.futureOfferingId,
      ),
      false,
    );
    assert.deepEqual(
      await repository.listActiveOfferingsBySanityServiceId({
        now: fixture.now,
        sanityServiceId: "stale-sanity-document-id",
        servicePublicSlug: fixture.servicePublicSlug,
      }),
      [],
    );
  },
);

test(
  "availability repository loads required resources, active schedules/exceptions, and connection-specific busy assignments",
  { skip: skipReason },
  async () => {
    const fixture = await seedConfigurationFixture({ secondaryResource: true });
    const repository = createDrizzleBookingAvailabilityRepository(requireDb());
    const result = await repository.getOfferingAvailabilityConfiguration({
      offeringId: fixture.activeOfferingId,
      primaryResourceId: fixture.primaryResourceId,
      timeMax: new Date("2030-06-04T00:00:00.000Z"),
      timeMin: new Date("2030-06-03T00:00:00.000Z"),
    });

    assert.deepEqual(
      result.requiredResourceIds,
      [fixture.primaryResourceId, fixture.secondaryResourceId].sort(),
    );
    assert.equal(result.resources.length, 2);
    const primary = result.resources.find(
      (resource) => resource.resourceId === fixture.primaryResourceId,
    );
    assert.ok(primary);
    assert.deepEqual(primary.recurringWindows, [
      {
        effectiveFrom: "2030-01-01",
        endsAt: "17:00",
        isoWeekday: 1,
        startsAt: "09:00",
        timezone: "America/Toronto",
      },
    ]);
    assert.deepEqual(
      primary.exceptions.map((exception) => exception.kind),
      ["unavailable"],
    );
    assert.deepEqual(
      primary.busyCalendarAssignments.map((assignment) => ({
        calendarId: assignment.calendarId,
        connectionId: assignment.connectionId,
      })).sort((first, second) =>
        first.calendarId.localeCompare(second.calendarId),
      ),
      [
        {
          calendarId: fixture.busyCalendarId,
          connectionId: fixture.busyConnectionId,
        },
        {
          calendarId: fixture.writeCalendarId,
          connectionId: fixture.writeConnectionId,
        },
      ].sort((first, second) =>
        first.calendarId.localeCompare(second.calendarId),
      ),
    );
  },
);

test(
  "configuration repository distinguishes active V2 intent from unhealthy calendar configuration",
  { skip: skipReason },
  async () => {
    const fixture = await seedConfigurationFixture();
    const repository = createDrizzleOperationalBookingConfigurationRepository(
      requireDb(),
    );
    await requireDb()
      .update(bookingResourceCalendarAssignments)
      .set({ status: "disabled" })
      .where(
        eq(bookingResourceCalendarAssignments.id, fixture.writeAssignmentId),
      );

    assert.deepEqual(
      await repository.listActiveOfferingsBySanityServiceId({
        now: fixture.now,
        sanityServiceId: fixture.sanityServiceId,
      }),
      [],
    );
    assert.equal(
      await repository.hasActiveOfferingIntent({
        now: fixture.now,
        sanityServiceId: fixture.sanityServiceId,
      }),
      true,
    );
    assert.equal(
      await repository.hasActiveOfferingIntent({
        now: fixture.now,
        sanityServiceId: "stale-sanity-document-id",
        servicePublicSlug: fixture.servicePublicSlug,
      }),
      true,
    );
    assert.equal(
      await repository.hasActiveOfferingIntent({
        now: fixture.now,
        sanityServiceId: "unrelated-sanity-document-id",
        servicePublicSlug: "unrelated-service-slug",
      }),
      false,
    );
  },
);

interface SeedFixtureOptions {
  secondaryResource?: boolean;
}

async function seedConfigurationFixture(
  options: SeedFixtureOptions = {},
): Promise<{
  activeOfferingId: string;
  busyCalendarId: string;
  busyConnectionId: string;
  futureOfferingId: string;
  now: Date;
  primaryResourceId: string;
  sanityServiceId: string;
  secondaryResourceId: string;
  servicePublicSlug: string;
  writeAssignmentId: string;
  writeCalendarId: string;
  writeConnectionId: string;
}> {
  const database = requireDb();
  const suffix = randomUUID();
  const now = new Date("2030-06-03T08:00:00.000Z");
  const [primaryResource] = await database
    .insert(bookingResources)
    .values({
      kind: "provider",
      name: `Public read provider ${suffix}`,
      resourceKey: `${TEST_PREFIX}primary-${suffix}`,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();
  const [secondaryResource] = await database
    .insert(bookingResources)
    .values({
      kind: "room",
      name: `Public read room ${suffix}`,
      resourceKey: `${TEST_PREFIX}secondary-${suffix}`,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();
  const [provider] = await database
    .insert(bookingProviders)
    .values({
      displayName: `Public read provider ${suffix}`,
      primaryResourceId: primaryResource.id,
      providerKey: `${TEST_PREFIX}provider-${suffix}`,
      publicSlug: `${TEST_PREFIX}provider-${suffix}`,
      status: "active",
    })
    .returning();
  const sanityServiceId = `${TEST_PREFIX}sanity-${suffix}`;
  const servicePublicSlug = `${TEST_PREFIX}service-${suffix}`;
  const [service] = await database
    .insert(bookingServices)
    .values({
      displayTitle: `Public read service ${suffix}`,
      publicSlug: servicePublicSlug,
      sanityDocumentId: sanityServiceId,
      serviceKey: `${TEST_PREFIX}service-${suffix}`,
      status: "active",
    })
    .returning();
  const [activeOffering, futureOffering] = await database
    .insert(bookingServiceOfferings)
    .values([
      {
        depositAmountCents: 5000,
        durationMinutes: 60,
        effectiveFrom: new Date("2030-01-01T00:00:00.000Z"),
        effectiveUntil: new Date("2030-12-31T00:00:00.000Z"),
        fullPriceCents: 15000,
        offeringKey: `${TEST_PREFIX}active-${suffix}`,
        primaryResourceId: primaryResource.id,
        providerId: provider.id,
        serviceId: service.id,
        slotIntervalMinutes: 30,
        status: "active",
      },
      {
        depositAmountCents: 5000,
        durationMinutes: 60,
        effectiveFrom: new Date("2031-01-01T00:00:00.000Z"),
        fullPriceCents: 15000,
        offeringKey: `${TEST_PREFIX}future-${suffix}`,
        primaryResourceId: primaryResource.id,
        providerId: provider.id,
        serviceId: service.id,
        slotIntervalMinutes: 30,
        status: "active",
      },
    ])
    .returning();
  await database.insert(bookingServiceOfferingAddOns).values([
    {
      addOnKey: "active-addon",
      description: "Active",
      name: "Active add-on",
      offeringId: activeOffering.id,
      priceCents: 1000,
      status: "active",
    },
    {
      addOnKey: "disabled-addon",
      description: "Disabled",
      name: "Disabled add-on",
      offeringId: activeOffering.id,
      priceCents: 1000,
      status: "disabled",
    },
  ]);
  const [writeConnection, busyConnection] = await database
    .insert(bookingCalendarConnections)
    .values([
      {
        accountEmail: `${TEST_PREFIX}write-${suffix}@example.com`,
        credentialSecretRef: `${TEST_PREFIX}write-secret-${suffix}`,
        provider: "google",
        providerAccountId: `${TEST_PREFIX}write-account-${suffix}`,
        status: "active",
      },
      {
        accountEmail: `${TEST_PREFIX}busy-${suffix}@example.com`,
        credentialSecretRef: `${TEST_PREFIX}busy-secret-${suffix}`,
        provider: "google",
        providerAccountId: `${TEST_PREFIX}busy-account-${suffix}`,
        status: "active",
      },
    ])
    .returning();
  const writeCalendarId = `${TEST_PREFIX}write-calendar-${suffix}@example.com`;
  const busyCalendarId = `${TEST_PREFIX}busy-calendar-${suffix}@example.com`;
  const [writeAssignment] = await database
    .insert(bookingResourceCalendarAssignments)
    .values([
      {
        acceptsBookings: true,
        calendarConnectionId: writeConnection.id,
        calendarLabel: `${TEST_PREFIX}write-${suffix}`,
        contributesBusy: true,
        providerCalendarId: writeCalendarId,
        resourceId: primaryResource.id,
        status: "active",
      },
      {
        acceptsBookings: false,
        calendarConnectionId: busyConnection.id,
        calendarLabel: `${TEST_PREFIX}busy-${suffix}`,
        contributesBusy: true,
        providerCalendarId: busyCalendarId,
        resourceId: primaryResource.id,
        status: "active",
      },
    ])
    .returning();
  await database.insert(bookingResourceSchedules).values([
    {
      effectiveFrom: "2030-01-01",
      endsAt: "17:00",
      resourceId: primaryResource.id,
      startsAt: "09:00",
      status: "active",
      timezone: "America/Toronto",
      weekday: 1,
    },
    {
      effectiveFrom: "2030-01-01",
      endsAt: "18:00",
      resourceId: primaryResource.id,
      startsAt: "08:00",
      status: "disabled",
      timezone: "America/Toronto",
      weekday: 1,
    },
    {
      effectiveFrom: "2030-01-01",
      endsAt: "16:00",
      resourceId: secondaryResource.id,
      startsAt: "10:00",
      status: "active",
      timezone: "America/Toronto",
      weekday: 1,
    },
  ]);
  await database.insert(bookingResourceScheduleExceptions).values([
    {
      endsAt: new Date("2030-06-03T16:00:00.000Z"),
      kind: "unavailable",
      reasonCode: TEST_PREFIX,
      resourceId: primaryResource.id,
      startsAt: new Date("2030-06-03T15:00:00.000Z"),
      status: "active",
      timezone: "America/Toronto",
    },
    {
      endsAt: new Date("2030-06-03T18:00:00.000Z"),
      kind: "unavailable",
      reasonCode: TEST_PREFIX,
      resourceId: primaryResource.id,
      startsAt: new Date("2030-06-03T17:00:00.000Z"),
      status: "cancelled",
      timezone: "America/Toronto",
    },
  ]);

  if (options.secondaryResource) {
    await database.insert(bookingServiceOfferingResources).values({
      isRequired: true,
      offeringId: activeOffering.id,
      resourceId: secondaryResource.id,
      role: "room",
    });
  }

  return {
    activeOfferingId: activeOffering.id,
    busyCalendarId,
    busyConnectionId: busyConnection.id,
    futureOfferingId: futureOffering.id,
    now,
    primaryResourceId: primaryResource.id,
    sanityServiceId,
    secondaryResourceId: secondaryResource.id,
    servicePublicSlug,
    writeAssignmentId: writeAssignment.id,
    writeCalendarId,
    writeConnectionId: writeConnection.id,
  };
}

function requireDb() {
  if (!db) throw new Error("TEST_DATABASE_URL not configured");
  return db;
}

async function cleanupTestRows(): Promise<void> {
  const database = requireDb();
  await database.execute(
    sql`delete from ${bookingResourceScheduleExceptions} where ${bookingResourceScheduleExceptions.reasonCode} = ${TEST_PREFIX}`,
  );
  const offeringRows = await database
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(
      sql`${bookingServiceOfferings.offeringKey} like ${`${TEST_PREFIX}%`}`,
    );
  const offeringIds = offeringRows.map((row) => row.id);
  if (offeringIds.length > 0) {
    await database
      .delete(bookingServiceOfferingAddOns)
      .where(inArray(bookingServiceOfferingAddOns.offeringId, offeringIds));
    await database
      .delete(bookingServiceOfferingResources)
      .where(inArray(bookingServiceOfferingResources.offeringId, offeringIds));
    await database
      .delete(bookingServiceOfferings)
      .where(inArray(bookingServiceOfferings.id, offeringIds));
  }
  await database.execute(
    sql`delete from ${bookingResourceCalendarAssignments} where ${bookingResourceCalendarAssignments.calendarLabel} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingCalendarConnections} where ${bookingCalendarConnections.accountEmail} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingProviders} where ${bookingProviders.providerKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingServices} where ${bookingServices.serviceKey} like ${`${TEST_PREFIX}%`}`,
  );
  const resourceRows = await database
    .select({ id: bookingResources.id })
    .from(bookingResources)
    .where(sql`${bookingResources.resourceKey} like ${`${TEST_PREFIX}%`}`);
  const resourceIds = resourceRows.map((row) => row.id);
  if (resourceIds.length > 0) {
    await database
      .delete(bookingResourceSchedules)
      .where(inArray(bookingResourceSchedules.resourceId, resourceIds));
    await database
      .delete(bookingResources)
      .where(inArray(bookingResources.id, resourceIds));
  }
}
