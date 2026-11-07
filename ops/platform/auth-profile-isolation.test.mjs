import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The actual TypeScript customer configuration/adapter metadata runs in a child;
// ordinary platform tests need no custom loader and no provider/database access.
test("installed Auth.js isolates customer email and administrator JWT profiles in both orders", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/register-server-only-test.mjs",
    "--test", "ops/platform/harness/auth-profile-isolation-regression.mjs"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH, NODE_ENV: "test", APP_ENV: "local" },
    });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /(?:# pass 2|ℹ pass 2)/u);
  assert.doesNotMatch(result.stdout, /(?:# fail [1-9]|ℹ fail [1-9])/u);
});
