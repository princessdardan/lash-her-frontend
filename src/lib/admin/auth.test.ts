import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const setup = String.raw`
  import assert from "node:assert/strict";

  import { createAdminAuth } from "./src/lib/admin/auth.ts";
  import { AdminAuthError } from "./src/lib/admin/types.ts";

  const ownerUser = {
    displayName: "Owner",
    email: "owner@example.com",
    emailNormalized: "owner@example.com",
    id: "admin-owner",
    providerUserId: "clerk-owner",
    role: "owner",
    status: "active",
  };

  async function rejectsWithCode(action, code) {
    await assert.rejects(
      action,
      (error) => error instanceof AdminAuthError && error.code === code,
    );
  }
`;

function runScenario(scenario: string): void {
  const result = spawnSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

test("requireAdmin rejects anonymous sessions", () => {
  runScenario(String.raw`
    ${setup}

    async function run() {
      const auth = createAdminAuth({
        getAllowlists: () => ({ ownerEmails: new Set(), operatorEmails: new Set() }),
        getSessionUser: async () => null,
        userStore: { findOrCreateAllowedAdminUser: async () => null },
      });

      await rejectsWithCode(() => auth.requireAdmin(), "unauthenticated");
    }

    run();
  `);
});

test("requireAdmin rejects signed-in users outside allowlists", () => {
  runScenario(String.raw`
    ${setup}

    async function run() {
      const auth = createAdminAuth({
        getAllowlists: () => ({ ownerEmails: new Set(), operatorEmails: new Set() }),
        getSessionUser: async () => ({
          displayName: "Visitor",
          email: "visitor@example.com",
          providerUserId: "clerk-visitor",
        }),
        userStore: { findOrCreateAllowedAdminUser: async () => null },
      });

      await rejectsWithCode(() => auth.requireAdmin(), "not_allowed");
    }

    run();
  `);
});

test("requireAdmin returns allowlisted owner", () => {
  runScenario(String.raw`
    ${setup}

    async function run() {
      const auth = createAdminAuth({
        getAllowlists: () => ({ ownerEmails: new Set(["owner@example.com"]), operatorEmails: new Set() }),
        getSessionUser: async () => ({
          displayName: "Owner",
          email: "owner@example.com",
          providerUserId: "clerk-owner",
        }),
        userStore: { findOrCreateAllowedAdminUser: async () => ownerUser },
      });

      const actor = await auth.requireAdmin();

      assert.equal(actor.user.role, "owner");
    }

    run();
  `);
});

test("requireOwner rejects operator", () => {
  runScenario(String.raw`
    ${setup}

    async function run() {
      const auth = createAdminAuth({
        getAllowlists: () => ({ ownerEmails: new Set(), operatorEmails: new Set(["operator@example.com"]) }),
        getSessionUser: async () => ({
          displayName: "Operator",
          email: "operator@example.com",
          providerUserId: "clerk-operator",
        }),
        userStore: {
          findOrCreateAllowedAdminUser: async () => ({
            ...ownerUser,
            email: "operator@example.com",
            emailNormalized: "operator@example.com",
            id: "admin-operator",
            providerUserId: "clerk-operator",
            role: "operator",
          }),
        },
      });

      await rejectsWithCode(() => auth.requireOwner(), "forbidden");
    }

    run();
  `);
});

test("requireAdmin rejects disabled admin users", () => {
  runScenario(String.raw`
    ${setup}

    async function run() {
      const auth = createAdminAuth({
        getAllowlists: () => ({ ownerEmails: new Set(["disabled@example.com"]), operatorEmails: new Set() }),
        getSessionUser: async () => ({
          displayName: "Disabled",
          email: "disabled@example.com",
          providerUserId: "clerk-disabled",
        }),
        userStore: {
          findOrCreateAllowedAdminUser: async () => ({
            ...ownerUser,
            email: "disabled@example.com",
            emailNormalized: "disabled@example.com",
            id: "admin-disabled",
            providerUserId: "clerk-disabled",
            status: "disabled",
          }),
        },
      });

      await rejectsWithCode(() => auth.requireAdmin(), "disabled");
    }

    run();
  `);
});
