import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindCommunityMediaRecovery, communityMediaSourceHashes } from "./community-media-recovery.mjs";
import { communityMediaPair } from "./community-media-pair.mjs";

const published = JSON.parse(readFileSync(new URL("./community-media-predecessor.json", import.meta.url)));
const runtimeImage = "ghcr.io/princessdardan/lash-her-platform-community-runtime@sha256:" + "4".repeat(64);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "community-media-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platformDirectory = join(root, "ops/platform");
  const reportFile = join(root, "community-media-recovery.json");
  mkdirSync(platformDirectory, { recursive: true });
  writeFileSync(join(platformDirectory, "compose.community-media.yaml"), "synthetic overlay");
  writeFileSync(join(platformDirectory, "community-media-restore-fence.sql"), "synthetic restore fence");
  writeFileSync(join(platformDirectory, "community-media-predecessor.json"), JSON.stringify(published));
  const testSource = "synthetic runner";
  const testSha = createHash("sha256").update(testSource).digest("hex");
  mkdirSync(join(root, "tests/support"), { recursive: true });
  writeFileSync(join(root, "tests/support/community-media-worker.test.mjs"), testSource);
  writeFileSync(join(platformDirectory, "published-recovery-harness.mjs"), testSource);
  const runtime = communityMediaSourceHashes(root);
  const candidate = {
    environment: "staging",
    releaseId: "p1-fixture",
    sources: { frontend: { commit: "f".repeat(40) }, community: { commit: "c".repeat(40) } },
    artifacts: { ...published.artifacts, communityRuntime: { image: runtimeImage } },
    runtime,
    integration: { state: "passed" },
  };
  const report = {
    version: 1,
    status: "ISOLATED_COMMUNITY_MEDIA_ROLLBACK_AND_RESTORE_PASS",
    currentRuntime: runtimeImage,
    predecessorRuntime: published.artifacts.communityRuntime.image,
    communitySourceCommit: candidate.sources.community.commit,
    runnerSha256: "sha256:" + testSha,
    overlaySha256: runtime.communityMediaOverlaySha256,
    restoreFenceSha256: runtime.communityMediaRestoreFenceSha256,
    platform: "linux/amd64",
    postgresVersion: "18.6 (synthetic)",
    applicationVersionOverlapped: false,
    mediaOffViewDenied: true,
    renewedSessionsUsed: true,
    preDeletionDatabaseSnapshotRestored: true,
    deletionReplayedIdempotently: true,
    deletedObjectAbsent: true,
    unrelatedObjectViewable: true,
    trafficAuthorized: false,
    cleanupPassed: true,
  };
  const bind = () => bindCommunityMediaRecovery(candidate, root, root);
  const save = value => writeFileSync(reportFile, JSON.stringify(value));
  const images = release => Object.fromEntries(Object.entries(release.artifacts).map(([key, value]) => [key, value.image]));
  const platform = {
    status: "PUBLISHED_APPLICATION_ROLLBACK_AND_DURABLE_RECOVERY_PASS", contractPhase: "p2",
    currentRelease: candidate.releaseId, rollbackRelease: published.releaseId, frontendSource: candidate.sources.frontend.commit,
    cleanupPassed: true, actualStagingChanged: false, applicationVersionOverlapped: false, runnerSha256: testSha,
    productionChanged: false, nativeSchedulerVerified: false, vmRecreationVerified: false,
    images: images(candidate), rollbackImages: images(published),
    rounds: ["current", "compatible-rollback", "restore-current"].map((phase, index) => {
      const release = index === 1 ? published : candidate;
      const runningImages = [
        ["gateway", "gateway"], ["course-tls", "gateway"], ["community-tls", "gateway"],
        ["course-api", "courseRuntime"], ["course-publisher", "courseRuntime"], ["course-snapshot", "courseRuntime"],
        ["course-media", "courseRuntime"], ["course-export-cleanup", "courseRuntime"],
        ["community-api", "communityRuntime"], ["community-worker", "communityRuntime"],
      ].map(([service, key], number) => ({service, containerId: String(number).repeat(64), reference: release.artifacts[key].image}));
      return { phase, releaseId: release.releaseId, preservedPriorBusinessRows: true, recoveredPendingEvents: index === 0 ? 0 : 2,
        records: Array.from({ length: 15 }, (_, id) => ({ name: "fixture-" + id, passed: true })),
        runningImages, gracefulStop: { processes: runningImages.map(instance => ({...instance, running: false, exitCode: 0, oomKilled: false})) } };
    }),
  };
  const savePlatform = value => writeFileSync(join(root, "media-platform-recovery.json"), JSON.stringify(value));
  savePlatform(platform);
  return { bind, save, report, platform, savePlatform, root, candidate };
}

test("candidate binds the exact verified predecessor and isolated media restore report", (t) => {
  const { bind, save, report } = fixture(t);
  save(report);
  const bound = bind();
  assert.equal(bound.integration.state, "passed");
  assert.equal(bound.integration.communityMediaRecovery.predecessorReleaseId, published.releaseId);
  assert.equal(bound.integration.communityMediaRecovery.scope, "isolated-platform-rollback-and-community-database-restore");
  assert.match(bound.integration.communityMediaRecovery.reportSha256, /^sha256:[a-f0-9]{64}$/u);
});

test("candidate rejects missing, stale, non-isolated or incomplete recovery evidence", (t) => {
  const { bind, save, report } = fixture(t);
  assert.throws(bind, { code: "ENOENT" });
  for (const change of [
    { currentRuntime: report.predecessorRuntime },
    { predecessorRuntime: runtimeImage },
    { restoreFenceSha256: "wrong" },
    { preDeletionDatabaseSnapshotRestored: false },
    { deletedObjectAbsent: false },
    { applicationVersionOverlapped: true },
    { trafficAuthorized: true },
    { cleanupPassed: false },
    { platform: "linux/arm64" },
    { postgresVersion: "16.6" },
    { authority: "unrecognized" },
  ]) {
    save({ ...report, ...change });
    assert.throws(bind, /Exact Community media rollback and restore evidence required/u);
  }
});

test("media proof alone cannot substitute for the exact platform rounds", (t) => {
  const { bind, save, report, platform, savePlatform } = fixture(t);
  save(report);
  platform.rounds[1].gracefulStop.processes.pop();
  savePlatform(platform);
  assert.throws(bind, /Exact platform rollback evidence required/u);
});

test("held pair requires completed issuer teardown and binds both exact manifest bytes", (t) => {
  const { bind, save, report, root } = fixture(t);
  save(report);
  const candidate = bind();
  writeFileSync(join(root, "release.candidate.json"), JSON.stringify(candidate));
  for (const file of ["community-media-issuer-qualification.yaml", "community-media-issuer-qualification.py"]) {
    writeFileSync(join(root, "tests/support", file), "synthetic issuer material");
  }
  const probeSha256 = createHash("sha256").update("synthetic issuer material").digest("hex");
  const scope = "p503-check-0123abcd";
  const issuer = {
    version: 1, scope: "disposable-roles-anywhere-issuer-chain", accountId: "691588646557", region: "us-east-1",
    templateSha256: probeSha256, probeSha256,
    liveWorkloadIssuerConfigured: false, trafficAuthorized: false,
    teardown: { scope, stackStatus: "DELETE_COMPLETE", resourcesRemoved: 8, directAbsenceConfirmed: true,
      localCertificateKeysRemoved: true },
    sessions: Object.fromEntries(["api", "worker"].map(role => [role, {
      issuer: "arn:aws:sts::691588646557:assumed-role/" + scope + "-" + role + "-issuer/certificate",
      target: "arn:aws:sts::691588646557:assumed-role/" + scope + "-" + role + "-target/" + scope + "-" + role,
      expiresAt: "2026-11-18T18:00:00Z", oppositeTargetDenied: true,
    }])),
  };
  const path = join(root, "ops/platform/community-media-issuer-proof.json");
  writeFileSync(path, JSON.stringify(issuer));
  const pair = communityMediaPair(candidate, root, root);
  assert.equal(pair.status, "ISOLATED_MEDIA_RECOVERY_PAIR_VERIFIED");
  assert.equal(pair.current.releaseId, candidate.releaseId);
  assert.equal(pair.predecessor.releaseId, published.releaseId);
  assert.equal(pair.trafficAuthorized, false);
  assert.equal(pair.releaseAccepted, false);
  issuer.teardown.directAbsenceConfirmed = false;
  writeFileSync(path, JSON.stringify(issuer));
  assert.throws(() => communityMediaPair(candidate, root, root), /Completed isolated AWS issuer/u);
});
