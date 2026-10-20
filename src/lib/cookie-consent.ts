export const COOKIE_CONSENT_STORAGE_KEY = "lh_cookie_consent";
export const COOKIE_CONSENT_UPDATED_EVENT = "lh-cookie-consent-updated";
export const COOKIE_CONSENT_VERSION = 2;

export type CookieConsentChoice = {
  required: true;
  analytics: boolean;
  crmTracking: boolean;
  decidedAt: string;
  version: typeof COOKIE_CONSENT_VERSION;
};

export function createCookieConsentChoice(
  choices: Pick<CookieConsentChoice, "analytics" | "crmTracking">,
  now = new Date(),
): CookieConsentChoice {
  return {
    required: true,
    analytics: choices.analytics,
    crmTracking: choices.crmTracking,
    decidedAt: now.toISOString(),
    version: COOKIE_CONSENT_VERSION,
  };
}

export function serializeCookieConsent(choice: CookieConsentChoice): string {
  return JSON.stringify(choice);
}

export function parseCookieConsent(
  value: string | null,
): CookieConsentChoice | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const input = parsed as Record<string, unknown>;
    if (input.required !== true || typeof input.analytics !== "boolean")
      return null;
    if (
      typeof input.decidedAt !== "string" ||
      !Number.isFinite(Date.parse(input.decidedAt))
    )
      return null;
    if (input.version !== 1 && input.version !== COOKIE_CONSENT_VERSION)
      return null;
    if (
      input.version === COOKIE_CONSENT_VERSION &&
      typeof input.crmTracking !== "boolean"
    )
      return null;
    return {
      required: true,
      analytics: input.analytics,
      // Legacy analytics permission never implies CRM-linked tracking permission.
      crmTracking:
        input.version === COOKIE_CONSENT_VERSION && input.crmTracking === true,
      decidedAt: input.decidedAt,
      version: COOKIE_CONSENT_VERSION,
    };
  } catch {
    return null;
  }
}
