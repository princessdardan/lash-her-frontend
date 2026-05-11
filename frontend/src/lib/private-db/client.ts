import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getCheckoutDatabaseUrl } from "@/lib/env/private-checkout";

import * as schema from "./schema";

let pool: Pool | null = null;
const createPrivateDb = () => drizzle({
  client: getPool(),
  schema,
});
let db: ReturnType<typeof createPrivateDb> | null = null;

function getPool(): Pool {
  if (pool !== null) {
    return pool;
  }

  pool = new Pool({
    connectionString: getCheckoutDatabaseUrl(),
    ssl: { rejectUnauthorized: true },
  });

  return pool;
}

export function getPrivateDb(): ReturnType<typeof createPrivateDb> {
  if (db !== null) {
    return db;
  }

  db = createPrivateDb();
  return db;
}

export async function closePrivateDbPool(): Promise<void> {
  if (pool === null) {
    return;
  }

  await pool.end();
  pool = null;
  db = null;
}
