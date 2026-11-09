import assert from "node:assert/strict";
import test from "node:test";
import { withWriterOperationContext, writerFirstOwnerWindowSha256 } from "@/lib/writer-admission/context";
import { p2FirstOwnerIdentitySha256 } from "../../../ops/platform/p2-first-owner-identity.mjs";

import type { AdminUserStore } from "./admin-user-store";
import { createAdminAuth } from "./auth-service";
import { assertFirstOwnerGoogleAuthentication } from "./authentication-freshness";
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

test("scoped first owner requires the reviewed verified Google subject and leaves replay read-only", async () => {
  const nonce = "9".repeat(32);
  const firstOwner = { nonce, identityDigest: p2FirstOwnerIdentitySha256(nonce, identity.email, identity.providerUserId)!.slice(0, 62),
    epoch: "12", startedAt: 1_794_009_600 };
  const scoped = <T>(task: () => Promise<T>) =>
    withWriterOperationContext(task, undefined, undefined, undefined, undefined, undefined, undefined, undefined, firstOwner);
  const store = createStore();
  let inserts = 0;
  const repository: AdminUserStore = {
    ...store,
    async createBootstrapOwner(value, options) {
      assert.deepEqual(options, { requireEmpty: true });
      inserts++;
      return store.createBootstrapOwner(value);
    },
    async bindIdentity() { assert.fail("first owner cannot rebind a row"); },
    async recordSignIn() { assert.fail("first-owner replay cannot refresh a row"); },
  };
  const resolve = (value: AdminIdentity, allowlist = new Set([value.email]), userStore = repository) =>
    scoped(() => createAdminAuth({ getIdentity: async () => value, getOwnerEmails: () => allowlist, userStore }).requireActor());
  for (const value of [{ ...identity, email: "other@example.com" }, { ...identity, providerUserId: "other-google-subject" }]) {
    await rejectsWithCode(() => resolve(value), "forbidden");
  }
  await rejectsWithCode(() => resolve(identity, new Set()), "forbidden");
  await rejectsWithCode(() => resolve({ ...identity, emailVerified: false }), "unverified_email");
  for (const row of [employee, { ...employee, role: "owner" as const, status: "disabled" as const },
    { ...employee, role: "owner" as const, providerUserId: "pending:other" }]) {
    const existing = createStore([row]);
    await rejectsWithCode(() => resolve(identity, new Set([identity.email]), { ...repository,
      findByProviderUserId: existing.findByProviderUserId, findByEmailNormalized: existing.findByEmailNormalized,
    }), "forbidden");
  }
  assert.equal(inserts, 0);
  const created = await resolve(identity);
  assert.equal(created.user.role, "owner");
  assert.deepEqual(await resolve(identity), created);
  assert.equal(inserts, 1);
});

test("first-owner materialization refuses a same-second ordinary JWT and a different scoped callback", () => {
  const selection = { nonce: "9".repeat(32), identityDigest: "6".repeat(62), epoch: "12", startedAt: 1_794_009_600 };
  const observedAt = selection.startedAt * 1000 + 10;
  assert.throws(() => assertFirstOwnerGoogleAuthentication(selection, selection.startedAt, undefined, observedAt));
  assert.throws(() => assertFirstOwnerGoogleAuthentication(selection, selection.startedAt,
    writerFirstOwnerWindowSha256({ ...selection, epoch: "11" }), observedAt));
  assert.throws(() => assertFirstOwnerGoogleAuthentication(selection, selection.startedAt - 1,
    writerFirstOwnerWindowSha256(selection), observedAt));
  assert.doesNotThrow(() => assertFirstOwnerGoogleAuthentication(selection, selection.startedAt,
    writerFirstOwnerWindowSha256(selection), observedAt));
});

test("scoped authoring and paid grants refresh only the exact active owner with an established provider binding", async () => {
  const selectedOwnerId = "8e2280dc-0389-4248-b21c-f87427f9e85c";
  const owner = { ...employee, id: selectedOwnerId, role: "owner" as const };
  const withinAuthoring = <T>(work: () => Promise<T>) =>
    withWriterOperationContext(work, undefined, undefined, undefined, undefined, selectedOwnerId);
  const withinPaidGrant = <T>(work: () => Promise<T>) =>
    withWriterOperationContext(work, undefined, undefined, undefined, undefined, undefined, undefined, selectedOwnerId);
  const cases = [
    { rows: [owner], refreshes: 1 },
    { rows: [{ ...owner, id: "wrong-owner" }], code: "forbidden" },
    { rows: [{ ...owner, role: "admin" }], code: "forbidden" },
    { rows: [{ ...owner, status: "disabled" }], code: "disabled" },
    { rows: [{ ...owner, providerUserId: "pending:owner" }], code: "forbidden" },
    { rows: [{ ...owner, email: "former@example.com", emailNormalized: "former@example.com" }], code: "forbidden" },
    { rows: [], code: "forbidden" },
  ] as const satisfies readonly { rows: readonly AdminUserRecord[]; code?: AdminAuthErrorCode; refreshes?: number }[];
  for (const entry of cases) {
    const store = createStore([...entry.rows]);
    let refreshes = 0;
    const auth = createAdminAuth({
      getIdentity: async () => identity,
      getOwnerEmails: () => new Set([identity.email]),
      userStore: {
        ...store,
        async recordSignIn(input) { refreshes++; return store.recordSignIn(input); },
        async bindIdentity() { assert.fail("scoped owner cannot bind an admin identity"); },
        async createBootstrapOwner() { assert.fail("scoped owner cannot bootstrap an owner"); },
      },
    });
    if ("code" in entry) {
      await rejectsWithCode(() => withinAuthoring(() => auth.requireActor()), entry.code);
      await rejectsWithCode(() => withinPaidGrant(() => auth.requireActor()), entry.code);
    } else {
      assert.equal((await withinAuthoring(() => auth.requirePermission("courses:edit"))).user.id, selectedOwnerId);
      assert.equal((await withinPaidGrant(() => auth.requirePermission("courses:support"))).user.id, selectedOwnerId);
    }
    assert.equal(refreshes, "refreshes" in entry ? 2 * entry.refreshes : 0);
  }
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
