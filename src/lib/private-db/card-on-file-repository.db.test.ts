import { execFileSync } from "node:child_process";
import { config } from "dotenv";
import test, { after } from "node:test";

config({ path: [".env.local", ".env"] });

const dbTestUrl = process.env.TEST_DATABASE_URL;
const dbTestSkipReason = dbTestUrl
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed repository tests";

if (dbTestUrl) {
  after(() => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
      });
    `);
  });
}

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { eq, sql } from "drizzle-orm";
  import { drizzle } from "drizzle-orm/node-postgres";
  import { Pool } from "pg";

  import { createCardOnFileDrizzleRepository } from "./src/lib/private-db/card-on-file-repository.ts";
  import { createPrivateDbPoolConfig } from "./src/lib/private-db/pool-config.ts";
  import {
    appointmentHolds,
    bookingNoShowChargeRecords,
  } from "./src/lib/private-db/schema.ts";

  function createTestDb() {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return null;

    const pool = new Pool(createPrivateDbPoolConfig(url));
    const db = drizzle({
      client: pool,
      schema: { appointmentHolds, bookingNoShowChargeRecords },
    });
    return { db, pool };
  }

  async function withTestDb(fn) {
    const created = createTestDb();
    if (!created) {
      throw new Error("TEST_DATABASE_URL not configured");
    }

    const { db, pool } = created;
    try {
      return await fn(db);
    } finally {
      await pool.end();
    }
  }

  async function resetCardOnFileTables(db) {
    // Scoped cleanup for rows created by this test file only.
    // Global TRUNCATE takes AccessExclusiveLock and deadlocks when concurrent
    // tests hold row locks inside transactions. Row-level DELETE on our own
    // rows avoids that lock while still resetting state between scenarios.
    const testHoldFilter = "appointment_holds.public_reference LIKE 'lh-test-%'";

    // checkout_payment_events.no_show_charge_record_id is onDelete set null,
    // so deleting no-show records/holds would leave orphan events. Delete
    // events linked to this test file's records first.
    await db.execute(sql.raw(
      "DELETE FROM checkout_payment_events " +
      "WHERE no_show_charge_record_id IN (" +
      "  SELECT id FROM booking_no_show_charge_records " +
      "  WHERE hold_id IN (" +
      "    SELECT id FROM appointment_holds WHERE " + testHoldFilter +
      "  )" +
      ")",
    ));

    // Remove dependent rows for our test holds in FK order.
    await db.execute(sql.raw(
      "DELETE FROM booking_no_show_charge_attempts " +
      "WHERE no_show_charge_record_id IN (" +
      "  SELECT id FROM booking_no_show_charge_records " +
      "  WHERE hold_id IN (" +
      "    SELECT id FROM appointment_holds WHERE " + testHoldFilter +
      "  )" +
      ")",
    ));

    await db.execute(sql.raw(
      "DELETE FROM booking_no_show_charge_records " +
      "WHERE hold_id IN (" +
      "  SELECT id FROM appointment_holds WHERE " + testHoldFilter +
      ")",
    ));

    await db.execute(sql.raw(
      "DELETE FROM booking_policy_acceptances " +
      "WHERE hold_id IN (" +
      "  SELECT id FROM appointment_holds WHERE " + testHoldFilter +
      ")",
    ));

    // Finally remove the root test rows.
    await db.execute(sql.raw(
      "DELETE FROM appointment_holds WHERE " + testHoldFilter,
    ));
  }

  async function seedHeldAppointmentHold(db, publicReference) {
    const [row] = await db.insert(appointmentHolds).values({
      publicReference,
      offeringId: "service-test",
      offeringSnapshot: { title: "Test Service", fullPrice: 125 },
      bookingType: "in-person-appointment",
      customerSnapshot: {
        email: "client@example.com",
        name: "Client Test",
        phone: "5555555555",
      },
      selectedStart: new Date("2026-06-21T15:00:00Z"),
      selectedEnd: new Date("2026-06-21T16:00:00Z"),
      timezone: "America/Toronto",
      status: "held",
      expiresAt: new Date("2026-06-21T14:55:00Z"),
      paymentProvider: "square",
    }).returning();

    return { id: row.id, publicReference: row.publicReference };
  }

  async function seedProviderDraftNoShowRecord(db, holdId) {
    const [row] = await db.insert(bookingNoShowChargeRecords).values({
      holdId,
      maxChargeCents: 12500,
      currency: "CAD",
      squareInvoiceId: "inv-test",
      squareOrderId: "order-test",
      status: "provider_draft_created",
      providerMetadata: { squareInvoiceVersion: 1 },
    }).returning();

    return row.id;
  }
`;

test(
  "card-on-file confirmation claim is hold-wide and row-lock safe",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-hold-claim");
        const repository = await createCardOnFileDrizzleRepository(db);
        const now = new Date("2026-06-20T12:00:00.000Z");

        const first = await repository.beginCardOnFileConfirmation({
          publicReference: hold.publicReference,
          idempotencyKey: "attempt-a",
          now,
        });
        const second = await repository.beginCardOnFileConfirmation({
          publicReference: hold.publicReference,
          idempotencyKey: "attempt-b",
          now: new Date(now.getTime() + 1_000),
        });

        assert.equal(first.status, "available");
        assert.equal(second.status, "in_progress");
      });
    `);
  },
);

test(
  "no-show charge claim publishes only one owner",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-no-show-claim");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const now = new Date("2026-06-20T12:05:00.000Z");

        const first = await repository.claimNoShowChargeAttempt({
          noShowChargeRecordId: recordId,
          idempotencyKey: "charge-a",
          amountCents: 12500,
          currency: "CAD",
          now,
        });
        const second = await repository.claimNoShowChargeAttempt({
          noShowChargeRecordId: recordId,
          idempotencyKey: "charge-b",
          amountCents: 12500,
          currency: "CAD",
          now: new Date(now.getTime() + 1_000),
        });

        assert.equal(first.isOwner, true);
        assert.equal(second.isOwner, false);
        assert.equal(second.attempt.status, "charge_pending");
      });
    `);
  },
);

test(
  "recordNoShowAdminAction is idempotent and detects missing records",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-no-show-admin-action");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const firstNow = new Date("2026-06-20T12:10:00.000Z");
        const secondNow = new Date("2026-06-20T12:11:00.000Z");

        const first = await repository.recordNoShowAdminAction({
          noShowChargeRecordId: recordId,
          operatorId: "staff-nataliea",
          reason: "Client did not attend",
          now: firstNow,
        });
        assert.equal(first.recorded, true);

        const second = await repository.recordNoShowAdminAction({
          noShowChargeRecordId: recordId,
          operatorId: "staff-other",
          reason: "Different reason",
          now: secondNow,
        });
        assert.equal(second.recorded, false);

        const [row] = await db
          .select({
            adminActionAt: bookingNoShowChargeRecords.adminActionAt,
            adminEligibilityCheckedAt: bookingNoShowChargeRecords.adminEligibilityCheckedAt,
            adminOperatorId: bookingNoShowChargeRecords.adminOperatorId,
            adminReason: bookingNoShowChargeRecords.adminReason,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.deepEqual(row.adminActionAt, firstNow);
        assert.deepEqual(row.adminEligibilityCheckedAt, firstNow);
        assert.equal(row.adminOperatorId, "staff-nataliea");
        assert.equal(row.adminReason, "Client did not attend");

        await assert.rejects(
          async () =>
            repository.recordNoShowAdminAction({
              noShowChargeRecordId: "00000000-0000-0000-0000-000000000000",
              operatorId: "staff-nataliea",
              reason: "Client did not attend",
              now: firstNow,
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("not found"));
            return true;
          },
        );
      });
    `);
  },
);

test(
  "getNoShowChargeRecordById includes updatedAt used for stale pending detection",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-no-show-updated-at");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        const record = await repository.getNoShowChargeRecordById(recordId);

        assert.ok(record !== null);
        assert.ok(record.updatedAt instanceof Date);
        assert.equal(Number.isNaN(record.updatedAt.getTime()), false);
      });
    `);
  },
);

test(
  "finalizeNoShowChargeRecord does not overwrite a terminal record",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-finalize-race");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const raceNow = new Date("2026-06-20T12:20:00.000Z");

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
        });

        // Simulate a concurrent finalization making the row terminal.
        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charged",
          squarePaymentId: "sq-payment-concurrent",
        });

        await assert.rejects(
          async () =>
            repository.finalizeNoShowChargeRecord({
              noShowChargeRecordId: recordId,
              status: "charge_failed",
              providerStatus: "FAILED",
              providerFailureReason: "Square payment status FAILED",
              event: {
                eventId: "evt-race",
                eventType: "payment.updated",
                status: "charge_failed",
                providerPaymentId: "sq-payment-concurrent",
                payloadSanitized: { note: "race simulation" },
                processedAt: raceNow,
                processingStatus: "failed",
              },
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("terminal") || error.message.includes("not found"));
            return true;
          },
        );

        const [row] = await db
          .select({
            status: bookingNoShowChargeRecords.status,
            squarePaymentId: bookingNoShowChargeRecords.squarePaymentId,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charged");
        assert.equal(row.squarePaymentId, "sq-payment-concurrent");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfNotTerminal updates non-terminal records",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-cas-update");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        const updated = await repository.updateNoShowChargeRecordIfNotTerminal({
          noShowChargeRecordId: recordId,
          status: "manual_followup",
          providerStatus: "lookup_failed",
          providerFailureReason: "Could not reconcile automatically",
        });

        assert.equal(updated.status, "manual_followup");

        const [row] = await db
          .select({
            status: bookingNoShowChargeRecords.status,
            providerStatus: bookingNoShowChargeRecords.providerStatus,
            providerFailureReason: bookingNoShowChargeRecords.providerFailureReason,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "manual_followup");
        assert.equal(row.providerStatus, "lookup_failed");
        assert.equal(row.providerFailureReason, "Could not reconcile automatically");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfNotTerminal does not overwrite terminal records",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-cas-terminal");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charged",
          squarePaymentId: "sq-payment-webhook",
        });

        await assert.rejects(
          async () =>
            repository.updateNoShowChargeRecordIfNotTerminal({
              noShowChargeRecordId: recordId,
              status: "charge_failed",
              providerStatus: "CANCELED",
              providerFailureReason: "Square invoice status CANCELED",
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("terminal") || error.message.includes("not found"));
            return true;
          },
        );

        const [row] = await db
          .select({
            status: bookingNoShowChargeRecords.status,
            squarePaymentId: bookingNoShowChargeRecords.squarePaymentId,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charged");
        assert.equal(row.squarePaymentId, "sq-payment-webhook");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfExpectedState updates only when expected state matches",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-expected-state-match");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const staleUpdatedAt = new Date("2026-06-20T12:00:00.000Z");

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "publish_pending",
          updatedAt: staleUpdatedAt,
        });

        const updated = await repository.updateNoShowChargeRecordIfExpectedState({
          noShowChargeRecordId: recordId,
          expectedStatus: "charge_pending",
          expectedProviderStatus: "publish_pending",
          expectedSquareInvoiceId: "inv-test",
          expectedUpdatedAt: staleUpdatedAt,
          status: "manual_followup",
          providerStatus: "PAID",
          providerFailureReason: "Stale PAID invoice requires manual validation",
        });

        assert.equal(updated.status, "manual_followup");

        const [row] = await db
          .select({
            status: bookingNoShowChargeRecords.status,
            providerStatus: bookingNoShowChargeRecords.providerStatus,
            providerFailureReason: bookingNoShowChargeRecords.providerFailureReason,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "manual_followup");
        assert.equal(row.providerStatus, "PAID");
        assert.equal(row.providerFailureReason, "Stale PAID invoice requires manual validation");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfExpectedState refuses when status guard fails",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-expected-state-status");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "provider_draft_created",
          providerStatus: "DRAFT",
        });

        await assert.rejects(
          async () =>
            repository.updateNoShowChargeRecordIfExpectedState({
              noShowChargeRecordId: recordId,
              expectedStatus: "charge_pending",
              expectedProviderStatus: "publish_pending",
              status: "manual_followup",
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("expected state") || error.message.includes("not found"));
            return true;
          },
        );

        const [row] = await db
          .select({ status: bookingNoShowChargeRecords.status })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "provider_draft_created");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfExpectedState refuses when providerStatus guard fails",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-expected-state-provider");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "UNPAID",
        });

        await assert.rejects(
          async () =>
            repository.updateNoShowChargeRecordIfExpectedState({
              noShowChargeRecordId: recordId,
              expectedStatus: "charge_pending",
              expectedProviderStatus: "publish_pending",
              status: "manual_followup",
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("expected state") || error.message.includes("not found"));
            return true;
          },
        );

        const [row] = await db
          .select({ status: bookingNoShowChargeRecords.status, providerStatus: bookingNoShowChargeRecords.providerStatus })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charge_pending");
        assert.equal(row.providerStatus, "UNPAID");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfExpectedState refuses when squareInvoiceId guard fails",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-expected-state-invoice");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "publish_pending",
        });

        await assert.rejects(
          async () =>
            repository.updateNoShowChargeRecordIfExpectedState({
              noShowChargeRecordId: recordId,
              expectedStatus: "charge_pending",
              expectedProviderStatus: "publish_pending",
              expectedSquareInvoiceId: "different-invoice",
              status: "manual_followup",
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("expected state") || error.message.includes("not found"));
            return true;
          },
        );

        const [row] = await db
          .select({ status: bookingNoShowChargeRecords.status })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charge_pending");
      });
    `);
  },
);

test(
  "updateNoShowChargeRecordIfExpectedState refuses when updatedAt guard fails",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-expected-state-updated-at");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "publish_pending",
          updatedAt: new Date("2026-06-20T12:00:00.000Z"),
        });

        await assert.rejects(
          async () =>
            repository.updateNoShowChargeRecordIfExpectedState({
              noShowChargeRecordId: recordId,
              expectedStatus: "charge_pending",
              expectedProviderStatus: "publish_pending",
              expectedUpdatedAt: new Date("2026-06-20T11:00:00.000Z"),
              status: "manual_followup",
            }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes("expected state") || error.message.includes("not found"));
            return true;
          },
        );

        const [row] = await db
          .select({ status: bookingNoShowChargeRecords.status })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charge_pending");
      });
    `);
  },
);

test(
  "recoverStaleNoShowChargePending reclaims only when invoice id and updatedAt match",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-recover-stale-match");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const staleUpdatedAt = new Date("2026-06-20T11:00:00.000Z");
        const now = new Date("2026-06-20T12:00:00.000Z");

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "publish_pending",
          updatedAt: staleUpdatedAt,
        });

        const recovered = await repository.recoverStaleNoShowChargePending({
          noShowChargeRecordId: recordId,
          now,
          expectedSquareInvoiceId: "inv-test",
          expectedUpdatedAt: staleUpdatedAt,
        });

        assert.ok(recovered !== null);
        assert.equal(recovered.status, "provider_draft_created");
        assert.equal(recovered.providerStatus, "DRAFT");

        const [row] = await db
          .select({
            status: bookingNoShowChargeRecords.status,
            providerStatus: bookingNoShowChargeRecords.providerStatus,
            updatedAt: bookingNoShowChargeRecords.updatedAt,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "provider_draft_created");
        assert.equal(row.providerStatus, "DRAFT");
        assert.deepEqual(row.updatedAt, now);
      });
    `);
  },
);

test(
  "recoverStaleNoShowChargePending refuses when squareInvoiceId changed since read",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-recover-stale-invoice");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const staleUpdatedAt = new Date("2026-06-20T11:00:00.000Z");
        const now = new Date("2026-06-20T12:00:00.000Z");

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "publish_pending",
          squareInvoiceId: "inv-changed",
          updatedAt: staleUpdatedAt,
        });

        const recovered = await repository.recoverStaleNoShowChargePending({
          noShowChargeRecordId: recordId,
          now,
          expectedSquareInvoiceId: "inv-test",
          expectedUpdatedAt: staleUpdatedAt,
        });

        assert.equal(recovered, null);

        const [row] = await db
          .select({ status: bookingNoShowChargeRecords.status })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charge_pending");
      });
    `);
  },
);

test(
  "recoverStaleNoShowChargePending refuses when updatedAt changed since read",
  { skip: dbTestSkipReason },
  () => {
    runDbScenario(`
      await withTestDb(async (db) => {
        await resetCardOnFileTables(db);
        const hold = await seedHeldAppointmentHold(db, "lh-test-recover-stale-updated-at");
        const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
        const repository = await createCardOnFileDrizzleRepository(db);
        const staleUpdatedAt = new Date("2026-06-20T11:00:00.000Z");
        const now = new Date("2026-06-20T12:00:00.000Z");

        await repository.updateNoShowChargeRecord({
          noShowChargeRecordId: recordId,
          status: "charge_pending",
          providerStatus: "publish_pending",
          updatedAt: new Date("2026-06-20T11:30:00.000Z"),
        });

        const recovered = await repository.recoverStaleNoShowChargePending({
          noShowChargeRecordId: recordId,
          now,
          expectedSquareInvoiceId: "inv-test",
          expectedUpdatedAt: staleUpdatedAt,
        });

        assert.equal(recovered, null);

        const [row] = await db
          .select({ status: bookingNoShowChargeRecords.status })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, recordId))
          .limit(1);

        assert.equal(row.status, "charge_pending");
      });
    `);
  },
);

function runDbScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})();`;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    },
  );
}
