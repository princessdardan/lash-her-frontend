/** Retired staging job; guard exports retained for historical tests only. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const expectedHost = "ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech";

export function assertReleaseContext(env: Record<string, string | undefined>, revision: string): void {
  assert.equal(process.versions.node.split(".")[0], "24", "Node 24 is required");
  assert.equal(env.GITHUB_ACTIONS, "true", "Protected GitHub job required");
  assert.equal(env.GITHUB_REPOSITORY, "princessdardan/lash-her-frontend");
  assert(["refs/heads/staging", "refs/heads/codex/p1-02-staging-release"].includes(env.GITHUB_REF ?? ""), "Reviewed release branch required");
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, revision, "Checkout must match the job revision");
  assert.equal(env.STAGING_MIGRATION_EXPECTED_COMMIT, revision, "Protected environment must approve the exact revision");
  assert.match(env.STAGING_MIGRATION_RECOVERY_REFERENCE ?? "", /^https:\/\/[^\s?]+$/, "Protected recovery evidence URL required");
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    assert.equal(existsSync(file), false, "Migration checkout must contain no environment files");
  }
}

export function assertStagingTarget(value: string | undefined): URL {
  // Never include URL values in assertions or exceptions.
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("Invalid staging database connection"); }
  if (!(["postgres:", "postgresql:"].includes(url.protocol) &&
    url.hostname === expectedHost && (!url.port || url.port === "5432") &&
    url.pathname === "/neondb" && decodeURIComponent(url.username) === "neondb_owner" &&
    url.password && url.searchParams.get("sslmode") === "verify-full" &&
    [...url.searchParams.keys()].every(key => ["sslmode", "channel_binding"].includes(key)))) {
    throw new Error("Connection must select the reviewed direct staging owner with certificate verification");
  }
  return url;
}

async function main() {
  throw new Error("Legacy protected staging migrator retired; use ops/platform/frontend-migration.mjs through the reviewed operator release");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Legacy staging migrator retired; use ops/platform/frontend-migration.mjs through the reviewed operator release."); process.exitCode = 1; });
}
