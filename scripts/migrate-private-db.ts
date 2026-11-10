import "dotenv/config";

import { readFileSync } from "node:fs";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { Pool, type PoolClient } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";
import {
  assertAppliedMigrationLineage,
  buildExpectedPrivateDbMigrationLineage,
  type AppliedMigrationLineageRow,
} from "../src/lib/private-db/migration-lineage";

const KNOWN_TARGETS = new Set(["local", "staging", "production"]);
const MIGRATION_LOCK_NAME = "lash-her:private-db:migrations";
const MIGRATIONS_FOLDER = "./drizzle";
const MIGRATION_JOURNAL_PATH = `${MIGRATIONS_FOLDER}/meta/_journal.json`;

interface MigrationJournal {
  entries: Array<{
    tag: string;
    when: number;
  }>;
}

interface NamedMigrationMeta extends MigrationMeta {
  tag: string;
}

async function main(): Promise<void> {
  const databaseUrl = verifyLocalMigrationUrl(getCheckoutDatabaseUrl());
  const migrations = readNamedMigrationFiles();

  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    await migrateSequentially(client, migrations);
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Drizzle's PostgreSQL migrator wraps every pending migration in one
 * transaction. PostgreSQL requires an enum value added by one migration to be
 * committed before a later migration can use it in an index predicate. Apply
 * each journal entry in its own transaction while retaining Drizzle's journal
 * format so both clean installs and incremental deploys are safe.
 */
async function migrateSequentially(
  client: PoolClient,
  migrations: NamedMigrationMeta[],
): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [
    MIGRATION_LOCK_NAME,
  ]);

  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const applied = await client.query<AppliedMigrationLineageRow>(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST, id ASC",
    );
    let latestAppliedAt = assertAppliedMigrationLineage(
      buildExpectedPrivateDbMigrationLineage(migrations),
      applied.rows,
    );

    for (const migration of migrations) {
      if (migration.folderMillis <= latestAppliedAt) {
        continue;
      }

      console.info(`[private-db] Applying migration ${migration.tag}`);

      try {
        await applyMigration(client, migration);
      } catch (error) {
        throw new Error(
          `Migration ${migration.tag} (${migration.folderMillis}) failed`,
          { cause: error },
        );
      }

      console.info(`[private-db] Applied migration ${migration.tag}`);
      latestAppliedAt = migration.folderMillis;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
      MIGRATION_LOCK_NAME,
    ]);
  }
}

async function applyMigration(
  client: PoolClient,
  migration: NamedMigrationMeta,
): Promise<void> {
  await client.query("BEGIN");

  try {
    for (const statement of migration.sql) {
      await client.query(statement);
    }

    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [migration.hash, migration.folderMillis],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function readNamedMigrationFiles(): NamedMigrationMeta[] {
  const journal = JSON.parse(
    readFileSync(MIGRATION_JOURNAL_PATH, "utf8"),
  ) as MigrationJournal;
  const tagsByTimestamp = new Map(
    journal.entries.map((entry) => [entry.when, entry.tag]),
  );

  const migrations = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  }).map((migration) => {
    const tag = tagsByTimestamp.get(migration.folderMillis);

    if (!tag) {
      throw new Error(
        `Migration journal is missing a tag for timestamp ${migration.folderMillis}.`,
      );
    }

    return {
      ...migration,
      tag,
    };
  });
  const maximumTag = process.env.PRIVATE_DB_MIGRATION_MAX_TAG?.trim();

  if (!maximumTag) {
    return migrations;
  }

  if (process.env.CI !== "true") {
    throw new Error(
      "PRIVATE_DB_MIGRATION_MAX_TAG is restricted to CI migration-upgrade verification.",
    );
  }

  const maximumIndex = migrations.findIndex(
    (migration) => migration.tag === maximumTag,
  );
  if (maximumIndex < 0) {
    throw new Error(`Unknown PRIVATE_DB_MIGRATION_MAX_TAG: ${maximumTag}`);
  }

  return migrations.slice(0, maximumIndex + 1);
}

function getCheckoutDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined) {
    throw new Error("Missing env var: DATABASE_URL");
  }

  return databaseUrl;
}

function verifyLocalMigrationUrl(databaseUrl: string): string {
  const target = process.env.PRIVATE_DB_MIGRATION_TARGET;

  if (!target || !KNOWN_TARGETS.has(target)) {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_TARGET to local, staging, or production before running private DB migrations.",
    );
  }

  if (target !== "local") {
    throw new Error("Release targets require the reviewed operator frontend migration command: ops/platform/frontend-migration.mjs");
  }

  const parsedUrl = parseDatabaseUrl(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw new Error("Local migrations require a PostgreSQL connection URL.");
  }
  if (parsedUrl.searchParams.has("host") || parsedUrl.searchParams.has("port")) {
    throw new Error("Local migration connection host and port must be in the URL authority.");
  }
  if (!parsedUrl.pathname || parsedUrl.pathname === "/") {
    throw new Error("Local migrations require a database name in the connection URL.");
  }
  const host = parsedUrl.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new Error("Local migrations require an isolated loopback database; remote targets use the operator release command");
  }
  const expectedHost =
    process.env.PRIVATE_DB_MIGRATION_HOST?.trim().toLowerCase();

  if (!expectedHost) {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_HOST to the verified database host before running migrations.",
    );
  }

  if (host !== expectedHost) {
    throw new Error(
      `DATABASE_URL host mismatch: expected ${expectedHost}, received ${host}.`,
    );
  }
  // Keep an omitted port independent of any ambient PGPORT setting.
  if (!parsedUrl.port) parsedUrl.port = "5432";
  return parsedUrl.href;
}

function parseDatabaseUrl(databaseUrl: string): URL {
  try {
    return new URL(databaseUrl);
  } catch {
    throw new Error(
      "Malformed env var: DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }
}

main().catch((error: unknown) => {
  console.error("[private-db] Migration failed", error);
  process.exit(1);
});
