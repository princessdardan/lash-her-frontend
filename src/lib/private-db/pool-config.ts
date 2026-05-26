import type { PoolConfig } from "pg";

export function createPrivateDbPoolConfig(connectionString: string): PoolConfig {
  const normalizedConnectionString = normalizeConnectionString(connectionString);

  if (hasSslMode(normalizedConnectionString)) {
    return { connectionString: normalizedConnectionString };
  }

  return {
    connectionString: normalizedConnectionString,
    ssl: { rejectUnauthorized: true },
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
