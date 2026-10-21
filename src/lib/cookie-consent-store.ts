"use client";

import {
  COOKIE_CONSENT_STORAGE_KEY,
  COOKIE_CONSENT_UPDATED_EVENT,
  parseCookieConsent,
  serializeCookieConsent,
  type CookieConsentChoice,
} from "@/lib/cookie-consent";

let sessionChoice: string | null = null;

// The snapshot is a primitive so useSyncExternalStore sees a stable value.
export function getCookieConsentSnapshot(): string {
  if (sessionChoice !== null) return sessionChoice;
  try {
    return window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function getServerCookieConsentSnapshot(): null {
  return null;
}

export function saveCookieConsent(choice: CookieConsentChoice): boolean {
  const value = serializeCookieConsent(choice);
  let persisted = false;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, value);
    sessionChoice = null;
    persisted = true;
  } catch {
    // Restricted storage still permits an explicit choice for this tab.
    sessionChoice = value;
  }
  window.dispatchEvent(new Event(COOKIE_CONSENT_UPDATED_EVENT));
  return persisted;
}

export function migrateLegacyCookieConsent(): void {
  const raw = getCookieConsentSnapshot();
  const choice = parseCookieConsent(raw);
  if (choice && JSON.parse(raw).version === 1) saveCookieConsent(choice);
}

export function subscribeToCookieConsent(onChange: () => void): () => void {
  function handleStorage(event: StorageEvent) {
    if (event.key === COOKIE_CONSENT_STORAGE_KEY || event.key === null) {
      sessionChoice = null;
      onChange();
    }
  }
  window.addEventListener(COOKIE_CONSENT_UPDATED_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  // Re-read after restoring a page from the browser's back/forward cache.
  window.addEventListener("pageshow", onChange);
  return () => {
    window.removeEventListener(COOKIE_CONSENT_UPDATED_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("pageshow", onChange);
  };
}
