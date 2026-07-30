import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import {
  bookingProviders,
  bookingResources,
  bookingServices,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";
import * as schema from "@/lib/private-db/schema";

import { runServiceOfferingOwnershipMutation } from "./service-offering-ownership-invariant";

const TEST_PREFIX = "service-owner-invariant-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run service ownership invariant DB tests";
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
  "one provider owns a service and adding a second provider makes it shared",
  { skip: skipReason },
  async () => {
    const fixture = await seed();

    await requireDb().transaction((tx) =>
      runServiceOfferingOwnershipMutation(tx, {
        serviceId: fixture.serviceId,
        mutate: () =>
          insertOffering(tx, {
            offeringKey: `${fixture.suffix}-provider-a`,
            primaryResourceId: fixture.firstResourceId,
            providerId: fixture.firstProviderId,
            serviceId: fixture.serviceId,
          }),
      }),
    );
    assert.equal(
      await readOwnerProviderId(fixture.serviceId),
      fixture.firstProviderId,
    );

    await requireDb().transaction((tx) =>
      runServiceOfferingOwnershipMutation(tx, {
        serviceId: fixture.serviceId,
        mutate: () =>
          insertOffering(tx, {
            offeringKey: `${fixture.suffix}-provider-b`,
            primaryResourceId: fixture.secondResourceId,
            providerId: fixture.secondProviderId,
            serviceId: fixture.serviceId,
          }),
      }),
    );
    assert.equal(await readOwnerProviderId(fixture.serviceId), null);
  },
);

test(
  "concurrent provider additions serialize ownership recomputation",
  { skip: skipReason },
  async () => {
    const fixture = await seed();
    const firstInserted = deferred<void>();
    const releaseFirst = deferred<void>();

    const first = requireDb().transaction((tx) =>
      runServiceOfferingOwnershipMutation(tx, {
        serviceId: fixture.serviceId,
        mutate: async () => {
          await insertOffering(tx, {
            offeringKey: `${fixture.suffix}-concurrent-a`,
            primaryResourceId: fixture.firstResourceId,
            providerId: fixture.firstProviderId,
            serviceId: fixture.serviceId,
          });
          firstInserted.resolve();
          await releaseFirst.promise;
        },
      }),
    );
    await firstInserted.promise;

    const second = requireDb().transaction((tx) =>
      runServiceOfferingOwnershipMutation(tx, {
        serviceId: fixture.serviceId,
        mutate: () =>
          insertOffering(tx, {
            offeringKey: `${fixture.suffix}-concurrent-b`,
            primaryResourceId: fixture.secondResourceId,
            providerId: fixture.secondProviderId,
            serviceId: fixture.serviceId,
          }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirst.resolve();
    await Promise.all([first, second]);

    assert.equal(await readOwnerProviderId(fixture.serviceId), null);
  },
);

async function seed() {
  const suffix = `${TEST_PREFIX}${randomUUID()}`;
  const [firstResource, secondResource] = await requireDb()
    .insert(bookingResources)
    .values([
      {
        kind: "provider",
        name: `${suffix} resource A`,
        resourceKey: `${suffix}-resource-a`,
        status: "active",
        timezone: "America/Toronto",
      },
      {
        kind: "provider",
        name: `${suffix} resource B`,
        resourceKey: `${suffix}-resource-b`,
        status: "active",
        timezone: "America/Toronto",
      },
    ])
    .returning();
  const [firstProvider, secondProvider] = await requireDb()
    .insert(bookingProviders)
    .values([
      {
        displayName: `${suffix} provider A`,
        primaryResourceId: firstResource.id,
        providerKey: `${suffix}-provider-a`,
        status: "active",
      },
      {
        displayName: `${suffix} provider B`,
        primaryResourceId: secondResource.id,
        providerKey: `${suffix}-provider-b`,
        status: "active",
      },
    ])
    .returning();
  const [service] = await requireDb()
    .insert(bookingServices)
    .values({
      displayTitle: `${suffix} service`,
      serviceKey: `${suffix}-service`,
      status: "active",
    })
    .returning();

  return {
    firstProviderId: firstProvider.id,
    firstResourceId: firstResource.id,
    secondProviderId: secondProvider.id,
    secondResourceId: secondResource.id,
    serviceId: service.id,
    suffix,
  };
}

async function insertOffering(
  tx: Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0],
  input: {
    offeringKey: string;
    primaryResourceId: string;
    providerId: string;
    serviceId: string;
  },
) {
  await tx.insert(bookingServiceOfferings).values({
    depositAmountCents: 5_000,
    durationMinutes: 60,
    fullPriceCents: 12_000,
    offeringKey: input.offeringKey,
    primaryResourceId: input.primaryResourceId,
    providerId: input.providerId,
    serviceId: input.serviceId,
    slotIntervalMinutes: 15,
    status: "draft",
  });
}

async function readOwnerProviderId(serviceId: string) {
  const [service] = await requireDb()
    .select({ ownerProviderId: bookingServices.ownerProviderId })
    .from(bookingServices)
    .where(eq(bookingServices.id, serviceId));
  return service.ownerProviderId;
}

function requireDb() {
  if (!db) throw new Error("TEST_DATABASE_URL not configured");
  return db;
}

async function cleanup(): Promise<void> {
  const database = requireDb();
  await database.execute(
    sql`delete from ${bookingServiceOfferings} where ${bookingServiceOfferings.offeringKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingServices} where ${bookingServices.serviceKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingProviders} where ${bookingProviders.providerKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${bookingResources} where ${bookingResources.resourceKey} like ${`${TEST_PREFIX}%`}`,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
