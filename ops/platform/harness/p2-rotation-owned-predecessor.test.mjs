import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { p2NativeHash } from "../p2-lifecycle-native.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "../qualification-target-profile.mjs";

// Supply the previously reviewed records to the real successor join. The
// catalog bytes are source-pinned. This archive models the predecessor release,
// while the current migration lease uses its own disposable database.
export function prepareOwnedRotationPredecessor(sourceRoot) {
  const bytes = readFileSync(join(sourceRoot, "ops/platform/managed-neon-replacement-catalog.json"));
  const { id, provider, target, databaseOid, migrationRoleOid, administrativeLogins } = JSON.parse(bytes);
  const reviewed = Buffer.from(JSON.stringify({
    version: 2, environment: "staging", qualificationTargetProfile: profile,
    replacement: {
      provider, target, databaseOid, migrationRoleOid, administrativeLogins,
      recoveryRef: "owned/predecessor", approvedPendingTags: [],
      managedCatalog: { id, sha256: p2NativeHash(bytes) },
    },
  }) + "\n");
  const reviewedPlanSha256 = p2NativeHash(reviewed);
  return {
    reviewedPlanSha256,
    retain(results, releaseId, receipt) {
      assert.match(results, /^\/var\/lib\/lash-her\/releases\/staging\/p2-owned-rotation-[a-zA-Z0-9]+\/results$/u);
      assert.equal(realpathSync(results), results);
      assert.match(releaseId, /^[a-z0-9][a-z0-9-]{0,63}$/u);
      assert.ok(Buffer.isBuffer(receipt));
      assert.equal(JSON.parse(receipt).reviewedPlanSha256, reviewedPlanSha256);
      const directory = join(results, "p2-profiled-replacement-write-" + releaseId);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "reviewed-plan.json"), reviewed, { flag: "wx", mode: 0o600 });
      writeFileSync(join(directory, "p2-frontend-replacement-write-outcome.json"), receipt, { flag: "wx", mode: 0o600 });
    },
  };
}
