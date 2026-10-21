import assert from "node:assert/strict";
import test from "node:test";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  parseCookieConsent,
  serializeCookieConsent,
} from "./cookie-consent";

const now = new Date("2026-10-20T12:00:00.000Z");
test("consent key stays stable and optional choices round trip independently", () => {
  assert.equal(COOKIE_CONSENT_STORAGE_KEY, "lh_cookie_consent");
  for (const analytics of [false, true])
    for (const crmTracking of [false, true]) {
      const choice = createCookieConsentChoice({ analytics, crmTracking }, now);
      assert.deepEqual(parseCookieConsent(serializeCookieConsent(choice)), {
        required: true,
        analytics,
        crmTracking,
        decidedAt: now.toISOString(),
        version: 2,
      });
      assert.equal("marketingConsent" in choice, false);
      assert.equal("smsMarketingConsent" in choice, false);
    }
});
test("legacy acceptance and rejection preserve analytics and timestamp without granting CRM tracking", () => {
  for (const analytics of [false, true]) {
    assert.deepEqual(
      parseCookieConsent(
        JSON.stringify({
          required: true,
          analytics,
          crmTracking: true,
          decidedAt: now.toISOString(),
          version: 1,
        }),
      ),
      {
        required: true,
        analytics,
        crmTracking: false,
        decidedAt: now.toISOString(),
        version: 2,
      },
    );
  }
});
test("missing, corrupt, unknown-version and malformed choices fail closed", () => {
  for (const value of [null, "", "bad json", "[]", "null", "true"])
    assert.equal(parseCookieConsent(value), null);
  const valid = createCookieConsentChoice(
    { analytics: true, crmTracking: true },
    now,
  );
  for (const change of [
    { required: false },
    { analytics: "yes" },
    { crmTracking: undefined },
    { crmTracking: "true" },
    { decidedAt: "bad date" },
    { decidedAt: "" },
    { version: 3 },
  ]) {
    assert.equal(
      parseCookieConsent(JSON.stringify({ ...valid, ...change })),
      null,
    );
  }
});
