import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const [script, expectedError] of [
  ["highlevel-config-check.ts", "missing_highlevel_location_id"],
  ["highlevel-backfill.ts", "highlevel_backfill_failed"],
] as const) {
  test(`HighLevel CLI ${script} reaches its configuration guard under the package module settings`, () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    for (const key of Object.keys(env))
      if (key.startsWith("HIGHLEVEL_")) delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/register-server-only-test.mjs",
        "--import",
        "tsx",
        `scripts/${script}`,
        "--dry-run",
      ],
      { encoding: "utf8", env },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), expectedError);
    assert.equal(result.stdout, "");
  });
}
