import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCustomerIdentityToJwt,
  applyCustomerIdentityToSession,
} from "./auth-callbacks";
import { CustomerIdentityConflictError } from "./types";

test("trusted initial Google callback resolves a distinct customer claim", async () => {
  const resolutions: unknown[] = [];
  const token = await applyCustomerIdentityToJwt({
    account: {
      provider: "google",
      providerAccountId: "google-subject",
    },
    profile: {
      email: "Customer@Example.com",
      email_verified: true,
      name: "Customer",
      sub: "google-subject",
    },
    resolveIdentity: async (identity) => {
      resolutions.push(identity);
      return "customer-user-id";
    },
    token: { sub: "authjs-token-subject" },
  });

  assert.equal(token.customerUserId, "customer-user-id");
  assert.equal(token.providerUserId, "google-subject");
  assert.equal(token.googleEmailVerified, true);
  assert.deepEqual(resolutions, [
    {
      displayName: "Customer",
      email: "Customer@Example.com",
      emailVerified: true,
      provider: "google",
      providerAccountId: "google-subject",
    },
  ]);
});

test("requires Google account ID and profile subject to agree", async () => {
  let resolutionCount = 0;

  await assert.rejects(
    applyCustomerIdentityToJwt({
      account: { provider: "google", providerAccountId: "account-subject" },
      profile: {
        email: "customer@example.com",
        email_verified: true,
        sub: "profile-subject",
      },
      resolveIdentity: async () => {
        resolutionCount += 1;
        return "customer-user-id";
      },
      token: {},
    }),
    CustomerIdentityConflictError,
  );
  assert.equal(resolutionCount, 0);
});

test("does not resolve customer identity for an untrusted provider callback", async () => {
  let resolutionCount = 0;
  const token = await applyCustomerIdentityToJwt({
    account: { provider: "github", providerAccountId: "github-subject" },
    profile: {
      email: "customer@example.com",
      email_verified: true,
      sub: "github-subject",
    },
    resolveIdentity: async () => {
      resolutionCount += 1;
      return "customer-user-id";
    },
    token: { sub: "legacy-staff-subject" },
  });

  assert.equal(resolutionCount, 0);
  assert.equal(token.customerUserId, undefined);
  assert.equal(token.providerUserId, "legacy-staff-subject");
});

test("refresh callbacks preserve customer and legacy staff claims without resolving", async () => {
  let resolutionCount = 0;
  const token = await applyCustomerIdentityToJwt({
    resolveIdentity: async () => {
      resolutionCount += 1;
      return "replacement";
    },
    token: {
      customerUserId: "customer-user-id",
      googleEmailVerified: true,
      providerUserId: "google-staff-subject",
      sub: "authjs-subject",
    },
  });

  assert.equal(resolutionCount, 0);
  assert.equal(token.customerUserId, "customer-user-id");
  assert.equal(token.providerUserId, "google-staff-subject");
  assert.equal(token.googleEmailVerified, true);
});

test("session ID is mapped only from the customer identity claim", () => {
  const customerSession = applyCustomerIdentityToSession(
    { user: {} },
    {
      customerUserId: "customer-user-id",
      providerUserId: "staff-provider-id",
      sub: "authjs-subject",
    },
  );
  const legacyStaffSession = applyCustomerIdentityToSession(
    { user: { id: "admin-user-id" } },
    {
      providerUserId: "staff-provider-id",
      sub: "authjs-subject",
    },
  );

  assert.equal(customerSession.user?.id, "customer-user-id");
  assert.equal(legacyStaffSession.user?.id, undefined);
});
