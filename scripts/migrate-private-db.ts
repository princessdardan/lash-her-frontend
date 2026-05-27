import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";
import * as schema from "../src/lib/private-db/schema";

const KNOWN_TARGETS = new Set(["local", "staging", "production"]);

async function main(): Promise<void> {
  const databaseUrl = getCheckoutDatabaseUrl();
  assertMigrationTarget(databaseUrl);

  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));

  try {
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
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
