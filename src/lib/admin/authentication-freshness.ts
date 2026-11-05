import { AdminAuthenticationFreshnessError } from "./types";

export function assertFreshAdminAuthenticationTimestamp(authenticatedAt: unknown, now: number, maxAgeMs: number): Date {
  if (typeof authenticatedAt !== "number" || !Number.isSafeInteger(authenticatedAt) || authenticatedAt <= 0 ||
    !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new AdminAuthenticationFreshnessError("required");
  const instant = authenticatedAt * 1_000;
  const age = now - instant;
  if (!Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime()) || age < 0) throw new AdminAuthenticationFreshnessError("required");
  if (age > maxAgeMs) throw new AdminAuthenticationFreshnessError("expired");
  return new Date(instant);
}
