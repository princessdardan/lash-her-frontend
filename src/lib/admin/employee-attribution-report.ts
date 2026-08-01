import { localDateTimeToUtc } from "./local-time";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_DAYS = 366;

export function calculateRefundPeriodMetrics(input: {
  grossAmountCents: number;
  refundedBeforeCents: number;
  refundedInPeriodCents: number;
  refundedThroughPeriodCents: number;
}): { fullyRefundedCents: number; refundedCents: number } {
  const becameFullyRefunded =
    input.grossAmountCents > 0 &&
    input.refundedBeforeCents < input.grossAmountCents &&
    input.refundedThroughPeriodCents >= input.grossAmountCents;

  return {
    fullyRefundedCents: becameFullyRefunded ? input.grossAmountCents : 0,
    refundedCents: input.refundedInPeriodCents,
  };
}

export interface EmployeeAttributionRow {
  attributionKey: string;
  capturedSalesCents: number;
  employeeLabel: string;
  fullyRefundedCents: number;
  knownTipsCents: number;
  legacyChargesCents: number;
  netAttributedSalesCents: number;
  noShowChargesCents: number;
  refundedCents: number;
  sourceLabels: string[];
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
    tipCents: number | null;
  }>;
  legacyCharges: Array<{
    amountCents: number;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
    tipCents: number | null;
  }>;
  noShowCharges: Array<{
    amountCents: number;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
  }>;
  refunds: Array<{
    amountCents: number;
    countUnattributed?: boolean;
    evidence: "local_fallback" | "square_event";
    forceUnattributed?: boolean;
    fullyRefundedCents: number;
    providerSnapshot: Record<string, unknown>;
    source: "currency_mismatch" | "direct" | "legacy" | "no_show" | "unmatched";
    squareTeamMemberId: string | null;
  }>;
}): {
  rows: EmployeeAttributionRow[];
  totals: Omit<
    EmployeeAttributionRow,
    "attributionKey" | "employeeLabel" | "sourceLabels"
  >;
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
    row.sourceLabelSet.add("Local attribution · legacy Square Payment Link");
  }

  for (const refund of input.refunds) {
    const row = getOrCreateRow(rows, {
      countUnattributed: refund.countUnattributed ?? false,
      forceUnattributed: refund.forceUnattributed,
      nativeAttributionRequired: refund.source === "direct",
      providerSnapshot: refund.providerSnapshot,
      squareTeamMemberId: refund.squareTeamMemberId,
    });
    row.refundedCents += refund.amountCents;
    row.fullyRefundedCents += refund.fullyRefundedCents;
    row.sourceLabelSet.add(getRefundSourceLabel(refund));
  }

  const resultRows = [...rows.values()]
    .map(finalizeRow)
    .sort((left, right) =>
      left.employeeLabel.localeCompare(right.employeeLabel),
    );
  const totals = resultRows.reduce(
    (total, row) => ({
      capturedSalesCents: total.capturedSalesCents + row.capturedSalesCents,
      fullyRefundedCents: total.fullyRefundedCents + row.fullyRefundedCents,
      knownTipsCents: total.knownTipsCents + row.knownTipsCents,
      legacyChargesCents: total.legacyChargesCents + row.legacyChargesCents,
      netAttributedSalesCents:
        total.netAttributedSalesCents + row.netAttributedSalesCents,
      noShowChargesCents: total.noShowChargesCents + row.noShowChargesCents,
      refundedCents: total.refundedCents + row.refundedCents,
      unattributedRecords: total.unattributedRecords + row.unattributedRecords,
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
  if (to > addCalendarDays(from, MAX_REPORT_DAYS - 1)) {
    throw new Error(
      `The reporting range cannot exceed ${MAX_REPORT_DAYS} days`,
    );
  }
  const endDate = addCalendarDays(to, 1);
  const start = localDateTimeToUtc(`${from}T00:00`, timezone);
  const endExclusive = localDateTimeToUtc(`${endDate}T00:00`, timezone);
  return { endExclusive, from, start, to };
}

function getOrCreateRow(
  rows: Map<string, MutableAttributionRow>,
  input: {
    nativeAttributionRequired: boolean;
    countUnattributed?: boolean;
    forceUnattributed?: boolean;
    providerSnapshot: Record<string, unknown>;
    squareTeamMemberId: string | null;
  },
): MutableAttributionRow {
  const snapshotLabel = getSnapshotLabel(input.providerSnapshot);
  const teamMemberId = input.squareTeamMemberId?.trim() || null;
  const isUnattributed =
    input.forceUnattributed === true ||
    (input.nativeAttributionRequired && teamMemberId === null);
  const providerKey = getSnapshotProviderKey(input.providerSnapshot);
  const key = isUnattributed
    ? "unattributed"
    : `provider:${providerKey ?? snapshotLabel}`;
  let row = rows.get(key);

  if (!row) {
    row = {
      ...emptyTotals(),
      attributionKey: key,
      employeeLabel: isUnattributed ? "Unattributed" : snapshotLabel,
      sourceLabels: [],
      sourceLabelSet: new Set<string>(),
    };
    rows.set(key, row);
  }
  if (isUnattributed && input.countUnattributed !== false) {
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
      row.refundedCents,
    noShowChargesCents: row.noShowChargesCents,
    refundedCents: row.refundedCents,
    sourceLabels: [...row.sourceLabelSet].sort(),
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
    refundedCents: 0,
    unattributedRecords: 0,
  };
}

function getRefundSourceLabel(refund: {
  evidence: "local_fallback" | "square_event";
  source: "currency_mismatch" | "direct" | "legacy" | "no_show" | "unmatched";
}): string {
  if (refund.evidence === "local_fallback") {
    if (refund.source === "direct") {
      return "Historical local evidence · direct payment refund";
    }
    if (refund.source === "legacy") {
      return "Historical local evidence · legacy Payment Link refund";
    }
    return "Historical local evidence · no-show refund";
  }

  if (refund.source === "currency_mismatch") {
    return "Unattributed Square refund · currency mismatch";
  }

  if (refund.source === "unmatched") {
    return "Unattributed Square refund · payment not found";
  }

  if (refund.source === "direct") {
    return "Native Square direct payment refund";
  }

  if (refund.source === "legacy") {
    return "Local attribution · legacy Square Payment Link refund";
  }

  return "Local attribution · Square no-show invoice refund";
}

function getSnapshotLabel(snapshot: Record<string, unknown>): string {
  return typeof snapshot.displayName === "string" && snapshot.displayName.trim()
    ? snapshot.displayName.trim()
    : "Unknown provider";
}

function getSnapshotProviderKey(
  snapshot: Record<string, unknown>,
): string | null {
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
