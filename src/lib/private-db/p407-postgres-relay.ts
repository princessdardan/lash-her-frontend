import "server-only";

import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import { createPostgresRelayStream, type PostgresRelaySocketConfig } from "@/lib/private-db/postgres-relay-stream";

const RELAY_URL = "wss://api-p407.lashher.com/internal/p4-07/postgres";
const POSTGRES_HOST = "p4-07-db.lashher.com";
const POSTGRES_PORT = 5432;
export const P407_POSTGRES_DATABASE = "lash_her_p407_frontend";
export const P407_POSTGRES_ROLE = "lash_her_p407_frontend_runtime";

export function readP407PostgresRelay(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
) {
  const endpoint = env.P407_POSTGRES_RELAY_URL;
  const proof = env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF;
  if (endpoint === undefined && proof === undefined) {
    if (URL.canParse(connectionString) && new URL(connectionString).hostname === POSTGRES_HOST) {
      throw new Error("P4-07 PostgreSQL relay configuration refused");
    }
    return undefined;
  }

  try {
    if (endpoint !== RELAY_URL || !proof || !/^[0-9a-f]{64}$/u.test(proof) || /^0+$/u.test(proof) ||
      env.VERCEL !== "1" || env.VERCEL_ENV !== "production" ||
      resolveApplicationEnvironment(env) !== "staging") throw new Error();
    const url = new URL(connectionString);
    const options = [...url.searchParams.keys()];
    const channelBinding = url.searchParams.getAll("channel_binding");
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== POSTGRES_HOST || Number(url.port || 5432) !== POSTGRES_PORT ||
      decodeURIComponent(url.pathname) !== `/${P407_POSTGRES_DATABASE}` ||
      decodeURIComponent(url.username) !== P407_POSTGRES_ROLE || !url.password || url.hash ||
      url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-full" ||
      options.some((key) => key !== "sslmode" && key !== "channel_binding") ||
      channelBinding.length > 1 || channelBinding.length === 1 && channelBinding[0] !== "require") throw new Error();
    return { stream: () => createP407PostgresStream({
      endpoint, proof, host: POSTGRES_HOST, port: POSTGRES_PORT,
    }) };
  } catch {
    throw new Error("P4-07 PostgreSQL relay configuration refused");
  }
}

export function createP407PostgresStream(
  config: PostgresRelaySocketConfig,
  getWorkloadToken?: () => Promise<string>,
) {
  return createPostgresRelayStream(config, "P4-07", getWorkloadToken);
}
