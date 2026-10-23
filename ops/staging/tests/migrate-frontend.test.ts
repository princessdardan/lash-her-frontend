import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseContext, assertStagingTarget } from "../migrate-frontend";
const host = "ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech";
const connection = `postgresql://neondb_owner:synthetic-only@${host}/neondb?sslmode=verify-full`;
test("only the reviewed direct staging owner and verified TLS can migrate", () => {
  assert.doesNotThrow(() => assertStagingTarget(connection));
  for (const url of [undefined, "invalid", connection.replace(host, "production.example"), connection.replace(host, host.replace(".c-", "-pooler.c-")), connection.replace("neondb_owner", "runtime"), connection.replace("verify-full", "require"), connection + "&options=-csearch_path%3Dother", connection.replace("/neondb", "/other")]) {
    assert.throws(() => assertStagingTarget(url), error => error instanceof Error && !error.message.includes("synthetic-only"));
  }
});
test("protected job identity, branch and exact approved revision are mandatory", () => {
  const revision = "a".repeat(40);
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "princessdardan/lash-her-frontend", GITHUB_REF: "refs/heads/staging", GITHUB_SHA: revision, STAGING_MIGRATION_EXPECTED_COMMIT: revision, STAGING_MIGRATION_RECOVERY_REFERENCE: "https://example.test/reviewed-recovery-evidence" };
  assert.doesNotThrow(() => assertReleaseContext(env, revision));
  for (const change of [{ STAGING_MIGRATION_RECOVERY_REFERENCE: "" }, { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "other/repo" }, { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/heads/codex/p1-02-retention-admin-fix" }, { GITHUB_SHA: "b".repeat(40) }, { STAGING_MIGRATION_EXPECTED_COMMIT: "b".repeat(40) }]) {
    assert.throws(() => assertReleaseContext({ ...env, ...change }, revision));
  }
});
