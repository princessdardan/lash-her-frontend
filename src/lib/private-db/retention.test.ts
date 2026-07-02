import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createPrivateDataRetentionCleanup,
    getPrivateDataRetentionCutoffs,
    getSoftDeletedCheckoutOrderPurgePredicate,
    getTerminalAppointmentHoldDeletePredicate,
    getTerminalAppointmentHoldRedactionPredicate,
    getTerminalAppointmentHoldRedactionValues,
    PRIVATE_DATA_RETENTION_TABLE_WINDOWS,
    PRIVATE_DATA_RETENTION_WINDOWS,
  } from "./src/lib/private-db/retention.ts";
  import { PgDialect } from "drizzle-orm/pg-core";
  import {
    appointmentHoldStatus,
    calendarFinalizationStatus,
    trainingEnrollmentSchedulingStatus,
  } from "./src/lib/private-db/schema.ts";

  function createRepository(overrides = {}) {
    const calls = [];
    const counts = {
      deleteAbandonedAppointmentHolds: 1,
      deleteCheckoutPaymentEvents: 2,
      deleteMarketingConsentEvents: 3,
      deleteNonConsentingMarketingSubmissions: 4,
      deleteTerminalAppointmentHolds: 5,
      deleteTerminalMarketingContactSyncJobs: 6,
      deleteTerminalTrainingEnrollments: 7,
      deleteUnsubscribedMarketingContacts: 8,
      expireTrainingSchedulingTokens: 9,
      purgeSoftDeletedCheckoutOrders: 10,
      redactCheckoutOrders: 11,
      redactConsentingMarketingSubmissions: 12,
      redactInactiveMarketingContacts: 13,
      redactMarketingContactSyncJobPayloads: 14,
      redactTerminalAppointmentHolds: 15,
      redactTerminalTrainingEnrollments: 16,
      scrubCheckoutPaymentEventPayloads: 17,
      softDeleteCheckoutOrders: 18,
      ...overrides,
    };

    function operation(name) {
      return async (input) => {
        calls.push({ cutoff: input.cutoff.toISOString(), name, now: input.now.toISOString() });
        return counts[name];
      };
    }

    return {
      calls,
      repository: {
        deleteAbandonedAppointmentHolds: operation("deleteAbandonedAppointmentHolds"),
        deleteCheckoutPaymentEvents: operation("deleteCheckoutPaymentEvents"),
        deleteMarketingConsentEvents: operation("deleteMarketingConsentEvents"),
        deleteNonConsentingMarketingSubmissions: operation("deleteNonConsentingMarketingSubmissions"),
        deleteTerminalAppointmentHolds: operation("deleteTerminalAppointmentHolds"),
        deleteTerminalMarketingContactSyncJobs: operation("deleteTerminalMarketingContactSyncJobs"),
        deleteTerminalTrainingEnrollments: operation("deleteTerminalTrainingEnrollments"),
        deleteUnsubscribedMarketingContacts: operation("deleteUnsubscribedMarketingContacts"),
        expireTrainingSchedulingTokens: operation("expireTrainingSchedulingTokens"),
        purgeSoftDeletedCheckoutOrders: operation("purgeSoftDeletedCheckoutOrders"),
        redactCheckoutOrders: operation("redactCheckoutOrders"),
        redactConsentingMarketingSubmissions: operation("redactConsentingMarketingSubmissions"),
        redactInactiveMarketingContacts: operation("redactInactiveMarketingContacts"),
        redactMarketingContactSyncJobPayloads: operation("redactMarketingContactSyncJobPayloads"),
        redactTerminalAppointmentHolds: operation("redactTerminalAppointmentHolds"),
        redactTerminalTrainingEnrollments: operation("redactTerminalTrainingEnrollments"),
        scrubCheckoutPaymentEventPayloads: operation("scrubCheckoutPaymentEventPayloads"),
        softDeleteCheckoutOrders: operation("softDeleteCheckoutOrders"),
      },
    };
  }
`;

test("private data retention windows define every scheduled table action", () => {
  runRetentionScenario(`
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.redactAfterDays, 395);
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.softDeleteAfterDays, 2555);
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.checkoutPaymentEvents.scrubPayloadAfterDays, 90);
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.deleteAbandonedAfterDays, 30);
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.expireSchedulingTokensAfterDays, 0);
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSubmissions.deleteNonConsentingAfterDays, 180);

    const tables = new Set(PRIVATE_DATA_RETENTION_TABLE_WINDOWS.map((window) => window.table));
    assert.deepEqual([...tables].sort(), [
      "appointment_holds",
      "checkout_orders",
      "checkout_payment_events",
      "marketing_consent_events",
      "marketing_contact_submissions",
      "marketing_contact_sync_jobs",
      "marketing_contacts",
      "training_enrollments",
    ]);
  `);
});

test("private data retention preserves unresolved follow-up states", () => {
  runRetentionScenario(`
    assert.ok(appointmentHoldStatus.enumValues.includes("manual_followup"));
    assert.ok(appointmentHoldStatus.enumValues.includes("paid_unbookable_rebooking_pending"));
    assert.ok(appointmentHoldStatus.enumValues.includes("refund_required"));
    assert.ok(calendarFinalizationStatus.enumValues.includes("paid_calendar_pending"));
    assert.ok(calendarFinalizationStatus.enumValues.includes("paid_unbookable_rebooking_pending"));
    assert.ok(calendarFinalizationStatus.enumValues.includes("refund_required"));
    assert.ok(calendarFinalizationStatus.enumValues.includes("manual_review"));
    assert.ok(trainingEnrollmentSchedulingStatus.enumValues.includes("manual_followup"));

    const documentationText = PRIVATE_DATA_RETENTION_TABLE_WINDOWS
      .map((window) => window.action)
      .join(" ");
    assert.equal(documentationText.includes("manual_followup"), false);
  `);
});

test("private data retention cutoffs subtract configured UTC windows", () => {
  runRetentionScenario(`
    const cutoffs = getPrivateDataRetentionCutoffs(new Date("2026-05-28T12:00:00.000Z"));

    assert.equal(cutoffs.trainingTokenExpiryCutoff.toISOString(), "2026-05-28T12:00:00.000Z");
    assert.equal(cutoffs.appointmentHoldAbandonedDeleteCutoff.toISOString(), "2026-04-28T12:00:00.000Z");
    assert.equal(cutoffs.paymentEventPayloadScrubCutoff.toISOString(), "2026-02-27T12:00:00.000Z");
    assert.equal(cutoffs.marketingSubmissionNonConsentingDeleteCutoff.toISOString(), "2025-11-29T12:00:00.000Z");
    assert.equal(cutoffs.marketingContactSyncJobRedactCutoff.toISOString(), "2025-04-28T12:00:00.000Z");
    assert.equal(cutoffs.marketingContactSyncJobDeleteCutoff.toISOString(), "2019-05-30T12:00:00.000Z");
    assert.equal(cutoffs.checkoutOrderRedactCutoff.toISOString(), "2025-04-28T12:00:00.000Z");
    assert.equal(cutoffs.checkoutOrderSoftDeleteCutoff.toISOString(), "2019-05-30T12:00:00.000Z");
  `);
});

test("private data retention cleanup runs in dependency-safe order", () => {
  runRetentionScenario(`
    const now = new Date("2026-05-28T12:00:00.000Z");
    const { calls, repository } = createRepository();
    const summary = await createPrivateDataRetentionCleanup(repository)({ now });

    assert.deepEqual(calls.map((call) => call.name), [
      "expireTrainingSchedulingTokens",
      "deleteAbandonedAppointmentHolds",
      "redactTerminalAppointmentHolds",
      "redactCheckoutOrders",
      "softDeleteCheckoutOrders",
      "scrubCheckoutPaymentEventPayloads",
      "deleteCheckoutPaymentEvents",
      "redactTerminalTrainingEnrollments",
      "deleteTerminalTrainingEnrollments",
      "deleteTerminalAppointmentHolds",
      "purgeSoftDeletedCheckoutOrders",
      "deleteNonConsentingMarketingSubmissions",
      "redactConsentingMarketingSubmissions",
      "redactMarketingContactSyncJobPayloads",
      "redactInactiveMarketingContacts",
      "deleteMarketingConsentEvents",
      "deleteUnsubscribedMarketingContacts",
      "deleteTerminalMarketingContactSyncJobs",
    ]);
    assert.equal(summary.runAt, "2026-05-28T12:00:00.000Z");
    assert.equal(summary.totalAffected, 171);
    assert.equal(summary.operations.length, 18);
    assert.deepEqual(summary.operations[0], {
      count: 9,
      cutoff: "2026-05-28T12:00:00.000Z",
      operation: "trainingSchedulingTokensExpired",
      table: "training_enrollments",
    });
    assert.deepEqual(summary.operations.at(-1), {
      count: 6,
      cutoff: "2019-05-30T12:00:00.000Z",
      operation: "marketingContactSyncJobsDeleted",
      table: "marketing_contact_sync_jobs",
    });
  `);
});

test("private data retention checkout purge preserves unresolved linked records", () => {
  runRetentionScenario(`
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(
      getSoftDeletedCheckoutOrderPurgePredicate(
        new Date("2026-04-28T12:00:00.000Z"),
        new Date("2024-05-28T12:00:00.000Z"),
        new Date("2019-05-30T12:00:00.000Z"),
        new Date("2024-05-28T12:00:00.000Z"),
      ),
    );
    const normalizedParams = query.params.map((param) => param instanceof Date ? param.toISOString() : param);

    assert.equal(query.sql.includes('"checkout_orders"."deleted_at" is not null'), true);
    assert.equal(query.sql.includes('"checkout_orders"."deleted_at" <= $1'), true);
    assert.equal(query.sql.includes('"checkout_orders"."calendar_finalization_status" in'), true);
    assert.equal(query.sql.includes('not exists'), true);
    assert.equal(query.sql.includes('from "checkout_payment_events"'), true);
    assert.equal(
      query.sql.includes('"checkout_payment_events"."order_id" = "checkout_orders"."id"'),
      true,
    );
    assert.equal(query.sql.includes('"checkout_payment_events"."created_at" >'), true);
    assert.equal(query.sql.includes('from "training_enrollments"'), true);
    assert.equal(
      query.sql.includes('"training_enrollments"."checkout_order_id" = "checkout_orders"."id"'),
      true,
    );
    assert.equal(
      query.sql.includes('"training_enrollments"."scheduling_status" not in'),
      true,
    );
    assert.equal(
      query.sql.includes('coalesce("training_enrollments"."scheduled_at", "training_enrollments"."token_used_at", "training_enrollments"."token_expires_at", "training_enrollments"."updated_at", "training_enrollments"."created_at") >'),
      true,
    );
    assert.equal(query.sql.includes('from "appointment_holds"'), true);
    assert.equal(
      query.sql.includes('"appointment_holds"."checkout_order_id" = "checkout_orders"."id"'),
      true,
    );
    assert.equal(query.sql.includes('"appointment_holds"."status" not in'), true);
    assert.equal(query.sql.includes('"appointment_holds"."finalization_status" not in'), true);
    assert.equal(
      query.sql.includes('coalesce("appointment_holds"."booked_at", "appointment_holds"."released_at", "appointment_holds"."expired_at", "appointment_holds"."payment_failed_at", "appointment_holds"."booking_failed_at", "appointment_holds"."manual_followup_at", "appointment_holds"."paid_at", "appointment_holds"."updated_at", "appointment_holds"."created_at") >'),
      true,
    );
    for (const expectedParam of [
      "2026-04-28T12:00:00.000Z",
      "2024-05-28T12:00:00.000Z",
      "2019-05-30T12:00:00.000Z",
      "not_required",
      "booked",
      "manual_rebooked",
      "refunded",
      "failed",
      "expired",
      "scheduled",
      "booking_failed",
      "payment_failed",
      "released",
    ]) {
      assert.equal(normalizedParams.includes(expectedParam), true);
    }
  `);
});

test("private data retention deletes only resolved terminal appointment holds", () => {
  runRetentionScenario(`
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(
      getTerminalAppointmentHoldDeletePredicate(new Date("2024-05-28T12:00:00.000Z")),
    );
    const normalizedParams = query.params.map((param) => param instanceof Date ? param.toISOString() : param);

    assert.equal(query.sql.includes('"appointment_holds"."status" in'), true);
    assert.equal(query.sql.includes('"appointment_holds"."finalization_status" in'), true);
    assert.equal(
      query.sql.includes('coalesce("appointment_holds"."booked_at", "appointment_holds"."released_at", "appointment_holds"."expired_at", "appointment_holds"."payment_failed_at", "appointment_holds"."booking_failed_at", "appointment_holds"."manual_followup_at", "appointment_holds"."paid_at", "appointment_holds"."updated_at", "appointment_holds"."created_at") <='),
      true,
    );
    for (const expectedParam of [
      "booked",
      "booking_failed",
      "expired",
      "manual_rebooked",
      "payment_failed",
      "refunded",
      "released",
      "not_required",
      "manual_rebooked",
      "2024-05-28T12:00:00.000Z",
    ]) {
      assert.equal(normalizedParams.includes(expectedParam), true);
    }
    for (const unresolvedParam of [
      "pending",
      "paid_calendar_pending",
      "paid_unbookable_rebooking_pending",
      "refund_required",
      "manual_review",
      "manual_followup",
    ]) {
      assert.equal(normalizedParams.includes(unresolvedParam), false);
    }
  `);
});

test("private data retention redacts only resolved terminal appointment holds", () => {
  runRetentionScenario(`
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(
      getTerminalAppointmentHoldRedactionPredicate(new Date("2025-11-29T12:00:00.000Z")),
    );
    const normalizedParams = query.params.map((param) => param instanceof Date ? param.toISOString() : param);

    assert.equal(query.sql.includes('"appointment_holds"."status" in'), true);
    assert.equal(query.sql.includes('"appointment_holds"."finalization_status" in'), true);
    assert.equal(query.sql.includes("customer_snapshot"), true);
    assert.equal(query.sql.includes("email"), true);
    assert.equal(
      query.sql.includes('coalesce("appointment_holds"."booked_at", "appointment_holds"."released_at", "appointment_holds"."expired_at", "appointment_holds"."payment_failed_at", "appointment_holds"."booking_failed_at", "appointment_holds"."manual_followup_at", "appointment_holds"."paid_at", "appointment_holds"."updated_at", "appointment_holds"."created_at") <='),
      true,
    );
    for (const expectedParam of [
      "booked",
      "booking_failed",
      "expired",
      "manual_rebooked",
      "payment_failed",
      "refunded",
      "released",
      "not_required",
      "manual_rebooked",
      "[redacted]",
      "2025-11-29T12:00:00.000Z",
    ]) {
      assert.equal(normalizedParams.includes(expectedParam), true);
    }
    for (const unresolvedParam of [
      "pending",
      "paid_calendar_pending",
      "paid_unbookable_rebooking_pending",
      "refund_required",
      "manual_review",
      "manual_followup",
    ]) {
      assert.equal(normalizedParams.includes(unresolvedParam), false);
    }
  `);
});

test("private data retention redacts appointment email retry state", () => {
  runRetentionScenario(`
    const now = new Date("2026-05-28T12:00:00.000Z");
    const redactionValues = getTerminalAppointmentHoldRedactionValues(now);

    assert.deepEqual(redactionValues.customerSnapshot, {
      email: "[redacted]",
      name: "[redacted]",
      phone: "[redacted]",
    });
    assert.equal(redactionValues.bookingConfirmationEmailClaimedUntil, null);
    assert.equal(redactionValues.bookingConfirmationEmailLastError, null);
    assert.equal(redactionValues.failureMetadata, null);
    assert.equal(redactionValues.failureReason, null);
    assert.equal(redactionValues.finalizationReason, null);
    assert.equal(redactionValues.manualReviewReason, null);
    assert.equal(redactionValues.reconciliationMetadata, null);
    assert.equal(redactionValues.squarePaymentLinkUrl, null);
    assert.equal(redactionValues.updatedAt, now);
  `);
});

test("private data retention redacts and eventually deletes marketing contact sync jobs", () => {
  runRetentionScenario(`
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSyncJobs.redactPayloadAfterDays, 395);
    assert.equal(PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSyncJobs.deleteTerminalAfterDays, 2555);

    const syncJobWindows = PRIVATE_DATA_RETENTION_TABLE_WINDOWS.filter(
      (window) => window.table === "marketing_contact_sync_jobs"
    );
    assert.equal(syncJobWindows.length, 2);
    assert.equal(syncJobWindows[0].action, "redact payload and last error context");
    assert.equal(syncJobWindows[0].windowDays, 395);
    assert.equal(syncJobWindows[1].action, "delete terminal sync jobs");
    assert.equal(syncJobWindows[1].windowDays, 2555);
  `);
});

function runRetentionScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
