"use client";

import * as React from "react";
import { Analytics } from "@vercel/analytics/next";
import { parseCookieConsent } from "@/lib/cookie-consent";
import {
  getCookieConsentSnapshot,
  getServerCookieConsentSnapshot,
  subscribeToCookieConsent,
} from "@/lib/cookie-consent-store";

const ANALYTICS_SCRIPT_SELECTOR = [
  'script[data-sdkn^="@vercel/analytics"]',
  'script[src*="/_vercel/insights/script.js"]',
  'script[src*="va.vercel-scripts.com/v1/script.debug.js"]',
].join(",");

export function ConsentedAnalytics() {
  const snapshot = React.useSyncExternalStore(
    subscribeToCookieConsent,
    getCookieConsentSnapshot,
    getServerCookieConsentSnapshot,
  );
  const hasAnalyticsConsent = parseCookieConsent(snapshot)?.analytics === true;
  const hadAnalyticsConsent = React.useRef(false);

  React.useEffect(() => {
    if (hadAnalyticsConsent.current && !hasAnalyticsConsent) {
      cleanupInjectedAnalytics();
    }

    hadAnalyticsConsent.current = hasAnalyticsConsent;
  }, [hasAnalyticsConsent]);

  return hasAnalyticsConsent ? <Analytics /> : null;
}

function cleanupInjectedAnalytics() {
  document
    .querySelectorAll<HTMLScriptElement>(ANALYTICS_SCRIPT_SELECTOR)
    .forEach((script) => {
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
