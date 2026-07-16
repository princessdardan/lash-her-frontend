import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import {
  appointmentHolds,
  appointments,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
  bookingProviders,
  bookingResources,
  bookingServices,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";
import * as schema from "@/lib/private-db/schema";

import { queryEmployeeNoShowAttribution } from "./employee-attribution-query";

const TEST_PREFIX = "attribution-db-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run employee attribution DB tests";
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
  "no-show attribution uses the matching successful attempt rather than the policy ceiling",
  { skip: skipReason },
  async () => {
    const first = await seedChargedRecord("with-attempt");
    const second = await seedChargedRecord("historical-without-attempt");
    const processedAt = new Date("2035-01-10T15:00:00.000Z");

    await requireDb().insert(bookingNoShowChargeAttempts).values([
      {
        amountCents: 9000,
        createdAt: new Date("2035-01-10T14:00:00.000Z"),
        noShowChargeRecordId: first.recordId,
        processedAt,
        squarePaymentId: `${TEST_PREFIX}failed-payment`,
        status: "charge_failed",
      },
      {
        amountCents: 7500,
        createdAt: new Date("2035-01-10T14:10:00.000Z"),
        noShowChargeRecordId: first.recordId,
        processedAt,
        squarePaymentId: first.squarePaymentId,
        status: "charged",
      },
      {
        amountCents: 8000,
        createdAt: new Date("2035-01-10T14:20:00.000Z"),
        noShowChargeRecordId: first.recordId,
        processedAt: new Date("2035-01-10T15:10:00.000Z"),
        squarePaymentId: `${TEST_PREFIX}unrelated-payment`,
        status: "charged",
      },
    ]);

    const rows = await queryEmployeeNoShowAttribution(requireDb(), {
      start: new Date("2035-01-01T00:00:00.000Z"),
      endExclusive: new Date("2035-02-01T00:00:00.000Z"),
    });
    const amounts = rows.map((row) => row.amountCents).sort((a, b) => a - b);
    assert.deepEqual(amounts, [0, 7500]);
    assert.equal(first.maxChargeCents, 12500);
    assert.equal(second.maxChargeCents, 12500);
  },
);

async function seedChargedRecord(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const [resource] = await requireDb()
    .insert(bookingResources)
    .values({
      kind: "provider",
      name: `Attribution resource ${suffix}`,
      resourceKey: `${TEST_PREFIX}resource-${suffix}`,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();
  const [provider] = await requireDb()
    .insert(bookingProviders)
    .values({
      displayName: `Attribution provider ${suffix}`,
      primaryResourceId: resource.id,
      providerKey: `${TEST_PREFIX}provider-${suffix}`,
      status: "active",
    })
    .returning();
  const [service] = await requireDb()
    .insert(bookingServices)
    .values({
      displayTitle: `Attribution service ${suffix}`,
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
      primaryResourceId: resource.id,
      providerId: provider.id,
      serviceId: service.id,
      slotIntervalMinutes: 15,
      status: "active",
    })
    .returning();
  const start = new Date("2035-01-10T14:00:00.000Z");
  const end = new Date("2035-01-10T15:00:00.000Z");
  const publicReference = `${TEST_PREFIX}hold-${suffix}`;
  const [hold] = await requireDb()
    .insert(appointmentHolds)
    .values({
      bookingType: "in-person-appointment",
      customerSnapshot: {
        email: `${TEST_PREFIX}${suffix}@example.invalid`,
        name: "Attribution Test",
        phone: "0000000000",
      },
      expiresAt: new Date("2035-01-01T00:10:00.000Z"),
      offeringId: `${TEST_PREFIX}legacy-offering`,
      offeringSnapshot: { title: "Attribution Test" },
      paymentSessionReference: `${TEST_PREFIX}session-${suffix}`,
      publicReference,
      selectedEnd: end,
      selectedStart: start,
      status: "booked",
      timezone: "America/Toronto",
    })
    .returning();
  const [appointment] = await requireDb()
    .insert(appointments)
    .values({
      customerEmail: `${TEST_PREFIX}${suffix}@example.invalid`,
      customerEmailNormalized: `${TEST_PREFIX}${suffix}@example.invalid`,
      customerName: "Attribution Test",
      occupiedEnd: end,
      occupiedStart: start,
      offeringSnapshot: { title: "Attribution Test" },
      primaryResourceId: resource.id,
      providerId: provider.id,
      providerSnapshot: {
        displayName: `Attribution provider ${suffix}`,
        providerKey: provider.providerKey,
      },
      publicReference: `${TEST_PREFIX}appointment-${suffix}`,
      selectedEnd: end,
      selectedStart: start,
      serviceOfferingId: offering.id,
      sourceHoldId: hold.id,
      sourceHoldPublicReference: publicReference,
      squareTeamMemberId: `${TEST_PREFIX}team-${suffix}`,
      timezone: "America/Toronto",
    })
    .returning();
  const maxChargeCents = 12500;
  const squarePaymentId = `${TEST_PREFIX}payment-${suffix}`;
  const [record] = await requireDb()
    .insert(bookingNoShowChargeRecords)
    .values({
      appointmentId: appointment.id,
      chargedAt: new Date("2035-01-10T15:00:00.000Z"),
      holdId: hold.id,
      maxChargeCents,
      squarePaymentId,
      status: "charged",
    })
    .returning();
  return { maxChargeCents, recordId: record.id, squarePaymentId };
}

function requireDb() {
  if (!db) throw new Error("TEST_DATABASE_URL not configured");
  return db;
}

async function cleanup(): Promise<void> {
  const database = requireDb();
  await database.execute(
    sql`delete from ${appointments} where ${appointments.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${appointmentHolds} where ${appointmentHolds.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
  const offeringRows = await database
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(sql`${bookingServiceOfferings.offeringKey} like ${`${TEST_PREFIX}%`}`);
  if (offeringRows.length > 0) {
    await database.delete(bookingServiceOfferings).where(
      inArray(
        bookingServiceOfferings.id,
        offeringRows.map((row) => row.id),
      ),
    );
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
