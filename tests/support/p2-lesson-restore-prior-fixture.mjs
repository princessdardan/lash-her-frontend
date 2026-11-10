import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { p2NativeHash } from "../../ops/platform/p2-lifecycle-native.mjs";

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const serialize = value => JSON.stringify(value, null, 2) + "\n";

export function writeP2LessonRestorePriorFixture(results, firstPlan, configurationSha256) {
  const { actorId, resumeAction: { courseId, lessonId, grantId } } = firstPlan.scopedAction;
  const playbackExpiresAt = "2026-11-07T18:10:00.000Z";
  const saved = { actorId, courseId, lessonId, grantId, enrollmentId: id(41), progressId: id(42), revision: 4,
    resumePositionSeconds: 4, maxPositionSeconds: 14, playbackIdSha256: "a".repeat(64), playbackExpiresAt };
  const witness = { ...saved, readOnly: true };
  const browser = {
    page: { pathname: `/academy/courses/${courseId}/lessons/${lessonId}`, status: 200 },
    playback: { requestId: id(43), expiresAt: playbackExpiresAt, thumbnailExpiresAt: playbackExpiresAt,
      lifetimeMs: 600_000, playbackIdSha256: witness.playbackIdSha256 },
    started: { requestId: id(44), progressId: witness.progressId, enrollmentId: witness.enrollmentId, revision: 1 },
    writes: [[10, 10, 10], [14, 13, 14], [4, 14, 14]].map(([resumePositionSeconds, submittedMaxPositionSeconds, maxPositionSeconds], index) => ({
      requestId: id(45 + index), expectedProgressRevision: index + 1, revision: index + 2,
      resumePositionSeconds, submittedMaxPositionSeconds, maxPositionSeconds,
    })),
    media: { durationSeconds: 32, videoWidth: 640, heartbeatSeconds: 10, pausedSeconds: 14, rewoundSeconds: 4,
      manifestObserved: true, segmentObserved: true },
  };
  const frontendAdmission = { epoch: String(BigInt(firstPlan.initialEpoch) + 2n), newWork: false, recovery: false, active: 0, uncertain: 0 };
  const gateway = {
    version: 2, qualificationTargetProfile: firstPlan.qualificationTargetProfile,
    status: "P2_INTERACTIVE_LESSON_RESUME_GATEWAY_OBSERVED", certificationActionId: firstPlan.certificationActionId,
    planSha256: firstPlan.planSha256, stage: "lesson-resume", epoch: String(BigInt(firstPlan.initialEpoch) + 1n),
    gatewayStateSha256: "c".repeat(64), gatewayActive: 0, gatewayUncertain: 0,
    gatewayAcknowledgements: [...Array.from({ length: 5 }, (_, index) => id(51 + index)), browser.playback.requestId,
      browser.started.requestId, ...browser.writes.map(row => row.requestId)].map((requestId, requestIndex) => ({
      requestId, requestIndex, proofRequestId: id(60 + requestIndex), upstreamStatus: 200,
    })),
  };
  const gatewayEvidenceSha256 = p2NativeHash(gateway);
  const joined = {
    version: 2, qualificationTargetProfile: firstPlan.qualificationTargetProfile, status: "P2_INTERACTIVE_LESSON_RESUME_JOINED",
    certificationActionId: firstPlan.certificationActionId, planSha256: firstPlan.planSha256, stage: "lesson-resume",
    ...saved, operation: "play-and-rewind", browserProgramSha256: "b".repeat(64), browserResponseSha256: p2NativeHash(browser),
    courseWitnessSha256: p2NativeHash(witness), gatewayEvidenceSha256,
    playbackGatewayRequestId: browser.playback.requestId, startedGatewayRequestId: browser.started.requestId,
    positionGatewayRequestIds: browser.writes.map(row => row.requestId), frontendAdmission, frontendOperationCount: 4,
    gatewayAdmissionClosed: true, gatewayActive: 0, gatewayUncertain: 0,
  };
  const terminalFields = ["version", "qualificationTargetProfile", "environment", "certificationActionId", "originalReleaseId", "sourceCommit",
    "operatorSourceCommit", "candidateSha256", "candidateObjectSha256", "inventorySha256", "targetSha256",
    "contractPhase", "phase2ContractManifestSha256", "mode", "planSha256"];
  const outcome = {
    ...Object.fromEntries(terminalFields.map(key => [key, firstPlan[key]])),
    status: "P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED", caseStatus: joined.status, caseOutcomeSha256: p2NativeHash(joined),
    configurationSha256, releaseId: firstPlan.originalReleaseId, frontendAdmission,
    gatewayAdmission: { version: 1, valid: true, newWork: false, recovery: false,
      active: { newWork: 0, recovery: 0 }, uncertain: { newWork: 0, recovery: 0 } },
    nativeDisabled: true, sqlReplayed: false, frontendSqlApplied: false, runtimeReplaced: false, trafficAuthorized: false, releaseAccepted: false,
  };
  const directory = join(results, firstPlan.certificationActionId);
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, value] of Object.entries({
    "p2-certification-started.json": firstPlan,
    "p2-certification-outcome.json": outcome,
    "p2-host-certification-outcome.json": outcome,
    "p2-interactive-lesson-resume-joined.json": joined,
    "p2-interactive-lesson-resume-gateway.json": { ...gateway, gatewayEvidenceSha256 },
    "p2-interactive-lesson-resume-browser.json": browser,
    "p2-interactive-lesson-resume-witness.json": witness,
  })) writeFileSync(join(directory, name), serialize(value), { mode: 0o600 });
  return {
    actionId: firstPlan.certificationActionId, outcomeSha256: hashBytes(serialize(outcome)), progressId: saved.progressId,
    enrollmentId: saved.enrollmentId, resumePositionSeconds: saved.resumePositionSeconds, maxPositionSeconds: saved.maxPositionSeconds,
    playbackIdSha256: saved.playbackIdSha256, playbackExpiresAt: saved.playbackExpiresAt,
  };
}
