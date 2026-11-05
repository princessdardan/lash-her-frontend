// Metadata-only regression of the installed Auth.js validator. No database,
// provider request, token issuance or authentication replacement is involved.
import assert from "node:assert/strict";
import test from "node:test";
import Google from "next-auth/providers/google";
import { createCustomerAuthConfig } from "../../src/lib/customer-auth/config.ts";
import { createCustomerAuthStore } from "../../src/lib/customer-auth/store.ts";

const request = { url: new URL("https://owned.example.invalid/api/auth/session"), query: {}, cookies: {} };
const customer = () => createCustomerAuthConfig({ origin: "https://owned.example.invalid", secure: true,
  secret: "owned-customer-profile-distinct-secret-32", googleId: "owned-customer-google", googleSecret: "owned-customer-google-secret",
  resendKey: "owned-customer-resend-key", emailFrom: "owned@example.invalid" }, createCustomerAuthStore(() => {
    throw new Error("Metadata validation must never open a database");
  }));
const administrator = () => ({ secret: "owned-admin-profile-distinct-secret-32", trustHost: true,
  providers: [Google({ clientId: "owned-admin-google", clientSecret: "owned-admin-google-secret" })], session: { strategy: "jwt" } });
async function validator(order) {
  // Independent real module instances model each initial request order. The
  // actual validator, provider constructors, errors and customer adapter remain
  // unchanged; no state or result is mocked.
  const path = new URL("./lib/utils/assert.js", import.meta.resolve("@auth/core"));
  path.searchParams.set("owned-profile-order", order);
  return (await import(path.href)).assertConfig;
}
function valid(result, scope) {
  assert.ok(Array.isArray(result), `${scope}: unexpected ${result?.type ?? result?.name ?? "validator refusal"}`);
}

test("customer email metadata cannot make a later administrator JWT profile require its adapter", async () => {
  const validate = await validator("customer-then-admin");
  valid(validate(request, customer()), "customer");
  valid(validate(request, administrator()), "administrator after customer");
});

test("administrator JWT and customer email metadata remain valid in reverse order", async () => {
  const validate = await validator("admin-then-customer");
  valid(validate(request, administrator()), "administrator");
  valid(validate(request, customer()), "customer after administrator");
});
