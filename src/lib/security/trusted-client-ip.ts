import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type BookingAbuseScope =
  | "active-holds"
  | "availability"
  | "hold-attempts";

interface HeaderReader {
  get(name: string): string | null;
}

interface PlatformEnvironment {
  [key: string]: string | undefined;
  VERCEL?: string;
  VERCEL_ENV?: string;
}

export function getTrustedClientIp(
  headers: HeaderReader,
  environment: PlatformEnvironment = process.env,
): string | null {
  const vercelForwarded = firstValidIp(
    headers.get("x-vercel-forwarded-for"),
  );
  if (vercelForwarded) return vercelForwarded;
  if (isVercelLaunchEnvironment(environment)) return null;

  const forwarded = headers.get("x-forwarded-for");
  const forwardedClient = firstValidIp(forwarded);
  if (forwardedClient) return forwardedClient;

  const realIp = headers.get("x-real-ip")?.trim() ?? "";
  return isIP(realIp) !== 0 ? realIp.toLowerCase() : null;
}

export function buildBookingAbuseKey(input: {
  headers: HeaderReader;
  environment?: PlatformEnvironment;
  scope: BookingAbuseScope;
  subject: string;
}): string | null {
  const clientIp = getTrustedClientIp(input.headers, input.environment);
  if (!clientIp && isVercelLaunchEnvironment(input.environment ?? process.env)) {
    return null;
  }
  const clientDigest = digest(`client:${clientIp ?? "local-unavailable"}`);
  const subjectDigest = digest(
    `subject:${input.subject.trim().toLowerCase() || "unavailable"}`,
  );

  return `booking:abuse:${input.scope}:${clientDigest}:${subjectDigest}`;
}

function firstValidIp(value: string | null): string | null {
  const candidate = value?.split(",", 1)[0]?.trim() ?? "";
  return isIP(candidate) !== 0 ? candidate.toLowerCase() : null;
}

function isVercelLaunchEnvironment(environment: PlatformEnvironment): boolean {
  return environment.VERCEL === "1"
    || environment.VERCEL_ENV === "production"
    || environment.VERCEL_ENV === "preview";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
