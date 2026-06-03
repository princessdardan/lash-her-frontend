import assert from "node:assert/strict";
import test from "node:test";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  parseCookieConsent,
  serializeCookieConsent,
} from "./cookie-consent";

test("cookie consent storage key is stable", () => {
  assert.equal(COOKIE_CONSENT_STORAGE_KEY, "lh_cookie_consent");
});

test("parseCookieConsent returns null for missing values", () => {
  assert.equal(parseCookieConsent(null), null);
  assert.equal(parseCookieConsent(""), null);
});

test("parseCookieConsent returns null for invalid JSON", () => {
  assert.equal(parseCookieConsent("not-json"), null);
});

test("parseCookieConsent rejects wrong shape", () => {
  assert.equal(parseCookieConsent(JSON.stringify({ analytics: true, version: 1 })), null);
  assert.equal(parseCookieConsent(JSON.stringify({ required: true, analytics: "yes", version: 1 })), null);
  assert.equal(parseCookieConsent(JSON.stringify({ required: true, analytics: true, version: 2 })), null);
});

test("parseCookieConsent accepts valid analytics consent", () => {
  const choice = parseCookieConsent(JSON.stringify({
    required: true,
    analytics: true,
    decidedAt: "2026-06-03T12:00:00.000Z",
    version: 1,
  }));

  assert.deepEqual(choice, {
    required: true,
    analytics: true,
    decidedAt: "2026-06-03T12:00:00.000Z",
    version: 1,
  });
});

test("createCookieConsentChoice records required true and selected analytics", () => {
  const now = new Date("2026-06-03T12:00:00.000Z");
  assert.deepEqual(createCookieConsentChoice(false, now), {
    required: true,
    analytics: false,
    decidedAt: "2026-06-03T12:00:00.000Z",
    version: 1,
  });
});

test("serializeCookieConsent serializes valid consent", () => {
  const choice = createCookieConsentChoice(true, new Date("2026-06-03T12:00:00.000Z"));
  assert.equal(serializeCookieConsent(choice), JSON.stringify(choice));
});
