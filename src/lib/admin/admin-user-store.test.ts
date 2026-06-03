import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositorySetup = String.raw`
  import assert from "node:assert/strict";

  import { createAdminUserStore } from "./src/lib/admin/admin-user-store.ts";

  function createRepository() {
    const rows = new Map();

    return {
      rows,
      async findByProviderUserId(providerUserId) {
        return [...rows.values()].find((row) => row.providerUserId === providerUserId) ?? null;
      },
      async updateAllowedAdminUserByProviderUserId(input) {
        const existing = [...rows.values()].find((row) => row.providerUserId === input.providerUserId);
        const row = {
          ...existing,
          providerUserId: input.providerUserId,
          email: input.email,
          emailNormalized: input.emailNormalized,
          displayName: input.displayName ?? null,
          role: input.role,
        };
        rows.set(row.id, row);
        return row;
      },
      async upsertAllowedAdminUser(input) {
        const existing = [...rows.values()].find((row) => row.emailNormalized === input.emailNormalized);
        const row = {
          id: existing?.id ?? "admin-" + (rows.size + 1),
          providerUserId: input.providerUserId,
          email: input.email,
          emailNormalized: input.emailNormalized,
          displayName: input.displayName ?? null,
          role: input.role,
          status: existing?.status ?? "active",
        };
        rows.set(row.id, row);
        return row;
      },
    };
  }
`;

const bootstrapOwnerScenario = String.raw`
  ${repositorySetup}

  async function run() {
    const repository = createRepository();
    const store = createAdminUserStore(repository);

    const owner = await store.findOrCreateAllowedAdminUser({
      allowedRole: "owner",
      displayName: "Owner Example",
      email: "Owner@Example.com",
      providerUserId: "clerk-owner",
    });

    assert.equal(owner?.emailNormalized, "owner@example.com");
    assert.equal(owner?.role, "owner");
    assert.equal(owner?.status, "active");
  }

  run();
`;

const disabledUserScenario = String.raw`
  ${repositorySetup}

  async function run() {
    const repository = createRepository();
    const store = createAdminUserStore(repository);

    repository.rows.set("admin-disabled", {
      id: "admin-disabled",
      providerUserId: "clerk-disabled",
      email: "disabled@example.com",
      emailNormalized: "disabled@example.com",
      displayName: null,
      role: "owner",
      status: "disabled",
    });

    const disabled = await store.findOrCreateAllowedAdminUser({
      allowedRole: "owner",
      displayName: "Disabled Example",
      email: "disabled@example.com",
      providerUserId: "clerk-disabled",
    });

    assert.equal(disabled?.status, "disabled");
    assert.equal(disabled?.displayName, null);
  }

  run();
`;

const updateExistingProviderScenario = String.raw`
  ${repositorySetup}

  async function run() {
    const repository = createRepository();
    const store = createAdminUserStore(repository);

    repository.rows.set("admin-existing", {
      id: "admin-existing",
      providerUserId: "clerk-owner",
      email: "old@example.com",
      emailNormalized: "old@example.com",
      displayName: "Old Name",
      role: "operator",
      status: "active",
    });

    const owner = await store.findOrCreateAllowedAdminUser({
      allowedRole: "owner",
      displayName: "Owner Example",
      email: "Owner@Example.com",
      providerUserId: "clerk-owner",
    });

    assert.equal(owner?.id, "admin-existing");
    assert.equal(owner?.emailNormalized, "owner@example.com");
    assert.equal(owner?.role, "owner");
  }

  run();
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

test("admin user store bootstraps allowlisted owner", () => {
  runScenario(bootstrapOwnerScenario);
});

test("admin user store denies disabled user even when allowlisted", () => {
  runScenario(disabledUserScenario);
});

test("admin user store updates existing active provider users", () => {
  runScenario(updateExistingProviderScenario);
});
