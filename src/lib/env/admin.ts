import "server-only";

type AdminEnv = Partial<
  Pick<NodeJS.ProcessEnv, "ADMIN_OWNER_EMAILS" | "NODE_ENV" | "VERCEL_ENV">
>;

export function getAdminOwnerEmails(env: AdminEnv = process.env): Set<string> {
  return parseAdminOwnerEmails(env.ADMIN_OWNER_EMAILS);
}

export function isAdminBootstrapOwner(
  email: string,
  ownerEmails: ReadonlySet<string> = getAdminOwnerEmails(),
): boolean {
  return ownerEmails.has(normalizeAdminEmail(email));
}

export function getAdminEnvironmentLabel(
  env: AdminEnv = process.env,
): "local" | "preview" | "production" | "unknown" {
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

export function parseAdminOwnerEmails(value: string | undefined): Set<string> {
  const emails = new Set<string>();

  for (const entry of (value ?? "").split(",")) {
    const normalized = normalizeAdminEmail(entry);

    if (normalized.length > 0) {
      emails.add(normalized);
    }
  }

  return emails;
}
