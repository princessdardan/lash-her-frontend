// Run only via asm-exec with RELEASE_DB_URL resolved in the child environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assertStagingTarget } from "./migrate-frontend.ts";
const repository = "princessdardan/lash-her-frontend";
const environment = "staging-migrations";
try {
  const url = assertStagingTarget(process.env.RELEASE_DB_URL);
  delete process.env.RELEASE_DB_URL;
  const inspection = spawnSync("gh", ["api", `repos/${repository}/environments/${environment}`], { encoding: "utf8" });
  assert.equal(inspection.status, 0);
  const config = JSON.parse(inspection.stdout);
  assert.equal(config.can_admins_bypass, false);
  const review = config.protection_rules.find(rule => rule.type === "required_reviewers");
  assert(review && review.reviewers.length === 1 && review.reviewers[0].reviewer.login === "princessdardan", "Sole developer protected review required");
  assert.equal(review.prevent_self_review, false, "Explicitly approved sole developer gate required");
  assert.deepEqual(config.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true });
  const branches = spawnSync("gh", ["api", `repos/${repository}/environments/${environment}/deployment-branch-policies`], { encoding: "utf8" });
  assert.equal(branches.status, 0);
  const policies = JSON.parse(branches.stdout).branch_policies;
  assert.deepEqual(policies.map(policy => `${policy.type}:${policy.name}`).sort(), ["branch:codex/p1-02-staging-release", "branch:staging"]);
  const result = spawnSync("gh", ["secret", "set", "STAGING_MIGRATION_DATABASE_URL", "--repo", repository, "--env", environment], { input: url.toString(), encoding: "utf8" });
  assert.equal(result.status, 0);
  console.log(JSON.stringify({ repository, environment, secretName: "STAGING_MIGRATION_DATABASE_URL", installed: true, valuesLogged: false }));
} catch { console.error("Protected migration credential handoff failed; values and provider error details withheld."); process.exitCode = 1; }
