import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateEmployeeAttributionRows,
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
        status: "captured",
        tipCents: 1_000,
      },
      {
        amountCents: 5_000,
        providerSnapshot: snapshot,
        squareTeamMemberId: "team-1",
        status: "refunded",
        tipCents: null,
      },
      {
        amountCents: 2_000,
        providerSnapshot: { displayName: "Unknown mapping" },
        squareTeamMemberId: null,
        status: "captured",
        tipCents: null,
      },
    ],
    legacyCharges: [
      {
        amountCents: 3_000,
        providerSnapshot: snapshot,
        squareTeamMemberId: "team-1",
        status: "paid",
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
  });

  const ava = result.rows.find((row) => row.squareTeamMemberId === "team-1");
  assert.ok(ava);
  assert.equal(ava.capturedSalesCents, 15_000);
  assert.equal(ava.fullyRefundedCents, 5_000);
  assert.equal(ava.knownTipsCents, 1_300);
  assert.equal(ava.noShowChargesCents, 4_000);
  assert.equal(ava.legacyChargesCents, 3_000);
  assert.equal(ava.netAttributedSalesCents, 18_300);
  assert.ok(ava.sourceLabels.some((label) => label.includes("Native Square")));
  assert.ok(
    ava.sourceLabels.some((label) => label.includes("legacy Square Payment Link")),
  );

  const unattributed = result.rows.find(
    (row) => row.employeeLabel === "Unattributed",
  );
  assert.equal(unattributed?.unattributedRecords, 1);
  assert.equal(result.totals.unattributedRecords, 1);
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
