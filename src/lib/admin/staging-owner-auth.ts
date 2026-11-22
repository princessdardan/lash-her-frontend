import "server-only";

import { cookies, headers } from "next/headers";
import { getAdminOwnerEmails } from "@/lib/env/admin";
import { getApplicationEnvironment } from "@/lib/env/application-environment.server";
import { INTERACTIVE_COOKIE, INTERACTIVE_HEADER } from "@/lib/writer-admission/interactive-proof";

export const STAGING_OWNER_ORIGIN = "https://staging.lashher.com";
const host = new URL(STAGING_OWNER_ORIGIN).host;

export function isAllowedStagingOwner(email: string): boolean {
  const allowed = getAdminOwnerEmails();
  return allowed.size === 1 && allowed.has(email.trim().toLowerCase());
}

export async function stagingOwnerRequest(): Promise<boolean> {
  if (process.env.STAGING_ADMIN_GOOGLE_ENABLED !== "true" || process.env.APP_ENV !== "staging" ||
      process.env.VERCEL_ENV !== "production" || process.env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" ||
      process.env.AUTH_URL !== STAGING_OWNER_ORIGIN ||
      (process.env.NEXTAUTH_URL !== undefined && process.env.NEXTAUTH_URL !== STAGING_OWNER_ORIGIN)) return false;
  if (getApplicationEnvironment() !== "staging") return false;
  const requestHeaders = await headers();
  return requestHeaders.get("host") === host && !requestHeaders.has(INTERACTIVE_HEADER) &&
    !(await cookies()).has(INTERACTIVE_COOKIE);
}

export function canBootstrapStagingOwner(now = Date.now()): boolean {
  const value = process.env.STAGING_ADMIN_FIRST_OWNER_UNTIL ?? "";
  return /^\d{10}$/u.test(value) && Number(value) * 1000 > now;
}
