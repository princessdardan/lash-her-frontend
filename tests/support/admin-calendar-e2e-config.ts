export const ADMIN_CALENDAR_E2E_AUTH_SECRET =
  "calendar-e2e-auth-secret-not-for-production-2026";
export const ADMIN_CALENDAR_E2E_CREDENTIAL_KEY =
  "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
export const ADMIN_CALENDAR_E2E_REDIS_ORIGIN = "https://e2e-redis.invalid";

export function getAdminCalendarE2EDatabaseUrl(): string | null {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    return null;
  }

  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  ) {
    throw new Error(
      "The admin calendar Playwright fixture cannot run in production.",
    );
  }

  const url = new URL(value);
  const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    !isLocal &&
    process.env.BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_DATABASE !== "isolated"
  ) {
    throw new Error(
      "Remote TEST_DATABASE_URL use requires BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_DATABASE=isolated.",
    );
  }

  const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (
    runtimeDatabaseUrl &&
    isSameDatabaseTarget(url, new URL(runtimeDatabaseUrl)) &&
    process.env.BOOKING_ADMIN_E2E_ALLOW_RUNTIME_DATABASE_MATCH !== "isolated"
  ) {
    throw new Error(
      "TEST_DATABASE_URL matches DATABASE_URL; explicit isolated-test confirmation is required.",
    );
  }

  if (isLocal && !url.searchParams.has("sslmode")) {
    url.searchParams.set("sslmode", "disable");
  }

  return url.toString();
}

function isSameDatabaseTarget(first: URL, second: URL): boolean {
  return (
    first.hostname === second.hostname &&
    first.port === second.port &&
    first.pathname === second.pathname &&
    first.username === second.username
  );
}
