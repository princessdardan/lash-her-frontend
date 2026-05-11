import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/lib/private-db/schema";

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: getCheckoutDatabaseUrl(),
    ssl: { rejectUnauthorized: true },
  });

  try {
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

function getCheckoutDatabaseUrl(): string {
  const databaseUrl = process.env.CHECKOUT_DATABASE_URL ?? process.env.DATABASE_URL;

  if (databaseUrl === undefined) {
    throw new Error("Missing env var: CHECKOUT_DATABASE_URL");
  }

  return databaseUrl;
}

main().catch((error: unknown) => {
  console.error("[private-db] Migration failed", error);
  process.exit(1);
});
