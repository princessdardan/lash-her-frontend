import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { lockSquareAttributionInvariant } from "@/lib/admin/square-attribution-invariant";
import type { ResolvedOperationalBooking } from "@/lib/booking/operations/offering";
import {
  resolveServiceBookingPaymentSession,
  type PaymentSessionRepository,
} from "@/lib/booking/payment-session";
import type { BookingHoldRecord } from "@/lib/booking/holds";

import { createDrizzleBookingReservationRepository } from "./booking-reservation-repository";
import { createServiceBookingPaymentRepository } from "./service-booking-payment-repository";
import { createPrivateDbPoolConfig } from "./pool-config";
import {
  appointmentHolds,
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingPaymentAttempts,
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
import { observeOperationalSquarePayment } from "./operational-square-payment-observer";

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
        (first.hold.offeringSnapshot as Record<string, unknown>).customerStatus,
        "pending",
      );
      assert.equal(
        (first.hold.offeringSnapshot as Record<string, unknown>).paymentStatus,
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
    mappedInput.booking.squareTeamMemberId = provider.squareTeamMemberId!;

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
      inactiveInput.booking.squareTeamMemberId = inactiveTeamMemberId;
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
  "hold creation waits for a concurrent Square mapping replacement and rejects the stale snapshot",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const repository = createDrizzleBookingReservationRepository(database);
    const fixture = await seedFixture();
    const now = new Date("2031-02-13T12:00:00.000Z");
    const originalTeamMemberId = `square-team-${randomUUID()}`;
    const replacementTeamMemberId = `square-team-${randomUUID()}`;
    const input = createHoldInput(
      fixture,
      new Date("2031-02-15T15:00:00.000Z"),
      now,
    );
    input.booking.squareTeamMemberId = originalTeamMemberId;

    await database
      .update(bookingProviders)
      .set({
        squareTeamMemberDisplayLabel: "Original Reservation Team Member",
        squareTeamMemberId: originalTeamMemberId,
        squareTeamMemberStatus: "active",
        squareTeamMemberVerifiedAt: now,
      })
      .where(eq(bookingProviders.id, fixture.providerId));
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

    const replacementReady = deferred<void>();
    const releaseReplacement = deferred<void>();
    const replacement = database.transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await tx
        .update(bookingProviders)
        .set({
          squareTeamMemberDisplayLabel: "Replacement Reservation Team Member",
          squareTeamMemberId: replacementTeamMemberId,
          squareTeamMemberStatus: "active",
          squareTeamMemberVerifiedAt: new Date("2031-02-13T12:01:00.000Z"),
        })
        .where(eq(bookingProviders.id, fixture.providerId));
      replacementReady.resolve();
      await releaseReplacement.promise;
    });
    await replacementReady.promise;

    let holdSettled = false;
    const holdCreation = repository.createV2Hold(input).then((result) => {
      holdSettled = true;
      return result;
    });

    try {
      await waitForAdvisoryLockWaiter(database);
      assert.equal(holdSettled, false);
      releaseReplacement.resolve();
      await replacement;

      assert.deepEqual(await holdCreation, {
        ok: false,
        reason: "square_team_attribution_required",
      });
      const holds = await database
        .select({ id: appointmentHolds.id })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.publicReference, input.publicReference));
      assert.equal(holds.length, 0);
    } finally {
      releaseReplacement.resolve();
      await replacement;
      await database
        .update(bookingBusinessSettings)
        .set({ requireSquareTeamAttribution: false })
        .where(eq(bookingBusinessSettings.singletonKey, "default"));
    }
  },
);

test(
  "hold creation snapshots the current Square mapping after a concurrent replacement when enforcement is disabled",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const repository = createDrizzleBookingReservationRepository(database);
    const fixture = await seedFixture();
    const now = new Date("2031-02-14T12:00:00.000Z");
    const originalTeamMemberId = `square-team-${randomUUID()}`;
    const replacementTeamMemberId = `square-team-${randomUUID()}`;
    const laterTeamMemberId = `square-team-${randomUUID()}`;
    const input = createHoldInput(
      fixture,
      new Date("2031-02-16T15:00:00.000Z"),
      now,
    );
    input.booking.squareTeamMemberId = originalTeamMemberId;

    await database
      .update(bookingProviders)
      .set({
        squareTeamMemberDisplayLabel: "Original Optional Team Member",
        squareTeamMemberId: originalTeamMemberId,
        squareTeamMemberStatus: "active",
        squareTeamMemberVerifiedAt: now,
      })
      .where(eq(bookingProviders.id, fixture.providerId));
    await database
      .insert(bookingBusinessSettings)
      .values({
        requireSquareTeamAttribution: false,
        singletonKey: "default",
      })
      .onConflictDoUpdate({
        target: bookingBusinessSettings.singletonKey,
        set: { requireSquareTeamAttribution: false },
      });

    const replacementReady = deferred<void>();
    const releaseReplacement = deferred<void>();
    const replacement = database.transaction(async (tx) => {
      await lockSquareAttributionInvariant(tx);
      await tx
        .update(bookingProviders)
        .set({
          squareTeamMemberDisplayLabel: "Replacement Optional Team Member",
          squareTeamMemberId: replacementTeamMemberId,
          squareTeamMemberStatus: "active",
          squareTeamMemberVerifiedAt: new Date("2031-02-14T12:01:00.000Z"),
        })
        .where(eq(bookingProviders.id, fixture.providerId));
      replacementReady.resolve();
      await releaseReplacement.promise;
    });
    await replacementReady.promise;

    let holdSettled = false;
    const holdCreation = repository.createV2Hold(input).then((result) => {
      holdSettled = true;
      return result;
    });

    try {
      await waitForAdvisoryLockWaiter(database);
      assert.equal(holdSettled, false);
      releaseReplacement.resolve();
      await replacement;

      const created = await holdCreation;
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.hold.squareTeamMemberId, replacementTeamMemberId);

      await database.transaction(async (tx) => {
        await lockSquareAttributionInvariant(tx);
        await tx
          .update(bookingProviders)
          .set({
            squareTeamMemberDisplayLabel: "Later Optional Team Member",
            squareTeamMemberId: laterTeamMemberId,
            squareTeamMemberStatus: "active",
            squareTeamMemberVerifiedAt: new Date("2031-02-14T12:02:00.000Z"),
          })
          .where(eq(bookingProviders.id, fixture.providerId));
      });
      const [persistedHold] = await database
        .select({
          squareTeamMemberId: appointmentHolds.squareTeamMemberId,
        })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, created.hold.id));
      assert.equal(persistedHold.squareTeamMemberId, replacementTeamMemberId);
    } finally {
      releaseReplacement.resolve();
      await replacement;
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
  "capture lease prevents expiry between Square authorization and capture",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const reservationRepository =
      createDrizzleBookingReservationRepository(requireDb());
    const paymentRepository =
      await createServiceBookingPaymentRepository(requireDb());
    const initialNow = new Date("2031-04-10T12:00:00.000Z");
    const start = new Date("2031-04-12T15:00:00.000Z");
    const first = await reservationRepository.createV2Hold({
      ...createHoldInput(fixture, start, initialNow),
      expiresAt: new Date("2031-04-10T12:10:00.000Z"),
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const prepare = paymentRepository.prepareOperationalPaymentIntent;
    const recordAuthorized =
      paymentRepository.recordAuthorizedOperationalPayment;
    const validateLease = paymentRepository.validateOperationalCaptureLease;
    assert.ok(prepare);
    assert.ok(recordAuthorized);
    assert.ok(validateLease);
    const providerKey = `${TEST_PREFIX}capture-key-${randomUUID()}`;
    const paymentId = `${TEST_PREFIX}capture-payment-${randomUUID()}`;
    const authorizedAt = new Date("2031-04-10T12:01:00.000Z");
    const leaseExpiresAt = new Date("2031-04-10T12:20:00.000Z");
    const prepared = await prepare({
      amountCents: 13560,
      currency: "CAD",
      holdId: first.hold.id,
      idempotencyKeyCandidate: providerKey,
      leaseExpiresAt,
      now: authorizedAt,
      referenceId: first.hold.publicReference,
      requestBodyHash: `${TEST_PREFIX}capture-request-hash`,
      sourceIdHash: `${TEST_PREFIX}capture-source-hash`,
      squareCustomerId: `${TEST_PREFIX}capture-customer`,
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;
    await recordAuthorized({
      amountCents: 13560,
      currency: "CAD",
      holdId: first.hold.id,
      idempotencyKey: providerKey,
      now: authorizedAt,
      squarePaymentId: paymentId,
    });

    // This transaction runs after the original hold expiry but during the
    // capture lease. It must neither release the reservation nor acquire it.
    const competing = await reservationRepository.createV2Hold(
      createHoldInput(fixture, start, new Date("2031-04-10T12:11:00.000Z")),
    );
    assert.deepEqual(competing, { ok: false, reason: "slot_conflict" });

    assert.equal(
      await validateLease({
        captureLeaseId: prepared.captureLeaseId,
        holdId: first.hold.id,
        idempotencyKey: providerKey,
        leaseExpiresAt: new Date("2031-04-10T12:25:00.000Z"),
        now: new Date("2031-04-10T12:12:00.000Z"),
        squarePaymentId: paymentId,
      }),
      true,
    );
  },
);

test(
  "provider-observed authorization protects an ambiguous CreatePayment before the HTTP response",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const reservationRepository =
      createDrizzleBookingReservationRepository(requireDb());
    const paymentRepository =
      await createServiceBookingPaymentRepository(requireDb());
    const initialNow = new Date("2031-04-20T12:00:00.000Z");
    const start = new Date("2031-04-22T15:00:00.000Z");
    const created = await reservationRepository.createV2Hold({
      ...createHoldInput(fixture, start, initialNow),
      expiresAt: new Date("2031-04-20T12:10:00.000Z"),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const prepare = paymentRepository.prepareOperationalPaymentIntent;
    assert.ok(prepare);
    const squareCustomerId = `${TEST_PREFIX}webhook-customer-${randomUUID()}`;
    const prepared = await prepare({
      amountCents: 13560,
      currency: "CAD",
      holdId: created.hold.id,
      idempotencyKeyCandidate: `${TEST_PREFIX}webhook-key-${randomUUID()}`,
      leaseExpiresAt: new Date("2031-04-20T12:20:00.000Z"),
      now: new Date("2031-04-20T12:01:00.000Z"),
      referenceId: created.hold.publicReference,
      requestBodyHash: `${TEST_PREFIX}webhook-request-hash`,
      sourceIdHash: `${TEST_PREFIX}webhook-source-hash`,
      squareCustomerId,
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;

    const paymentId = `${TEST_PREFIX}webhook-payment-${randomUUID()}`;
    const observed = await observeOperationalSquarePayment(
      {
        amount_money: { amount: 13560, currency: "CAD" },
        customer_id: squareCustomerId,
        id: paymentId,
        reference_id: created.hold.publicReference,
        status: "APPROVED",
        version_token: "version-before-response",
      },
      new Date("2031-04-20T12:02:00.000Z"),
      requireDb(),
    );
    const [attempt] = await requireDb()
      .select({
        providerMetadata: bookingPaymentAttempts.providerMetadata,
        providerPaymentId: bookingPaymentAttempts.providerPaymentId,
        status: bookingPaymentAttempts.status,
      })
      .from(bookingPaymentAttempts)
      .where(
        eq(bookingPaymentAttempts.idempotencyKey, prepared.idempotencyKey),
      );

    assert.equal(observed.status, "observed");
    assert.equal(attempt.providerPaymentId, paymentId);
    assert.equal(attempt.status, "authorized");
    assert.equal(
      attempt.providerMetadata?.squareVersionToken,
      "version-before-response",
    );

    const competing = await reservationRepository.createV2Hold(
      createHoldInput(fixture, start, new Date("2031-04-20T12:21:00.000Z")),
    );
    assert.deepEqual(competing, { ok: false, reason: "slot_conflict" });
  },
);

test(
  "provider observation never rebinds an attempt to a second matching-metadata payment",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const fixture = await seedFixture();
    const reservationRepository =
      createDrizzleBookingReservationRepository(database);
    const paymentRepository =
      await createServiceBookingPaymentRepository(database);
    const initialNow = new Date("2031-04-21T12:00:00.000Z");
    const created = await reservationRepository.createV2Hold(
      createHoldInput(
        fixture,
        new Date("2031-04-23T15:00:00.000Z"),
        initialNow,
      ),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const prepare = paymentRepository.prepareOperationalPaymentIntent;
    assert.ok(prepare);
    const squareCustomerId = `${TEST_PREFIX}webhook-binding-customer-${randomUUID()}`;
    const prepared = await prepare({
      amountCents: 13560,
      currency: "CAD",
      holdId: created.hold.id,
      idempotencyKeyCandidate: `${TEST_PREFIX}webhook-binding-key-${randomUUID()}`,
      leaseExpiresAt: new Date("2031-04-21T12:20:00.000Z"),
      now: new Date("2031-04-21T12:01:00.000Z"),
      referenceId: created.hold.publicReference,
      requestBodyHash: `${TEST_PREFIX}webhook-binding-request-hash`,
      sourceIdHash: `${TEST_PREFIX}webhook-binding-source-hash`,
      squareCustomerId,
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;

    const boundPaymentId = `${TEST_PREFIX}webhook-bound-payment-${randomUUID()}`;
    await observeOperationalSquarePayment(
      {
        amount_money: { amount: 13560, currency: "CAD" },
        customer_id: squareCustomerId,
        id: boundPaymentId,
        reference_id: created.hold.publicReference,
        status: "APPROVED",
        version_token: "bound-version",
      },
      new Date("2031-04-21T12:02:00.000Z"),
      database,
    );

    const conflictingPaymentId = `${TEST_PREFIX}webhook-conflicting-payment-${randomUUID()}`;
    const alerts: unknown[] = [];
    let completedProjectionCalls = 0;
    const conflictingObservation = await observeOperationalSquarePayment(
      {
        amount_money: { amount: 13560, currency: "CAD" },
        customer_id: squareCustomerId,
        id: conflictingPaymentId,
        reference_id: created.hold.publicReference,
        status: "COMPLETED",
        version_token: "conflicting-version",
      },
      new Date("2031-04-21T12:03:00.000Z"),
      database,
      {
        alerts: { alert: (input) => alerts.push(input) },
        async recordCompletedPayment() {
          completedProjectionCalls += 1;
        },
      },
    );

    const [attempt] = await database
      .select({
        providerMetadata: bookingPaymentAttempts.providerMetadata,
        providerPaymentId: bookingPaymentAttempts.providerPaymentId,
        status: bookingPaymentAttempts.status,
      })
      .from(bookingPaymentAttempts)
      .where(
        eq(bookingPaymentAttempts.idempotencyKey, prepared.idempotencyKey),
      );

    assert.equal(conflictingObservation.status, "observed");
    assert.equal(attempt.providerPaymentId, boundPaymentId);
    assert.equal(attempt.status, "authorized");
    assert.equal(attempt.providerMetadata?.squareVersionToken, "bound-version");
    assert.equal(completedProjectionCalls, 0);
    assert.equal(alerts.length, 1);
    assert.match(JSON.stringify(alerts[0]), /immutable payment attempt/);
  },
);

test(
  "provider-observed attribution mismatch cancels and terminalizes the authorization",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const fixture = await seedFixture();
    const reservationRepository =
      createDrizzleBookingReservationRepository(database);
    const paymentRepository =
      await createServiceBookingPaymentRepository(database);
    const expectedTeamMemberId = `${TEST_PREFIX}webhook-team-${randomUUID()}`;
    const initialNow = new Date("2031-04-23T12:00:00.000Z");
    await database
      .update(bookingProviders)
      .set({
        squareTeamMemberDisplayLabel: "Webhook Team Member",
        squareTeamMemberId: expectedTeamMemberId,
        squareTeamMemberStatus: "active",
        squareTeamMemberVerifiedAt: initialNow,
      })
      .where(eq(bookingProviders.id, fixture.providerId));
    const holdInput = createHoldInput(
      fixture,
      new Date("2031-04-25T15:00:00.000Z"),
      initialNow,
    );
    holdInput.booking.squareTeamMemberId = expectedTeamMemberId;
    const created = await reservationRepository.createV2Hold(holdInput);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const prepare = paymentRepository.prepareOperationalPaymentIntent;
    const terminate =
      paymentRepository.markAuthorizedOperationalPaymentTerminated;
    assert.ok(prepare);
    assert.ok(terminate);
    const squareCustomerId = `${TEST_PREFIX}webhook-mismatch-customer-${randomUUID()}`;
    const prepared = await prepare({
      amountCents: 13560,
      currency: "CAD",
      holdId: created.hold.id,
      idempotencyKeyCandidate: `${TEST_PREFIX}webhook-mismatch-key-${randomUUID()}`,
      leaseExpiresAt: new Date("2031-04-23T12:20:00.000Z"),
      now: new Date("2031-04-23T12:01:00.000Z"),
      referenceId: created.hold.publicReference,
      requestBodyHash: `${TEST_PREFIX}webhook-mismatch-request-hash`,
      sourceIdHash: `${TEST_PREFIX}webhook-mismatch-source-hash`,
      squareCustomerId,
      squareTeamMemberId: expectedTeamMemberId,
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;

    const cancellationCalls: string[] = [];
    const alertCalls: unknown[] = [];
    const paymentId = `${TEST_PREFIX}webhook-mismatch-payment-${randomUUID()}`;
    const observed = await observeOperationalSquarePayment(
      {
        amount_money: { amount: 13560, currency: "CAD" },
        customer_id: squareCustomerId,
        id: paymentId,
        reference_id: created.hold.publicReference,
        status: "APPROVED",
        team_member_id: `${TEST_PREFIX}wrong-team`,
      },
      new Date("2031-04-23T12:02:00.000Z"),
      database,
      {
        alerts: { alert: (input) => alertCalls.push(input) },
        async cancelPayment(squarePaymentId) {
          cancellationCalls.push(squarePaymentId);
          return {
            payment: {
              amount_money: { amount: 13560, currency: "CAD" },
              customer_id: squareCustomerId,
              id: squarePaymentId,
              reference_id: created.hold.publicReference,
              status: "CANCELED",
              team_member_id: `${TEST_PREFIX}wrong-team`,
            },
          };
        },
        markHoldPaymentFailed: (input) =>
          paymentRepository.markHoldPaymentFailed(input),
        markHoldRefundRequired: (input) =>
          paymentRepository.markHoldRefundRequired(input),
        markPaymentTerminated: (input) => terminate(input),
      },
    );

    const [attempt] = await database
      .select()
      .from(bookingPaymentAttempts)
      .where(
        eq(bookingPaymentAttempts.idempotencyKey, prepared.idempotencyKey),
      );
    const [hold] = await database
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, created.hold.id));
    assert.equal(observed.status, "observed");
    assert.deepEqual(cancellationCalls, [paymentId]);
    assert.equal(attempt.status, "cancelled");
    assert.equal(attempt.providerPaymentId, paymentId);
    assert.equal(hold.status, "payment_failed");
    assert.equal(alertCalls.length, 1);
  },
);

test(
  "provider-observed completed attribution mismatch is captured without creating an appointment",
  { skip: skipReason },
  async () => {
    const database = requireDb();
    const fixture = await seedFixture();
    const reservationRepository =
      createDrizzleBookingReservationRepository(database);
    const paymentRepository =
      await createServiceBookingPaymentRepository(database);
    const expectedTeamMemberId = `${TEST_PREFIX}webhook-complete-team-${randomUUID()}`;
    const initialNow = new Date("2031-04-24T12:00:00.000Z");
    await database
      .update(bookingProviders)
      .set({
        squareTeamMemberDisplayLabel: "Completed Webhook Team Member",
        squareTeamMemberId: expectedTeamMemberId,
        squareTeamMemberStatus: "active",
        squareTeamMemberVerifiedAt: initialNow,
      })
      .where(eq(bookingProviders.id, fixture.providerId));
    const holdInput = createHoldInput(
      fixture,
      new Date("2031-04-26T15:00:00.000Z"),
      initialNow,
    );
    holdInput.booking.squareTeamMemberId = expectedTeamMemberId;
    const created = await reservationRepository.createV2Hold(holdInput);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const prepare = paymentRepository.prepareOperationalPaymentIntent;
    const terminate =
      paymentRepository.markAuthorizedOperationalPaymentTerminated;
    assert.ok(prepare);
    assert.ok(terminate);
    const squareCustomerId = `${TEST_PREFIX}webhook-complete-customer-${randomUUID()}`;
    const prepared = await prepare({
      amountCents: 13560,
      currency: "CAD",
      holdId: created.hold.id,
      idempotencyKeyCandidate: `${TEST_PREFIX}webhook-complete-key-${randomUUID()}`,
      leaseExpiresAt: new Date("2031-04-24T12:20:00.000Z"),
      now: new Date("2031-04-24T12:01:00.000Z"),
      referenceId: created.hold.publicReference,
      requestBodyHash: `${TEST_PREFIX}webhook-complete-request-hash`,
      sourceIdHash: `${TEST_PREFIX}webhook-complete-source-hash`,
      squareCustomerId,
      squareTeamMemberId: expectedTeamMemberId,
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;

    let completedProjectionCalls = 0;
    const paymentId = `${TEST_PREFIX}webhook-complete-payment-${randomUUID()}`;
    const observed = await observeOperationalSquarePayment(
      {
        amount_money: { amount: 13560, currency: "CAD" },
        customer_id: squareCustomerId,
        id: paymentId,
        reference_id: created.hold.publicReference,
        status: "COMPLETED",
        team_member_id: `${TEST_PREFIX}wrong-team`,
      },
      new Date("2031-04-24T12:02:00.000Z"),
      database,
      {
        alerts: { alert() {} },
        markHoldPaymentFailed: (input) =>
          paymentRepository.markHoldPaymentFailed(input),
        markHoldRefundRequired: (input) =>
          paymentRepository.markHoldRefundRequired(input),
        markPaymentTerminated: (input) => terminate(input),
        async recordCompletedPayment() {
          completedProjectionCalls += 1;
        },
      },
    );

    const [attempt] = await database
      .select()
      .from(bookingPaymentAttempts)
      .where(
        eq(bookingPaymentAttempts.idempotencyKey, prepared.idempotencyKey),
      );
    const [hold] = await database
      .select()
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, created.hold.id));
    assert.equal(observed.status, "observed");
    assert.equal(completedProjectionCalls, 0);
    assert.equal(attempt.status, "captured");
    assert.equal(attempt.providerPaymentId, paymentId);
    assert.equal(hold.status, "refund_required");
    assert.equal(hold.finalizationStatus, "refund_required");
  },
);

test(
  "provider-observed completion remains captured when appointment projection fails",
  { skip: skipReason },
  async () => {
    const fixture = await seedFixture();
    const reservationRepository =
      createDrizzleBookingReservationRepository(requireDb());
    const paymentRepository =
      await createServiceBookingPaymentRepository(requireDb());
    const initialNow = new Date("2031-04-25T12:00:00.000Z");
    const start = new Date("2031-04-27T15:00:00.000Z");
    const created = await reservationRepository.createV2Hold({
      ...createHoldInput(fixture, start, initialNow),
      expiresAt: new Date("2031-04-25T12:10:00.000Z"),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const prepare = paymentRepository.prepareOperationalPaymentIntent;
    assert.ok(prepare);
    const squareCustomerId = `${TEST_PREFIX}captured-customer-${randomUUID()}`;
    const prepared = await prepare({
      amountCents: 13560,
      currency: "CAD",
      holdId: created.hold.id,
      idempotencyKeyCandidate: `${TEST_PREFIX}captured-key-${randomUUID()}`,
      leaseExpiresAt: new Date("2031-04-25T12:20:00.000Z"),
      now: new Date("2031-04-25T12:01:00.000Z"),
      referenceId: created.hold.publicReference,
      requestBodyHash: `${TEST_PREFIX}captured-request-hash`,
      sourceIdHash: `${TEST_PREFIX}captured-source-hash`,
      squareCustomerId,
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;

    const paymentId = `${TEST_PREFIX}captured-payment-${randomUUID()}`;
    const completedPayment = {
      amount_money: { amount: 13560, currency: "CAD" },
      customer_id: squareCustomerId,
      id: paymentId,
      reference_id: created.hold.publicReference,
      status: "COMPLETED",
    };
    await assert.rejects(
      observeOperationalSquarePayment(
        completedPayment,
        new Date("2031-04-25T12:02:00.000Z"),
        requireDb(),
      ),
      /validated payment selection/,
    );

    const [attempt] = await requireDb()
      .select({
        providerPaymentId: bookingPaymentAttempts.providerPaymentId,
        status: bookingPaymentAttempts.status,
      })
      .from(bookingPaymentAttempts)
      .where(
        eq(bookingPaymentAttempts.idempotencyKey, prepared.idempotencyKey),
      );
    assert.equal(attempt.providerPaymentId, paymentId);
    assert.equal(attempt.status, "captured");

    // A webhook retry must keep using the same captured evidence and retry the
    // local projection rather than falling through to a legacy finalizer.
    await assert.rejects(
      observeOperationalSquarePayment(
        completedPayment,
        new Date("2031-04-25T12:03:00.000Z"),
        requireDb(),
      ),
      /validated payment selection/,
    );
    const competing = await reservationRepository.createV2Hold(
      createHoldInput(fixture, start, new Date("2031-04-25T12:21:00.000Z")),
    );
    assert.deepEqual(competing, { ok: false, reason: "slot_conflict" });
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Timed out waiting for hold creation to block on advisory lock",
  );
}

function getNestedPostgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth += 1
  ) {
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
