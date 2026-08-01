import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import {
  appointmentHolds,
  bookingProviders,
  bookingResourceReservations,
  bookingResources,
  bookingServices,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";
import * as schema from "@/lib/private-db/schema";

import {
  assignOfferingResourceInTransaction,
  removeOfferingResourceInTransaction,
} from "./offering-resource-admin";

const TEST_PREFIX = "offering-resource-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run offering resource admin DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;

afterEach(async () => {
  if (db) await cleanup();
});
after(async () => {
  await pool?.end();
});

test(
  "offering resource assignment is configurable and removal preserves existing reservations",
  { skip: skipReason },
  async () => {
    const fixture = await seed();
    await requireDb().transaction((tx) =>
      assignOfferingResourceInTransaction(tx, {
        isRequired: true,
        offeringId: fixture.offeringId,
        resourceId: fixture.secondaryResourceId,
      }),
    );
    const [relationship] = await requireDb()
      .select()
      .from(bookingServiceOfferingResources)
      .where(
        eq(
          bookingServiceOfferingResources.offeringId,
          fixture.offeringId,
        ),
      );
    assert.equal(relationship.isRequired, true);
    assert.equal(relationship.role, "room");

    await requireDb().transaction((tx) =>
      assignOfferingResourceInTransaction(tx, {
        isRequired: false,
        offeringId: fixture.offeringId,
        resourceId: fixture.secondaryResourceId,
      }),
    );
    const [updated] = await requireDb()
      .select({ isRequired: bookingServiceOfferingResources.isRequired })
      .from(bookingServiceOfferingResources)
      .where(eq(bookingServiceOfferingResources.id, relationship.id));
    assert.equal(updated.isRequired, false);

    await requireDb().transaction((tx) =>
      removeOfferingResourceInTransaction(tx, {
        offeringId: fixture.offeringId,
        resourceId: fixture.secondaryResourceId,
      }),
    );
    const [reservation] = await requireDb()
      .select({ state: bookingResourceReservations.state })
      .from(bookingResourceReservations)
      .where(eq(bookingResourceReservations.id, fixture.reservationId));
    assert.equal(reservation.state, "active");
  },
);

async function seed() {
  const suffix = randomUUID();
  const [primary, secondary] = await requireDb()
    .insert(bookingResources)
    .values([
      {
        kind: "provider",
        name: `Offering provider resource ${suffix}`,
        resourceKey: `${TEST_PREFIX}primary-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      },
      {
        kind: "room",
        name: `Offering room ${suffix}`,
        resourceKey: `${TEST_PREFIX}room-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      },
    ])
    .returning();
  const [provider] = await requireDb()
    .insert(bookingProviders)
    .values({
      displayName: `Offering provider ${suffix}`,
      primaryResourceId: primary.id,
      providerKey: `${TEST_PREFIX}provider-${suffix}`,
      status: "active",
    })
    .returning();
  const [service] = await requireDb()
    .insert(bookingServices)
    .values({
      displayTitle: `Offering service ${suffix}`,
      serviceKey: `${TEST_PREFIX}service-${suffix}`,
      status: "active",
    })
    .returning();
  const [offering] = await requireDb()
    .insert(bookingServiceOfferings)
    .values({
      depositAmountCents: 5000,
      durationMinutes: 60,
      fullPriceCents: 12000,
      offeringKey: `${TEST_PREFIX}offering-${suffix}`,
      primaryResourceId: primary.id,
      providerId: provider.id,
      serviceId: service.id,
      slotIntervalMinutes: 15,
      status: "draft",
    })
    .returning();
  const start = new Date("2036-01-10T14:00:00.000Z");
  const end = new Date("2036-01-10T15:00:00.000Z");
  const [hold] = await requireDb()
    .insert(appointmentHolds)
    .values({
      bookingType: "in-person-appointment",
      customerSnapshot: {
        email: `${TEST_PREFIX}${suffix}@example.invalid`,
        name: "Offering Resource Test",
        phone: "0000000000",
      },
      expiresAt: new Date("2036-01-01T12:10:00.000Z"),
      offeringId: `${TEST_PREFIX}legacy`,
      offeringSnapshot: { title: "Offering Resource Test" },
      paymentSessionReference: `${TEST_PREFIX}session-${suffix}`,
      publicReference: `${TEST_PREFIX}hold-${suffix}`,
      selectedEnd: end,
      selectedStart: start,
      timezone: "America/Toronto",
    })
    .returning();
  const [reservation] = await requireDb()
    .insert(bookingResourceReservations)
    .values({
      expiresAt: new Date("2036-01-01T12:10:00.000Z"),
      holdId: hold.id,
      kind: "hold",
      occupiedEnd: end,
      occupiedStart: start,
      resourceId: secondary.id,
      state: "active",
    })
    .returning();
  return {
    offeringId: offering.id,
    reservationId: reservation.id,
    secondaryResourceId: secondary.id,
  };
}

function requireDb() {
  if (!db) throw new Error("TEST_DATABASE_URL not configured");
  return db;
}

async function cleanup(): Promise<void> {
  const database = requireDb();
  await database.execute(
    sql`delete from ${appointmentHolds} where ${appointmentHolds.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
  const offerings = await database
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(sql`${bookingServiceOfferings.offeringKey} like ${`${TEST_PREFIX}%`}`);
  if (offerings.length > 0) {
    const ids = offerings.map((row) => row.id);
    await database
      .delete(bookingServiceOfferingResources)
      .where(inArray(bookingServiceOfferingResources.offeringId, ids));
    await database
      .delete(bookingServiceOfferings)
      .where(inArray(bookingServiceOfferings.id, ids));
  }
  await database.execute(
    sql`delete from ${bookingProviders} where ${bookingProviders.providerKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingServices} where ${bookingServices.serviceKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingResources} where ${bookingResources.resourceKey} like ${`${TEST_PREFIX}%`}`,
  );
}
