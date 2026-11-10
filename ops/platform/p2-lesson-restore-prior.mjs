import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { validateP2LessonResumeReceipt } from "./p2-lifecycle-browser-recorder.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

const priorFields = ["actionId", "outcomeSha256", "progressId", "enrollmentId", "resumePositionSeconds",
  "maxPositionSeconds", "playbackIdSha256", "playbackExpiresAt"];
const releaseFields = ["environment", "originalReleaseId", "sourceCommit", "operatorSourceCommit", "candidateSha256",
  "candidateObjectSha256", "inventorySha256", "targetSha256", "contractPhase", "phase2ContractManifestSha256"];
const planFields = [...releaseFields, "originalReleaseReceiptSha256", "originalReleasePlanSha256", "configurationCanonicalSha256",
  "runtimeInventorySha256", "gatewayProcessSha256", "gatewayConfigurationSha256", "operatorSourceClosureSha256",
  "apiJobSha256", "readyReceiptSha256"];
const deploymentFields = ["projectId", "deploymentId", "deploymentUrl", "configurationRecordSha256"];
const joinedStatus = "P2_INTERACTIVE_LESSON_RESUME_JOINED";
const action = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const epoch = value => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
const utc = value => typeof value === "string" && value.length === 24 && value.slice(0, 4) !== "0000" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const closed = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const same = (left, right, fields) => left && right && fields.every(key => Object.hasOwn(left, key) && Object.hasOwn(right, key) &&
  isDeepStrictEqual(left[key], right[key]));
const refuse = () => new Error("P2_LESSON_RESTORE_PRIOR_REFUSED");
const demand = condition => { if (!condition) throw refuse(); };

export function validateP2LessonRestorePriorSelection(prior) {
  return Boolean(closed(prior, priorFields) && action(prior.actionId) && sha(prior.outcomeSha256) &&
    uuid(prior.progressId) && uuid(prior.enrollmentId) &&
    Number.isInteger(prior.resumePositionSeconds) && prior.resumePositionSeconds >= 3 && prior.resumePositionSeconds <= 6 &&
    prior.maxPositionSeconds === prior.resumePositionSeconds + 10 &&
    sha(prior.playbackIdSha256) && utc(prior.playbackExpiresAt));
}

const frontendClosed = (value, expectedEpoch) => value?.epoch === expectedEpoch &&
  value.newWork === false && value.recovery === false && value.active === 0 && value.uncertain === 0;
const gatewayClosed = value => value?.valid === true && value.version === 1 && value.newWork === false && value.recovery === false &&
  [value.active, value.uncertain].every(counters => counters?.newWork === 0 && counters?.recovery === 0);

export function readP2LessonRestorePrior({ results, plan, identityPlan }) {
  try {
    const selected = plan?.scopedAction?.restoreAction, prior = selected?.prior, actorId = plan?.scopedAction?.actorId;
    const releasePins = plan?.replacementRelease ? [...planFields, "replacementRelease"] : planFields;
    demand(plan?.mode === "interactive-browser" && plan.scopedAction.stage === "lesson-restore" &&
      selected?.operation === "restore-resume" && validateP2LessonRestorePriorSelection(prior) &&
      action(plan.certificationActionId) && action(identityPlan?.certificationActionId) &&
      new Set([plan.originalReleaseId, plan.certificationActionId, identityPlan.certificationActionId, prior.actionId]).size === 4 &&
      epoch(plan.initialEpoch) && epoch(identityPlan.initialEpoch) &&
      BigInt(plan.initialEpoch) === BigInt(identityPlan.initialEpoch) + 2n &&
      identityPlan.mode === "interactive-browser" && identityPlan.scopedAction?.stage === "identity" &&
      isDeepStrictEqual(identityPlan.scopedAction.identityActor, { actorKind: "customer", actorId }) &&
      same(plan, identityPlan, releasePins) && isDeepStrictEqual(plan.replacementRelease, identityPlan.replacementRelease) &&
      same(plan.nativePlan, identityPlan.nativePlan, deploymentFields));
    frontendPrivateReceiptDirectory(results);
    const directory = join(results, prior.actionId);
    const outcomeBytes = readFrontendReleaseEvidence(directory, "p2-certification-outcome.json");
    demand(createHash("sha256").update(outcomeBytes).digest("hex") === prior.outcomeSha256);
    const outcome = decodeQualificationTargetJson(outcomeBytes, "carrier");
    const read = name => decodeQualificationTargetJson(readFrontendReleaseEvidence(directory, name), "carrier");
    demand(isDeepStrictEqual(outcome, read("p2-host-certification-outcome.json")));
    const firstPlan = read("p2-certification-started.json");
    const joined = read("p2-interactive-lesson-resume-joined.json");
    const browser = read("p2-interactive-lesson-resume-browser.json");
    const witness = read("p2-interactive-lesson-resume-witness.json");
    const { gatewayEvidenceSha256, ...gateway } = read("p2-interactive-lesson-resume-gateway.json");
    requireQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, plan, identityPlan, firstPlan, outcome, joined, gateway);
    const { planSha256, ...firstBody } = firstPlan;
    const closedEpoch = identityPlan.initialEpoch;
    demand(firstPlan.version === 2 && firstPlan.mode === "interactive-browser" && firstPlan.certificationActionId === prior.actionId &&
      firstPlan.startState === "already-closed" && epoch(firstPlan.initialEpoch) &&
      BigInt(firstPlan.initialEpoch) + 2n === BigInt(closedEpoch) &&
      sha(planSha256) && p2NativeHash(firstBody) === planSha256 &&
      same(firstPlan, plan, releasePins) && isDeepStrictEqual(firstPlan.replacementRelease, plan.replacementRelease) &&
      same(firstPlan.nativePlan, plan.nativePlan, deploymentFields) &&
      firstPlan.scopedAction?.stage === "lesson-resume" && firstPlan.scopedAction.actorId === actorId &&
      isDeepStrictEqual(firstPlan.scopedAction.resumeAction, {
        operation: "play-and-rewind", courseId: selected.courseId, lessonId: selected.lessonId, grantId: selected.grantId,
      }));
    demand(outcome.version === 2 && outcome.status === "P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED" &&
      outcome.mode === firstPlan.mode && outcome.certificationActionId === prior.actionId && outcome.releaseId === plan.originalReleaseId &&
      outcome.planSha256 === planSha256 && same(outcome, plan, releaseFields) &&
      isDeepStrictEqual(outcome.replacementRelease, plan.replacementRelease) &&
      p2NativeHash(outcome.configurationSha256) === plan.configurationCanonicalSha256 &&
      outcome.caseStatus === joinedStatus && outcome.caseOutcomeSha256 === p2NativeHash(joined) &&
      outcome.nativeDisabled === true && outcome.sqlReplayed === false && outcome.frontendSqlApplied === false &&
      outcome.runtimeReplaced === false && outcome.trafficAuthorized === false && outcome.releaseAccepted === false &&
      frontendClosed(outcome.frontendAdmission, closedEpoch) && gatewayClosed(outcome.gatewayAdmission));
    const saved = { actorId, courseId: selected.courseId, lessonId: selected.lessonId, grantId: selected.grantId,
      enrollmentId: prior.enrollmentId, progressId: prior.progressId, revision: 4,
      resumePositionSeconds: prior.resumePositionSeconds, maxPositionSeconds: prior.maxPositionSeconds,
      playbackIdSha256: prior.playbackIdSha256, playbackExpiresAt: prior.playbackExpiresAt };
    demand(joined.version === 2 && joined.status === joinedStatus && joined.stage === "lesson-resume" &&
      joined.operation === "play-and-rewind" && joined.certificationActionId === prior.actionId && joined.planSha256 === planSha256 &&
      joined.frontendOperationCount === 4 && frontendClosed(joined.frontendAdmission, closedEpoch) &&
      joined.gatewayAdmissionClosed === true && joined.gatewayActive === 0 && joined.gatewayUncertain === 0 &&
      same(joined, saved, Object.keys(saved)) &&
      joined.courseWitnessSha256 === p2NativeHash(witness) && isDeepStrictEqual(witness, { ...saved, readOnly: true }) &&
      joined.browserResponseSha256 === p2NativeHash(browser));
    demand(gateway.status === "P2_INTERACTIVE_LESSON_RESUME_GATEWAY_OBSERVED" &&
      gateway.certificationActionId === prior.actionId && gateway.planSha256 === planSha256 && gateway.stage === "lesson-resume" &&
      gateway.epoch === String(BigInt(firstPlan.initialEpoch) + 1n) && gateway.gatewayActive === 0 && gateway.gatewayUncertain === 0 &&
      gatewayEvidenceSha256 === p2NativeHash(gateway) && joined.gatewayEvidenceSha256 === gatewayEvidenceSha256);
    validateP2LessonResumeReceipt(browser, saved);
    const rewound = browser.writes.at(-1);
    const requestAt = index => gateway.gatewayAcknowledgements.find(row => row.requestIndex === index)?.requestId;
    demand(browser.started.progressId === saved.progressId && browser.started.enrollmentId === saved.enrollmentId &&
      browser.playback.playbackIdSha256 === saved.playbackIdSha256 &&
      [browser.playback.expiresAt, browser.playback.thumbnailExpiresAt].sort().at(-1) === saved.playbackExpiresAt &&
      rewound.resumePositionSeconds === saved.resumePositionSeconds && rewound.maxPositionSeconds === saved.maxPositionSeconds &&
      joined.playbackGatewayRequestId === browser.playback.requestId && joined.startedGatewayRequestId === browser.started.requestId &&
      browser.playback.requestId === requestAt(5) && browser.started.requestId === requestAt(6) &&
      isDeepStrictEqual(joined.positionGatewayRequestIds, browser.writes.map(row => row.requestId)) &&
      isDeepStrictEqual(joined.positionGatewayRequestIds, [7, 8, 9].map(requestAt)));
    return Object.freeze(saved);
  } catch {
    throw refuse();
  }
}
