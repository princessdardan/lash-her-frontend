import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { p2NativeHash } from "../p2-lifecycle-native.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "../qualification-target-profile.mjs";

// Supply the previously reviewed records to the real successor join. The
// catalog bytes are source-pinned. This archive models the predecessor release,
// while the current migration lease uses its own disposable database.
export function prepareOwnedRotationPredecessor(sourceRoot, { releaseId, sourceCommit, candidateSha256 }) {
  assert.match(releaseId, /^[a-z0-9][a-z0-9-]{0,63}$/u);
  assert.match(sourceCommit, /^(?!0+$)[a-f0-9]{40}$/u);
  assert.match(candidateSha256, /^(?!0+$)[a-f0-9]{64}$/u);
  const bytes = readFileSync(join(sourceRoot, "ops/platform/managed-neon-replacement-catalog.json"));
  const { id, provider, target, databaseOid, migrationRoleOid, administrativeLogins } = JSON.parse(bytes);
  const reviewed = Buffer.from(JSON.stringify({
    version: 2, status: "P2_FRONTEND_REPLACEMENT_PLAN_PREPARED",
    environment: "staging", qualificationTargetProfile: profile, releaseId, sourceCommit, candidateSha256,
    replacement: {
      provider, target, databaseOid, migrationRoleOid, administrativeLogins,
      recoveryRef: "owned/predecessor", approvedPendingTags: [],
      managedCatalog: { id, sha256: p2NativeHash(bytes) },
    },
  }) + "\n");
  const reviewedPlanSha256 = p2NativeHash(reviewed);
  return {
    reviewedPlanSha256,
    retain(results, receipt) {
      assert.match(results, /^\/var\/lib\/lash-her\/releases\/staging\/p2-owned-rotation-[a-zA-Z0-9]+\/results$/u);
      assert.equal(realpathSync(results), results);
      assert.ok(Buffer.isBuffer(receipt));
      const original = JSON.parse(receipt);
      assert.equal(original.reviewedPlanSha256, reviewedPlanSha256);
      assert.deepEqual([original.releaseId, original.sourceCommit, original.candidateSha256], [releaseId, sourceCommit, candidateSha256]);
      const directory = join(results, "p2-profiled-replacement-write-" + releaseId);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "reviewed-plan.json"), reviewed, { flag: "wx", mode: 0o600 });
      writeFileSync(join(directory, "p2-frontend-replacement-write-outcome.json"), receipt, { flag: "wx", mode: 0o600 });
    },
  };
}
