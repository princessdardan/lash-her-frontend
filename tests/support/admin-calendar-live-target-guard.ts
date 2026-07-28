export const ADMIN_CALENDAR_LIVE_TARGET_CONFIRMATION =
  "mutate-isolated-live-calendar";

interface AdminCalendarLiveTargetEnvironment {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}

interface AssertAdminCalendarLiveTargetInput {
  baseUrl: string;
  confirmedIsolatedOrigin?: string;
  confirmation?: string;
  environment: AdminCalendarLiveTargetEnvironment;
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"]);
const KNOWN_PRODUCTION_HOSTNAMES = new Set([
  "lash-her-frontend.vercel.app",
  "lashher.com",
  "www.lashher.com",
]);
const PRODUCTION_LIKE_HOST_LABELS = new Set([
  "prod",
  "production",
  "preview",
  "staging",
  "www",
]);
const ISOLATED_TEST_HOST_LABELS = new Set([
  "e2e",
  "sandbox",
  "test",
  "testing",
]);

/**
 * Validates the live smoke destination before any authenticated browser
 * context can mutate calendar assignments.
 */
export function assertAdminCalendarLiveTarget(
  input: AssertAdminCalendarLiveTargetInput,
): string {
  const target = parseOrigin(input.baseUrl, "BOOKING_ADMIN_E2E_BASE_URL");

  if (
    input.environment.NODE_ENV === "production" ||
    input.environment.VERCEL_ENV === "production" ||
    input.environment.VERCEL_ENV === "preview"
  ) {
    throw new Error(
      "The admin calendar live smoke cannot run in a production-like runtime.",
    );
  }

  const hostname = target.hostname.toLowerCase();
  const hostnameLabels = hostname.split(/[.-]/);
  if (
    KNOWN_PRODUCTION_HOSTNAMES.has(hostname) ||
    hostnameLabels.some((label) => PRODUCTION_LIKE_HOST_LABELS.has(label))
  ) {
    throw new Error(
      `The admin calendar live smoke refuses production-like target ${target.origin}.`,
    );
  }

  const isLocal = LOCAL_HOSTNAMES.has(hostname);
  if (!isLocal) {
    if (target.protocol !== "https:") {
      throw new Error(
        "A remote admin calendar live smoke target must use HTTPS.",
      );
    }
    if (!hostnameLabels.some((label) => ISOLATED_TEST_HOST_LABELS.has(label))) {
      throw new Error(
        `The admin calendar live smoke refuses arbitrary remote target ${target.origin}; use a host explicitly named for isolated e2e, test, or sandbox use.`,
      );
    }
  }

  if (!input.confirmedIsolatedOrigin?.trim()) {
    throw new Error(
      "Set BOOKING_ADMIN_E2E_ISOLATED_LIVE_ORIGIN to the exact isolated target origin.",
    );
  }

  const confirmedTarget = parseOrigin(
    input.confirmedIsolatedOrigin,
    "BOOKING_ADMIN_E2E_ISOLATED_LIVE_ORIGIN",
  );
  if (confirmedTarget.origin !== target.origin) {
    throw new Error(
      `BOOKING_ADMIN_E2E_ISOLATED_LIVE_ORIGIN must exactly match ${target.origin}.`,
    );
  }

  if (input.confirmation !== ADMIN_CALENDAR_LIVE_TARGET_CONFIRMATION) {
    throw new Error(
      `Set BOOKING_ADMIN_E2E_CONFIRM_ISOLATED_LIVE_TARGET=${ADMIN_CALENDAR_LIVE_TARGET_CONFIRMATION} after verifying the target is isolated.`,
    );
  }

  return target.origin;
}

function parseOrigin(value: string, variableName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid HTTP(S) origin.`);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${variableName} must contain only an HTTP(S) origin without credentials, path, query, or fragment.`,
    );
  }

  return url;
}
