import { localDateTimeToUtc } from "./local-time";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_DAYS = 366;

export interface EmployeeAttributionRow {
  attributionKey: string;
  capturedSalesCents: number;
  employeeLabel: string;
  fullyRefundedCents: number;
  knownTipsCents: number;
  legacyChargesCents: number;
  netAttributedSalesCents: number;
  noShowChargesCents: number;
  sourceLabels: string[];
  squareTeamMemberId: string | null;
  unattributedRecords: number;
}

interface MutableAttributionRow extends EmployeeAttributionRow {
  sourceLabelSet: Set<string>;
}

export function aggregateEmployeeAttributionRows(input: {
  directPayments: Array<{
    amountCents: number;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
    status: string;
    tipCents: number | null;
  }>;
  legacyCharges: Array<{
    amountCents: number;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
    status: string;
    tipCents: number | null;
  }>;
  noShowCharges: Array<{
    amountCents: number;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
  }>;
}): {
  rows: EmployeeAttributionRow[];
  totals: Omit<EmployeeAttributionRow, "attributionKey" | "employeeLabel" | "sourceLabels" | "squareTeamMemberId">;
} {
  const rows = new Map<string, MutableAttributionRow>();

  for (const payment of input.directPayments) {
    const row = getOrCreateRow(rows, {
      nativeAttributionRequired: true,
      providerSnapshot: payment.providerSnapshot,
      squareTeamMemberId: payment.squareTeamMemberId,
    });
    row.capturedSalesCents += payment.amountCents;
    row.knownTipsCents += payment.tipCents ?? 0;
    if (payment.status === "refunded") {
      row.fullyRefundedCents += payment.amountCents;
    }
    row.sourceLabelSet.add("Native Square direct payment");
  }

  for (const charge of input.noShowCharges) {
    const row = getOrCreateRow(rows, {
      nativeAttributionRequired: false,
      providerSnapshot: charge.providerSnapshot,
      squareTeamMemberId: charge.squareTeamMemberId,
    });
    row.noShowChargesCents += charge.amountCents;
    row.sourceLabelSet.add("Local attribution · Square no-show invoice");
  }

  for (const charge of input.legacyCharges) {
    const row = getOrCreateRow(rows, {
      nativeAttributionRequired: false,
      providerSnapshot: charge.providerSnapshot,
      squareTeamMemberId: charge.squareTeamMemberId,
    });
    row.legacyChargesCents += charge.amountCents;
    row.knownTipsCents += charge.tipCents ?? 0;
    if (charge.status === "refunded") {
      row.fullyRefundedCents += charge.amountCents;
    }
    row.sourceLabelSet.add("Local attribution · legacy Square Payment Link");
  }

  const resultRows = [...rows.values()]
    .map(finalizeRow)
    .sort((left, right) => left.employeeLabel.localeCompare(right.employeeLabel));
  const totals = resultRows.reduce(
    (total, row) => ({
      capturedSalesCents: total.capturedSalesCents + row.capturedSalesCents,
      fullyRefundedCents:
        total.fullyRefundedCents + row.fullyRefundedCents,
      knownTipsCents: total.knownTipsCents + row.knownTipsCents,
      legacyChargesCents: total.legacyChargesCents + row.legacyChargesCents,
      netAttributedSalesCents:
        total.netAttributedSalesCents + row.netAttributedSalesCents,
      noShowChargesCents:
        total.noShowChargesCents + row.noShowChargesCents,
      unattributedRecords:
        total.unattributedRecords + row.unattributedRecords,
    }),
    emptyTotals(),
  );

  return { rows: resultRows, totals };
}

export function resolveEmployeeAttributionReportingRange(
  input: { from?: string; to?: string },
  timezone: string,
) {
  const today = formatDateInTimezone(new Date(), timezone);
  const defaultFrom = addCalendarDays(today, -29);
  const from = input.from?.trim() || defaultFrom;
  const to = input.to?.trim() || today;
  assertDate(from, "from");
  assertDate(to, "to");
  if (from > to) {
    throw new Error("The from date must not be after the to date");
  }
  const endDate = addCalendarDays(to, 1);
  const start = localDateTimeToUtc(`${from}T00:00`, timezone);
  const endExclusive = localDateTimeToUtc(`${endDate}T00:00`, timezone);
  if (endExclusive.getTime() - start.getTime() > MAX_REPORT_DAYS * 86_400_000) {
    throw new Error(`The reporting range cannot exceed ${MAX_REPORT_DAYS} days`);
  }
  return { endExclusive, from, start, to };
}

function getOrCreateRow(
  rows: Map<string, MutableAttributionRow>,
  input: {
    nativeAttributionRequired: boolean;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
  },
): MutableAttributionRow {
  const snapshotLabel = getSnapshotLabel(input.providerSnapshot);
  const teamMemberId = input.squareTeamMemberId?.trim() || null;
  const isUnattributed = input.nativeAttributionRequired && teamMemberId === null;
  const providerKey = getSnapshotProviderKey(input.providerSnapshot);
  const key = isUnattributed
    ? "unattributed"
    : teamMemberId
      ? `team:${teamMemberId}`
      : `provider:${providerKey ?? snapshotLabel}`;
  let row = rows.get(key);

  if (!row) {
    row = {
      ...emptyTotals(),
      attributionKey: key,
      employeeLabel: isUnattributed ? "Unattributed" : snapshotLabel,
      sourceLabels: [],
      sourceLabelSet: new Set<string>(),
      squareTeamMemberId: teamMemberId,
    };
    rows.set(key, row);
  }
  if (isUnattributed) {
    row.unattributedRecords += 1;
  }
  return row;
}

function finalizeRow(row: MutableAttributionRow): EmployeeAttributionRow {
  return {
    attributionKey: row.attributionKey,
    capturedSalesCents: row.capturedSalesCents,
    employeeLabel: row.employeeLabel,
    fullyRefundedCents: row.fullyRefundedCents,
    knownTipsCents: row.knownTipsCents,
    legacyChargesCents: row.legacyChargesCents,
    netAttributedSalesCents:
      row.capturedSalesCents +
      row.knownTipsCents +
      row.noShowChargesCents +
      row.legacyChargesCents -
      row.fullyRefundedCents,
    noShowChargesCents: row.noShowChargesCents,
    sourceLabels: [...row.sourceLabelSet].sort(),
    squareTeamMemberId: row.squareTeamMemberId,
    unattributedRecords: row.unattributedRecords,
  };
}

function emptyTotals() {
  return {
    capturedSalesCents: 0,
    fullyRefundedCents: 0,
    knownTipsCents: 0,
    legacyChargesCents: 0,
    netAttributedSalesCents: 0,
    noShowChargesCents: 0,
    unattributedRecords: 0,
  };
}

function getSnapshotLabel(snapshot: Record<string, unknown>): string {
  return typeof snapshot.displayName === "string" && snapshot.displayName.trim()
    ? snapshot.displayName.trim()
    : "Unknown provider";
}

function getSnapshotProviderKey(snapshot: Record<string, unknown>): string | null {
  return typeof snapshot.providerKey === "string" && snapshot.providerKey.trim()
    ? snapshot.providerKey.trim()
    : null;
}

function assertDate(value: string, label: string): void {
  if (!DATE_PATTERN.test(value) || addCalendarDays(value, 0) !== value) {
    throw new Error(`The ${label} date is invalid`);
  }
}

function addCalendarDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
