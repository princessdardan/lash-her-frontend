import { execFileSync } from "node:child_process";
import { config } from "dotenv";
import test from "node:test";

config({ path: [".env.local", ".env"] });

const dbTestUrl = process.env.TEST_DATABASE_URL;
const dbTestSkipReason = dbTestUrl
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed repository tests";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    createServiceReconciliationMonitor,
    type ServiceReconciliationFinding,
    type ServiceReconciliationRepository,
  } from "./src/lib/booking/payments/service-reconciliation-monitor.ts";

  function createFakeRepository(overrides = {}) {
    return {
      findAmountCurrencyCustomerMismatches: async () => [],
      findBookedAppointmentsWithoutNoShowChargeRecord: async () => [],
      findBookedAppointmentsWithoutPolicyAcceptance: async () => [],
      findBookedAppointmentsWithoutSavedPaymentMethod: async () => [],
      findConfirmedBookingsWithoutNoShowInvoice: async () => [],
      findFailedNoShowCharges: async () => [],
      findNoShowChargeFailedNotAlerted: async () => [],
      findNoShowChargesPendingTooLong: async () => [],
      findPaidBookingsNotBooked: async () => [],
      findSquareInvoicePaymentEventsNotReconciled: async () => [],
      findSquarePaymentsPendingTooLong: async () => [],
      ...overrides,
    };
  }

  function createMonitor(overrides = {}) {
    return createServiceReconciliationMonitor({
      repository: createFakeRepository(overrides),
    });
  }
`;

test("reconciliation monitor returns ok when repository finds no issues", () => {
  runMonitorScenario(`
    const monitor = createMonitor();
    const summary = await monitor.run({ now: new Date("2026-06-19T12:00:00.000Z") });

    assert.equal(summary.ok, true);
    assert.deepEqual(summary.findings, []);
    assert.equal(summary.checkedAt, "2026-06-19T12:00:00.000Z");
  `);
});

test("reconciliation monitor surfaces confirmed booking without no-show invoice", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findConfirmedBookingsWithoutNoShowInvoice: async () => [{ holdId: "hold-2" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "confirmed_booking_without_no_show_invoice",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-2");
    assert.equal(finding.severity, "warning");
  `);
});

test("reconciliation monitor surfaces square payment pending too long", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findSquarePaymentsPendingTooLong: async () => [{ holdId: "hold-3", orderId: "order-3" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "square_payment_pending_too_long",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-3");
    assert.equal(finding.orderId, "order-3");
    assert.equal(finding.severity, "error");
  `);
});

test("reconciliation monitor surfaces paid booking not booked", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findPaidBookingsNotBooked: async () => [{ holdId: "hold-4", orderId: "order-4" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "paid_booking_not_booked",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-4");
    assert.equal(finding.orderId, "order-4");
    assert.equal(finding.severity, "error");
  `);
});

test("reconciliation monitor surfaces failed no-show charge", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findFailedNoShowCharges: async () => [{ holdId: "hold-5", orderId: "order-5" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "failed_no_show_charge",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-5");
    assert.equal(finding.orderId, "order-5");
    assert.equal(finding.severity, "error");
  `);
});

test("reconciliation monitor surfaces booked appointment without saved payment method", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findBookedAppointmentsWithoutSavedPaymentMethod: async () => [{ holdId: "hold-6" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "booked_without_saved_payment_method",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-6");
    assert.equal(finding.severity, "warning");
  `);
});

test("reconciliation monitor surfaces booked appointment without policy acceptance", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findBookedAppointmentsWithoutPolicyAcceptance: async () => [{ holdId: "hold-7" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "booked_without_policy_acceptance",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-7");
    assert.equal(finding.severity, "warning");
  `);
});

test("reconciliation monitor surfaces booked appointment without no-show charge record", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findBookedAppointmentsWithoutNoShowChargeRecord: async () => [{ holdId: "hold-8" }],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "booked_without_no_show_charge_record",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-8");
    assert.equal(finding.severity, "warning");
  `);
});

test("reconciliation monitor surfaces no-show charge failed not alerted", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findNoShowChargeFailedNotAlerted: async () => [
        { holdId: "hold-9", noShowChargeRecordId: "nsr-1", status: "charge_failed" },
      ],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "no_show_charge_failed_not_alerted",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-9");
    assert.equal(finding.noShowChargeRecordId, "nsr-1");
    assert.equal(finding.status, "charge_failed");
    assert.equal(finding.severity, "error");
  `);
});

test("reconciliation monitor surfaces Square invoice/payment event not reconciled locally", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findSquareInvoicePaymentEventsNotReconciled: async () => [
        { eventId: "evt-1", noShowChargeRecordId: "nsr-2", processingStatus: "received" },
      ],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "square_invoice_payment_event_not_reconciled",
    );

    assert.ok(finding);
    assert.equal(finding.eventId, "evt-1");
    assert.equal(finding.noShowChargeRecordId, "nsr-2");
    assert.equal(finding.processingStatus, "received");
    assert.equal(finding.severity, "warning");
  `);
});

test("reconciliation monitor surfaces amount/currency/customer mismatch", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findAmountCurrencyCustomerMismatches: async () => [
        {
          holdId: "hold-10",
          mismatchType: "amount_currency",
          noShowChargeRecordId: "nsr-3",
          policyAcceptanceId: "pa-1",
          savedPaymentMethodId: "spm-1",
        },
      ],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "payment_amount_currency_customer_mismatch",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-10");
    assert.equal(finding.noShowChargeRecordId, "nsr-3");
    assert.equal(finding.savedPaymentMethodId, "spm-1");
    assert.equal(finding.policyAcceptanceId, "pa-1");
    assert.equal(finding.mismatchType, "amount_currency");
    assert.equal(finding.severity, "error");
  `);
});

test("reconciliation does not flag legacy booked holds without card-on-file markers", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findBookedAppointmentsWithoutSavedPaymentMethod: async () => [],
      findBookedAppointmentsWithoutPolicyAcceptance: async () => [],
      findBookedAppointmentsWithoutNoShowChargeRecord: async () => [],
      findConfirmedBookingsWithoutNoShowInvoice: async () => [],
      findFailedNoShowCharges: async () => [],
    });

    const summary = await monitor.run({ now: new Date("2026-06-20T12:00:00Z") });

    assert.equal(summary.ok, true);
    assert.deepEqual(summary.findings, []);
  `);
});

test("reconciliation monitor surfaces no-show charge pending too long", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findNoShowChargesPendingTooLong: async () => [
        { holdId: "hold-pending", noShowChargeRecordId: "nsr-pending", status: "charge_pending" },
      ],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "no_show_charge_pending_too_long",
    );

    assert.ok(finding);
    assert.equal(finding.holdId, "hold-pending");
    assert.equal(finding.noShowChargeRecordId, "nsr-pending");
    assert.equal(finding.status, "charge_pending");
    assert.equal(finding.severity, "error");
  `);
});

test("reconciliation monitor findings do not include raw customer PII or card details", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findBookedAppointmentsWithoutSavedPaymentMethod: async () => [
        { holdId: "hold-6", customerEmail: "client@example.com", cardLast4: "4242" },
      ],
    });

    const summary = await monitor.run({ now: new Date() });
    const finding = summary.findings.find(
      (f) => f.category === "booked_without_saved_payment_method",
    );

    assert.ok(finding);
    assert.equal("customerEmail" in finding, false);
    assert.equal("cardLast4" in finding, false);
  `);
});

test("reconciliation monitor is not ok when any finding is present", () => {
  runMonitorScenario(`
    const monitor = createMonitor({
      findPaidBookingsNotBooked: async () => [{ holdId: "hold-bad" }],
    });

    const summary = await monitor.run({ now: new Date() });

    assert.equal(summary.ok, false);
    assert.equal(summary.findings.length, 1);
  `);
});

test("reconciliation monitor defaults now to current date", () => {
  runMonitorScenario(`
    const before = new Date();
    const monitor = createMonitor();
    const summary = await monitor.run();
    const checkedAt = new Date(summary.checkedAt);
    const after = new Date();

    assert.ok(checkedAt >= before);
    assert.ok(checkedAt <= after);
  `);
});

const repositoryHelperScript = String.raw`
  import assert from "node:assert/strict";
  import { drizzle } from "drizzle-orm/node-postgres";
  import { eq } from "drizzle-orm";
  import { Pool } from "pg";
  import { nanoid } from "nanoid";

  import { createDrizzleServiceReconciliationRepository } from "./src/lib/booking/payments/service-reconciliation-monitor.ts";
  import { createPrivateDbPoolConfig } from "./src/lib/private-db/pool-config.ts";
  import {
    appointmentHolds,
    bookingNoShowChargeRecords,
    checkoutOrders,
    checkoutPaymentEvents,
  } from "./src/lib/private-db/schema.ts";

  function createTestDb() {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return null;
    const pool = new Pool(createPrivateDbPoolConfig(url));
    const db = drizzle({
      client: pool,
      schema: {
        appointmentHolds,
        bookingNoShowChargeRecords,
        checkoutPaymentEvents,
      },
    });
    return { db, pool };
  }

  async function withRollback(fn) {
    const { db, pool } = createTestDb();
    if (!db) throw new Error("TEST_DATABASE_URL not configured");
    let captured = null;
    let error = null;
    try {
      await db.transaction(async (tx) => {
        try {
          captured = await fn(tx);
        } catch (e) {
          error = e;
        }
        throw new Error("INTENTIONAL_ROLLBACK");
      });
    } catch (e) {
      if (e.message !== "INTENTIONAL_ROLLBACK") {
        error = error ?? e;
      }
    } finally {
      await pool.end();
    }
    if (error) throw error;
    return captured;
  }

  function futureDate() {
    return new Date(Date.now() + 60 * 60 * 1000);
  }

  async function createHold(tx, overrides = {}) {
    const [row] = await tx.insert(appointmentHolds).values({
      publicReference: "hold-" + nanoid(),
      offeringId: "offering-test",
      offeringSnapshot: {},
      bookingType: "appointment",
      customerSnapshot: {},
      selectedStart: new Date(),
      selectedEnd: new Date(),
      timezone: "America/Toronto",
      status: "booked",
      expiresAt: futureDate(),
      paymentProvider: "square",
      ...overrides,
    }).returning();
    return row;
  }

  async function createNoShowChargeRecord(tx, holdId, overrides = {}) {
    const [row] = await tx.insert(bookingNoShowChargeRecords).values({
      holdId,
      maxChargeCents: 10000,
      currency: "CAD",
      status: "draft",
      ...overrides,
    }).returning();
    return row;
  }

  async function createCheckoutPaymentEvent(tx, overrides = {}) {
    const [row] = await tx.insert(checkoutPaymentEvents).values({
      eventType: "invoice.payment_made",
      paymentProvider: "square",
      processingStatus: "received",
      ...overrides,
    }).returning();
    return row;
  }

  async function createCheckoutOrder(tx, overrides = {}) {
    const [row] = await tx.insert(checkoutOrders).values({
      orderId: "order-" + nanoid(),
      checkoutTokenHash: "token-" + nanoid(),
      secretTokenCiphertext: "secret-" + nanoid(),
      customerName: "Test Customer",
      customerEmail: "test@example.com",
      amountCents: 10000,
      lineItems: [],
      purpose: "appointment_deposit",
      status: "paid",
      calendarFinalizationStatus: "pending",
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
      paymentProvider: "square",
      ...overrides,
    }).returning();
    return row;
  }
`;

test(
  "repository excludes handled Square payment event statuses from unreconciled findings",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      const hold = await createHold(tx);
      const record = await createNoShowChargeRecord(tx, hold.id);

      await createCheckoutPaymentEvent(tx, {
        noShowChargeRecordId: record.id,
        paymentProvider: "square",
        processingStatus: "received",
      });
      await createCheckoutPaymentEvent(tx, {
        noShowChargeRecordId: record.id,
        paymentProvider: "square",
        processingStatus: "ignored",
      });
      await createCheckoutPaymentEvent(tx, {
        noShowChargeRecordId: record.id,
        paymentProvider: "square",
        processingStatus: "failed",
      });
      await createCheckoutPaymentEvent(tx, {
        noShowChargeRecordId: record.id,
        paymentProvider: "square",
        processingStatus: "processed",
      });
      await createCheckoutPaymentEvent(tx, {
        noShowChargeRecordId: record.id,
        paymentProvider: "square",
        processingStatus: "duplicate",
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findSquareInvoicePaymentEventsNotReconciled(new Date());
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].processingStatus, "received");
  `);
  },
);

test(
  "repository excludes webhook-driven charge_failed with providerFailureReason or handled event from not-alerted",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, expectedRecordId } = await withRollback(async (tx) => {
      const stale = new Date(Date.now() - 6 * 60 * 1000);

      const holdWithReason = await createHold(tx);
      await createNoShowChargeRecord(tx, holdWithReason.id, {
        status: "charge_failed",
        providerFailureReason: "card_declined",
        updatedAt: stale,
      });

      const holdWithEvent = await createHold(tx);
      const recordWithEvent = await createNoShowChargeRecord(tx, holdWithEvent.id, {
        status: "charge_failed",
        updatedAt: stale,
      });
      await createCheckoutPaymentEvent(tx, {
        noShowChargeRecordId: recordWithEvent.id,
        paymentProvider: "square",
        processingStatus: "processed",
      });

      const holdStale = await createHold(tx);
      const recordStale = await createNoShowChargeRecord(tx, holdStale.id, {
        status: "charge_failed",
        updatedAt: stale,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findNoShowChargeFailedNotAlerted(new Date());
      return { findings, expectedRecordId: recordStale.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].noShowChargeRecordId, expectedRecordId);
  `);
  },
);

test(
  "repository detects hold linked to another hold's no-show charge record",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, holdAId, recordId } = await withRollback(async (tx) => {
      const holdA = await createHold(tx);
      const holdB = await createHold(tx);
      const recordB = await createNoShowChargeRecord(tx, holdB.id);

      await tx.update(appointmentHolds)
        .set({ noShowChargeRecordId: recordB.id })
        .where(eq(appointmentHolds.id, holdA.id));

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findAmountCurrencyCustomerMismatches(new Date());
      return { findings, holdAId: holdA.id, recordId: recordB.id };
    });

    const linkFinding = findings.find((f) => f.mismatchType === "hold_record_link");
    assert.ok(linkFinding);
    assert.equal(linkFinding.holdId, holdAId);
    assert.equal(linkFinding.noShowChargeRecordId, recordId);
  `);
  },
);

test(
  "repository findConfirmedBookingsWithoutNoShowInvoice flags booked Square card-on-file holds whose no-show charge record lacks a Square invoice",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, holdId } = await withRollback(async (tx) => {
      const hold = await createHold(tx, {
        cardOnFileStatus: "intake_complete",
        noShowChargeRecordId: null,
      });
      const record = await createNoShowChargeRecord(tx, hold.id, {
        squareInvoiceId: null,
      });
      await tx.update(appointmentHolds)
        .set({ noShowChargeRecordId: record.id })
        .where(eq(appointmentHolds.id, hold.id));

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findConfirmedBookingsWithoutNoShowInvoice(new Date());
      return { findings, holdId: hold.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, holdId);
  `);
  },
);

test(
  "repository findConfirmedBookingsWithoutNoShowInvoice ignores no-show records already in manual followup",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      const hold = await createHold(tx, {
        cardOnFileStatus: "intake_complete",
      });
      const record = await createNoShowChargeRecord(tx, hold.id, {
        status: "manual_followup",
        squareInvoiceId: null,
      });
      await tx.update(appointmentHolds)
        .set({ noShowChargeRecordId: record.id })
        .where(eq(appointmentHolds.id, hold.id));

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findConfirmedBookingsWithoutNoShowInvoice(new Date());
    });

    assert.equal(findings.length, 0);
  `);
  },
);

test(
  "repository findConfirmedBookingsWithoutNoShowInvoice ignores booked Square card-on-file holds with no no-show charge record",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      await createHold(tx, {
        publicReference: "cof-no-record-" + nanoid(),
        cardOnFileStatus: "intake_complete",
        noShowChargeRecordId: null,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findConfirmedBookingsWithoutNoShowInvoice(new Date());
    });

    assert.equal(findings.length, 0);
  `);
  },
);

test(
  "repository findConfirmedBookingsWithoutNoShowInvoice ignores legacy Square payment-link booked holds without card-on-file marker",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      await createHold(tx, {
        publicReference: "legacy-square-payment-link-" + nanoid(),
        paymentProvider: "square",
        squarePaymentLinkId: "plink_" + nanoid(),
        cardOnFileStatus: null,
        noShowChargeRecordId: null,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findConfirmedBookingsWithoutNoShowInvoice(new Date());
    });

    assert.equal(findings.length, 0);
  `);
  },
);

test(
  "repository findBookedAppointmentsWithoutSavedPaymentMethod ignores legacy booked holds without card-on-file marker",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, squareHoldId } = await withRollback(async (tx) => {
      await createHold(tx, {
        publicReference: "legacy-helcim-" + nanoid(),
        paymentProvider: "helcim",
        cardOnFileStatus: null,
        savedPaymentMethodId: null,
      });
      await createHold(tx, {
        publicReference: "legacy-square-payment-link-" + nanoid(),
        paymentProvider: "square",
        squarePaymentLinkId: "plink_" + nanoid(),
        cardOnFileStatus: null,
        savedPaymentMethodId: null,
      });
      const squareHold = await createHold(tx, {
        publicReference: "cof-" + nanoid(),
        paymentProvider: "square",
        cardOnFileStatus: "intake_complete",
        savedPaymentMethodId: null,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findBookedAppointmentsWithoutSavedPaymentMethod(new Date());
      return { findings, squareHoldId: squareHold.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, squareHoldId);
  `);
  },
);

test(
  "repository findBookedAppointmentsWithoutPolicyAcceptance ignores legacy booked holds without card-on-file marker",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, squareHoldId } = await withRollback(async (tx) => {
      await createHold(tx, {
        publicReference: "legacy-helcim-" + nanoid(),
        paymentProvider: "helcim",
        cardOnFileStatus: null,
        policyAcceptanceId: null,
      });
      await createHold(tx, {
        publicReference: "legacy-square-payment-link-" + nanoid(),
        paymentProvider: "square",
        squarePaymentLinkId: "plink_" + nanoid(),
        cardOnFileStatus: null,
        policyAcceptanceId: null,
      });
      const squareHold = await createHold(tx, {
        publicReference: "cof-" + nanoid(),
        paymentProvider: "square",
        cardOnFileStatus: "intake_complete",
        policyAcceptanceId: null,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findBookedAppointmentsWithoutPolicyAcceptance(new Date());
      return { findings, squareHoldId: squareHold.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, squareHoldId);
  `);
  },
);

test(
  "repository findBookedAppointmentsWithoutNoShowChargeRecord ignores legacy booked holds without card-on-file marker",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, squareHoldId } = await withRollback(async (tx) => {
      await createHold(tx, {
        publicReference: "legacy-helcim-" + nanoid(),
        paymentProvider: "helcim",
        cardOnFileStatus: null,
        noShowChargeRecordId: null,
      });
      await createHold(tx, {
        publicReference: "legacy-square-payment-link-" + nanoid(),
        paymentProvider: "square",
        squarePaymentLinkId: "plink_" + nanoid(),
        cardOnFileStatus: null,
        noShowChargeRecordId: null,
      });
      const squareHold = await createHold(tx, {
        publicReference: "cof-" + nanoid(),
        paymentProvider: "square",
        cardOnFileStatus: "intake_complete",
        noShowChargeRecordId: null,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findBookedAppointmentsWithoutNoShowChargeRecord(new Date());
      return { findings, squareHoldId: squareHold.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, squareHoldId);
  `);
  },
);

test(
  "repository findFailedNoShowCharges returns charge_failed records but excludes stale unalerted ones",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, holdId } = await withRollback(async (tx) => {
      const stale = new Date(Date.now() - 6 * 60 * 1000);

      const holdAlertable = await createHold(tx);
      await createNoShowChargeRecord(tx, holdAlertable.id, {
        status: "charge_failed",
        squareOrderId: "order-failed-1",
        providerFailureReason: "card_declined",
      });

      const holdStaleUnalerted = await createHold(tx);
      await createNoShowChargeRecord(tx, holdStaleUnalerted.id, {
        status: "charge_failed",
        squareOrderId: "order-failed-2",
        updatedAt: stale,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findFailedNoShowCharges(new Date());
      return { findings, holdId: holdAlertable.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, holdId);
    assert.equal(findings[0].orderId, "order-failed-1");
  `);
  },
);

test(
  "repository findNoShowChargesPendingTooLong returns stale charge_pending records",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { matchingFindings, recordId, holdId } = await withRollback(async (tx) => {
      const hold = await createHold(tx);
      const stale = new Date(Date.now() - 16 * 60 * 1000);
      const record = await createNoShowChargeRecord(tx, hold.id, {
        status: "charge_pending",
        providerStatus: "publish_pending",
        updatedAt: stale,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findNoShowChargesPendingTooLong(new Date());
      return {
        matchingFindings: findings.filter((finding) => finding.noShowChargeRecordId === record.id),
        recordId: record.id,
        holdId: hold.id,
      };
    });

    assert.equal(matchingFindings.length, 1);
    assert.equal(matchingFindings[0].holdId, holdId);
    assert.equal(matchingFindings[0].noShowChargeRecordId, recordId);
    assert.equal(matchingFindings[0].status, "charge_pending");
  `);
  },
);

test(
  "repository findNoShowChargesPendingTooLong ignores fresh charge_pending records",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const matchingFindings = await withRollback(async (tx) => {
      const hold = await createHold(tx);
      const fresh = new Date(Date.now() - 5 * 60 * 1000);
      const record = await createNoShowChargeRecord(tx, hold.id, {
        status: "charge_pending",
        providerStatus: "publish_pending",
        updatedAt: fresh,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findNoShowChargesPendingTooLong(new Date());
      return findings.filter((finding) => finding.noShowChargeRecordId === record.id);
    });

    assert.equal(matchingFindings.length, 0);
  `);
  },
);

test(
  "repository findNoShowChargesPendingTooLong ignores charge_pending records not in publish_pending provider status",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const matchingFindings = await withRollback(async (tx) => {
      const hold = await createHold(tx);
      const stale = new Date(Date.now() - 16 * 60 * 1000);
      const record = await createNoShowChargeRecord(tx, hold.id, {
        status: "charge_pending",
        providerStatus: "UNPAID",
        updatedAt: stale,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findNoShowChargesPendingTooLong(new Date());
      return findings.filter((finding) => finding.noShowChargeRecordId === record.id);
    });

    assert.equal(matchingFindings.length, 0);
  `);
  },
);

test(
  "repository findSquarePaymentsPendingTooLong returns stale Square payment_pending without payment link",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, holdId } = await withRollback(async (tx) => {
      const stale = new Date(Date.now() - 40 * 60 * 1000);
      const hold = await createHold(tx, {
        publicReference: "square-cof-pending-" + nanoid(),
        status: "payment_pending",
        paymentProvider: "square",
        cardOnFileStatus: "intake_complete",
        squarePaymentLinkId: null,
        updatedAt: stale,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findSquarePaymentsPendingTooLong(new Date());
      return { findings, holdId: hold.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, holdId);
  `);
  },
);

test(
  "repository findSquarePaymentsPendingTooLong ignores legacy Square payment-link holds",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      const stale = new Date(Date.now() - 40 * 60 * 1000);
      await createHold(tx, {
        publicReference: "legacy-square-payment-link-pending-" + nanoid(),
        status: "payment_pending",
        paymentProvider: "square",
        squarePaymentLinkId: "plink_" + nanoid(),
        cardOnFileStatus: null,
        updatedAt: stale,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findSquarePaymentsPendingTooLong(new Date());
    });

    assert.equal(findings.length, 0);
  `);
  },
);

test(
  "repository findPaidBookingsNotBooked returns paid Square card-on-file appointments not booked",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const { findings, holdId } = await withRollback(async (tx) => {
      const order = await createCheckoutOrder(tx, {
        purpose: "appointment_full",
        calendarFinalizationStatus: "pending",
      });
      const hold = await createHold(tx, {
        publicReference: "square-cof-paid-" + nanoid(),
        status: "paid_pending_booking",
        paymentProvider: "square",
        cardOnFileStatus: "intake_complete",
        squarePaymentLinkId: null,
        checkoutOrderId: order.id,
        checkoutOrderPublicId: order.orderId,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      const findings = await repo.findPaidBookingsNotBooked(new Date());
      return { findings, holdId: hold.id };
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].holdId, holdId);
  `);
  },
);

test(
  "repository findPaidBookingsNotBooked ignores Helcim hosted checkout rows",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      const order = await createCheckoutOrder(tx, {
        paymentProvider: "helcim",
        purpose: "appointment_deposit",
        calendarFinalizationStatus: "pending",
      });
      await createHold(tx, {
        publicReference: "legacy-helcim-paid-" + nanoid(),
        status: "paid_pending_booking",
        paymentProvider: "helcim",
        cardOnFileStatus: null,
        checkoutOrderId: order.id,
        checkoutOrderPublicId: order.orderId,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findPaidBookingsNotBooked(new Date());
    });

    assert.equal(findings.length, 0);
  `);
  },
);

test(
  "repository findPaidBookingsNotBooked ignores Square Payment Link-era appointment rows",
  { skip: dbTestSkipReason },
  () => {
    runRepositoryScenario(`
    const findings = await withRollback(async (tx) => {
      const order = await createCheckoutOrder(tx, {
        purpose: "appointment_deposit",
        calendarFinalizationStatus: "pending",
      });
      await createHold(tx, {
        publicReference: "legacy-square-payment-link-paid-" + nanoid(),
        status: "paid_pending_booking",
        paymentProvider: "square",
        squarePaymentLinkId: "plink_" + nanoid(),
        cardOnFileStatus: null,
        checkoutOrderId: order.id,
        checkoutOrderPublicId: order.orderId,
      });

      const repo = createDrizzleServiceReconciliationRepository(tx);
      return await repo.findPaidBookingsNotBooked(new Date());
    });

    assert.equal(findings.length, 0);
  `);
  },
);

function runMonitorScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;

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

function runRepositoryScenario(assertions: string): void {
  const scenario = `${repositoryHelperScript}\nvoid (async () => {\n${assertions}\n})()`;

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
