"use client";

import * as React from "react";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  parseCookieConsent,
  serializeCookieConsent,
} from "@/lib/cookie-consent";

const CONSENT_UPDATED_EVENT = "lh-cookie-consent-updated";

type ConsentSnapshot = "pending" | "missing" | "stored";

export function CookieConsentBanner() {
  const consentSnapshot = React.useSyncExternalStore(
    subscribeToConsentUpdates,
    getStoredConsentSnapshot,
    getServerConsentSnapshot,
  );
  const detailsId = React.useId();
  const [hasHandledChoice, setHasHandledChoice] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);

  function saveChoice(analytics: boolean) {
    const choice = createCookieConsentChoice(analytics);
    try {
      window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, serializeCookieConsent(choice));
    } catch {
      // Storage can be unavailable in restricted browsing contexts; still honor the in-session choice.
    }

    window.dispatchEvent(new Event(CONSENT_UPDATED_EVENT));
    setHasHandledChoice(true);
  }

  const isReady = consentSnapshot !== "pending";
  const isVisible = !hasHandledChoice && consentSnapshot === "missing";

  if (!isReady || !isVisible) return null;

  return (
    <section
      aria-label="Cookie consent"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-4xl rounded-[24px] border border-lh-line bg-lh-white p-5 text-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.18)] md:p-6"
    >
      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
        <div>
          <p className="eyebrow-label mb-2">Privacy Preferences</p>
          <h2 className="font-heading text-2xl font-normal tracking-[-0.01em] text-lh-shadow">
            We use required cookies and optional analytics.
          </h2>
          <p className="mt-3 font-body text-sm font-bold leading-6 text-lh-shadow/75">
            Required storage keeps the site working for carts, bookings, checkout, and preferences. Analytics helps us understand site performance and will only load if you accept analytics cookies.
          </p>
          <div
            className="mt-4 grid gap-3 rounded-2xl bg-lh-neutral-2 p-4 font-body text-sm font-bold leading-6 text-lh-shadow/75 md:grid-cols-2"
            hidden={!showDetails}
            id={detailsId}
          >
            <div>
              <h3 className="text-lh-shadow">Required</h3>
              <p>Always on. Supports functional site behavior such as cart, booking, checkout, and saved preferences.</p>
            </div>
            <div>
              <h3 className="text-lh-shadow">Analytics</h3>
              <p>Optional. Helps measure visits and improve the website. Analytics is off unless you accept it.</p>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row md:min-w-56 md:flex-col">
          <button
            className="rounded-full bg-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-white transition-colors hover:bg-lh-accent"
            type="button"
            onClick={() => saveChoice(true)}
          >
            Accept analytics
          </button>
          <button
            className="rounded-full border border-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-primary transition-colors hover:bg-lh-primary-soft"
            type="button"
            onClick={() => saveChoice(false)}
          >
            Reject analytics
          </button>
          <button
            className="font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-muted underline underline-offset-4 transition-colors hover:text-lh-shadow"
            type="button"
            aria-controls={detailsId}
            aria-expanded={showDetails}
            onClick={() => setShowDetails((current) => !current)}
          >
            Manage choices
          </button>
        </div>
      </div>
    </section>
  );
}

function readStoredConsent() {
  try {
    return parseCookieConsent(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getStoredConsentSnapshot(): ConsentSnapshot {
  return readStoredConsent() === null ? "missing" : "stored";
}

function subscribeToConsentUpdates(onStoreChange: () => void) {
  function handleStorageEvent(event: StorageEvent) {
    if (event.key === COOKIE_CONSENT_STORAGE_KEY || event.key === null) {
      onStoreChange();
    }
  }

  window.addEventListener(CONSENT_UPDATED_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener(CONSENT_UPDATED_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorageEvent);
  };
}

function getServerConsentSnapshot(): ConsentSnapshot {
  return "pending";
}
