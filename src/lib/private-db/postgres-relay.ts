import "server-only";

import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import { readP407PostgresRelay } from "./p407-postgres-relay";
import { createPostgresRelayStream } from "./postgres-relay-stream";

import {
  P506_RELAY_URL,
  P506_POSTGRES_HOST,
  P506_POSTGRES_PORT,
  P506_POSTGRES_DATABASE,
  P506_POSTGRES_ROLE,
} from "./p506-postgres-relay-pins.mjs";

export function hasP506PostgresRelayBinding(env: Record<string, string | undefined>): boolean {
  return env.P506_POSTGRES_RELAY_URL !== undefined || env.P506_POSTGRES_RELAY_DEPLOYMENT_PROOF !== undefined;
}

function pointsToP506Database(url: URL): boolean {
  const hosts = [url.hostname, ...url.searchParams.getAll("host")];
  if (hosts.some(host => host.toLowerCase().replace(/\.$/u, "") === P506_POSTGRES_HOST)) return true;

  try {
    return decodeURIComponent(url.pathname) === `/${P506_POSTGRES_DATABASE}` ||
      decodeURIComponent(url.username) === P506_POSTGRES_ROLE;
  } catch {
    return false;
  }
}

export function readPostgresRelay(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
) {
  const url = URL.canParse(connectionString) ? new URL(connectionString) : undefined;
  if (!hasP506PostgresRelayBinding(env) && !(url && pointsToP506Database(url))) {
    const relay = readP407PostgresRelay(connectionString, env);
    return relay && { ...relay, qualification: "P4-07" as const };
  }

  try {
    const endpoint = env.P506_POSTGRES_RELAY_URL;
    const proof = env.P506_POSTGRES_RELAY_DEPLOYMENT_PROOF;
    if (env.P407_POSTGRES_RELAY_URL !== undefined || env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF !== undefined ||
      env.P407_CHECKOUT_SCOPE_JSON !== undefined ||
      endpoint !== P506_RELAY_URL || !proof || !/^[0-9a-f]{64}$/u.test(proof) || /^0+$/u.test(proof) ||
      env.VERCEL !== "1" || env.VERCEL_ENV !== "production" ||
      resolveApplicationEnvironment(env) !== "staging") throw new Error();

    if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== P506_POSTGRES_HOST || Number(url.port || P506_POSTGRES_PORT) !== P506_POSTGRES_PORT ||
      decodeURIComponent(url.pathname) !== `/${P506_POSTGRES_DATABASE}` ||
      decodeURIComponent(url.username) !== P506_POSTGRES_ROLE || !url.password || url.hash) throw new Error();
    const channelBinding = url.searchParams.getAll("channel_binding");
    if (url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-full" ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode" && key !== "channel_binding") ||
      channelBinding.length > 1 || channelBinding.length === 1 && channelBinding[0] !== "require") throw new Error();

    return { qualification: "P5-06" as const, stream: () => createPostgresRelayStream({
      endpoint, proof, host: P506_POSTGRES_HOST, port: P506_POSTGRES_PORT,
    }, "P5-06") };
  } catch {
    throw new Error("P5-06 PostgreSQL relay configuration refused");
  }
}
