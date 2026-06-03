export const COOKIE_CONSENT_STORAGE_KEY = "lh_cookie_consent";

export type CookieConsentChoice = {
  required: true;
  analytics: boolean;
  decidedAt: string;
  version: 1;
};

export function createCookieConsentChoice(
  analytics: boolean,
  now = new Date(),
): CookieConsentChoice {
  return {
    required: true,
    analytics,
    decidedAt: now.toISOString(),
    version: 1,
  };
}

export function serializeCookieConsent(choice: CookieConsentChoice): string {
  return JSON.stringify(choice);
}

export function parseCookieConsent(value: string | null): CookieConsentChoice | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<CookieConsentChoice> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.required !== true) return null;
    if (typeof parsed.analytics !== "boolean") return null;
    if (typeof parsed.decidedAt !== "string" || !parsed.decidedAt) return null;
    if (parsed.version !== 1) return null;

    return {
      required: true,
      analytics: parsed.analytics,
      decidedAt: parsed.decidedAt,
      version: 1,
    };
  } catch {
    return null;
  }
}
