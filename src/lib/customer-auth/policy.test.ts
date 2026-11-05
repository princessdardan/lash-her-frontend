import assert from "node:assert/strict";
import test from "node:test";
import { customerSessionCookieName, customerThrottleKey, hashCustomerSession, normalizeCustomerEmail, resolveCustomerAuthConfiguration, safeCustomerReturn } from "./policy";

test("customer configuration is off by default and never borrows administrator credentials", () => {
  assert.equal(resolveCustomerAuthConfiguration({}), null);
  const env = { CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true", CUSTOMER_AUTH_URL: "https://staging.example.com", CUSTOMER_AUTH_SECRET: "c".repeat(32), CUSTOMER_AUTH_GOOGLE_ID: "customer-client", CUSTOMER_AUTH_GOOGLE_SECRET: "customer-google", CUSTOMER_AUTH_RESEND_KEY: "customer-resend", CUSTOMER_AUTH_EMAIL_FROM: "Account <account@example.com>" };
  assert.equal(resolveCustomerAuthConfiguration(env)?.origin, "https://staging.example.com");
  assert.equal(resolveCustomerAuthConfiguration({ ...env, INTEGRATION_CUSTOMER_ACCESS_ENABLED: "false" }), null);
  for (const override of [{ AUTH_SECRET: env.CUSTOMER_AUTH_SECRET }, { AUTH_GOOGLE_SECRET: env.CUSTOMER_AUTH_GOOGLE_SECRET }, { AUTH_GOOGLE_ID: env.CUSTOMER_AUTH_GOOGLE_ID }, { AUTH_URL: "https://elsewhere.example.com" }, { CUSTOMER_AUTH_SECRET: "short" }, { CUSTOMER_AUTH_URL: "http://example.com" }, { CUSTOMER_AUTH_URL: "https://user:pass@example.com" }, { CUSTOMER_AUTH_URL: "https://example.com/api/auth" }]) {
    assert.throws(() => resolveCustomerAuthConfiguration({ ...env, ...override }));
  }
  assert.equal(customerSessionCookieName(true), "__Host-lash-customer.session-token");
  assert.notEqual(customerSessionCookieName(false), "authjs.session-token");
});

test("customer return URLs stay on the public same-origin surface", () => {
  const origin = "https://example.com";
  assert.equal(safeCustomerReturn("/academy/lesson?lesson=1", origin), "/academy/lesson?lesson=1");
  assert.equal(safeCustomerReturn(`${origin}/account/sign-in-methods`, origin), "/account/sign-in-methods");
  for (const value of ["https://evil.test", "//evil.test/path", "/\\evil.test", "/%2f%2fevil.test", "/%5cevil.test", "/%61dmin", "/api/auth/signin", "/studio", "javascript:alert(1)", "/%00bad", "/%zz"]) assert.equal(safeCustomerReturn(value, origin), "/academy", value);
});

test("strict email normalization and keyed privacy-safe throttle identities", () => {
  assert.equal(normalizeCustomerEmail(" Name@EXAMPLE.com "), "name@example.com");
  for (const email of ["a@example.com,b@example.com", '"a"@example.com', "a@@example.com", "A@EXAMPLE.COM\nB@EXAMPLE.COM", "a@localhost", "a".repeat(255)]) assert.throws(() => normalizeCustomerEmail(email));
  assert.match(hashCustomerSession("bearer"), /^[a-f0-9]{64}$/u);
  assert.notEqual(customerThrottleKey("one", "email", "a@example.com"), customerThrottleKey("two", "email", "a@example.com"));
});
