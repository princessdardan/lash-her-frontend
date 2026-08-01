import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, beforeEach } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import {
  bookingBusinessSettings,
  bookingProviders,
  bookingResources,
  bookingServices,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";
import * as schema from "@/lib/private-db/schema";

import {
  assertSquareAttributionCanBeRequired,
  assertSquareMappingRemovalAllowed,
  assertSquareOfferingActivationAllowed,
  lockSquareAttributionInvariant,
  lockSquareAttributionInvariantShared,
} from "./square-attribution-invariant";
import { applySquareTeamMappingRefresh } from "./square-team-mapping-refresh";

const TEST_PREFIX = "square-invariant-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run Square attribution invariant DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
let originalRequired = false;

beforeEach(async () => {
  if (!db) return;
  const [settings] = await db
    .select({ required: bookingBusinessSettings.requireSquareTeamAttribution })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"));
  originalRequired = settings?.required ?? false;
});

afterEach(async () => {
  if (!db) return;
  await setAttributionRequired(originalRequired);
  await cleanup();
});

after(async () => {
  await pool?.end();
});

test(
  "enforcement enablement serializes with mapping removal",
  { skip: skipReason },
  async () => {
    const fixture = await seed("active");
    await setAttributionRequired(false);
    const gate = deferred<void>();
    const checked = deferred<void>();

    const enablement = requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await assertSquareAttributionCanBeRequired(tx);
      checked.resolve();
      await gate.promise;
      await tx
        .update(bookingBusinessSettings)
        .set({ requireSquareTeamAttribution: true })
        .where(eq(bookingBusinessSettings.singletonKey, "default"));
    });
    await checked.promise;

    const removal = requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await assertSquareMappingRemovalAllowed(tx, fixture.providerId);
      await tx
        .update(bookingProviders)
        .set({ squareTeamMemberId: null })
        .where(eq(bookingProviders.id, fixture.providerId));
    });
    gate.resolve();
    await enablement;
    await assert.rejects(removal, /active offerings/);

    const [provider] = await requireDb()
      .select({ squareTeamMemberId: bookingProviders.squareTeamMemberId })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, fixture.providerId));
    assert.equal(provider.squareTeamMemberId, fixture.squareTeamMemberId);
  },
);

test(
  "shared attribution locks coexist across concurrent hold transactions",
  { skip: skipReason },
  async () => {
    const release = deferred<void>();
    const firstLocked = deferred<void>();
    const secondLocked = deferred<void>();

    const first = requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariantShared(tx);
      firstLocked.resolve();
      await release.promise;
    });
    await firstLocked.promise;

    const second = requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariantShared(tx);
      secondLocked.resolve();
      await release.promise;
    });

    try {
      await waitFor(secondLocked.promise);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
  },
);

test(
  "offering activation rechecks attribution after concurrent mapping removal",
  { skip: skipReason },
  async () => {
    const fixture = await seed("draft");
    await setAttributionRequired(true);
    const gate = deferred<void>();
    const checked = deferred<void>();

    const removal = requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await assertSquareMappingRemovalAllowed(tx, fixture.providerId);
      checked.resolve();
      await gate.promise;
      await tx
        .update(bookingProviders)
        .set({
          squareTeamMemberId: null,
          squareTeamMemberStatus: null,
          squareTeamMemberVerifiedAt: null,
        })
        .where(eq(bookingProviders.id, fixture.providerId));
    });
    await checked.promise;

    const activation = requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await assertSquareOfferingActivationAllowed(tx, fixture.providerId);
      await tx
        .update(bookingServiceOfferings)
        .set({ status: "active" })
        .where(eq(bookingServiceOfferings.id, fixture.offeringId));
    });
    gate.resolve();
    await removal;
    await assert.rejects(activation, /active Square team member/);

    const [offering] = await requireDb()
      .select({ status: bookingServiceOfferings.status })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, fixture.offeringId));
    assert.equal(offering.status, "draft");
  },
);

test(
  "successful directory refresh persists inactive mappings while enforcement remains enabled",
  { skip: skipReason },
  async () => {
    const fixture = await seed("active");
    const verifiedAt = new Date("2031-04-01T12:00:00.000Z");
    await setAttributionRequired(true);

    await requireDb().transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await applySquareTeamMappingRefresh(tx, {
        actorUserId: null,
        now: verifiedAt,
        verificationById: new Map([
          [
            fixture.squareTeamMemberId,
            {
              displayLabel: "Inactive Square provider",
              id: fixture.squareTeamMemberId,
              isOwner: false,
              status: "inactive" as const,
            },
          ],
        ]),
      });
    });

    const [provider] = await requireDb()
      .select({
        displayLabel: bookingProviders.squareTeamMemberDisplayLabel,
        status: bookingProviders.squareTeamMemberStatus,
        verifiedAt: bookingProviders.squareTeamMemberVerifiedAt,
      })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, fixture.providerId));
    assert.equal(provider.status, "inactive");
    assert.equal(provider.displayLabel, "Inactive Square provider");
    assert.equal(provider.verifiedAt?.toISOString(), verifiedAt.toISOString());

    await assert.rejects(
      requireDb().transaction(async (tx) => {
        await assertSquareOfferingActivationAllowed(tx, fixture.providerId);
      }),
      /active Square team member/,
    );
  },
);

test(
  "directory refresh rolls back when a concurrent mapping is absent from the verified snapshot",
  { skip: skipReason },
  async () => {
    const fixture = await seed("active");
    const [before] = await requireDb()
      .select({
        displayLabel: bookingProviders.squareTeamMemberDisplayLabel,
        status: bookingProviders.squareTeamMemberStatus,
        verifiedAt: bookingProviders.squareTeamMemberVerifiedAt,
      })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, fixture.providerId));

    await assert.rejects(
      requireDb().transaction(async (tx) => {
        await lockSquareAttributionInvariant(tx);
        await applySquareTeamMappingRefresh(tx, {
          actorUserId: null,
          now: new Date("2031-04-02T12:00:00.000Z"),
          verificationById: new Map(),
        });
      }),
      /changed during refresh/,
    );

    const [afterRefresh] = await requireDb()
      .select({
        displayLabel: bookingProviders.squareTeamMemberDisplayLabel,
        status: bookingProviders.squareTeamMemberStatus,
        verifiedAt: bookingProviders.squareTeamMemberVerifiedAt,
      })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, fixture.providerId));
    assert.deepEqual(afterRefresh, before);
  },
);

async function seed(status: "active" | "draft") {
  const suffix = randomUUID();
  const squareTeamMemberId = `${TEST_PREFIX}team-${suffix}`;
  const [resource] = await requireDb()
    .insert(bookingResources)
    .values({
      kind: "provider",
      name: `Square invariant resource ${suffix}`,
      resourceKey: `${TEST_PREFIX}resource-${suffix}`,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();
  const [provider] = await requireDb()
    .insert(bookingProviders)
    .values({
      displayName: `Square invariant provider ${suffix}`,
      primaryResourceId: resource.id,
      providerKey: `${TEST_PREFIX}provider-${suffix}`,
      squareTeamMemberId,
      squareTeamMemberStatus: "active",
      squareTeamMemberVerifiedAt: new Date(),
      status: "active",
    })
    .returning();
  const [service] = await requireDb()
    .insert(bookingServices)
    .values({
      displayTitle: `Square invariant service ${suffix}`,
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
      status,
    })
    .returning();
  return {
    offeringId: offering.id,
    providerId: provider.id,
    squareTeamMemberId,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error("Timed out waiting for shared attribution lock")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function requireDb() {
  if (!db) throw new Error("TEST_DATABASE_URL not configured");
  return db;
}

async function setAttributionRequired(required: boolean): Promise<void> {
  await requireDb()
    .insert(bookingBusinessSettings)
    .values({
      requireSquareTeamAttribution: required,
      singletonKey: "default",
    })
    .onConflictDoUpdate({
      target: bookingBusinessSettings.singletonKey,
      set: {
        requireSquareTeamAttribution: required,
        updatedAt: new Date(),
      },
    });
}

async function cleanup(): Promise<void> {
  const database = requireDb();
  const offeringRows = await database
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(
      sql`${bookingServiceOfferings.offeringKey} like ${`${TEST_PREFIX}%`}`,
    );
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
