import type { BrowserContext } from "@playwright/test";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  serializeCookieConsent,
} from "../../src/lib/cookie-consent";

/** Non-consent UX fixtures explicitly decline both optional purposes. */
export async function setRequiredOnlyCookieConsent(context: BrowserContext) {
  await context.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    {
      key: COOKIE_CONSENT_STORAGE_KEY,
      value: serializeCookieConsent(
        createCookieConsentChoice({ analytics: false, crmTracking: false }),
      ),
    },
  );
}
