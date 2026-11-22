import "server-only";

import { sql } from "drizzle-orm";
import { getCheckoutDatabaseUrl } from "@/lib/env/private-checkout";
import { getPrivateDb } from "./client";
import {
  P407_POSTGRES_DATABASE, P407_POSTGRES_ROLE, readP407PostgresRelay,
} from "./p407-postgres-relay";

export async function runP407PostgresRelayProbe(): Promise<void> {
  if (!readP407PostgresRelay(getCheckoutDatabaseUrl())) throw new Error("P4-07 PostgreSQL relay probe refused");
  await getPrivateDb().transaction(async (tx) => {
    const { rows: [row] } = await tx.execute<{ allowed: boolean }>(sql`
      select coalesce(
        current_database() = ${P407_POSTGRES_DATABASE}
        and current_user = ${P407_POSTGRES_ROLE}
        and current_setting('server_version_num')::int / 10000 = 18
        and current_setting('transaction_read_only') = 'on'
        and (select ssl from pg_stat_ssl where pid = pg_backend_pid()),
        false
      ) as allowed
    `);
    if (row?.allowed !== true) throw new Error("P4-07 PostgreSQL relay probe refused");
  }, { accessMode: "read only" });
}
