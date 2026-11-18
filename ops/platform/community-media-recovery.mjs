import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const files = {
  communityMediaOverlaySha256: "ops/platform/compose.community-media.yaml",
  communityMediaRestoreFenceSha256: "ops/platform/community-media-restore-fence.sql",
};
const sha256 = (contents) => "sha256:" + createHash("sha256").update(contents).digest("hex");
const digest = /^ghcr\.io\/princessdardan\/lash-her-platform-community-runtime@sha256:[a-f0-9]{64}$/u;
const predecessorFile = "ops/platform/community-media-predecessor.json";
const reportFile = "community-media-recovery.json";

export function communityMediaSourceHashes(source) {
  if (!existsSync(join(source, files.communityMediaOverlaySha256))) return {};
  return Object.fromEntries(Object.entries(files).map(([key, path]) => [key, sha256(readFileSync(join(source, path)))]));
}

const platformReportFile = "media-platform-recovery.json";
const platformServices = {
  gateway: "gateway", "course-tls": "gateway", "community-tls": "gateway",
  "course-api": "courseRuntime", "course-publisher": "courseRuntime",
  "course-snapshot": "courseRuntime", "course-media": "courseRuntime",
  "course-export-cleanup": "courseRuntime", "community-api": "communityRuntime",
  "community-worker": "communityRuntime",
};

function sameImages(refs, release) {
  const artifacts = Object.entries(release.artifacts);
  return Object.keys(refs ?? {}).length === artifacts.length &&
    artifacts.every(([key, artifact]) => refs[key] === artifact.image);
}

function platformRoundsAgree(report, current, previous) {
  const phases = ["current", "compatible-rollback", "restore-current"];
  return report.status === "PUBLISHED_APPLICATION_ROLLBACK_AND_DURABLE_RECOVERY_PASS" &&
    report.contractPhase === "p2" && report.currentRelease === current.releaseId &&
    report.rollbackRelease === previous.releaseId && report.frontendSource === current.sources.frontend.commit &&
    report.cleanupPassed === true && report.actualStagingChanged === false &&
    report.productionChanged === false && report.nativeSchedulerVerified === false &&
    report.vmRecreationVerified === false &&
    report.applicationVersionOverlapped === false && sameImages(report.images, current) &&
    sameImages(report.rollbackImages, previous) && report.rounds?.length === phases.length &&
    report.rounds.every((round, index) => {
      const release = index === 1 ? previous : current;
      const services = Object.entries(platformServices);
      const running = round.runningImages;
      const stopped = round.gracefulStop?.processes;
      return round.phase === phases[index] && round.releaseId === release.releaseId &&
        round.preservedPriorBusinessRows === true && (index === 0 || round.recoveredPendingEvents === 2) &&
        round.records?.length === 15 && new Set(round.records.map(check => check.name)).size === 15 &&
        round.records.every(check => check.passed === true) &&
        running?.length === services.length && stopped?.length === services.length &&
        new Set(running.map(({ containerId }) => containerId)).size === services.length &&
        services.every(([service, artifact]) => {
          const instance = running.find(item => item.service === service);
          return instance?.reference === release.artifacts[artifact].image &&
            /^[a-f0-9]{64}$/u.test(instance.containerId ?? "") &&
            stopped.some(item => item.service === service && item.reference === instance.reference &&
              /^[a-f0-9]{64}$/u.test(item.containerId ?? "") &&
              (service === "gateway" || item.containerId === instance.containerId) &&
              item.running === false && item.exitCode === 0 && item.oomKilled === false);
        });
    });
}

export function bindCommunityMediaRecovery(candidate, source, evidence) {
  const hashes = communityMediaSourceHashes(source);
  if (!Object.keys(hashes).length) {
    if (candidate.runtime?.communityMediaOverlaySha256 || existsSync(join(evidence, reportFile)))
      throw new Error("Community media evidence requires its exact release source");
    return candidate;
  }
  const predecessorBytes = readFileSync(join(source, predecessorFile));
  const predecessor = JSON.parse(predecessorBytes);
  const reportBytes = readFileSync(join(evidence, reportFile));
  const report = JSON.parse(reportBytes);
  const currentRuntime = candidate.artifacts?.communityRuntime?.image;
  const predecessorRuntime = predecessor.artifacts?.communityRuntime?.image;
  const expected = {
    version: 1,
    status: "ISOLATED_COMMUNITY_MEDIA_ROLLBACK_AND_RESTORE_PASS",
    currentRuntime,
    predecessorRuntime,
    communitySourceCommit: candidate.sources?.community?.commit,
    runnerSha256: sha256(readFileSync(join(source, "tests/support/community-media-worker.test.mjs"))),
    overlaySha256: hashes.communityMediaOverlaySha256,
    restoreFenceSha256: hashes.communityMediaRestoreFenceSha256,
    platform: "linux/amd64",
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
  if (candidate.environment !== "staging" || predecessor.environment !== candidate.environment ||
      predecessor.integration?.state !== "passed" || predecessor.releaseId === candidate.releaseId ||
      !/^[a-f0-9]{40}$/u.test(expected.communitySourceCommit ?? "") ||
      predecessor.runtime?.communityMediaOverlaySha256 || !digest.test(currentRuntime ?? "") ||
      !digest.test(predecessorRuntime ?? "") || currentRuntime === predecessorRuntime ||
      !Object.entries(hashes).every(([key, value]) => candidate.runtime?.[key] === value) ||
      Object.keys(report).length !== Object.keys(expected).length + 1 ||
      !/^18\.[0-9]+(?: .+)?$/u.test(report.postgresVersion ?? "") ||
      !Object.entries(expected).every(([key, value]) => report[key] === value)) {
    throw new Error("Exact Community media rollback and restore evidence required");
  }
  const platformReportBytes = readFileSync(join(evidence, platformReportFile));
  const platformReport = JSON.parse(platformReportBytes);
  const platformRunner = readFileSync(join(source, "ops/platform/published-recovery-harness.mjs"));
  if (platformReport.runnerSha256 !== sha256(platformRunner).slice(7) ||
      !platformRoundsAgree(platformReport, candidate, predecessor))
    throw new Error("Exact platform rollback evidence required");
  return {
    ...candidate,
    integration: {
      ...candidate.integration,
      communityMediaRecovery: {
        predecessorReleaseId: predecessor.releaseId,
        predecessorManifestSha256: sha256(predecessorBytes),
        reportSha256: sha256(reportBytes),
        platformReportSha256: sha256(platformReportBytes),
        scope: "isolated-platform-rollback-and-community-database-restore",
      },
    },
  };
}
