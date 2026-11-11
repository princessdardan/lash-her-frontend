import { AdminAuthenticationFreshnessError } from "./types";
import { writerFirstOwnerDiscoveryWindowSha256, writerFirstOwnerWindowSha256, type WriterFirstOwner,
  type WriterFirstOwnerDiscovery } from "@/lib/writer-admission/context";

export function assertFreshAdminAuthenticationTimestamp(authenticatedAt: unknown, now: number, maxAgeMs: number): Date {
  if (typeof authenticatedAt !== "number" || !Number.isSafeInteger(authenticatedAt) || authenticatedAt <= 0 ||
    !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new AdminAuthenticationFreshnessError("required");
  const instant = authenticatedAt * 1_000;
  const age = now - instant;
  if (!Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime()) || age < 0) throw new AdminAuthenticationFreshnessError("required");
  if (age > maxAgeMs) throw new AdminAuthenticationFreshnessError("expired");
  return new Date(instant);
}

export function assertFirstOwnerGoogleAuthentication(selection: WriterFirstOwner, authenticatedAt: unknown,
  windowSha256: unknown, now: number): void {
  const authenticated = assertFreshAdminAuthenticationTimestamp(authenticatedAt, now, 240_000);
  if (windowSha256 !== writerFirstOwnerWindowSha256(selection) || authenticated.getTime() < selection.startedAt * 1000) {
    throw new AdminAuthenticationFreshnessError("required");
  }
}

export function assertFirstOwnerDiscoveryGoogleAuthentication(selection: WriterFirstOwnerDiscovery, authenticatedAt: unknown,
  windowSha256: unknown, now: number): void {
  const authenticated = assertFreshAdminAuthenticationTimestamp(authenticatedAt, now, 240_000);
  if (windowSha256 !== writerFirstOwnerDiscoveryWindowSha256(selection) || authenticated.getTime() < selection.startedAt * 1000) {
    throw new AdminAuthenticationFreshnessError("required");
  }
}
