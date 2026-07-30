import { AdminAuthError } from "./types";

export type AdminMutationFailureReason =
  | "conflict"
  | "dependency_unavailable"
  | "insufficient_permission"
  | "not_found"
  | "operation_failed"
  | "validation_failed";

export async function executeAdminMutationAttempt<T>(
  execute: () => Promise<T>,
  recordFailure: (error: unknown) => Promise<void>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    try {
      await recordFailure(error);
    } catch {
      // Activity-history persistence must not replace the original failure.
    }
    throw error;
  }
}

export function classifyAdminMutationFailure(error: unknown): {
  outcome: "denied" | "failure";
  reason: AdminMutationFailureReason;
} {
  if (error instanceof AdminAuthError) {
    return { outcome: "denied", reason: "insufficient_permission" };
  }

  const postgresCode = getPostgresErrorCode(error);
  if (
    postgresCode === "23505" ||
    postgresCode === "40001" ||
    postgresCode === "40P01"
  ) {
    return { outcome: "failure", reason: "conflict" };
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("not found")) {
      return { outcome: "failure", reason: "not_found" };
    }
    if (
      /(?:google|square|calendar access|reconnect|provider).*?(?:failed|unavailable|verify|verified|access)/i.test(
        message,
      )
    ) {
      return { outcome: "failure", reason: "dependency_unavailable" };
    }
    if (
      /(?:invalid|required|must|cannot|can't|outside|not active|not owned|not eligible)/i.test(
        message,
      )
    ) {
      return { outcome: "failure", reason: "validation_failed" };
    }
  }

  return { outcome: "failure", reason: "operation_failed" };
}

export function getCommittedAdminAuditOutcome(
  action: string,
): "failure" | "success" {
  return action === "calendar_connection_authorization_failed" ||
    action === "employee_calendar_authorization_failed"
    ? "failure"
    : "success";
}

function getPostgresErrorCode(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
    if (typeof candidate !== "object") {
      return null;
    }
    if ("code" in candidate && typeof candidate.code === "string") {
      return candidate.code;
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}
