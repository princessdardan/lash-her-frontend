// Fixed browser child. The reviewed lost-ack case can drop delivery after one
// exact progress request succeeds. The media reservation holds the outbound upload.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";

const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_BROWSER_REFUSED"); };
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const privateNoStore = headers => /(?:^|,)\s*private\s*(?:,|$)/iu.test(headers["cache-control"] ?? "")
  && /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(headers["cache-control"] ?? "");
const interactiveOrigin = "https://staging.lashher.com";
const permitName = "__Host-lash-p2q-window";
const customerSessionName = "__Host-lash-customer.session-token";
const authoringPath = "/api/admin/courses";
const firstOwnerPath = "/admin/certification/first-owner";
const heldLessonStages = ["lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save",
  "lesson-visibility-save", "lesson-stale-revision"];
const learnerScopedStages = ["learning", "learner-access", ...heldLessonStages];
const interactivePages = {
  identity: { owner: "/admin/sign-in", learner: "/sign-in" },
  authoring: { owner: "/admin/courses" },
  media: { owner: "/admin/courses" },
  learning: { learner: "/academy" },
  "learner-access": { learner: "/academy/courses" },
  "lesson-entry": { learner: "/academy/courses" },
  "lesson-denial": { learner: "/academy/courses" },
  "lesson-assessment": { learner: "/academy/courses" },
  "lesson-resume": { learner: "/academy/courses" },
  "lesson-restore": { learner: "/academy/courses" },
  "lesson-ack-loss": { learner: "/academy/courses" },
  "lesson-exit-save": { learner: "/academy/courses" },
  "lesson-visibility-save": { learner: "/academy/courses" },
  "lesson-stale-revision": { learner: "/academy/courses" },
  "paid-grant": { owner: "/admin/courses" },
  "paid-revoke": { owner: "/admin/courses" },
  lifecycle: { owner: "/admin/customer-accounts", learner: "/account" },
};

export function p2InteractiveBrowserPath(stage, context) {
  const pages = typeof stage === "string" && Object.hasOwn(interactivePages, stage) && interactivePages[stage];
  demand(pages && typeof context === "string" && Object.hasOwn(pages, context));
  return pages[context];
}

export function p2LifecycleMutationTarget({ actorKind, userId, operation }) {
  if (actorKind === "admin") {
    demand(uuid(userId) && ["suspend", "restore", "export", "delete"].includes(operation));
    return { context: "owner", pathname: `/api/admin/customer-accounts/${userId}/commands`, operation };
  }
  demand(actorKind === "customer" && ["export", "delete", "preferences-on", "preferences-off"].includes(operation));
  return { context: "learner", pathname: operation.startsWith("preferences-") ? "/api/account/preferences" : "/api/account/commands", operation };
}

function validateLifecycleTarget(target) {
  demand(closed(target, ["context", "pathname", "operation"]) && typeof target.pathname === "string");
  const admin = target.context === "owner";
  const userId = admin ? /^\/api\/admin\/customer-accounts\/([^/]+)\/commands$/u.exec(target.pathname)?.[1] : undefined;
  const selected = p2LifecycleMutationTarget({ actorKind: admin ? "admin" : "customer", userId, operation: target.operation });
  demand(Object.entries(selected).every(([key, value]) => target[key] === value));
}

export function p2InteractiveIdentityContext(input) {
  return input.firstOwner || input.identity?.actorKind === "admin" ? "owner" : "learner";
}

function firstOwnerSelector(value) {
  demand(closed(value, ["nonce", "identitySha256"]) && matches(value.nonce, /^(?!0+$)[a-f0-9]{32}$/u) &&
    matches(value.identitySha256, /^(?!0+$)[a-f0-9]{64}$/u));
  return "a3" + value.identitySha256.slice(0, 62);
}

function identitySelector(identity) {
  const paired = identity && Object.hasOwn(identity, "sessionCount");
  demand(closed(identity, ["actorKind", "actorId", ...(paired ? ["sessionCount"] : [])]) && uuid(identity.actorId)
    && (!paired || identity.actorKind === "customer" && identity.sessionCount === 2));
  if (identity.actorKind === "customer") return "7032712d637573746f6d65722d763100" + identity.actorId.replaceAll("-", "");
  demand(identity.actorKind === "admin");
  return createHash("sha256").update(JSON.stringify(["identity", "admin"])).digest("hex");
}

function enrollmentSelector(enrollment) {
  demand(closed(enrollment, ["provider", "emailSha256", "nonce"]) && ["google", "resend"].includes(enrollment.provider)
    && sha(enrollment.emailSha256) && matches(enrollment.nonce, /^[a-f0-9]{32}$/u));
  return (enrollment.provider === "google" ? "a1" : "a2") + enrollment.emailSha256.slice(0, 62);
}

const authoringEdit = input => input.stage === "authoring" && input.authoring?.operation === "edit-and-stale-draft";
const authoringReorder = input => input.stage === "authoring" && input.authoring?.operation === "reorder-and-stale-curriculum";
const authoringCreateCurriculum = input => input.stage === "authoring" && input.authoring?.operation === "create-curriculum";
const authoringPublication = input => input.stage === "authoring" && input.authoring?.operation === "qualify-publication";
const authoringQuiz = input => input.stage === "authoring" && input.authoring?.operation === "save-quiz-revision";
const authoringArchive = input => input.stage === "authoring" && input.authoring?.operation === "archive-paid-course";
const authoringRepublish = input => input.stage === "authoring" && input.authoring?.operation === "republish-paid-course";
export const isP2InteractiveAuthoringPair = input => authoringEdit(input) || authoringReorder(input);
export const isP2InteractiveAuthoringDetail = input => isP2InteractiveAuthoringPair(input) || authoringCreateCurriculum(input)
  || authoringPublication(input) || authoringQuiz(input) || authoringArchive(input) || authoringRepublish(input);
const publicationIssueCode = code => matches(code, /^[A-Z][A-Z0-9_]{0,63}$/u);
const publishedOutcome = target => target.outcome === "published";

export function p2AuthoringPublicationPaths({ courseId }) {
  const detail = authoringPath + "/" + courseId;
  return { detail, readiness: detail + "/publication-readiness" };
}

export function p2AuthoringCurriculumPath({ kind, parentId }) {
  return kind === "module" ? authoringPath + "/" + parentId + "/modules" : "/api/admin/modules/" + parentId + "/lessons";
}

export function p2AuthoringReorderPath(target) {
  return p2AuthoringCurriculumPath(target) + "/reorder";
}

export function p2AuthoringQuizPath({ lessonId }) {
  return "/api/admin/lessons/" + lessonId + "/quiz";
}

function authoringSelector(input) {
  demand(uuid(input.authoring.actorId));
  const actor = input.authoring.actorId.replaceAll("-", "");
  if (authoringArchive(input)) return "7032712d617574682d6172632d763100" + actor;
  if (authoringRepublish(input)) {
    return (publishedOutcome(input.authoring) ? "7032712d617574682d7265702d763100" : "7032712d617574682d72626c2d763100") + actor;
  }
  if (authoringQuiz(input)) return "7032712d617574682d7175697a2d7631" + actor;
  if (authoringPublication(input)) {
    return (publishedOutcome(input.authoring) ? "7032712d617574682d7075622d763100" : "7032712d617574682d7264792d763100") + actor;
  }
  const prefix = authoringReorder(input) ? "7032712d617574682d736f72742d7631"
    : authoringCreateCurriculum(input) ? "7032712d617574682d6e65772d763100"
      : authoringEdit(input) ? "7032712d617574682d656469742d7631" : "7032712d617574686f72696e672d7631";
  return prefix + actor;
}

export function p2InteractiveBrowserEntryPath(input, context) {
  const path = p2InteractiveBrowserPath(input.stage, context);
  if (input.stage === "media") return path + "/" + input.media.courseId;
  if (input.stage === "learning") {
    const { coursePath, academyPath } = p2LearningEnrollmentPaths(input.learning);
    return learningEnrollmentReplay(input.learning) ? academyPath : coursePath;
  }
  if (input.stage === "learner-access") return p2PaidLearnerAccessPaths(input.learnerAccess).pagePath;
  if (input.stage === "lesson-entry") return p2LessonEntryPaths(input.lessonEntry).academyPath;
  if (input.stage === "lesson-denial") return p2LessonDenialPaths(input.lessonDenial).lessonPath;
  if (input.stage === "lesson-assessment") return p2LessonAssessmentPaths(input.assessment).lessonPath;
  if (input.stage === "lesson-resume") return p2LessonResumePaths(input.resume).lessonPath;
  if (input.stage === "lesson-restore") return p2LessonResumePaths(input.restore).lessonPath;
  if (input.stage === "lesson-ack-loss") return p2LessonResumePaths(input.ackLoss).lessonPath;
  if (input.stage === "lesson-exit-save") return p2LessonResumePaths(input.exitSave).lessonPath;
  if (input.stage === "lesson-visibility-save") return p2LessonResumePaths(input.visibility).lessonPath;
  if (input.stage === "lesson-stale-revision") return p2LessonResumePaths(input.staleRevision).lessonPath;
  if (input.stage === "paid-grant") return p2PaidGrantPaths(input.paidGrant).pagePath;
  if (input.stage === "paid-revoke") return p2PaidRevokePaths(input.paidRevoke).pagePath;
  return isP2InteractiveAuthoringDetail(input) ? path + "/" + input.authoring.courseId : path;
}

export const p2MediaUploadCallbackOperation = "upload-video-and-observe-callback";

export function validP2MediaReservationAction(value) {
  return closed(value, ["operation", "courseId", "lessonId", "revision", "currentVideoAssetId", "fileSha256", "fileBytes", "contentType"])
    && ["reserve-video-upload", p2MediaUploadCallbackOperation].includes(value.operation) && uuid(value.courseId) && uuid(value.lessonId)
    && Number.isSafeInteger(value.revision) && value.revision >= 1 && value.revision < 2_147_483_647
    && (value.currentVideoAssetId === null || uuid(value.currentVideoAssetId)) && sha(value.fileSha256)
    && value.fileSha256 !== "0".repeat(64) && Number.isSafeInteger(value.fileBytes) && value.fileBytes > 0
    && value.fileBytes <= 8 * 1024 * 1024 && value.contentType === "video/mp4";
}

export function validateP2MediaDispatchIntent(value, browserExpires, now = Date.now() / 1000) {
  demand(closed(value, ["intentSha256", "expiresAt"]) && sha(value.intentSha256) && value.intentSha256 !== "0".repeat(64)
    && Number.isSafeInteger(browserExpires) && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > now && value.expiresAt <= browserExpires);
  return value;
}

export function validateP2MediaDispatchReceipt(value) {
  demand(closed(value, ["attempted", "status"]) && value.attempted === true
    && Number.isInteger(value.status) && value.status >= 200 && value.status <= 299);
  return value;
}

export function p2MediaReservationBody({ revision, currentVideoAssetId }) {
  return { expectedCourseRevision: revision, expectedCurrentVideoAssetId: currentVideoAssetId };
}

export function readP2MediaReservationFile(path, target) {
  try {
    demand(Number.isSafeInteger(target?.fileBytes) && target.fileBytes > 0 && target.fileBytes <= 8 * 1024 * 1024);
    demand(typeof path === "string" && path.length <= 4096 && resolve(path) === path && realpathSync(path) === path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      demand(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n
        && (before.mode & 0o077n) === 0n && before.size === BigInt(target.fileBytes));
      const bytes = Buffer.alloc(target.fileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      const after = fstatSync(fd, { bigint: true });
      demand(["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key])
        && length === target.fileBytes);
      const file = bytes.subarray(0, length);
      demand(createHash("sha256").update(file).digest("hex") === target.fileSha256);
      return file;
    } finally { closeSync(fd); }
  } catch { throw new Error("P2_MEDIA_FIXTURE_REFUSED"); }
}

export function validateP2MediaReservationReceipt(receipt, target) {
  demand(closed(receipt, ["page", "read", "reservation", "outbound"]));
  const { page, read, reservation, outbound } = receipt;
  demand(closed(page, ["pathname", "status"]) && page.pathname === "/admin/courses/" + target.courseId && page.status === 200
    && closed(read, ["requestId", "courseRevision", "currentVideoAssetId"]) && uuid(read.requestId)
    && read.courseRevision === target.revision && read.currentVideoAssetId === target.currentVideoAssetId
    && closed(reservation, ["requestId", "status", "assetId", "lessonId", "uploadId", "uploadTimeoutSeconds", "assetStatus"])
    && uuid(reservation.requestId) && reservation.requestId !== read.requestId && reservation.status === 200
    && uuid(reservation.assetId) && reservation.assetId !== target.currentVideoAssetId && reservation.lessonId === target.lessonId
    && matches(reservation.uploadId, /^[A-Za-z0-9_-]{1,255}$/u) && reservation.uploadTimeoutSeconds === 3600
    && reservation.assetStatus === "uploading"
    && closed(outbound, ["intercepted", "sent", "fileSha256", "fileBytes", "contentType"])
    && outbound.intercepted === true && outbound.sent === false && outbound.fileSha256 === target.fileSha256
    && outbound.fileBytes === target.fileBytes && outbound.contentType === target.contentType);
  return receipt;
}

export function p2LearningEnrollmentPaths({ courseId, slug }) {
  const academyPath = "/academy/courses/" + courseId;
  return { coursePath: "/courses/" + slug, academyPath, pathname: "/api" + academyPath + "/enrollments" };
}

const learningEnrollmentReplay = target => target?.operation === "replay-free-enrollment";

export function p2PaidLearnerAccessPaths({ courseId, lessonId }) {
  const pagePath = "/academy/courses/" + courseId;
  const lesson = "/api/academy/lessons/" + lessonId;
  return { pagePath, lessonPath: pagePath + "/lessons/" + lessonId,
    targets: ["/api" + pagePath, lesson, lesson + "/playback", "/api/academy/progress?lessonId=" + lessonId, lesson + "/quiz", lesson + "/quiz/attempts"] };
}

export function p2LessonEntryPaths({ courseId, lessonId }) {
  const academyPath = `/academy/courses/${courseId}`, api = `/api/academy/lessons/${lessonId}`;
  return { academyPath, lessonPath: `${academyPath}/lessons/${lessonId}`, playbackPath: `${api}/playback`, progressPath: `${api}/progress` };
}

export function p2LessonDenialPaths({ courseId, lessonId }) {
  const { lessonPath, targets } = p2PaidLearnerAccessPaths({ courseId, lessonId });
  // Next's cache-buster is the bare parameter when only RSC is present.
  return { lessonPath, flightPath: lessonPath + "?_rsc", targets: targets.slice(1) };
}

export function p2LessonAssessmentPaths(target) {
  const { lessonPath, playbackPath, progressPath } = p2LessonEntryPaths(target);
  return { lessonPath, playbackPath, progressPath, latestPath: "/api/academy/progress?lessonId=" + target.lessonId,
    attemptsPath: "/api/academy/lessons/" + target.lessonId + "/quiz/attempts" };
}

export function p2LessonResumePaths(target) {
  const { lessonPath, playbackPath, progressPath } = p2LessonEntryPaths(target);
  return { lessonPath, playbackPath, progressPath };
}

const assessmentKey = value => matches(value, /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/u);
const assessmentRequestId = value => matches(value, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const assessmentRevision = value => Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
const assessmentAnswers = answers => Array.isArray(answers) && answers.length >= 1 && answers.length <= 100
  && answers.every(answer => closed(answer, ["questionId", "optionId"]) && assessmentKey(answer.questionId) && assessmentKey(answer.optionId))
  && new Set(answers.map(answer => answer.questionId)).size === answers.length;
const sameAssessmentAnswers = (left, right) => assessmentAnswers(left) && left.length === right.length
  && left.every((answer, index) => answer.questionId === right[index].questionId && answer.optionId === right[index].optionId);

export function p2PaidGrantPaths({ courseId }) {
  const pagePath = "/admin/courses/" + courseId + "/manual-grants";
  return { pagePath, pathname: "/api" + pagePath };
}

export function p2PaidRevokePaths(target) {
  const { pagePath, pathname } = p2PaidGrantPaths(target);
  return { pagePath: pagePath + "/revoke", pathname: pathname + "/revoke" };
}

function actorAttemptSelector({ actorId, idempotencyKey }) {
  demand(uuid(actorId) && uuid(idempotencyKey));
  return actorId.replaceAll("-", "") + idempotencyKey.replaceAll("-", "");
}

export function validateP2InteractiveBrowserInput(input) {
  const enrollment = input?.stage === "identity" && Object.hasOwn(input, "identityEnrollment");
  const firstOwner = input?.stage === "identity" && Object.hasOwn(input, "firstOwner");
  demand(closed(input, ["version", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit", "deploymentId",
    "deploymentUrl", "browserOrigin", "stage", "epoch", "windowSeconds",
    ...(["lifecycle", "authoring", "learning", "media"].includes(input?.stage) ? [input.stage]
      : input?.stage === "identity" ? [firstOwner ? "firstOwner" : enrollment ? "identityEnrollment" : "identity"] : input?.stage === "paid-grant" ? ["paidGrant"]
        : input?.stage === "learner-access" ? ["learnerAccess"] : input?.stage === "lesson-entry" ? ["lessonEntry"]
          : input?.stage === "lesson-denial" ? ["lessonDenial"] : input?.stage === "lesson-assessment" ? ["assessment"]
          : input?.stage === "lesson-resume" ? ["resume"] : input?.stage === "lesson-restore" ? ["restore"] : input?.stage === "lesson-ack-loss" ? ["ackLoss"]
          : input?.stage === "lesson-exit-save" ? ["exitSave"]
          : input?.stage === "lesson-visibility-save" ? ["visibility"]
          : input?.stage === "lesson-stale-revision" ? ["staleRevision"]
          : input?.stage === "paid-revoke" ? ["paidRevoke"] : [])])
    && input.version === 2 && input.environment === "staging" && matches(input.actionId, /^[a-z0-9][a-z0-9-]{0,63}$/u)
    && sha(input.challenge) && sha(input.bindingSha256) && matches(input.sourceCommit, /^[a-f0-9]{40}$/u)
    && matches(input.deploymentId, /^dpl_[A-Za-z0-9]+$/u) && matches(input.deploymentUrl, /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u)
    && input.browserOrigin === interactiveOrigin && typeof input.stage === "string" && Object.hasOwn(interactivePages, input.stage)
    && matches(input.epoch, /^[1-9][0-9]{0,17}$/u)
    && Number.isSafeInteger(input.windowSeconds) && input.windowSeconds >= 30 && input.windowSeconds <= 300);
  if (input.stage === "lifecycle") validateLifecycleTarget(input.lifecycle);
  if (input.stage === "media") {
    const { actorId, filePath, ...selection } = input.media ?? {};
    demand(uuid(actorId) && validP2MediaReservationAction(selection)
      && typeof filePath === "string" && filePath.length <= 4096 && resolve(filePath) === filePath);
  }
  if (input.stage === "learning") {
    const selected = input.learning, replay = learningEnrollmentReplay(selected);
    demand(closed(selected, ["actorId", "operation", "courseId", "slug", "idempotencyKey", ...(replay ? ["prior"] : [])])
      && (replay || selected.operation === "enroll-free-course") && uuid(selected.actorId) && uuid(selected.courseId) && uuid(selected.idempotencyKey)
      && matches(selected.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u) && selected.slug.length <= 120);
    if (replay) demand(closed(selected.prior, ["grantId", "enrollmentId", "eventId", "streamId", "canonicalDigest"])
      && [selected.prior.grantId, selected.prior.enrollmentId, selected.prior.eventId, selected.prior.streamId].every(uuid)
      && sha(selected.prior.canonicalDigest) && selected.prior.canonicalDigest !== "0".repeat(64));
  }
  if (input.stage === "learner-access") {
    const selected = input.learnerAccess;
    demand(closed(selected, ["actorId", "operation", "courseId", "lessonId", "grantId", "revision", "outcome"])
      && selected.operation === "observe-paid-access" && [selected.actorId, selected.courseId, selected.lessonId, selected.grantId].every(uuid)
      && Number.isSafeInteger(selected.revision) && selected.revision >= 1 && selected.revision <= 2_147_483_647
      && ["allowed", "archived", "draft", "restricted"].includes(selected.outcome));
  }
  if (input.stage === "lesson-entry") {
    const selected = input.lessonEntry;
    demand(closed(selected, ["actorId", "operation", "courseId", "lessonId", "grantId"]) && selected.operation === "open-lesson"
      && [selected.actorId, selected.courseId, selected.lessonId, selected.grantId].every(uuid));
  }
  if (input.stage === "lesson-denial") {
    const selected = input.lessonDenial;
    demand(closed(selected, ["actorId", "operation", "courseId", "lessonId", "enrolledActorId", "grantId"])
      && selected.operation === "deny-cross-account" && selected.actorId !== selected.enrolledActorId
      && [selected.actorId, selected.courseId, selected.lessonId, selected.enrolledActorId, selected.grantId].every(uuid));
  }
  if (input.stage === "lesson-assessment") {
    const selected = input.assessment;
    demand(closed(selected, ["actorId", "operation", "courseId", "lessonId", "grantId", "quizRevision", "failAnswers", "passAnswers"])
      && selected.operation === "fail-then-pass" && [selected.actorId, selected.courseId, selected.lessonId, selected.grantId].every(uuid)
      && assessmentRevision(selected.quizRevision) && assessmentAnswers(selected.failAnswers) && assessmentAnswers(selected.passAnswers)
      && selected.failAnswers.length === selected.passAnswers.length
      && selected.failAnswers.every((answer, index) => answer.questionId === selected.passAnswers[index].questionId)
      && !sameAssessmentAnswers(selected.failAnswers, selected.passAnswers));
  }
  if (input.stage === "lesson-resume") {
    const selected = input.resume;
    demand(closed(selected, ["actorId", "operation", "courseId", "lessonId", "grantId"]) && selected.operation === "play-and-rewind"
      && [selected.actorId, selected.courseId, selected.lessonId, selected.grantId].every(uuid));
  }
  if (input.stage === "lesson-restore") {
    validateLessonRestoreTarget(input.restore);
    demand(input.restore.prior.actionId !== input.actionId);
  }
  if (input.stage === "lesson-ack-loss") validateLessonAckLossTarget(input.ackLoss);
  if (input.stage === "lesson-exit-save") validateLessonExitSaveTarget(input.exitSave);
  if (input.stage === "lesson-visibility-save") validateLessonVisibilityTarget(input.visibility);
  if (input.stage === "lesson-stale-revision") validateLessonStaleRevisionTarget(input.staleRevision);
  if (["paid-grant", "paid-revoke"].includes(input.stage)) {
    const revoke = input.stage === "paid-revoke", selected = input.paidGrant ?? input.paidRevoke;
    demand(closed(selected, ["actorId", "operation", "courseId", "userId", "revision", "idempotencyKey", "reasonSha256",
      ...(revoke ? ["grantId", "remainingAccess"] : [])])
      && selected.operation === (revoke ? "revoke-paid-grant" : "grant-paid-access") && uuid(selected.actorId) && uuid(selected.courseId) && uuid(selected.userId)
      && uuid(selected.idempotencyKey) && Number.isSafeInteger(selected.revision) && selected.revision >= 1 && selected.revision <= 2_147_483_647
      && sha(selected.reasonSha256) && (!revoke || uuid(selected.grantId) && typeof selected.remainingAccess === "boolean"));
  }
  if (input.stage === "authoring") {
    const target = input.authoring, pair = isP2InteractiveAuthoringPair(input), create = authoringCreateCurriculum(input);
    const curriculum = authoringReorder(input) || create, quiz = authoringQuiz(input);
    const archive = authoringArchive(input), republish = authoringRepublish(input), publication = authoringPublication(input) || republish;
    demand(closed(target, ["actorId", "slug", ...(isP2InteractiveAuthoringDetail(input) ? ["operation", "courseId", "revision"] : []),
      ...(pair ? ["winnerBodySha256", "staleBodySha256"] : publication ? ["outcome", "issueCodes"] : ["bodySha256"]),
      ...(curriculum ? ["kind", "parentId"] : []), ...(quiz ? ["lessonId", "quizRevision", "documentSha256"] : []),
      ...(create ? ["childSlug"] : []), ...(archive || republish ? ["userId", "grantId"] : []), ...(republish ? ["expectedAccess"] : [])])
      && uuid(target.actorId) && matches(target.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u) && target.slug.length <= 120);
    if (isP2InteractiveAuthoringDetail(input)) demand(uuid(target.courseId) && Number.isSafeInteger(target.revision)
      && target.revision >= 1 && target.revision < (publication || quiz || archive ? 2_147_483_647 : Number.MAX_SAFE_INTEGER));
    if (pair) demand(sha(target.winnerBodySha256) && sha(target.staleBodySha256) && target.winnerBodySha256 !== target.staleBodySha256);
    else if (publication) demand(["published", "blocked"].includes(target.outcome) && Array.isArray(target.issueCodes)
      && target.issueCodes.length <= 16 && (publishedOutcome(target) ? target.issueCodes.length === 0 : target.issueCodes.length > 0)
      && target.issueCodes.every((code, index, codes) => publicationIssueCode(code) && (index === 0 || codes[index - 1] < code)));
    else demand(sha(target.bodySha256));
    if (curriculum) demand(["module", "lesson"].includes(target.kind) && uuid(target.parentId)
      && (target.kind !== "module" || target.parentId === target.courseId));
    if (create) demand(matches(target.childSlug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u) && target.childSlug.length <= 120);
    if (quiz) demand(uuid(target.lessonId) && Number.isSafeInteger(target.quizRevision)
      && target.quizRevision >= 0 && target.quizRevision < 2_147_483_647 && sha(target.documentSha256));
    if (archive) demand(uuid(target.userId) && uuid(target.grantId) && target.bodySha256 === createHash("sha256")
      .update(JSON.stringify({ expectedRevision: target.revision, status: "archived" })).digest("hex"));
    if (republish) demand(uuid(target.userId) && uuid(target.grantId) && target.revision <= 2_147_483_645 && typeof target.expectedAccess === "boolean");
  }
  if (firstOwner) firstOwnerSelector(input.firstOwner);
  else if (enrollment) enrollmentSelector(input.identityEnrollment);
  else if (input.stage === "identity") identitySelector(input.identity);
  return input;
}

export function validateP2InteractiveBrowserPermit(permit, input, now = Math.floor(Date.now() / 1000)) {
  demand(closed(permit, ["stage", "epoch", "expires", "cookie"]) && permit.stage === input.stage && permit.epoch === input.epoch
    && Number.isSafeInteger(permit.expires) && permit.expires > now && typeof permit.cookie === "string"
    && permit.cookie.length <= (input.stage === "lesson-visibility-save" ? 261 : input.stage === "lesson-stale-revision" ? 260 : 256));
  const parts = permit.cookie.split(".");
  const [version, epoch, stage, issued, expires, nonce] = parts;
  demand(epoch === permit.epoch && stage === permit.stage && /^\d{10}$/u.test(issued ?? "") && /^\d{10}$/u.test(expires ?? "")
    && Number(issued) <= now && Number(expires) === permit.expires && permit.expires - Number(issued) <= input.windowSeconds
    && /^[a-f0-9]{32}$/u.test(nonce ?? "")
    && (["lifecycle", "identity", "authoring", "media", "paid-grant", "paid-revoke", ...learnerScopedStages].includes(stage)
      ? version === "v2" && parts.length === 8 && (stage === "media" || heldLessonStages.includes(stage) ? matches(parts[6], /^[a-f0-9]{96}$/u) : sha(parts[6])) && sha(parts[7])
      : version === "v1" && parts.length === 7 && sha(parts[6])));
  if (stage === "identity") {
    const enrollment = input.identityEnrollment;
    demand(input.firstOwner ? nonce === input.firstOwner.nonce && parts[6] === firstOwnerSelector(input.firstOwner)
      : enrollment ? nonce === enrollment.nonce && parts[6] === enrollmentSelector(enrollment) : parts[6] === identitySelector(input.identity));
  }
  if (stage === "authoring") demand(parts[6] === authoringSelector(input));
  if (stage === "media") {
    const { actorId, courseId, lessonId } = input.media;
    demand(parts[6] === (actorId + courseId + lessonId).replaceAll("-", ""));
  }
  if (["learning", "paid-grant", "paid-revoke"].includes(stage)) demand(parts[6] === actorAttemptSelector(input.learning ?? input.paidGrant ?? input.paidRevoke));
  if (stage === "learner-access") demand(parts[6] === (input.learnerAccess.actorId + input.learnerAccess.lessonId).replaceAll("-", ""));
  if (heldLessonStages.includes(stage)) {
    const { actorId, courseId, lessonId } = input.lessonEntry ?? input.lessonDenial ?? input.assessment ?? input.resume ?? input.restore
      ?? input.ackLoss ?? input.exitSave ?? input.visibility ?? input.staleRevision;
    demand(parts[6] === (actorId + courseId + lessonId).replaceAll("-", ""));
  }
  return permit;
}

export function readP2InteractiveBrowserPermit(stream, input, selection) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(1024);
    let length = 0;
    const finish = permit => {
      clearTimeout(timer);
      stream.pause();
      stream.off("data", read);
      stream.off("end", refused);
      stream.off("error", refused);
      bytes.fill(0);
      if (permit) resolve(permit);
      else reject(new Error("P2_INTERACTIVE_BROWSER_STDIN_REFUSED"));
    };
    const refused = () => finish();
    const read = chunk => {
      try {
        demand(Buffer.isBuffer(chunk) && length + chunk.length <= bytes.length);
        chunk.copy(bytes, length);
        length += chunk.length;
        const end = bytes.subarray(0, length).indexOf(10);
        if (end === -1) return;
        demand(end === length - 1);
        const line = bytes.subarray(0, end).toString("utf8"), value = JSON.parse(line);
        demand(JSON.stringify(value) === line && closed(value, ["challenge", "bindingSha256", "context", "permit"])
          && value.challenge === input.challenge && value.bindingSha256 === input.bindingSha256 && value.context === selection.context);
        const permit = validateP2InteractiveBrowserPermit(value.permit, input);
        demand(permit.expires === selection.expires);
        finish(permit);
      } catch { refused(); }
    };
    const timer = setTimeout(refused, 15_000);
    stream.once("end", refused);
    stream.once("error", refused);
    stream.on("data", read);
    if (stream.readableEnded || stream.destroyed) refused();
    else stream.resume();
  });
}

function scopedCookie(value, expires) {
  return { name: permitName, value, url: `${interactiveOrigin}/`, secure: true, httpOnly: true, sameSite: "Lax", expires };
}

export async function installP2InteractiveBrowserCookie(context, permit, input) {
  validateP2InteractiveBrowserPermit(permit, input);
  await context.addCookies([scopedCookie(permit.cookie, permit.expires)]);
}

export async function expireP2InteractiveBrowserCookie(context) {
  await context.addCookies([scopedCookie("", 1)]);
}

const maxLifecycleBody = 4096;
const maxAuthoringBody = 1024 * 1024;
const maxPaidGrantBody = 16 * 1024;
const preferences = target => target.pathname === "/api/account/preferences";

function exactBrowserJson(bytes, maximum = maxLifecycleBody) {
  demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum);
  const text = bytes.toString("utf8"), value = JSON.parse(text);
  demand(JSON.stringify(value) === text);
  return value;
}

const identityRefused = () => new Error("P2_INTERACTIVE_IDENTITY_SESSION_REFUSED");

export function validateP2InteractiveIdentityReceipt(receipt, input) {
  const paired = input.identity?.sessionCount === 2;
  demand(input.stage === "identity" && closed(receipt, ["actorKind", "actorId", "sessionVerified", ...(paired ? ["sessionProofs"] : [])])
    && receipt.sessionVerified === true && uuid(receipt.actorId));
  if (paired) demand(Array.isArray(receipt.sessionProofs) && receipt.sessionProofs.length === 2
    && receipt.sessionProofs.every(sha) && receipt.sessionProofs[0] !== receipt.sessionProofs[1]);
  if (input.firstOwner) demand(receipt.actorKind === "admin");
  else if (input.identityEnrollment) demand(receipt.actorKind === "customer");
  else demand(receipt.actorKind === input.identity.actorKind && receipt.actorId === input.identity.actorId);
  return receipt;
}

function readIdentitySession(body, input, ownerSubjectSha256, openedAt, now) {
  if (body === null) return null;
  const enrollment = input.identityEnrollment, actorKind = input.identity?.actorKind ?? "customer";
  demand(closed(body, ["expires", "user"]) && typeof body.expires === "string");
  const expiry = Date.parse(body.expires);
  demand(Number.isFinite(expiry) && expiry > now && new Date(expiry).toISOString() === body.expires);
  const user = body.user;
  if (actorKind === "customer") {
    demand(closed(user, ["id", "name", "email", "image"]) && uuid(user.id) && user.image === null
      && typeof user.email === "string" && (user.name === null || typeof user.name === "string"));
    if (enrollment) {
      const email = createHash("sha256").update(JSON.stringify(["p2q-customer-enrollment-v1", enrollment.provider, enrollment.nonce, user.email])).digest("hex");
      demand(email === enrollment.emailSha256);
    } else demand(user.id === input.identity.actorId);
    return { actorKind, actorId: user.id, sessionVerified: true };
  }
  const actorId = input.identity.actorId;
  demand(user && typeof user === "object" && !Array.isArray(user)
    && Object.keys(user).every(key => ["name", "email", "image", "providerUserId", "isEmailVerified", "authenticatedAt"].includes(key))
    && typeof user.email === "string" && user.email.trim().length > 0
    && matches(user.providerUserId, /^[!-~]{1,256}$/u) && user.isEmailVerified === true && Number.isSafeInteger(user.authenticatedAt)
    && user.authenticatedAt > 0);
  const subject = createHash("sha256").update(JSON.stringify(["p2q-interactive-owner-v1", input.challenge, actorId, user.providerUserId])).digest("hex");
  const authenticatedAt = user.authenticatedAt * 1000;
  demand(subject === ownerSubjectSha256 && authenticatedAt <= now + 1000);
  if (authenticatedAt < openedAt - 1000 || now - authenticatedAt >= 240_000) return null;
  return validateP2InteractiveIdentityReceipt({ actorKind, actorId, sessionVerified: true }, input);
}

export async function observeP2InteractiveIdentitySession(page, input, { context, ownerSubjectSha256, openedAt, expires }) {
  let response, bytes;
  try {
    validateP2InteractiveBrowserInput(input);
    demand(input.stage === "identity" && context === p2InteractiveIdentityContext(input) && Number.isSafeInteger(openedAt)
      && Number.isSafeInteger(expires) && openedAt <= Date.now() && openedAt < expires * 1000);
    const owner = context === "owner";
    demand(owner && !input.firstOwner ? sha(ownerSubjectSha256) : ownerSubjectSha256 === undefined);
    const remaining = expires * 1000 - Date.now();
    demand(remaining > 0 && remaining <= input.windowSeconds * 1000);
    if (URL.parse(page.url())?.origin !== input.browserOrigin) return null;
    const url = input.browserOrigin + (input.firstOwner ? firstOwnerPath : owner ? "/api/auth/session" : "/api/customer-auth/session");
    if (input.firstOwner && page.url() !== url) return null;
    response = await page.request.get(url, { maxRedirects: 0, timeout: Math.min(8000, remaining),
      headers: { accept: "application/json", "cache-control": "no-cache" } });
    demand(response.url() === url && Date.now() < expires * 1000);
    if ([401, 403].includes(response.status())) return null;
    demand(response.status() === 200);
    const fields = name => response.headersArray().filter(header => header.name.toLowerCase() === name).map(header => header.value);
    const types = fields("content-type"), cache = fields("cache-control"), lengths = fields("content-length"), encodings = fields("content-encoding");
    demand(types.length === 1 && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(types[0])
      && cache.length === 1 && privateNoStore({ "cache-control": cache[0] })
      && (encodings.length === 0 || encodings.length === 1 && encodings[0].toLowerCase() === "identity")
      && lengths.length <= 1 && (lengths.length === 0 || /^[1-9][0-9]{0,3}$/u.test(lengths[0]) && Number(lengths[0]) <= maxLifecycleBody));
    bytes = await response.body();
    demand(lengths.length === 0 || bytes.length === Number(lengths[0]));
    const now = Date.now();
    demand(now < expires * 1000);
    const observed = exactBrowserJson(bytes);
    return input.firstOwner ? validateP2InteractiveIdentityReceipt(observed, input) : readIdentitySession(observed, input, ownerSubjectSha256, openedAt, now);
  } catch {
    throw identityRefused();
  } finally {
    bytes?.fill(0);
    await response?.dispose();
  }
}

async function waitForInteractiveIdentity(page, input, selection) {
  while (Date.now() < selection.expires * 1000) {
    const receipt = await observeP2InteractiveIdentitySession(page, input, selection);
    if (receipt) return receipt;
    await pause(Math.min(2000, Math.max(1, selection.expires * 1000 - Date.now())));
  }
  throw identityRefused();
}

async function customerSessionProof(context, input) {
  const cookies = (await context.cookies(input.browserOrigin)).filter(cookie => cookie.name === customerSessionName);
  demand(cookies.length === 1 && cookies[0].secure && cookies[0].httpOnly
    && cookies[0].path === "/" && cookies[0].value.length > 0 && cookies[0].value.length <= 256);
  const tokenHash = createHash("sha256").update(cookies[0].value).digest("hex");
  return createHash("sha256").update(JSON.stringify(["p2q-customer-session-v1", input.challenge, tokenHash])).digest("hex");
}

export function validateP2LifecycleMutationReceipt(receipt, target) {
  demand(closed(receipt, ["method", "pathname", "status", "requestId", "body"]) && receipt.method === "POST"
    && receipt.pathname === target.pathname && uuid(receipt.requestId));
  const body = receipt.body;
  if (preferences(target)) demand(receipt.status === 200 && closed(body, ["saved"]) && body.saved === true);
  else demand(receipt.status === 202 && closed(body, ["commandId", "action", "accountVersion", "status"])
    && uuid(body.commandId) && body.action === target.operation && body.status === "pending"
    && Number.isSafeInteger(body.accountVersion) && body.accountVersion >= 1);
  return receipt;
}

function validateAuthoringCourseReceipt(receipt, target, edit = false) {
  demand(closed(receipt, ["method", "pathname", "status", "requestId", "body"]) && receipt.method === (edit ? "PATCH" : "POST")
    && receipt.pathname === (edit ? authoringPath + "/" + target.courseId : authoringPath) && receipt.status === 200 && uuid(receipt.requestId)
    && closed(receipt.body, ["courseId", "slug", "revision", "status"]) && uuid(receipt.body.courseId)
    && receipt.body.slug === target.slug && receipt.body.status === "draft"
    && (edit ? receipt.body.courseId === target.courseId && receipt.body.revision === target.revision + 1 : receipt.body.revision === 1));
  return receipt;
}

export function validateP2LearningEnrollmentReceipt(receipt, target) {
  const { academyPath, pathname } = p2LearningEnrollmentPaths(target), replay = learningEnrollmentReplay(target);
  demand(closed(receipt, ["method", "pathname", "status", "requestId", "academyPath", "body"]) && receipt.method === "POST"
    && receipt.pathname === pathname && receipt.status === 200 && uuid(receipt.requestId) && receipt.academyPath === academyPath
    && closed(receipt.body, ["courseId", "grantId", "enrollmentId", "source", "status", "idempotentReplay"])
    && receipt.body.courseId === target.courseId && uuid(receipt.body.grantId) && uuid(receipt.body.enrollmentId)
    && receipt.body.source === "free" && receipt.body.status === "active" && receipt.body.idempotentReplay === replay
    && (!replay || receipt.body.grantId === target.prior?.grantId && receipt.body.enrollmentId === target.prior?.enrollmentId));
  return receipt;
}

export function validateP2LessonEntryReceipt(receipt, target) {
  const { lessonPath } = p2LessonEntryPaths(target);
  const playback = receipt?.playback, progress = receipt?.progress;
  const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
  demand(closed(receipt, ["page", "playback", "progress"]) && closed(receipt.page, ["pathname", "flight"])
    && receipt.page.pathname === lessonPath && receipt.page.flight === true
    && closed(playback, ["requestId", "expiresAt", "thumbnailExpiresAt", "lifetimeMs"]) && uuid(playback.requestId)
    && instant(playback.expiresAt) && instant(playback.thumbnailExpiresAt) && Number.isSafeInteger(playback.lifetimeMs)
    && playback.lifetimeMs >= 590_000 && playback.lifetimeMs <= 601_000
    && closed(progress, ["requestId", "progressId", "enrollmentId", "revision"]) && uuid(progress.requestId)
    && progress.requestId !== playback.requestId && uuid(progress.progressId) && uuid(progress.enrollmentId) && progress.revision === 1);
  return receipt;
}

export function validateP2LessonDenialReceipt(receipt, target) {
  const { lessonPath, targets } = p2LessonDenialPaths(target);
  demand(closed(receipt, ["page", "reads"])
    && closed(receipt.page, ["pathname", "documentStatus", "flightStatus", "documentRequestId", "flightRequestId"])
    && receipt.page.pathname === lessonPath && receipt.page.documentStatus === 200 && receipt.page.flightStatus === 200
    && uuid(receipt.page.documentRequestId) && uuid(receipt.page.flightRequestId)
    && Array.isArray(receipt.reads) && receipt.reads.length === targets.length && receipt.reads.every((read, index) =>
      closed(read, ["target", "status", "requestId", "code"]) && read.target === targets[index] && read.status === 403
      && uuid(read.requestId) && read.code === "access_required")
    && new Set([receipt.page.documentRequestId, receipt.page.flightRequestId, ...receipt.reads.map(read => read.requestId)]).size === targets.length + 2);
  return receipt;
}

const assessmentInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

const integerBetween = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const validResumePosition = (index, resume, submittedMax, priorMax) => {
  if (index === 0) return integerBetween(resume, 10, 12) && submittedMax === resume;
  if (index === 1) return integerBetween(resume, Math.max(13, priorMax), 16)
    && integerBetween(submittedMax, Math.max(priorMax, resume - 1), resume);
  return integerBetween(resume, 3, 6) && resume === priorMax - 10 && submittedMax === priorMax;
};

function validateLessonRestoreTarget(target) {
  demand(closed(target, ["actorId", "operation", "courseId", "lessonId", "grantId", "prior"]) && target.operation === "restore-resume"
    && [target.actorId, target.courseId, target.lessonId, target.grantId].every(uuid));
  const prior = target.prior;
  demand(closed(prior, ["actionId", "outcomeSha256", "progressId", "enrollmentId", "resumePositionSeconds", "maxPositionSeconds",
    "playbackIdSha256", "playbackExpiresAt"])
    && matches(prior.actionId, /^[a-z0-9][a-z0-9-]{0,63}$/u)
    && [prior.outcomeSha256, prior.playbackIdSha256].every(value => sha(value) && !/^0+$/u.test(value))
    && uuid(prior.progressId) && uuid(prior.enrollmentId) && assessmentInstant(prior.playbackExpiresAt)
    && prior.playbackExpiresAt.length === 24 && !prior.playbackExpiresAt.startsWith("0000")
    && integerBetween(prior.resumePositionSeconds, 3, 6) && prior.maxPositionSeconds === prior.resumePositionSeconds + 10);
}

function validResumePlayback(playback) {
  return closed(playback, ["requestId", "expiresAt", "thumbnailExpiresAt", "lifetimeMs", "playbackIdSha256"])
    && uuid(playback.requestId) && sha(playback.playbackIdSha256) && !/^0+$/u.test(playback.playbackIdSha256)
    && assessmentInstant(playback.expiresAt) && assessmentInstant(playback.thumbnailExpiresAt)
    && integerBetween(playback.lifetimeMs, 590_000, 601_000)
    && Math.abs(Date.parse(playback.expiresAt) - Date.parse(playback.thumbnailExpiresAt)) + playback.lifetimeMs <= 601_000;
}

export function validateP2LessonResumeReceipt(receipt, target) {
  const { lessonPath } = p2LessonResumePaths(target), { page, playback, started, writes, media } = receipt ?? {};
  demand(closed(receipt, ["page", "playback", "started", "writes", "media"])
    && closed(page, ["pathname", "status"]) && page.pathname === lessonPath && page.status === 200
    && validResumePlayback(playback)
    && closed(started, ["requestId", "progressId", "enrollmentId", "revision"])
    && [started.requestId, started.progressId, started.enrollmentId].every(uuid) && started.revision === 1
    && Array.isArray(writes) && writes.length === 3);
  let priorMax = 0;
  for (const [index, row] of writes.entries()) {
    demand(closed(row, ["requestId", "expectedProgressRevision", "revision", "resumePositionSeconds", "submittedMaxPositionSeconds", "maxPositionSeconds"])
      && uuid(row.requestId) && row.expectedProgressRevision === index + 1 && row.revision === index + 2
      && validResumePosition(index, row.resumePositionSeconds, row.submittedMaxPositionSeconds, priorMax)
      && row.maxPositionSeconds === Math.max(row.resumePositionSeconds, row.submittedMaxPositionSeconds));
    priorMax = row.maxPositionSeconds;
  }
  demand(new Set([playback.requestId, started.requestId, ...writes.map(row => row.requestId)]).size === 5
    && closed(media, ["durationSeconds", "videoWidth", "heartbeatSeconds", "pausedSeconds", "rewoundSeconds", "manifestObserved", "segmentObserved"])
    && integerBetween(media.durationSeconds, 22, Number.MAX_SAFE_INTEGER) && integerBetween(media.videoWidth, 1, Number.MAX_SAFE_INTEGER)
    && integerBetween(media.heartbeatSeconds, writes[0].resumePositionSeconds, writes[0].resumePositionSeconds + 1)
    && media.pausedSeconds === writes[1].resumePositionSeconds && media.rewoundSeconds === writes[2].resumePositionSeconds
    && media.manifestObserved === true && media.segmentObserved === true);
  return receipt;
}

export function validateP2LessonRestoreReceipt(receipt, target) {
  validateLessonRestoreTarget(target);
  const { lessonPath } = p2LessonResumePaths(target), { prior } = target;
  const { page, playback, started, restored, media } = receipt ?? {};
  demand(closed(receipt, ["page", "playback", "started", "restored", "media"])
    && closed(page, ["pathname", "status"]) && page.pathname === lessonPath && page.status === 200
    && validResumePlayback(playback) && playback.playbackIdSha256 === prior.playbackIdSha256
    && closed(started, ["requestId", "progressId", "enrollmentId", "revision"])
    && uuid(started.requestId) && started.progressId === prior.progressId && started.enrollmentId === prior.enrollmentId && started.revision === 5
    && closed(restored, ["requestId", "progressId", "enrollmentId", "revision", "resumePositionSeconds", "maxPositionSeconds"])
    && uuid(restored.requestId) && restored.progressId === prior.progressId && restored.enrollmentId === prior.enrollmentId && restored.revision === 6
    && restored.resumePositionSeconds === prior.resumePositionSeconds && restored.maxPositionSeconds === prior.maxPositionSeconds
    && new Set([playback.requestId, started.requestId, restored.requestId]).size === 3
    && closed(media, ["durationSeconds", "videoWidth", "restoredSeconds", "paused", "manifestObserved", "segmentObserved"])
    && integerBetween(media.durationSeconds, 22, Number.MAX_SAFE_INTEGER) && integerBetween(media.videoWidth, 1, Number.MAX_SAFE_INTEGER)
    && media.restoredSeconds === prior.resumePositionSeconds && media.paused === true && media.manifestObserved === true && media.segmentObserved === true);
  return receipt;
}

function validatePinnedLessonPositionTarget(target, operations) {
  demand(closed(target, ["actorId", "operation", "courseId", "lessonId", "grantId", "progressId", "enrollmentId", "resumePositionSeconds",
    "maxPositionSeconds", "playbackIdSha256"]) && operations.includes(target.operation)
    && [target.actorId, target.courseId, target.lessonId, target.grantId, target.progressId, target.enrollmentId].every(uuid)
    && integerBetween(target.resumePositionSeconds, 3, 6) && target.maxPositionSeconds === target.resumePositionSeconds + 10
    && sha(target.playbackIdSha256) && !/^0+$/u.test(target.playbackIdSha256));
}

const pinnedProgressFields = ["requestId", "progressId", "enrollmentId", "revision", "resumePositionSeconds", "maxPositionSeconds"];
const validateLessonAckLossTarget = target => validatePinnedLessonPositionTarget(target, ["commit-drop-recover"]);
const validateLessonExitSaveTarget = target => validatePinnedLessonPositionTarget(target, ["spa-navigation", "document-exit"]);
const validateLessonVisibilityTarget = target => validatePinnedLessonPositionTarget(target, ["hide-active-document"]);
const validateLessonStaleRevisionTarget = target => validatePinnedLessonPositionTarget(target, ["conflict-reload"]);

export function validateP2LessonAckLossReceipt(receipt, target) {
  validateLessonAckLossTarget(target);
  const { page, playback, writes, recovery, media } = receipt ?? {};
  const { lessonPath } = p2LessonResumePaths(target), { resumePositionSeconds: resume, maxPositionSeconds: maximum } = target;
  const progressMatches = (row, revision, position) => uuid(row.requestId) && row.progressId === target.progressId
    && row.enrollmentId === target.enrollmentId && row.revision === revision
    && row.resumePositionSeconds === position && row.maxPositionSeconds === maximum;
  demand(closed(receipt, ["page", "playback", "writes", "recovery", "media"])
    && closed(page, ["pathname", "status"]) && page.pathname === lessonPath && page.status === 200
    && Array.isArray(playback) && playback.length === 2 && playback.every(row =>
      validResumePlayback(row) && row.playbackIdSha256 === target.playbackIdSha256)
    && Array.isArray(writes) && writes.length === 5 && writes.every((row, index) =>
      closed(row, pinnedProgressFields) && progressMatches(row, index + 7, index < 2 ? resume : maximum))
    && closed(recovery, [...pinnedProgressFields, "browserFailure", "unconfirmedObserved", "noReplay"])
    && progressMatches(recovery, 9, maximum) && recovery.browserFailure === "connectionreset"
    && recovery.unconfirmedObserved === true && recovery.noReplay === true
    && new Set([...playback, ...writes, recovery].map(row => row.requestId)).size === 8
    && closed(media, ["beforeSeconds", "afterSeconds", "paused", "manifestObserved", "segmentObserved"])
    && media.beforeSeconds === resume && media.afterSeconds === maximum && media.paused === true
    && media.manifestObserved === true && media.segmentObserved === true);
  return receipt;
}

export function validateP2LessonExitSaveReceipt(receipt, target) {
  validateLessonExitSaveTarget(target);
  const { page, playback, writes, exit, media } = receipt ?? {};
  const { lessonPath, academyPath } = p2LessonEntryPaths(target);
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum } = target;
  const documentExit = target.operation === "document-exit";
  demand(closed(receipt, ["page", "playback", "writes", "exit", "media"])
    && closed(page, ["pathname", "status"]) && page.pathname === lessonPath && page.status === 200
    && validResumePlayback(playback) && playback.playbackIdSha256 === target.playbackIdSha256
    && Array.isArray(writes) && writes.length === 2 && writes.every((row, index) => closed(row, pinnedProgressFields)
      && uuid(row.requestId) && row.progressId === target.progressId && row.enrollmentId === target.enrollmentId
      && row.revision === index + 7 && row.resumePositionSeconds === resume && row.maxPositionSeconds === maximum)
    && new Set([playback.requestId, ...writes.map(row => row.requestId)]).size === 3
    && closed(exit, ["pathname", "status", "sameDocument", "trustedPagehide", "trustedHidden", "resumePositionSeconds",
      "maxPositionSeconds", "expectedProgressRevision"])
    && exit.pathname === academyPath && exit.status === 200 && exit.sameDocument === !documentExit
    && exit.trustedPagehide === documentExit && exit.trustedHidden === documentExit && exit.expectedProgressRevision === 8
    && integerBetween(exit.resumePositionSeconds, resume + 2, resume + 5) && exit.maxPositionSeconds === maximum
    && closed(media, ["playedSeconds", "playing", "manifestObserved", "segmentObserved"])
    && integerBetween(media.playedSeconds, resume + 2, resume + 5) && Math.abs(media.playedSeconds - exit.resumePositionSeconds) <= 2
    && media.playing === true && media.manifestObserved === true && media.segmentObserved === true);
  return receipt;
}

export function validateP2LessonVisibilityReceipt(receipt, target) {
  validateLessonVisibilityTarget(target);
  const { page, playback, writes, visibility, media } = receipt ?? {};
  const { lessonPath } = p2LessonResumePaths(target), { resumePositionSeconds: resume, maxPositionSeconds: maximum } = target;
  demand(closed(receipt, ["page", "playback", "writes", "visibility", "media"])
    && closed(page, ["pathname", "status"]) && page.pathname === lessonPath && page.status === 200
    && validResumePlayback(playback) && playback.playbackIdSha256 === target.playbackIdSha256
    && closed(visibility, ["sameDocument", "trustedHidden", "trustedPagehide", "resumePositionSeconds", "maxPositionSeconds",
      "expectedProgressRevision"])
    && visibility.sameDocument === true && visibility.trustedHidden === true && visibility.trustedPagehide === false
    && visibility.expectedProgressRevision === 8 && integerBetween(visibility.resumePositionSeconds, resume + 2, resume + 5)
    && visibility.maxPositionSeconds === maximum
    && Array.isArray(writes) && writes.length === 3 && writes.every((row, index) => closed(row, pinnedProgressFields)
      && uuid(row.requestId) && row.progressId === target.progressId && row.enrollmentId === target.enrollmentId
      && row.revision === index + 7 && row.resumePositionSeconds === (index < 2 ? resume : visibility.resumePositionSeconds)
      && row.maxPositionSeconds === maximum)
    && new Set([playback.requestId, ...writes.map(row => row.requestId)]).size === 4
    && closed(media, ["playedSeconds", "playing", "manifestObserved", "segmentObserved"])
    && integerBetween(media.playedSeconds, resume + 2, resume + 5) && Math.abs(media.playedSeconds - visibility.resumePositionSeconds) <= 2
    && media.playing === true && media.manifestObserved === true && media.segmentObserved === true);
  return receipt;
}

export function validateP2LessonStaleRevisionReceipt(receipt, target) {
  validateLessonStaleRevisionTarget(target);
  const { page, playback, writes, conflict, authoritative, reload, media } = receipt ?? {};
  const { lessonPath } = p2LessonResumePaths(target);
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum } = target;
  const matchesProgress = (row, revision, position) => closed(row, pinnedProgressFields) && uuid(row.requestId)
    && row.progressId === target.progressId && row.enrollmentId === target.enrollmentId && row.revision === revision
    && row.resumePositionSeconds === position && row.maxPositionSeconds === maximum;
  demand(closed(receipt, ["page", "playback", "writes", "conflict", "authoritative", "reload", "media"])
    && closed(page, ["pathname", "status"]) && page.pathname === lessonPath && page.status === 200
    && Array.isArray(playback) && playback.length === 3
    && playback.every(row => validResumePlayback(row) && row.playbackIdSha256 === target.playbackIdSha256)
    && Array.isArray(writes) && writes.length === 7
    && writes.every((row, index) => matchesProgress(row, index + 7, index < 4 ? resume : maximum))
    && closed(conflict, ["requestId", "expectedProgressRevision", "resumePositionSeconds", "maxPositionSeconds", "status"])
    && uuid(conflict.requestId) && conflict.expectedProgressRevision === 8 && conflict.resumePositionSeconds === 0
    && conflict.maxPositionSeconds === maximum && conflict.status === 409 && matchesProgress(authoritative, 11, maximum)
    && new Set([...playback, ...writes, conflict, authoritative].map(row => row.requestId)).size === 12
    && closed(reload, ["documentReplaced", "noReplay"]) && reload.documentReplaced === true && reload.noReplay === true
    && closed(media, ["beforeSeconds", "afterSeconds", "paused", "manifestObserved", "segmentObserved"])
    && media.beforeSeconds === resume && media.afterSeconds === maximum && media.paused === true
    && media.manifestObserved === true && media.segmentObserved === true);
  return receipt;
}

export function validateP2LessonAssessmentReceipt(receipt, target) {
  const { lessonPath } = p2LessonAssessmentPaths(target);
  demand(closed(receipt, ["page", "playback", "started", "attempts"])
    && closed(receipt.page, ["pathname", "status"]) && receipt.page.pathname === lessonPath && receipt.page.status === 200
    && closed(receipt.playback, ["requestId", "status"]) && uuid(receipt.playback.requestId) && receipt.playback.status === 404
    && closed(receipt.started, ["requestId", "progressId", "enrollmentId", "revision"])
    && [receipt.started.requestId, receipt.started.progressId, receipt.started.enrollmentId].every(uuid) && receipt.started.revision === 1
    && Array.isArray(receipt.attempts) && receipt.attempts.length === 2);
  const { started, playback, attempts } = receipt;
  for (const [index, attempt] of attempts.entries()) {
    const passing = index === 1;
    demand(closed(attempt, ["requestId", "payloadRequestId", "attemptId", "quizRevisionId", "quizRevision", "correctCount",
      "totalCount", "passed", "completed", "createdAt", "progress"])
      && [attempt.requestId, attempt.attemptId, attempt.quizRevisionId].every(uuid) && assessmentRequestId(attempt.payloadRequestId)
      && attempt.quizRevision === target.quizRevision && attempt.totalCount === target.failAnswers.length
      && Number.isSafeInteger(attempt.correctCount) && attempt.correctCount >= 0 && attempt.correctCount <= attempt.totalCount
      && attempt.passed === passing && attempt.completed === passing && assessmentInstant(attempt.createdAt));
    const progress = attempt.progress;
    demand(closed(progress, ["requestId", "progressId", "enrollmentId", "revision", "completedAt", "completedQuizRevision"])
      && uuid(progress.requestId) && progress.progressId === started.progressId && progress.enrollmentId === started.enrollmentId
      && progress.revision === index + 2 && progress.completedAt === (passing ? attempt.createdAt : null)
      && progress.completedQuizRevision === (passing ? target.quizRevision : null));
  }
  demand(new Set([playback.requestId, started.requestId, ...attempts.flatMap(attempt =>
    [attempt.requestId, attempt.payloadRequestId, attempt.attemptId, attempt.progress.requestId])]).size === 10
    && attempts[0].quizRevisionId === attempts[1].quizRevisionId
    && attempts[0].correctCount < attempts[1].correctCount
    && Date.parse(attempts[0].createdAt) <= Date.parse(attempts[1].createdAt));
  return receipt;
}

const paidLearnerAccessOutcomes = {
  allowed: { status: 200, codes: [null] },
  archived: { status: 410, codes: ["course_archived"] },
  draft: { status: 404, codes: ["not_found"] },
  restricted: { status: 403, codes: ["access_required", "access_revoked"] },
};

export function validateP2PaidLearnerAccessReceipt(receipt, target) {
  const { pagePath, targets } = p2PaidLearnerAccessPaths(target), expected = paidLearnerAccessOutcomes[target.outcome];
  demand(expected && closed(receipt, ["page", "reads", "body"]) && closed(receipt.page, ["pathname", "status", "lessonLink"])
    && receipt.page.pathname === pagePath && receipt.page.status === 200 && receipt.page.lessonLink === (target.outcome === "allowed")
    && Array.isArray(receipt.reads) && receipt.reads.length === targets.length && receipt.reads.every((read, index) =>
      closed(read, ["target", "status", "requestId", "code"]) && read.target === targets[index] && read.status === expected.status
      && uuid(read.requestId) && expected.codes.includes(read.code))
    && new Set(receipt.reads.map(read => read.requestId)).size === targets.length
    && closed(receipt.body, ["courseId", "lessonId", "outcome"]) && receipt.body.courseId === target.courseId
    && receipt.body.lessonId === target.lessonId && receipt.body.outcome === target.outcome);
  return receipt;
}

export function validateP2PaidGrantReceipt(receipt, target) {
  demand(closed(receipt, ["method", "pathname", "status", "requestId", "body"]) && receipt.method === "POST"
    && receipt.pathname === p2PaidGrantPaths(target).pathname && receipt.status === 200 && uuid(receipt.requestId)
    && closed(receipt.body, ["courseId", "userId", "commandId", "grantId", "courseRevision"])
    && receipt.body.courseId === target.courseId && receipt.body.userId === target.userId && receipt.body.courseRevision === target.revision
    && uuid(receipt.body.commandId) && uuid(receipt.body.grantId));
  return receipt;
}

export function validateP2PaidRevokeReceipt(receipt, target) {
  demand(closed(receipt, ["method", "pathname", "status", "requestId", "body"]) && receipt.method === "POST"
    && receipt.pathname === p2PaidRevokePaths(target).pathname && receipt.status === 200 && uuid(receipt.requestId)
    && closed(receipt.body, ["courseId", "userId", "grantId", "commandId", "courseRevision"])
    && receipt.body.courseId === target.courseId && receipt.body.userId === target.userId && receipt.body.grantId === target.grantId
    && receipt.body.courseRevision === target.revision && uuid(receipt.body.commandId));
  return receipt;
}

const matchesAuthoringStep = (step, method, pathname, status = 200) => closed(step, ["method", "pathname", "status", "requestId"])
  && step.method === method && step.pathname === pathname && step.status === status && uuid(step.requestId);

export function validateP2AuthoringMutationReceipt(receipt, target) {
  if (target.operation === "archive-paid-course") {
    demand(closed(receipt, ["method", "pathname", "status", "requestId", "body", "warningObserved", "cancelObservedWithoutMutation"])
      && receipt.method === "PATCH" && receipt.pathname === authoringPath + "/" + target.courseId && receipt.status === 200
      && uuid(receipt.requestId) && receipt.warningObserved === true && receipt.cancelObservedWithoutMutation === true
      && closed(receipt.body, ["courseId", "slug", "revision", "status"]) && receipt.body.courseId === target.courseId
      && receipt.body.slug === target.slug && receipt.body.revision === target.revision + 1 && receipt.body.status === "archived");
    return receipt;
  }
  if (target.operation === "save-quiz-revision") {
    const pathname = p2AuthoringQuizPath(target);
    demand(closed(receipt, ["prior", "save", "body"])
      && matchesAuthoringStep(receipt.prior, "GET", pathname, target.quizRevision === 0 ? 404 : 200)
      && matchesAuthoringStep(receipt.save, "PUT", pathname) && receipt.save.requestId !== receipt.prior.requestId
      && closed(receipt.body, ["courseId", "slug", "lessonId", "quizId", "revision", "quizRevision", "documentSha256"])
      && receipt.body.courseId === target.courseId && receipt.body.slug === target.slug && receipt.body.lessonId === target.lessonId
      && uuid(receipt.body.quizId) && receipt.body.revision === target.revision + 1 && receipt.body.quizRevision === target.quizRevision + 1
      && receipt.body.documentSha256 === target.documentSha256);
    return receipt;
  }
  if (["qualify-publication", "republish-paid-course"].includes(target.operation)) {
    const { detail, readiness } = p2AuthoringPublicationPaths(target), published = publishedOutcome(target);
    const republish = target.operation === "republish-paid-course";
    demand(closed(receipt, ["readiness", "body", ...(published ? ["publication"] : []), ...(republish ? ["draft"] : [])])
      && matchesAuthoringStep(receipt.readiness, "GET", readiness)
      && (!republish || matchesAuthoringStep(receipt.draft, "PATCH", detail)
        && receipt.draft.requestId !== receipt.readiness.requestId && receipt.draft.requestId !== receipt.publication?.requestId)
      && (!published || matchesAuthoringStep(receipt.publication, "PATCH", detail) && receipt.publication.requestId !== receipt.readiness.requestId)
      && closed(receipt.body, ["courseId", "slug", "revision", "status", "issueCodes"])
      && receipt.body.courseId === target.courseId && receipt.body.slug === target.slug
      && receipt.body.revision === target.revision + Number(republish) + Number(published) && receipt.body.status === (published ? "published" : "draft")
      && Array.isArray(receipt.body.issueCodes) && receipt.body.issueCodes.length === target.issueCodes.length
      && target.issueCodes.every((code, index) => receipt.body.issueCodes[index] === code));
    return receipt;
  }
  if (target.operation === "create-curriculum") {
    demand(closed(receipt, ["method", "pathname", "status", "requestId", "body"]) && receipt.method === "POST"
      && receipt.pathname === p2AuthoringCurriculumPath(target) && receipt.status === 200 && uuid(receipt.requestId)
      && closed(receipt.body, ["courseId", "parentId", "kind", "itemId", "slug", "revision"])
      && receipt.body.courseId === target.courseId && receipt.body.parentId === target.parentId && receipt.body.kind === target.kind
      && uuid(receipt.body.itemId) && receipt.body.slug === target.childSlug && receipt.body.revision === target.revision + 1);
    return receipt;
  }
  return validateAuthoringCourseReceipt(receipt, target);
}

export function validateP2AuthoringEditResponses(responses, target) {
  demand(closed(responses, ["winner", "stale"]));
  validateAuthoringCourseReceipt(responses.winner, target, true);
  const stale = responses.stale;
  demand(closed(stale, ["method", "pathname", "status", "requestId", "outcome", "dirtyInputPreserved"])
    && stale.method === "PATCH" && stale.pathname === authoringPath + "/" + target.courseId && stale.status === 409
    && uuid(stale.requestId) && stale.requestId !== responses.winner.requestId
    && stale.outcome === "conflict" && stale.dirtyInputPreserved === true);
  return responses;
}

const orderedIds = ids => Array.isArray(ids) && ids.length >= 2 && ids.length <= 1000 && ids.every(uuid) && new Set(ids).size === ids.length;

export function validateP2AuthoringReorderResponses(responses, target) {
  demand(closed(responses, ["winner", "stale"]));
  const { winner, stale } = responses, pathname = p2AuthoringReorderPath(target);
  demand(closed(winner, ["method", "pathname", "status", "requestId", "keyboardActivated", "body"])
    && winner.method === "POST" && winner.pathname === pathname && winner.status === 200 && uuid(winner.requestId)
    && winner.keyboardActivated === true && closed(winner.body, ["courseId", "parentId", "kind", "revision", "ids"])
    && winner.body.courseId === target.courseId && winner.body.parentId === target.parentId && winner.body.kind === target.kind
    && winner.body.revision === target.revision + 1 && orderedIds(winner.body.ids));
  demand(closed(stale, ["method", "pathname", "status", "requestId", "keyboardActivated", "outcome"])
    && stale.method === "POST" && stale.pathname === pathname && stale.status === 409 && uuid(stale.requestId)
    && stale.requestId !== winner.requestId && stale.keyboardActivated === true && stale.outcome === "conflict");
  return responses;
}

function reorderResult(body, target, submittedIds) {
  const modules = target.kind === "module", field = modules ? "course" : "module";
  demand(closed(body, [field]));
  const result = body[field];
  demand(result && typeof result === "object" && !Array.isArray(result) && result.id === target.parentId);
  if (modules) demand(result.slug === target.slug && result.status === "draft");
  else demand(result.courseId === target.courseId);
  const revision = modules ? result.revision : result.courseRevision, items = modules ? result.modules : result.lessons;
  demand(Array.isArray(items) && revision === target.revision + 1 && items.length === submittedIds.length);
  const ids = items.map(item => item?.id);
  demand(orderedIds(ids) && ids.every((id, index) => id === submittedIds[index]));
  return { courseId: target.courseId, parentId: target.parentId, kind: target.kind, revision, ids };
}

function validateCurriculumPost(body, target) {
  const createsModule = target.kind === "module";
  demand(closed(body, ["expectedCourseRevision", "title", "slug", "position",
    ...(createsModule ? ["description"] : ["contentDocument", "transcript", "isPreview", "captions"])])
    && body.expectedCourseRevision === target.revision && typeof body.title === "string" && body.title.length > 0
    && body.slug === target.childSlug && Number.isSafeInteger(body.position) && body.position >= 1);
  if (createsModule) demand(body.description === null || typeof body.description === "string");
  else demand((body.transcript === null || typeof body.transcript === "string") && typeof body.isPreview === "boolean"
    && closed(body.contentDocument, ["version", "blocks"]) && body.contentDocument.version === 1
    && Array.isArray(body.contentDocument.blocks) && body.contentDocument.blocks.length <= 500
    && Array.isArray(body.captions) && body.captions.length === 0);
}

function curriculumResult(body, target) {
  demand(closed(body, [target.kind]));
  const item = body[target.kind];
  demand(item && typeof item === "object" && !Array.isArray(item)
    && item[target.kind === "module" ? "courseId" : "moduleId"] === target.parentId);
  return { courseId: target.courseId, parentId: target.parentId, kind: target.kind,
    itemId: item.id, slug: item.slug, revision: item.courseRevision };
}

async function readBrowserResponseHead(response, request, origin, pathname, method, status) {
  demand(response.url() === origin + pathname && response.status() === status && request.method() === method
    && !response.fromServiceWorker() && request.redirectedTo() === null);
  const [ids, contentTypes, cache] = await Promise.all([
    response.headerValues("x-request-id"), response.headerValues("content-type"), response.headerValues("cache-control"),
  ]);
  demand(ids.length === 1 && uuid(ids[0]) && contentTypes.length === 1 && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentTypes[0])
    && cache.length === 1 && privateNoStore({ "cache-control": cache[0] }));
  return { method, pathname, status, requestId: ids[0] };
}

async function readBrowserResponseBounds(response, request, maximum, allowCompression) {
  const [encodings, lengths, size] = await Promise.all([
    response.headerValues("content-encoding"), response.headerValues("content-length"), request.sizes(),
  ]);
  const identity = encodings.length === 0 || encodings.length === 1 && encodings[0].toLowerCase() === "identity";
  demand((identity || allowCompression && encodings.length === 1 && ["gzip", "br", "deflate", "zstd"].includes(encodings[0].toLowerCase()))
    && lengths.length <= 1 && (lengths.length === 0 || /^[1-9][0-9]{0,6}$/u.test(lengths[0]))
    && Number.isSafeInteger(size.responseBodySize) && size.responseBodySize <= maximum);
  const declared = lengths.length === 1 ? Number(lengths[0]) : undefined;
  demand(declared === undefined ? size.responseBodySize > 0 : declared <= maximum);
  return { identity, declared };
}

async function readBrowserResponseJson(response, request, maximum, allowCompression = false) {
  const { identity, declared } = await readBrowserResponseBounds(response, request, maximum, allowCompression);
  const bytes = await response.body();
  try {
    demand(!identity || declared === undefined || bytes.length === declared);
    return exactBrowserJson(bytes, maximum);
  } finally { bytes.fill(0); }
}

function readCourseResult(body) {
  demand(closed(body, ["course"]) && body.course && typeof body.course === "object" && !Array.isArray(body.course));
  const { id: courseId, slug, revision, status } = body.course;
  return { courseId, slug, revision, status };
}

function approvedGrantReason(reason, digest) {
  return typeof reason === "string" && reason.length <= 1800 && reason.trim().length > 0
    && createHash("sha256").update(reason.trim()).digest("hex") === digest;
}

function readPaidGrantResult(body, target) {
  demand(closed(body, ["state", "idempotencyKey", "command", "grant", "courseRevision", "mutationRetried", "communityDeliveryVerified"])
    && body.state === "confirmed" && body.idempotencyKey === target.idempotencyKey && body.courseRevision === target.revision
    && body.mutationRetried === false && body.communityDeliveryVerified === false);
  const { command, grant } = body, prefix = `[paid-course revision ${target.revision}] `;
  demand(closed(command, ["commandId", "action", "scope", "outcome", "actorUserId", "userId", "courseId", "targetGrantId", "reason",
    "effectiveAt", "affectedGrantCount", "effects", "createdAt", "idempotencyKey"])
    && uuid(command.commandId) && command.action === "grant" && command.scope === "userCourse" && command.outcome === "applied"
    && command.actorUserId === target.actorId && command.userId === target.userId && command.courseId === target.courseId
    && command.idempotencyKey === "owner-paid:" + target.idempotencyKey && command.targetGrantId === null && command.affectedGrantCount === 1
    && typeof command.reason === "string" && command.reason.startsWith(prefix) && Array.isArray(command.effects) && command.effects.length === 1);
  const reason = command.reason.slice(prefix.length), [effect] = command.effects;
  demand(approvedGrantReason(reason, target.reasonSha256) && reason === reason.trim()
    && closed(effect, ["grantId", "effectType", "previousStatus", "resultingStatus"]) && uuid(effect.grantId)
    && effect.effectType === "grant_created" && effect.previousStatus === null && effect.resultingStatus === "active"
    && closed(grant, ["grantId", "userId", "courseId", "status", "grantReason", "orderId", "externalPaymentId", "provider"])
    && grant.grantId === effect.grantId && grant.userId === target.userId && grant.courseId === target.courseId
    && grant.status === "active" && grant.grantReason === "manual" && grant.orderId === null && grant.externalPaymentId === null && grant.provider === null);
  return { courseId: target.courseId, userId: target.userId, commandId: command.commandId, grantId: grant.grantId, courseRevision: body.courseRevision };
}

function readPaidRevokeResult(body, target) {
  demand(closed(body, ["state", "idempotencyKey", "command", "grant", "courseRevision", "mutationRetried", "communityDeliveryVerified"])
    && body.state === "confirmed" && body.idempotencyKey === target.idempotencyKey && body.courseRevision === target.revision
    && body.mutationRetried === false && body.communityDeliveryVerified === false
    && closed(body.command, ["commandId"]) && uuid(body.command.commandId)
    && closed(body.grant, ["grantId", "userId", "courseId", "status", "orderId", "externalPaymentId", "provider"])
    && body.grant.grantId === target.grantId && body.grant.userId === target.userId && body.grant.courseId === target.courseId
    && body.grant.status === "revoked" && body.grant.orderId === null && body.grant.externalPaymentId === null && body.grant.provider === null);
  return { courseId: body.grant.courseId, userId: body.grant.userId, grantId: body.grant.grantId,
    commandId: body.command.commandId, courseRevision: body.courseRevision };
}

async function readMutationResponse(response, request, input, pathname, editRole, submittedIds) {
  const authoring = input.stage === "authoring", learning = input.stage === "learning", paidGrant = input.stage === "paid-grant";
  const paidRevoke = input.stage === "paid-revoke";
  const maximum = authoring ? maxAuthoringBody : paidGrant || paidRevoke ? maxPaidGrantBody : maxLifecycleBody;
  const reorder = authoringReorder(input), archive = authoringArchive(input), method = archive || editRole && !reorder ? "PATCH" : "POST";
  const status = editRole === "stale" ? 409 : authoring || learning || paidGrant || paidRevoke || preferences(input.lifecycle) ? 200 : 202;
  const receipt = await readBrowserResponseHead(response, request, input.browserOrigin, pathname, method, status);
  if (reorder) receipt.keyboardActivated = true;
  // The normal editor handles the status and request ID without consuming its
  // error body. Chromium may discard those bytes. The conflict alert and
  // retained dirty input are verified separately before the paired receipt.
  if (editRole === "stale") return receipt;
  const body = await readBrowserResponseJson(response, request, maximum);
  if (learning) return validateP2LearningEnrollmentReceipt({ ...receipt, academyPath: p2LearningEnrollmentPaths(input.learning).academyPath, body }, input.learning);
  if (paidGrant) return validateP2PaidGrantReceipt({ ...receipt, body: readPaidGrantResult(body, input.paidGrant) }, input.paidGrant);
  if (paidRevoke) return validateP2PaidRevokeReceipt({ ...receipt, body: readPaidRevokeResult(body, input.paidRevoke) }, input.paidRevoke);
  if (!authoring) return validateP2LifecycleMutationReceipt({ ...receipt, body }, input.lifecycle);
  if (reorder) return { ...receipt, body: reorderResult(body, input.authoring, submittedIds) };
  if (authoringCreateCurriculum(input)) {
    return validateP2AuthoringMutationReceipt({ ...receipt, body: curriculumResult(body, input.authoring) }, input.authoring);
  }
  if (archive) return validateP2AuthoringMutationReceipt({ ...receipt, body: readCourseResult(body),
    warningObserved: true, cancelObservedWithoutMutation: true }, input.authoring);
  return validateAuthoringCourseReceipt({ ...receipt, body: readCourseResult(body) }, input.authoring, editRole === "winner");
}

// Attach before navigation. A second selected request, even one whose response
// is lost while closing the page, invalidates the first accepted response.
function watchMutation(context, page, input, edit) {
  validateP2InteractiveBrowserInput(input);
  const authoring = input.stage === "authoring", reorder = authoringReorder(input), create = authoringCreateCurriculum(input), target = input.lifecycle;
  const archive = authoringArchive(input);
  const learning = input.stage === "learning" ? p2LearningEnrollmentPaths(input.learning) : undefined;
  const paidRevoke = input.stage === "paid-revoke";
  const paidGrant = input.stage === "paid-grant" ? p2PaidGrantPaths(input.paidGrant) : paidRevoke ? p2PaidRevokePaths(input.paidRevoke) : undefined;
  const academyUrl = learning && input.browserOrigin + learning.academyPath;
  const pathname = reorder ? p2AuthoringReorderPath(input.authoring) : create ? p2AuthoringCurriculumPath(input.authoring)
    : edit || archive ? authoringPath + "/" + input.authoring.courseId : authoring ? authoringPath : (learning ?? paidGrant ?? target).pathname;
  const method = archive || edit && !reorder ? "PATCH" : "POST";
  const refusal = () => new Error("P2_INTERACTIVE_" + input.stage.toUpperCase().replaceAll("-", "_") + "_RESPONSE_REFUSED");
  let selected, receipt, accept, reject, submittedIds, activation, failed = false, responseStarted = false, completed = false, arrived = false;
  const observed = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  observed.catch(() => {});
  const fail = () => { failed = true; reject(refusal()); };
  const onRequest = request => {
    const url = URL.parse(request.url());
    if (!url) return;
    if ((archive || paidRevoke) && url.origin === input.browserOrigin && !["GET", "HEAD", "OPTIONS"].includes(request.method())
      && (url.pathname !== pathname || request.method() !== method)) return fail();
    if (url.origin !== input.browserOrigin || url.pathname !== pathname || request.method() !== method) return;
    try {
      const frame = request.frame();
      if (edit && frame === edit.peer.mainFrame()) return;
      demand(!selected && !url.search && !url.hash && request.redirectedFrom() === null && frame === page.mainFrame());
      selected = request;
      const bytes = request.postDataBuffer(), posted = exactBrowserJson(bytes, authoring ? maxAuthoringBody : paidGrant ? 8192 : maxLifecycleBody);
      if (authoring) {
        const source = URL.parse(frame.url());
        const digest = edit ? input.authoring[edit.role + "BodySha256"] : input.authoring.bodySha256;
        demand(source?.origin === input.browserOrigin && source.pathname === p2InteractiveBrowserEntryPath(input, "owner")
          && createHash("sha256").update(bytes).digest("hex") === digest);
        if (reorder) {
          demand(closed(posted, ["expectedCourseRevision", "ids"]) && posted.expectedCourseRevision === input.authoring.revision && orderedIds(posted.ids));
          submittedIds = posted.ids;
          activation = edit.acceptReorder(frame);
          activation.catch(fail);
        } else if (create) validateCurriculumPost(posted, input.authoring);
        else if (archive) {
          demand(frame.url() === input.browserOrigin + p2InteractiveBrowserEntryPath(input, "owner") && request.resourceType() === "fetch"
            && closed(posted, ["expectedRevision", "status"]) && posted.expectedRevision === input.authoring.revision && posted.status === "archived");
          activation = frame.evaluate(() => window.__lashP2qConsumePaidArchive?.() === true).then(demand);
          activation.catch(fail);
        }
        else {
          demand(posted?.slug === input.authoring.slug);
          if (edit) {
            demand(posted.expectedRevision === input.authoring.revision && !Object.hasOwn(posted, "status")
              && typeof posted.title === "string" && posted.title.length > 0 && posted.title.length <= 300);
            edit.acceptTitle(posted.title);
          } else demand(posted.status === "draft");
        }
      } else if (learning) demand(frame.url() === input.browserOrigin + learning.coursePath && request.resourceType() === "fetch"
        && closed(posted, ["idempotencyKey"]) && posted.idempotencyKey === input.learning.idempotencyKey);
      else if (paidGrant) {
        const selectedGrant = input.paidGrant ?? input.paidRevoke;
        demand(frame.url() === input.browserOrigin + paidGrant.pagePath && request.resourceType() === "fetch"
          && closed(posted, ["userId", "reason", "expectedCourseRevision", "idempotencyKey", ...(paidRevoke ? ["grantId"] : [])])
          && posted.userId === selectedGrant.userId && (!paidRevoke || posted.grantId === selectedGrant.grantId)
          && posted.expectedCourseRevision === selectedGrant.revision && posted.idempotencyKey === selectedGrant.idempotencyKey
          && approvedGrantReason(posted.reason, selectedGrant.reasonSha256));
        if (paidRevoke) {
          activation = frame.evaluate(() => window.__lashP2qConsumePaidRevoke?.() === true).then(demand);
          activation.catch(fail);
        }
      }
      else if (preferences(target)) demand(closed(posted, ["learningUpdates"]) && posted.learningUpdates === (target.operation === "preferences-on"));
      else demand(closed(posted, ["action", "idempotencyKey"]) && posted.action === target.operation && uuid(posted.idempotencyKey));
    } catch { fail(); }
  };
  const onResponse = response => {
    if (response.request() !== selected) return;
    if (failed || responseStarted) return fail();
    responseStarted = true;
    void Promise.resolve(activation).then(() => readMutationResponse(response, selected, input, pathname, edit?.role, submittedIds)).then(value => {
      if (!failed) { receipt = value; edit?.observeReceipt(); accept(value); }
    }, fail);
  };
  const onFailure = request => { if (request === selected) fail(); };
  const onNavigation = frame => {
    if (frame !== page.mainFrame() || !selected) return;
    if (!responseStarted || frame.url() !== academyUrl) fail();
    else arrived = true;
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onFailure);
  if (learning) page.on("framenavigated", onNavigation);
  return {
    async wait(expires) {
      const remaining = expires * 1000 - Date.now();
      if (failed || remaining <= 0 || remaining > input.windowSeconds * 1000) throw refusal();
      let timer;
      try {
        await Promise.race([observed, new Promise((_, timeout) => { timer = setTimeout(() => timeout(refusal()), remaining); })]);
        if (create) {
          const timeout = expires * 1000 - Date.now();
          if (timeout <= 0) throw refusal();
          const message = input.authoring.kind === "module" ? "Module saved." : "Lesson saved.";
          await page.getByRole("status").getByText(message, { exact: true }).waitFor({ state: "visible", timeout }).catch(() => { throw refusal(); });
          completed = true;
        }
        if (learning) {
          const timeout = () => {
            const remaining = expires * 1000 - Date.now();
            if (failed || remaining <= 0) throw refusal();
            return remaining;
          };
          await page.waitForURL(academyUrl, { waitUntil: "domcontentloaded", timeout: timeout() }).catch(() => { throw refusal(); });
          const overview = page.getByRole("link", { name: "Course overview", exact: true })
            .and(page.locator('a[href="' + learning.coursePath + '"]'));
          await overview.waitFor({ state: "visible", timeout: timeout() }).catch(() => { throw refusal(); });
          if (!arrived || page.url() !== academyUrl) throw refusal();
          completed = true;
        }
        if (paidGrant) {
          const timeout = expires * 1000 - Date.now();
          if (failed || timeout <= 0) throw refusal();
          const feedback = paidRevoke ? "Manual revocation and audit confirmed. Community access has not been verified yet."
            : "Manual grant and audit confirmed. Community access has not been verified yet.";
          await page.getByRole("status").and(page.getByText(feedback, { exact: true }))
            .waitFor({ state: "visible", timeout }).catch(() => { throw refusal(); });
          if (page.url() !== input.browserOrigin + paidGrant.pagePath) throw refusal();
          completed = true;
        }
        if (archive) {
          const timeout = expires * 1000 - Date.now();
          if (failed || timeout <= 0) throw refusal();
          await Promise.all([
            page.getByRole("status").getByText("Course archived. Historical references remain available.", { exact: true }).waitFor({ state: "visible", timeout }),
            page.getByText("archived · Revision " + receipt.body.revision, { exact: true }).waitFor({ state: "visible", timeout }),
            page.getByRole("heading", { name: "Before archiving this paid course", exact: true }).waitFor({ state: "hidden", timeout }),
          ]).catch(() => { throw refusal(); });
          if (page.url() !== input.browserOrigin + p2InteractiveBrowserEntryPath(input, "owner")) throw refusal();
          completed = true;
        }
        if (failed) throw refusal();
      } finally { clearTimeout(timer); }
    },
    finish() {
      if (failed || !receipt || (create || learning || paidGrant || archive) && !completed || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailure);
      if (learning) page.off("framenavigated", onNavigation);
      fail();
    },
  };
}

export function watchP2LifecycleMutation(context, page, input) {
  demand(input.stage === "lifecycle");
  return watchMutation(context, page, input);
}

export function watchP2LearningEnrollment(context, page, input) {
  demand(input.stage === "learning");
  return learningEnrollmentReplay(input.learning) ? watchP2LearningEnrollmentReplay(context, page, input) : watchMutation(context, page, input);
}

export function watchP2PaidGrant(context, page, input) {
  demand(input.stage === "paid-grant");
  return watchMutation(context, page, input);
}

export function watchP2PaidRevoke(context, page, input) {
  demand(input.stage === "paid-revoke");
  return watchMutation(context, page, input);
}

export async function installP2PaidRevokeObserver(page, input) {
  demand(input.stage === "paid-revoke");
  const path = p2InteractiveBrowserEntryPath(input, "owner");
  await page.addInitScript(({ origin, path }) => {
    const atRevoke = () => location.origin === origin && location.pathname === path && !location.search && !location.hash;
    if (window.top !== window || !atRevoke()) return;
    const text = element => element?.textContent?.replace(/\s+/gu, " ").trim();
    let confirmed = false;
    window.addEventListener("submit", event => {
      confirmed = false;
      const form = event.target, button = event.submitter;
      if (!event.isTrusted || !atRevoke() || !(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement)
        || button.form !== form || button.disabled || text(button) !== "Revoke manual access") return;
      const region = form.closest('section, [role="region"]');
      const labelledBy = region?.getAttribute("aria-labelledby"), name = region?.getAttribute("aria-label") ?? text(labelledBy && document.getElementById(labelledBy));
      if (name !== "Revoke manual course access") return;
      const confirmation = [...form.elements].filter(element => element instanceof HTMLInputElement && element.type === "checkbox"
        && [...(element.labels ?? [])].some(label => text(label) === "Confirm grant revocation"));
      confirmed = confirmation.length === 1 && confirmation[0].checked && !confirmation[0].disabled;
    }, { capture: true, passive: true });
    Object.defineProperty(window, "__lashP2qConsumePaidRevoke", { value: () => {
      const accepted = atRevoke() && confirmed;
      confirmed = false;
      return accepted;
    } });
  }, { origin: input.browserOrigin, path });
}

const paidLearnerDenials = {
  course_archived: { heading: "This course is archived", message: "This course is archived." },
  not_found: { heading: "This course is unavailable", message: "This resource is unavailable." },
  access_required: { heading: "Enrollment required", message: "Course access is required." },
  access_revoked: { heading: "Course access has ended", message: "Course access has been revoked." },
};

function paidLearnerCourseModule(body, target) {
  demand(closed(body, ["course"]) && body.course?.id === target.courseId && body.course.accessMode === "paid"
    && body.course.currency === "CAD" && Number.isSafeInteger(body.course.priceCents) && body.course.priceCents > 0
    && Array.isArray(body.course.modules));
  const matching = [];
  for (const courseModule of body.course.modules) {
    demand(uuid(courseModule?.id) && Array.isArray(courseModule.lessons));
    for (const lesson of courseModule.lessons) {
      if (lesson?.id !== target.lessonId) continue;
      demand(lesson.moduleId === courseModule.id && lesson.isPreview === false);
      matching.push(courseModule.id);
    }
  }
  demand(matching.length === 1);
  return matching[0];
}

function validatePaidLearnerQuiz(body, lessonId) {
  demand(closed(body, ["quiz"]) && closed(body.quiz, ["id", "lessonId", "revision", "document"])
    && uuid(body.quiz.id) && body.quiz.lessonId === lessonId && Number.isSafeInteger(body.quiz.revision) && body.quiz.revision >= 1);
  const { document } = body.quiz;
  demand(closed(document, ["version", "mode", "passingPercent", "questions"]) && document.version === 1 && document.mode === "graded"
    && Number.isSafeInteger(document.passingPercent) && document.passingPercent >= 1 && document.passingPercent <= 100
    && Array.isArray(document.questions) && document.questions.length > 0 && document.questions.length <= 100
    && document.questions.every(question => closed(question, ["id", "prompt", "options"]) && typeof question.id === "string"
      && typeof question.prompt === "string" && Array.isArray(question.options) && question.options.length >= 2
      && question.options.every(option => closed(option, ["id", "text"]) && typeof option.id === "string" && typeof option.text === "string")));
}

// Executed only in a Chromium isolated world for the selected main frame.
async function captureInteractiveFetch({ source, target, timeout, maximum, idempotencyKey, flight }) {
  if (location.href !== source) throw new Error("P2_INTERACTIVE_FETCH_FRAME_CHANGED");
  const headers = flight ? { accept: "text/x-component", RSC: "1" } : { accept: "application/json" };
  const post = idempotencyKey !== undefined;
  if (post) Object.assign(headers, { "content-type": "application/json", "x-lash-csrf": "1" });
  const response = await fetch(target, { method: post ? "POST" : "GET", mode: "same-origin", credentials: "same-origin", redirect: "error",
    cache: "no-store", headers, signal: AbortSignal.timeout(timeout), ...(post ? { body: JSON.stringify({ idempotencyKey }) } : {}) });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("P2_INTERACTIVE_FETCH_BODY_MISSING");
  const bytes = new Uint8Array(maximum);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      try {
        if (chunk.value.byteLength > maximum - size) throw new Error("P2_INTERACTIVE_FETCH_BODY_LIMIT");
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      } finally { chunk.value.fill(0); }
    }
    return { body: bytes.subarray(0, size).toBase64(), size, url: response.url, status: response.status, redirected: response.redirected,
      requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control") };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    bytes.fill(0);
    reader.releaseLock();
  }
}

async function isolatedMainFrame(session, source) {
  const { frameTree: { frame } } = await session.send("Page.getFrameTree");
  demand(frame.url === source && frame.securityOrigin === new URL(source).origin && !frame.parentId);
  const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frame.id, grantUniveralAccess: false });
  demand(Number.isSafeInteger(executionContextId) && executionContextId > 0);
  return executionContextId;
}

async function readIsolatedFetch({ session, executionContextId, page, slot, source, status, maximum, timeout, idempotencyKey }) {
  const origin = new URL(source).origin, method = idempotencyKey === undefined ? "GET" : "POST";
  const observed = page.waitForResponse(candidate => candidate.request() === slot.request, { timeout });
  // Chromium can discard its DevTools copy after the renderer drains Fetch.
  // Read the actual stream once and join it to the independent network record.
  const captured = session.send("Runtime.callFunctionOn", { executionContextId, functionDeclaration: captureInteractiveFetch.toString(),
    arguments: [{ value: { source, target: slot.target, timeout, maximum, idempotencyKey } }], awaitPromise: true, returnByValue: true, silent: true })
    .then(({ result, exceptionDetails }) => { demand(!exceptionDetails); return result.value; });
  try {
    const [response, payload] = await Promise.all([observed, captured]);
    demand(closed(payload, ["body", "size", "url", "status", "redirected", "requestId", "contentType", "cacheControl"]));
    const head = await readBrowserResponseHead(response, slot.request, origin, slot.target, method, status);
    const [{ identity, declared }, contentType, cacheControl] = await Promise.all([
      readBrowserResponseBounds(response, slot.request, maximum, true), response.headerValue("content-type"), response.headerValue("cache-control"),
    ]);
    demand(payload.url === response.url() && payload.status === head.status && payload.redirected === false
      && payload.requestId === head.requestId && payload.contentType === contentType && payload.cacheControl === cacheControl
      && Number.isSafeInteger(payload.size) && payload.size > 0 && payload.size <= maximum
      && typeof payload.body === "string" && payload.body.length === 4 * Math.ceil(payload.size / 3)
      && (!identity || declared === undefined || payload.size === declared));
    const bytes = Buffer.from(payload.body, "base64");
    payload.body = "";
    try {
      demand(bytes.byteLength === payload.size);
      return { response, head, body: exactBrowserJson(bytes, maximum) };
    } finally { bytes.fill(0); }
  } finally {
    const payload = await captured.catch(() => undefined);
    if (payload && typeof payload === "object") payload.body = "";
  }
}

function watchP2LearningEnrollmentReplay(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "learning" && learningEnrollmentReplay(input.learning) && page.context() === context);
  const target = input.learning, { coursePath, academyPath, pathname } = p2LearningEnrollmentPaths(target);
  const origin = input.browserOrigin, source = origin + academyPath;
  const refusal = () => new Error("P2_INTERACTIVE_LEARNING_RESPONSE_REFUSED");
  let navigation, slot, receipt, opened = false, ready = false, failed = false;
  const fail = () => { failed = true; };
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method();
    try {
      if (request.isNavigationRequest()) {
        demand(opened && !navigation && request.url() === source && method === "GET"
          && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        navigation = request;
      } else if (url?.origin === origin) {
        if (!url.pathname.startsWith("/api/")) { demand(["GET", "HEAD", "OPTIONS"].includes(method)); return; }
        demand(slot && !slot.request && request.url() === origin + pathname && method === "POST"
          && request.frame() === page.mainFrame() && request.frame().url() === source && request.resourceType() === "fetch"
          && request.redirectedFrom() === null);
        slot.request = request;
        const recorded = request.postDataBuffer(), bytes = recorded && Buffer.from(recorded);
        try {
          const body = exactBrowserJson(bytes);
          demand(closed(body, ["idempotencyKey"]) && body.idempotencyKey === target.idempotencyKey);
        } finally { bytes?.fill(0); }
      }
    } catch { fail(); }
  };
  const onFailure = request => { if (request === navigation || request === slot?.request) fail(); };
  const onNavigation = frame => { if (frame === page.mainFrame() && navigation && frame.url() !== source) fail(); };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  page.on("framenavigated", onNavigation);

  const verifyPage = async expires => {
    demand(page.url() === source);
    const overview = page.getByRole("link", { name: "Course overview", exact: true }).and(page.locator(`a[href="${coursePath}"]`));
    await overview.waitFor({ state: "visible", timeout: remaining(expires) });
    demand(page.url() === source && remaining(expires) > 0);
  };

  return {
    async open(expires) {
      try {
        demand(!opened);
        opened = true;
        const response = await page.goto(source, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) });
        demand(navigation && response?.request() === navigation && response.status() === 200 && response.url() === source
          && !response.fromServiceWorker() && navigation.redirectedTo() === null);
        await verifyPage(expires);
        ready = true;
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      let session;
      try {
        demand(ready && !slot);
        await verifyPage(expires);
        session = await context.newCDPSession(page);
        const executionContextId = await isolatedMainFrame(session, source);
        const timeout = Math.min(8000, remaining(expires));
        slot = { target: pathname };
        const { head, body } = await readIsolatedFetch({ session, executionContextId, page, slot, source, status: 200,
          maximum: maxLifecycleBody, timeout, idempotencyKey: target.idempotencyKey });
        const [requestOrigin, fetchSite, contentType, csrf] = await Promise.all(["origin", "sec-fetch-site", "content-type", "x-lash-csrf"]
          .map(name => slot.request.headerValue(name)));
        demand(requestOrigin === origin && (fetchSite === null || fetchSite === "same-origin")
          && contentType === "application/json" && csrf === "1" && !slot.request.failure());
        await verifyPage(expires);
        receipt = validateP2LearningEnrollmentReceipt({ ...head, academyPath, body }, target);
      } catch {
        fail();
        throw refusal();
      } finally { await session?.detach().catch(() => {}); }
    },
    finish() {
      if (failed || !receipt || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      page.off("framenavigated", onNavigation);
      fail();
    },
  };
}

export function watchP2PaidLearnerAccess(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "learner-access" && page.context() === context);
  const target = input.learnerAccess, { pagePath, lessonPath, targets } = p2PaidLearnerAccessPaths(target);
  const origin = input.browserOrigin, source = origin + pagePath, expected = paidLearnerAccessOutcomes[target.outcome], allowed = target.outcome === "allowed";
  const refusal = () => new Error("P2_INTERACTIVE_LEARNER_ACCESS_RESPONSE_REFUSED");
  let navigation, pageProof, activeRead, receipt, moduleId, failed = false, opened = false, capturing = false;
  const fail = () => { failed = true; };
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method();
    try {
      if (request.isNavigationRequest()) {
        demand(opened && !navigation && request.url() === source && method === "GET"
          && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        navigation = request;
      } else if (url?.origin === origin) {
        demand(["GET", "HEAD", "OPTIONS"].includes(method));
        if (!url.pathname.startsWith("/api/")) return;
        demand(activeRead && !activeRead.request && request.url() === origin + activeRead.target && method === "GET"
          && request.frame() === page.mainFrame() && request.frame().url() === source && request.resourceType() === "fetch"
          && request.redirectedFrom() === null && request.postDataBuffer() === null);
        activeRead.request = request;
      }
    } catch { fail(); }
  };
  const onFailure = request => {
    // Chromium can abort bookkeeping for a selected GET after native Fetch has
    // read EOF. Only that GET can still qualify, and only after full validation.
    if (request === navigation || request === activeRead?.request && request.failure()?.errorText !== "net::ERR_ABORTED") fail();
  };
  const onNavigation = frame => { if (frame === page.mainFrame() && navigation && frame.url() !== source) fail(); };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  page.on("framenavigated", onNavigation);

  const verifyPage = async expires => {
    demand(page.url() === source);
    const selectedLink = page.getByRole("link").and(page.locator(`a[href="${lessonPath}"]`));
    if (allowed) {
      await selectedLink.waitFor({ state: "visible", timeout: remaining(expires) });
      return { lessonLink: true, code: null };
    }
    const heading = page.getByRole("heading", { level: 1, name: new RegExp("^(?:" + expected.codes.map(code => paidLearnerDenials[code].heading).join("|") + ")$", "u") });
    await heading.waitFor({ state: "visible", timeout: remaining(expires) });
    const name = (await heading.textContent({ timeout: remaining(expires) }))?.trim();
    const code = expected.codes.find(code => paidLearnerDenials[code].heading === name);
    demand(code && await page.locator(`a[href^="${pagePath}/lessons/"]`).count() === 0);
    return { lessonLink: false, code };
  };

  const read = async (session, executionContextId, path, index, expires) => {
    const slot = activeRead = { target: path }, maximum = allowed ? maxAuthoringBody : maxLifecycleBody;
    const timeout = Math.min(8000, remaining(expires));
    try {
      const { response, head, body } = await readIsolatedFetch({ session, executionContextId, page, slot, source,
        status: expected.status, maximum, timeout });
      let code = null;
      if (!allowed) {
        demand(closed(body, ["error", "requestId"]) && body.requestId === head.requestId && closed(body.error, ["code", "message"])
          && expected.codes.includes(body.error.code) && body.error.message === paidLearnerDenials[body.error.code].message);
        code = body.error.code;
        if (index === 0) demand(code === pageProof.code);
      } else if (index === 0) moduleId = paidLearnerCourseModule(body, target);
      else if (index === 1) demand(closed(body, ["lesson"]) && body.lesson?.id === target.lessonId
        && body.lesson.moduleId === moduleId && body.lesson.isPreview === false);
      else if (index === 2) {
        const dates = await response.headerValues("date");
        demand(dates.length === 1);
        parseP2PlaybackObservation(head.status, { "cache-control": "private, no-store", date: dates[0] }, body, true);
        const originTime = Date.parse(dates[0]), latest = Math.max(Date.parse(body.expiresAt), Date.parse(body.thumbnailExpiresAt));
        demand(body.thumbnailToken.length > 20 && latest - originTime <= 601_000);
      } else if (index === 3) demand(closed(body, ["progress"]) && Array.isArray(body.progress) && body.progress.length <= 1
        && body.progress.every(row => uuid(row?.id) && row.userId === target.actorId && row.lessonId === target.lessonId
          && (row.enrollmentId === null || uuid(row.enrollmentId))));
      else if (index === 4) validatePaidLearnerQuiz(body, target.lessonId);
      else demand(closed(body, ["attempts"]) && Array.isArray(body.attempts) && body.attempts.length <= 50
        && body.attempts.every(row => uuid(row?.id) && row.lessonId === target.lessonId && uuid(row.quizRevisionId)));
      const failure = slot.request.failure();
      demand(!failure || failure.errorText === "net::ERR_ABORTED");
      remaining(expires);
      return { target: path, status: head.status, requestId: head.requestId, code };
    } finally { activeRead = undefined; }
  };

  return {
    async open(expires) {
      try {
        demand(!opened);
        opened = true;
        const response = await page.goto(source, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) });
        demand(navigation && response?.request() === navigation && response.status() === 200 && response.url() === source
          && !response.fromServiceWorker() && navigation.redirectedTo() === null);
        pageProof = await verifyPage(expires);
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      let session;
      try {
        demand(pageProof && !capturing);
        capturing = true;
        session = await context.newCDPSession(page);
        const executionContextId = await isolatedMainFrame(session, source);
        const reads = [];
        for (const [index, path] of targets.entries()) reads.push(await read(session, executionContextId, path, index, expires));
        const final = await verifyPage(expires);
        demand(final.lessonLink === pageProof.lessonLink && final.code === pageProof.code);
        receipt = validateP2PaidLearnerAccessReceipt({ page: { pathname: pagePath, status: 200, lessonLink: pageProof.lessonLink }, reads,
          body: { courseId: target.courseId, lessonId: target.lessonId, outcome: target.outcome } }, target);
      } catch {
        fail();
        throw refusal();
      } finally { await session?.detach().catch(() => {}); }
    },
    finish() {
      if (failed || !receipt || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      page.off("framenavigated", onNavigation);
      fail();
    },
  };
}

const deniedLessonHeading = "Enrollment required";
const deniedLessonDescription = "Open the course page to enroll or check your access.";
const privateLessonMarkup = /\b(?:mux-player|stream\.mux\.com|image\.mux\.com|lesson-outline-title|initialProgress|quizState|contentDocument|playbackToken|thumbnailToken|completedQuizRevision|resumePositionSeconds|maxPositionSeconds|correctOptionId)\b|p2q-s07-private-(?:content|transcript|quiz)/iu;

function uniqueDenialReference(markup, pattern) {
  const references = Array.from(markup.matchAll(pattern));
  demand(references.length === 1 && uuid(references[0][1]));
  return references[0][1];
}

function deniedLessonDocumentReference(markup) {
  const sections = Array.from(markup.matchAll(/<section\b[^>]*\baria-labelledby="learning-unavailable-title"[^>]*>([\s\S]*?)<\/section>/gu));
  demand(sections.length === 1 && !privateLessonMarkup.test(markup));
  const section = sections[0][1];
  demand(/<h1\b[^>]*\bid="learning-unavailable-title"[^>]*>Enrollment required<\/h1>/u.test(section)
    && section.includes(deniedLessonDescription));
  return uniqueDenialReference(section, /<p\b[^>]*>Reference: (?:<!-- -->)?([^<\s]+)<\/p>/gu);
}

function deniedLessonFlightReference(markup) {
  const models = markup.split("\n").filter(row => /^[a-f0-9]+:/u.test(row) && row.includes('"aria-labelledby":"learning-unavailable-title"'));
  demand(models.length === 1 && !privateLessonMarkup.test(markup));
  const model = models[0], nodes = [JSON.parse(model.slice(model.indexOf(":") + 1))], sections = [];
  const props = (node, tag) => Array.isArray(node) && node[0] === "$" && node[1] === tag ? node[3] : undefined;
  while (nodes.length) {
    const node = nodes.pop();
    if (props(node, "section")?.["aria-labelledby"] === "learning-unavailable-title") sections.push(node[3]);
    if (node && typeof node === "object") for (const child of Object.values(node)) nodes.push(child);
  }
  const children = sections[0]?.children;
  demand(sections.length === 1 && Array.isArray(children));
  const headings = children.map(node => props(node, "h1")).filter(Boolean);
  const paragraphs = children.map(node => props(node, "p")?.children);
  const references = paragraphs.filter(text => Array.isArray(text) && text[0] === "Reference: ");
  demand(headings.length === 1 && headings[0].id === "learning-unavailable-title" && headings[0].children === deniedLessonHeading
    && paragraphs.includes(deniedLessonDescription) && references.length === 1 && references[0].length === 2 && uuid(references[0][1]));
  return references[0][1];
}

function watchDeniedLessonDocument(session, frameId, source, timeout) {
  const maximum = maxAuthoringBody;
  let requestId, settle, reject;
  const result = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
  result.catch(() => {});
  const refuse = () => reject(new Error("P2_INTERACTIVE_LESSON_DOCUMENT_REFUSED"));
  const timer = setTimeout(refuse, timeout);
  const onResponse = ({ requestId: id, frameId: frame, type, response }) => {
    if (frame !== frameId || type !== "Document") return;
    if (requestId || response.url !== source || response.status !== 200
      || response.fromServiceWorker || response.fromDiskCache || response.fromPrefetchCache) return refuse();
    requestId = id;
  };
  const onFinished = ({ requestId: id }) => {
    if (id !== requestId) return;
    void session.send("Network.getResponseBody", { requestId }).then(payload => {
      const { body, base64Encoded } = payload;
      payload.body = "";
      demand(typeof body === "string" && body.length <= (base64Encoded ? 4 * Math.ceil(maximum / 3) : maximum));
      const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
      try {
        demand(bytes.length > 0 && bytes.length <= maximum);
        settle(deniedLessonDocumentReference(bytes.toString("utf8")));
      } finally { bytes.fill(0); }
    }).catch(refuse);
  };
  const onFailed = ({ requestId: id }) => { if (id === requestId) refuse(); };
  session.on("Network.responseReceived", onResponse);
  session.on("Network.loadingFinished", onFinished);
  session.on("Network.loadingFailed", onFailed);
  return { result, close() {
    clearTimeout(timer);
    session.off("Network.responseReceived", onResponse);
    session.off("Network.loadingFinished", onFinished);
    session.off("Network.loadingFailed", onFailed);
  } };
}

async function readDeniedLessonFlight({ session, executionContextId, page, slot, source, timeout }) {
  const observed = page.waitForResponse(candidate => candidate.request() === slot.request, { timeout });
  const maximum = maxAuthoringBody;
  const captured = session.send("Runtime.callFunctionOn", { executionContextId, functionDeclaration: captureInteractiveFetch.toString(),
    arguments: [{ value: { source, target: slot.target, timeout, maximum, flight: true } }], awaitPromise: true, returnByValue: true, silent: true })
    .then(({ result, exceptionDetails }) => { demand(!exceptionDetails); return result.value; });
  try {
    const [response, payload] = await Promise.all([observed, captured]);
    const [types, cache, vary] = await Promise.all(["content-type", "cache-control", "vary"].map(name => response.headerValues(name)));
    demand(response.url() === new URL(slot.target, source).href && response.status() === 200 && !response.fromServiceWorker()
      && slot.request.redirectedTo() === null && types.length === 1 && /^text\/x-component(?:;.*)?$/iu.test(types[0])
      && cache.length === 1 && privateNoStore({ "cache-control": cache[0] })
      && vary.some(value => /(?:^|,)\s*rsc\s*(?:,|$)/iu.test(value))
      && payload?.url === response.url() && payload.status === 200 && payload.redirected === false
      && payload.contentType === types[0] && payload.cacheControl === cache[0]
      && Number.isSafeInteger(payload.size) && payload.size > 0 && payload.size <= maximum
      && typeof payload.body === "string" && payload.body.length === 4 * Math.ceil(payload.size / 3));
    const bytes = Buffer.from(payload.body, "base64");
    try {
      demand(bytes.byteLength === payload.size);
      return deniedLessonFlightReference(bytes.toString("utf8"));
    } finally { bytes.fill(0); }
  } finally {
    const payload = await captured.catch(() => undefined);
    if (payload && typeof payload === "object") payload.body = "";
  }
}

export function watchP2LessonDenial(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "lesson-denial" && page.context() === context);
  const target = input.lessonDenial, { lessonPath, flightPath, targets } = p2LessonDenialPaths(target);
  const origin = input.browserOrigin, source = origin + lessonPath;
  const refusal = () => new Error("P2_INTERACTIVE_LESSON_DENIAL_RESPONSE_REFUSED");
  let navigation, documentRequestId, activeRead, receipt, opened = false, capturing = false, failed = false;
  const fail = () => { failed = true; };
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method(), headers = request.headers();
    try {
      demand(["GET", "HEAD", "OPTIONS"].includes(method) && request.resourceType() !== "media"
        && !/(?:^|\.)mux\.com$/iu.test(url?.hostname ?? ""));
      if (request.isNavigationRequest()) {
        demand(opened && !navigation && request.url() === source && method === "GET" && headers.rsc === undefined
          && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        navigation = request;
      } else if (url?.origin === origin) {
        const selectedSurface = url.pathname.startsWith("/api/")
          || url.pathname.startsWith("/academy/courses/") && url.pathname.includes("/lessons/");
        if (!selectedSurface) return;
        const flight = activeRead?.target === flightPath;
        demand(activeRead && !activeRead.request && request.url() === origin + activeRead.target && method === "GET"
          && request.frame() === page.mainFrame() && request.frame().url() === source && request.resourceType() === "fetch"
          && request.redirectedFrom() === null && request.postDataBuffer() === null
          && headers.rsc === (flight ? "1" : undefined)
          && ["next-router-prefetch", "next-router-segment-prefetch", "next-router-state-tree", "next-url"].every(name => headers[name] === undefined));
        activeRead.request = request;
      }
    } catch { fail(); }
  };
  const onFailure = request => {
    if (request === navigation || request === activeRead?.request && request.failure()?.errorText !== "net::ERR_ABORTED") fail();
  };
  const onNavigation = frame => { if (frame === page.mainFrame() && navigation && frame.url() !== source) fail(); };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  page.on("framenavigated", onNavigation);

  const verifyPage = async expires => {
    const main = page.locator("main");
    const denial = main.locator('section[aria-labelledby="learning-unavailable-title"]');
    await denial.getByRole("heading", { level: 1, name: deniedLessonHeading, exact: true })
      .waitFor({ state: "visible", timeout: remaining(expires) });
    demand(page.url() === source && await main.getByRole("heading", { level: 1 }).count() === 1
      && await denial.getByText(deniedLessonDescription, { exact: true }).isVisible()
      && await denial.getByText("Reference: " + documentRequestId, { exact: true }).isVisible()
      && (await denial.locator("p").allTextContents()).filter(text => text.startsWith("Reference: ")).length === 1
      && await main.locator('article, video, audio, mux-player, form, [aria-label="Lesson navigation"], [aria-label="Course lessons"]').count() === 0
      && await page.locator("main, script:not([src])").evaluateAll((nodes, source) => {
        const privateMarkup = new RegExp(source, "iu");
        return nodes.every(node => !privateMarkup.test(node.innerHTML));
      }, privateLessonMarkup.source));
    remaining(expires);
  };

  return {
    async open(expires) {
      let session, document;
      try {
        demand(!opened);
        opened = true;
        session = await context.newCDPSession(page);
        const { frameTree: { frame } } = await session.send("Page.getFrameTree");
        demand(!frame.parentId);
        const buffers = { maxTotalBufferSize: 4 * maxAuthoringBody, maxResourceBufferSize: maxAuthoringBody };
        await session.send("Network.configureDurableMessages", buffers);
        await session.send("Network.enable", { ...buffers, maxPostDataSize: 0 });
        const timeout = Math.min(30_000, remaining(expires));
        document = watchDeniedLessonDocument(session, frame.id, source, timeout);
        const [response, rawReference] = await Promise.all([page.goto(source, { waitUntil: "domcontentloaded", timeout }), document.result]);
        demand(navigation && response?.request() === navigation && response.url() === source && response.status() === 200
          && !response.fromServiceWorker() && navigation.redirectedTo() === null);
        const [types, cache] = await Promise.all(["content-type", "cache-control"].map(name => response.headerValues(name)));
        demand(types.length === 1 && /^text\/html(?:;.*)?$/iu.test(types[0]) && cache.length === 1
          && privateNoStore({ "cache-control": cache[0] }));
        documentRequestId = rawReference;
        await verifyPage(expires);
      } catch { fail(); throw refusal(); }
      finally { document?.close(); await session?.detach().catch(() => {}); }
    },
    async wait(expires) {
      let session;
      try {
        demand(documentRequestId && !capturing);
        capturing = true;
        session = await context.newCDPSession(page);
        const executionContextId = await isolatedMainFrame(session, source);
        activeRead = { target: flightPath };
        const flightRequestId = await readDeniedLessonFlight({ session, executionContextId, page, slot: activeRead, source,
          timeout: Math.min(8000, remaining(expires)) });
        demand(flightRequestId !== documentRequestId);
        const reads = [];
        for (const path of targets) {
          activeRead = { target: path };
          const { head, body } = await readIsolatedFetch({ session, executionContextId, page, slot: activeRead, source,
            status: 403, maximum: maxLifecycleBody, timeout: Math.min(8000, remaining(expires)) });
          const failure = activeRead.request.failure();
          demand((!failure || failure.errorText === "net::ERR_ABORTED")
            && closed(body, ["error", "requestId"]) && body.requestId === head.requestId && closed(body.error, ["code", "message"])
            && body.error.code === "access_required" && body.error.message === paidLearnerDenials.access_required.message);
          reads.push({ target: path, status: head.status, requestId: head.requestId, code: body.error.code });
        }
        await verifyPage(expires);
        receipt = validateP2LessonDenialReceipt({ page: { pathname: lessonPath, documentStatus: 200, flightStatus: 200,
          documentRequestId, flightRequestId }, reads }, target);
      } catch { fail(); throw refusal(); }
      finally { activeRead = undefined; await session?.detach().catch(() => {}); }
    },
    finish() {
      if (failed || !receipt || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      page.off("framenavigated", onNavigation);
      fail();
    },
  };
}

function watchLessonNetworkBodies(session, frameId, slots, origin, fail) {
  const byRequest = new Map();
  for (const slot of [...slots.values()].flat()) {
    slot.native = new Promise((resolve, reject) => { slot.resolve = resolve; slot.reject = reject; });
    slot.native.catch(() => {});
  }
  const onResponse = ({ requestId, frameId: actualFrame, type, response }) => {
    const url = URL.parse(response.url), group = url?.origin === origin && slots.get(url.pathname + url.search);
    if (!group) return;
    const slot = Array.isArray(group) ? group.find(row => !row.cdpId) : group;
    if (!slot || slot.cdpId || actualFrame !== frameId || type !== "Fetch" || response.status !== (slot.status ?? 200) ||
      response.fromServiceWorker || response.fromDiskCache || response.fromPrefetchCache) return fail();
    slot.cdpId = requestId;
    const ids = Object.entries(response.headers).filter(([name]) => name.toLowerCase() === "x-request-id");
    if (ids.length !== 1 || !uuid(ids[0][1])) return fail();
    slot.gatewayId = ids[0][1];
    byRequest.set(requestId, slot);
  };
  const onFinished = ({ requestId }) => {
    const slot = byRequest.get(requestId);
    if (!slot) return;
    byRequest.delete(requestId);
    void session.send("Network.getResponseBody", { requestId }).then(result => {
      const { body, base64Encoded } = result;
      result.body = "";
      const maximum = slot.maximum ?? maxLifecycleBody;
      demand(typeof body === "string" && body.length <= (base64Encoded ? 4 * Math.ceil(maximum / 3) : maximum));
      const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
      try { slot.resolve({ body: exactBrowserJson(bytes, maximum), size: bytes.length }); }
      finally { bytes.fill(0); }
    }).catch(error => slot.reject(error));
  };
  const onFailed = ({ requestId }) => {
    const slot = byRequest.get(requestId);
    if (slot) { byRequest.delete(requestId); slot.reject(new Error("P2_INTERACTIVE_LESSON_NETWORK_REFUSED")); }
  };
  session.on("Network.responseReceived", onResponse);
  session.on("Network.loadingFinished", onFinished);
  session.on("Network.loadingFailed", onFailed);
  return () => {
    session.off("Network.responseReceived", onResponse);
    session.off("Network.loadingFinished", onFinished);
    session.off("Network.loadingFailed", onFailed);
    byRequest.clear();
  };
}

export function watchP2LessonEntry(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "lesson-entry" && page.context() === context);
  const target = input.lessonEntry, { academyPath, lessonPath, playbackPath, progressPath } = p2LessonEntryPaths(target);
  const origin = input.browserOrigin, source = origin + academyPath, destination = origin + lessonPath;
  const playback = { method: "GET" }, progress = { method: "POST" }, flight = {};
  const slots = new Map([[playbackPath, playback], [progressPath, progress]]);
  const refusal = () => new Error("P2_INTERACTIVE_LESSON_ENTRY_RESPONSE_REFUSED");
  let navigation, title, receipt, opened = false, clicked = false, failed = false;
  const fail = () => { failed = true; };
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const selectedLink = () => page.getByRole("link").and(page.locator(`a[href="${lessonPath}"]`));
  const prefetch = headers => headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined
    || /\bprefetch\b/iu.test([headers.purpose, headers["sec-purpose"]].join(" "));
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method();
    try {
      if (request.isNavigationRequest()) {
        demand(opened && !navigation && request.url() === source && method === "GET" && request.frame() === page.mainFrame()
          && request.redirectedFrom() === null);
        navigation = request;
      } else if (url?.origin === origin) {
        const headers = request.headers();
        if (url.pathname === lessonPath) {
          demand(clicked && !flight.request && url.pathname === lessonPath && method === "GET" && request.resourceType() === "fetch"
            && headers.rsc === "1" && !prefetch(headers) && request.frame() === page.mainFrame() && request.redirectedFrom() === null
            && !url.hash && (url.searchParams.size === 0 || url.searchParams.size === 1 && /^[A-Za-z0-9_-]{1,128}$/u.test(url.searchParams.get("_rsc") ?? ""))
            && request.postDataBuffer() === null);
          flight.request = request;
        } else if (url.pathname.startsWith("/api/")) {
          const slot = slots.get(url.pathname);
          demand(clicked && flight.request && slot && !slot.request && !url.search && !url.hash && method === slot.method
            && request.frame() === page.mainFrame() && request.frame().url() === destination && request.resourceType() === "fetch" && request.redirectedFrom() === null);
          slot.request = request;
          const recorded = request.postDataBuffer();
          if (slot === playback) demand(recorded === null);
          else {
            const bytes = recorded && Buffer.from(recorded);
            try {
              const body = exactBrowserJson(bytes);
              demand(closed(body, ["event", "expectedProgressRevision"]) && body.event === "lesson_started" && body.expectedProgressRevision === 0
                && bytes.toString("utf8") === '{"event":"lesson_started","expectedProgressRevision":0}');
            } finally { bytes?.fill(0); }
          }
        } else if (prefetch(headers)) {
          demand((method === "GET" || method === "HEAD") && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        } else demand(headers.rsc === undefined && ["GET", "HEAD", "OPTIONS"].includes(method));
      }
    } catch { fail(); }
  };
  const onFailure = request => {
    if ([navigation, flight.request, playback.request, progress.request].includes(request)) fail();
  };
  const onNavigation = frame => {
    if (frame === page.mainFrame() && navigation && frame.url() !== source && (!clicked || !flight.request || frame.url() !== destination)) fail();
  };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  page.on("framenavigated", onNavigation);

  const apiRead = async (slot, path, expires) => {
    const response = await page.waitForResponse(candidate => candidate.request() === slot.request, { timeout: remaining(expires) });
    const head = await readBrowserResponseHead(response, slot.request, origin, path, slot.method, 200);
    const [{ identity, declared }, native] = await Promise.all([readBrowserResponseBounds(response, slot.request, maxLifecycleBody, true), slot.native]);
    demand(slot.gatewayId === head.requestId && (!identity || declared === undefined || native.size === declared) && !slot.request.failure());
    return { response, head, body: native.body };
  };

  return {
    async open(expires) {
      try {
        demand(!opened);
        opened = true;
        const response = await page.goto(source, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) });
        demand(navigation && response?.request() === navigation && response.status() === 200 && response.url() === source
          && !response.fromServiceWorker() && navigation.redirectedTo() === null && page.url() === source);
        const [types, cache] = await Promise.all([response.headerValues("content-type"), response.headerValues("cache-control")]);
        demand(types.length === 1 && /^text\/html(?:;.*)?$/iu.test(types[0]) && cache.length === 1 && privateNoStore({ "cache-control": cache[0] }));
        const link = selectedLink();
        await link.waitFor({ state: "visible", timeout: remaining(expires) });
        title = (await link.locator("span").first().textContent({ timeout: remaining(expires) }))?.trim();
        demand(title && remaining(expires) > 0);
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      let session, stopNetwork, timer;
      try {
        demand(title && !clicked && page.url() === source);
        session = await context.newCDPSession(page);
        const { frameTree: { frame } } = await session.send("Page.getFrameTree");
        demand(frame.url === source && frame.securityOrigin === origin && !frame.parentId);
        const buffers = { maxTotalBufferSize: 256 * 1024, maxResourceBufferSize: 8192 };
        await session.send("Network.configureDurableMessages", buffers);
        await session.send("Network.enable", { ...buffers, maxPostDataSize: 0 });
        stopNetwork = watchLessonNetworkBodies(session, frame.id, slots, origin, fail);
        const observed = Promise.all([
          page.waitForResponse(candidate => candidate.request() === flight.request, { timeout: remaining(expires) }),
          apiRead(playback, playbackPath, expires), apiRead(progress, progressPath, expires),
        ]);
        observed.catch(() => {});
        clicked = true;
        await selectedLink().click({ timeout: remaining(expires) });
        const [flightResponse, media, saved] = await Promise.race([observed,
          new Promise((_, reject) => { timer = setTimeout(() => reject(refusal()), remaining(expires)); })]);
        const [flightTypes, flightCache, flightVary] = await Promise.all([flightResponse.headerValues("content-type"),
          flightResponse.headerValues("cache-control"), flightResponse.headerValues("vary")]);
        demand(flightResponse.status() === 200 && flightResponse.url() === flight.request.url() && !flightResponse.fromServiceWorker()
          && flight.request.redirectedTo() === null && flightTypes.length === 1 && /^text\/x-component(?:;.*)?$/iu.test(flightTypes[0])
          && flightCache.length === 1 && privateNoStore({ "cache-control": flightCache[0] })
          && flightVary.some(value => /(?:^|,)\s*rsc\s*(?:,|$)/iu.test(value)));
        const [csrf, requestOrigin, fetchSite, contentType] = await Promise.all(["x-lash-csrf", "origin", "sec-fetch-site", "content-type"]
          .map(name => progress.request.headerValue(name)));
        demand(csrf === "1" && requestOrigin === origin && (fetchSite === null || fetchSite === "same-origin") && contentType === "application/json");
        const dates = await media.response.headerValues("date");
        demand(dates.length === 1);
        const { expiresAt, thumbnailExpiresAt, lifetimeMs } = parseP2PlaybackObservation(media.head.status,
          { "cache-control": "private, no-store", date: dates[0] }, media.body, true);
        demand(media.body.thumbnailToken.length > 20 && Math.max(Date.parse(expiresAt), Date.parse(thumbnailExpiresAt)) - Date.parse(dates[0]) <= 601_000);
        const row = saved.body?.progress;
        demand(closed(saved.body, ["progress"]) && closed(row, ["id", "userId", "lessonId", "enrollmentId", "maxPositionSeconds", "resumePositionSeconds",
          "revision", "completedQuizRevision", "completedAt", "lastWatchedAt", "createdAt", "updatedAt"])
          && row.userId === target.actorId && row.lessonId === target.lessonId && row.maxPositionSeconds === 0 && row.resumePositionSeconds === 0
          && row.completedQuizRevision === null && row.completedAt === null);
        await page.waitForURL(destination, { timeout: remaining(expires) });
        const player = page.locator("mux-player");
        await Promise.all([page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor({ state: "visible", timeout: remaining(expires) }),
          page.getByText("Progress saved to your account.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) }),
          player.waitFor({ state: "attached", timeout: remaining(expires) })]);
        demand(page.url() === destination && await player.count() === 1 && remaining(expires) > 0);
        receipt = validateP2LessonEntryReceipt({ page: { pathname: lessonPath, flight: true },
          playback: { requestId: media.head.requestId, expiresAt, thumbnailExpiresAt, lifetimeMs },
          progress: { requestId: saved.head.requestId, progressId: row.id, enrollmentId: row.enrollmentId, revision: row.revision } }, target);
      } catch { fail(); throw refusal(); }
      finally { clearTimeout(timer); stopNetwork?.(); await session?.detach().catch(() => {}); }
    },
    finish() {
      if (failed || !receipt || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      page.off("framenavigated", onNavigation);
      fail();
    },
  };
}

function assessmentProgress(body, target, revision, completion, quizRevision) {
  const row = revision === 1 ? body?.progress : body?.progress?.[0];
  demand(closed(body, ["progress"]) && (revision === 1 || Array.isArray(body.progress) && body.progress.length === 1)
    && closed(row, ["id", "userId", "lessonId", "enrollmentId", "maxPositionSeconds", "resumePositionSeconds",
      "revision", "completedQuizRevision", "completedAt", "lastWatchedAt", "createdAt", "updatedAt"])
    && uuid(row.id) && uuid(row.enrollmentId) && row.userId === target.actorId && row.lessonId === target.lessonId
    && row.maxPositionSeconds === 0 && row.resumePositionSeconds === 0 && row.revision === revision
    && row.completedAt === completion && row.completedQuizRevision === quizRevision);
  return { progressId: row.id, enrollmentId: row.enrollmentId, revision: row.revision,
    completedAt: row.completedAt, completedQuizRevision: row.completedQuizRevision };
}

function assessmentResult(body, target, answers, quizRevisionId, passing) {
  const attempt = body?.attempt;
  const sorted = [...answers].sort((a, b) => a.questionId < b.questionId ? -1 : 1);
  demand(closed(body, ["attempt"]) && closed(attempt, ["id", "lessonId", "quizRevisionId", "quizRevision", "mode", "passingPercent",
    "answers", "correctCount", "totalCount", "passed", "completed", "createdAt", "results"])
    && uuid(attempt.id) && attempt.lessonId === target.lessonId && attempt.quizRevisionId === quizRevisionId
    && attempt.quizRevision === target.quizRevision && attempt.mode === "graded" && sameAssessmentAnswers(attempt.answers, sorted)
    && attempt.passed === passing && attempt.completed === passing && assessmentInstant(attempt.createdAt)
    && Number.isSafeInteger(attempt.passingPercent) && attempt.passingPercent >= 1 && attempt.passingPercent <= 100
    && Number.isSafeInteger(attempt.correctCount) && attempt.correctCount >= 0 && attempt.correctCount <= answers.length
    && attempt.totalCount === answers.length && (attempt.correctCount * 100 >= attempt.passingPercent * attempt.totalCount) === passing
    && Array.isArray(attempt.results) && attempt.results.length === answers.length && attempt.results.every((result, index) =>
      closed(result, ["questionId", "selectedOptionId", "correctOptionId", "correct", "feedback"])
      && result.questionId === answers[index].questionId && result.selectedOptionId === answers[index].optionId
      && assessmentKey(result.correctOptionId) && result.correct === (result.selectedOptionId === result.correctOptionId)
      && typeof result.feedback === "string" && result.feedback.length <= 8000)
    && attempt.results.filter(result => result.correct).length === attempt.correctCount);
  return { attemptId: attempt.id, quizRevisionId: attempt.quizRevisionId, quizRevision: attempt.quizRevision,
    correctCount: attempt.correctCount, totalCount: attempt.totalCount, passed: attempt.passed, completed: attempt.completed, createdAt: attempt.createdAt };
}

export function watchP2LessonAssessment(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "lesson-assessment" && page.context() === context);
  const target = input.assessment, { lessonPath, playbackPath, progressPath, latestPath, attemptsPath } = p2LessonAssessmentPaths(target);
  const origin = input.browserOrigin, source = origin + lessonPath, maximum = 8 * 1024 * 1024;
  const playback = { path: playbackPath, method: "GET", status: 404 };
  const started = { path: progressPath, method: "POST", status: 200 };
  const pairs = [target.failAnswers, target.passAnswers].map(answers => ({
    attempt: { path: attemptsPath, method: "POST", status: 200, maximum, answers },
    latest: { path: latestPath, method: "GET", status: 200 },
  }));
  const slots = new Map([[playbackPath, playback], [progressPath, started],
    [attemptsPath, pairs.map(pair => pair.attempt)], [latestPath, pairs.map(pair => pair.latest)]]);
  const refusal = () => new Error("P2_INTERACTIVE_LESSON_ASSESSMENT_RESPONSE_REFUSED");
  const assessment = () => page.getByRole("main").getByRole("region", { name: "Check your understanding", exact: true });
  let navigation, opened = false, failed = false, initialized, completed, active, session, stopNetwork;
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const fail = () => { if (!failed) { failed = true; rejectFailure(refusal()); } };
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method(), headers = request.headers();
    try {
      demand(request.resourceType() !== "media" && !/(?:^|\.)mux\.com$/iu.test(url?.hostname ?? ""));
      if (request.isNavigationRequest()) {
        demand(opened && !navigation && request.url() === source && method === "GET" && headers.rsc === undefined
          && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        navigation = request;
        return;
      }
      if (url?.origin === origin && url.pathname.startsWith("/api/")) {
        const slot = active?.find(candidate => candidate.path === url.pathname + url.search);
        demand(slot && !slot.request && !url.hash && method === slot.method && request.frame() === page.mainFrame()
          && request.frame().url() === source && request.resourceType() === "fetch" && request.redirectedFrom() === null
          && headers.rsc === undefined);
        if (slot.path === latestPath) demand(active[0].request);
        const recorded = request.postDataBuffer();
        if (method === "GET") demand(recorded === null);
        else {
          const bytes = recorded && Buffer.from(recorded);
          try {
            const body = exactBrowserJson(bytes, 65_536);
            if (slot === started) demand(bytes.toString("utf8") === '{"event":"lesson_started","expectedProgressRevision":0}');
            else {
              demand(closed(body, ["quizRevision", "requestId", "answers"]) && body.quizRevision === target.quizRevision
                && assessmentRequestId(body.requestId) && sameAssessmentAnswers(body.answers, slot.answers)
                && bytes.toString("utf8") === JSON.stringify({ quizRevision: target.quizRevision, requestId: body.requestId,
                  answers: slot.answers.map(({ questionId, optionId }) => ({ questionId, optionId })) })
                && !pairs.some(({ attempt }) => attempt.payloadRequestId === body.requestId));
              slot.payloadRequestId = body.requestId;
            }
          } finally { bytes?.fill(0); }
        }
        slot.request = request;
        return;
      }
      demand(["GET", "HEAD", "OPTIONS"].includes(method));
      if (url?.origin === origin && headers.rsc !== undefined) {
        demand(!url.pathname.startsWith("/academy/courses/") && (headers["next-router-prefetch"] !== undefined
          || headers["next-router-segment-prefetch"] !== undefined) && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
      }
    } catch { fail(); }
  };
  const onFailure = request => { if (request === navigation || active?.some(slot => slot.request === request)) fail(); };
  const onNavigation = frame => { if (frame === page.mainFrame() && navigation && frame.url() !== source) fail(); };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  page.on("framenavigated", onNavigation);

  const observe = async (slot, expires) => {
    const response = await page.waitForResponse(candidate => candidate.request() === slot.request, { timeout: remaining(expires) });
    const [head, bounds, native] = await Promise.all([readBrowserResponseHead(response, slot.request, origin, slot.path, slot.method, slot.status),
      readBrowserResponseBounds(response, slot.request, slot.maximum ?? maxLifecycleBody, true), slot.native]);
    demand(slot.gatewayId === head.requestId && (!bounds.identity || bounds.declared === undefined || native.size === bounds.declared)
      && !slot.request.failure());
    if (slot.method === "POST") {
      const [csrf, requestOrigin, fetchSite, contentType, idempotency] = await Promise.all([
        "x-lash-csrf", "origin", "sec-fetch-site", "content-type", "x-idempotency-key",
      ].map(name => slot.request.headerValue(name)));
      demand(csrf === "1" && requestOrigin === origin && (fetchSite === null || fetchSite === "same-origin")
        && contentType === "application/json" && idempotency === null);
    }
    remaining(expires);
    return { requestId: head.requestId, body: native.body };
  };

  const bounded = async (operation, expires) => {
    let timer;
    try {
      return await Promise.race([operation, failure, new Promise((_, reject) => {
        timer = setTimeout(() => reject(refusal()), remaining(expires));
      })]);
    } finally { clearTimeout(timer); }
  };

  const fillForm = async (answers, expires) => {
    const form = assessment().locator("form"), fields = form.locator("fieldset");
    await form.waitFor({ state: "visible", timeout: remaining(expires) });
    demand(await form.count() === 1 && await fields.count() === answers.length);
    let quizRevisionId;
    for (const [index, answer] of answers.entries()) {
      const radios = fields.nth(index).getByRole("radio");
      const names = await radios.evaluateAll(elements => elements.map(element => element.name));
      const id = names[0]?.slice(5, 41);
      demand(uuid(id) && (!quizRevisionId || id === quizRevisionId) && names.length >= 2 && names.length <= 6
        && names.every(name => name === "quiz-" + id + "-" + answer.questionId));
      quizRevisionId = id;
      const selected = radios.and(fields.nth(index).locator(`input[value="${answer.optionId}"]`));
      demand(await selected.count() === 1 && await selected.isVisible());
      await selected.check({ timeout: remaining(expires) });
      demand(await selected.isChecked());
    }
    return quizRevisionId;
  };

  const noPlayer = async () => {
    demand(page.url() === source && await page.getByRole("main").locator("mux-player, video, audio").count() === 0);
  };

  return {
    async open(expires) {
      try {
        demand(!opened);
        opened = true;
        session = await context.newCDPSession(page);
        const { frameTree: { frame } } = await session.send("Page.getFrameTree");
        demand(!frame.parentId);
        const buffers = { maxTotalBufferSize: 4 * maximum, maxResourceBufferSize: maximum };
        await session.send("Network.configureDurableMessages", buffers);
        await session.send("Network.enable", { ...buffers, maxPostDataSize: 0 });
        stopNetwork = watchLessonNetworkBodies(session, frame.id, slots, origin, fail);
        active = [playback, started];
        const [media, saved, response] = await bounded(Promise.all([
          observe(playback, expires), observe(started, expires),
          page.goto(source, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) }),
        ]), expires);
        demand(navigation && response?.request() === navigation && response.status() === 200 && response.url() === source
          && !response.fromServiceWorker() && navigation.redirectedTo() === null);
        const [types, cache] = await Promise.all([response.headerValues("content-type"), response.headerValues("cache-control")]);
        demand(types.length === 1 && /^text\/html(?:;.*)?$/iu.test(types[0]) && cache.length === 1
          && privateNoStore({ "cache-control": cache[0] })
          && closed(media.body, ["error", "requestId"]) && media.body.requestId === media.requestId
          && closed(media.body.error, ["code", "message"]) && media.body.error.code === "not_found"
          && media.body.error.message === "This resource is unavailable.");
        const progress = assessmentProgress(saved.body, target, 1, null, null);
        initialized = { playback: { requestId: media.requestId, status: 404 },
          started: { requestId: saved.requestId, progressId: progress.progressId, enrollmentId: progress.enrollmentId, revision: 1 } };
        active = undefined;
        await Promise.all([assessment().locator("form").waitFor({ state: "visible", timeout: remaining(expires) }),
          page.getByText("Progress saved to your account.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) })]);
        await noPlayer();
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      try {
        demand(initialized && !completed && !active);
        const attempts = [];
        for (const [index, { attempt, latest }] of pairs.entries()) {
          const passing = index === 1;
          if (passing) await assessment().getByRole("button", { name: "Try again", exact: true }).click({ timeout: remaining(expires) });
          const quizRevisionId = await fillForm(attempt.answers, expires);
          active = [attempt, latest];
          const submit = assessment().locator("form").getByRole("button", { name: "Submit answers", exact: true });
          const [observedAttempt, observedProgress] = await bounded(Promise.all([
            observe(attempt, expires), observe(latest, expires), submit.click({ timeout: remaining(expires) }),
          ]), expires);
          active = undefined;
          const result = assessmentResult(observedAttempt.body, target, attempt.answers, quizRevisionId, passing);
          const progress = assessmentProgress(observedProgress.body, target, index + 2,
            passing ? result.createdAt : null, passing ? target.quizRevision : null);
          const threshold = observedAttempt.body.attempt.passingPercent;
          await assessment().getByText(`Score at least ${threshold}% to complete this assessment. You can try as often as you need.`, { exact: true })
            .waitFor({ state: "visible", timeout: remaining(expires) });
          await assessment().getByRole("heading", { level: 3, name: passing ? "Assessment passed" : "Keep practising", exact: true })
            .waitFor({ state: "visible", timeout: remaining(expires) });
          await assessment().getByText(new RegExp(`^${result.correctCount} of ${result.totalCount} answers correct\\.`))
            .waitFor({ state: "visible", timeout: remaining(expires) });
          if (passing) await page.getByText("Lesson complete. Progress saved.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) });
          else demand(await page.getByText("Lesson complete. Progress saved.", { exact: true }).count() === 0);
          await noPlayer();
          attempts.push({ requestId: observedAttempt.requestId, payloadRequestId: attempt.payloadRequestId, ...result,
            progress: { requestId: observedProgress.requestId, ...progress } });
        }
        remaining(expires);
        completed = validateP2LessonAssessmentReceipt({ page: { pathname: lessonPath, status: 200 }, ...initialized, attempts }, target);
      } catch { fail(); throw refusal(); }
    },
    finish() {
      if (failed || !completed || context.serviceWorkers().length) throw refusal();
      return completed;
    },
    async close() {
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      page.off("framenavigated", onNavigation);
      fail();
      stopNetwork?.();
      await session?.detach().catch(() => {});
    },
  };
}

const muxHttps = url => url?.protocol === "https:" && !url.port && !url.username && !url.password
  && /(?:^|\.)mux\.com$/iu.test(url.hostname);
const resumeDigest = value => createHash("sha256").update(value).digest("hex");

function watchResumeMedia(context, page, fail) {
  // Keep only digests of the signed manifest and its transitive media URLs.
  const manifests = new Map(), segments = new Set();
  let pending = 0, observed = 0;
  const mediaKey = url => {
    url.hash = "";
    return resumeDigest(url.href);
  };
  const record = async response => {
    const url = URL.parse(response.url()), mime = response.headers()["content-type"]?.split(";", 1)[0]?.toLowerCase();
    const playlist = /\.m3u8$/iu.test(url?.pathname ?? "")
      || /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|(?:x-)?mpegurl)$/u.test(mime ?? "");
    const segment = /^(?:video\/(?:mp2t|mp4|iso\.segment)|audio\/(?:aac|mpeg|mp4)|application\/(?:mp4|iso\.segment))$/u.test(mime ?? "")
      || /^(?:application|binary)\/octet-stream$/u.test(mime ?? "") && /\.(?:ts|mpegts|m4s|mp4|aac)$/iu.test(url?.pathname ?? "");
    if (!playlist && !segment) return;
    const request = response.request(), status = response.status();
    demand(++observed <= 256 && muxHttps(url) && request.frame() === page.mainFrame() && request.method() === "GET"
      && ["media", "fetch", "xhr"].includes(request.resourceType()) && !response.fromServiceWorker());
    if (status >= 300 && status <= 399) return; // Join final bytes to the original referenced URL below.
    demand(status === 200 || !playlist && status === 206);
    let original = request, redirects = 0;
    while (original.redirectedFrom()) {
      original = original.redirectedFrom();
      demand(++redirects <= 3 && muxHttps(URL.parse(original.url())));
    }
    const first = URL.parse(original.url()), key = mediaKey(first);
    if (segment && !playlist) {
      const [completion, sizes] = await Promise.all([response.finished(), request.sizes()]);
      demand(completion === null && integerBetween(sizes.responseBodySize, 1, 32 * 1024 * 1024));
      segments.add(key);
      return;
    }
    const limit = 256 * 1024, sizes = await request.sizes();
    demand(sizes.responseBodySize > 0 && sizes.responseBodySize <= limit);
    const bytes = await response.body();
    try {
      demand(bytes.length > 0 && bytes.length <= limit);
      const content = bytes.toString("utf8");
      demand(/^#EXTM3U(?:\r?\n)/u.test(content));
      const references = new Set();
      for (const line of content.split(/\r?\n/u)) {
        const text = line.trim();
        const uris = text.startsWith("#") ? [...text.matchAll(/\bURI="([^"\r\n]+)"/gu)].map(match => match[1]) : [text];
        for (const uri of uris) {
          if (!uri) continue;
          const resolved = URL.parse(uri, url);
          if (muxHttps(resolved)) references.add(mediaKey(resolved));
          demand(references.size <= 1024);
        }
      }
      const candidate = first.hostname === "stream.mux.com" && /^\/([A-Za-z0-9_-]{1,255})\.m3u8$/u.exec(first.pathname);
      const tokens = first.searchParams.getAll("token");
      const signed = candidate && tokens.length === 1
        ? { playbackIdSha256: resumeDigest(candidate[1]), tokenSha256: resumeDigest(tokens[0]) } : null;
      const previous = manifests.get(key);
      if (previous) for (const reference of references) previous.references.add(reference);
      else manifests.set(key, { signed, references });
      demand(manifests.size <= 32 && (previous?.references.size ?? references.size) <= 1024);
    } finally { bytes.fill(0); }
  };
  const onResponse = response => {
    pending++;
    void record(response).catch(fail).finally(() => { pending--; });
  };
  context.on("response", onResponse);
  return {
    verified(permit) {
      if (pending) return false;
      const selected = [...manifests].filter(([, entry]) => entry.signed?.playbackIdSha256 === permit.playbackIdSha256
        && entry.signed?.tokenSha256 === permit.tokenSha256);
      if (selected.length !== 1) return false;
      const reachable = new Set(), pendingKeys = [selected[0][0]];
      while (pendingKeys.length) {
        const key = pendingKeys.pop();
        if (reachable.has(key)) continue;
        reachable.add(key);
        for (const linked of manifests.get(key)?.references ?? []) if (!reachable.has(linked)) pendingKeys.push(linked);
      }
      return [...manifests.keys()].every(key => reachable.has(key)) && segments.size > 0
        && [...segments].every(key => reachable.has(key));
    },
    close() {
      context.off("response", onResponse);
      manifests.clear();
      segments.clear();
    },
  };
}

function resumeProgress(body, target, revision, resumePositionSeconds, maxPositionSeconds) {
  const row = body?.progress;
  demand(closed(body, ["progress"]) && closed(row, ["id", "userId", "lessonId", "enrollmentId", "maxPositionSeconds", "resumePositionSeconds",
    "revision", "completedQuizRevision", "completedAt", "lastWatchedAt", "createdAt", "updatedAt"])
    && uuid(row.id) && uuid(row.enrollmentId) && row.userId === target.actorId && row.lessonId === target.lessonId
    && row.revision === revision && row.resumePositionSeconds === resumePositionSeconds && row.maxPositionSeconds === maxPositionSeconds
    && row.completedAt === null && row.completedQuizRevision === null);
  return row;
}

// Runs only in the selected frame's Chromium isolated world. The Mux wrapper
// supplies the DOM shape, and the native media accessors supply the evidence.
async function sampleNativeResumeMedia({ source, playbackIdSha256 }) {
  if (location.href !== source) return null;
  const players = document.querySelectorAll("main mux-player");
  if (players.length !== 1) return null;
  const player = players[0], playbackId = player.getAttribute("playback-id");
  if (!playbackId || !/^[A-Za-z0-9_-]{1,255}$/u.test(playbackId)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(playbackId));
  if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== playbackIdSha256) return null;
  const mux = player.shadowRoot?.querySelector("mux-video");
  const videos = [...(mux?.querySelectorAll(":scope > video") ?? []), ...(mux?.shadowRoot?.querySelectorAll("video") ?? [])];
  if (videos.length !== 1 || !(videos[0] instanceof HTMLVideoElement) || !videos[0].isConnected) return null;
  const native = videos[0];
  const read = (property, prototype = HTMLMediaElement.prototype) => Object.getOwnPropertyDescriptor(prototype, property).get.call(native);
  const current = URL.parse(read("currentSrc"));
  if (current?.protocol === "blob:" ? current.origin !== location.origin :
    current?.protocol !== "https:" || current.hostname !== "stream.mux.com" || current.pathname !== "/" + playbackId + ".m3u8") return null;
  return { position: read("currentTime"), duration: read("duration"), width: read("videoWidth", HTMLVideoElement.prototype),
    ready: read("readyState"), paused: read("paused"), seeking: read("seeking"), ended: read("ended") };
}

export function watchP2LessonResume(context, page, input) {
  return watchLessonPosition(context, page, input, "lesson-resume");
}

export function watchP2LessonRestore(context, page, input) {
  return watchLessonPosition(context, page, input, "lesson-restore");
}

export function watchP2LessonExitSave(context, page, input) {
  return watchLessonPosition(context, page, input, "lesson-exit-save");
}

// Playwright 1.59.1 sets focus emulation on the primary Chromium page session.
// Use that same owned session to release it before a native tab switch.
export async function hideP2LessonDocument({ context, page, cover, timeout }) {
  const deadline = performance.now() + timeout;
  const withinLease = () => demand(performance.now() < deadline && page.context() === context && cover !== page
    && cover?.context() === context && !page.isClosed() && !cover.isClosed() && cover.url() === "about:blank"
    && context.pages().includes(page) && context.pages().includes(cover) && page._connection === context._connection
    && cover._connection === context._connection);
  demand(Number.isFinite(timeout) && timeout > 0);
  withinLease();
  const { default: { version } } = await import("playwright-core/package.json", { with: { type: "json" } });
  demand(version === "1.59.1");
  const impl = page._connection.toImpl(page), delegate = impl?.delegate, main = delegate?._mainFrameSession;
  const primary = main?._client;
  demand(impl?.browserContext === context._connection.toImpl(context) && main?._page === impl && main._parentSession === null
    && typeof main._targetId === "string" && main._targetId.length > 0 && main._targetId === delegate._targetId
    && typeof primary?.send === "function" && primary._closed === false && typeof primary._sessionId === "string" && primary._sessionId.length > 0);
  withinLease();
  await primary.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const { result, exceptionDetails } = await primary.send("Runtime.evaluate", {
    expression: "document.visibilityState", returnByValue: true, silent: true,
  });
  demand(!exceptionDetails && result.value === "visible");
  withinLease();
  await cover.bringToFront();
  return cover;
}

export function watchP2LessonVisibility(context, page, input, hideDocument) {
  demand(typeof hideDocument === "function");
  return watchLessonPosition(context, page, input, "lesson-visibility-save", hideDocument);
}

export function watchP2LessonAckLoss(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "lesson-ack-loss" && page.context() === context);
  const target = input.ackLoss, origin = input.browserOrigin;
  const { lessonPath, playbackPath, progressPath, latestPath } = p2LessonAssessmentPaths(target);
  const source = origin + lessonPath, progressUrl = origin + progressPath;
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum } = target;
  const player = page.getByRole("main").locator("mux-player");
  const started = revision => ({ event: "lesson_started", expectedProgressRevision: revision });
  const position = (revision, resumePositionSeconds) => ({ resumePositionSeconds, maxPositionSeconds: maximum, expectedProgressRevision: revision });
  const get = path => ({ path, method: "GET" });
  const post = body => ({ path: progressPath, method: "POST", body: JSON.stringify(body) });
  const playback = [get(playbackPath), get(playbackPath)], latest = get(latestPath);
  const writes = [post(started(6)), post(position(7, resume)), post(position(8, maximum)), post(started(9)), post(position(10, maximum))];
  const [firstStart, firstPosition, dropped, nextStart, nextPosition] = writes;
  const normalWrites = [firstStart, firstPosition, nextStart, nextPosition];
  const slots = new Map([[playbackPath, playback], [progressPath, normalWrites], [latestPath, latest]]);
  const refusal = () => new Error("P2_INTERACTIVE_LESSON_ACK_LOSS_RESPONSE_REFUSED");
  let active, session, executionContextId, stopNetwork, navigation, navigationAllowed = false, opened = false, failed = false;
  let initial, completed, finalPermit, forwarding, forwarded, dropRoute, rejectFailure, acceptDrop;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const dropObserved = new Promise(resolve => { acceptDrop = resolve; });
  const fail = () => { if (!failed) { failed = true; rejectFailure(refusal()); } };
  let media = watchResumeMedia(context, page, fail);
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method(), headers = request.headers();
    try {
      if (request.isNavigationRequest()) {
        demand(navigationAllowed && !navigation && request.url() === source && method === "GET" && headers.rsc === undefined
          && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        navigation = request;
        navigationAllowed = false;
        return;
      }
      if (request.resourceType() === "media") demand(muxHttps(url) || url?.protocol === "blob:" && url.origin === origin);
      if (url?.origin === origin && url.pathname.startsWith("/api/")) {
        const slot = active?.find(candidate => url.pathname + url.search === candidate.path && method === candidate.method && !candidate.request);
        demand(slot && !url.hash && request.frame() === page.mainFrame() && request.frame().url() === source
          && request.resourceType() === "fetch" && request.redirectedFrom() === null && headers.rsc === undefined);
        const predecessor = slot === firstPosition ? [playback[0], firstStart] : slot === nextPosition ? [playback[1], nextStart] : [];
        demand(predecessor.every(row => row.gatewayId));
        const bytes = request.postDataBuffer();
        demand(method === "GET" ? bytes === null : bytes?.toString("utf8") === slot.body);
        slot.request = request;
        return;
      }
      demand(["GET", "HEAD", "OPTIONS"].includes(method));
      if (url?.origin === origin && headers.rsc !== undefined) {
        demand(!url.pathname.startsWith("/academy/courses/") && (headers["next-router-prefetch"] !== undefined
          || headers["next-router-segment-prefetch"] !== undefined) && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
      }
    } catch { fail(); }
  };
  const onFailure = request => {
    if (request === dropped.request && forwarded && request.failure()?.errorText === "net::ERR_CONNECTION_RESET") acceptDrop(forwarded);
    else if (request === navigation || [...playback, ...writes, latest].some(slot => slot.request === request)) fail();
  };
  const onNavigation = frame => { if (frame === page.mainFrame() && frame.url() !== source) fail(); };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  page.on("framenavigated", onNavigation);

  const bounded = async (operation, expires) => {
    let timer;
    try {
      return await Promise.race([operation, failure, new Promise((_, reject) => {
        timer = setTimeout(() => reject(refusal()), remaining(expires));
      })]);
    } finally { clearTimeout(timer); }
  };
  const checkPostHeaders = async request => {
    const [csrf, requestOrigin, fetchSite, contentType, idempotency] = await Promise.all([
      "x-lash-csrf", "origin", "sec-fetch-site", "content-type", "x-idempotency-key",
    ].map(name => request.headerValue(name)));
    demand(csrf === "1" && requestOrigin === origin && (fetchSite === null || fetchSite === "same-origin")
      && contentType === "application/json" && idempotency === null);
  };
  const observe = async (slot, expires) => {
    const response = await page.waitForResponse(candidate => candidate.request() === slot.request, { timeout: remaining(expires) });
    const [head, bounds, native] = await Promise.all([readBrowserResponseHead(response, slot.request, origin, slot.path, slot.method, 200),
      readBrowserResponseBounds(response, slot.request, maxLifecycleBody, true), slot.native]);
    demand(slot.gatewayId === head.requestId && (!bounds.identity || bounds.declared === undefined || native.size === bounds.declared)
      && !slot.request.failure());
    if (slot.method === "POST") await checkPostHeaders(slot.request);
    return { requestId: head.requestId, body: native.body, response };
  };
  const progressReceipt = (result, revision, positionSeconds) => {
    const row = resumeProgress(result.body, target, revision, positionSeconds, maximum);
    demand(row.id === target.progressId && row.enrollmentId === target.enrollmentId);
    return { requestId: result.requestId, progressId: row.id, enrollmentId: row.enrollmentId, revision: row.revision,
      resumePositionSeconds: row.resumePositionSeconds, maxPositionSeconds: row.maxPositionSeconds };
  };
  const sample = async (positionSeconds, permit, expires) => bounded(until(async () => {
    const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", { executionContextId,
      functionDeclaration: sampleNativeResumeMedia.toString(), arguments: [{ value: { source, playbackIdSha256: permit.playbackIdSha256 } }],
      awaitPromise: true, returnByValue: true, silent: true });
    demand(!exceptionDetails);
    const value = result.value;
    return value && value.paused && !value.seeking && !value.ended && value.ready >= 2 && Math.floor(value.position) === positionSeconds
      && integerBetween(Math.floor(value.duration), 22, Number.MAX_SAFE_INTEGER) && integerBetween(value.width, 1, Number.MAX_SAFE_INTEGER);
  }, performance.now() + remaining(expires)), expires);
  const hydrate = async (index, expires, navigate) => {
    const [mediaSlot, start, restored, revision, positionSeconds] = index === 0
      ? [playback[0], firstStart, firstPosition, 7, resume] : [playback[1], nextStart, nextPosition, 10, maximum];
    active = [mediaSlot, start, restored];
    navigation = undefined;
    navigationAllowed = true;
    const [mediaResult, startedResult, restoredResult, document] = await bounded(Promise.all([
      observe(mediaSlot, expires), observe(start, expires), observe(restored, expires), navigate(),
    ]), expires);
    demand(navigation && document?.request() === navigation && document.status() === 200 && document.url() === source
      && !document.fromServiceWorker() && navigation.redirectedTo() === null && page.url() === source);
    const [types, cache, dates] = await Promise.all([document.headerValues("content-type"), document.headerValues("cache-control"),
      mediaResult.response.headerValues("date")]);
    demand(types.length === 1 && /^text\/html(?:;.*)?$/iu.test(types[0]) && cache.length === 1
      && privateNoStore({ "cache-control": cache[0] }) && dates.length === 1);
    const authorization = mediaResult.body;
    let permit, playbackReceipt;
    try {
      const { expiresAt, thumbnailExpiresAt, lifetimeMs } = parseP2PlaybackObservation(200,
        { "cache-control": "private, no-store", date: dates[0] }, authorization, true);
      demand(matches(authorization.playbackId, /^[A-Za-z0-9_-]{1,255}$/u) && authorization.thumbnailToken.length > 20
        && resumeDigest(authorization.playbackId) === target.playbackIdSha256);
      permit = { playbackIdSha256: target.playbackIdSha256, tokenSha256: resumeDigest(authorization.playbackToken) };
      playbackReceipt = { requestId: mediaResult.requestId, expiresAt, thumbnailExpiresAt, lifetimeMs, playbackIdSha256: permit.playbackIdSha256 };
    } finally { authorization.playbackId = authorization.playbackToken = authorization.thumbnailToken = ""; }
    const progressWrites = [progressReceipt(startedResult, revision, positionSeconds), progressReceipt(restoredResult, revision + 1, positionSeconds)];
    active = undefined;
    await bounded(Promise.all([player.waitFor({ state: "visible", timeout: remaining(expires) }),
      page.getByText("Progress saved to your account.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) })]), expires);
    demand(await player.count() === 1);
    executionContextId = await isolatedMainFrame(session, source);
    await Promise.all([sample(positionSeconds, permit, expires),
      bounded(until(() => media.verified(permit), performance.now() + remaining(expires)), expires)]);
    return { permit, playbackReceipt, progressWrites };
  };
  const drop = async (route, expires) => {
    let response;
    try {
      const request = route.request();
      demand(!forwarding && !failed && request === dropped.request && request.url() === progressUrl && request.method() === "POST");
      forwarding = true;
      await checkPostHeaders(request);
      remaining(expires);
      // Forward the browser's one reviewed request without changing URL, headers or body.
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: Math.min(10_000, remaining(expires)) });
      demand(response.url() === progressUrl && response.status() === 200);
      const values = name => response.headersArray().filter(row => row.name.toLowerCase() === name).map(row => row.value);
      const [ids, types, cache, lengths] = ["x-request-id", "content-type", "cache-control", "content-length"].map(values);
      demand(ids.length === 1 && uuid(ids[0]) && types.length === 1 && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(types[0])
        && cache.length === 1 && privateNoStore({ "cache-control": cache[0] }) && values("set-cookie").length === 0
        && lengths.length <= 1 && (!lengths.length || matches(lengths[0], /^[1-9][0-9]{0,6}$/u) && Number(lengths[0]) <= maxLifecycleBody));
      const bytes = await response.body();
      try { forwarded = progressReceipt({ body: exactBrowserJson(bytes), requestId: ids[0] }, 9, maximum); }
      finally { bytes.fill(0); }
      remaining(expires);
    } catch { fail(); }
    finally {
      try { await response?.dispose(); }
      catch { fail(); }
      try { await route.abort("connectionreset"); }
      catch { fail(); }
    }
  };
  const unroute = async () => {
    if (dropRoute) {
      await page.unroute(progressUrl, dropRoute);
      dropRoute = undefined;
    }
  };

  return {
    async open(expires) {
      try {
        demand(!opened);
        opened = true;
        session = await context.newCDPSession(page);
        const { frameTree: { frame } } = await session.send("Page.getFrameTree");
        demand(!frame.parentId);
        const buffers = { maxTotalBufferSize: 256 * 1024, maxResourceBufferSize: 8192 };
        await session.send("Network.configureDurableMessages", buffers);
        await session.send("Network.enable", { ...buffers, maxPostDataSize: 0 });
        stopNetwork = watchLessonNetworkBodies(session, frame.id, slots, origin, fail);
        initial = await hydrate(0, expires, () => page.goto(source, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) }));
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      try {
        demand(initial && !completed && !active && page.url() === source);
        dropRoute = route => drop(route, expires);
        await page.route(progressUrl, dropRoute);
        active = [dropped];
        const control = player.getByRole("button", { name: "play", exact: true }).filter({ visible: true }).first();
        const [committed] = await bounded(Promise.all([dropObserved, sample(maximum, initial.permit, expires),
          control.press("ArrowRight", { timeout: remaining(expires) })]), expires);
        active = undefined;
        await unroute();
        const unconfirmed = page.getByRole("alert").filter({ hasText: "Progress has not been confirmed." });
        await bounded(unconfirmed.waitFor({ state: "visible", timeout: remaining(expires) }), expires);
        active = [latest];
        const [read] = await bounded(Promise.all([observe(latest, expires),
          unconfirmed.getByRole("button", { name: "Retry saving progress", exact: true }).click({ timeout: remaining(expires) })]), expires);
        demand(closed(read.body, ["progress"]) && Array.isArray(read.body.progress) && read.body.progress.length === 1);
        const recovered = progressReceipt({ requestId: read.requestId, body: { progress: read.body.progress[0] } }, 9, maximum);
        active = undefined;
        const reload = page.getByRole("alert").getByRole("button", { name: "Load latest progress", exact: true });
        await bounded(reload.waitFor({ state: "visible", timeout: remaining(expires) }), expires);
        media.close();
        media = watchResumeMedia(context, page, fail);
        const next = await hydrate(1, expires, async () => {
          const [response] = await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: remaining(expires) }),
            reload.click({ timeout: remaining(expires) })]);
          return response;
        });
        finalPermit = next.permit;
        remaining(expires);
        completed = validateP2LessonAckLossReceipt({ page: { pathname: lessonPath, status: 200 },
          playback: [initial.playbackReceipt, next.playbackReceipt], writes: [...initial.progressWrites, committed, ...next.progressWrites],
          recovery: { ...recovered, browserFailure: "connectionreset", unconfirmedObserved: true, noReplay: true },
          media: { beforeSeconds: resume, afterSeconds: maximum, paused: true, manifestObserved: true, segmentObserved: true } }, target);
      } catch { fail(); throw refusal(); }
      finally {
        try { await unroute(); }
        catch { fail(); throw refusal(); }
      }
    },
    finish() {
      if (failed || !completed || context.serviceWorkers().length || !media.verified(finalPermit)) throw refusal();
      return completed;
    },
    async close() {
      fail();
      await unroute().catch(() => {});
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      page.off("framenavigated", onNavigation);
      media.close();
      stopNetwork?.();
      await session?.detach().catch(() => {});
    },
  };
}

export function watchP2LessonStaleRevision(context, page, peerContext, peerPage, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "lesson-stale-revision" && page.context() === context && peerPage.context() === peerContext
    && context !== peerContext && context.browser() && context.browser() === peerContext.browser());
  const target = input.staleRevision, origin = input.browserOrigin;
  const { lessonPath, playbackPath, progressPath, latestPath } = p2LessonAssessmentPaths(target);
  const source = origin + lessonPath, { resumePositionSeconds: resume, maxPositionSeconds: maximum } = target;
  const get = path => ({ path, method: "GET" });
  const post = (body, status = 200) => ({ path: progressPath, method: "POST", body: JSON.stringify(body), status });
  const started = revision => post({ event: "lesson_started", expectedProgressRevision: revision });
  const positioned = (revision, seconds, status) => post({ resumePositionSeconds: seconds, maxPositionSeconds: maximum,
    expectedProgressRevision: revision }, status);
  const firstPlayback = get(playbackPath), peerPlayback = get(playbackPath), reloadPlayback = get(playbackPath);
  const [firstStart, firstPosition, peerStart, peerPosition, winner, reloadStart, reloadPosition] = [
    started(6), positioned(7, resume), started(8), positioned(9, resume), positioned(10, maximum),
    started(11), positioned(12, maximum),
  ];
  const conflict = positioned(8, 0, 409), latest = get(latestPath);
  const refusal = () => new Error("P2_INTERACTIVE_LESSON_STALE_REVISION_RESPONSE_REFUSED");
  let initial, completed, fenced = false, failed = false, rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const fail = () => { if (!failed) { failed = true; rejectFailure(refusal()); } };
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const bounded = async (operation, expires) => {
    let timer;
    try {
      return await Promise.race([operation, failure, new Promise((_, reject) => {
        timer = setTimeout(() => reject(refusal()), remaining(expires));
      })]);
    } finally { clearTimeout(timer); }
  };

  function watchDevice(deviceContext, devicePage, entries) {
    const slots = new Map(entries);
    const allSlots = [...slots.values()].flat();
    const player = devicePage.getByRole("main").locator("mux-player");
    let active, navigationAllowed = false, navigation, session, stopNetwork, executionContextId, heldFrame, currentPermit;
    let media = watchResumeMedia(deviceContext, devicePage, fail);
    const onRequest = request => {
      const url = URL.parse(request.url()), method = request.method(), headers = request.headers();
      try {
        if (request.isNavigationRequest()) {
          demand(navigationAllowed && !navigation && request.url() === source && method === "GET" && headers.rsc === undefined
            && request.frame() === devicePage.mainFrame() && request.redirectedFrom() === null);
          navigation = request;
          navigationAllowed = false;
          return;
        }
        if (request.resourceType() === "media") demand(muxHttps(url) || url?.protocol === "blob:" && url.origin === origin);
        if (url?.origin === origin && url.pathname.startsWith("/api/")) {
          const slot = active?.find(candidate => url.pathname + url.search === candidate.path && method === candidate.method && !candidate.request);
          demand(slot && !url.hash && request.frame() === devicePage.mainFrame() && request.frame().url() === source
            && request.resourceType() === "fetch" && request.redirectedFrom() === null && headers.rsc === undefined);
          const predecessor = slot === firstPosition ? [firstPlayback, firstStart] : slot === peerPosition ? [peerPlayback, peerStart]
            : slot === reloadPosition ? [reloadPlayback, reloadStart] : slot === latest ? [conflict] : [];
          demand(predecessor.every(row => row.gatewayId));
          const bytes = request.postDataBuffer();
          demand(method === "GET" ? bytes === null : bytes?.toString("utf8") === slot.body);
          slot.request = request;
          return;
        }
        demand(["GET", "HEAD", "OPTIONS"].includes(method));
        if (url?.origin === origin && headers.rsc !== undefined) {
          demand(!url.pathname.startsWith("/academy/courses/") && (headers["next-router-prefetch"] !== undefined
            || headers["next-router-segment-prefetch"] !== undefined) && request.frame() === devicePage.mainFrame() && request.redirectedFrom() === null);
        }
      } catch { fail(); }
    };
    const onFailure = request => { if (request === navigation || allSlots.some(slot => slot.request === request)) fail(); };
    const onNavigation = frame => { if (frame === devicePage.mainFrame() && frame.url() !== source) fail(); };
    deviceContext.on("request", onRequest);
    deviceContext.on("requestfailed", onFailure);
    devicePage.on("framenavigated", onNavigation);
    devicePage.on("close", fail);

    const observe = async (slot, expires) => {
      const response = await devicePage.waitForResponse(candidate => candidate.request() === slot.request, { timeout: remaining(expires) });
      const [head, bounds, native] = await Promise.all([
        readBrowserResponseHead(response, slot.request, origin, slot.path, slot.method, slot.status ?? 200),
        readBrowserResponseBounds(response, slot.request, maxLifecycleBody, true), slot.native,
      ]);
      demand(slot.gatewayId === head.requestId && (!bounds.identity || bounds.declared === undefined || native.size === bounds.declared)
        && !slot.request.failure());
      if (slot.method === "POST") {
        const [csrf, requestOrigin, fetchSite, contentType, idempotency] = await Promise.all([
          "x-lash-csrf", "origin", "sec-fetch-site", "content-type", "x-idempotency-key",
        ].map(name => slot.request.headerValue(name)));
        demand(csrf === "1" && requestOrigin === origin && (fetchSite === null || fetchSite === "same-origin")
          && contentType === "application/json" && idempotency === null);
      }
      return { requestId: head.requestId, body: native.body, response };
    };
    const sample = (seconds, expires) => bounded(until(async () => {
      const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", { executionContextId,
        functionDeclaration: sampleNativeResumeMedia.toString(), arguments: [{ value: { source, playbackIdSha256: target.playbackIdSha256 } }],
        awaitPromise: true, returnByValue: true, silent: true });
      demand(!exceptionDetails);
      const value = result.value;
      return value && value.paused && !value.seeking && !value.ended && value.ready >= 2 && Math.floor(value.position) === seconds
        && integerBetween(Math.floor(value.duration), 22, Number.MAX_SAFE_INTEGER) && integerBetween(value.width, 1, Number.MAX_SAFE_INTEGER);
    }, performance.now() + remaining(expires)), expires);
    const seek = (key, expires) => player.getByRole("button", { name: "play", exact: true }).filter({ visible: true }).first()
      .press(key, { timeout: remaining(expires) });
    const frame = async () => (await session.send("Page.getFrameTree")).frameTree.frame;

    return {
      async initialize(expires) {
        demand(deviceContext.pages().length === 1 && !deviceContext.serviceWorkers().length && devicePage.url() === "about:blank");
        session = await bounded(deviceContext.newCDPSession(devicePage), expires);
        const initialFrame = await frame();
        demand(!initialFrame.parentId);
        const buffers = { maxTotalBufferSize: 256 * 1024, maxResourceBufferSize: 8192 };
        await session.send("Network.configureDurableMessages", buffers);
        await session.send("Network.enable", { ...buffers, maxPostDataSize: 0 });
        stopNetwork = watchLessonNetworkBodies(session, initialFrame.id, slots, origin, fail);
      },
      async hydrate(mediaSlot, start, restored, revision, seconds, expires, reloadButton) {
        demand(!active && !navigationAllowed && Boolean(heldFrame) === Boolean(reloadButton));
        if (reloadButton) {
          media.close();
          media = watchResumeMedia(deviceContext, devicePage, fail);
        }
        active = [mediaSlot, start, restored];
        navigation = undefined;
        navigationAllowed = true;
        const options = { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) };
        const [mediaResult, startedResult, restoredResult, document] = await bounded(Promise.all([
          observe(mediaSlot, expires), observe(start, expires), observe(restored, expires),
          reloadButton ? Promise.all([devicePage.waitForNavigation(options), reloadButton.click({ timeout: remaining(expires) })])
            .then(([response]) => response) : devicePage.goto(source, options),
        ]), expires);
        demand(navigation && document?.request() === navigation && document.status() === 200 && document.url() === source
          && !document.fromServiceWorker() && navigation.redirectedTo() === null && devicePage.url() === source);
        const [types, cache, dates] = await Promise.all([document.headerValues("content-type"), document.headerValues("cache-control"),
          mediaResult.response.headerValues("date")]);
        demand(types.length === 1 && /^text\/html(?:;.*)?$/iu.test(types[0]) && cache.length === 1
          && privateNoStore({ "cache-control": cache[0] }) && dates.length === 1);
        const authorization = mediaResult.body;
        let playback;
        try {
          const { expiresAt, thumbnailExpiresAt, lifetimeMs } = parseP2PlaybackObservation(200,
            { "cache-control": "private, no-store", date: dates[0] }, authorization, true);
          demand(matches(authorization.playbackId, /^[A-Za-z0-9_-]{1,255}$/u) && authorization.thumbnailToken.length > 20
            && resumeDigest(authorization.playbackId) === target.playbackIdSha256);
          currentPermit = { playbackIdSha256: target.playbackIdSha256, tokenSha256: resumeDigest(authorization.playbackToken) };
          playback = { requestId: mediaResult.requestId, expiresAt, thumbnailExpiresAt, lifetimeMs, playbackIdSha256: target.playbackIdSha256 };
        } finally { authorization.playbackId = authorization.playbackToken = authorization.thumbnailToken = ""; }
        const writes = [progressReceipt(startedResult, revision, seconds), progressReceipt(restoredResult, revision + 1, seconds)];
        active = undefined;
        await bounded(Promise.all([player.waitFor({ state: "visible", timeout: remaining(expires) }),
          devicePage.getByText("Progress saved to your account.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) })]), expires);
        demand(await player.count() === 1);
        const currentFrame = await frame();
        demand(currentFrame.loaderId && (!heldFrame || currentFrame.id === heldFrame.id && currentFrame.loaderId !== heldFrame.loaderId));
        heldFrame = currentFrame;
        executionContextId = await isolatedMainFrame(session, source);
        await Promise.all([sample(seconds, expires),
          bounded(until(() => media.verified(currentPermit), performance.now() + remaining(expires)), expires)]);
        return { playback, writes };
      },
      async seekAndObserve(key, seconds, expected, expires) {
        demand(!active && heldFrame);
        active = expected;
        const results = await bounded(Promise.all([
          ...expected.map(slot => observe(slot, expires)), sample(seconds, expires), seek(key, expires),
        ]), expires);
        active = undefined;
        return results.slice(0, expected.length);
      },
      get reloadButton() { return devicePage.getByRole("alert").getByRole("button", { name: "Load latest progress", exact: true }); },
      async blockedSeek(expires) {
        demand(!active && heldFrame);
        await this.reloadButton.waitFor({ state: "visible", timeout: remaining(expires) });
        await bounded(Promise.all([seek("ArrowRight", expires), sample(10, expires)]), expires);
        await bounded(pause(250), expires);
        demand(await this.reloadButton.isVisible() && !failed);
      },
      ready() {
        return !active && !navigationAllowed && !devicePage.isClosed() && devicePage.url() === source
          && deviceContext.pages().length === 1 && !deviceContext.serviceWorkers().length && media.verified(currentPermit);
      },
      async confirmHeld() {
        const current = await frame();
        return this.ready() && current.id === heldFrame.id && current.loaderId === heldFrame.loaderId && current.url === source;
      },
      async close() {
        deviceContext.off("request", onRequest);
        deviceContext.off("requestfailed", onFailure);
        devicePage.off("framenavigated", onNavigation);
        devicePage.off("close", fail);
        media.close();
        stopNetwork?.();
        await session?.detach().catch(() => {});
      },
    };
  }

  const progressReceipt = (result, revision, position) => {
    const row = resumeProgress(result.body, target, revision, position, maximum);
    demand(row.id === target.progressId && row.enrollmentId === target.enrollmentId);
    return { requestId: result.requestId, progressId: row.id, enrollmentId: row.enrollmentId, revision: row.revision,
      resumePositionSeconds: row.resumePositionSeconds, maxPositionSeconds: row.maxPositionSeconds };
  };
  const first = watchDevice(context, page, [[playbackPath, [firstPlayback, reloadPlayback]],
    [progressPath, [firstStart, firstPosition, conflict, reloadStart, reloadPosition]], [latestPath, latest]]);
  const peer = watchDevice(peerContext, peerPage, [[playbackPath, peerPlayback], [progressPath, [peerStart, peerPosition, winner]]]);
  return {
    async open(expires) {
      try {
        demand(!initial);
        await Promise.all([first.initialize(expires), peer.initialize(expires)]);
        const a = await first.hydrate(firstPlayback, firstStart, firstPosition, 7, resume, expires);
        const b = await peer.hydrate(peerPlayback, peerStart, peerPosition, 9, resume, expires);
        initial = { a, b };
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      try {
        demand(initial && !completed && first.ready() && peer.ready());
        const [won] = await peer.seekAndObserve("ArrowRight", maximum, [winner], expires);
        const winningWrite = progressReceipt(won, 11, maximum);
        const [lost, read] = await first.seekAndObserve("ArrowLeft", 0, [conflict, latest], expires);
        demand(closed(lost.body, ["error", "requestId"]) && closed(lost.body.error, ["code", "message"])
          && lost.body.requestId === lost.requestId && lost.body.error.code === "conflict"
          && lost.body.error.message === "This operation conflicts with the current state. Refresh and try again.");
        demand(closed(read.body, ["progress"]) && Array.isArray(read.body.progress) && read.body.progress.length === 1);
        const authoritative = progressReceipt({ requestId: read.requestId, body: { progress: read.body.progress[0] } }, 11, maximum);
        await first.blockedSeek(expires);
        const reloaded = await first.hydrate(reloadPlayback, reloadStart, reloadPosition, 12, maximum, expires, first.reloadButton);
        remaining(expires);
        completed = validateP2LessonStaleRevisionReceipt({ page: { pathname: lessonPath, status: 200 },
          playback: [initial.a.playback, initial.b.playback, reloaded.playback],
          writes: [...initial.a.writes, ...initial.b.writes, winningWrite, ...reloaded.writes],
          conflict: { requestId: lost.requestId, expectedProgressRevision: 8, resumePositionSeconds: 0, maxPositionSeconds: maximum, status: 409 },
          authoritative, reload: { documentReplaced: true, noReplay: true },
          media: { beforeSeconds: resume, afterSeconds: maximum, paused: true, manifestObserved: true, segmentObserved: true },
        }, target);
      } catch { fail(); throw refusal(); }
    },
    finish() {
      if (failed || !completed || !first.ready() || !peer.ready()) throw refusal();
      return completed;
    },
    async confirmFenced() {
      try {
        demand(!fenced && this.finish() && (await Promise.all([first.confirmHeld(), peer.confirmHeld()])).every(Boolean) && !failed);
        fenced = true;
        return true;
      } catch { fail(); throw refusal(); }
    },
    async close() {
      fail();
      await Promise.all([first.close(), peer.close()]);
    },
  };
}

function watchLessonPosition(context, page, input, stage, hideDocument) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === stage && page.context() === context);
  const exitSave = input.exitSave, documentExit = exitSave?.operation === "document-exit";
  const visibility = input.visibility, lifecycleSave = exitSave ?? visibility;
  const target = lifecycleSave ?? input.restore ?? input.resume, prior = lifecycleSave ?? target.prior;
  const startRevision = lifecycleSave ? 6 : prior ? 4 : 0;
  const { academyPath, lessonPath, playbackPath, progressPath } = p2LessonEntryPaths(target);
  const origin = input.browserOrigin, source = origin + lessonPath, destination = origin + academyPath;
  const player = page.getByRole("main").locator("mux-player");
  const playback = { path: playbackPath, method: "GET" }, started = { path: progressPath, method: "POST" };
  const writes = (prior ? [startRevision + 1] : [1, 2, 3]).map(revision => ({ path: progressPath, method: "POST", revision }));
  const restored = prior ? writes[0] : null;
  const exit = lifecycleSave && { path: progressPath, method: "POST", revision: 8 };
  const slots = new Map([[playbackPath, playback], [progressPath, [started, ...writes, ...(visibility ? [exit] : [])]]]);
  const refusal = () => new Error(exitSave ? "P2_INTERACTIVE_LESSON_EXIT_SAVE_RESPONSE_REFUSED"
    : visibility ? "P2_INTERACTIVE_LESSON_VISIBILITY_RESPONSE_REFUSED"
    : prior ? "P2_INTERACTIVE_LESSON_RESTORE_RESPONSE_REFUSED" : "P2_INTERACTIVE_LESSON_RESUME_RESPONSE_REFUSED");
  let navigation, opened = false, failed = false, initialized, restoredProgress, completed, active, session, executionContextId, stopNetwork, permit, previousMax = 0;
  let exiting = false, destinationRequest, sourceFrame, exitNetworkId, exitRequestedAt, exitAborted = false;
  let visibilityCover, freezeRequested = false, visibilityFenced = false;
  const trustedEvents = new Map(), validExitHeaders = new Set();
  const eventBinding = "__lashP2ExitEvent";
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const fail = () => { if (!failed) { failed = true; rejectFailure(refusal()); } };
  const media = watchResumeMedia(context, page, fail);
  const remaining = expires => {
    const timeout = expires * 1000 - Date.now();
    if (failed || timeout <= 0 || timeout > input.windowSeconds * 1000) throw refusal();
    return timeout;
  };
  const onRequest = request => {
    const url = URL.parse(request.url()), method = request.method(), headers = request.headers();
    try {
      if (visibility && trustedEvents.has("freeze")) demand(request.frame().page() !== page);
      if (request.isNavigationRequest()) {
        demand(opened && method === "GET" && headers.rsc === undefined
          && request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        if (!navigation && request.url() === source) navigation = request;
        else {
          demand(documentExit && exiting && !destinationRequest && request.url() === destination);
          destinationRequest = request;
        }
        return;
      }
      if (request.resourceType() === "media") demand(muxHttps(url) || url?.protocol === "blob:" && url.origin === origin);
      if (url?.origin === origin && url.pathname.startsWith("/api/")) {
        const slot = active?.find(candidate => candidate.path === url.pathname && !candidate.request);
        demand(slot && !url.search && !url.hash && method === slot.method
          && request.frame() === page.mainFrame() && request.resourceType() === "fetch"
          && request.redirectedFrom() === null && headers.rsc === undefined);
        const frameUrl = request.frame().url();
        demand(frameUrl === source || exitSave && slot === exit && frameUrl === destination);
        const recorded = request.postDataBuffer();
        if (slot === playback) demand(recorded === null);
        else {
          const bytes = recorded && Buffer.from(recorded);
          try {
            const posted = exactBrowserJson(bytes);
            if (slot === started) demand(bytes.toString("utf8") === JSON.stringify({ event: "lesson_started", expectedProgressRevision: startRevision }));
            else if (slot === restored) {
              const { resumePositionSeconds, maxPositionSeconds } = prior;
              demand(started.gatewayId && playback.gatewayId && bytes.toString("utf8") === JSON.stringify({
                resumePositionSeconds, maxPositionSeconds, expectedProgressRevision: startRevision + 1,
              }));
            }
            else {
              const { resumePositionSeconds, maxPositionSeconds, expectedProgressRevision } = posted;
              demand(expectedProgressRevision === slot.revision
                && (slot === exit ? integerBetween(resumePositionSeconds, prior.resumePositionSeconds + 2, prior.resumePositionSeconds + 5)
                  && maxPositionSeconds === prior.maxPositionSeconds
                  : validResumePosition(slot.revision - 1, resumePositionSeconds, maxPositionSeconds, previousMax))
                && bytes.toString("utf8") === JSON.stringify({ resumePositionSeconds, maxPositionSeconds, expectedProgressRevision }));
              slot.posted = posted;
            }
          } finally { bytes?.fill(0); }
        }
        slot.request = request;
        return;
      }
      demand(["GET", "HEAD", "OPTIONS"].includes(method));
      if (url?.origin === origin && headers.rsc !== undefined) {
        const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
        demand(request.frame() === page.mainFrame() && request.redirectedFrom() === null);
        if (exitSave && url.pathname === academyPath) {
          demand(!documentExit && exiting && !destinationRequest && !prefetch && method === "GET" && headers.rsc === "1"
            && request.resourceType() === "fetch" && !url.hash && /^\?_rsc(?:=[A-Za-z0-9_-]{0,128})?$/u.test(url.search));
          destinationRequest = request;
        } else demand(!url.pathname.startsWith("/academy/courses/") && prefetch);
      }
    } catch { fail(); }
  };
  const onFailure = request => {
    if (request === exit?.request) {
      if (documentExit && request.failure()?.errorText === "net::ERR_ABORTED") exitAborted = true;
      else fail();
      return;
    }
    if (request === navigation || request === destinationRequest || active?.some(slot => slot.request === request)) fail();
  };
  const onNavigation = frame => {
    if (frame === page.mainFrame() && navigation && !(frame.url() === source && !completed)
      && !(exiting && frame.url() === destination)) fail();
  };
  const onFinished = request => { if (documentExit && request === exit?.request) fail(); };
  const onExitNetworkRequest = ({ requestId, request, frameId, loaderId, documentURL, type, redirectResponse, wallTime }) => {
    if (!exiting || request.url !== origin + progressPath) return;
    if (exitNetworkId || type !== "Fetch" || request.method !== "POST" || frameId !== sourceFrame.id
      || loaderId !== sourceFrame.loaderId || (documentURL !== source && (!exitSave || documentExit || documentURL !== destination))
      || redirectResponse || !Number.isFinite(wallTime) || wallTime <= 0) return fail();
    exitNetworkId = requestId;
    exitRequestedAt = wallTime * 1000;
  };
  const onExitNetworkHeaders = ({ requestId, headers }) => {
    if (!exiting) return;
    // Chromium can deliver this before requestWillBeSent. Store only IDs
    // whose real network headers pass the checks, never the header values.
    const entries = Object.entries(headers);
    const values = key => entries.filter(([name]) => name.toLowerCase() === key).map(([, value]) => value);
    const matchesHeader = (key, expected) => {
      const found = values(key);
      return found.length === 1 && found[0] === expected;
    };
    if (!matchesHeader("origin", origin) || !matchesHeader("sec-fetch-site", "same-origin")
      || !matchesHeader("x-lash-csrf", "1") || !matchesHeader("content-type", "application/json")
      || values("x-idempotency-key").length !== 0) return;
    if (validExitHeaders.has(requestId) || validExitHeaders.size >= 16) return fail();
    validExitHeaders.add(requestId);
  };
  const onTrustedExitEvent = ({ name, payload, executionContextId: observedContext }) => {
    if (name !== eventBinding) return;
    try {
      demand((documentExit || visibility) && exiting && observedContext === executionContextId && typeof payload === "string" && payload.length <= 96);
      const event = JSON.parse(payload);
      demand(closed(event, ["kind", "at"]) && (documentExit ? ["pagehide", "hidden"].includes(event.kind) : event.kind === "hidden" || event.kind === "freeze" && freezeRequested)
        && !trustedEvents.has(event.kind)
        && Number.isFinite(event.at) && event.at > 0);
      trustedEvents.set(event.kind, event.at);
    } catch { fail(); }
  };
  context.on("request", onRequest);
  context.on("requestfailed", onFailure);
  if (documentExit) context.on("requestfinished", onFinished);
  page.on("framenavigated", onNavigation);

  const boundedFor = async (operation, timeout) => {
    let timer;
    try {
      return await Promise.race([operation, failure, new Promise((_, reject) => {
        timer = setTimeout(() => reject(refusal()), timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const bounded = (operation, expires) => boundedFor(operation, remaining(expires));
  const checkHiddenDocument = async () => {
    demand(!page.isClosed() && visibilityCover && !visibilityCover.isClosed() && visibilityCover.url() === "about:blank");
    const { frameTree: { frame } } = await session.send("Page.getFrameTree");
    const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", { executionContextId,
      functionDeclaration: function hidden(source) {
        return location.href === source && document.visibilityState === "hidden";
      }.toString(), arguments: [{ value: source }], returnByValue: true, silent: true });
    demand(frame.id === sourceFrame.id && frame.loaderId === sourceFrame.loaderId && frame.url === source
      && page.url() === source && !exceptionDetails && result.value === true);
  };
  const observe = async (slot, expires) => {
    const response = await page.waitForResponse(candidate => candidate.request() === slot.request, { timeout: remaining(expires) });
    const [head, bounds, native] = await Promise.all([readBrowserResponseHead(response, slot.request, origin, slot.path, slot.method, 200),
      readBrowserResponseBounds(response, slot.request, maxLifecycleBody, true), slot.native]);
    demand(slot.gatewayId === head.requestId && (!bounds.identity || bounds.declared === undefined || native.size === bounds.declared)
      && !slot.request.failure());
    if (slot.method === "POST") {
      const [csrf, requestOrigin, fetchSite, contentType, idempotency] = await Promise.all([
        "x-lash-csrf", "origin", "sec-fetch-site", "content-type", "x-idempotency-key",
      ].map(name => slot.request.headerValue(name)));
      demand(csrf === "1" && requestOrigin === origin && (fetchSite === null || fetchSite === "same-origin")
        && contentType === "application/json" && idempotency === null);
    }
    remaining(expires);
    return { requestId: head.requestId, body: native.body, response };
  };
  const sample = async (accept, expires) => bounded(until(async () => {
    const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", { executionContextId,
      functionDeclaration: sampleNativeResumeMedia.toString(), arguments: [{ value: { source, playbackIdSha256: permit.playbackIdSha256 } }],
      awaitPromise: true, returnByValue: true, silent: true });
    demand(!exceptionDetails);
    const value = result.value;
    return value && Number.isFinite(value.position) && integerBetween(Math.floor(value.duration), 22, Number.MAX_SAFE_INTEGER)
      && integerBetween(value.width, 1, Number.MAX_SAFE_INTEGER) && !value.seeking && !value.ended && accept(value) ? value : null;
  }, performance.now() + remaining(expires)), expires);
  const control = (name) => player.getByRole("button", { name, exact: true }).filter({ visible: true });
  const press = async (name, expires, key) => {
    const selected = control(name).first();
    await selected.waitFor({ state: "visible", timeout: remaining(expires) });
    if (key) await selected.press(key, { timeout: remaining(expires) });
    else await selected.click({ timeout: remaining(expires) });
  };
  const write = async (slot, expires) => {
    const result = await observe(slot, expires), { resumePositionSeconds, maxPositionSeconds: submittedMaxPositionSeconds } = slot.posted;
    const maxPositionSeconds = Math.max(resumePositionSeconds, submittedMaxPositionSeconds);
    const row = resumeProgress(result.body, target, slot.revision + 1, resumePositionSeconds, maxPositionSeconds);
    demand(row.id === initialized.started.progressId && row.enrollmentId === initialized.started.enrollmentId);
    previousMax = maxPositionSeconds;
    return { requestId: result.requestId, expectedProgressRevision: slot.revision, revision: row.revision,
      resumePositionSeconds, submittedMaxPositionSeconds, maxPositionSeconds };
  };

  return {
    async open(expires) {
      try {
        demand(!opened);
        opened = true;
        if (visibility) {
          visibilityCover = await bounded(context.newPage(), expires);
          demand(visibilityCover !== page && visibilityCover.context() === context && visibilityCover.url() === "about:blank");
          visibilityCover.on("framenavigated", fail);
          visibilityCover.on("close", fail);
          page.on("close", fail);
          await bounded(page.bringToFront(), expires);
        }
        session = await context.newCDPSession(page);
        const { frameTree: { frame } } = await session.send("Page.getFrameTree");
        demand(!frame.parentId);
        const buffers = { maxTotalBufferSize: 256 * 1024, maxResourceBufferSize: 8192 };
        await session.send("Network.configureDurableMessages", buffers);
        await session.send("Network.enable", { ...buffers, maxPostDataSize: 0 });
        stopNetwork = watchLessonNetworkBodies(session, frame.id, slots, origin, fail);
        active = restored ? [playback, started, restored] : [playback, started];
        const [mediaResult, saved, restoredResult, response] = await bounded(Promise.all([
          observe(playback, expires), observe(started, expires), restored ? observe(restored, expires) : null,
          page.goto(source, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, remaining(expires)) }),
        ]), expires);
        demand(navigation && response?.request() === navigation && response.status() === 200 && response.url() === source
          && !response.fromServiceWorker() && navigation.redirectedTo() === null && page.url() === source);
        const [types, cache, dates] = await Promise.all([response.headerValues("content-type"), response.headerValues("cache-control"),
          mediaResult.response.headerValues("date")]);
        demand(types.length === 1 && /^text\/html(?:;.*)?$/iu.test(types[0]) && cache.length === 1
          && privateNoStore({ "cache-control": cache[0] }) && dates.length === 1);
        try {
          const row = resumeProgress(saved.body, target, startRevision + 1, prior?.resumePositionSeconds ?? 0, prior?.maxPositionSeconds ?? 0);
          const { expiresAt, thumbnailExpiresAt, lifetimeMs } = parseP2PlaybackObservation(200,
            { "cache-control": "private, no-store", date: dates[0] }, mediaResult.body, true);
          demand(matches(mediaResult.body.playbackId, /^[A-Za-z0-9_-]{1,255}$/u) && mediaResult.body.thumbnailToken.length > 20);
          permit = { playbackIdSha256: resumeDigest(mediaResult.body.playbackId), tokenSha256: resumeDigest(mediaResult.body.playbackToken) };
          initialized = { playback: { requestId: mediaResult.requestId, expiresAt, thumbnailExpiresAt, lifetimeMs, playbackIdSha256: permit.playbackIdSha256 },
            started: { requestId: saved.requestId, progressId: row.id, enrollmentId: row.enrollmentId, revision: row.revision } };
          if (prior) {
            demand(row.id === prior.progressId && row.enrollmentId === prior.enrollmentId && permit.playbackIdSha256 === prior.playbackIdSha256);
            const { resumePositionSeconds, maxPositionSeconds } = prior;
            const result = resumeProgress(restoredResult.body, target, startRevision + 2, resumePositionSeconds, maxPositionSeconds);
            if (lifecycleSave) demand(result.id === prior.progressId && result.enrollmentId === prior.enrollmentId);
            restoredProgress = { requestId: restoredResult.requestId, progressId: result.id, enrollmentId: result.enrollmentId,
              revision: result.revision, resumePositionSeconds: result.resumePositionSeconds, maxPositionSeconds: result.maxPositionSeconds };
          }
        } finally {
          mediaResult.body.playbackId = mediaResult.body.playbackToken = mediaResult.body.thumbnailToken = "";
        }
        active = undefined;
        await Promise.all([player.waitFor({ state: "visible", timeout: remaining(expires) }),
          page.getByText("Progress saved to your account.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) })]);
        demand(await player.count() === 1);
        executionContextId = await isolatedMainFrame(session, source);
        if (lifecycleSave) {
          ({ frameTree: { frame: sourceFrame } } = await session.send("Page.getFrameTree"));
          demand(sourceFrame.url === source && sourceFrame.loaderId);
          await session.send("Runtime.enable");
          session.on("Runtime.bindingCalled", onTrustedExitEvent);
          session.on("Network.requestWillBeSent", onExitNetworkRequest);
          session.on("Network.requestWillBeSentExtraInfo", onExitNetworkHeaders);
          await session.send("Runtime.addBinding", { name: eventBinding, executionContextId });
          const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", { executionContextId,
            functionDeclaration: function observeNativeExit({ source, name, observeVisible }) {
              if (location.href !== source || document.visibilityState !== "visible") return false;
              const notify = globalThis[name];
              const observe = (event, kind) => notify(JSON.stringify({ kind, at: performance.timeOrigin + event.timeStamp }));
              window.addEventListener("pagehide", event => {
                if (event.isTrusted) observe(event, event.persisted ? "persisted" : "pagehide");
              }, { capture: true });
              document.addEventListener("visibilitychange", event => {
                if (event.isTrusted && (observeVisible || document.visibilityState === "hidden")) observe(event, document.visibilityState);
              }, { capture: true });
              if (observeVisible) for (const kind of ["freeze", "resume"]) document.addEventListener(kind, event => {
                if (event.isTrusted) observe(event, kind);
              }, { capture: true });
              return true;
            }.toString(), arguments: [{ value: { source, name: eventBinding, observeVisible: Boolean(visibility) } }], returnByValue: true, silent: true });
          demand(!exceptionDetails && result.value === true);
        }
      } catch { fail(); throw refusal(); }
    },
    async wait(expires) {
      try {
        demand(initialized && !completed && !active && page.url() === source);
        if (visibility) {
          const { resumePositionSeconds: resume, maxPositionSeconds: maximum } = prior;
          await Promise.all([
            bounded(until(() => media.verified(permit), performance.now() + remaining(expires)), expires),
            sample(value => value.paused && value.ready >= 2 && Math.floor(value.position) === resume, expires),
          ]);
          await press("play", expires);
          const native = await sample(value => !value.paused && value.ready >= 2
            && value.position >= resume + 3 && value.position < resume + 4, expires);
          exiting = true;
          active = [exit];
          const [saved] = await bounded(Promise.all([observe(exit, expires),
            hideDocument({ context, page, cover: visibilityCover, timeout: remaining(expires) })]), expires);
          await bounded(until(() => {
            remaining(expires);
            return validExitHeaders.has(exitNetworkId) && trustedEvents.has("hidden");
          }, performance.now() + remaining(expires)), expires);
          demand(exitNetworkId === exit.cdpId && exitRequestedAt + 2 >= trustedEvents.get("hidden"));
          await bounded(checkHiddenDocument(), expires);
          const row = resumeProgress(saved.body, target, 9, exit.posted.resumePositionSeconds, maximum);
          demand(row.id === prior.progressId && row.enrollmentId === prior.enrollmentId);
          active = undefined;
          // Keep the same hidden document in place through the parent fence.
          const freezeTimeout = remaining(expires);
          freezeRequested = true;
          await boundedFor(session.send("Page.setWebLifecycleState", { state: "frozen" }), freezeTimeout);
          await bounded(until(() => trustedEvents.has("freeze"), performance.now() + remaining(expires)), expires);
          demand(trustedEvents.get("freeze") >= trustedEvents.get("hidden"));
          remaining(expires);
          completed = validateP2LessonVisibilityReceipt({ page: { pathname: lessonPath, status: 200 }, playback: initialized.playback,
            writes: [{ ...initialized.started, resumePositionSeconds: resume, maxPositionSeconds: maximum }, restoredProgress,
              { requestId: saved.requestId, progressId: row.id, enrollmentId: row.enrollmentId, revision: row.revision,
                resumePositionSeconds: row.resumePositionSeconds, maxPositionSeconds: row.maxPositionSeconds }],
            visibility: { sameDocument: true, trustedHidden: true, trustedPagehide: false, ...exit.posted },
            media: { playedSeconds: Math.floor(native.position), playing: true, manifestObserved: true, segmentObserved: true } }, target);
          return;
        }
        if (exitSave) {
          const resume = prior.resumePositionSeconds;
          await Promise.all([
            bounded(until(() => media.verified(permit), performance.now() + remaining(expires)), expires),
            sample(value => value.paused && value.ready >= 2 && Math.floor(value.position) === resume, expires),
          ]);
          const link = page.getByRole("main").locator(`a[href="${academyPath}"]`);
          demand(await link.count() === 1 && await link.isVisible());
          const courseTitle = (await link.innerText({ timeout: remaining(expires) })).trim();
          demand(courseTitle.length > 0);
          await press("play", expires);
          const native = await sample(value => !value.paused && value.ready >= 2
            && value.position >= resume + 3 && value.position < resume + 4, expires);
          // The old document can lose the response when it unloads. The
          // gateway acknowledgement and held Course witness settle the write.
          stopNetwork();
          stopNetwork = undefined;
          media.close();
          exiting = true;
          active = [exit];
          const [response] = await bounded(Promise.all([
            page.waitForResponse(candidate => candidate.request() === destinationRequest, { timeout: remaining(expires) }),
            documentExit ? page.goto(destination, { waitUntil: "domcontentloaded", timeout: remaining(expires) })
              : link.click({ timeout: remaining(expires) }),
          ]), expires);
          demand(response.status() === 200 && !response.fromServiceWorker() && destinationRequest.redirectedTo() === null);
          const [type, cache] = await Promise.all(["content-type", "cache-control"].map(name => response.headerValues(name)));
          const expectedType = documentExit ? /^text\/html(?:;.*)?$/iu : /^text\/x-component(?:;.*)?$/iu;
          demand(type.length === 1 && expectedType.test(type[0]) && cache.length === 1 && privateNoStore({ "cache-control": cache[0] }));
          await bounded(Promise.all([
            page.waitForURL(destination, { timeout: remaining(expires) }),
            page.getByRole("main").getByRole("heading", { level: 1, name: courseTitle, exact: true })
              .waitFor({ state: "visible", timeout: remaining(expires) }),
            until(() => {
              remaining(expires);
              return exit.request && validExitHeaders.has(exitNetworkId) && (!documentExit || exitAborted && trustedEvents.size === 2);
            }, performance.now() + remaining(expires)),
          ]), expires);
          // A request started before teardown can also lose its response.
          // Compare Chromium's epoch clocks, allowing 2 ms for precision.
          if (documentExit) demand(exitRequestedAt + 2 >= Math.min(...trustedEvents.values()));
          const { frameTree: { frame } } = await session.send("Page.getFrameTree");
          demand(frame.id === sourceFrame.id && frame.url === destination && await player.count() === 0);
          active = undefined;
          remaining(expires);
          completed = validateP2LessonExitSaveReceipt({ page: { pathname: lessonPath, status: 200 }, playback: initialized.playback,
            writes: [{ ...initialized.started, resumePositionSeconds: resume, maxPositionSeconds: prior.maxPositionSeconds }, restoredProgress],
            exit: { pathname: academyPath, status: 200, sameDocument: frame.loaderId === sourceFrame.loaderId,
              trustedPagehide: trustedEvents.has("pagehide"), trustedHidden: trustedEvents.has("hidden"), ...exit.posted },
            media: { playedSeconds: Math.floor(native.position), playing: true, manifestObserved: true, segmentObserved: true } }, target);
          return;
        }
        if (prior) {
          await bounded(until(() => media.verified(permit), performance.now() + remaining(expires)), expires);
          const native = await sample(value => value.paused && value.ready >= 2 && Math.floor(value.position) === prior.resumePositionSeconds, expires);
          demand(page.url() === source && remaining(expires) > 0);
          completed = validateP2LessonRestoreReceipt({ page: { pathname: lessonPath, status: 200 }, ...initialized, restored: restoredProgress,
            media: { durationSeconds: Math.floor(native.duration), videoWidth: native.width, restoredSeconds: Math.floor(native.position),
              paused: native.paused, manifestObserved: true, segmentObserved: true } }, target);
          return;
        }
        await sample(value => value.paused && value.ready >= 1 && value.position < 1, expires);
        const [heartbeat, paused, rewind] = writes;
        active = [heartbeat];
        const [first, playing] = await bounded(Promise.all([write(heartbeat, expires),
          sample(value => !value.paused && value.ready >= 2 && value.position >= 10, expires),
          press("play", expires)]), expires);
        active = undefined;
        await sample(value => !value.paused && value.ready >= 2 && value.position >= 14 && value.position < 16, expires);
        active = [paused];
        const [second, stopped] = await bounded(Promise.all([write(paused, expires),
          sample(value => value.paused && value.ready >= 2 && value.position >= 12, expires),
          press("pause", expires, "Enter")]), expires);
        active = [rewind];
        const [third, rewound] = await bounded(Promise.all([write(rewind, expires),
          sample(value => value.paused && value.ready >= 2 && value.position >= 3 && value.position < 7, expires),
          press("play", expires, "ArrowLeft")]), expires);
        active = undefined;
        await page.getByText("Progress saved to your account.", { exact: true }).waitFor({ state: "visible", timeout: remaining(expires) });
        await bounded(until(() => media.verified(permit), performance.now() + remaining(expires)), expires);
        demand(page.url() === source && remaining(expires) > 0);
        completed = validateP2LessonResumeReceipt({ page: { pathname: lessonPath, status: 200 }, ...initialized, writes: [first, second, third],
          media: { durationSeconds: Math.floor(playing.duration), videoWidth: playing.width, heartbeatSeconds: Math.floor(playing.position),
            pausedSeconds: Math.floor(stopped.position), rewoundSeconds: Math.floor(rewound.position), manifestObserved: true, segmentObserved: true } }, target);
      } catch { fail(); throw refusal(); }
    },
    finish() {
      if (failed || !completed || context.serviceWorkers().length || (exitSave ? page.url() !== destination : !media.verified(permit))) throw refusal();
      return completed;
    },
    async confirmFenced() {
      try {
        demand(visibility && !failed && completed && !visibilityFenced && trustedEvents.size === 2
          && trustedEvents.has("freeze") && !context.serviceWorkers().length);
        await boundedFor(checkHiddenDocument(), 5_000);
        demand(!failed && !context.serviceWorkers().length && media.verified(permit));
        visibilityFenced = true;
      } catch { fail(); throw refusal(); }
    },
    async close() {
      if (visibility) {
        visibilityCover?.off("framenavigated", fail);
        visibilityCover?.off("close", fail);
        page.off("close", fail);
      }
      context.off("request", onRequest);
      context.off("requestfailed", onFailure);
      if (documentExit) context.off("requestfinished", onFinished);
      page.off("framenavigated", onNavigation);
      fail();
      media.close();
      stopNetwork?.();
      session?.off("Runtime.bindingCalled", onTrustedExitEvent);
      session?.off("Network.requestWillBeSent", onExitNetworkRequest);
      session?.off("Network.requestWillBeSentExtraInfo", onExitNetworkHeaders);
      await session?.detach().catch(() => {});
    },
  };
}

function quizDocumentHash(document) {
  demand(closed(document, ["version", "mode", "passingPercent", "questions"]) && document.version === 1
    && ["graded", "practice"].includes(document.mode) && Number.isSafeInteger(document.passingPercent)
    && document.passingPercent >= 1 && document.passingPercent <= 100 && Array.isArray(document.questions));
  const canonical = JSON.stringify(document, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
  return createHash("sha256").update(canonical).digest("hex");
}

function readQuizResult(body, target, saved) {
  demand(closed(body, ["quiz"]));
  const { quiz } = body;
  demand(closed(quiz, ["id", "lessonId", "revision", "courseRevision", "document", "createdBy", "createdAt"])
    && uuid(quiz.id) && quiz.lessonId === target.lessonId && quiz.revision === target.quizRevision + Number(saved)
    && quiz.courseRevision === target.revision + Number(saved) && uuid(quiz.createdBy)
    && typeof quiz.createdAt === "string" && Number.isFinite(Date.parse(quiz.createdAt)));
  const documentSha256 = quizDocumentHash(quiz.document);
  if (saved) demand(quiz.createdBy === target.actorId && documentSha256 === target.documentSha256);
  return { courseId: target.courseId, slug: target.slug, lessonId: quiz.lessonId, quizId: quiz.id,
    revision: quiz.courseRevision, quizRevision: quiz.revision, documentSha256 };
}

export function watchP2MediaReservation(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  const target = input.media, origin = input.browserOrigin;
  const pathname = p2InteractiveBrowserEntryPath(input, "owner"), source = origin + pathname;
  const lesson = "/api/admin/lessons/" + target.lessonId, statusPath = lesson + "/video", postPath = lesson + "/video-upload";
  const detailPath = "/api/admin/courses/" + target.courseId;
  const dispatchReviewed = target.operation === p2MediaUploadCallbackOperation;
  const expected = Buffer.from(JSON.stringify(p2MediaReservationBody(target)));
  let statusRequest, reserveRequest, read, reservation, captured, attempted = false, failed = false, reject, accept;
  let heldRoute, heldExpires, heldDeadline, holdTimer, dispatched = false;
  const observed = new Promise((done, fail) => { accept = done; reject = fail; });
  observed.catch(() => {});
  const refusal = () => new Error("P2_MEDIA_RESERVATION_REFUSED");
  const fail = () => { failed = true; reject(refusal()); };
  const matchesPage = request => request.frame() === page.mainFrame() && request.frame().url() === source
    && request.resourceType() === "fetch" && request.redirectedFrom() === null;
  const pattern = "**/*";
  const intercept = async route => {
    try {
      const request = route.request(), url = URL.parse(request.url()), method = request.method();
      demand(!failed && url);
      if (dispatched && method === "GET" && matchesPage(request)
        && [origin + statusPath, origin + detailPath].includes(url.href)) {
        // The regular editor refreshes after fetch settles. Those reads stay local to the fence.
        await route.abort().catch(() => {});
        return;
      }
      if (method === "PUT") {
        demand(!attempted && reservation && matchesPage(request));
        attempted = true;
        const reviewed = await reservation;
        const file = request.postDataBuffer(), headers = await request.allHeaders();
        demand(url.href === reviewed.uploadUrl && url.origin !== origin && url.protocol === "https:" && !url.username && !url.password
          && !headers.authorization && !headers.cookie && headers["content-type"] === target.contentType
          && Buffer.isBuffer(file) && file.length === target.fileBytes
          && createHash("sha256").update(file).digest("hex") === target.fileSha256);
        delete reviewed.uploadUrl;
        captured = validateP2MediaReservationReceipt({ page: { pathname, status: 200 }, read: await read,
          reservation: reviewed.sanitized, outbound: { intercepted: true, sent: false,
            fileSha256: target.fileSha256, fileBytes: target.fileBytes, contentType: target.contentType } }, target);
        if (dispatchReviewed) heldRoute = route;
        accept(captured);
        // Only an authenticated fixed dispatch can continue this route. Page closure discards it.
        return;
      }
      if (method === "POST") {
        demand(!reserveRequest && statusRequest && read && url.href === origin + postPath && matchesPage(request)
          && request.postDataBuffer()?.equals(expected));
        reserveRequest = request;
        await read;
      } else {
        demand(!reserveRequest && (["GET", "HEAD"].includes(method) &&
          (url.origin === origin || !["fetch", "xhr"].includes(request.resourceType()))
          || method === "OPTIONS" && url.origin === origin));
        if (url.origin === origin && url.pathname === statusPath) {
          demand(!statusRequest && method === "GET" && url.href === origin + statusPath && matchesPage(request)
            && request.postDataBuffer() === null);
          statusRequest = request;
        }
      }
      await route.fallback();
    } catch {
      fail();
      await route.abort().catch(() => {});
    }
  };
  const onResponse = response => {
    const request = response.request();
    if (request === statusRequest) {
      read = (async () => {
        const head = await readBrowserResponseHead(response, request, origin, statusPath, "GET", 200);
        const value = await readBrowserResponseJson(response, request, 65_536, true);
        demand(closed(value, ["courseRevision", "current", "latest"]) && value.courseRevision === target.revision
          && (target.currentVideoAssetId === null ? value.current === null :
            value.current?.id === target.currentVideoAssetId && value.current.lessonId === target.lessonId
              && value.current.status === "ready" && value.current.isCurrent === true)
          && (value.latest === null || value.latest?.lessonId === target.lessonId && ["ready", "errored"].includes(value.latest.status)));
        return { requestId: head.requestId, courseRevision: value.courseRevision, currentVideoAssetId: target.currentVideoAssetId };
      })();
      read.catch(fail);
    }
    if (request === reserveRequest) {
      reservation = (async () => {
        const head = await readBrowserResponseHead(response, request, origin, postPath, "POST", 200);
        const body = await readBrowserResponseJson(response, request, 16_384, true);
        demand(closed(body, ["upload", "videoAsset"]) && closed(body.upload, ["id", "timeoutSeconds", "url"])
          && closed(body.videoAsset, ["id", "lessonId", "status"]) && typeof body.upload.url === "string"
          && body.upload.url.length <= 8192);
        const url = URL.parse(body.upload.url);
        demand(url?.protocol === "https:" && url.origin !== origin && !url.username && !url.password && !url.hash);
        return { uploadUrl: url.href, sanitized: { requestId: head.requestId, status: head.status, assetId: body.videoAsset.id,
          lessonId: body.videoAsset.lessonId, assetStatus: body.videoAsset.status, uploadId: body.upload.id,
          uploadTimeoutSeconds: body.upload.timeoutSeconds } };
      })();
      reservation.catch(fail);
    }
  };
  const onFailure = request => { if (request === statusRequest || request === reserveRequest) fail(); };
  const unexpectedPage = other => {
    if (other === page) return;
    fail();
    void other.close().catch(() => {});
  };
  context.on("response", onResponse);
  context.on("requestfailed", onFailure);
  if (dispatchReviewed) context.on("page", unexpectedPage);
  return {
    async open(expires) {
      if (dispatchReviewed) demand(context.pages().length === 1 && context.pages()[0] === page && context.serviceWorkers().length === 0);
      await context.route(pattern, intercept);
      const response = await page.goto(source, { waitUntil: "domcontentloaded", timeout: 30_000 });
      demand(response?.status() === 200 && response.url() === source && page.url() === source);
      const timeout = expires * 1000 - Date.now();
      demand(timeout > 0);
      await page.getByText("draft · Revision " + target.revision, { exact: true }).waitFor({ state: "visible", timeout });
      await page.locator('[data-lesson-id="' + target.lessonId + '"]').getByRole("button",
        { name: "Video and captions", exact: true }).click({ timeout });
      const editor = page.getByRole("region", { name: "Open course editor", exact: true });
      const file = readP2MediaReservationFile(target.filePath, target);
      try {
        await editor.getByLabel("Video file", { exact: true }).setInputFiles({
          name: "certification-video.mp4", mimeType: target.contentType, buffer: file,
        }, { timeout });
        await editor.getByRole("button", { name: target.currentVideoAssetId === null ? "Upload video" : "Upload replacement",
          exact: true }).click({ timeout });
      } finally { file.fill(0); }
    },
    async wait(expires) {
      const timeout = expires * 1000 - Date.now();
      demand(!failed && timeout > 0);
      let timer;
      try {
        await Promise.race([observed, new Promise((_, refuse) => { timer = setTimeout(() => refuse(refusal()), timeout); })]);
      } finally { clearTimeout(timer); }
    },
    finish() {
      demand(!dispatchReviewed && !failed && captured && attempted && page.isClosed() && context.serviceWorkers().length === 0);
      return captured;
    },
    hold(expires) {
      demand(dispatchReviewed && !failed && captured && heldRoute && heldExpires === undefined && !page.isClosed()
        && context.serviceWorkers().length === 0 && Number.isSafeInteger(expires) && Date.now() < expires * 1000);
      heldExpires = expires;
      const remaining = expires * 1000 - Date.now();
      heldDeadline = performance.now() + remaining;
      holdTimer = setTimeout(() => { fail(); void page.close().catch(() => {}); }, remaining);
      return captured;
    },
    async dispatch(intent) {
      let timer;
      const route = heldRoute;
      heldRoute = undefined;
      try {
        validateP2MediaDispatchIntent(intent, heldExpires);
        demand(dispatchReviewed && !failed && route && !dispatched && !page.isClosed() && context.serviceWorkers().length === 0);
        const remaining = Math.min(heldDeadline - performance.now(), intent.expiresAt * 1000 - Date.now());
        demand(remaining > 0);
        const dispatchDeadline = performance.now() + remaining;
        const request = route.request();
        dispatched = true;
        const completed = async () => {
          await route.continue();
          const response = await request.response();
          demand(response && response.request() === request && response.url() === request.url()
            && !response.fromServiceWorker() && request.redirectedTo() === null);
          const receipt = validateP2MediaDispatchReceipt({ attempted: true, status: response.status() });
          // A final 204 has no body. Chromium can report ERR_ABORTED after receiving it.
          if (receipt.status !== 204) demand(await response.finished() === null && request.failure() === null);
          return receipt;
        };
        const receipt = await Promise.race([completed(), new Promise((_, refuse) => {
          timer = setTimeout(() => refuse(refusal()), remaining);
        })]);
        await page.close();
        demand(!failed && page.isClosed() && performance.now() < dispatchDeadline && Date.now() < intent.expiresAt * 1000);
        return receipt;
      } catch { throw new Error("P2_MEDIA_DISPATCH_REFUSED"); }
      finally {
        clearTimeout(timer);
        clearTimeout(holdTimer);
        if (!page.isClosed()) await page.close().catch(() => {});
      }
    },
    async close() {
      clearTimeout(holdTimer);
      heldRoute = undefined;
      context.off("response", onResponse);
      context.off("requestfailed", onFailure);
      if (dispatchReviewed) context.off("page", unexpectedPage);
      // Do not remove the write fence while the selected browser page is open.
      if (!page.isClosed()) await page.close().catch(() => {});
      if (page.isClosed()) await context.unroute(pattern, intercept).catch(() => {});
      fail();
    },
  };
}

function watchAuthoringReadWrite(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  const target = input.authoring, published = publishedOutcome(target), origin = input.browserOrigin;
  const quiz = authoringQuiz(input), republish = authoringRepublish(input), requiresWrite = quiz || published;
  const { detail, readiness } = p2AuthoringPublicationPaths(target);
  const source = origin + p2InteractiveBrowserEntryPath(input, "owner");
  const reviewRevision = target.revision + Number(republish);
  const expectedPatch = Buffer.from(JSON.stringify({ expectedRevision: reviewRevision, status: "published" }));
  const expectedDraft = republish && Buffer.from(JSON.stringify({ expectedRevision: target.revision, status: "draft" }));
  const quizPath = quiz ? p2AuthoringQuizPath(target) : undefined;
  const prior = { method: "GET", pathname: quiz ? quizPath : readiness, status: quiz && target.quizRevision === 0 ? 404 : 200 };
  const write = { method: quiz ? "PUT" : "PATCH", pathname: quiz ? quizPath : detail, status: 200 };
  const draft = { method: "PATCH", pathname: detail, status: 200 };
  const draftRead = { method: "GET", pathname: detail, status: 200 };
  const publishedRead = { method: "GET", pathname: detail, status: 200 };
  const steps = republish ? [draft, draftRead, prior, ...(published ? [write, publishedRead] : [])] : [prior, write];
  const refusal = () => new Error("P2_INTERACTIVE_AUTHORING_RESPONSE_REFUSED");
  let failed = false, qualified = false, receipt, accept, reject, stepIndex = 0;
  const observed = new Promise((resolve, refuse) => { accept = resolve; reject = refuse; });
  observed.catch(() => {});
  const fail = () => { failed = true; reject(refusal()); };
  const onRequest = request => {
    const url = URL.parse(request.url());
    if (url?.origin !== origin) return;
    const method = request.method();
    const observedRepublishRequest = url.pathname === detail || url.pathname === readiness || !["GET", "HEAD", "OPTIONS"].includes(method);
    if (republish && observedRepublishRequest && !steps[stepIndex]) return fail();
    const step = republish ? (observedRepublishRequest ? steps[stepIndex] : undefined)
      : url.pathname === prior.pathname && (!quiz || method === "GET") ? prior
        : url.pathname === write.pathname && method !== "GET" ? write : undefined;
    if (!step) return;
    try {
      const frame = request.frame();
      demand(!failed && !step.request && frame === page.mainFrame() && frame.url() === source && !url.search && !url.hash
        && url.pathname === step.pathname && method === step.method && request.resourceType() === "fetch" && request.redirectedFrom() === null);
      if (republish && stepIndex > 0) demand(steps[stepIndex - 1].response);
      const bytes = request.postDataBuffer();
      if (method === "GET") demand(bytes === null);
      else if (republish) demand(Buffer.isBuffer(bytes) && bytes.equals(step === draft ? expectedDraft : expectedPatch));
      else {
        demand(requiresWrite && prior.response && Buffer.isBuffer(bytes));
        if (quiz) {
          const body = exactBrowserJson(bytes, maxAuthoringBody);
          demand(createHash("sha256").update(bytes).digest("hex") === target.bodySha256
            && closed(body, ["expectedCourseRevision", "document"]) && body.expectedCourseRevision === target.revision
            && quizDocumentHash(body.document) === target.documentSha256);
        } else demand(bytes.equals(expectedPatch));
      }
      step.request = request;
      if (republish) stepIndex++;
    } catch { fail(); }
  };
  const onResponse = response => {
    const request = response.request(), step = steps.find(candidate => request === candidate.request);
    if (!step) return;
    if (failed || step.response) return fail();
    step.response = (async () => {
      const predecessor = republish && steps[steps.indexOf(step) - 1];
      if (predecessor) await predecessor.response;
      const head = await readBrowserResponseHead(response, request, origin, step.pathname, step.method, step.status);
      // The normal quiz editor handles the first GET's 404 without reading its body.
      if (step.status === 404) return { head };
      const body = await readBrowserResponseJson(response, request, maxAuthoringBody);
      if (quiz) return { head, result: readQuizResult(body, target, step === write) };
      if (step === prior) {
        demand(closed(body, ["courseId", "courseRevision", "ready", "issues"]) && body.courseId === target.courseId
          && body.courseRevision === reviewRevision && body.ready === published && Array.isArray(body.issues)
          && body.issues.every(issue => publicationIssueCode(issue?.code)));
        const codes = [...new Set(body.issues.map(issue => issue.code))].sort();
        demand(codes.length === target.issueCodes.length && target.issueCodes.every((code, index) => code === codes[index]));
        return { head, codes };
      }
      const result = readCourseResult(body);
      const draftState = republish && (step === draft || step === draftRead);
      demand(result.courseId === target.courseId && result.slug === target.slug
        && result.revision === reviewRevision + Number(!draftState) && result.status === (draftState ? "draft" : "published"));
      return { head, result };
    })();
    void step.response.then(async value => {
      if (failed || (republish ? step !== steps.at(-1) : requiresWrite && step === prior)) return;
      const reviewed = step === prior ? value : await prior.response;
      if (failed) return;
      if (quiz) {
        demand(reviewed.result?.quizId !== value.result.quizId);
        receipt = validateP2AuthoringMutationReceipt({ prior: reviewed.head, save: value.head, body: value.result }, target);
      } else {
        const draftReceipt = republish && await draft.response;
        const publication = published && (republish ? (await write.response).head : value.head);
        receipt = validateP2AuthoringMutationReceipt({ ...(republish ? { draft: draftReceipt.head } : {}), readiness: reviewed.head,
          ...(published ? { publication } : {}), body: { ...(published ? value.result
            : { courseId: target.courseId, slug: target.slug, revision: reviewRevision, status: "draft" }), issueCodes: reviewed.codes } }, target);
      }
      accept(receipt);
    }).catch(fail);
  };
  const onFailure = request => { if (steps.some(step => request === step.request)) fail(); };
  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onFailure);
  return {
    async wait(expires) {
      const remaining = expires * 1000 - Date.now();
      if (failed || remaining <= 0 || remaining > input.windowSeconds * 1000) throw refusal();
      let timer;
      try {
        await Promise.race([observed, new Promise((_, timeout) => { timer = setTimeout(() => timeout(refusal()), remaining); })]);
        const timeout = expires * 1000 - Date.now();
        if (failed || timeout <= 0) throw refusal();
        const feedback = quiz ? "Quiz revision saved. Previous attempts remain in history."
          : published ? "Course published." : "Resolve these items before publishing";
        const status = quiz ? "draft" : receipt.body.status;
        await Promise.all([
          page.getByRole("status").getByText(feedback, { exact: true }).waitFor({ state: "visible", timeout }),
          page.getByText(status + " · Revision " + receipt.body.revision, { exact: true }).waitFor({ state: "visible", timeout }),
        ]).catch(() => { throw refusal(); });
        if (failed || republish && page.url() !== source || !requiresWrite && await page.getByRole("button", { name: "Publish course", exact: true })
          .and(page.locator("button:enabled")).count() !== 0) throw refusal();
        qualified = true;
      } finally { clearTimeout(timer); }
    },
    finish() {
      if (failed || !qualified || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailure);
      fail();
    },
  };
}

export function watchP2AuthoringMutation(context, page, input) {
  demand(input.stage === "authoring" && !isP2InteractiveAuthoringPair(input));
  if (authoringPublication(input) || authoringQuiz(input) || authoringRepublish(input)) return watchAuthoringReadWrite(context, page, input);
  return watchMutation(context, page, input);
}

export async function installP2PaidArchiveObserver(page, input) {
  demand(authoringArchive(input));
  const path = p2InteractiveBrowserEntryPath(input, "owner");
  await page.addInitScript(({ origin, path }) => {
    const atCourse = () => location.origin === origin && location.pathname === path && !location.search && !location.hash;
    if (window.top !== window || !atCourse()) return;
    const warningParagraphs = [
      "Archiving denies protected lessons, new playback, assessments and progress updates, including access from existing purchases. Already issued video access may continue for up to 600 seconds.",
      "Course and lesson identifiers, independent grants, progress and assessment and audit history remain. Community access depends on remaining eligible courses and grants.",
      "Archiving does not issue a refund or cancel a payment. Support and refund requests follow existing applicable terms and owner review.",
      "Restoring access requires an explicit republish that passes current publication checks. Republish cannot override revoked or expired grants, suspension or account deletion.",
    ];
    const warning = () => document.querySelector('section[aria-labelledby="paid-archive-heading"]');
    const text = element => element?.textContent?.replace(/\s+/gu, " ").trim();
    const visible = element => element && element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]')
      && getComputedStyle(element).visibility === "visible" && getComputedStyle(element).opacity !== "0";
    const completeWarning = section => {
      const heading = section?.querySelector("h3#paid-archive-heading"), paragraphs = [...(section?.querySelectorAll("p") ?? [])];
      return visible(section) && visible(heading) && text(heading) === "Before archiving this paid course"
        && paragraphs.length === warningParagraphs.length
        && paragraphs.every((paragraph, index) => visible(paragraph) && text(paragraph) === warningParagraphs[index]);
    };
    let step = "initial";
    const observe = () => {
      const section = warning();
      if (step === "opening-first" && completeWarning(section)) step = "first-visible";
      if (step === "canceling" && !section) step = "canceled";
      if (step === "opening-second" && completeWarning(section)) step = "second-visible";
    };
    const observer = new MutationObserver(observe);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener("click", event => {
      if (!event.isTrusted || !atCourse()) return;
      const button = event.target instanceof Element ? event.target.closest("button") : null, label = text(button);
      if (!button || button.disabled || !visible(button) || !["Archive course", "Cancel archive", "Archive paid course"].includes(label)) return;
      observe();
      const section = warning();
      if (label === "Archive course" && !section && step === "initial") step = "opening-first";
      else if (label === "Archive course" && !section && step === "canceled") step = "opening-second";
      else if (label === "Cancel archive" && step === "first-visible" && completeWarning(section) && section.contains(button)) step = "canceling";
      else if (label === "Archive paid course" && step === "second-visible" && completeWarning(section) && section.contains(button)) step = "confirming";
      else step = "invalid";
    }, { capture: true, passive: true });
    Object.defineProperty(window, "__lashP2qConsumePaidArchive", { value: () => {
      const qualified = atCourse() && step === "confirming";
      step = "consumed";
      observer.disconnect();
      return qualified;
    } });
  }, { origin: input.browserOrigin, path });
}

const titleField = page => page.getByRole("textbox", { name: "Course title", exact: true });
const titleHash = value => createHash("sha256").update(value).digest("hex");

async function installReorderKeyboardObserver(page, origin, path, kind) {
  await page.addInitScript(({ origin, path, kind }) => {
    if (window.top !== window || location.origin !== origin || location.pathname !== path) return;
    const labelPattern = new RegExp("^Move " + kind + " .+ (?:up|down)$", "u");
    const button = target => {
      const element = target instanceof Element ? target.closest("button") : null;
      const label = element?.getAttribute("aria-label");
      return element && !element.disabled && label && label.length <= 512 && labelPattern.test(label) ? element : null;
    };
    let pending, activated;
    const options = { capture: true, passive: true };
    window.addEventListener("keydown", event => {
      pending = activated = undefined;
      const selected = button(event.target);
      if (selected && event.isTrusted && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && (event.key === "Enter" || event.key === " ")) pending = { selected, at: performance.now() };
    }, options);
    window.addEventListener("pointerdown", () => { pending = activated = undefined; }, options);
    window.addEventListener("click", event => {
      const key = pending;
      pending = activated = undefined;
      if (key && event.isTrusted && event.detail === 0 && button(event.target) === key.selected
        && performance.now() - key.at <= 2000) activated = performance.now();
    }, options);
    Object.defineProperty(window, "__lashP2qConsumeReorderKey", { value: () => {
      const at = activated;
      activated = undefined;
      return location.origin === origin && location.pathname === path && at !== undefined && performance.now() - at <= 1000;
    } });
  }, { origin, path, kind });
}

export function watchP2AuthoringEdits(context, winnerPage, stalePage, input) {
  demand(isP2InteractiveAuthoringPair(input) && winnerPage !== stalePage && winnerPage.context() === context && stalePage.context() === context);
  const reorder = authoringReorder(input);
  let ready = false, winnerAccepted = false, conflictVisible = false, startingTitle, submittedTitle, dirtyInputPreserved = false;
  const acceptReorder = async (frame, stale) => {
    demand(ready && (!stale || winnerAccepted));
    demand(await frame.evaluate(() => window.__lashP2qConsumeReorderKey?.() === true));
  };
  const winner = watchMutation(context, winnerPage, input, {
    role: "winner", peer: stalePage, acceptTitle: () => demand(ready), observeReceipt: () => { winnerAccepted = true; },
    acceptReorder: frame => acceptReorder(frame, false),
  });
  const stale = watchMutation(context, stalePage, input, {
    role: "stale", peer: winnerPage, acceptTitle: title => {
      demand(ready && winnerAccepted);
      submittedTitle = titleHash(title);
      demand(submittedTitle !== startingTitle);
    }, observeReceipt: () => {}, acceptReorder: frame => acceptReorder(frame, true),
  });
  const remaining = deadline => {
    const timeout = deadline - Date.now();
    demand(timeout > 0);
    return timeout;
  };
  return {
    async open(expires) {
      demand(!ready);
      const path = p2InteractiveBrowserEntryPath(input, "owner");
      const deadline = Math.min(Date.now() + 30_000, expires * 1000), url = input.browserOrigin + path;
      for (const page of [winnerPage, stalePage]) {
        if (reorder) await installReorderKeyboardObserver(page, input.browserOrigin, path, input.authoring.kind);
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining(deadline) });
        demand(response?.status() === 200 && response.url() === url && page.url() === url);
        if (reorder) {
          const control = page.getByRole("button", { name: new RegExp("^Move " + input.authoring.kind + " .+ (?:up|down)$", "u") })
            .and(page.locator("button:enabled")).first();
          await Promise.all([control.waitFor({ state: "visible", timeout: remaining(deadline) }),
            page.getByText("draft · Revision " + input.authoring.revision, { exact: true }).waitFor({ state: "visible", timeout: remaining(deadline) })]);
        } else {
          const title = titleField(page), save = page.getByRole("button", { name: "Save course details", exact: true });
          await Promise.all([title.waitFor({ state: "visible", timeout: remaining(deadline) }), save.waitFor({ state: "visible", timeout: remaining(deadline) })]);
          demand(await title.isEditable({ timeout: remaining(deadline) }) && await save.isEnabled({ timeout: remaining(deadline) }));
          const value = await title.inputValue({ timeout: remaining(deadline) });
          demand(value.trim().length > 0 && (!startingTitle || startingTitle === titleHash(value)));
          startingTitle = titleHash(value);
        }
      }
      ready = true;
      await winnerPage.bringToFront();
    },
    async wait(expires) {
      demand(ready);
      await Promise.all([winner.wait(expires), stale.wait(expires)]);
      const { requestId } = stale.finish(), deadline = expires * 1000;
      const text = "This course changed or is not ready for this operation. Reload before trying again. Reference: " + requestId;
      await stalePage.getByRole("alert").getByText(text, { exact: true }).waitFor({ state: "visible", timeout: remaining(deadline) });
      conflictVisible = true;
      if (!reorder) {
        const title = await titleField(stalePage).inputValue({ timeout: remaining(deadline) });
        demand(titleHash(title) === submittedTitle);
        dirtyInputPreserved = true;
      }
    },
    finish() {
      demand(conflictVisible);
      if (reorder) return validateP2AuthoringReorderResponses({ winner: winner.finish(), stale: { ...stale.finish(), outcome: "conflict" } }, input.authoring);
      return validateP2AuthoringEditResponses({ winner: winner.finish(),
        stale: { ...stale.finish(), outcome: "conflict", dirtyInputPreserved } }, input.authoring);
    },
    close() { winner.close(); stale.close(); },
  };
}

export function validateP2LifecycleBrowserInput(input) {
  demand(closed(input, ["version", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit", "deploymentId", "deploymentUrl", "browserOrigin", "userId", "courseId", "lessonId", "windowSeconds"])
    && input.version === 1 && input.environment === "staging" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId)
    && sha(input.challenge) && sha(input.bindingSha256) && /^[a-f0-9]{40}$/u.test(input.sourceCommit)
    && /^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId) && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.deploymentUrl)
    && input.browserOrigin === "https://staging.lashher.com" && [input.userId, input.courseId, input.lessonId].every(uuid) && input.windowSeconds === 840);
  return input;
}

export function parseP2PlaybackObservation(status, headers, body, initial = false) {
  demand(privateNoStore(headers));
  if (initial) {
    demand(status === 200 && closed(body, ["expiresAt", "playbackId", "playbackToken", "thumbnailExpiresAt", "thumbnailToken"])
      && typeof body.playbackToken === "string" && body.playbackToken.length > 20 && typeof body.thumbnailToken === "string"
      && Number.isFinite(Date.parse(body.expiresAt)) && Number.isFinite(Date.parse(body.thumbnailExpiresAt))
      && typeof body.playbackId === "string" && body.playbackId.length > 0 && Number.isFinite(Date.parse(headers.date)));
    // Tokens and playback identifiers are deliberately discarded in memory.
    const lifetimeMs = Math.min(Date.parse(body.expiresAt), Date.parse(body.thumbnailExpiresAt)) - Date.parse(headers.date);
    demand(lifetimeMs >= 590_000 && lifetimeMs <= 601_000);
    return { httpStatus: 200, serverDate: headers.date, expiresAt: body.expiresAt, thumbnailExpiresAt: body.thumbnailExpiresAt, lifetimeMs, privateNoStore: true };
  }
  demand(status === 401 && closed(body, ["error", "requestId"]) && closed(body.error, ["code", "message"])
    && body.error.code === "sign_in_required" && typeof body.error.message === "string" && uuid(body.requestId)
    && headers["x-request-id"] === body.requestId);
  return { httpStatus: 401, errorCode: "sign_in_required", requestId: body.requestId, privateNoStore: true };
}

export function parseP2OwnerSuspensionResponse(status, headers, body) {
  demand(status === 202 && privateNoStore(headers) && uuid(headers["x-request-id"])
    && closed(body, ["commandId", "accountVersion", "action", "status"]) && uuid(body.commandId)
    && Number.isSafeInteger(body.accountVersion) && body.accountVersion >= 1 && body.action === "suspend" && body.status === "pending");
  return { ...body, requestId: headers["x-request-id"] };
}

async function boundedJson(response) {
  const raw = await response.body(); demand(raw.length > 0 && raw.length <= 65536); return JSON.parse(raw.toString("utf8"));
}
function exactResponse(response, page, origin, path, method) {
  const request = response.request(), url = new URL(response.url());
  return request.frame() === page.mainFrame() && url.origin === origin && url.pathname === path && url.search === ""
    && request.method() === method && request.redirectedFrom() === null && request.redirectedTo() === null;
}
async function until(check, deadline) {
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await pause(250); }
  throw new Error("P2_LIFECYCLE_BROWSER_TIMEOUT");
}

// This exported source routine is exercised with owned pages in tests. The live
// entry below creates its own real Playwright pages and never accepts a page,
// callback, browser endpoint, storage state or launch argument over IPC.
export async function recordP2SuspensionBrowser(input, pages, control) {
  validateP2LifecycleBrowserInput(input);
  const { customer, owner } = pages, origin = input.browserOrigin, started = performance.now(), deadline = started + 840_000;
  const events = [], event = (type, detail) => { const value = { type, observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...detail }; events.push(value); return value; };
  const playbackPath = `/api/academy/lessons/${input.lessonId}/playback`;
  const initialResponse = customer.waitForResponse(response => exactResponse(response, customer, origin, playbackPath, "GET"), { timeout: 60_000 });
  await customer.goto(`${origin}/academy/courses/${input.courseId}/lessons/${input.lessonId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const initial = await initialResponse;
  const baseline = event("ordinary-playback-authorized", parseP2PlaybackObservation(initial.status(), await initial.allHeaders(), await boundedJson(initial), true));
  await until(async () => await customer.locator("mux-player").count() === 1, Math.min(deadline, performance.now() + 60_000));
  event("player-present", { muxPlayerCount: 1 });
  await control.baseline(baseline); // Parent records its pre-suspend token first.
  demand(performance.now() < deadline);
  const adminSession = await owner.request.get(`${origin}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
  demand(adminSession.status() === 200);
  const session = await adminSession.json(), authenticatedAt = session?.user?.authenticatedAt;
  demand(Number.isInteger(authenticatedAt) && Date.now() - authenticatedAt * 1000 >= 0 && Date.now() - authenticatedAt * 1000 < 240_000);
  await owner.goto(`${origin}/admin/customer-accounts`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await owner.getByRole("heading", { name: "Customer account lifecycle", exact: true }).waitFor({ timeout: 15_000 });
  await owner.getByLabel("Customer UUID", { exact: true }).fill(input.userId);
  await owner.getByLabel("Action", { exact: true }).selectOption("suspend");
  const renewal = customer.waitForResponse(response => exactResponse(response, customer, origin, playbackPath, "GET"), { timeout: Math.max(1, deadline - performance.now()) });
  const commandResponse = owner.waitForResponse(response => exactResponse(response, owner, origin, `/api/admin/customer-accounts/${input.userId}/commands`, "POST"), { timeout: 30_000 });
  await owner.getByRole("button", { name: "Record account command", exact: true }).click();
  const response = await commandResponse, request = response.request(), posted = request.postDataJSON();
  demand(closed(posted, ["action", "idempotencyKey"]) && posted.action === "suspend" && uuid(posted.idempotencyKey));
  const suspension = event("ordinary-owner-suspension-accepted", parseP2OwnerSuspensionResponse(response.status(), await response.allHeaders(), await boundedJson(response)));
  await control.suspended(suspension);
  const denied = await renewal;
  const denial = event("ordinary-renewal-denied", parseP2PlaybackObservation(denied.status(), await denied.allHeaders(), await boundedJson(denied)));
  await until(async () => await customer.locator("mux-player").count() === 0
    && await customer.getByRole("alert").filter({ hasText: "Your session has ended. Sign in again to continue." }).count() === 1, deadline);
  event("player-removed", { muxPlayerCount: 0, sessionEndedAlert: true });
  demand(denial.elapsedMs > suspension.elapsedMs && denial.elapsedMs - baseline.elapsedMs > 0 && performance.now() < deadline);
  return { version: 1, status: "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED", environment: "staging", actionId: input.actionId,
    challenge: input.challenge, bindingSha256: input.bindingSha256, sourceCommit: input.sourceCommit, deploymentId: input.deploymentId,
    deploymentUrl: input.deploymentUrl, browserOrigin: origin, userId: input.userId, courseId: input.courseId, lessonId: input.lessonId, events,
    contextsIsolated: true, sessionsFabricated: false, clockChanged: false, requestsIntercepted: false,
    playbackRemovalAfterSuspensionMs: events.at(-1).elapsedMs - suspension.elapsedMs,
    tokensRetained: false, rawHarRetained: false, nativeInvocationQualified: false, releaseAccepted: false };
}

function receiveBrowserMessage(timeout) {
  return new Promise((done, fail) => {
    const clean = () => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", lost);
    };
    const lost = () => { clean(); fail(new Error("P2_BROWSER_PARENT_UNAVAILABLE")); };
    const receive = message => { clean(); done(message); };
    const timer = setTimeout(lost, timeout);
    process.once("message", receive);
    process.once("disconnect", lost);
  });
}

function sendBrowserMessage(message) {
  return new Promise((done, fail) => process.send(message, error => error ? fail(error) : done()));
}

const interactiveBinding = input => ({ challenge: input.challenge, bindingSha256: input.bindingSha256, stage: input.stage, epoch: input.epoch });

async function runInteractiveBrowser(first) {
  let input = validateP2InteractiveBrowserInput(first), binding = interactiveBinding(input);
  const send = (type, value = {}) => sendBrowserMessage({ type, ...binding, ...value });
  const next = () => {
    const pending = receiveBrowserMessage(300_000);
    pending.catch(() => {}); // An IPC send can fail before the caller awaits this receive.
    return pending;
  };
  let browser, context, page, peer, peerPage, selection, mutationWatch, identityOpenedAt, verifiedIdentity, staleSessionProofs;
  let opened = false, cleared = false, browserFenced = false, mediaHeld = false;
  const permitPipe = new Socket({ fd: 4, readable: true, writable: false });
  permitPipe.pause();
  const contexts = new Map(), actions = new Set([input.actionId]);
  const lost = () => { if (browser) void browser.close().catch(() => {}); };
  const terminate = () => { if (process.connected) process.disconnect(); else lost(); };
  process.once("disconnect", lost);
  process.once("SIGTERM", terminate);
  try {
    let pending = next();
    await send("interactive-initialized");
    while (true) {
      const command = await pending;
      demand(closed(command, ["type", "input"]) && command.input?.challenge === binding.challenge
        && command.input.bindingSha256 === binding.bindingSha256 && command.input.stage === binding.stage && command.input.epoch === binding.epoch);
      const received = command.input;
      if (command.type === "interactive-close") {
        demand(closed(received, Object.keys(binding)));
        break;
      }
      if (command.type === "interactive-select") {
        demand(cleared && !input.identityEnrollment && !input.firstOwner && !heldLessonStages.includes(input.stage)
          && closed(received, [...Object.keys(binding), "next"]));
        const selectedInput = validateP2InteractiveBrowserInput(received.next);
        demand(!selectedInput.identityEnrollment && !selectedInput.firstOwner && ["challenge", "sourceCommit", "deploymentId", "deploymentUrl", "browserOrigin"].every(key => selectedInput[key] === input[key])
          && actions.size < 24 && !actions.has(selectedInput.actionId) && selectedInput.bindingSha256 !== input.bindingSha256
          && BigInt(selectedInput.epoch) > BigInt(input.epoch));
        if (["authoring", "media", "paid-grant", "paid-revoke"].includes(selectedInput.stage)) demand(input.stage === "identity" && verifiedIdentity?.actorKind === "admin"
          && verifiedIdentity.actorId === (selectedInput.authoring ?? selectedInput.media ?? selectedInput.paidGrant ?? selectedInput.paidRevoke).actorId
          && BigInt(selectedInput.epoch) === BigInt(input.epoch) + 2n);
        if (learnerScopedStages.includes(selectedInput.stage)) demand(input.stage === "identity" && verifiedIdentity?.actorKind === "customer"
          && verifiedIdentity.actorId === (selectedInput.learning ?? selectedInput.learnerAccess ?? selectedInput.lessonEntry ?? selectedInput.lessonDenial
            ?? selectedInput.assessment ?? selectedInput.resume ?? selectedInput.restore ?? selectedInput.ackLoss ?? selectedInput.exitSave
            ?? selectedInput.visibility ?? selectedInput.staleRevision).actorId
          && BigInt(selectedInput.epoch) === BigInt(input.epoch) + 2n);
        const staleRevision = selectedInput.stage === "lesson-stale-revision";
        demand(staleRevision === (input.identity?.sessionCount === 2));
        if (staleRevision) {
          demand(verifiedIdentity?.sessionProofs?.length === 2 && contexts.has("learner-peer"));
          staleSessionProofs = verifiedIdentity.sessionProofs;
        }
        actions.add(selectedInput.actionId);
        input = selectedInput;
        binding = interactiveBinding(input);
        selection = context = page = peer = peerPage = identityOpenedAt = verifiedIdentity = undefined;
        opened = cleared = false;
        pending = next();
        await send("interactive-selected");
        continue;
      }
      const captureIdentity = command.type === "interactive-capture-identity";
      const ownerIdentity = captureIdentity && binding.stage === "identity" && p2InteractiveIdentityContext(input) === "owner" && !input.firstOwner;
      const mediaDispatch = command.type === "interactive-dispatch-media";
      demand(closed(received, [...Object.keys(binding), "context", "expires", ...(ownerIdentity ? ["ownerSubjectSha256"] : []),
        ...(mediaDispatch ? ["dispatch"] : [])]) && Number.isSafeInteger(received.expires));
      const path = p2InteractiveBrowserEntryPath(input, received.context);
      const pairedIdentity = input.identity?.sessionCount === 2;
      const staleRevision = binding.stage === "lesson-stale-revision";
      if (command.type === "interactive-install") {
        demand(selection === undefined && (binding.stage !== "lifecycle" || received.context === input.lifecycle.context)
          && (binding.stage !== "identity" || received.context === p2InteractiveIdentityContext(input))
          && (!learnerScopedStages.includes(binding.stage) || contexts.has("learner"))
          && (!["media", "paid-grant", "paid-revoke"].includes(binding.stage) || contexts.has("owner")));
        selection = { context: received.context, expires: received.expires };
        const permit = await readP2InteractiveBrowserPermit(permitPipe, input, selection);
        try {
          if (!browser) {
            const { chromium } = await import("playwright");
            browser = await chromium.launch({ headless: false });
          }
          context = contexts.get(received.context);
          if (pairedIdentity) demand(!context && !contexts.has("learner-peer"));
          if (!context) {
            context = await browser.newContext(received.context === "owner" ? { serviceWorkers: "block" } : undefined);
            contexts.set(received.context, context);
          }
          if (pairedIdentity) {
            peer = await browser.newContext();
            contexts.set("learner-peer", peer);
          } else if (staleRevision) {
            peer = contexts.get("learner-peer");
            demand(peer && peer !== context && staleSessionProofs);
            const proofs = await Promise.all([context, peer].map(device => customerSessionProof(device, input)));
            demand(proofs.every((proof, index) => proof === staleSessionProofs[index]));
          }
          await installP2InteractiveBrowserCookie(context, permit, input);
          if (peer) await installP2InteractiveBrowserCookie(peer, permit, input);
        } finally { permit.cookie = ""; }
        pending = next();
        await send("interactive-permit-installed", selection);
        continue;
      }
      demand(selection && received.context === selection.context && received.expires === selection.expires && context);
      if (command.type === "interactive-confirm-visibility-fenced" || command.type === "interactive-confirm-stale-revision-fenced") {
        const stage = staleRevision ? "stale-revision" : "visibility";
        demand(binding.stage === "lesson-" + stage && command.type === "interactive-confirm-" + stage + "-fenced"
          && cleared && mutationWatch && !browserFenced);
        await mutationWatch.confirmFenced();
        browserFenced = true;
        pending = next();
        await send("interactive-" + stage + "-fenced", selection);
        continue;
      }
      demand(!cleared);
      if (mediaHeld || mediaDispatch) {
        demand(mediaHeld && mediaDispatch && selection.context === "owner" && binding.stage === "media"
          && input.media.operation === p2MediaUploadCallbackOperation && mutationWatch);
        const response = await mutationWatch.dispatch(received.dispatch);
        await context.close();
        await mutationWatch.close();
        mutationWatch = undefined;
        contexts.delete("owner");
        mediaHeld = false;
        cleared = true;
        pending = next();
        await send("interactive-media-dispatched", { ...selection, response });
        continue;
      }
      if (command.type === "interactive-open") {
        demand(!opened && Date.now() < selection.expires * 1000);
        opened = true;
        if (binding.stage === "identity") identityOpenedAt = Date.now();
        page = await context.newPage();
        let httpStatus;
        if (pairedIdentity) {
          demand(peer && peer !== context);
          peerPage = await peer.newPage();
          const url = input.browserOrigin + path;
          const responses = await Promise.all([page, peerPage].map(device => device.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })));
          demand(responses.every(response => response?.status() === 200 && response.url() === url));
          httpStatus = 200;
        } else if (staleRevision) {
          demand(peer && peer !== context);
          peerPage = await peer.newPage();
          mutationWatch = watchP2LessonStaleRevision(context, page, peer, peerPage, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (isP2InteractiveAuthoringPair(input)) {
          const stale = await context.newPage();
          mutationWatch = watchP2AuthoringEdits(context, page, stale, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "media") {
          mutationWatch = watchP2MediaReservation(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "learner-access") {
          mutationWatch = watchP2PaidLearnerAccess(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-entry") {
          mutationWatch = watchP2LessonEntry(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-denial") {
          mutationWatch = watchP2LessonDenial(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-assessment") {
          mutationWatch = watchP2LessonAssessment(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-resume") {
          mutationWatch = watchP2LessonResume(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-restore") {
          mutationWatch = watchP2LessonRestore(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-ack-loss") {
          mutationWatch = watchP2LessonAckLoss(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-exit-save") {
          mutationWatch = watchP2LessonExitSave(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "lesson-visibility-save") {
          mutationWatch = watchP2LessonVisibility(context, page, input, hideP2LessonDocument);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else if (binding.stage === "learning" && learningEnrollmentReplay(input.learning)) {
          mutationWatch = watchP2LearningEnrollment(context, page, input);
          await mutationWatch.open(selection.expires);
          httpStatus = 200;
        } else {
          if (binding.stage === "lifecycle") mutationWatch = watchP2LifecycleMutation(context, page, input);
          if (binding.stage === "authoring") mutationWatch = watchP2AuthoringMutation(context, page, input);
          if (authoringArchive(input)) await installP2PaidArchiveObserver(page, input);
          if (binding.stage === "learning") mutationWatch = watchP2LearningEnrollment(context, page, input);
          if (binding.stage === "paid-grant") mutationWatch = watchP2PaidGrant(context, page, input);
          if (binding.stage === "paid-revoke") {
            mutationWatch = watchP2PaidRevoke(context, page, input);
            await installP2PaidRevokeObserver(page, input);
          }
          const url = input.browserOrigin + path;
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          httpStatus = response?.status();
          demand(Number.isInteger(httpStatus));
          if (binding.stage === "learning") {
            const timeout = selection.expires * 1000 - Date.now();
            demand(timeout > 0 && httpStatus === 200 && response.url() === url && page.url() === url);
            await page.getByRole("button", { name: "Enroll for free", exact: true }).and(page.locator("button:enabled"))
              .waitFor({ state: "visible", timeout });
          }
          if (binding.stage === "paid-grant") {
            const timeout = selection.expires * 1000 - Date.now();
            demand(timeout > 0 && httpStatus === 200 && response.url() === url && page.url() === url);
            const form = page.getByRole("region", { name: "Manual course access", exact: true }).locator("form");
            const revision = `Selected published paid course revision: ${input.paidGrant.revision}.`;
            const submit = form.getByRole("button", { name: "Grant manual access", exact: true }).and(page.locator("button:enabled"));
            await Promise.all([submit.waitFor({ state: "visible", timeout }), page.getByText(revision, { exact: true }).waitFor({ state: "visible", timeout })]);
            demand(await form.getByRole("textbox", { name: "Customer UUID", exact: true }).isEditable()
              && await form.getByRole("textbox", { name: "Grant reason", exact: true }).isEditable());
          }
          if (binding.stage === "paid-revoke") {
            const timeout = selection.expires * 1000 - Date.now();
            demand(timeout > 0 && httpStatus === 200 && response.url() === url && page.url() === url);
            const region = page.getByRole("region", { name: "Revoke manual course access", exact: true }), form = region.locator("form");
            const revision = `Selected paid course revision: ${input.paidRevoke.revision}.`;
            const submit = form.getByRole("button", { name: "Revoke manual access", exact: true });
            const confirmation = form.getByRole("checkbox", { name: "Confirm grant revocation", exact: true });
            await Promise.all([submit.waitFor({ state: "visible", timeout }), confirmation.waitFor({ state: "visible", timeout }),
              region.getByText(revision, { exact: true }).waitFor({ state: "visible", timeout })]);
            for (const name of ["Customer UUID", "Grant UUID", "Revocation reason"]) {
              demand(await form.getByRole("textbox", { name, exact: true }).isEditable({ timeout }));
            }
            demand(await confirmation.isEnabled({ timeout }) && !await confirmation.isChecked({ timeout }));
          }
          if (isP2InteractiveAuthoringDetail(input)) {
            const timeout = selection.expires * 1000 - Date.now();
            demand(timeout > 0 && httpStatus === 200 && response.url() === url && page.url() === url);
            const archive = authoringArchive(input), republish = authoringRepublish(input);
            const name = republish ? "Move to draft" : archive ? "Archive course" : authoringQuiz(input) ? "Assessment" : authoringPublication(input) ? "Review publication readiness"
              : input.authoring.kind === "module" ? "Add module" : "Add lesson";
            const state = republish ? "archived" : archive ? "published" : "draft";
            await Promise.all([
              page.getByRole("button", { name, exact: true }).and(page.locator("button:enabled")).first().waitFor({ state: "visible", timeout }),
              page.getByText(state + " · Revision " + input.authoring.revision, { exact: true }).waitFor({ state: "visible", timeout }),
            ]);
          }
        }
        pending = next();
        await send("interactive-page-opened", { ...selection, path, httpStatus });
      } else {
        const edit = isP2InteractiveAuthoringPair(input), stage = edit ? "authoring-edit" : binding.stage;
        const captureMutation = ["lifecycle", "authoring", "media", "paid-grant", "paid-revoke", ...learnerScopedStages].includes(binding.stage)
          && command.type === "interactive-capture-" + stage;
        demand(command.type === "interactive-clear" || captureMutation && opened && mutationWatch
          || captureIdentity && binding.stage === "identity" && opened && page?.context() === context);
        if (captureMutation) await mutationWatch.wait(selection.expires);
        if (captureIdentity) {
          const observation = { ...selection, openedAt: identityOpenedAt, ownerSubjectSha256: received.ownerSubjectSha256 };
          if (pairedIdentity) {
            demand(peerPage?.context() === peer && peer !== context);
            const [first, second] = await Promise.all([page, peerPage].map(device => waitForInteractiveIdentity(device, input, observation)));
            demand(first.actorId === second.actorId && first.actorKind === second.actorKind);
            const sessionProofs = await Promise.all([context, peer].map(device => customerSessionProof(device, input)));
            verifiedIdentity = validateP2InteractiveIdentityReceipt({ ...first, sessionProofs }, input);
          } else verifiedIdentity = await waitForInteractiveIdentity(page, input, observation);
        }
        if (captureMutation && staleRevision) {
          const proofs = await Promise.all([context, peer].map(device => customerSessionProof(device, input)));
          demand(proofs.every((proof, index) => proof === staleSessionProofs[index]));
        }
        const selectedContexts = peer ? [context, peer] : [context];
        await Promise.all(selectedContexts.map(expireP2InteractiveBrowserCookie));
        if (captureMutation && binding.stage === "media" && input.media.operation === p2MediaUploadCallbackOperation) {
          demand(selection.context === "owner" && !peer && (await context.cookies(input.browserOrigin)).every(cookie => cookie.name !== permitName));
          const response = mutationWatch.hold(selection.expires);
          mediaHeld = true;
          pending = next();
          await send("interactive-media-captured", { ...selection, response });
          continue;
        }
        // Teardown can queue progress or telemetry. Hold the selected page until
        // the parent closes the browser after fencing, with the permit expired.
        if (!captureMutation || !heldLessonStages.includes(binding.stage)) {
          await Promise.all(selectedContexts.flatMap(device => device.pages()).map(page => page.close()));
        }
        cleared = true;
        if (input.identityEnrollment || input.firstOwner) await context.close();
        if (captureMutation || captureIdentity) demand(Date.now() < selection.expires * 1000);
        const response = captureMutation ? mutationWatch.finish() : undefined;
        if (!(binding.stage === "lesson-visibility-save" || staleRevision) || !captureMutation) {
          await mutationWatch?.close();
          mutationWatch = undefined;
        }
        pending = next();
        if (captureMutation) await send("interactive-" + stage + "-captured", { ...selection, ...(edit ? { responses: response } : { response }) });
        else if (captureIdentity) await send("interactive-identity-captured", { ...selection, identity: verifiedIdentity });
        else await send("interactive-permit-cleared", selection);
      }
    }
  } finally {
    process.off("disconnect", lost);
    process.off("SIGTERM", terminate);
    permitPipe.destroy();
    await mutationWatch?.close();
    try {
      if (context && !cleared) await Promise.all((peer ? [context, peer] : [context]).map(expireP2InteractiveBrowserCookie));
    }
    finally { await browser?.close(); }
  }
  await send("interactive-closed");
  process.disconnect();
}

async function childMain() {
  demand(process.versions.node.split(".")[0] === "24" && typeof process.send === "function" && process.argv.length === 1);
  const first = await receiveBrowserMessage(30_000);
  demand(closed(first, ["type", "input"]));
  if (first.type === "initialize-interactive") return runInteractiveBrowser(first.input);
  demand(first.type === "initialize");
  let authCheck;
  const next = type => new Promise((done, fail) => {
    const timer = setTimeout(() => { process.off("message", receive); fail(new Error("P2_BROWSER_PARENT_TIMEOUT")); }, type === "initialize" ? 30_000 : 900_000);
    let checking = false;
    const receive = message => {
      if (type === "arm" && closed(message, ["type", "input"]) && message.type === "check-authentication" && message.input === input.challenge && authCheck && !checking) {
        checking = true;
        void authCheck().then(value => { checking = false; return new Promise((resolve, reject) => process.send({ type: "authentication-current", challenge: input.challenge, value }, error => error ? reject(error) : resolve())); })
          .catch(error => { clearTimeout(timer); process.off("message", receive); fail(error); }).finally(() => { checking = false; });
        return;
      }
      if (!closed(message, ["type", "input"]) || message.type !== type || checking) { clearTimeout(timer); process.off("message", receive); fail(new Error("P2_BROWSER_PROTOCOL")); return; }
      clearTimeout(timer); process.off("message", receive); done(message.input); };
    process.on("message", receive);
  });
  const input = validateP2LifecycleBrowserInput(first.input);
  process.send({ type: "initialized", challenge: input.challenge });
  // Only the fixed armed auth-preparation parent may release this barrier.
  // No browser or authentication request exists before that source capability.
  demand((await next("authenticate")) === input.challenge);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  process.once("disconnect", () => { void browser.close().finally(() => process.exit(1)); });
  let result;
  try {
    const customerContext = await browser.newContext(), ownerContext = await browser.newContext();
    const customer = await customerContext.newPage(), owner = await ownerContext.newPage();
    await customer.goto(`${input.browserOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
    await owner.goto(`${input.browserOrigin}/admin/sign-in`, { waitUntil: "domcontentloaded" });
    authCheck = async () => {
      const learner = await customer.request.get(`${input.browserOrigin}/api/customer-auth/session`, { maxRedirects: 0, timeout: 15_000 });
      const admin = await owner.request.get(`${input.browserOrigin}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
      if (learner.status() !== 200 || admin.status() !== 200) return { customerAuthenticated: false, ownerFresh: false, observedAt: new Date().toISOString() };
      const learnerSession = await learner.json(), adminSession = await admin.json(), at = adminSession?.user?.authenticatedAt;
      return { customerAuthenticated: learnerSession?.user?.id === input.userId,
        ownerFresh: Number.isInteger(at) && Date.now()-at*1000 >= 0 && Date.now()-at*1000 < 240000, observedAt: new Date().toISOString() };
    };
    // The parent's auth-preparation action bounds the normal manual sign-in.
    // This longer child timeout is only process liveness, never admission proof.
    const loginDeadline = performance.now() + 900_000;
    const ready = await until(async () => {
      const current = await authCheck(); if (current.customerAuthenticated && current.ownerFresh) return current;
      await pause(750); return false;
    }, loginDeadline);
    process.send({ type: "authenticated", challenge: input.challenge, value: ready });
    demand((await next("arm")) === input.challenge);
    result = await recordP2SuspensionBrowser(input, { customer, owner }, {
      baseline: async value => { const waiting = next("suspend"); process.send({ type: "baseline", challenge: input.challenge, value }); demand(await waiting === input.challenge); },
      suspended: async value => { process.send({ type: "suspended", challenge: input.challenge, value }); },
    });
  } finally { await browser.close(); }
  await new Promise((done, fail) => process.send({ type: "complete", challenge: input.challenge, value: result }, error => error ? fail(error) : done()));
  process.disconnect();
}
export async function runP2LifecycleBrowserChild() {
  try { await childMain(); }
  catch { process.send?.({ type: "failed" }, () => process.disconnect?.()); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runP2LifecycleBrowserChild();
