import "server-only";

import type { AdminRole } from "@/lib/private-db/schema";

export interface AdminEmailAllowlists {
  ownerEmails: Set<string>;
  operatorEmails: Set<string>;
}

type AdminEnv = Partial<Pick<NodeJS.ProcessEnv, "ADMIN_OWNER_EMAILS" | "ADMIN_OPERATOR_EMAILS" | "NODE_ENV" | "VERCEL_ENV">>;

export function getAdminEmailAllowlists(env: AdminEnv = process.env): AdminEmailAllowlists {
  return parseAdminEmailAllowlists(env);
}

export function parseAdminEmailAllowlists(env: AdminEnv): AdminEmailAllowlists {
  return {
    ownerEmails: parseEmailSet(env.ADMIN_OWNER_EMAILS),
    operatorEmails: parseEmailSet(env.ADMIN_OPERATOR_EMAILS),
  };
}

export function resolveAllowedAdminRole(
  email: string,
  allowlists: AdminEmailAllowlists,
): AdminRole | null {
  const normalized = normalizeAdminEmail(email);

  if (allowlists.ownerEmails.has(normalized)) {
    return "owner";
  }

  if (allowlists.operatorEmails.has(normalized)) {
    return "operator";
  }

  return null;
}

export function getAdminEnvironmentLabel(env: AdminEnv = process.env): "local" | "preview" | "production" | "unknown" {
  if (env.VERCEL_ENV === "production") {
    return "production";
  }

  if (env.VERCEL_ENV === "preview") {
    return "preview";
  }

  if (env.NODE_ENV === "development") {
    return "local";
  }

  return "unknown";
}

export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseEmailSet(value: string | undefined): Set<string> {
  const emails = new Set<string>();

  for (const entry of (value ?? "").split(",")) {
    const normalized = normalizeAdminEmail(entry);

    if (normalized.length > 0) {
      emails.add(normalized);
    }
  }

  return emails;
}
