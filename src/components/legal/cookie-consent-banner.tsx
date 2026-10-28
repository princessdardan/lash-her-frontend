"use client";

import * as React from "react";
import {
  createCookieConsentChoice,
  parseCookieConsent,
  type CookieConsentChoice,
} from "@/lib/cookie-consent";
import {
  getCookieConsentSnapshot,
  getServerCookieConsentSnapshot,
  migrateLegacyCookieConsent,
  saveCookieConsent,
  subscribeToCookieConsent,
} from "@/lib/cookie-consent-store";

export function CookieConsentBanner({
  crmTrackingAvailable = false,
}: {
  crmTrackingAvailable?: boolean;
}) {
  const snapshot = React.useSyncExternalStore(
    subscribeToCookieConsent,
    getCookieConsentSnapshot,
    getServerCookieConsentSnapshot,
  );
  const choice = parseCookieConsent(snapshot);
  const [managing, setManaging] = React.useState(false);
  const [storageWarning, setStorageWarning] = React.useState(false);
  const manageButton = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    migrateLegacyCookieConsent();
  }, []);

  function save(analytics: boolean, crmTracking: boolean) {
    setStorageWarning(
      !saveCookieConsent(createCookieConsentChoice({ analytics, crmTracking })),
    );
    setManaging(false);
    manageButton.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <div className="bg-lh-shadow px-4 pb-6 text-center text-sm text-lh-neutral">
        <button
          ref={manageButton}
          type="button"
          className="underline underline-offset-4"
          onClick={() => setManaging(true)}
        >
          Manage cookie preferences
        </button>
        {storageWarning ? (
          <p role="status" className="mt-2">
            Preferences apply to this tab only because browser storage is
            unavailable. You may be asked again after reloading.
          </p>
        ) : null}
      </div>
      {snapshot !== null && (managing || !choice) ? (
        <ConsentChoices
          key={snapshot}
          choice={choice}
          crmTrackingAvailable={crmTrackingAvailable}
          expanded={managing}
          onCustomize={() => setManaging(true)}
          onSave={save}
        />
      ) : null}
    </>
  );
}

function ConsentChoices({
  choice,
  crmTrackingAvailable,
  expanded,
  onCustomize,
  onSave,
}: {
  choice: CookieConsentChoice | null;
  crmTrackingAvailable: boolean;
  expanded: boolean;
  onCustomize: () => void;
  onSave: (analytics: boolean, crmTracking: boolean) => void;
}) {
  const [analytics, setAnalytics] = React.useState(choice?.analytics ?? false);
  const [crmTracking, setCrmTracking] = React.useState(
    choice?.crmTracking ?? false,
  );
  const headingId = React.useId();
  const analyticsId = React.useId();
  const crmId = React.useId();
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [expanded]);

  if (!expanded) {
    return (
      <section
        aria-label="Cookie consent"
        className="fixed inset-x-4 bottom-4 z-50 mx-auto max-h-[85dvh] max-w-4xl overflow-y-auto rounded-2xl border border-lh-line bg-lh-white p-4 text-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.18)] md:flex md:items-center md:gap-6 md:p-5"
      >
        <div className="flex-1">
          <h2
            ref={heading}
            tabIndex={-1}
            className="font-heading text-xl font-normal"
          >
            Cookie preferences
          </h2>
          <p className="mt-1 font-body text-sm leading-6 text-lh-shadow/75">
            We use required storage to keep the site working. With your
            permission, we also use analytics and CRM/marketing tracking.
          </p>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 md:mt-0 md:shrink-0">
          <button
            type="button"
            className="rounded-full bg-lh-primary px-4 py-3 font-body text-xs font-bold text-lh-white"
            onClick={() => onSave(true, true)}
          >
            Accept
          </button>
          <button
            type="button"
            className="rounded-full border border-lh-primary px-4 py-3 font-body text-xs font-bold text-lh-primary"
            onClick={onCustomize}
          >
            Customize
          </button>
          <button
            type="button"
            className="rounded-full border border-lh-primary px-4 py-3 font-body text-xs font-bold text-lh-primary"
            onClick={() => onSave(false, false)}
          >
            Reject
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Cookie consent"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-h-[85dvh] max-w-4xl overflow-y-auto rounded-[24px] border border-lh-line bg-lh-white p-5 text-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.18)] md:p-6"
    >
      <p className="eyebrow-label mb-2">Privacy Preferences</p>
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="font-heading text-2xl font-normal"
      >
        Choose optional website tracking
      </h2>
      <p className="mt-3 font-body text-sm font-bold leading-6 text-lh-shadow/75">
        Required storage is always on for carts, checkout, course access and
        progress, and saved preferences. Optional choices are off by default and
        do not affect site access.
      </p>
      <div className="mt-4 grid gap-4 rounded-2xl bg-lh-neutral-2 p-4 font-body text-sm font-bold leading-6 md:grid-cols-2">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-lh-primary"
            aria-label="Analytics"
            checked={analytics}
            onChange={(event) => setAnalytics(event.target.checked)}
            aria-describedby={analyticsId}
          />
          <span>
            Analytics
            <span id={analyticsId} className="block font-normal">
              Measure visits and improve website performance.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-lh-primary"
            aria-label="CRM/marketing tracking"
            checked={crmTracking}
            onChange={(event) => setCrmTracking(event.target.checked)}
            aria-describedby={crmId}
          />
          <span>
            CRM/marketing tracking
            <span id={crmId} className="block font-normal">
              Allow HighLevel to link public-page browsing and campaign
              attribution with a contact when tracking is available. This does
              not grant email or SMS marketing permission.
            </span>
          </span>
        </label>
      </div>
      {!crmTrackingAvailable ? (
        <p className="mt-3 font-body text-sm leading-6">
          HighLevel tracking is currently disabled. Your preference can be
          saved, but no HighLevel tracker loads or sends browsing data.
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded-full bg-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-white"
          onClick={() => onSave(analytics, crmTracking)}
        >
          Save choices
        </button>
        <button
          type="button"
          className="rounded-full border border-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-primary"
          onClick={() => onSave(true, false)}
        >
          Accept analytics only
        </button>
        <button
          type="button"
          className="rounded-full border border-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-primary"
          onClick={() => onSave(false, false)}
        >
          Reject optional cookies
        </button>
      </div>
    </section>
  );
}
