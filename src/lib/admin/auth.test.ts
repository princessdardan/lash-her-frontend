import assert from "node:assert/strict";
import test from "node:test";

import type { AdminUserStore } from "./admin-user-store";
import { createAdminAuth } from "./auth-service";
import {
  AdminAuthError,
  type AdminAuthErrorCode,
  type AdminIdentity,
  type AdminUserRecord,
} from "./types";

const identity: AdminIdentity = {
  displayName: "Employee",
  email: "employee@example.com",
  emailVerified: true,
  providerUserId: "google-sub-employee",
};

const employee: AdminUserRecord = {
  displayName: "Employee",
  email: "employee@example.com",
  emailNormalized: "employee@example.com",
  id: "admin-employee",
  providerUserId: "google-sub-employee",
  role: "employee",
  status: "active",
};

test("admin auth keeps database roles authoritative and enforces resource scopes", async () => {
  const employeeStore = createStore(
    [employee],
    new Map([[employee.id, ["resource-a"]]]),
  );
  const employeeAuth = createAdminAuth({
    getIdentity: async () => identity,
    getOwnerEmails: () => new Set(["employee@example.com"]),
    userStore: employeeStore,
  });

  const actor = await employeeAuth.requirePermission("bookings:view", {
    bookingResourceId: "resource-a",
  });

  assert.equal(actor.user.role, "employee");
  assert.deepEqual(actor.bookingProviderResourceIds, ["resource-a"]);
  assert.deepEqual(actor.bookingResourceIds, ["resource-a"]);
  await rejectsWithCode(
    () =>
      employeeAuth.requirePermission("bookings:view", {
        bookingResourceId: "resource-b",
      }),
    "forbidden",
  );
  await rejectsWithCode(
    () => employeeAuth.requirePermission("marketing:view"),
    "forbidden",
  );
});

test("owner allowlisting cannot reactivate or elevate an existing database user", async () => {
  const disabledStore = createStore([{ ...employee, status: "disabled" }]);
  const disabledAuth = createAdminAuth({
    getIdentity: async () => identity,
    getOwnerEmails: () => new Set(["employee@example.com"]),
    userStore: disabledStore,
  });

  await rejectsWithCode(() => disabledAuth.requireActor(), "disabled");
});

test("provisioned users bind their provider identity without changing their database role", async () => {
  const provisionedStore = createStore([
    {
      ...employee,
      id: "provisioned-admin",
      providerUserId: "pending:provisioned-admin",
      role: "admin",
    },
  ]);
  const provisionedAuth = createAdminAuth({
    getIdentity: async () => identity,
    getOwnerEmails: () => new Set(),
    userStore: provisionedStore,
  });

  const provisionedActor = await provisionedAuth.requireActor();

  assert.equal(provisionedActor.user.role, "admin");
  assert.equal(provisionedActor.user.providerUserId, "google-sub-employee");
});

test("owner bootstrap is limited to verified allowlisted identities", async () => {
  const bootstrapStore = createStore();
  const bootstrapAuth = createAdminAuth({
    getIdentity: async () => ({ ...identity, email: "owner@example.com" }),
    getOwnerEmails: () => new Set(["owner@example.com"]),
    userStore: bootstrapStore,
  });
  const deniedAuth = createAdminAuth({
    getIdentity: async () => identity,
    getOwnerEmails: () => new Set(),
    userStore: createStore(),
  });
  const unverifiedAuth = createAdminAuth({
    getIdentity: async () => ({ ...identity, emailVerified: false }),
    getOwnerEmails: () => new Set(["employee@example.com"]),
    userStore: createStore(),
  });

  assert.equal((await bootstrapAuth.requireActor()).user.role, "owner");
  await rejectsWithCode(() => deniedAuth.requireActor(), "not_allowed");
  await rejectsWithCode(
    () => unverifiedAuth.requireActor(),
    "unverified_email",
  );
});

function createStore(
  initialRows: AdminUserRecord[] = [],
  resourceIds = new Map<string, string[]>(),
  providerResourceIds = resourceIds,
): AdminUserStore {
  const rows = new Map(initialRows.map((row) => [row.id, row]));

  const bindIdentity: AdminUserStore["bindIdentity"] = async (input) => {
    const existing = rows.get(input.adminUserId);
    assert.ok(existing, `Unknown admin user: ${input.adminUserId}`);

    const updated: AdminUserRecord = {
      ...existing,
      displayName: input.displayName,
      email: input.email,
      emailNormalized: input.email.trim().toLowerCase(),
      providerUserId: input.providerUserId,
    };
    rows.set(updated.id, updated);
    return updated;
  };

  return {
    bindIdentity,
    async createBootstrapOwner(ownerIdentity) {
      const row: AdminUserRecord = {
        displayName: ownerIdentity.displayName,
        email: ownerIdentity.email,
        emailNormalized: ownerIdentity.email.trim().toLowerCase(),
        id: "bootstrap-owner",
        providerUserId: ownerIdentity.providerUserId,
        role: "owner",
        status: "active",
      };
      rows.set(row.id, row);
      return row;
    },
    async findByEmailNormalized(email) {
      return (
        [...rows.values()].find((row) => row.emailNormalized === email) ?? null
      );
    },
    async findByProviderUserId(id) {
      return (
        [...rows.values()].find((row) => row.providerUserId === id) ?? null
      );
    },
    async listBookingProviderResourceIds(id) {
      return providerResourceIds.get(id) ?? [];
    },
    async listBookingResourceIds(id) {
      return resourceIds.get(id) ?? [];
    },
    recordSignIn: bindIdentity,
  };
}

async function rejectsWithCode(
  action: () => Promise<unknown>,
  code: AdminAuthErrorCode,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof AdminAuthError);
    assert.equal(error.code, code);
    return true;
  });
}
