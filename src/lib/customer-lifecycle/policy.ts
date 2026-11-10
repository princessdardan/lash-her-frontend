import { parseBoundary } from "@/lib/api-integration/boundary-validation";
import type { components } from "@/lib/api-integration/generated/boundaries";

export type AccountCommand = components["schemas"]["AccountLifecycleCommand"];
export type AccountAction = AccountCommand["action"];
export type AccountReceiver = "course" | "community";
export const ACCOUNT_RECEIVERS: readonly AccountReceiver[] = ["course", "community"];
export const EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
// A new database session proves a completed Google/email sign-in. Silent session
// reads and extensions never refresh this timestamp.
export const ACCOUNT_FRESH_AUTH_MS = 15 * 60 * 1_000;
export const canonicalUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);

export class AccountLifecycleError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function parseAccountCommand(value: unknown): AccountCommand {
  return parseBoundary("AccountLifecycleCommand", value);
}

export function parseAccountRequest(value: unknown): { action: AccountAction; idempotencyKey: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "action,idempotencyKey") throw new AccountLifecycleError(400, "invalid_request");
  const record = value as Record<string, unknown>;
  if (!canonicalUuid(record.idempotencyKey) || !["suspend", "restore", "export", "delete"].includes(record.action as string)) throw new AccountLifecycleError(400, "invalid_request");
  return { action: record.action as AccountAction, idempotencyKey: record.idempotencyKey };
}

export function assertFreshCustomerSession(createdAt: Date, now: Date): void {
  const age = now.getTime() - createdAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > ACCOUNT_FRESH_AUTH_MS) throw new AccountLifecycleError(403, "fresh_sign_in_required");
}
