import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import { createCardOnFileDrizzleRepository } from "@/lib/private-db/card-on-file-repository";
import {
  appointmentHolds,
  appointments,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  bookingProviders,
  bookingResources,
  bookingServices,
  bookingServiceOfferings,
  checkoutOrders,
  squarePaymentRefundEvents,
} from "@/lib/private-db/schema";
import * as schema from "@/lib/private-db/schema";

import {
  queryCompletedSquareRefunds,
  queryCompletedSquareRefundsForPayments,
  queryEmployeeDirectAttribution,
  queryEmployeeLegacyAttribution,
  queryEmployeeNoShowAttribution,
} from "./employee-attribution-query";
import { getEmployeeAttributionAnalyticsForRange } from "./employee-attribution-analytics";

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
  "no-show attribution keeps historical gross and uses actual terminal attempts without requiring appointments",
  { skip: skipReason },
  async () => {
    const first = await seedChargedRecord("with-attempt");
    const second = await seedChargedRecord("historical-without-attempt");
    const voided = await seedChargedRecord("voided");
    const refunded = await seedChargedRecord("refunded");
    const withoutAppointment = await seedChargedRecord("without-appointment");
    const processedAt = new Date("2035-01-10T15:00:00.000Z");

    await requireDb()
      .update(bookingNoShowChargeRecords)
      .set({
        status: "voided",
        voidedAt: new Date("2035-01-10T15:05:00.000Z"),
      })
      .where(eq(bookingNoShowChargeRecords.id, voided.recordId));
    await requireDb()
      .update(bookingNoShowChargeRecords)
      .set({ appointmentId: null })
      .where(eq(bookingNoShowChargeRecords.id, withoutAppointment.recordId));
    await requireDb()
      .insert(bookingNoShowChargeAttempts)
      .values([
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
        {
          amountCents: 6500,
          createdAt: new Date("2035-01-10T14:30:00.000Z"),
          noShowChargeRecordId: voided.recordId,
          processedAt: new Date("2035-01-10T15:05:00.000Z"),
          squarePaymentId: voided.squarePaymentId,
          status: "charged",
        },
        {
          amountCents: 6000,
          createdAt: new Date("2035-01-10T14:40:00.000Z"),
          noShowChargeRecordId: refunded.recordId,
          processedAt: new Date("2035-01-10T15:10:00.000Z"),
          squarePaymentId: refunded.squarePaymentId,
          status: "charged",
        },
        {
          amountCents: 2000,
          createdAt: new Date("2035-01-10T15:20:00.000Z"),
          noShowChargeRecordId: refunded.recordId,
          processedAt: new Date("2035-01-10T15:20:00.000Z"),
          squarePaymentId: `${TEST_PREFIX}refund-${randomUUID()}`,
          status: "partially_refunded",
        },
        {
          amountCents: 5500,
          createdAt: new Date("2035-01-10T15:30:00.000Z"),
          noShowChargeRecordId: withoutAppointment.recordId,
          processedAt: new Date("2035-01-10T15:30:00.000Z"),
          squarePaymentId: withoutAppointment.squarePaymentId,
          status: "charged",
        },
      ]);

    const rows = await queryEmployeeNoShowAttribution(requireDb(), {
      start: new Date("2035-01-01T00:00:00.000Z"),
      endExclusive: new Date("2035-02-01T00:00:00.000Z"),
    });
    const amounts = rows.map((row) => row.amountCents).sort((a, b) => a - b);
    assert.deepEqual(amounts, [0, 5500, 6000, 7500]);
    assert.equal(first.maxChargeCents, 12500);
    assert.equal(second.maxChargeCents, 12500);
    assert.equal(rows.length, 4);
    const rowWithoutAppointment = rows.find((row) => row.amountCents === 5500);
    assert.equal(
      rowWithoutAppointment?.providerSnapshot.providerKey,
      withoutAppointment.providerKey,
    );
    assert.equal(
      rowWithoutAppointment?.squareTeamMemberId,
      withoutAppointment.squareTeamMemberId,
    );
  },
);

test(
  "direct and legacy attribution use immutable hold snapshots without appointments",
  { skip: skipReason },
  async () => {
    const direct = await seedChargedRecord("direct-without-appointment");
    const legacy = await seedChargedRecord("legacy-without-appointment");
    const capturedAt = new Date("2035-01-12T15:00:00.000Z");
    const directPaymentId = `${TEST_PREFIX}direct-${randomUUID()}`;

    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 10000,
        capturedAt,
        currency: "CAD",
        holdId: direct.holdId,
        idempotencyKey: `${TEST_PREFIX}direct-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: directPaymentId,
        squareTeamMemberId: direct.squareTeamMemberId,
        status: "captured",
      });

    const [legacyOrder] = await requireDb()
      .insert(checkoutOrders)
      .values({
        amountCents: 7000,
        checkoutTokenHash: `${TEST_PREFIX}token-${randomUUID()}`,
        currency: "CAD",
        customerEmail: `${TEST_PREFIX}legacy@example.invalid`,
        customerName: "Legacy Attribution",
        lineItems: [],
        orderId: `${TEST_PREFIX}order-${randomUUID()}`,
        paidAt: capturedAt,
        paymentProvider: "square",
        providerPaymentId: `${TEST_PREFIX}legacy-payment-${randomUUID()}`,
        purpose: "appointment_full",
        secretTokenCiphertext: `${TEST_PREFIX}ciphertext`,
        squareTipAmountCents: 500,
        status: "paid",
      })
      .returning();
    await requireDb()
      .update(appointmentHolds)
      .set({ checkoutOrderId: legacyOrder.id })
      .where(eq(appointmentHolds.id, legacy.holdId));

    const range = {
      endExclusive: new Date("2035-01-13T00:00:00.000Z"),
      start: new Date("2035-01-12T00:00:00.000Z"),
    };
    const [directRows, legacyRows] = await Promise.all([
      queryEmployeeDirectAttribution(requireDb(), range),
      queryEmployeeLegacyAttribution(requireDb(), range),
    ]);

    const directRow = directRows.find(
      (row) => row.squareTeamMemberId === direct.squareTeamMemberId,
    );
    assert.equal(directRow?.amountCents, 10000);
    assert.equal(directRow?.providerSnapshot.providerKey, direct.providerKey);

    const legacyRow = legacyRows.find(
      (row) => row.squareTeamMemberId === legacy.squareTeamMemberId,
    );
    assert.equal(legacyRow?.amountCents, 7000);
    assert.equal(legacyRow?.tipCents, 500);
    assert.equal(legacyRow?.providerSnapshot.providerKey, legacy.providerKey);
  },
);

test(
  "completed Square refunds are idempotent by refund and use first completion timestamps",
  { skip: skipReason },
  async () => {
    const paymentId = `${TEST_PREFIX}refund-payment-${randomUUID()}`;
    const refundId = `${TEST_PREFIX}refund-${randomUUID()}`;
    await requireDb()
      .insert(squarePaymentRefundEvents)
      .values([
        {
          amountCents: 2500,
          currency: "CAD",
          occurredAt: new Date("2035-01-08T20:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}refund-pending-${randomUUID()}`,
          squarePaymentId: paymentId,
          squareRefundId: refundId,
          status: "PENDING",
        },
        {
          amountCents: 2500,
          currency: "CAD",
          occurredAt: new Date("2035-01-10T20:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}refund-completed-${randomUUID()}`,
          squarePaymentId: paymentId,
          squareRefundId: refundId,
          status: "COMPLETED",
        },
        {
          amountCents: 2500,
          currency: "CAD",
          occurredAt: new Date("2035-01-11T20:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}refund-repeated-${randomUUID()}`,
          squarePaymentId: paymentId,
          squareRefundId: refundId,
          status: "COMPLETED",
        },
        {
          amountCents: 1000,
          currency: "CAD",
          occurredAt: new Date("2035-02-01T00:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}refund-boundary-${randomUUID()}`,
          squarePaymentId: paymentId,
          squareRefundId: `${TEST_PREFIX}refund-${randomUUID()}`,
          status: "COMPLETED",
        },
      ]);

    const period = await queryCompletedSquareRefunds(requireDb(), {
      endExclusive: new Date("2035-02-01T00:00:00.000Z"),
      start: new Date("2035-01-01T00:00:00.000Z"),
    });
    assert.deepEqual(
      period.map((refund) => ({
        amountCents: refund.amountCents,
        occurredAt: refund.occurredAt.toISOString(),
      })),
      [
        {
          amountCents: 2500,
          occurredAt: "2035-01-10T20:00:00.000Z",
        },
      ],
    );

    const allThroughPeriod = await queryCompletedSquareRefundsForPayments(
      requireDb(),
      {
        endExclusive: new Date("2035-02-01T00:00:00.000Z"),
        squarePaymentIds: [paymentId],
      },
    );
    assert.equal(allThroughPeriod.length, 1);
    assert.equal(allThroughPeriod[0]?.squareRefundId, refundId);
  },
);

test(
  "async no-show finalization records the provider amount and event timestamp on the attempt",
  { skip: skipReason },
  async () => {
    const seeded = await seedChargedRecord("async-finalization");
    const providerOccurredAt = new Date("2035-01-10T14:58:00.000Z");
    const processedAt = new Date("2035-01-10T15:05:00.000Z");
    const paymentId = `${TEST_PREFIX}async-payment-${randomUUID()}`;
    await requireDb()
      .update(bookingNoShowChargeRecords)
      .set({
        chargedAt: null,
        squarePaymentId: null,
        status: "charge_pending",
      })
      .where(eq(bookingNoShowChargeRecords.id, seeded.recordId));
    const [attempt] = await requireDb()
      .insert(bookingNoShowChargeAttempts)
      .values({
        amountCents: 5000,
        idempotencyKey: `${TEST_PREFIX}async-attempt-${randomUUID()}`,
        noShowChargeRecordId: seeded.recordId,
        status: "charge_pending",
      })
      .returning();
    const repository = await createCardOnFileDrizzleRepository(requireDb());

    await repository.finalizeNoShowChargeRecord({
      chargedAmountCents: 7500,
      chargedAt: providerOccurredAt,
      event: {
        eventId: `${TEST_PREFIX}async-event-${randomUUID()}`,
        eventType: "payment.updated",
        payloadSanitized: {},
        processedAt,
        processingStatus: "processed",
        providerPaymentId: paymentId,
        status: "charged",
      },
      noShowChargeRecordId: seeded.recordId,
      providerStatus: "COMPLETED",
      squarePaymentId: paymentId,
      status: "charged",
    });

    const [storedAttempt] = await requireDb()
      .select()
      .from(bookingNoShowChargeAttempts)
      .where(eq(bookingNoShowChargeAttempts.id, attempt.id));
    const [storedRecord] = await requireDb()
      .select()
      .from(bookingNoShowChargeRecords)
      .where(eq(bookingNoShowChargeRecords.id, seeded.recordId));

    assert.equal(storedAttempt?.amountCents, 7500);
    assert.equal(storedAttempt?.squarePaymentId, paymentId);
    assert.equal(storedAttempt?.status, "charged");
    assert.equal(
      storedAttempt?.processedAt?.toISOString(),
      processedAt.toISOString(),
    );
    assert.equal(
      storedRecord?.chargedAt?.toISOString(),
      providerOccurredAt.toISOString(),
    );
  },
);

test(
  "aggregation preserves event and historical refunds across source, boundary, and unattributed cases",
  { skip: skipReason },
  async () => {
    const eventDirect = await seedChargedRecord("aggregate-event-direct");
    const historicalDirect = await seedChargedRecord(
      "aggregate-historical-direct",
    );
    const historicalLegacy = await seedChargedRecord(
      "aggregate-historical-legacy",
    );
    const historicalNoShow = await seedChargedRecord(
      "aggregate-historical-no-show",
    );
    const missingOutside = await seedChargedRecord("aggregate-missing-outside");
    const missingInside = await seedChargedRecord("aggregate-missing-inside");
    const currencyMismatch = await seedChargedRecord(
      "aggregate-currency-mismatch",
    );
    const range = {
      endExclusive: new Date("2035-02-01T00:00:00.000Z"),
      start: new Date("2035-01-20T00:00:00.000Z"),
    };

    const eventDirectPaymentId = `${TEST_PREFIX}aggregate-direct-${randomUUID()}`;
    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 10_000,
        capturedAt: new Date("2035-01-10T15:00:00.000Z"),
        currency: "CAD",
        holdId: eventDirect.holdId,
        idempotencyKey: `${TEST_PREFIX}aggregate-direct-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: eventDirectPaymentId,
        squareTeamMemberId: eventDirect.squareTeamMemberId,
        status: "refunded",
        updatedAt: new Date("2035-01-25T15:00:00.000Z"),
      });
    const firstDirectRefundId = `${TEST_PREFIX}aggregate-refund-${randomUUID()}`;
    await requireDb()
      .insert(squarePaymentRefundEvents)
      .values([
        {
          amountCents: 3000,
          currency: "CAD",
          occurredAt: new Date("2035-01-25T15:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: eventDirectPaymentId,
          squareRefundId: firstDirectRefundId,
          status: "COMPLETED",
        },
        {
          amountCents: 3000,
          currency: "CAD",
          occurredAt: new Date("2035-01-26T15:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: eventDirectPaymentId,
          squareRefundId: firstDirectRefundId,
          status: "COMPLETED",
        },
        {
          amountCents: 7000,
          currency: "CAD",
          occurredAt: new Date("2035-01-27T15:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: eventDirectPaymentId,
          squareRefundId: `${TEST_PREFIX}aggregate-refund-${randomUUID()}`,
          status: "COMPLETED",
        },
      ]);

    const historicalDirectPaymentId = `${TEST_PREFIX}aggregate-historical-direct-${randomUUID()}`;
    const [historicalDirectOrder] = await requireDb()
      .insert(checkoutOrders)
      .values({
        amountCents: 2500,
        checkoutTokenHash: `${TEST_PREFIX}aggregate-token-${randomUUID()}`,
        currency: "CAD",
        customerEmail: `${TEST_PREFIX}aggregate-direct@example.invalid`,
        customerName: "Historical Direct Attribution",
        lineItems: [],
        orderId: `${TEST_PREFIX}aggregate-order-${randomUUID()}`,
        paidAt: new Date("2035-01-10T15:00:00.000Z"),
        paymentProvider: "square",
        providerPaymentId: historicalDirectPaymentId,
        purpose: "appointment_full",
        secretTokenCiphertext: `${TEST_PREFIX}aggregate-ciphertext`,
        squareTipAmountCents: 250,
        status: "paid",
      })
      .returning();
    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 2500,
        capturedAt: new Date("2035-01-10T15:00:00.000Z"),
        checkoutOrderId: historicalDirectOrder.id,
        currency: "CAD",
        holdId: historicalDirect.holdId,
        idempotencyKey: `${TEST_PREFIX}aggregate-historical-direct-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: historicalDirectPaymentId,
        squareTeamMemberId: historicalDirect.squareTeamMemberId,
        status: "refunded",
        updatedAt: new Date("2035-01-24T15:00:00.000Z"),
      });

    const legacyPaymentId = `${TEST_PREFIX}aggregate-legacy-${randomUUID()}`;
    const [legacyOrder] = await requireDb()
      .insert(checkoutOrders)
      .values({
        amountCents: 5000,
        checkoutTokenHash: `${TEST_PREFIX}aggregate-token-${randomUUID()}`,
        currency: "CAD",
        customerEmail: `${TEST_PREFIX}aggregate-legacy@example.invalid`,
        customerName: "Historical Legacy Attribution",
        lineItems: [],
        orderId: `${TEST_PREFIX}aggregate-order-${randomUUID()}`,
        paidAt: new Date("2035-01-10T15:00:00.000Z"),
        paymentProvider: "square",
        providerPaymentId: legacyPaymentId,
        purpose: "appointment_full",
        secretTokenCiphertext: `${TEST_PREFIX}aggregate-ciphertext`,
        squareTipAmountCents: 500,
        status: "refunded",
        updatedAt: new Date("2035-01-25T15:00:00.000Z"),
      })
      .returning();
    await requireDb()
      .update(appointmentHolds)
      .set({ checkoutOrderId: legacyOrder.id })
      .where(eq(appointmentHolds.id, historicalLegacy.holdId));

    await requireDb()
      .insert(bookingNoShowChargeAttempts)
      .values([
        {
          amountCents: 6000,
          createdAt: new Date("2035-01-10T15:00:00.000Z"),
          noShowChargeRecordId: historicalNoShow.recordId,
          processedAt: new Date("2035-01-10T15:00:00.000Z"),
          squarePaymentId: historicalNoShow.squarePaymentId,
          status: "charged",
        },
        {
          amountCents: 2000,
          createdAt: new Date("2035-01-15T15:00:00.000Z"),
          noShowChargeRecordId: historicalNoShow.recordId,
          processedAt: new Date("2035-01-15T15:00:00.000Z"),
          squarePaymentId: `${TEST_PREFIX}aggregate-no-show-refund-${randomUUID()}`,
          status: "partially_refunded",
        },
        {
          amountCents: 4000,
          createdAt: new Date("2035-01-25T15:00:00.000Z"),
          noShowChargeRecordId: historicalNoShow.recordId,
          processedAt: new Date("2035-01-25T15:00:00.000Z"),
          squarePaymentId: `${TEST_PREFIX}aggregate-no-show-refund-${randomUUID()}`,
          status: "refunded",
        },
      ]);

    const missingOutsidePaymentId = `${TEST_PREFIX}aggregate-missing-outside-${randomUUID()}`;
    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 3000,
        capturedAt: new Date("2035-01-10T15:00:00.000Z"),
        currency: "CAD",
        holdId: missingOutside.holdId,
        idempotencyKey: `${TEST_PREFIX}aggregate-missing-outside-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: missingOutsidePaymentId,
        squareTeamMemberId: null,
        status: "captured",
      });

    const missingInsidePaymentId = `${TEST_PREFIX}aggregate-missing-inside-${randomUUID()}`;
    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 2000,
        capturedAt: new Date("2035-01-25T14:00:00.000Z"),
        currency: "CAD",
        holdId: missingInside.holdId,
        idempotencyKey: `${TEST_PREFIX}aggregate-missing-inside-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: missingInsidePaymentId,
        squareTeamMemberId: null,
        status: "captured",
      });

    const currencyMismatchPaymentId = `${TEST_PREFIX}aggregate-currency-${randomUUID()}`;
    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 4000,
        capturedAt: new Date("2035-01-10T15:00:00.000Z"),
        currency: "CAD",
        holdId: currencyMismatch.holdId,
        idempotencyKey: `${TEST_PREFIX}aggregate-currency-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: currencyMismatchPaymentId,
        squareTeamMemberId: currencyMismatch.squareTeamMemberId,
        status: "captured",
      });

    await requireDb()
      .insert(squarePaymentRefundEvents)
      .values([
        {
          amountCents: 1500,
          currency: "CAD",
          occurredAt: new Date("2035-01-25T16:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: missingOutsidePaymentId,
          squareRefundId: `${TEST_PREFIX}aggregate-refund-${randomUUID()}`,
          status: "COMPLETED",
        },
        {
          amountCents: 1000,
          currency: "CAD",
          occurredAt: new Date("2035-01-26T16:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: missingInsidePaymentId,
          squareRefundId: `${TEST_PREFIX}aggregate-refund-${randomUUID()}`,
          status: "COMPLETED",
        },
        {
          amountCents: 400,
          currency: "CAD",
          occurredAt: new Date("2035-01-27T16:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: `${TEST_PREFIX}aggregate-unmatched-${randomUUID()}`,
          squareRefundId: `${TEST_PREFIX}aggregate-refund-${randomUUID()}`,
          status: "COMPLETED",
        },
        {
          amountCents: 600,
          currency: "USD",
          occurredAt: new Date("2035-01-28T16:00:00.000Z"),
          providerEventId: `${TEST_PREFIX}aggregate-event-${randomUUID()}`,
          squarePaymentId: currencyMismatchPaymentId,
          squareRefundId: `${TEST_PREFIX}aggregate-refund-${randomUUID()}`,
          status: "COMPLETED",
        },
      ]);

    const result = await getEmployeeAttributionAnalyticsForRange(
      requireDb(),
      range,
    );
    const directRow = result.rows.find(
      (row) => row.attributionKey === `provider:${eventDirect.providerKey}`,
    );
    const historicalDirectRow = result.rows.find(
      (row) =>
        row.attributionKey === `provider:${historicalDirect.providerKey}`,
    );
    const legacyRow = result.rows.find(
      (row) =>
        row.attributionKey === `provider:${historicalLegacy.providerKey}`,
    );
    const noShowRow = result.rows.find(
      (row) =>
        row.attributionKey === `provider:${historicalNoShow.providerKey}`,
    );
    const unattributed = result.rows.find(
      (row) => row.attributionKey === "unattributed",
    );

    assert.equal(directRow?.capturedSalesCents, 0);
    assert.equal(directRow?.refundedCents, 10_000);
    assert.equal(directRow?.fullyRefundedCents, 10_000);
    assert.equal(directRow?.netAttributedSalesCents, -10_000);
    assert.ok(
      directRow?.sourceLabels.includes("Native Square direct payment refund"),
    );
    assert.equal(
      directRow?.sourceLabels.some((label) =>
        label.includes("Historical local evidence"),
      ),
      false,
    );

    assert.equal(historicalDirectRow?.capturedSalesCents, 0);
    assert.equal(historicalDirectRow?.refundedCents, 2750);
    assert.equal(historicalDirectRow?.fullyRefundedCents, 2750);
    assert.equal(historicalDirectRow?.netAttributedSalesCents, -2750);
    assert.ok(
      historicalDirectRow?.sourceLabels.includes(
        "Historical local evidence · direct payment refund",
      ),
    );

    assert.equal(legacyRow?.legacyChargesCents, 0);
    assert.equal(legacyRow?.refundedCents, 5500);
    assert.equal(legacyRow?.fullyRefundedCents, 5500);
    assert.equal(legacyRow?.netAttributedSalesCents, -5500);
    assert.ok(
      legacyRow?.sourceLabels.includes(
        "Historical local evidence · legacy Payment Link refund",
      ),
    );

    assert.equal(noShowRow?.noShowChargesCents, 0);
    assert.equal(noShowRow?.refundedCents, 4000);
    assert.equal(noShowRow?.fullyRefundedCents, 6000);
    assert.equal(noShowRow?.netAttributedSalesCents, -4000);
    assert.ok(
      noShowRow?.sourceLabels.includes(
        "Historical local evidence · no-show refund",
      ),
    );

    assert.equal(unattributed?.capturedSalesCents, 2000);
    assert.equal(unattributed?.refundedCents, 3500);
    assert.equal(unattributed?.fullyRefundedCents, 0);
    assert.equal(unattributed?.netAttributedSalesCents, -1500);
    assert.equal(unattributed?.unattributedRecords, 4);
    assert.ok(
      unattributed?.sourceLabels.includes(
        "Unattributed Square refund · payment not found",
      ),
    );
    assert.ok(
      unattributed?.sourceLabels.includes(
        "Unattributed Square refund · currency mismatch",
      ),
    );

    assert.deepEqual(result.totals, {
      capturedSalesCents: 2000,
      fullyRefundedCents: 24_250,
      knownTipsCents: 0,
      legacyChargesCents: 0,
      netAttributedSalesCents: -23_750,
      noShowChargesCents: 0,
      refundedCents: 25_750,
      unattributedRecords: 4,
    });
  },
);

test(
  "aggregation keeps one repeatable-read snapshot when a refund completes between query phases",
  { skip: skipReason },
  async () => {
    const seeded = await seedChargedRecord("aggregate-repeatable-read");
    const paymentId = `${TEST_PREFIX}aggregate-snapshot-payment-${randomUUID()}`;
    const range = {
      endExclusive: new Date("2035-02-01T00:00:00.000Z"),
      start: new Date("2035-01-20T00:00:00.000Z"),
    };
    await requireDb()
      .insert(bookingPaymentAttempts)
      .values({
        amountCents: 10_000,
        capturedAt: new Date("2035-01-10T15:00:00.000Z"),
        currency: "CAD",
        holdId: seeded.holdId,
        idempotencyKey: `${TEST_PREFIX}aggregate-snapshot-attempt-${randomUUID()}`,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerPaymentId: paymentId,
        squareTeamMemberId: seeded.squareTeamMemberId,
        status: "captured",
      });
    await requireDb()
      .insert(squarePaymentRefundEvents)
      .values({
        amountCents: 3000,
        currency: "CAD",
        occurredAt: new Date("2035-01-25T15:00:00.000Z"),
        providerEventId: `${TEST_PREFIX}aggregate-snapshot-event-${randomUUID()}`,
        squarePaymentId: paymentId,
        squareRefundId: `${TEST_PREFIX}aggregate-snapshot-refund-${randomUUID()}`,
        status: "COMPLETED",
      });

    const firstSnapshot = await getEmployeeAttributionAnalyticsForRange(
      requireDb(),
      range,
      {
        afterInitialReads: async () => {
          await requireDb()
            .insert(squarePaymentRefundEvents)
            .values({
              amountCents: 7000,
              currency: "CAD",
              occurredAt: new Date("2035-01-26T15:00:00.000Z"),
              providerEventId: `${TEST_PREFIX}aggregate-snapshot-event-${randomUUID()}`,
              squarePaymentId: paymentId,
              squareRefundId: `${TEST_PREFIX}aggregate-snapshot-refund-${randomUUID()}`,
              status: "COMPLETED",
            });
        },
      },
    );
    const firstRow = firstSnapshot.rows.find(
      (row) => row.attributionKey === `provider:${seeded.providerKey}`,
    );
    assert.equal(firstRow?.refundedCents, 3000);
    assert.equal(firstRow?.fullyRefundedCents, 0);

    const nextSnapshot = await getEmployeeAttributionAnalyticsForRange(
      requireDb(),
      range,
    );
    const nextRow = nextSnapshot.rows.find(
      (row) => row.attributionKey === `provider:${seeded.providerKey}`,
    );
    assert.equal(nextRow?.refundedCents, 10_000);
    assert.equal(nextRow?.fullyRefundedCents, 10_000);
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
  const providerSnapshot = {
    displayName: `Attribution provider ${suffix}`,
    providerKey: provider.providerKey,
  };
  const squareTeamMemberId = `${TEST_PREFIX}team-${suffix}`;
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
      providerSnapshot,
      publicReference,
      selectedEnd: end,
      selectedStart: start,
      status: "booked",
      squareTeamMemberId,
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
      providerSnapshot,
      publicReference: `${TEST_PREFIX}appointment-${suffix}`,
      selectedEnd: end,
      selectedStart: start,
      serviceOfferingId: offering.id,
      sourceHoldId: hold.id,
      sourceHoldPublicReference: publicReference,
      squareTeamMemberId,
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
  return {
    appointmentId: appointment.id,
    holdId: hold.id,
    maxChargeCents,
    providerKey: provider.providerKey,
    recordId: record.id,
    squarePaymentId,
    squareTeamMemberId,
  };
}

function requireDb() {
  if (!db) throw new Error("TEST_DATABASE_URL not configured");
  return db;
}

async function cleanup(): Promise<void> {
  const database = requireDb();
  await database.execute(
    sql`delete from ${bookingPaymentAttempts} where ${bookingPaymentAttempts.idempotencyKey} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${appointments} where ${appointments.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${appointmentHolds} where ${appointmentHolds.publicReference} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${checkoutOrders} where ${checkoutOrders.orderId} like ${`${TEST_PREFIX}%`}`,
  );
  await database.execute(
    sql`delete from ${squarePaymentRefundEvents} where ${squarePaymentRefundEvents.providerEventId} like ${`${TEST_PREFIX}%`}`,
  );
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
