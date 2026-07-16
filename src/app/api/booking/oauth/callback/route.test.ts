import assert from "node:assert/strict";
import test from "node:test";

import type { BookingCalendarOAuthState } from "@/lib/booking/calendar-oauth-state";

import {
  handleAdminCalendarOAuthCallback,
  type AdminCalendarOAuthCallbackDependencies,
} from "@/lib/admin/admin-calendar-oauth-callback";

const origin = "https://example.test";

test("owner and employee duplicate-account rejection revoke the new token", async (t) => {
  for (const flowType of ["admin", "employee"] as const) {
    await t.test(flowType, async () => {
      const state = createState(flowType);
      const revoked: string[] = [];
      const dependencies = createDependencies(state, {
        revokeRefreshToken: async (token) => {
          revoked.push(token);
        },
        saveEmployeeCredential: async () => ({ status: "owned_elsewhere" }),
        saveOwnerCredential: async () => ({ status: "owned_elsewhere" }),
      });

      const response = await handleAdminCalendarOAuthCallback(
        { code: "oauth-code", origin, state: "admin_state" },
        dependencies,
      );

      assert.equal(response.status, 307);
      assert.deepEqual(revoked, ["new-refresh-token"]);
      const location = new URL(response.headers.get("location")!);
      assert.match(
        location.searchParams.get("error") ?? "",
        /already managed/,
      );
    });
  }
});

test("OAuth persistence failure revokes the issued refresh token", async () => {
  const state = createState("admin");
  const revoked: string[] = [];
  const dependencies = createDependencies(state, {
    revokeRefreshToken: async (token) => {
      revoked.push(token);
    },
    saveOwnerCredential: async () => {
      throw new Error("unique account conflict");
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.deepEqual(revoked, ["new-refresh-token"]);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /authorization failed/,
  );
});

test("unverified Google identity revokes the issued token before redirect", async () => {
  const state = createState("employee");
  const revoked: string[] = [];
  const dependencies = createDependencies(state, {
    exchangeCode: async () => ({
      async getVerifiedProfile() {
        return {
          accountEmail: "employee@example.test",
          providerAccountId: "google-account-1",
          verified: false,
        };
      },
      refreshToken: "new-refresh-token",
      scopes: ["calendar"],
    }),
    revokeRefreshToken: async (token) => {
      revoked.push(token);
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "employee_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.deepEqual(revoked, ["new-refresh-token"]);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /could not be verified/,
  );
});

test("successful callback saves the verified credential and redirects deterministically", async () => {
  const state = createState("admin");
  const saved: unknown[] = [];
  const dependencies = createDependencies(state, {
    saveOwnerCredential: async (input) => {
      saved.push(input);
      return { status: "reconnected_existing" };
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.equal(saved.length, 1);
  assert.equal(
    new URL(response.headers.get("location")!).searchParams.get("notice"),
    "Google Calendar account connected.",
  );
});

function createState(
  flowType: "admin" | "employee",
): BookingCalendarOAuthState {
  return {
    actorAdminUserId: "admin-user-1",
    connectionId: "connection-1",
    flowType,
    resourceId: flowType === "employee" ? "resource-1" : null,
    returnTo:
      flowType === "employee"
        ? "/admin/my-calendar"
        : "/admin/calendar-connections",
  };
}

function createDependencies(
  state: BookingCalendarOAuthState,
  overrides: Partial<AdminCalendarOAuthCallbackDependencies> = {},
): AdminCalendarOAuthCallbackDependencies {
  return {
    async assertEmployeeOwnsConnection() {},
    async authorizeActor() {
      return { user: { id: state.actorAdminUserId } };
    },
    async consumeState() {
      return state;
    },
    async exchangeCode() {
      return {
        async getVerifiedProfile() {
          return {
            accountEmail: "calendar@example.test",
            providerAccountId: "google-account-1",
            verified: true,
          };
        },
        refreshToken: "new-refresh-token",
        scopes: ["calendar"],
      };
    },
    async revokeRefreshToken() {},
    async saveEmployeeCredential() {
      return { status: "saved" };
    },
    async saveOwnerCredential() {
      return { status: "saved" };
    },
    ...overrides,
  };
}
