import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { ResolvedOperationalBooking } from "@/lib/booking/operations/offering";
import {
  resolveServiceBookingPaymentSession,
  type PaymentSessionRepository,
} from "@/lib/booking/payment-session";
import type { BookingHoldRecord } from "@/lib/booking/holds";

import { createDrizzleBookingReservationRepository } from "./booking-reservation-repository";
import { createPrivateDbPoolConfig } from "./pool-config";
import {
  appointmentHolds,
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResourceReservations,
  bookingResourceScheduleExceptions,
  bookingResources,
  bookingServices,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
} from "./schema";
import * as schema from "./schema";

const TEST_PREFIX = "v2-res-test-";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run booking reservation DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;

afterEach(async () => {
  if (db) {
    await cleanupTestRows();
  }
});

after(async () => {
  await pool?.end();
});

test(
  "same resource conflicts across different offerings",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const secondOffering = await seedAdditionalOffering(fixture);
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const now = new Date("2031-01-01T12:00:00.000Z");
    const start = new Date("2031-01-03T15:00:00.000Z");
    const first = await repository.createV2Hold(
      createHoldInput(fixture, start, now),
    );
    const second = await repository.createV2Hold(
      createHoldInput({ ...fixture, offering: secondOffering }, start, now),
    );

    assert.equal(first.ok, true);
    if (first.ok) {
      assert.deepEqual(
        (first.hold.offeringSnapshot as Record<string, unknown>).answers,
        [{ questionId: "notes", answer: "Sensitive eyes" }],
      );
      assert.equal(
        (first.hold.offeringSnapshot as Record<string, unknown>)
          .customerStatus,
        "pending",
      );
      assert.equal(
        (first.hold.offeringSnapshot as Record<string, unknown>)
          .paymentStatus,
        "pending",
      );
    }
    assert.deepEqual(second, { ok: false, reason: "slot_conflict" });
  },
);

test(
  "different resources can reserve the same interval",
  { skip: skipReason },
  async () => {
    const firstFixture = await seedFixture();
    const secondFixture = await seedFixture();
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const now = new Date("2031-02-01T12:00:00.000Z");
    const start = new Date("2031-02-03T15:00:00.000Z");
    const first = await repository.createV2Hold(
      createHoldInput(firstFixture, start, now),
    );
    const second = await repository.createV2Hold(
      createHoldInput(secondFixture, start, now),
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
  },
);

test(
  "hold creation snapshots a verified Square team member and enforcement rejects missing mappings",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const repository = createDrizzleBookingReservationRepository(database);
    const fixture = await seedFixture();
    const now = new Date("2031-02-10T12:00:00.000Z");
    const mappedInput = createHoldInput(
      fixture,
      new Date("2031-02-12T15:00:00.000Z"),
      now,
    );

    await database
      .update(bookingProviders)
      .set({
        squareTeamMemberDisplayLabel: "Reservation Team Member",
        squareTeamMemberId: `square-team-${randomUUID()}`,
        squareTeamMemberStatus: "active",
        squareTeamMemberVerifiedAt: now,
      })
      .where(eq(bookingProviders.id, fixture.providerId));
    const [provider] = await database
      .select({ squareTeamMemberId: bookingProviders.squareTeamMemberId })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, fixture.providerId));
    mappedInput.booking.providerSnapshot.squareTeamMemberId =
      provider.squareTeamMemberId!;

    await database
      .insert(bookingBusinessSettings)
      .values({
        requireSquareTeamAttribution: true,
        singletonKey: "default",
      })
      .onConflictDoUpdate({
        target: bookingBusinessSettings.singletonKey,
        set: { requireSquareTeamAttribution: true },
      });

    try {
      const mappedResult = await repository.createV2Hold(mappedInput);
      assert.equal(mappedResult.ok, true);
      if (mappedResult.ok) {
        assert.equal(
          mappedResult.hold.squareTeamMemberId,
          provider.squareTeamMemberId,
        );
      }

      const missingFixture = await seedFixture();
      const missingResult = await repository.createV2Hold(
        createHoldInput(
          missingFixture,
          new Date("2031-02-12T17:00:00.000Z"),
          now,
        ),
      );
      assert.deepEqual(missingResult, {
        ok: false,
        reason: "square_team_attribution_required",
      });

      const inactiveFixture = await seedFixture();
      const inactiveTeamMemberId = `square-team-${randomUUID()}`;
      await database
        .update(bookingProviders)
        .set({
          squareTeamMemberDisplayLabel: "Inactive Reservation Team Member",
          squareTeamMemberId: inactiveTeamMemberId,
          squareTeamMemberStatus: "inactive",
          squareTeamMemberVerifiedAt: now,
        })
        .where(eq(bookingProviders.id, inactiveFixture.providerId));
      const inactiveInput = createHoldInput(
        inactiveFixture,
        new Date("2031-02-12T19:00:00.000Z"),
        now,
      );
      inactiveInput.booking.providerSnapshot.squareTeamMemberId =
        inactiveTeamMemberId;
      assert.deepEqual(await repository.createV2Hold(inactiveInput), {
        ok: false,
        reason: "square_team_attribution_required",
      });
    } finally {
      await database
        .update(bookingBusinessSettings)
        .set({ requireSquareTeamAttribution: false })
        .where(eq(bookingBusinessSettings.singletonKey, "default"));
    }
  },
);

test(
  "a Square team member cannot be mapped to two providers",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const firstFixture = await seedFixture();
    const secondFixture = await seedFixture();
    const squareTeamMemberId = `square-team-${randomUUID()}`;

    await database
      .update(bookingProviders)
      .set({ squareTeamMemberId })
      .where(eq(bookingProviders.id, firstFixture.providerId));

    await assert.rejects(
      database
        .update(bookingProviders)
        .set({ squareTeamMemberId })
        .where(eq(bookingProviders.id, secondFixture.providerId)),
      (error: unknown) => getNestedPostgresCode(error) === "23505",
    );
  },
);

test(
  "adjacent half-open reservation intervals do not conflict",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const now = new Date("2031-03-01T12:00:00.000Z");
    const first = await repository.createV2Hold(
      createHoldInput(fixture, new Date("2031-03-03T15:00:00.000Z"), now),
    );
    const second = await repository.createV2Hold(
      createHoldInput(fixture, new Date("2031-03-03T16:00:00.000Z"), now),
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
  },
);

test(
  "expired hold reservations are released before a replacement is inserted",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const start = new Date("2031-04-03T15:00:00.000Z");
    const firstNow = new Date("2031-04-01T12:00:00.000Z");
    const first = await repository.createV2Hold({
      ...createHoldInput(fixture, start, firstNow),
      expiresAt: new Date("2031-04-01T12:10:00.000Z"),
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const replacementNow = new Date("2031-04-01T12:11:00.000Z");
    const replacement = await repository.createV2Hold(
      createHoldInput(fixture, start, replacementNow),
    );
    const [expiredHold] = await requireDb()
      .select({ status: appointmentHolds.status })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, first.hold.id));
    const oldReservations = await requireDb()
      .select({ state: bookingResourceReservations.state })
      .from(bookingResourceReservations)
      .where(eq(bookingResourceReservations.holdId, first.hold.id));

    assert.equal(replacement.ok, true);
    assert.equal(expiredHold.status, "expired");
    assert.deepEqual(
      oldReservations.map((row) => row.state),
      ["released"],
    );
  },
);

test(
  "multi-resource conflicts roll back the hold and every reservation",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture({ secondaryResource: true });
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const now = new Date("2031-05-01T12:00:00.000Z");
    const start = new Date("2031-05-03T15:00:00.000Z");
    const end = new Date("2031-05-03T16:00:00.000Z");
    const blockedResourceId = fixture.secondaryResourceId;
    assert.ok(blockedResourceId);
    await seedUnavailableBlock(blockedResourceId, start, end);
    const input = createHoldInput(fixture, start, now);
    const result = await repository.createV2Hold(input);
    const holds = await requireDb()
      .select({ id: appointmentHolds.id })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.publicReference, input.publicReference!));
    const primaryReservations = await requireDb()
      .select({ id: bookingResourceReservations.id })
      .from(bookingResourceReservations)
      .where(
        and(
          eq(bookingResourceReservations.resourceId, fixture.primaryResourceId),
          eq(bookingResourceReservations.kind, "hold"),
        ),
      );

    assert.deepEqual(result, { ok: false, reason: "slot_conflict" });
    assert.equal(holds.length, 0);
    assert.equal(primaryReservations.length, 0);

    const successful = await repository.createV2Hold(
      createHoldInput(fixture, new Date("2031-05-03T17:00:00.000Z"), now),
    );
    assert.equal(successful.ok, true);
    if (successful.ok) {
      assert.deepEqual(
        successful.resourceIds,
        [...successful.resourceIds].sort(),
      );
      assert.equal(successful.resourceIds.length, 2);
    }
  },
);

test(
  "busy-window reads and hold reservation release are idempotent",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const now = new Date("2031-06-01T12:00:00.000Z");
    const created = await repository.createV2Hold(
      createHoldInput(fixture, new Date("2031-06-03T15:00:00.000Z"), now),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const beforeRelease = await repository.listActiveBusyWindows({
      now,
      resourceId: fixture.primaryResourceId,
      timeMax: new Date("2031-06-03T17:00:00.000Z"),
      timeMin: new Date("2031-06-03T14:00:00.000Z"),
    });
    const firstRelease = await repository.releaseReservationsForHold({
      holdId: created.hold.id,
      now: new Date("2031-06-01T12:01:00.000Z"),
      reason: "test_release",
    });
    const secondRelease = await repository.releaseReservationsForHold({
      holdId: created.hold.id,
      now: new Date("2031-06-01T12:02:00.000Z"),
      reason: "test_release_again",
    });
    const afterRelease = await repository.listActiveBusyWindows({
      now,
      resourceId: fixture.primaryResourceId,
      timeMax: new Date("2031-06-03T17:00:00.000Z"),
      timeMin: new Date("2031-06-03T14:00:00.000Z"),
    });

    assert.equal(beforeRelease.length, 1);
    assert.equal(firstRelease, 1);
    assert.equal(secondRelease, 0);
    assert.equal(afterRelease.length, 0);
  },
);

test(
  "legacy V1 holds remain valid and do not require reservations",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const reference = `${TEST_PREFIX}legacy-${randomUUID()}`;
    const [legacyHold] = await requireDb()
      .insert(appointmentHolds)
      .values({
        bookingType: "in-person-appointment",
        customerSnapshot: {
          email: "legacy@example.com",
          name: "Legacy Test",
          phone: "5555555555",
        },
        expiresAt: new Date("2031-07-01T12:10:00.000Z"),
        offeringId: "legacy-sanity-service",
        offeringSnapshot: { title: "Legacy Service" },
        paymentSessionReference: `${TEST_PREFIX}session-${randomUUID()}`,
        publicReference: reference,
        selectedEnd: new Date("2031-07-03T16:00:00.000Z"),
        selectedStart: new Date("2031-07-03T15:00:00.000Z"),
        status: "held",
        timezone: "America/Toronto",
      })
      .returning();
    const reservations = await requireDb()
      .select({ id: bookingResourceReservations.id })
      .from(bookingResourceReservations)
      .where(eq(bookingResourceReservations.holdId, legacyHold.id));

    assert.equal(legacyHold.bookingModelVersion, 1);
    assert.equal(legacyHold.serviceOfferingId, null);
    assert.equal(legacyHold.primaryResourceId, null);
    assert.equal(reservations.length, 0);
    assert.ok(fixture.primaryResourceId);
  },
);

test(
  "a persisted V2 hold opens through the existing payment-session contract",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const repository = createDrizzleBookingReservationRepository(requireDb());
    const now = new Date("2031-08-01T12:00:00.000Z");
    const input = createHoldInput(
      fixture,
      new Date("2031-08-03T15:00:00.000Z"),
      now,
    );
    input.booking.durationMinutes = 75;
    input.booking.pricing.addOnPriceCents = 1500;
    input.booking.selectedAddOn = {
      description: "Extended lash bath",
      durationDeltaMinutes: 15,
      key: "lash-bath",
      name: "Lash bath",
      priceCents: 1500,
    };
    input.booking.selectedEnd = new Date("2031-08-03T16:15:00.000Z");
    input.booking.occupiedEnd = input.booking.selectedEnd;
    const created = await repository.createV2Hold(input);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const row = created.hold;
    const paymentRepository: PaymentSessionRepository = {
      getByPaymentSessionReference: async () =>
        ({
          bookingModelVersion: row.bookingModelVersion,
          bookingType: row.bookingType,
          createdAt: row.createdAt,
          customer: row.customerSnapshot,
          expiresAt: row.expiresAt,
          googleEventId: row.googleEventId,
          id: row.id,
          offeringId: row.offeringId,
          offeringSnapshot: row.offeringSnapshot,
          payment: null,
          paymentSessionReference: row.paymentSessionReference,
          publicReference: row.publicReference,
          selectedEnd: row.selectedEnd,
          selectedStart: row.selectedStart,
          state: row.status,
          timezone: row.timezone,
          updatedAt: row.updatedAt,
        }) as BookingHoldRecord,
    };
    const result = await resolveServiceBookingPaymentSession(
      {
        now: new Date("2031-08-01T12:01:00.000Z"),
        paymentSessionReference: row.paymentSessionReference,
        serviceSlug: fixture.offering.publicSlug,
      },
      paymentRepository,
    );

    assert.equal(result.status, "active");
    if (result.status !== "active") return;
    assert.equal(
      result.session.serviceTitle,
      "Reservation test service with Reservation test provider",
    );
    assert.equal(result.session.pricing.fullPriceCents, 12000);
    assert.equal(result.session.pricing.depositAmountCents, 5000);
    assert.equal(result.session.pricing.addOnPriceCents, 1500);
    assert.deepEqual(result.session.selectedAddOn, {
      description: "Extended lash bath",
      key: "lash-bath",
      name: "Lash bath",
      priceCents: 1500,
    });
  },
);

interface SeededFixture {
  assignmentId: string;
  calendarConnectionId: string;
  offering: {
    id: string;
    key: string;
    publicSlug: string;
    serviceId: string;
    serviceKey: string;
  };
  primaryResourceId: string;
  providerId: string;
  providerKey: string;
  secondaryResourceId?: string;
}

async function seedFixture(
  options: { secondaryResource?: boolean } = {},
): Promise<SeededFixture> {
  const suffix = randomUUID();
  const database = requireDb();
  const [primaryResource] = await database
    .insert(bookingResources)
    .values({
      kind: "provider",
      name: `Test resource ${suffix}`,
      resourceKey: `${TEST_PREFIX}resource-${suffix}`,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();
  const [provider] = await database
    .insert(bookingProviders)
    .values({
      displayName: `Test provider ${suffix}`,
      primaryResourceId: primaryResource.id,
      providerKey: `${TEST_PREFIX}provider-${suffix}`,
      publicSlug: `${TEST_PREFIX}provider-${suffix}`,
      status: "active",
    })
    .returning();
  const [service] = await database
    .insert(bookingServices)
    .values({
      displayTitle: `Test service ${suffix}`,
      publicSlug: `${TEST_PREFIX}service-${suffix}`,
      serviceKey: `${TEST_PREFIX}service-${suffix}`,
      status: "active",
    })
    .returning();
  const [offering] = await database
    .insert(bookingServiceOfferings)
    .values({
      bookingType: "in-person-appointment",
      depositAmountCents: 5000,
      durationMinutes: 60,
      fullPriceCents: 12000,
      offeringKey: `${TEST_PREFIX}offering-${suffix}`,
      primaryResourceId: primaryResource.id,
      providerId: provider.id,
      serviceId: service.id,
      slotIntervalMinutes: 15,
      status: "active",
      version: 1,
    })
    .returning();
  const [connection] = await database
    .insert(bookingCalendarConnections)
    .values({
      accountEmail: `${TEST_PREFIX}${suffix}@example.com`,
      credentialSecretRef: `${TEST_PREFIX}secret-${suffix}`,
      provider: "google",
      providerAccountId: `${TEST_PREFIX}account-${suffix}`,
      status: "active",
    })
    .returning();
  const [assignment] = await database
    .insert(bookingResourceCalendarAssignments)
    .values({
      acceptsBookings: true,
      calendarConnectionId: connection.id,
      calendarLabel: `${TEST_PREFIX}calendar-${suffix}`,
      contributesBusy: true,
      providerCalendarId: `${TEST_PREFIX}calendar-id-${suffix}`,
      resourceId: primaryResource.id,
      status: "active",
    })
    .returning();
  let secondaryResourceId: string | undefined;

  if (options.secondaryResource) {
    const [secondary] = await database
      .insert(bookingResources)
      .values({
        kind: "room",
        name: `Test secondary resource ${suffix}`,
        resourceKey: `${TEST_PREFIX}secondary-${suffix}`,
        status: "active",
        timezone: "America/Toronto",
      })
      .returning();
    secondaryResourceId = secondary.id;
    await database.insert(bookingServiceOfferingResources).values({
      isRequired: true,
      offeringId: offering.id,
      resourceId: secondary.id,
      role: "room",
    });
  }

  return {
    assignmentId: assignment.id,
    calendarConnectionId: connection.id,
    offering: {
      id: offering.id,
      key: offering.offeringKey,
      publicSlug: service.publicSlug!,
      serviceId: service.id,
      serviceKey: service.serviceKey,
    },
    primaryResourceId: primaryResource.id,
    providerId: provider.id,
    providerKey: provider.providerKey,
    ...(secondaryResourceId ? { secondaryResourceId } : {}),
  };
}

async function seedAdditionalOffering(fixture: SeededFixture) {
  const suffix = randomUUID();
  const database = requireDb();
  const [service] = await database
    .insert(bookingServices)
    .values({
      displayTitle: `Second test service ${suffix}`,
      publicSlug: `${TEST_PREFIX}second-service-${suffix}`,
      serviceKey: `${TEST_PREFIX}second-service-${suffix}`,
      status: "active",
    })
    .returning();
  const [offering] = await database
    .insert(bookingServiceOfferings)
    .values({
      depositAmountCents: 4000,
      durationMinutes: 60,
      fullPriceCents: 10000,
      offeringKey: `${TEST_PREFIX}second-offering-${suffix}`,
      primaryResourceId: fixture.primaryResourceId,
      providerId: fixture.providerId,
      serviceId: service.id,
      slotIntervalMinutes: 15,
      status: "active",
      version: 1,
    })
    .returning();

  return {
    id: offering.id,
    key: offering.offeringKey,
    publicSlug: service.publicSlug!,
    serviceId: service.id,
    serviceKey: service.serviceKey,
  };
}

function createHoldInput(fixture: SeededFixture, start: Date, now: Date) {
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const booking: ResolvedOperationalBooking = {
    bookingModelVersion: 2,
    calendar: {
      assignmentId: fixture.assignmentId,
      calendarId: `${TEST_PREFIX}canonical-calendar`,
      connectionId: fixture.calendarConnectionId,
    },
    configurationVersion: 1,
    durationMinutes: 60,
    occupiedEnd: end,
    occupiedStart: start,
    offeringId: fixture.offering.id,
    offeringKey: fixture.offering.key,
    pricing: {
      addOnPriceCents: 0,
      currency: "CAD",
      depositAmountCents: 5000,
      fullPriceCents: 12000,
    },
    providerId: fixture.providerId,
    providerSnapshot: {
      displayName: "Reservation test provider",
      providerKey: fixture.providerKey,
    },
    resourceId: fixture.primaryResourceId,
    selectedEnd: end,
    selectedStart: start,
    serviceSnapshot: {
      displayTitle: "Reservation test service",
      publicSlug: fixture.offering.publicSlug,
      serviceId: fixture.offering.serviceId,
      serviceKey: fixture.offering.serviceKey,
    },
    timezone: "America/Toronto",
  };

  return {
    answers: [{ questionId: "notes", answer: "Sensitive eyes" }],
    booking,
    customer: {
      email: "reservation-test@example.com",
      name: "Reservation Test",
      phone: "5555555555",
    },
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    now,
    paymentSessionReference: `${TEST_PREFIX}session-${randomUUID()}`,
    publicReference: `${TEST_PREFIX}hold-${randomUUID()}`,
  };
}

async function seedUnavailableBlock(
  resourceId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<void> {
  const database = requireDb();
  const [exception] = await database
    .insert(bookingResourceScheduleExceptions)
    .values({
      endsAt,
      kind: "unavailable",
      reasonCode: TEST_PREFIX,
      resourceId,
      startsAt,
      status: "active",
      timezone: "America/Toronto",
    })
    .returning();

  await database.insert(bookingResourceReservations).values({
    kind: "block",
    occupiedEnd: endsAt,
    occupiedStart: startsAt,
    resourceId,
    scheduleExceptionId: exception.id,
    state: "active",
  });
}

function requireDb() {
  if (!db) {
    throw new Error("TEST_DATABASE_URL not configured");
  }

  return db;
}

function getNestedPostgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as { cause?: unknown; code?: unknown };
    if (typeof record.code === "string") {
      return record.code;
    }
    current = record.cause;
  }
  return undefined;
}

async function cleanupTestRows(): Promise<void> {
  const database = requireDb();

  await database.execute(
    sql`delete from ${appointmentHolds} where ${appointmentHolds.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
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
  await database.execute(
    sql`delete from ${bookingResources} where ${bookingResources.resourceKey} like ${`${TEST_PREFIX}%`}`,
  );
}
