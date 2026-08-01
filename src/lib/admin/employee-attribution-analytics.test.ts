import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateEmployeeAttributionRows,
  calculateRefundPeriodMetrics,
  resolveEmployeeAttributionReportingRange,
} from "./employee-attribution-report";

test("employee attribution separates native, local, refunded, and unattributed totals", () => {
  const snapshot = { displayName: "Ava Provider", providerKey: "ava" };
  const result = aggregateEmployeeAttributionRows({
    directPayments: [
      {
        amountCents: 10_000,
        providerSnapshot: snapshot,
        squareTeamMemberId: "team-1",
        tipCents: 1_000,
      },
      {
        amountCents: 5_000,
        providerSnapshot: snapshot,
        squareTeamMemberId: "team-1",
        tipCents: null,
      },
      {
        amountCents: 2_000,
        providerSnapshot: { displayName: "Unknown mapping" },
        squareTeamMemberId: null,
        tipCents: null,
      },
    ],
    legacyCharges: [
      {
        amountCents: 3_000,
        providerSnapshot: snapshot,
        squareTeamMemberId: "team-1",
        tipCents: 300,
      },
    ],
    noShowCharges: [
      {
        amountCents: 4_000,
        providerSnapshot: snapshot,
        squareTeamMemberId: "team-1",
      },
    ],
    refunds: [
      {
        amountCents: 7_000,
        evidence: "square_event",
        fullyRefundedCents: 5_000,
        providerSnapshot: snapshot,
        source: "direct",
        squareTeamMemberId: "team-1",
      },
    ],
  });

  const ava = result.rows.find((row) => row.employeeLabel === "Ava Provider");
  assert.ok(ava);
  assert.equal(ava.attributionKey, "provider:ava");
  assert.equal(ava.attributionKey.includes("team-1"), false);
  assert.equal(ava.capturedSalesCents, 15_000);
  assert.equal(ava.fullyRefundedCents, 5_000);
  assert.equal(ava.refundedCents, 7_000);
  assert.equal(ava.knownTipsCents, 1_300);
  assert.equal(ava.noShowChargesCents, 4_000);
  assert.equal(ava.legacyChargesCents, 3_000);
  assert.equal(ava.netAttributedSalesCents, 16_300);
  assert.ok(ava.sourceLabels.some((label) => label.includes("Native Square")));
  assert.ok(
    ava.sourceLabels.some((label) =>
      label.includes("legacy Square Payment Link"),
    ),
  );

  const unattributed = result.rows.find(
    (row) => row.employeeLabel === "Unattributed",
  );
  assert.equal(unattributed?.unattributedRecords, 1);
  assert.equal(result.totals.unattributedRecords, 1);
});

test("refund period metrics subtract partial refunds and separately detect full completion", () => {
  assert.deepEqual(
    calculateRefundPeriodMetrics({
      grossAmountCents: 10_000,
      refundedBeforeCents: 2_000,
      refundedInPeriodCents: 3_000,
      refundedThroughPeriodCents: 5_000,
    }),
    { fullyRefundedCents: 0, refundedCents: 3_000 },
  );
  assert.deepEqual(
    calculateRefundPeriodMetrics({
      grossAmountCents: 10_000,
      refundedBeforeCents: 5_000,
      refundedInPeriodCents: 5_000,
      refundedThroughPeriodCents: 10_000,
    }),
    { fullyRefundedCents: 10_000, refundedCents: 5_000 },
  );
  assert.deepEqual(
    calculateRefundPeriodMetrics({
      grossAmountCents: 10_000,
      refundedBeforeCents: 10_000,
      refundedInPeriodCents: 500,
      refundedThroughPeriodCents: 10_500,
    }),
    { fullyRefundedCents: 0, refundedCents: 500 },
  );
});

test("employee attribution date boundaries use inclusive business-local dates", () => {
  const range = resolveEmployeeAttributionReportingRange(
    { from: "2026-03-08", to: "2026-03-08" },
    "America/Toronto",
  );

  assert.equal(range.start.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.throws(
    () =>
      resolveEmployeeAttributionReportingRange(
        { from: "2026-03-10", to: "2026-03-09" },
        "America/Toronto",
      ),
    /from date/,
  );
});

test("employee attribution allows 366 calendar days across Toronto fall DST", () => {
  const range = resolveEmployeeAttributionReportingRange(
    { from: "2025-11-01", to: "2026-11-01" },
    "America/Toronto",
  );

  assert.equal(range.start.toISOString(), "2025-11-01T04:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-11-02T05:00:00.000Z");
  assert.ok(
    range.endExclusive.getTime() - range.start.getTime() > 366 * 86_400_000,
  );
  assert.throws(
    () =>
      resolveEmployeeAttributionReportingRange(
        { from: "2025-11-01", to: "2026-11-02" },
        "America/Toronto",
      ),
    /cannot exceed 366 days/,
  );
});
