import "dotenv/config";

import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";

const KNOWN_TARGETS = new Set(["local", "staging", "production"]);

const INDEX_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointment_holds_square_cof_checkout_order_id_idx"
   ON "appointment_holds" USING btree ("checkout_order_id", "id")
   WHERE "appointment_holds"."payment_provider" = 'square'
     AND "appointment_holds"."card_on_file_status" IS NOT NULL
     AND "appointment_holds"."square_payment_link_id" IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "checkout_orders_paid_square_appointment_not_booked_idx"
   ON "checkout_orders" USING btree ("paid_at", "id", "order_id")
   WHERE "checkout_orders"."status" = 'paid'
     AND "checkout_orders"."payment_provider" = 'square'
     AND "checkout_orders"."purpose" IN ('appointment_deposit', 'appointment_full', 'appointment_custom_partial')
     AND "checkout_orders"."calendar_finalization_status" NOT IN ('not_required', 'booked', 'manual_rebooked')`,
];

async function main(): Promise<void> {
  const databaseUrl = getCheckoutDatabaseUrl();
  assertMigrationTarget(databaseUrl);

  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));

  try {
    for (const statement of INDEX_STATEMENTS) {
      await pool.query(statement);
    }
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
      "Set PRIVATE_DB_MIGRATION_TARGET to local, staging, or production before creating private DB indexes.",
    );
  }

  const parsedUrl = parseDatabaseUrl(databaseUrl);
  const host = parsedUrl.hostname.toLowerCase();
  const expectedHost =
    process.env.PRIVATE_DB_MIGRATION_HOST?.trim().toLowerCase();

  if (!expectedHost) {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_HOST to the verified database host before creating private DB indexes.",
    );
  }

  if (host !== expectedHost) {
    throw new Error(
      `DATABASE_URL host mismatch: expected ${expectedHost}, received ${host}.`,
    );
  }

  if (
    target === "production" &&
    process.env.PRIVATE_DB_MIGRATION_CONFIRM !== "production"
  ) {
    throw new Error(
      "Production index creation requires PRIVATE_DB_MIGRATION_CONFIRM=production after backup/PITR and approval checks.",
    );
  }
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
  console.error(
    "[private-db] Payment reconciliation index creation failed",
    error,
  );
  process.exit(1);
});
