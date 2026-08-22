import type { PoolConfig } from "pg";

export function createPrivateDbPoolConfig(
  connectionString: string,
): PoolConfig {
  const normalizedConnectionString =
    normalizeConnectionString(connectionString);
  const poolTuning = resolvePoolTuning(normalizedConnectionString);

  if (hasSslMode(normalizedConnectionString)) {
    return { connectionString: normalizedConnectionString, ...poolTuning };
  }

  return {
    connectionString: normalizedConnectionString,
    ssl: { rejectUnauthorized: true },
    ...poolTuning,
  };
}

type PrivateDbPoolTuning = Required<
  Pick<
    PoolConfig,
    "max" | "idleTimeoutMillis" | "connectionTimeoutMillis" | "allowExitOnIdle"
  >
>;

/**
 * Serverless-aware pool limits. Each concurrent function instance holds its own
 * pool, so the node-postgres defaults (`max: 10`, `connectionTimeoutMillis: 0`
 * i.e. wait forever) let a launch-day traffic spike exhaust Postgres
 * `max_connections` or hang checkout indefinitely on the acquire queue. Behind a
 * transaction pooler (Neon/Supabase `-pooler`, pgBouncer) each instance needs
 * only a couple of connections; against a direct endpoint allow more but stay
 * bounded, and always fail fast rather than hang.
 */
function resolvePoolTuning(connectionString: string): PrivateDbPoolTuning {
  const usesTransactionPooler = /-pooler|pgbouncer|pooler\./i.test(
    connectionString,
  );

  return {
    max: usesTransactionPooler ? 3 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  };
}

function normalizeConnectionString(connectionString: string): string {
  let url: URL;

  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
    return url.toString();
  }

  return connectionString;
}

function hasSslMode(connectionString: string): boolean {
  try {
    return new URL(connectionString).searchParams.has("sslmode");
  } catch {
    return false;
  }
}
