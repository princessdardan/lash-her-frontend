import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import {
  P506_POSTGRES_DATABASE,
  P506_POSTGRES_HOST,
  P506_POSTGRES_PORT,
  P506_POSTGRES_ROLE,
  P506_RELAY_URL,
} from "@/lib/private-db/p506-postgres-relay-pins.mjs";

type Environment = Record<string, string | undefined>;

const candidateHost = /^lash-her-frontend-staging-[a-z0-9]{9}-dardan-demiris-projects\.vercel\.app$/u;
const sha = /^(?!0+$)[a-f0-9]{40}$/u;
const digest = /^(?!0+$)[a-f0-9]{64}$/u;
const gatewayOrigin = new URL(P506_RELAY_URL).origin.replace(/^wss:/u, "https:");

export function resolveP506CandidateOrigin(env: Environment = process.env): string | undefined {
  if (env.STAGING_P5_06_BUILD_PINS === undefined && env.STAGING_P5_06_MIGRATION_RECEIPT_SHA256 === undefined &&
      env.P506_POSTGRES_RELAY_URL === undefined && env.P506_POSTGRES_RELAY_DEPLOYMENT_PROOF === undefined) return undefined;
  try {
    const host = env.VERCEL_URL;
    if (!host || !candidateHost.test(host) ||
        env.VERCEL !== "1" || env.VERCEL_ENV !== "production" || env.VERCEL_TARGET_ENV !== "production" ||
        resolveApplicationEnvironment(env) !== "staging" ||
        env.API_GATEWAY_STAGING_ORIGIN !== gatewayOrigin ||
        env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" ||
        env.P506_POSTGRES_RELAY_URL !== P506_RELAY_URL || !digest.test(env.P506_POSTGRES_RELAY_DEPLOYMENT_PROOF ?? "") ||
        env.P407_CHECKOUT_SCOPE_JSON || env.P407_POSTGRES_RELAY_URL ||
        env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF || env.AUTH_REDIRECT_PROXY_URL) throw new Error();

    const rawPins = env.STAGING_P5_06_BUILD_PINS ?? "";
    if (!rawPins || rawPins.length > 256) throw new Error();
    const pins = JSON.parse(rawPins);
    if (!pins || Object.keys(pins).sort().join(",") !== "commit,migrationReceiptSha256" ||
        typeof pins.commit !== "string" || !sha.test(pins.commit) || pins.commit !== env.VERCEL_GIT_COMMIT_SHA ||
        typeof pins.migrationReceiptSha256 !== "string" || !digest.test(pins.migrationReceiptSha256) ||
        pins.migrationReceiptSha256 !== env.STAGING_P5_06_MIGRATION_RECEIPT_SHA256) throw new Error();

    for (const name of ["DATABASE_URL", "FRONTEND_WRITER_ADMISSION_DATABASE_URL"]) {
      const url = new URL(env[name] ?? "");
      if (!["postgresql:", "postgres:"].includes(url.protocol) ||
          url.hostname !== P506_POSTGRES_HOST || Number(url.port || P506_POSTGRES_PORT) !== P506_POSTGRES_PORT ||
          decodeURIComponent(url.username) !== P506_POSTGRES_ROLE || !url.password ||
          decodeURIComponent(url.pathname) !== `/${P506_POSTGRES_DATABASE}` || url.hash ||
          url.searchParams.getAll("sslmode").join(",") !== "verify-full" ||
          url.searchParams.getAll("channel_binding").join(",") !== "require" ||
          [...url.searchParams.keys()].some((key) => key !== "sslmode" && key !== "channel_binding")) throw new Error();
    }

    const origin = `https://${host}`;
    if ([env.AUTH_URL, env.NEXTAUTH_URL, env.CUSTOMER_AUTH_URL]
      .some((url) => url && url !== origin && url !== origin + "/")) throw new Error();
    return origin;
  } catch {
    throw new Error("P5-06 candidate origin refused");
  }
}

/** Auth.js derives server-action URLs from forwarded headers when AUTH_URL is
 * absent. Confirm every header it considers against the deployed origin first. */
export function matchesP506OriginHeaders(headers: Pick<Headers, "get">, origin: string): boolean {
  const expected = new URL(origin);
  const forwardedHost = headers.get("x-forwarded-host");
  const forwardedProtocol = headers.get("x-forwarded-proto");
  return headers.get("host") === expected.host &&
    (forwardedHost === null || forwardedHost === expected.host) &&
    (forwardedProtocol === null || forwardedProtocol === "https");
}

export function permitsP506CandidateRequest(
  request: Pick<Request, "url" | "headers">,
  env: Environment = process.env,
): boolean {
  try {
    const origin = resolveP506CandidateOrigin(env);
    return !origin || new URL(request.url).origin === origin && matchesP506OriginHeaders(request.headers, origin);
  } catch {
    return false;
  }
}
