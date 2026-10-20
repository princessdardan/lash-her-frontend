import assert from "node:assert/strict";
import test from "node:test";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  parseCookieConsent,
} from "./cookie-consent";
import {
  getCookieConsentSnapshot,
  migrateLegacyCookieConsent,
  saveCookieConsent,
  subscribeToCookieConsent,
} from "./cookie-consent-store";

test("browser store migrates once, refreshes on storage/pageshow, and honors storage-denied withdrawal", () => {
  const originalWindow = globalThis.window;
  const target = new EventTarget();
  const values = new Map<string, string>();
  let deny = false;
  let writes = 0;
  const localStorage = {
    getItem: (key: string) => {
      if (deny) throw new Error("blocked");
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (deny) throw new Error("blocked");
      values.set(key, value);
      writes++;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(target, { localStorage }),
  });
  let updates = 0;
  const unsubscribe = subscribeToCookieConsent(() => updates++);
  const dispatchStorage = (key: string | null) => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: key });
    target.dispatchEvent(event);
  };
  try {
    const decidedAt = "2026-06-03T12:00:00.000Z";
    values.set(
      COOKIE_CONSENT_STORAGE_KEY,
      JSON.stringify({
        required: true,
        analytics: true,
        decidedAt,
        version: 1,
      }),
    );
    migrateLegacyCookieConsent();
    migrateLegacyCookieConsent();
    assert.equal(writes, 1);
    assert.equal(updates, 1);
    assert.deepEqual(JSON.parse(values.get(COOKIE_CONSENT_STORAGE_KEY)!), {
      required: true,
      analytics: true,
      crmTracking: false,
      decidedAt,
      version: 2,
    });
    dispatchStorage("unrelated");
    assert.equal(updates, 1);
    dispatchStorage(COOKIE_CONSENT_STORAGE_KEY);
    assert.equal(updates, 2);
    target.dispatchEvent(new Event("pageshow"));
    assert.equal(updates, 3);
    const grant = createCookieConsentChoice({
      analytics: true,
      crmTracking: true,
    });
    assert.equal(saveCookieConsent(grant), true);
    deny = true;
    assert.equal(getCookieConsentSnapshot(), "");
    const rejection = createCookieConsentChoice({
      analytics: true,
      crmTracking: false,
    });
    assert.equal(saveCookieConsent(rejection), false);
    assert.equal(
      parseCookieConsent(getCookieConsentSnapshot())?.crmTracking,
      false,
    );
    assert.equal(
      parseCookieConsent(getCookieConsentSnapshot())?.analytics,
      true,
    );
    // The old persisted grant cannot override an explicit in-tab rejection.
    assert.equal(
      JSON.parse(values.get(COOKIE_CONSENT_STORAGE_KEY)!).crmTracking,
      true,
    );
    deny = false;
    values.delete(COOKIE_CONSENT_STORAGE_KEY);
    dispatchStorage(null);
    assert.equal(getCookieConsentSnapshot(), "");
    const before = updates;
    unsubscribe();
    target.dispatchEvent(new Event("pageshow"));
    assert.equal(updates, before);
  } finally {
    unsubscribe();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});
