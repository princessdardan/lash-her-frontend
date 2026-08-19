export interface ExpectedMigrationLineageEntry {
  folderMillis: number;
  hash: string;
  tag: string;
  acceptedHistoricalHashes?: readonly string[];
  optional?: boolean;
}

export interface AppliedMigrationLineageRow {
  created_at: string | number | null;
  hash: string;
}

const LEGACY_ADMIN_DASHBOARD_MIGRATIONS: ExpectedMigrationLineageEntry[] = [
  {
    folderMillis: 1780454716621,
    hash: "5610ea67c054201218507dc5aecf55f8c42af8ff465ada2b846bbef194de6a75",
    tag: "legacy/0011_red_rocket_raccoon",
    optional: true,
  },
  {
    folderMillis: 1780520000000,
    hash: "9ed678e8cfdb74df5dfe7da13692d7b258c17237015de191310b7d8b0c916b79",
    tag: "legacy/0012_drop_admin_audit_reason",
    optional: true,
  },
];

const RECONCILED_MIGRATION_HASHES = new Map<
  number,
  { canonicalHash: string; acceptedHistoricalHashes: readonly string[] }
>([
  [
    1783023767006,
    {
      canonicalHash:
        "7698d4d5cedf4205a3484575be6f01db8ebc4a3f3e4dc434b1a58010d7a26d2c",
      acceptedHistoricalHashes: [
        "223b503a8609f1f3451550a6ce9c133b89fe501b206dd147731d36f295fc09f3",
      ],
    },
  ],
]);

/**
 * Adds the explicitly audited abandoned-branch entries and deployed hash
 * variants that the active migration lineage reconciles additively.
 */
export function buildExpectedPrivateDbMigrationLineage(
  localMigrations: ExpectedMigrationLineageEntry[],
): ExpectedMigrationLineageEntry[] {
  const expected = localMigrations.map((migration) => {
    const reconciliation = RECONCILED_MIGRATION_HASHES.get(
      migration.folderMillis,
    );

    if (!reconciliation) {
      return migration;
    }
    if (migration.hash !== reconciliation.canonicalHash) {
      throw new Error(
        `Local migration ${migration.tag} (${migration.folderMillis}) no longer matches its canonical reconciled hash ${reconciliation.canonicalHash}. Restore the committed migration before continuing.`,
      );
    }

    return {
      ...migration,
      acceptedHistoricalHashes: reconciliation.acceptedHistoricalHashes,
    };
  });

  return [...expected, ...LEGACY_ADMIN_DASHBOARD_MIGRATIONS].sort(
    (left, right) => left.folderMillis - right.folderMillis,
  );
}

/**
 * Verifies that the database journal is an exact prefix of the required local
 * lineage plus explicitly audited historical entries. A timestamp-only
 * comparison can silently accept edited migration files, unknown entries, or
 * missing migrations beneath the latest applied timestamp.
 */
export function assertAppliedMigrationLineage(
  expectedMigrations: ExpectedMigrationLineageEntry[],
  appliedRows: AppliedMigrationLineageRow[],
): number {
  const expectedByTimestamp = new Map<number, ExpectedMigrationLineageEntry>();

  for (const migration of expectedMigrations) {
    if (expectedByTimestamp.has(migration.folderMillis)) {
      throw new Error(
        `Local migration journal contains duplicate timestamp ${migration.folderMillis}.`,
      );
    }
    expectedByTimestamp.set(migration.folderMillis, migration);
  }

  const appliedByTimestamp = new Map<number, AppliedMigrationLineageRow>();
  let latestAppliedAt = 0;

  for (const applied of appliedRows) {
    const timestamp = parseAppliedTimestamp(applied.created_at);
    const expected = expectedByTimestamp.get(timestamp);

    if (!expected) {
      throw new Error(
        `Database migration lineage contains unknown timestamp ${timestamp}; it is absent from the selected expected lineage. Stop and reconcile the deployed migration history before continuing.`,
      );
    }
    if (appliedByTimestamp.has(timestamp)) {
      throw new Error(
        `Database migration lineage contains duplicate timestamp ${timestamp} (${expected.tag}). Stop and reconcile the deployed migration history before continuing.`,
      );
    }
    const acceptedHashes = new Set([
      expected.hash,
      ...(expected.acceptedHistoricalHashes ?? []),
    ]);

    if (!acceptedHashes.has(applied.hash)) {
      const historicalHashMessage = expected.acceptedHistoricalHashes?.length
        ? " or an explicitly audited historical hash"
        : "";
      throw new Error(
        `Migration lineage mismatch for ${expected.tag} (${timestamp}): database hash ${applied.hash} does not match local hash ${expected.hash}${historicalHashMessage}. Stop; do not edit the database journal or reapply later migrations. Restore the exact deployed migration provenance and reconcile with a new additive migration.`,
      );
    }

    appliedByTimestamp.set(timestamp, applied);
    latestAppliedAt = Math.max(latestAppliedAt, timestamp);
  }

  for (const migration of expectedMigrations) {
    if (
      !migration.optional &&
      migration.folderMillis <= latestAppliedAt &&
      !appliedByTimestamp.has(migration.folderMillis)
    ) {
      throw new Error(
        `Database migration lineage has a gap at ${migration.tag} (${migration.folderMillis}) even though a later migration is recorded. Stop and reconcile the deployed migration history before continuing.`,
      );
    }
  }

  return latestAppliedAt;
}

function parseAppliedTimestamp(value: string | number | null): number {
  const timestamp = typeof value === "number" ? value : Number(value);

  if (value === null || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(
      `Database migration lineage contains invalid timestamp ${String(value)}. Stop and reconcile the deployed migration history before continuing.`,
    );
  }

  return timestamp;
}
