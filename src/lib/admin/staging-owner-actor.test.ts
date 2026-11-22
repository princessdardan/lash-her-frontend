import assert from "node:assert/strict";
import test from "node:test";
import "../../../scripts/register-server-only-test.mjs";

import type { AdminIdentity, AdminUserRecord } from "./types";

const identity: AdminIdentity = {
  email: "Owner@example.invalid",
  emailVerified: true,
  providerUserId: "google-first-owner",
  displayName: "Owner",
};

const owner: AdminUserRecord = {
  id: "staging-owner",
  displayName: identity.displayName,
  email: identity.email,
  emailNormalized: identity.email.toLowerCase(),
  providerUserId: identity.providerUserId,
  role: "owner",
  status: "active",
};

async function fixture({
  providerUser = null,
  emailUser = null,
  staging = true,
  windowOpen = true,
}: {
  providerUser?: AdminUserRecord | null;
  emailUser?: AdminUserRecord | null;
  staging?: boolean;
  windowOpen?: boolean;
} = {}) {
  const { createStagingOwnerAccess } = await import("./staging-owner-actor");
  const calls: string[] = [];
  const access = createStagingOwnerAccess({
    isStagingRequest: async () => staging,
    isAllowedOwner: (email) => email.toLowerCase() === owner.emailNormalized,
    canBootstrap: () => windowOpen,
    getStore: () => ({
      findByProviderUserId: async () => { calls.push("provider"); return providerUser; },
      findByEmailNormalized: async () => { calls.push("email"); return emailUser; },
      listBookingProviderResourceIds: async () => { calls.push("providers"); return ["provider"]; },
      listBookingResourceIds: async () => { calls.push("resources"); return ["resource"]; },
    }),
    createFirstOwner: async () => { calls.push("bootstrap"); return owner; },
  });
  return { ...access, calls };
}

test("staging bootstrap reaches only the eligible fresh owner, and only while its window is open", async () => {
  const open = await fixture();
  assert.equal(await open.establishStagingOwner(identity), true);
  assert.deepEqual(open.calls, ["provider", "email", "bootstrap"]);

  for (const closed of [await fixture({ staging: false }), await fixture({ windowOpen: false })]) {
    assert.equal(await closed.establishStagingOwner(identity), false);
    assert.ok(!closed.calls.includes("bootstrap"));
  }
  for (const callback of [
    { ...identity, emailVerified: false },
    { ...identity, email: "someone-else@example.invalid" },
    { ...identity, providerUserId: "bad subject" },
  ]) {
    const hidden = await fixture();
    assert.equal(await hidden.establishStagingOwner(callback), false);
    assert.deepEqual(hidden.calls, []);
  }
});

test("an exact active staging owner signs in and resolves read-only after bootstrap expires", async () => {
  const established = await fixture({ emailUser: owner, providerUser: owner, windowOpen: false });
  assert.equal(await established.establishStagingOwner(identity), true);
  assert.deepEqual(await established.requireStagingOwnerActor(identity), {
    user: owner, bookingProviderResourceIds: ["provider"], bookingResourceIds: ["resource"],
  });
  assert.deepEqual(established.calls, ["provider", "email", "provider", "email", "providers", "resources"]);
});

test("actor reads never create an owner and lookup conflicts cannot bind or revive one", async () => {
  for (const settings of [
    {},
    { emailUser: { ...owner, status: "disabled" as const }, providerUser: null },
    { emailUser: owner, providerUser: { ...owner, id: "another" } },
    { emailUser: { ...owner, role: "admin" as const }, providerUser: { ...owner, role: "admin" as const } },
  ]) {
    const denied = await fixture(settings);
    await assert.rejects(denied.requireStagingOwnerActor(identity), { code: "forbidden" });
    assert.deepEqual(denied.calls, ["provider", "email"]);
  }

  const conflict = await fixture({ emailUser: owner, providerUser: { ...owner, id: "another" } });
  assert.equal(await conflict.establishStagingOwner(identity), false);
  assert.deepEqual(conflict.calls, ["provider", "email"]);
});

test("the dedicated staging owner path demands the reviewed database role, host and TLS", async () => {
  const { isReviewedStagingAdminDatabase } = await import("./admin-user-store");
  const { default: stagingRelease } = await import("../../../ops/staging/first-release.json", { with: { type: "json" } });
  const { pooledHost, directHost, database, runtimeRole } = stagingRelease.frontendDatabase;
  for (const host of [pooledHost, directHost]) {
    const value = `postgresql://${runtimeRole}:fixture-password@${host}/${database}?sslmode=verify-full`;
    assert.equal(isReviewedStagingAdminDatabase(value), true);
    assert.equal(isReviewedStagingAdminDatabase(`${value}&channel_binding=require`), true);
    assert.equal(isReviewedStagingAdminDatabase(value.replace(host, "other.example.invalid")), false);
    assert.equal(isReviewedStagingAdminDatabase(value.replace(runtimeRole, "other_role")), false);
    assert.equal(isReviewedStagingAdminDatabase(value.replace("verify-full", "require")), false);
    assert.equal(isReviewedStagingAdminDatabase(`${value}&sslmode=require`), false);
  }
});
