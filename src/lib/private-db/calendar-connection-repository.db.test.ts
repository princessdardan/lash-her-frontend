import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, before } from "node:test";

import { eq, inArray, like, sql } from "drizzle-orm";
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
    const { createDrizzleCalendarConnectionRepository } =
      await import("./calendar-connection-repository");
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
        credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
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
    await assert.rejects(
      repository.upsertAssignment({
        acceptsBookings: false,
        actorAdminUserId: actor.id,
        calendarLabel: "First",
        connectionId: firstConnection.id,
        contributesBusy: true,
        now,
        providerCalendarId: `${TEST_PREFIX}calendar-a-${suffix}`,
        resourceId: resource.id,
      }),
      /Move the booking destination/,
    );
    await assert.rejects(
      repository.upsertAssignment({
        acceptsBookings: true,
        actorAdminUserId: actor.id,
        connectionId: firstConnection.id,
        contributesBusy: false,
        now,
        providerCalendarId: `${TEST_PREFIX}invalid-role-${suffix}`,
        resourceId: resource.id,
      }),
      /must also block its busy time/,
    );
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
    await assert.rejects(
      repository.upsertAssignment({
        acceptsBookings: true,
        actorAdminUserId: actor.id,
        calendarLabel: "Second",
        connectionId: secondConnection.id,
        contributesBusy: true,
        now,
        providerCalendarId: `${TEST_PREFIX}calendar-b-${suffix}`,
        resourceId: resource.id,
      }),
      /Confirm the existing booking destination replacement/,
    );
    const secondAssignment = await repository.upsertAssignment({
      acceptsBookings: true,
      actorAdminUserId: actor.id,
      calendarLabel: "Second",
      confirmedReplacementAssignmentId: firstAssignment.id,
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

    await assert.rejects(
      repository.disableConnection({
        connectionId: secondConnection.id,
        now: new Date("2032-01-01T12:03:00.000Z"),
      }),
      /Move the booking destination/,
    );
    await repository.upsertAssignment({
      acceptsBookings: true,
      actorAdminUserId: actor.id,
      calendarLabel: "First",
      confirmedReplacementAssignmentId: secondAssignment.id,
      connectionId: firstConnection.id,
      contributesBusy: true,
      now: new Date("2032-01-01T12:04:00.000Z"),
      providerCalendarId: `${TEST_PREFIX}calendar-a-${suffix}`,
      resourceId: resource.id,
    });
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
    const [otherOwnedConnection] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}other-calendar-${suffix}@example.com`,
        connectedByAdminUserId: otherActor.id,
        credentialCiphertext: `${TEST_PREFIX}existing-ciphertext`,
        credentialOwnerAdminUserId: otherActor.id,
        provider: "google",
        providerAccountId,
        status: "active",
      })
      .returning();
    const [provisional] = await database
      .insert(bookingCalendarConnections)
      .values({
        connectedByAdminUserId: actor.id,
        credentialOwnerAdminUserId: actor.id,
        provider: "google",
        status: "reconnect_required",
      })
      .returning();
    const {
      disableProvisionalGoogleCalendarConnection,
      resolveAndSaveGoogleCalendarCredential,
    } = await import("@/lib/admin/google-calendar-credential-resolution");

    const outcome = await database.transaction((tx) =>
      resolveAndSaveGoogleCalendarCredential(tx, {
        accountEmail: `${TEST_PREFIX}new-${suffix}@example.com`,
        actorAdminUserId: actor.id,
        canManageAllConnections: false,
        connectionId: provisional.id,
        credentialCiphertext: `${TEST_PREFIX}ciphertext`,
        credentialOwnerAdminUserId: actor.id,
        employeeResourceId: null,
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

    const [failedProvisional] = await database
      .insert(bookingCalendarConnections)
      .values({
        connectedByAdminUserId: actor.id,
        credentialOwnerAdminUserId: actor.id,
        provider: "google",
        status: "reconnect_required",
      })
      .returning();
    assert.equal(
      await database.transaction((tx) =>
        disableProvisionalGoogleCalendarConnection(tx, {
          actorAdminUserId: actor.id,
          connectionId: failedProvisional.id,
          credentialOwnerAdminUserId: actor.id,
          now: new Date("2032-01-01T12:05:00.000Z"),
        }),
      ),
      true,
    );
    assert.equal(
      await database.transaction((tx) =>
        disableProvisionalGoogleCalendarConnection(tx, {
          actorAdminUserId: otherActor.id,
          connectionId: otherOwnedConnection.id,
          credentialOwnerAdminUserId: otherActor.id,
          now: new Date("2032-01-01T12:05:00.000Z"),
        }),
      ),
      false,
    );
    const [failedConnection, preservedActiveConnection] = await Promise.all([
      database
        .select({ status: bookingCalendarConnections.status })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, failedProvisional.id))
        .then(([connection]) => connection),
      database
        .select({ status: bookingCalendarConnections.status })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, otherOwnedConnection.id))
        .then(([connection]) => connection),
    ]);
    assert.equal(failedConnection.status, "disabled");
    assert.equal(preservedActiveConnection.status, "active");
  },
);

test(
  "employee busy assignment guard cannot demote an active write assignment",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const [actor] = await database
      .insert(adminUsers)
      .values({
        email: `${TEST_PREFIX}write-guard-${suffix}@example.com`,
        emailNormalized: `${TEST_PREFIX}write-guard-${suffix}@example.com`,
        providerUserId: `${TEST_PREFIX}write-guard-${suffix}`,
        role: "employee",
        status: "active",
      })
      .returning();
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: `Write guard ${suffix}`,
        resourceKey: `${TEST_PREFIX}write-guard-resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    const [connection] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}write-guard-calendar-${suffix}@example.com`,
        connectedByAdminUserId: actor.id,
        credentialCiphertext: `${TEST_PREFIX}ciphertext-${suffix}`,
        credentialOwnerAdminUserId: actor.id,
        provider: "google",
        providerAccountId: `${TEST_PREFIX}write-guard-account-${suffix}`,
        status: "active",
      })
      .returning();
    const providerCalendarId = `${TEST_PREFIX}write-calendar-${suffix}`;
    const [writeAssignment] = await database
      .insert(bookingResourceCalendarAssignments)
      .values({
        acceptsBookings: true,
        calendarConnectionId: connection.id,
        contributesBusy: true,
        createdByAdminUserId: actor.id,
        providerCalendarId,
        resourceId: resource.id,
        status: "active",
      })
      .returning();
    const { assertEmployeeBusyAssignmentCanBeSaved } =
      await import("@/lib/admin/calendar-assignment-authorization");

    await assert.rejects(
      database.transaction((tx) =>
        assertEmployeeBusyAssignmentCanBeSaved(tx, {
          connectionId: connection.id,
          providerCalendarId,
          resourceId: resource.id,
        }),
      ),
      /cannot change a calendar that receives bookings/,
    );

    const [preserved] = await database
      .select({
        acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
        status: bookingResourceCalendarAssignments.status,
      })
      .from(bookingResourceCalendarAssignments)
      .where(eq(bookingResourceCalendarAssignments.id, writeAssignment.id));
    assert.equal(preserved.acceptsBookings, true);
    assert.equal(preserved.status, "active");
  },
);

test(
  "calendar credential reconnects preserve account identity and admin-managed ownership",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const now = new Date("2032-01-02T12:00:00.000Z");
    const [employee, admin] = await database
      .insert(adminUsers)
      .values([
        {
          email: `${TEST_PREFIX}reconnect-employee-${suffix}@example.com`,
          emailNormalized: `${TEST_PREFIX}reconnect-employee-${suffix}@example.com`,
          providerUserId: `${TEST_PREFIX}reconnect-employee-${suffix}`,
          role: "employee",
          status: "active",
        },
        {
          email: `${TEST_PREFIX}reconnect-admin-${suffix}@example.com`,
          emailNormalized: `${TEST_PREFIX}reconnect-admin-${suffix}@example.com`,
          providerUserId: `${TEST_PREFIX}reconnect-admin-${suffix}`,
          role: "admin",
          status: "active",
        },
      ])
      .returning();
    const accountA = `${TEST_PREFIX}account-a-${suffix}`;
    const accountB = `${TEST_PREFIX}account-b-${suffix}`;
    const [established] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}employee-calendar-${suffix}@example.com`,
        connectedByAdminUserId: employee.id,
        credentialCiphertext: `${TEST_PREFIX}old-ciphertext-${suffix}`,
        credentialOwnerAdminUserId: employee.id,
        provider: "google",
        providerAccountId: accountA,
        status: "active",
      })
      .returning();
    const { resolveAndSaveGoogleCalendarCredential } =
      await import("@/lib/admin/google-calendar-credential-resolution");

    const sameAccount = await database.transaction((tx) =>
      resolveAndSaveGoogleCalendarCredential(tx, {
        accountEmail: `${TEST_PREFIX}employee-calendar-${suffix}@example.com`,
        actorAdminUserId: employee.id,
        canManageAllConnections: false,
        connectionId: established.id,
        credentialCiphertext: `${TEST_PREFIX}new-ciphertext-${suffix}`,
        credentialOwnerAdminUserId: employee.id,
        employeeResourceId: null,
        now,
        providerAccountId: accountA,
        scopes: ["calendar"],
      }),
    );
    assert.deepEqual(sameAccount, {
      connectionId: established.id,
      status: "saved",
    });

    const differentAccount = await database.transaction((tx) =>
      resolveAndSaveGoogleCalendarCredential(tx, {
        accountEmail: `${TEST_PREFIX}other-calendar-${suffix}@example.com`,
        actorAdminUserId: employee.id,
        canManageAllConnections: false,
        connectionId: established.id,
        credentialCiphertext: `${TEST_PREFIX}rejected-ciphertext-${suffix}`,
        credentialOwnerAdminUserId: employee.id,
        employeeResourceId: null,
        now: new Date("2032-01-02T12:05:00.000Z"),
        providerAccountId: accountB,
        scopes: ["calendar"],
      }),
    );
    assert.deepEqual(differentAccount, {
      connectionId: established.id,
      status: "account_mismatch",
    });

    const [preserved] = await database
      .select({
        credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
        credentialOwnerAdminUserId:
          bookingCalendarConnections.credentialOwnerAdminUserId,
        providerAccountId: bookingCalendarConnections.providerAccountId,
      })
      .from(bookingCalendarConnections)
      .where(eq(bookingCalendarConnections.id, established.id));
    assert.equal(preserved.providerAccountId, accountA);
    assert.equal(preserved.credentialOwnerAdminUserId, employee.id);
    assert.equal(
      preserved.credentialCiphertext,
      `${TEST_PREFIX}new-ciphertext-${suffix}`,
    );

    const [adminManaged] = await database
      .insert(bookingCalendarConnections)
      .values({
        connectedByAdminUserId: admin.id,
        credentialOwnerAdminUserId: null,
        provider: "google",
        status: "reconnect_required",
      })
      .returning();
    const adminOutcome = await database.transaction((tx) =>
      resolveAndSaveGoogleCalendarCredential(tx, {
        accountEmail: `${TEST_PREFIX}admin-calendar-${suffix}@example.com`,
        actorAdminUserId: admin.id,
        canManageAllConnections: true,
        connectionId: adminManaged.id,
        credentialCiphertext: `${TEST_PREFIX}admin-ciphertext-${suffix}`,
        credentialOwnerAdminUserId: null,
        employeeResourceId: null,
        now,
        providerAccountId: `${TEST_PREFIX}admin-account-${suffix}`,
        scopes: ["calendar"],
      }),
    );
    assert.deepEqual(adminOutcome, {
      connectionId: adminManaged.id,
      status: "saved",
    });
    const [savedAdminManaged] = await database
      .select({
        credentialOwnerAdminUserId:
          bookingCalendarConnections.credentialOwnerAdminUserId,
      })
      .from(bookingCalendarConnections)
      .where(eq(bookingCalendarConnections.id, adminManaged.id));
    assert.equal(savedAdminManaged.credentialOwnerAdminUserId, null);
  },
);

test(
  "employee disconnect wins against an in-flight OAuth callback",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const [employee] = await database
      .insert(adminUsers)
      .values({
        email: `${TEST_PREFIX}disconnect-callback-${suffix}@example.com`,
        emailNormalized: `${TEST_PREFIX}disconnect-callback-${suffix}@example.com`,
        providerUserId: `${TEST_PREFIX}disconnect-callback-${suffix}`,
        role: "employee",
        status: "active",
      })
      .returning();
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: `Disconnect callback ${suffix}`,
        resourceKey: `${TEST_PREFIX}disconnect-callback-resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    await database.insert(adminUserResources).values({
      adminUserId: employee.id,
      bookingResourceId: resource.id,
    });
    const providerAccountId = `${TEST_PREFIX}disconnect-callback-account-${suffix}`;
    const originalCredential = `${TEST_PREFIX}disconnect-callback-old-${suffix}`;
    const [connection] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}disconnect-callback-${suffix}@example.com`,
        connectedByAdminUserId: employee.id,
        credentialCiphertext: originalCredential,
        credentialOwnerAdminUserId: employee.id,
        provider: "google",
        providerAccountId,
        status: "active",
      })
      .returning();
    const [
      { lockEmployeeCalendarInvariant },
      { resolveAndSaveGoogleCalendarCredential },
    ] = await Promise.all([
      import("@/lib/admin/employee-calendar-invariant"),
      import("@/lib/admin/google-calendar-credential-resolution"),
    ]);
    const connectionDisabled = createDeferred();
    const releaseDisconnect = createDeferred();

    const disconnectTransaction = database.transaction(async (tx) => {
      await lockEmployeeCalendarInvariant(tx, employee.id);
      const [lockedConnection] = await tx
        .select({ id: bookingCalendarConnections.id })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, connection.id))
        .limit(1)
        .for("update");
      assert.ok(lockedConnection);
      await tx
        .update(bookingCalendarConnections)
        .set({
          credentialCiphertext: null,
          credentialSecretRef: null,
          disabledAt: new Date("2032-01-03T12:00:00.000Z"),
          status: "disabled",
          updatedAt: new Date("2032-01-03T12:00:00.000Z"),
        })
        .where(eq(bookingCalendarConnections.id, connection.id));
      connectionDisabled.resolve();
      await releaseDisconnect.promise;
    });
    await connectionDisabled.promise;

    let callbackSettled = false;
    const callbackAttempt = database
      .transaction((tx) =>
        resolveAndSaveGoogleCalendarCredential(tx, {
          accountEmail: `${TEST_PREFIX}disconnect-callback-${suffix}@example.com`,
          actorAdminUserId: employee.id,
          canManageAllConnections: false,
          connectionId: connection.id,
          credentialCiphertext: `${TEST_PREFIX}disconnect-callback-new-${suffix}`,
          credentialOwnerAdminUserId: employee.id,
          employeeResourceId: resource.id,
          now: new Date("2032-01-03T12:01:00.000Z"),
          providerAccountId,
          scopes: ["calendar"],
        }),
      )
      .finally(() => {
        callbackSettled = true;
      });
    const callbackRejection = assert.rejects(
      callbackAttempt,
      /Calendar connection changed\. Retry authorization/,
    );

    await waitForAdvisoryLockWaiter(database);
    assert.equal(callbackSettled, false);
    releaseDisconnect.resolve();
    await disconnectTransaction;
    await callbackRejection;

    const [storedConnection] = await database
      .select({
        credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
        status: bookingCalendarConnections.status,
      })
      .from(bookingCalendarConnections)
      .where(eq(bookingCalendarConnections.id, connection.id));
    assert.equal(storedConnection.status, "disabled");
    assert.equal(storedConnection.credentialCiphertext, null);
  },
);

test(
  "admin force-disable wins against an in-flight duplicate-account OAuth callback",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const [employee, admin] = await database
      .insert(adminUsers)
      .values([
        {
          email: `${TEST_PREFIX}force-disable-employee-${suffix}@example.com`,
          emailNormalized: `${TEST_PREFIX}force-disable-employee-${suffix}@example.com`,
          providerUserId: `${TEST_PREFIX}force-disable-employee-${suffix}`,
          role: "employee",
          status: "active",
        },
        {
          email: `${TEST_PREFIX}force-disable-admin-${suffix}@example.com`,
          emailNormalized: `${TEST_PREFIX}force-disable-admin-${suffix}@example.com`,
          providerUserId: `${TEST_PREFIX}force-disable-admin-${suffix}`,
          role: "admin",
          status: "active",
        },
      ])
      .returning();
    const providerAccountId = `${TEST_PREFIX}force-disable-account-${suffix}`;
    const [established] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}force-disable-calendar-${suffix}@example.com`,
        connectedByAdminUserId: employee.id,
        credentialCiphertext: `${TEST_PREFIX}force-disable-old-${suffix}`,
        credentialOwnerAdminUserId: employee.id,
        provider: "google",
        providerAccountId,
        status: "active",
      })
      .returning();
    const [provisional] = await database
      .insert(bookingCalendarConnections)
      .values({
        connectedByAdminUserId: admin.id,
        credentialOwnerAdminUserId: null,
        provider: "google",
        status: "reconnect_required",
      })
      .returning();
    const [
      { lockEmployeeCalendarInvariant },
      { resolveAndSaveGoogleCalendarCredential },
    ] = await Promise.all([
      import("@/lib/admin/employee-calendar-invariant"),
      import("@/lib/admin/google-calendar-credential-resolution"),
    ]);
    const connectionDisabled = createDeferred();
    const releaseForceDisable = createDeferred();

    const forceDisableTransaction = database.transaction(async (tx) => {
      await lockEmployeeCalendarInvariant(tx, employee.id);
      const [lockedConnection] = await tx
        .select({ id: bookingCalendarConnections.id })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, established.id))
        .limit(1)
        .for("update");
      assert.ok(lockedConnection);
      await tx
        .update(bookingCalendarConnections)
        .set({
          credentialCiphertext: null,
          credentialSecretRef: null,
          disabledAt: new Date("2032-01-04T12:00:00.000Z"),
          status: "disabled",
          updatedAt: new Date("2032-01-04T12:00:00.000Z"),
        })
        .where(eq(bookingCalendarConnections.id, established.id));
      connectionDisabled.resolve();
      await releaseForceDisable.promise;
    });
    await connectionDisabled.promise;

    let callbackSettled = false;
    const callbackAttempt = database
      .transaction((tx) =>
        resolveAndSaveGoogleCalendarCredential(tx, {
          accountEmail: `${TEST_PREFIX}force-disable-calendar-${suffix}@example.com`,
          actorAdminUserId: admin.id,
          canManageAllConnections: true,
          connectionId: provisional.id,
          credentialCiphertext: `${TEST_PREFIX}force-disable-new-${suffix}`,
          credentialOwnerAdminUserId: null,
          employeeResourceId: null,
          now: new Date("2032-01-04T12:01:00.000Z"),
          providerAccountId,
          scopes: ["calendar"],
        }),
      )
      .finally(() => {
        callbackSettled = true;
      });
    const callbackRejection = assert.rejects(
      callbackAttempt,
      /Google account connection changed\. Retry authorization/,
    );

    await waitForAdvisoryLockWaiter(database);
    assert.equal(callbackSettled, false);
    releaseForceDisable.resolve();
    await forceDisableTransaction;
    await callbackRejection;

    const [storedEstablished, storedProvisional] = await Promise.all([
      database
        .select({
          credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
          status: bookingCalendarConnections.status,
        })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, established.id))
        .then(([connection]) => connection),
      database
        .select({
          credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
          status: bookingCalendarConnections.status,
        })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, provisional.id))
        .then(([connection]) => connection),
    ]);
    assert.equal(storedEstablished.status, "disabled");
    assert.equal(storedEstablished.credentialCiphertext, null);
    assert.equal(storedProvisional.status, "reconnect_required");
    assert.equal(storedProvisional.credentialCiphertext, null);
  },
);

test(
  "employee disable serializes before assignment creation and makes it fail closed",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const [employee] = await database
      .insert(adminUsers)
      .values({
        email: `${TEST_PREFIX}disable-race-${suffix}@example.com`,
        emailNormalized: `${TEST_PREFIX}disable-race-${suffix}@example.com`,
        providerUserId: `${TEST_PREFIX}disable-race-${suffix}`,
        role: "employee",
        status: "active",
      })
      .returning();
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: `Disable race ${suffix}`,
        resourceKey: `${TEST_PREFIX}disable-race-resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    await database.insert(adminUserResources).values({
      adminUserId: employee.id,
      bookingResourceId: resource.id,
    });
    const [connection] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}disable-race-calendar-${suffix}@example.com`,
        connectedByAdminUserId: employee.id,
        credentialCiphertext: `${TEST_PREFIX}disable-race-ciphertext-${suffix}`,
        credentialOwnerAdminUserId: employee.id,
        provider: "google",
        providerAccountId: `${TEST_PREFIX}disable-race-account-${suffix}`,
        status: "active",
      })
      .returning();
    const {
      lockEmployeeCalendarInvariant,
      requireActiveEmployeeProviderResourceUnderInvariantLock,
    } = await import("@/lib/admin/employee-calendar-invariant");
    const statusUpdated = createDeferred();
    const releaseStatusTransaction = createDeferred();

    const disableTransaction = database.transaction(async (tx) => {
      await lockEmployeeCalendarInvariant(tx, employee.id);
      await tx
        .update(adminUsers)
        .set({ status: "disabled" })
        .where(eq(adminUsers.id, employee.id));
      statusUpdated.resolve();
      await releaseStatusTransaction.promise;
    });
    await statusUpdated.promise;

    let assignmentSettled = false;
    const assignmentAttempt = database
      .transaction(async (tx) => {
        await lockEmployeeCalendarInvariant(tx, employee.id);
        await requireActiveEmployeeProviderResourceUnderInvariantLock(tx, {
          employeeUserId: employee.id,
          resourceId: resource.id,
        });
        await tx.insert(bookingResourceCalendarAssignments).values({
          acceptsBookings: false,
          calendarConnectionId: connection.id,
          contributesBusy: true,
          createdByAdminUserId: employee.id,
          providerCalendarId: `${TEST_PREFIX}disable-race-calendar-id-${suffix}`,
          resourceId: resource.id,
          status: "active",
        });
      })
      .finally(() => {
        assignmentSettled = true;
      });
    const assignmentRejection = assert.rejects(
      assignmentAttempt,
      /active contractor/,
    );

    await delay(25);
    assert.equal(
      assignmentSettled,
      false,
      "assignment must wait for the employee invariant lock",
    );
    releaseStatusTransaction.resolve();
    await disableTransaction;
    await assignmentRejection;

    const [storedEmployee, assignments] = await Promise.all([
      database
        .select({ status: adminUsers.status })
        .from(adminUsers)
        .where(eq(adminUsers.id, employee.id))
        .then(([row]) => row),
      database
        .select({ id: bookingResourceCalendarAssignments.id })
        .from(bookingResourceCalendarAssignments)
        .where(
          eq(
            bookingResourceCalendarAssignments.calendarConnectionId,
            connection.id,
          ),
        ),
    ]);
    assert.equal(storedEmployee.status, "disabled");
    assert.equal(assignments.length, 0);
  },
);

test(
  "resource removal serializes before ownership transfer and prevents orphaned assignments",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const suffix = randomUUID();
    const [employee] = await database
      .insert(adminUsers)
      .values({
        email: `${TEST_PREFIX}unassign-race-${suffix}@example.com`,
        emailNormalized: `${TEST_PREFIX}unassign-race-${suffix}@example.com`,
        providerUserId: `${TEST_PREFIX}unassign-race-${suffix}`,
        role: "employee",
        status: "active",
      })
      .returning();
    const [resource] = await database
      .insert(bookingResources)
      .values({
        kind: "provider",
        name: `Unassign race ${suffix}`,
        resourceKey: `${TEST_PREFIX}unassign-race-resource-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    await database.insert(adminUserResources).values({
      adminUserId: employee.id,
      bookingResourceId: resource.id,
    });
    const [connection] = await database
      .insert(bookingCalendarConnections)
      .values({
        accountEmail: `${TEST_PREFIX}unassign-race-calendar-${suffix}@example.com`,
        connectedByAdminUserId: employee.id,
        credentialCiphertext: `${TEST_PREFIX}unassign-race-ciphertext-${suffix}`,
        credentialOwnerAdminUserId: null,
        provider: "google",
        providerAccountId: `${TEST_PREFIX}unassign-race-account-${suffix}`,
        status: "active",
      })
      .returning();
    await database.insert(bookingResourceCalendarAssignments).values({
      acceptsBookings: false,
      calendarConnectionId: connection.id,
      contributesBusy: true,
      createdByAdminUserId: employee.id,
      providerCalendarId: `${TEST_PREFIX}unassign-race-calendar-id-${suffix}`,
      resourceId: resource.id,
      status: "active",
    });
    const [
      { getCalendarOwnershipTransferError },
      { lockEmployeeCalendarInvariant },
      { assertStaffResourceMutationAllowed },
    ] = await Promise.all([
      import("@/lib/admin/calendar-self-service-policy"),
      import("@/lib/admin/employee-calendar-invariant"),
      import("@/lib/admin/staff-resource-authorization"),
    ]);
    const membershipRemoved = createDeferred();
    const releaseRemovalTransaction = createDeferred();

    const removalTransaction = database.transaction(async (tx) => {
      await assertStaffResourceMutationAllowed(tx, {
        operation: "unassign",
        resourceId: resource.id,
        userId: employee.id,
      });
      await tx
        .delete(adminUserResources)
        .where(eq(adminUserResources.adminUserId, employee.id));
      membershipRemoved.resolve();
      await releaseRemovalTransaction.promise;
    });
    await membershipRemoved.promise;

    let transferSettled = false;
    const transferAttempt = database
      .transaction(async (tx) => {
        await lockEmployeeCalendarInvariant(tx, employee.id);
        const [lockedConnection] = await tx
          .select({ id: bookingCalendarConnections.id })
          .from(bookingCalendarConnections)
          .where(eq(bookingCalendarConnections.id, connection.id))
          .limit(1)
          .for("update");
        assert.ok(lockedConnection);
        const [assignedResources, activeAssignments] = await Promise.all([
          tx
            .select({ resourceId: adminUserResources.bookingResourceId })
            .from(adminUserResources)
            .where(eq(adminUserResources.adminUserId, employee.id)),
          tx
            .select({
              resourceId: bookingResourceCalendarAssignments.resourceId,
            })
            .from(bookingResourceCalendarAssignments)
            .where(
              eq(
                bookingResourceCalendarAssignments.calendarConnectionId,
                connection.id,
              ),
            ),
        ]);
        const transferError = getCalendarOwnershipTransferError({
          activeAssignmentResourceIds: activeAssignments.map(
            (assignment) => assignment.resourceId,
          ),
          employeeResourceIds: assignedResources.map(
            (assignment) => assignment.resourceId,
          ),
        });
        if (transferError) {
          throw new Error(transferError);
        }
        await tx
          .update(bookingCalendarConnections)
          .set({ credentialOwnerAdminUserId: employee.id })
          .where(eq(bookingCalendarConnections.id, connection.id));
      })
      .finally(() => {
        transferSettled = true;
      });
    const transferRejection = assert.rejects(
      transferAttempt,
      /Every active calendar assignment/,
    );

    await delay(25);
    assert.equal(
      transferSettled,
      false,
      "ownership transfer must wait for the employee invariant lock",
    );
    releaseRemovalTransaction.resolve();
    await removalTransaction;
    await transferRejection;

    const [storedConnection] = await database
      .select({
        credentialOwnerAdminUserId:
          bookingCalendarConnections.credentialOwnerAdminUserId,
      })
      .from(bookingCalendarConnections)
      .where(eq(bookingCalendarConnections.id, connection.id));
    assert.equal(storedConnection.credentialOwnerAdminUserId, null);
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

    const [
      { assertStaffResourceMutationAllowed },
      { createDrizzleCalendarConnectionRepository },
    ] = await Promise.all([
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
      acceptsBookings: false,
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
      /Transfer or disconnect the contractor's active calendar assignment/,
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
      .where(
        inArray(bookingResourceCalendarAssignments.resourceId, resourceIds),
      );
    await db
      .delete(bookingResources)
      .where(inArray(bookingResources.id, resourceIds));
  }

  if (adminIds.length > 0) {
    await db
      .delete(bookingCalendarConnections)
      .where(
        inArray(bookingCalendarConnections.connectedByAdminUserId, adminIds),
      );
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

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAdvisoryLockWaiter(
  database: ReturnType<typeof requireDb>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await database.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting
          from pg_locks
          where locktype = 'advisory'
            and granted = false`,
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for OAuth callback invariant lock");
}
