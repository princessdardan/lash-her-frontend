"use client";

import * as React from "react";
import { Analytics } from "@vercel/analytics/next";
import { COOKIE_CONSENT_STORAGE_KEY, parseCookieConsent } from "@/lib/cookie-consent";

const CONSENT_UPDATED_EVENT = "lh-cookie-consent-updated";
const ANALYTICS_SCRIPT_SELECTOR = [
  'script[data-sdkn^="@vercel/analytics"]',
  'script[src*="/_vercel/insights/script.js"]',
  'script[src*="va.vercel-scripts.com/v1/script.debug.js"]',
].join(",");

export function ConsentedAnalytics() {
  const [hasAnalyticsConsent, setHasAnalyticsConsent] = React.useState(false);
  const hadAnalyticsConsent = React.useRef(false);

  React.useEffect(() => {
    function syncConsent() {
      try {
        const choice = parseCookieConsent(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY));
        setHasAnalyticsConsent(choice?.analytics === true);
      } catch {
        setHasAnalyticsConsent(false);
      }
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === COOKIE_CONSENT_STORAGE_KEY || event.key === null) {
        syncConsent();
      }
    }

    syncConsent();
    window.addEventListener(CONSENT_UPDATED_EVENT, syncConsent);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(CONSENT_UPDATED_EVENT, syncConsent);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  React.useEffect(() => {
    if (hadAnalyticsConsent.current && !hasAnalyticsConsent) {
      cleanupInjectedAnalytics();
    }

    hadAnalyticsConsent.current = hasAnalyticsConsent;
  }, [hasAnalyticsConsent]);

  return hasAnalyticsConsent ? <Analytics /> : null;
}

function cleanupInjectedAnalytics() {
  document.querySelectorAll<HTMLScriptElement>(ANALYTICS_SCRIPT_SELECTOR).forEach((script) => {
    script.remove();
  });

  // @vercel/analytics exposes no supported teardown API. Clear its globals after
  // revocation so future calls cannot enqueue or dispatch through the SDK shim.
  const analyticsWindow = window as typeof window & {
    va?: unknown;
    vaq?: unknown;
    vam?: unknown;
  };

  delete analyticsWindow.va;
  delete analyticsWindow.vaq;
  delete analyticsWindow.vam;
}
