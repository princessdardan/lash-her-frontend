import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("admin auth keeps database roles authoritative and enforces resource scopes", () => {
  const source = String.raw`
    import assert from "node:assert/strict";
    import authService from "./src/lib/admin/auth-service.ts";
    import adminTypes from "./src/lib/admin/types.ts";

    const { createAdminAuth } = authService;
    const { AdminAuthError } = adminTypes;

    function createStore(initialRows = [], resourceIds = new Map()) {
      const rows = new Map(initialRows.map((row) => [row.id, row]));

      return {
        rows,
        async bindIdentity(input) {
          const existing = rows.get(input.adminUserId);
          const updated = {
            ...existing,
            displayName: input.displayName,
            email: input.email,
            emailNormalized: input.email.trim().toLowerCase(),
            providerUserId: input.providerUserId,
          };
          rows.set(updated.id, updated);
          return updated;
        },
        async createBootstrapOwner(identity) {
          const row = {
            displayName: identity.displayName,
            email: identity.email,
            emailNormalized: identity.email.trim().toLowerCase(),
            id: "bootstrap-owner",
            providerUserId: identity.providerUserId,
            role: "owner",
            status: "active",
          };
          rows.set(row.id, row);
          return row;
        },
        async findByEmailNormalized(email) {
          return [...rows.values()].find((row) => row.emailNormalized === email) ?? null;
        },
        async findByProviderUserId(id) {
          return [...rows.values()].find((row) => row.providerUserId === id) ?? null;
        },
        async listBookingResourceIds(id) {
          return resourceIds.get(id) ?? [];
        },
        async recordSignIn(input) {
          return this.bindIdentity(input);
        },
      };
    }

    async function rejectsWithCode(action, code) {
      await assert.rejects(
        action,
        (error) => error instanceof AdminAuthError && error.code === code,
      );
    }

    const identity = {
      displayName: "Employee",
      email: "employee@example.com",
      emailVerified: true,
      providerUserId: "google-sub-employee",
    };

    const employee = {
      displayName: "Employee",
      email: "employee@example.com",
      emailNormalized: "employee@example.com",
      id: "admin-employee",
      providerUserId: "google-sub-employee",
      role: "employee",
      status: "active",
    };

    const employeeStore = createStore(
      [employee],
      new Map([[employee.id, ["resource-a"]]]),
    );
    const employeeAuth = createAdminAuth({
      getIdentity: async () => identity,
      getOwnerEmails: () => new Set(["employee@example.com"]),
      userStore: employeeStore,
    });

    async function run() {
    const actor = await employeeAuth.requirePermission("bookings:view", {
      bookingResourceId: "resource-a",
    });
    assert.equal(actor.user.role, "employee");
    assert.deepEqual(actor.bookingResourceIds, ["resource-a"]);
    await rejectsWithCode(
      () => employeeAuth.requirePermission("bookings:view", {
        bookingResourceId: "resource-b",
      }),
      "forbidden",
    );
    await rejectsWithCode(
      () => employeeAuth.requirePermission("marketing:view"),
      "forbidden",
    );

    const disabledStore = createStore([{ ...employee, status: "disabled" }]);
    const disabledAuth = createAdminAuth({
      getIdentity: async () => identity,
      getOwnerEmails: () => new Set(["employee@example.com"]),
      userStore: disabledStore,
    });
    await rejectsWithCode(() => disabledAuth.requireActor(), "disabled");

    const provisionedStore = createStore([{
      ...employee,
      id: "provisioned-admin",
      providerUserId: "pending:provisioned-admin",
      role: "admin",
    }]);
    const provisionedAuth = createAdminAuth({
      getIdentity: async () => identity,
      getOwnerEmails: () => new Set(),
      userStore: provisionedStore,
    });
    const provisionedActor = await provisionedAuth.requireActor();
    assert.equal(provisionedActor.user.role, "admin");
    assert.equal(provisionedActor.user.providerUserId, "google-sub-employee");

    const bootstrapStore = createStore();
    const bootstrapAuth = createAdminAuth({
      getIdentity: async () => ({ ...identity, email: "owner@example.com" }),
      getOwnerEmails: () => new Set(["owner@example.com"]),
      userStore: bootstrapStore,
    });
    assert.equal((await bootstrapAuth.requireActor()).user.role, "owner");

    const deniedAuth = createAdminAuth({
      getIdentity: async () => identity,
      getOwnerEmails: () => new Set(),
      userStore: createStore(),
    });
    await rejectsWithCode(() => deniedAuth.requireActor(), "not_allowed");

    const unverifiedAuth = createAdminAuth({
      getIdentity: async () => ({ ...identity, emailVerified: false }),
      getOwnerEmails: () => new Set(["employee@example.com"]),
      userStore: createStore(),
    });
    await rejectsWithCode(() => unverifiedAuth.requireActor(), "unverified_email");
    }

    run();
  `;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env },
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
