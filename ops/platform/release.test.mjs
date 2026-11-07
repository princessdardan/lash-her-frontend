import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contractManifestHash, validatePlatformRelease } from "./release.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";

const sha = (character) => `sha256:${character.repeat(64)}`;
const commit = (character) => character.repeat(40);

function manifest() {
  const artifacts = {};
  for (const [name, suffix, digestCharacter] of [["courseRuntime", "course-runtime", "1"], ["courseMigration", "course-migration", "2"],
    ["communityRuntime", "community-runtime", "3"], ["communityMigration", "community-migration", "4"],
    ["gateway", "gateway", "5"], ["frontendMigration", "frontend-migration", "6"]]) {
    artifacts[name] = { image: `ghcr.io/princessdardan/lash-her-${suffix}@${sha(digestCharacter)}`, sbomSha256: sha("a"),
      provenanceSha256: sha("b"), scan: "passed" };
  }
  return { version: 2, environment: "staging", releaseId: "profile-fixture",
    sources: {
      frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: commit("a"), requiredChecks: "passed" },
      course: { repository: "https://github.com/princessdardan/lash-her-course-api.git", commit: commit("b"), requiredChecks: "passed" },
      community: { repository: "https://github.com/princessdardan/lash-her-community-api.git", commit: commit("c"), requiredChecks: "passed" },
    },
    contractManifestSha256: contractManifestHash(),
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309", runId: "1", runAttempt: 1,
      verifiedAt: "2026-11-06T12:00:00.000Z" },
    integration: { state: "passed", reportSha256: sha("c") }, artifacts,
    frontendMigration: { sourceCommit: commit("a"), sqlArtifactSha256: sha("d") },
    approval: { state: "approved", operator: "Dardan", environment: "staging", releaseId: "profile-fixture",
      approvedAt: "2026-11-06T12:00:00.000Z" },
    migrations: { frontend: { state: "verified" }, course: { state: "verified" }, community: { state: "verified" } },
    recovery: { state: "verified" },
    workload: { environment: "production", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" },
    scheduler: { state: "verified", cancellation: "verified" } };
}

function profiled(value) {
  value.version = 3;
  for (const carrier of [value, value.sourceApproval, value.integration, ...Object.values(value.sources), value.workload,
    value.approval, value.frontendMigration]) carrier.qualificationTargetProfile = current;
  return value;
}

test("legacy release validation remains unprofiled and byte-stable", () => {
  const value = manifest(), before = JSON.stringify(value);
  assert.deepEqual(validatePlatformRelease(value, new Date("2026-11-06T13:00:00.000Z")), []);
  assert.equal(JSON.stringify(value), before);
  value.qualificationTargetProfile = current;
  assert.ok(validatePlatformRelease(value).includes("QUALIFICATION_TARGET_PROFILE_REFUSED"));
});

test("profiled release joins all independent candidate projections and current workload policy", () => {
  const value = profiled(manifest());
  assert.deepEqual(validatePlatformRelease(value, new Date("2026-11-06T13:00:00.000Z"), current), []);
  for (const mutate of [
    (copy) => { delete copy.integration.qualificationTargetProfile; },
    (copy) => { copy.sources.course.qualificationTargetProfile = { ...current, sha256: "f".repeat(64) }; },
    (copy) => { copy.workload.projectId = "prj_Wrong"; },
    (copy) => { copy.version = 2; },
  ]) {
    const copy = structuredClone(value); mutate(copy);
    assert.notDeepEqual(validatePlatformRelease(copy, new Date("2026-11-06T13:00:00.000Z"), current), []);
  }
  assert.notDeepEqual(validatePlatformRelease(value, new Date(), null), []);
});

test("fixed release CLI chooses context before raw decode and refuses reciprocal or duplicate input", () => {
  const root = mkdtempSync(join(tmpdir(), "release-profile-cli-"));
  try {
    const legacy = join(root, "legacy.json"), selected = join(root, "profiled.json"), duplicate = join(root, "duplicate-private-value.json"),
      linked = join(root, "linked.json");
    writeFileSync(legacy, JSON.stringify(manifest()));
    writeFileSync(selected, JSON.stringify(profiled(manifest())));
    writeFileSync(duplicate, JSON.stringify(profiled(manifest())).replace('"releaseId":"profile-fixture"',
      '"releaseId":"profile-fixture","releaseId":"private-must-not-print"'));
    const run = (...args) => spawnSync(process.execPath, ["ops/platform/release.mjs", ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run(legacy).status, 0);
    assert.equal(run("--check-profiled-current", selected).status, 0);
    assert.equal(run(selected).status, 1);
    assert.equal(run("--check-profiled-current", legacy).status, 1);
    const refused = run("--check-profiled-current", duplicate);
    assert.equal(refused.status, 1); assert.equal(refused.stderr, "Platform manifest verification refused\n");
    assert.ok(!`${refused.stdout}${refused.stderr}`.includes("private-must-not-print"));
    symlinkSync(selected, linked);
    const linkedRefusal = run("--check-profiled-current", linked);
    assert.equal(linkedRefusal.status, 1); assert.equal(linkedRefusal.stderr, "Platform manifest verification refused\n");
    assert.ok(!linkedRefusal.stderr.includes(linked));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
