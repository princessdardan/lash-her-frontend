import assert from "node:assert/strict";
import test from "node:test";

import type { BookingCalendarOAuthState } from "@/lib/booking/calendar-oauth-state";

import {
  handleAdminCalendarOAuthCallback,
  type AdminCalendarOAuthCallbackDependencies,
} from "@/lib/admin/admin-calendar-oauth-callback";

const origin = "https://example.test";

test("duplicate-account rejection preserves the existing Google project grant", async (t) => {
  for (const flowType of ["admin", "employee"] as const) {
    await t.test(flowType, async () => {
      const state = createState(flowType);
      const disabled: string[] = [];
      const revoked: string[] = [];
      const dependencies = createDependencies(state, {
        disableProvisionalConnection: async (payload) => {
          disabled.push(payload.connectionId);
        },
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
      assert.deepEqual(disabled, []);
      assert.deepEqual(revoked, []);
      const location = new URL(response.headers.get("location")!);
      const errorMessage = location.searchParams.get("error") ?? "";
      assert.match(errorMessage, /already managed by another contractor/);
      assert.doesNotMatch(errorMessage, /\bemployees?\b/i);
    });
  }
});

test("provider denial consumes state, rechecks the actor, and redirects to the fixed path", async () => {
  const state = {
    ...createState("employee"),
    returnTo: "//attacker.example/redirect",
  };
  let consumed = 0;
  let authorized = 0;
  const disabled: string[] = [];
  const dependencies = createDependencies(state, {
    async authorizeActor() {
      authorized += 1;
      return { user: { id: state.actorAdminUserId } };
    },
    async consumeState() {
      consumed += 1;
      return consumed === 1 ? state : null;
    },
    async disableProvisionalConnection(payload) {
      disabled.push(payload.connectionId);
    },
    async exchangeCode() {
      throw new Error("denied callbacks must not exchange a code");
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: null, origin, state: "employee_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.equal(consumed, 1);
  assert.equal(authorized, 1);
  assert.deepEqual(disabled, ["connection-1"]);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.pathname, "/admin/my-calendar");
  assert.match(location.searchParams.get("error") ?? "", /denied or cancelled/);

  const replay = await handleAdminCalendarOAuthCallback(
    { code: null, origin, state: "employee_state" },
    dependencies,
  );
  assert.equal(replay.status, 400);
  assert.equal(consumed, 2);
});

test("different-account reconnect preserves the existing account and project grant", async () => {
  const state = createState("admin");
  const revoked: string[] = [];
  const dependencies = createDependencies(state, {
    async revokeRefreshToken(token) {
      revoked.push(token);
    },
    async saveOwnerCredential() {
      return {
        connectionId: state.connectionId,
        status: "account_mismatch",
      };
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.deepEqual(revoked, []);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /already assigned/,
  );
});

test("OAuth persistence failure revokes the issued refresh token", async () => {
  const state = createState("admin");
  const disabled: string[] = [];
  const revoked: string[] = [];
  const dependencies = createDependencies(state, {
    disableProvisionalConnection: async (payload) => {
      disabled.push(payload.connectionId);
    },
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
  assert.deepEqual(disabled, ["connection-1"]);
  assert.deepEqual(revoked, ["new-refresh-token"]);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /authorization failed/,
  );
});

test("OAuth persistence failure preserves an established connection grant", async () => {
  const state = createState("admin");
  const revoked: string[] = [];
  const dependencies = createDependencies(state, {
    async canRevokeRejectedGrant() {
      return false;
    },
    async revokeRefreshToken(token) {
      revoked.push(token);
    },
    async saveOwnerCredential() {
      throw new Error("database unavailable");
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.deepEqual(revoked, []);
});

test("unverified Google identity revokes the issued token before redirect", async () => {
  const state = createState("employee");
  const disabled: string[] = [];
  const revoked: string[] = [];
  const dependencies = createDependencies(state, {
    disableProvisionalConnection: async (payload) => {
      disabled.push(payload.connectionId);
    },
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
  assert.deepEqual(disabled, ["connection-1"]);
  assert.deepEqual(revoked, ["new-refresh-token"]);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /could not be verified/,
  );
});

test("missing offline access disables the provisional connection", async () => {
  const state = createState("admin");
  const disabled: string[] = [];
  const dependencies = createDependencies(state, {
    disableProvisionalConnection: async (payload) => {
      disabled.push(payload.connectionId);
    },
    exchangeCode: async () => ({
      async getVerifiedProfile() {
        throw new Error("profile should not be requested without a token");
      },
      scopes: ["calendar"],
    }),
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.deepEqual(disabled, ["connection-1"]);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /offline access/,
  );
});

test("OAuth cleanup failures do not replace the deterministic error redirect", async () => {
  const state = createState("admin");
  const dependencies = createDependencies(state, {
    async disableProvisionalConnection() {
      throw new Error("database unavailable");
    },
    async revokeRefreshToken() {
      throw new Error("Google revocation unavailable");
    },
    async saveOwnerCredential() {
      throw new Error("persistence conflict");
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.match(
    new URL(response.headers.get("location")!).searchParams.get("error") ?? "",
    /authorization failed/,
  );
});

test("successful callback saves the verified credential and redirects deterministically", async () => {
  const state = createState("admin");
  const disabled: string[] = [];
  const saved: unknown[] = [];
  const dependencies = createDependencies(state, {
    disableProvisionalConnection: async (payload) => {
      disabled.push(payload.connectionId);
    },
    saveOwnerCredential: async (input) => {
      saved.push(input);
      return {
        connectionId: "existing-connection",
        status: "reconnected_existing",
      };
    },
  });

  const response = await handleAdminCalendarOAuthCallback(
    { code: "oauth-code", origin, state: "admin_state" },
    dependencies,
  );

  assert.equal(response.status, 307);
  assert.deepEqual(disabled, []);
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
    async canRevokeRejectedGrant() {
      return true;
    },
    async consumeState() {
      return state;
    },
    async disableProvisionalConnection() {},
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
      return { connectionId: state.connectionId, status: "saved" };
    },
    async saveOwnerCredential() {
      return { connectionId: state.connectionId, status: "saved" };
    },
    ...overrides,
  };
}
