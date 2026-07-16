import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, before } from "node:test";

import { eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "./pool-config";
import {
  adminUserResources,
  adminUsers,
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
  bookingResources,
} from "./schema";
import * as schema from "./schema";

const TEST_PREFIX = "calendar-connection-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run calendar connection DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
let previousEncryptionKey: string | undefined;
let previousSanityDataset: string | undefined;
let previousSanityProjectId: string | undefined;

before(() => {
  previousEncryptionKey =
    process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY;
  previousSanityDataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
  previousSanityProjectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
  process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(
    32,
    19,
  ).toString("base64");
  process.env.NEXT_PUBLIC_SANITY_DATASET = "calendar-connection-test";
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "calendar-connection-test";
});

afterEach(async () => {
  await cleanupTestRows();
});

after(async () => {
  if (previousEncryptionKey === undefined) {
    delete process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY =
      previousEncryptionKey;
  }

  restoreEnv("NEXT_PUBLIC_SANITY_DATASET", previousSanityDataset);
  restoreEnv("NEXT_PUBLIC_SANITY_PROJECT_ID", previousSanityProjectId);

  await pool?.end();
});

test(
  "calendar credentials are encrypted, assignments have one canonical write target, and disable revokes local access",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const now = new Date("2032-01-01T12:00:00.000Z");
    const [actor] = await database
      .insert(adminUsers)
      .values({
        email: `${TEST_PREFIX}${suffix}@example.com`,
        emailNormalized: `${TEST_PREFIX}${suffix}@example.com`,
        providerUserId: `${TEST_PREFIX}identity-${suffix}`,
        role: "owner",
        status: "active",
      })
      .returning();
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: `Calendar resource ${suffix}`,
        resourceKey: `${TEST_PREFIX}resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    const { createDrizzleCalendarConnectionRepository } = await import(
      "./calendar-connection-repository"
    );
    const repository = createDrizzleCalendarConnectionRepository(database);
    const firstConnection = await repository.createGoogleConnection({
      actorAdminUserId: actor.id,
      now,
    });

    assert.equal(firstConnection.status, "reconnect_required");

    const activeConnection = await repository.saveGoogleCredential({
      accountEmail: `Owner-${suffix}@Example.com`,
      actorAdminUserId: actor.id,
      connectionId: firstConnection.id,
      now,
      providerAccountId: `${TEST_PREFIX}account-${suffix}`,
      refreshToken: `${TEST_PREFIX}refresh-${suffix}`,
      scopes: ["scope-z", "scope-a", "scope-z", " "],
    });
    const [storedConnection] = await database
      .select({
        credentialCiphertext:
          bookingCalendarConnections.credentialCiphertext,
      })
      .from(bookingCalendarConnections)
      .where(eq(bookingCalendarConnections.id, firstConnection.id));
    const credential = await repository.getActiveGoogleCredential(
      firstConnection.id,
    );

    assert.equal(activeConnection.accountEmail, `owner-${suffix}@example.com`);
    assert.notEqual(
      storedConnection.credentialCiphertext,
      `${TEST_PREFIX}refresh-${suffix}`,
    );
    assert.match(storedConnection.credentialCiphertext ?? "", /^v1:/);
    assert.deepEqual(credential, {
      refreshToken: `${TEST_PREFIX}refresh-${suffix}`,
      scopes: ["scope-a", "scope-z"],
    });

    await assert.rejects(
      repository.upsertAssignment({
        acceptsBookings: true,
        actorAdminUserId: actor.id,
        connectionId: firstConnection.id,
        contributesBusy: true,
        now,
        providerCalendarId: "primary",
        resourceId: resource.id,
      }),
      /canonical Google Calendar ID/,
    );
    await assert.rejects(
      repository.upsertAssignment({
        acceptsBookings: false,
        actorAdminUserId: actor.id,
        connectionId: firstConnection.id,
        contributesBusy: false,
        now,
        providerCalendarId: `${TEST_PREFIX}unused-${suffix}`,
        resourceId: resource.id,
      }),
      /booking role/,
    );

    const firstAssignment = await repository.upsertAssignment({
      acceptsBookings: true,
      actorAdminUserId: actor.id,
      calendarLabel: "First",
      connectionId: firstConnection.id,
      contributesBusy: true,
      now,
      providerCalendarId: `${TEST_PREFIX}calendar-a-${suffix}`,
      resourceId: resource.id,
    });
    const secondConnection = await repository.createGoogleConnection({
      actorAdminUserId: actor.id,
      now,
    });
    await repository.saveGoogleCredential({
      accountEmail: `second-${suffix}@example.com`,
      actorAdminUserId: actor.id,
      connectionId: secondConnection.id,
      now,
      providerAccountId: `${TEST_PREFIX}account-second-${suffix}`,
      refreshToken: `${TEST_PREFIX}refresh-second-${suffix}`,
      scopes: ["scope-a"],
    });
    const secondAssignment = await repository.upsertAssignment({
      acceptsBookings: true,
      actorAdminUserId: actor.id,
      calendarLabel: "Second",
      connectionId: secondConnection.id,
      contributesBusy: true,
      now,
      providerCalendarId: `${TEST_PREFIX}calendar-b-${suffix}`,
      resourceId: resource.id,
    });
    const assignments = await repository.listAssignmentsForResource(
      resource.id,
    );

    assert.equal(
      assignments.filter(
        (assignment) =>
          assignment.status === "active" && assignment.acceptsBookings,
      ).length,
      1,
    );
    assert.equal(
      assignments.find((assignment) => assignment.id === firstAssignment.id)
        ?.acceptsBookings,
      false,
    );
    assert.equal(
      assignments.find((assignment) => assignment.id === secondAssignment.id)
        ?.acceptsBookings,
      true,
    );

    assert.equal(
      await repository.disableConnection({
        connectionId: secondConnection.id,
        now: new Date("2032-01-01T12:05:00.000Z"),
      }),
      true,
    );
    await assert.rejects(
      repository.getActiveGoogleCredential(secondConnection.id),
      /not active/,
    );
    const disabledAssignments = await repository.listAssignmentsForResource(
      resource.id,
    );
    assert.equal(
      disabledAssignments.find(
        (assignment) => assignment.id === secondAssignment.id,
      )?.status,
      "disabled",
    );
  },
);

test(
  "shared Google credential resolution disables duplicates and preserves account ownership",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const [actor, otherActor] = await database
      .insert(adminUsers)
      .values([
        {
          email: `${TEST_PREFIX}actor-${suffix}@example.com`,
          emailNormalized: `${TEST_PREFIX}actor-${suffix}@example.com`,
          providerUserId: `${TEST_PREFIX}actor-${suffix}`,
          role: "owner",
          status: "active",
        },
        {
          email: `${TEST_PREFIX}other-${suffix}@example.com`,
          emailNormalized: `${TEST_PREFIX}other-${suffix}@example.com`,
          providerUserId: `${TEST_PREFIX}other-${suffix}`,
          role: "employee",
          status: "active",
        },
      ])
      .returning();
    const providerAccountId = `${TEST_PREFIX}google-${suffix}`;
    await database.insert(bookingCalendarConnections).values({
      accountEmail: `${TEST_PREFIX}other-calendar-${suffix}@example.com`,
      connectedByAdminUserId: otherActor.id,
      credentialCiphertext: `${TEST_PREFIX}existing-ciphertext`,
      credentialOwnerAdminUserId: otherActor.id,
      provider: "google",
      providerAccountId,
      status: "active",
    });
    const [provisional] = await database
      .insert(bookingCalendarConnections)
      .values({
        connectedByAdminUserId: actor.id,
        credentialOwnerAdminUserId: actor.id,
        provider: "google",
        status: "reconnect_required",
      })
      .returning();
    const { resolveAndSaveGoogleCalendarCredential } = await import(
      "@/lib/admin/google-calendar-credential-resolution"
    );

    const outcome = await database.transaction((tx) =>
      resolveAndSaveGoogleCalendarCredential(tx, {
        accountEmail: `${TEST_PREFIX}new-${suffix}@example.com`,
        actorAdminUserId: actor.id,
        connectionId: provisional.id,
        credentialCiphertext: `${TEST_PREFIX}ciphertext`,
        now: new Date("2032-01-01T12:00:00.000Z"),
        providerAccountId,
        scopes: ["calendar"],
      }),
    );

    assert.deepEqual(outcome, { status: "owned_elsewhere" });
    const [disabled] = await database
      .select({ status: bookingCalendarConnections.status })
      .from(bookingCalendarConnections)
      .where(eq(bookingCalendarConnections.id, provisional.id));
    assert.equal(disabled.status, "disabled");
  },
);

test(
  "staff resource assignment remains valid while removal protects an employee-owned active calendar",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const now = new Date("2032-02-01T12:00:00.000Z");
    const [employee] = await database
      .insert(adminUsers)
      .values({
        email: `${TEST_PREFIX}employee-${suffix}@example.com`,
        emailNormalized: `${TEST_PREFIX}employee-${suffix}@example.com`,
        providerUserId: `${TEST_PREFIX}employee-identity-${suffix}`,
        role: "employee",
        status: "active",
      })
      .returning();
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: `Employee calendar resource ${suffix}`,
        resourceKey: `${TEST_PREFIX}employee-resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();

    await database.insert(adminUserResources).values({
      adminUserId: employee.id,
      bookingResourceId: resource.id,
    });

    const [{ assertStaffResourceMutationAllowed }, { createDrizzleCalendarConnectionRepository }] =
      await Promise.all([
        import("@/lib/admin/staff-resource-authorization"),
        import("./calendar-connection-repository"),
      ]);
    const repository = createDrizzleCalendarConnectionRepository(database);
    const connection = await repository.createGoogleConnection({
      actorAdminUserId: employee.id,
      now,
    });
    await repository.saveGoogleCredential({
      accountEmail: `employee-${suffix}@example.com`,
      actorAdminUserId: employee.id,
      connectionId: connection.id,
      now,
      providerAccountId: `${TEST_PREFIX}employee-account-${suffix}`,
      refreshToken: `${TEST_PREFIX}employee-refresh-${suffix}`,
      scopes: ["scope-a"],
    });
    await repository.upsertAssignment({
      acceptsBookings: true,
      actorAdminUserId: employee.id,
      connectionId: connection.id,
      contributesBusy: true,
      now,
      providerCalendarId: `${TEST_PREFIX}employee-calendar-${suffix}`,
      resourceId: resource.id,
    });

    await database.transaction((tx) =>
      assertStaffResourceMutationAllowed(tx, {
        operation: "assign",
        resourceId: resource.id,
        userId: employee.id,
      }),
    );

    await assert.rejects(
      database.transaction((tx) =>
        assertStaffResourceMutationAllowed(tx, {
          operation: "unassign",
          resourceId: resource.id,
          userId: employee.id,
        }),
      ),
      /Transfer or disconnect the employee's active calendar assignment/,
    );

    await repository.disableConnection({
      connectionId: connection.id,
      now: new Date("2032-02-01T12:05:00.000Z"),
    });

    await database.transaction((tx) =>
      assertStaffResourceMutationAllowed(tx, {
        operation: "unassign",
        resourceId: resource.id,
        userId: employee.id,
      }),
    );
  },
);

function requireDb(): NonNullable<typeof db> {
  assert.ok(db, skipReason);
  return db;
}

async function cleanupTestRows(): Promise<void> {
  if (!db) return;

  const prefixedResources = await db
    .select({ id: bookingResources.id })
    .from(bookingResources)
    .where(like(bookingResources.resourceKey, `${TEST_PREFIX}%`));
  const resourceIds = prefixedResources.map((resource) => resource.id);
  const prefixedAdmins = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(like(adminUsers.emailNormalized, `${TEST_PREFIX}%`));
  const adminIds = prefixedAdmins.map((admin) => admin.id);

  if (adminIds.length > 0) {
    await db
      .delete(adminUserResources)
      .where(inArray(adminUserResources.adminUserId, adminIds));
  }

  if (resourceIds.length > 0) {
    await db
      .delete(bookingResourceCalendarAssignments)
      .where(inArray(bookingResourceCalendarAssignments.resourceId, resourceIds));
    await db.delete(bookingResources).where(inArray(bookingResources.id, resourceIds));
  }

  if (adminIds.length > 0) {
    await db
      .delete(bookingCalendarConnections)
      .where(inArray(bookingCalendarConnections.connectedByAdminUserId, adminIds));
    await db.delete(adminUsers).where(inArray(adminUsers.id, adminIds));
  }

}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
