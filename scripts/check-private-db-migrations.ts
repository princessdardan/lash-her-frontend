/**
 * Read-only check: is the private database migrated to the committed lineage?
 *
 * This never writes to the database and does NOT require the PRIVATE_DB_MIGRATION_*
 * guards that `db:migrate` needs. It reuses the exact lineage verification the
 * migrator uses (`assertAppliedMigrationLineage`), so its verdict matches what
 * `npm run db:migrate` would enforce — including migration hash integrity and
 * gap detection, not just a timestamp comparison.
 *
 * Usage:
 *   npm run db:check                              # uses DATABASE_URL from .env
 *   npm run db:check -- --env-file .env.production
 *   npm run db:check -- --url-env PROD_DATABASE_URL
 *   DATABASE_URL=postgres://... npm run db:check
 *
 * Exit code: 0 = fully up to date; 1 = pending / not migrated / lineage problem / error.
 */
import { readFileSync } from "node:fs";

import { config as loadDotenv } from "dotenv";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";
import {
  assertAppliedMigrationLineage,
  buildExpectedPrivateDbMigrationLineage,
  type AppliedMigrationLineageRow,
  type ExpectedMigrationLineageEntry,
} from "../src/lib/private-db/migration-lineage";

const MIGRATIONS_FOLDER = "./drizzle";
const JOURNAL_PATH = `${MIGRATIONS_FOLDER}/meta/_journal.json`;

interface MigrationJournal {
  entries: Array<{ tag: string; when: number }>;
}

function getArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function loadExpectedLineage(): {
  expected: ExpectedMigrationLineageEntry[];
  tagByMillis: Map<number, string>;
  finalTag: string;
  finalWhen: number;
} {
  const journal = JSON.parse(
    readFileSync(JOURNAL_PATH, "utf8"),
  ) as MigrationJournal;
  const tagByMillis = new Map(
    journal.entries.map((entry) => [entry.when, entry.tag]),
  );

  const local: ExpectedMigrationLineageEntry[] = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  }).map((migration) => {
    const tag = tagByMillis.get(migration.folderMillis);
    if (!tag) {
      throw new Error(
        `Migration journal is missing a tag for timestamp ${migration.folderMillis}.`,
      );
    }
    return { folderMillis: migration.folderMillis, hash: migration.hash, tag };
  });

  const expected = buildExpectedPrivateDbMigrationLineage(local);
  for (const entry of expected) tagByMillis.set(entry.folderMillis, entry.tag);

  const finalEntry = journal.entries[journal.entries.length - 1];
  if (!finalEntry) {
    throw new Error("Migration journal has no entries.");
  }
  return {
    expected,
    tagByMillis,
    finalTag: finalEntry.tag,
    finalWhen: finalEntry.when,
  };
}

async function fetchAppliedRows(
  databaseUrl: string,
): Promise<{ rows: AppliedMigrationLineageRow[]; tableMissing: boolean }> {
  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));
  try {
    const client = await pool.connect();
    try {
      const present = await client.query<{ present: boolean | null }>(
        "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
      );
      if (present.rows[0]?.present !== true) {
        return { rows: [], tableMissing: true };
      }
      const applied = await client.query<AppliedMigrationLineageRow>(
        "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST, id ASC",
      );
      return { rows: applied.rows, tableMissing: false };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function redactTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(unparseable database URL)";
  }
}

async function main(): Promise<void> {
  const envFile = getArg("--env-file");
  loadDotenv(envFile ? { path: envFile } : {});

  const explicitUrl = getArg("--url");
  const urlEnvName = getArg("--url-env") ?? "DATABASE_URL";
  const databaseUrl = explicitUrl ?? process.env[urlEnvName];

  if (!databaseUrl) {
    console.error(
      `[db-check] No database URL found. Set ${urlEnvName} in your .env, or pass --url / --url-env / --env-file.`,
    );
    process.exit(1);
  }

  const { expected, tagByMillis, finalTag, finalWhen } = loadExpectedLineage();

  console.log(
    `[db-check] Target:                  ${redactTarget(databaseUrl)}`,
  );
  console.log(
    `[db-check] Expected final migration: ${finalTag} (${finalWhen})`,
  );

  let applied: { rows: AppliedMigrationLineageRow[]; tableMissing: boolean };
  try {
    applied = await fetchAppliedRows(databaseUrl);
  } catch (error) {
    console.error(
      `[db-check] Could not query the database: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
    return;
  }

  if (applied.tableMissing) {
    console.log("");
    console.log(
      "❌ NOT MIGRATED — drizzle.__drizzle_migrations does not exist on this database.",
    );
    console.log("   No private-DB migrations have been applied here.");
    process.exit(1);
    return;
  }

  let latestAppliedAt: number;
  try {
    latestAppliedAt = assertAppliedMigrationLineage(expected, applied.rows);
  } catch (error) {
    console.log("");
    console.log(
      "❌ LINEAGE PROBLEM — the applied history does not match the committed migrations:",
    );
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  const pending = expected
    .filter((entry) => !entry.optional && entry.folderMillis > latestAppliedAt)
    .sort((left, right) => left.folderMillis - right.folderMillis);

  const latestTag = tagByMillis.get(latestAppliedAt) ?? String(latestAppliedAt);

  console.log(`[db-check] Applied migrations:       ${applied.rows.length}`);
  console.log(
    `[db-check] Latest applied:           ${latestTag} (${latestAppliedAt})`,
  );
  console.log("");

  if (pending.length === 0) {
    if (latestAppliedAt === finalWhen) {
      console.log(
        `✅ UP TO DATE — migrated through ${finalTag}. Nothing pending.`,
      );
    } else {
      console.log(
        `✅ No pending migrations for this checkout, but the latest applied (${latestTag}) is not the journal's final entry (${finalTag}). Confirm this checkout is on the intended commit.`,
      );
    }
    process.exit(0);
    return;
  }

  console.log(
    `⚠️  PENDING — ${pending.length} migration(s) are committed but NOT applied to this database:`,
  );
  for (const entry of pending) console.log(`     • ${entry.tag}`);
  console.log("");
  console.log(
    "   Run `npm run db:migrate` against this database to apply them.",
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error("[db-check] Unexpected failure", error);
  process.exit(1);
});
