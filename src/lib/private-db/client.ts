import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getCheckoutDatabaseUrl } from "@/lib/env/private-checkout";

import { createPrivateDbPoolConfig } from "./pool-config";
import { readPostgresRelay } from "./postgres-relay";
import * as schema from "./schema";

let pool: Pool | null = null;
const createPrivateDb = () =>
  drizzle({
    client: getPool(),
    schema,
  });
let db: ReturnType<typeof createPrivateDb> | null = null;

function getPool(): Pool {
  if (pool !== null) {
    return pool;
  }

  const databaseUrl = getCheckoutDatabaseUrl();
  const config = createPrivateDbPoolConfig(databaseUrl);
  const relay = readPostgresRelay(databaseUrl);
  pool = new Pool(
    relay
      ? {
          ...config,
          // pg merges URI sslmode options after structured options. Use the structured
          // identity so the dedicated staging CA governs the inner PostgreSQL session.
          ...(relay.qualification === "P6-00" && {
            connectionString: undefined,
            ...relay.connection,
          }),
          stream: relay.stream,
          enableChannelBinding: true,
          max: 3,
          maxLifetimeSeconds: 120,
          idleTimeoutMillis: 20_000,
          statement_timeout: 10_000,
          // The bounded relay has eight slots across all serverless instances.
          // Return the tunnel after each checkout instead of waiting for idle
          // timers that may pause with the function instance.
          ...(relay.qualification !== "P4-07" && { max: 2, maxUses: 1 }),
        }
      : config,
  );
  if (relay)
    pool.on("error", () => {
      // An expired relay closes idle clients. pg removes them before emitting.
      console.error(
        `${relay.qualification} PostgreSQL relay idle connection closed`,
      );
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
