import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("P4-05 routes retain recovery admission and read-only override reporting", () => {
  const result = spawnSync(process.execPath, [
    "--import", "./scripts/register-server-only-test.mjs",
    "--import", "tsx", "tests/support/course-purchase-integration.mjs",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
