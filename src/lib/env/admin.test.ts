import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runScenario(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      source,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env },
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

test("owner bootstrap email parsing normalizes and removes empty entries", () => {
  runScenario(String.raw`
    import assert from "node:assert/strict";
    import adminEnvironment from "./src/lib/env/admin.ts";

    const { parseAdminOwnerEmails } = adminEnvironment;

    assert.deepEqual(
      [...parseAdminOwnerEmails(" Owner@Example.com, ,SECOND@example.com,owner@example.com ")],
      ["owner@example.com", "second@example.com"],
    );
  `);
});

test("bootstrap owner matching is case insensitive", () => {
  runScenario(String.raw`
    import assert from "node:assert/strict";
    import adminEnvironment from "./src/lib/env/admin.ts";

    const { isAdminBootstrapOwner } = adminEnvironment;

    assert.equal(
      isAdminBootstrapOwner(" OWNER@example.com ", new Set(["owner@example.com"])),
      true,
    );
    assert.equal(
      isAdminBootstrapOwner("employee@example.com", new Set(["owner@example.com"])),
      false,
    );
  `);
});

test("environment labels distinguish local, preview, and production", () => {
  runScenario(String.raw`
    import assert from "node:assert/strict";
    import adminEnvironment from "./src/lib/env/admin.ts";

    const { getAdminEnvironmentLabel } = adminEnvironment;

    assert.equal(getAdminEnvironmentLabel({ VERCEL_ENV: "production" }), "production");
    assert.equal(getAdminEnvironmentLabel({ VERCEL_ENV: "preview" }), "preview");
    assert.equal(getAdminEnvironmentLabel({ NODE_ENV: "development" }), "local");
    assert.equal(getAdminEnvironmentLabel({ NODE_ENV: "test" }), "unknown");
  `);
});
