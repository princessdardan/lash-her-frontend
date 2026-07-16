import "dotenv/config";

import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { Pool, type PoolClient } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";

const KNOWN_TARGETS = new Set(["local", "staging", "production"]);
const MIGRATION_LOCK_NAME = "lash-her:private-db:migrations";

async function main(): Promise<void> {
  const databaseUrl = getCheckoutDatabaseUrl();
  assertMigrationTarget(databaseUrl);

  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    await migrateSequentially(
      client,
      readMigrationFiles({ migrationsFolder: "./drizzle" }),
    );
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
  migrations: MigrationMeta[],
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

    const latest = await client.query<{ created_at: string | null }>(
      "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC NULLS LAST LIMIT 1",
    );
    let latestAppliedAt = Number(latest.rows[0]?.created_at ?? 0);

    for (const migration of migrations) {
      if (migration.folderMillis <= latestAppliedAt) {
        continue;
      }

      await applyMigration(client, migration);
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
  migration: MigrationMeta,
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

function getCheckoutDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined) {
    throw new Error("Missing env var: DATABASE_URL");
  }

  return databaseUrl;
}

function assertMigrationTarget(databaseUrl: string): void {
  const target = process.env.PRIVATE_DB_MIGRATION_TARGET;

  if (!target || !KNOWN_TARGETS.has(target)) {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_TARGET to local, staging, or production before running private DB migrations.",
    );
  }

  const parsedUrl = parseDatabaseUrl(databaseUrl);
  const host = parsedUrl.hostname.toLowerCase();
  const expectedHost = process.env.PRIVATE_DB_MIGRATION_HOST?.trim().toLowerCase();

  if (!expectedHost) {
    throw new Error("Set PRIVATE_DB_MIGRATION_HOST to the verified database host before running migrations.");
  }

  if (host !== expectedHost) {
    throw new Error(`DATABASE_URL host mismatch: expected ${expectedHost}, received ${host}.`);
  }

  if (target === "production" && process.env.PRIVATE_DB_MIGRATION_CONFIRM !== "production") {
    throw new Error(
      "Production migrations require PRIVATE_DB_MIGRATION_CONFIRM=production after backup/PITR and approval checks.",
    );
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  try {
    return new URL(databaseUrl);
  } catch {
    throw new Error("Malformed env var: DATABASE_URL must be a valid PostgreSQL URL.");
  }
}

main().catch((error: unknown) => {
  console.error("[private-db] Migration failed", error);
  process.exit(1);
});
