import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { dirname } from "node:path";
import { readP2GatewayProcessBinding } from "./p2-certification-fault.mjs";
import { interactiveCourseOperation, interactiveCourseStagePermits } from "./operations.mjs";
import { parseAssessmentAttempt } from "./assessment-attempt.mjs";
import { EXIT_SAVE_LESSON_STARTED, lessonAckLossBodies, lessonExitSaveBodies, lessonRestorePositionBody, lessonStaleRevisionBodies, parseLessonExitSavePosition,
  parseLessonRestorePosition, parseLessonResumePosition, permitsLessonAckLossBody, permitsLessonStaleRevisionBody, RESTORE_LESSON_STARTED } from "./lesson-resume-position.mjs";

const STATE_KEYS = "actionId,candidateSha256,environment,newWork,recovery,releaseId,version";
const SCOPED_KEYS = "actionId,candidateSha256,environment,muxCallback,newWork,recovery,releaseId,version";
const CALLBACK_KEYS = "assetId,attemptId,environmentId,eventType,expiresAt,gatewayProcessSha256,generation,issuedAt,mountDevice,mountInode,uploadId";
const ONE_SHOT_CALLBACK_KEYS = CALLBACK_KEYS.replace(",uploadId", ",oneShot,uploadId");
const UPLOAD_ASSET_CREATED = "video.upload.asset_created";
const INTERACTIVE_STATE_KEYS = "actionId,candidateSha256,environment,interactive,newWork,recovery,releaseId,version";
const INTERACTIVE_KEYS = "actorId,deploymentHost,epoch,expiresAt,frontendSourceCommit,gatewayProcessSha256,issuedAt,key,mountDevice,mountInode,nonce,requests,stage";
const INTERACTIVE_REQUEST_KEYS = "bodySha256,method,target,uses";
const INTERACTIVE_TARGET = /^\/course\/v1\/[A-Za-z0-9/_-]+(?:\?[!$%&'()*+,./:;=?@\[\]_~A-Za-z0-9-]+)?$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const INTERACTIVE_STAGES = new Set(["authoring", "media", "learning", "learner-access", "lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision", "paid-grant", "paid-revoke"]);
const EMPTY_SHA = createHash("sha256").update("").digest("hex");
const INITIAL_LESSON_PROGRESS = Buffer.from('{"event":"lesson_started","expectedProgressRevision":0}');
const RESTORE_LESSON_PROGRESS = Buffer.from(RESTORE_LESSON_STARTED);
const EXIT_SAVE_LESSON_PROGRESS = Buffer.from(EXIT_SAVE_LESSON_STARTED);
const LESSON_DENIAL_RESPONSE = Buffer.from('{"error":{"code":"ACTIVE_ENROLLMENT_REQUIRED","message":"Active enrollment required"}}');
const ASSESSMENT_PLAYBACK_RESPONSE = Buffer.from('{"error":{"code":"LESSON_NOT_FOUND","message":"Lesson not found"}}');
const STALE_PROGRESS_RESPONSE = Buffer.from('{"error":{"code":"CONFLICT","message":"Progress revision is stale; reload before updating"}}');
const MAX_ORDINARY_STATE = 4096;
const MAX_INTERACTIVE_STATE = 16_384;
const ASSET_TYPES = new Set(["video.asset.created", "video.asset.ready", "video.asset.errored", "video.asset.deleted"]);
const TRACK_TYPES = new Set(["video.asset.track.ready", "video.asset.track.deleted"]);
const ASSET_STATUSES = new Set(["pending", "uploading", "processing", "ready", "errored"]);
const UNCERTAIN_MEDIA_ERRORS = new Set(["CAPTION_OUTCOME_UNKNOWN", "MEDIA_LEASE_LOST"]);
const ADMIN_LESSON_UPLOAD = "/v1/admin/lessons/{lessonId}/video-upload";
export const SCOPED_MUX_BODY_LIMIT = 65_536;
export const SCOPED_MUX_HEADER = "x-lash-certification-mux-target";
export const SCOPED_INTERACTIVE_HEADER = "x-lash-certification-interactive";

const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const providerId = value => matches(PROVIDER_ID, value);
const keys = value => value !== null && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
const ordered = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const RESTORE_POSITION_HASHES = [3, 4, 5, 6].map(resume => digest(lessonRestorePositionBody(resume, resume + 10)));
const RESUME_POSITION_TEMPLATES = [1, 2, 3].map(expectedProgressRevision => digest(JSON.stringify({ expectedProgressRevision })));
const ACK_LOSS_WRITE_HASHES = [3, 4, 5, 6].map(resume => lessonAckLossBodies(resume).map(digest));
const ACK_LOSS_PHASES = [[0, 1, 2, 3, 4], [5, 6], [7], [8], [2], [0, 1, 2, 3, 4], [5, 9], [10]];
const STALE_REVISION_WRITE_HASHES = [3, 4, 5, 6].map(resume => lessonStaleRevisionBodies(resume).map(digest));
const STALE_REVISION_PHASES = [
  [0, 1, 2, 3, 4], [5, 6], [7], [0, 1, 2, 3, 4], [5, 8], [9],
  [10], [11], [2], [0, 1, 2, 3, 4], [5, 12], [13],
];
const EXIT_SAVE_WRITE_HASHES = [3, 4, 5, 6].map(resume => lessonExitSaveBodies(resume).map(digest));
const EXIT_SAVE_POSITION_TEMPLATE = EXIT_SAVE_WRITE_HASHES[0][2];
const EXIT_SAVE_PHASES = [[0, 1, 2, 3, 4], [5, 6], [7], [0, 8, 9]];
const VISIBILITY_SAVE_PHASES = [...EXIT_SAVE_PHASES.slice(0, -1), [8]];

function orderedRecursively(value) {
  if (Array.isArray(value)) return value.map(orderedRecursively);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedRecursively(value[key])]));
  }
  return value;
}

function canonicalTime(value) {
  if (typeof value !== "string") throw new Error();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error();
  return time;
}

function rootAdmissionStorage(file, directory, info) {
  return file === "/admission/state.json" && directory.uid === 0n && info.uid === 0n;
}

function trustedAdmissionDirectory(config, info, storageAuthority) {
  const directory = lstatSync(dirname(config.admission.file), { bigint: true });
  if (!directory.isDirectory() || directory.uid !== info.uid ||
      !storageAuthority(config.admission.file, directory, info) ||
      (directory.mode & 0o022n) !== 0n || (info.mode & 0o022n) !== 0n) throw new Error();
  return directory;
}

function reviewedStagingScope(config) {
  return config.appEnv === "staging" && config.publicHost === "api-staging.lashher.com" &&
    config.ownerId === "team_2Hrn5eMZyZxfAWdmYvyKi9t3" && config.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM";
}

function stagingScopeStorage(value, config, info, processBinding, storageAuthority) {
  const directory = trustedAdmissionDirectory(config, info, storageAuthority);
  if (!reviewedStagingScope(config) || value.mountDevice !== String(directory.dev) || value.mountInode !== String(directory.ino) ||
      !matches(SHA, value.gatewayProcessSha256) || value.gatewayProcessSha256 !== processBinding()) throw new Error();
}

function scopeTime(value, now, maximum) {
  const issued = canonicalTime(value.issuedAt), expires = canonicalTime(value.expiresAt);
  if (!Number.isSafeInteger(now) || issued > now || now >= expires || expires <= issued || expires - issued > maximum) throw new Error();
}

function muxCallbackScope(value, config, info, processBinding, storageAuthority, now) {
  const oneShot = value?.oneShot === true;
  if (keys(value) !== (oneShot ? ONE_SHOT_CALLBACK_KEYS : CALLBACK_KEYS) ||
      !matches(UUID, value.attemptId) || !providerId(value.environmentId) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation > 2_147_483_647 ||
      (value.assetId !== null && !providerId(value.assetId)) || (value.uploadId !== null && !providerId(value.uploadId))) throw new Error();
  stagingScopeStorage(value, config, info, processBinding, storageAuthority);
  const uploadEvent = value.eventType === UPLOAD_ASSET_CREATED;
  if (oneShot && (!uploadEvent || info.nlink !== 1n)) throw new Error();
  const trackEvent = TRACK_TYPES.has(value.eventType);
  if (!(uploadEvent || trackEvent || ASSET_TYPES.has(value.eventType)) ||
      (uploadEvent && value.uploadId === null) || (trackEvent && value.assetId === null)) throw new Error();
  scopeTime(value, now, 120_000);
}

function interactiveScope(value, config, info, processBinding, storageAuthority, group, now) {
  if (keys(value) !== INTERACTIVE_KEYS || info.gid !== group || info.nlink !== 1n || (info.mode & 0o7777n) !== 0o640n ||
      !matches(UUID, value.actorId) || !INTERACTIVE_STAGES.has(value.stage) || !matches(/^[1-9][0-9]{0,17}$/u, value.epoch) ||
      !matches(/^[a-f0-9]{40}$/u, value.frontendSourceCommit) || /^0+$/u.test(value.frontendSourceCommit) ||
      !matches(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.vercel\.app$/u, value.deploymentHost) ||
      !matches(/^[a-f0-9]{32}$/u, value.nonce) || !matches(SHA, value.key) || /^0+$/u.test(value.key) ||
      !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 16) throw new Error();
  stagingScopeStorage(value, config, info, processBinding, storageAuthority);
  scopeTime(value, now, 300_000);
  const tuples = new Set();
  for (const row of value.requests) {
    if (keys(row) !== INTERACTIVE_REQUEST_KEYS || !matches(INTERACTIVE_TARGET, row.target) || row.target.length > 512 ||
        !interactiveCourseStagePermits(value.stage, row.method, row.target) ||
        !matches(SHA, row.bodySha256) || (row.method === "GET" && row.bodySha256 !== EMPTY_SHA) ||
        !Number.isSafeInteger(row.uses) || row.uses < 1 || row.uses > 4) throw new Error();
    const tuple = `${row.method}\n${row.target}\n${row.bodySha256}`;
    if (tuples.has(tuple)) throw new Error();
    tuples.add(tuple);
  }
  if (["lesson-denial", "lesson-assessment", "lesson-resume", "lesson-restore", "lesson-ack-loss", "lesson-exit-save", "lesson-visibility-save", "lesson-stale-revision"].includes(value.stage)) {
    requireSelectedLessonRequests(value.stage, value.requests);
  }
  if (value.stage === "media" && value.requests.some(row => row.method === "POST" && row.target.split("?", 1)[0].endsWith("/video-upload"))) {
    const [course, status, upload] = value.requests;
    const coursePrefix = "/course/v1/admin/courses/", lessonPrefix = "/course/v1/admin/lessons/";
    if (value.requests.length !== 3 || value.requests.some(row => row.uses !== 1) ||
        course.method !== "GET" || !course.target.startsWith(coursePrefix) || !matches(UUID, course.target.slice(coursePrefix.length)) ||
        status.method !== "GET" || !status.target.startsWith(lessonPrefix) || !status.target.endsWith("/video") ||
        !matches(UUID, status.target.slice(lessonPrefix.length, -"/video".length)) ||
        upload.method !== "POST" || upload.target !== status.target + "-upload" || upload.bodySha256 === EMPTY_SHA) throw new Error();
  }
}

function requireSelectedLessonRequests(stage, requests) {
  const student = "/course/v1/student", coursePrefix = `${student}/courses/`, lessonPrefix = `${student}/lessons/`;
  const [course, lesson] = requests;
  if (!course?.target.startsWith(coursePrefix) || !matches(UUID, course.target.slice(coursePrefix.length)) ||
      !lesson?.target.startsWith(lessonPrefix) || !matches(UUID, lesson.target.slice(lessonPrefix.length))) throw new Error();
  const lessonId = lesson.target.slice(lessonPrefix.length);
  const reads = [course.target, lesson.target, `${student}/progress?lessonId=${lessonId}`,
    `${lesson.target}/quiz`, `${lesson.target}/quiz/attempts`, `${lesson.target}/playback`];
  const assessment = stage === "lesson-assessment", resume = stage === "lesson-resume", restore = stage === "lesson-restore";
  const ackLoss = stage === "lesson-ack-loss", exitSave = stage === "lesson-exit-save";
  const visibilitySave = stage === "lesson-visibility-save";
  const staleRevision = stage === "lesson-stale-revision";
  const uses = staleRevision ? [3, 3, 4, 3, 3, 3] : ackLoss ? [2, 2, 3, 2, 2, 2] :
    exitSave ? [2, 1, 1, 1, 1, 1] :
    resume || restore || visibilitySave ? [1, 1, 1, 1, 1, 1] : assessment ? [1, 1, 3, 1, 1, 1] : [2, 3, 3, 3, 3, 1];
  const expected = reads.map((target, index) => ["GET", target, uses[index]]);
  if (assessment) expected.push(["POST", `${lesson.target}/progress`, 1],
    ["POST", reads[4], 1], ["POST", reads[4], 1]);
  const positionWrites = staleRevision ? 8 : resume ? 4 : restore ? 2 : ackLoss ? 5 : exitSave || visibilitySave ? 3 : 0;
  for (let index = 0; index < positionWrites; index++) expected.push(["POST", `${lesson.target}/progress`, 1]);
  if (exitSave) expected.push(["GET", `${student}/progress?courseId=${course.target.slice(coursePrefix.length)}`, 1]);
  if (requests.length !== expected.length || expected.some(([method, target, count], index) =>
    requests[index].method !== method || requests[index].target !== target || requests[index].uses !== count)) throw new Error();
  if (assessment && (requests[6].bodySha256 !== digest(INITIAL_LESSON_PROGRESS) ||
      requests.slice(7).some(row => row.bodySha256 === EMPTY_SHA))) throw new Error();
  if (resume && (requests[6].bodySha256 !== digest(INITIAL_LESSON_PROGRESS) ||
      RESUME_POSITION_TEMPLATES.some((hash, index) => requests[index + 7].bodySha256 !== hash))) throw new Error();
  if (restore && (requests[6].bodySha256 !== digest(RESTORE_LESSON_PROGRESS) ||
      !RESTORE_POSITION_HASHES.includes(requests[7].bodySha256))) throw new Error();
  if (ackLoss && !ACK_LOSS_WRITE_HASHES.some(hashes =>
    hashes.every((hash, index) => requests[index + 6].bodySha256 === hash))) throw new Error();
  if (staleRevision && !STALE_REVISION_WRITE_HASHES.some(hashes =>
    hashes.every((hash, index) => requests[index + 6].bodySha256 === hash))) throw new Error();
  if ((exitSave || visibilitySave) && !EXIT_SAVE_WRITE_HASHES.some(hashes =>
    hashes.every((hash, index) => requests[index + 6].bodySha256 === hash))) throw new Error();
}

function hasInteractiveActor(token, actorId) {
  if (!matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u, token) || token.length > 8192) return false;
  const segment = token.split(".")[1];
  if (segment.length > 4096) return false;
  try {
    const bytes = Buffer.from(segment, "base64url");
    if (!isUtf8(bytes) || bytes.toString("base64url") !== segment) return false;
    const payload = JSON.parse(bytes.toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) && payload.sub === actorId;
  } catch {
    return false;
  }
}

function scopedPaidRevocation(body, idempotency) {
  if (!idempotency.startsWith("owner-paid-revoke:") || !matches(UUID, idempotency.slice("owner-paid-revoke:".length)) || !isUtf8(body)) return false;
  try {
    const value = JSON.parse(body.toString("utf8"));
    return keys(value) === "grantId,idempotencyKey,reason,scope" && value.scope === "grantId" && matches(UUID, value.grantId) &&
      typeof value.reason === "string" && value.reason.trim().length > 0 && value.idempotencyKey === idempotency;
  } catch {
    return false;
  }
}

export function selectScopedInteractiveRequest(scope, { method, target, body, headers, now }) {
  const proof = headers[SCOPED_INTERACTIVE_HEADER];
  const requestId = headers["x-request-id"];
  if (!scope || !interactiveCourseStagePermits(scope.stage, method, target) ||
      typeof proof !== "string" || proof.length !== 115 || !matches(UUID, requestId) || !Buffer.isBuffer(body)) return null;
  const [version, issued, proofId, mac] = proof.split(".");
  const age = Math.floor(now / 1000) - Number(issued);
  if (version !== "v1" || !matches(/^[1-9][0-9]{9}$/u, issued) || proofId !== requestId ||
      !matches(SHA, mac) || !Number.isSafeInteger(age) || age < 0 || age >= 30) return null;
  const authorization = headers.authorization;
  const applicationToken = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const idempotency = headers["x-idempotency-key"] ?? "";
  const operation = interactiveCourseOperation(method, target.split("?", 1)[0]);
  if (operation === "catalog" ? authorization !== undefined : !hasInteractiveActor(applicationToken, scope.actorId)) return null;
  if (idempotency !== "" && !matches(/^[A-Za-z0-9._:-]{1,255}$/u, idempotency)) return null;
  const contentType = headers["content-type"];
  if (method !== "GET" && contentType !== "application/json" && (body.length > 0 || contentType !== undefined)) return null;
  let attempt, resumePosition;
  const boundedPositionSave = scope.stage === "lesson-exit-save" || scope.stage === "lesson-visibility-save";
  if (scope.stage === "lesson-assessment") {
    if (idempotency !== "" || method === "POST" && contentType !== "application/json") return null;
    if (method === "POST" && target.endsWith("/quiz/attempts")) {
      attempt = isUtf8(body) && parseAssessmentAttempt(body.toString("utf8"));
      if (!attempt) return null;
    } else if (method === "POST" && !body.equals(INITIAL_LESSON_PROGRESS)) return null;
  } else if (scope.stage === "lesson-ack-loss" || scope.stage === "lesson-stale-revision") {
    const permitsBody = scope.stage === "lesson-ack-loss" ? permitsLessonAckLossBody : permitsLessonStaleRevisionBody;
    if (headers["x-idempotency-key"] !== undefined ||
        method === "POST" && (contentType !== "application/json" || !isUtf8(body) || !permitsBody(body.toString("utf8")))) return null;
  } else if (boundedPositionSave) {
    if (headers["x-idempotency-key"] !== undefined || method === "POST" && contentType !== "application/json") return null;
    if (method === "POST" && !body.equals(EXIT_SAVE_LESSON_PROGRESS)) {
      resumePosition = isUtf8(body) && parseLessonExitSavePosition(body.toString("utf8"));
      if (!resumePosition) return null;
    }
  } else if (scope.stage === "lesson-resume" || scope.stage === "lesson-restore") {
    const restore = scope.stage === "lesson-restore";
    if (headers["x-idempotency-key"] !== undefined || method === "POST" && contentType !== "application/json") return null;
    if (method === "POST" && !body.equals(restore ? RESTORE_LESSON_PROGRESS : INITIAL_LESSON_PROGRESS)) {
      const parsePosition = restore ? parseLessonRestorePosition : parseLessonResumePosition;
      resumePosition = isUtf8(body) && parsePosition(body.toString("utf8"));
      if (!resumePosition) return null;
    }
  }
  const bodySha256 = digest(body);
  const selectedBodySha256 = attempt ? digest(attempt.template) :
    resumePosition && scope.stage === "lesson-resume" ? RESUME_POSITION_TEMPLATES[resumePosition.expectedProgressRevision - 1] :
    resumePosition?.expectedProgressRevision === 8 && boundedPositionSave ? EXIT_SAVE_POSITION_TEMPLATE : bodySha256;
  const requestIndex = scope.requests.findIndex(row => row.method === method && row.target === target && row.bodySha256 === selectedBodySha256);
  if (requestIndex < 0) return null;
  const mediaReservation = scope.stage === "media" && scope.requests.at(2)?.target.endsWith("/video-upload");
  if (mediaReservation && (idempotency !== "" || method === "POST" && contentType !== "application/json")) return null;
  if (scope.stage === "paid-revoke" && method === "POST" && !scopedPaidRevocation(body, idempotency)) return null;
  if (scope.stage === "lesson-entry" && (idempotency !== "" || (method === "POST" && !body.equals(INITIAL_LESSON_PROGRESS))) ||
      scope.stage === "lesson-denial" && idempotency !== "") return null;
  const message = ["lash-her:p2q:interactive:gateway-request:v1", issued, requestId, method, target, bodySha256,
    digest(applicationToken), digest(idempotency)].join("\n");
  const expected = createHmac("sha256", Buffer.from(scope.key, "hex")).update(message).digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return null;
  return { requestId, requestIndex, uses: scope.requests[requestIndex].uses,
    ...(mediaReservation ? { mediaReservation: true } : {}),
    ...(attempt ? { attemptRequestId: attempt.requestId, quizRevision: attempt.quizRevision } : {}),
    ...(resumePosition ? { resumePosition } : {}) };
}

export function lessonResumePhasePermits({ requestIndex, resumePosition }, evidence, restore = false) {
  const completed = evidence.acknowledged.length;
  if (completed < 5) return requestIndex < 5;
  if (completed < 7) return requestIndex === 5 || requestIndex === 6;
  if (completed !== requestIndex || !resumePosition || evidence.resumeProgress?.revision !== resumePosition.expectedProgressRevision) return false;
  const prior = evidence.resumeProgress;
  if (restore) return requestIndex === 7 && resumePosition.resumePositionSeconds === prior.resumePositionSeconds &&
    resumePosition.maxPositionSeconds === prior.maxPositionSeconds;
  if (requestIndex === 7) return true;
  if (requestIndex === 8) return resumePosition.resumePositionSeconds >= prior.resumePositionSeconds &&
    resumePosition.maxPositionSeconds >= prior.maxPositionSeconds;
  return requestIndex === 9 && resumePosition.resumePositionSeconds === prior.resumePositionSeconds - 10 &&
    resumePosition.maxPositionSeconds === prior.maxPositionSeconds;
}

export function scopedLessonPositionPhasePermits({ requestIndex, resumePosition }, { acknowledged, used, resumeProgress }, stage) {
  const phases = stage === "lesson-exit-save" ? EXIT_SAVE_PHASES :
    stage === "lesson-visibility-save" ? VISIBILITY_SAVE_PHASES :
      stage === "lesson-ack-loss" ? ACK_LOSS_PHASES : stage === "lesson-stale-revision" ? STALE_REVISION_PHASES : null;
  if (!phases) return false;
  if ((phases === EXIT_SAVE_PHASES || phases === VISIBILITY_SAVE_PHASES) && requestIndex === 8 && (!resumePosition || resumeProgress?.revision !== 8 ||
    resumePosition.maxPositionSeconds !== resumeProgress.maxPositionSeconds ||
    resumePosition.resumePositionSeconds < resumeProgress.resumePositionSeconds + 2 ||
    resumePosition.resumePositionSeconds > resumeProgress.resumePositionSeconds + 5)) return false;
  if ((used.get(requestIndex) ?? 0) !== acknowledged.filter(row => row.requestIndex === requestIndex).length) return false;
  let completed = acknowledged.length;
  for (const phase of phases) {
    if (completed < phase.length) return phase.includes(requestIndex) &&
      !acknowledged.slice(acknowledged.length - completed).some(row => row.requestIndex === requestIndex);
    completed -= phase.length;
  }
  return false;
}

function playbackClaims(token, playbackId, audience, expiresAt, now) {
  if (!matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u, token) || token.length > 4096 ||
      typeof expiresAt !== "string") return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isSafeInteger(expiry) || new Date(expiry).toISOString() !== expiresAt ||
      expiry - now < 590_000 || expiry - now > 602_000) return null;
  const [header, payload] = token.split(".").slice(0, 2).map(value => {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || !isUtf8(bytes)) throw new Error();
    return JSON.parse(bytes.toString("utf8"));
  });
  if (keys(header) !== "alg,typ" || header.alg !== "RS256" || header.typ !== "JWT" ||
      keys(payload) !== "aud,exp,kid,sub" || !providerId(payload.kid) ||
      payload.sub !== playbackId || payload.aud !== audience || payload.exp !== expiry / 1000) return null;
  return { expiry, key: payload.kid };
}

function matchesLearnerProgress(row, actorId) {
  return keys(row) ===
    "completedAt,completedQuizRevision,createdAt,enrollmentId,id,lastWatchedAt,lessonId,maxPositionSeconds,resumePositionSeconds,revision,updatedAt,userId" &&
    matches(UUID, row.id) && (row.enrollmentId === null || matches(UUID, row.enrollmentId)) &&
    row.userId === actorId && matches(UUID, row.lessonId);
}

function matchesUncompletedProgress(row, actorId, lessonId) {
  return matchesLearnerProgress(row, actorId) && matches(UUID, row.enrollmentId) && row.lessonId === lessonId &&
    row.completedAt === null && row.completedQuizRevision === null;
}

function exitSaveCourseAcknowledged(course, lessonId, evidence) {
  if (!Array.isArray(course.modules) || course.modules.some(module => !Array.isArray(module.lessons))) return false;
  const ids = course.modules.flatMap(module => module.lessons.map(lesson => lesson.id));
  const selected = new Set(ids);
  if (!selected.has(lessonId) || selected.size !== ids.length || ids.some(id => !matches(UUID, id))) return false;
  if (evidence.courseLessonIds) {
    return selected.size === evidence.courseLessonIds.size && ids.every(id => evidence.courseLessonIds.has(id));
  }
  evidence.courseLessonIds = selected;
  return true;
}

function exitSaveCourseProgressAcknowledged(value, actorId, lessonId, evidence) {
  const { courseLessonIds, resumeProgress: prior, exitBaselineResume, exitRequestedPosition } = evidence;
  if (keys(value) !== "progress" || !Array.isArray(value.progress) || !prior || !courseLessonIds) return false;
  const ids = new Set(), lessons = new Set();
  let selected = false;
  for (const row of value.progress) {
    if (!matchesLearnerProgress(row, actorId) || !courseLessonIds.has(row.lessonId) ||
        ids.has(row.id) || lessons.has(row.lessonId)) return false;
    ids.add(row.id);
    lessons.add(row.lessonId);
    if (row.lessonId !== lessonId) continue;
    const resume = row.revision === 8 ? exitBaselineResume : row.revision === 9 ? exitRequestedPosition : undefined;
    if (!matchesUncompletedProgress(row, actorId, lessonId) || row.id !== prior.id || row.enrollmentId !== prior.enrollmentId ||
        resume === undefined || row.resumePositionSeconds !== resume || row.maxPositionSeconds !== prior.maxPositionSeconds) return false;
    selected = true;
  }
  return selected;
}

export function scopedResumeAcknowledged(target, status, contentType, body, selection, evidence, scope, now) {
  const { requestIndex, resumePosition } = selection;
  const staleRevision = scope.stage === "lesson-stale-revision", conflict = staleRevision && requestIndex === 11;
  if (status !== (conflict ? 409 : 200) || typeof contentType !== "string" ||
      contentType.split(";", 1)[0] !== "application/json" || !isUtf8(body)) return false;
  if (conflict) return evidence.resumeProgress?.revision === 11 && body.equals(STALE_PROGRESS_RESPONSE);
  const restore = scope.stage === "lesson-restore";
  const ackLoss = scope.stage === "lesson-ack-loss";
  const exitSave = scope.stage === "lesson-exit-save";
  const boundedPositionSave = exitSave || scope.stage === "lesson-visibility-save";
  const actorId = scope.actorId;
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!body.equals(Buffer.from(JSON.stringify(value)))) return false;
    if (requestIndex === 0) {
      return keys(value) === "course" && value.course?.id === target.split("/").at(-1) &&
        (!exitSave || exitSaveCourseAcknowledged(value.course, scope.requests[1].target.split("/").at(-1), evidence));
    }
    if (requestIndex === 1) return keys(value) === "lesson" && value.lesson?.id === target.split("/").at(-1) && value.lesson.isPreview === false;
    if (requestIndex === 2) {
      if (keys(value) !== "progress" || !Array.isArray(value.progress) || value.progress.length !== (restore || ackLoss || boundedPositionSave || staleRevision ? 1 : 0)) return false;
      if (!restore && !ackLoss && !boundedPositionSave && !staleRevision) return true;
      const [row] = value.progress;
      const lessonId = target.slice(target.lastIndexOf("=") + 1);
      if (!matchesUncompletedProgress(row, actorId, lessonId)) return false;
      if ((ackLoss || staleRevision) && evidence.resumeProgress) {
        const prior = evidence.resumeProgress;
        return (staleRevision ? [8, 11].includes(row.revision) : row.revision === 9) && row.revision === prior.revision && row.id === prior.id && row.enrollmentId === prior.enrollmentId &&
          row.resumePositionSeconds === prior.resumePositionSeconds && row.maxPositionSeconds === prior.maxPositionSeconds;
      }
      if (ackLoss || boundedPositionSave || staleRevision) {
        const bodies = staleRevision ? lessonStaleRevisionBodies : boundedPositionSave ? lessonExitSaveBodies : lessonAckLossBodies;
        if (row.revision !== 6 || row.maxPositionSeconds !== row.resumePositionSeconds + 10 ||
          digest(bodies(row.resumePositionSeconds)[1]) !== scope.requests[7].bodySha256) return false;
      } else if (row.revision !== 4 ||
        digest(lessonRestorePositionBody(row.resumePositionSeconds, row.maxPositionSeconds)) !== scope.requests[7].bodySha256) return false;
      if (exitSave) evidence.exitBaselineResume = row.resumePositionSeconds;
      evidence.resumeProgress = { id: row.id, enrollmentId: row.enrollmentId, revision: row.revision,
        resumePositionSeconds: row.resumePositionSeconds, maxPositionSeconds: row.maxPositionSeconds };
      return true;
    }
    if (requestIndex === 3) return keys(value) === "quiz" && value.quiz?.lessonId === target.split("/").at(-2);
    if (requestIndex === 4) return keys(value) === "attempts" && Array.isArray(value.attempts) && value.attempts.length === 0;
    if (requestIndex === 5) {
      if (keys(value) !== "expiresAt,playbackId,playbackToken,thumbnailExpiresAt,thumbnailToken" || !providerId(value.playbackId)) return false;
      const playback = playbackClaims(value.playbackToken, value.playbackId, "v", value.expiresAt, now);
      const thumbnail = playbackClaims(value.thumbnailToken, value.playbackId, "t", value.thumbnailExpiresAt, now);
      if (playback === null || thumbnail === null || playback.key !== thumbnail.key || Math.abs(playback.expiry - thumbnail.expiry) > 1000) return false;
      if (ackLoss || staleRevision) {
        const playbackIdSha256 = digest(value.playbackId);
        if (evidence.playbackIdSha256 && evidence.playbackIdSha256 !== playbackIdSha256) return false;
        evidence.playbackIdSha256 = playbackIdSha256;
      }
      return true;
    }
    if (exitSave && requestIndex === 9) {
      return exitSaveCourseProgressAcknowledged(value, actorId, scope.requests[1].target.split("/").at(-1), evidence);
    }
    const row = value?.progress, prior = evidence.resumeProgress;
    if (ackLoss || boundedPositionSave || staleRevision) {
      const expectedResume = boundedPositionSave ? resumePosition?.resumePositionSeconds ?? prior?.resumePositionSeconds :
        requestIndex < (staleRevision ? 10 : 8) ? prior?.resumePositionSeconds : prior?.maxPositionSeconds;
      const expectedRevision = staleRevision && requestIndex > 11 ? requestIndex - 1 : requestIndex;
      if (!prior || prior.revision !== expectedRevision || keys(value) !== "progress" ||
          !matchesUncompletedProgress(row, actorId, target.split("/").at(-2)) ||
          row.id !== prior.id || row.enrollmentId !== prior.enrollmentId || row.revision !== expectedRevision + 1 ||
          row.resumePositionSeconds !== expectedResume ||
          row.maxPositionSeconds !== prior.maxPositionSeconds) return false;
      evidence.resumeProgress = { ...prior, revision: row.revision, resumePositionSeconds: row.resumePositionSeconds };
      return true;
    }
    const resume = restore ? prior?.resumePositionSeconds : resumePosition?.resumePositionSeconds ?? 0;
    const maximum = restore ? prior?.maxPositionSeconds : Math.max(resume, resumePosition?.maxPositionSeconds ?? 0);
    if (keys(value) !== "progress" || !matchesUncompletedProgress(row, actorId, target.split("/").at(-2)) ||
      row.revision !== requestIndex - (restore ? 1 : 5) || row.resumePositionSeconds !== resume || row.maxPositionSeconds !== maximum ||
      (!restore && requestIndex === 6 ? prior !== undefined : row.id !== prior?.id || row.enrollmentId !== prior?.enrollmentId)) return false;
    evidence.resumeProgress = { id: row.id, enrollmentId: row.enrollmentId, revision: row.revision,
      resumePositionSeconds: resume, maxPositionSeconds: maximum };
    return true;
  } catch {
    return false;
  }
}

export function lessonAssessmentPhasePermits(selection, evidence) {
  const { requestIndex, attemptRequestId } = selection;
  const { acknowledged, used, attemptIds } = evidence;
  const completedUses = acknowledged.filter(row => row.requestIndex === requestIndex).length;
  if ((used.get(requestIndex) ?? 0) !== completedUses || (attemptRequestId && attemptIds.has(attemptRequestId))) return false;
  const completed = acknowledged.length;
  if (completed < 5) return requestIndex < 5;
  if (completed < 7) return requestIndex === 5 || requestIndex === 6;
  return requestIndex === [7, 2, 8, 2][completed - 7];
}

export function scopedAssessmentAcknowledged(target, status, contentType, body, selection, evidence, actorId) {
  if (typeof contentType !== "string" || contentType.split(";", 1)[0] !== "application/json" || !isUtf8(body)) return false;
  const { requestIndex, quizRevision } = selection;
  if (requestIndex === 5) return status === 404 && body.equals(ASSESSMENT_PLAYBACK_RESPONSE);
  if (status !== 200) return false;
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!body.equals(Buffer.from(JSON.stringify(value)))) return false;
    if (requestIndex === 2 || requestIndex === 6) {
      if (keys(value) !== "progress") return false;
      const lessonId = requestIndex === 6 ? target.split("/").at(-2) : target.split("?lessonId=")[1];
      const expected = requestIndex === 6 ? 1 : evidence.acknowledged.length < 5 ? 0 : evidence.acknowledged.length === 8 ? 2 : 3;
      const rows = requestIndex === 6 ? [value.progress] : value.progress;
      if (!Array.isArray(rows) || rows.length !== (expected === 0 ? 0 : 1)) return false;
      return expected === 0 || rows[0]?.userId === actorId && rows[0].lessonId === lessonId &&
        rows[0].revision === expected && rows[0].resumePositionSeconds === 0 && rows[0].maxPositionSeconds === 0 &&
        (expected === 3 ? typeof rows[0].completedAt === "string" && Number.isSafeInteger(rows[0].completedQuizRevision)
          : rows[0].completedAt === null && rows[0].completedQuizRevision === null);
    }
    if (requestIndex === 7 || requestIndex === 8) {
      const attempt = value?.attempt, passing = requestIndex === 8;
      return keys(value) === "attempt" && matches(UUID, attempt?.id) && matches(UUID, attempt.quizRevisionId) &&
        attempt.lessonId === target.split("/").at(-3) && attempt.quizRevision === quizRevision && attempt.mode === "graded" &&
        attempt.passed === passing && attempt.completed === passing;
    }
    if (requestIndex === 4) return keys(value) === "attempts" && Array.isArray(value.attempts) && value.attempts.length === 0;
    const key = requestIndex === 0 ? "course" : requestIndex === 1 ? "lesson" : "quiz";
    return keys(value) === key && value[key] !== null && typeof value[key] === "object" && !Array.isArray(value[key]);
  } catch {
    return false;
  }
}

function acknowledgedMediaRefresh(target, value) {
  const path = target.split("?", 1)[0].split("/");
  return keys(value) === "captionTracks,generation,id,isCurrent,lastErrorCode,lessonId,status" &&
    matches(UUID, path[5]) && matches(UUID, path[7]) && value.lessonId === path[5] && value.id === path[7] &&
    ASSET_STATUSES.has(value.status) && Number.isSafeInteger(value.generation) && value.generation >= 1 &&
    typeof value.isCurrent === "boolean" && value.lastErrorCode === null && Array.isArray(value.captionTracks) &&
    value.captionTracks.every(track => keys(track) === "closedCaptions,id,label,language,status" &&
      typeof track.closedCaptions === "boolean" && [track.id, track.label, track.language, track.status].every(field => typeof field === "string"));
}

export function scopedInteractiveAcknowledged(route, target, status, contentType, body, stage) {
  if (stage === "lesson-denial") {
    return status === 403 && typeof contentType === "string" && contentType.split(";", 1)[0] === "application/json" &&
      body.equals(LESSON_DENIAL_RESPONSE);
  }
  const refresh = route.method === "POST" && route.path === "/v1/admin/lessons/{lessonId}/video/{videoAssetId}/refresh";
  const reserve = stage === "media" && route.method === "POST" && route.path === ADMIN_LESSON_UPLOAD;
  if (status === 204) return !refresh && !reserve && body.length === 0;
  if (!((status >= 200 && status < 300) || (status >= 400 && status < 500)) ||
      typeof contentType !== "string" || contentType.split(";", 1)[0] !== "application/json" || !isUtf8(body)) return false;
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (status >= 400) {
      return keys(value) === "error" && keys(value.error) === "code,message" &&
        matches(/^[A-Z][A-Z0-9_]{0,127}$/u, value.error.code) && typeof value.error.message === "string" &&
        !UNCERTAIN_MEDIA_ERRORS.has(value.error.code);
    }
    if (refresh) return status === 200 && acknowledgedMediaRefresh(target, value);
    if (reserve) {
      if (status !== 201 || keys(value) !== "upload,videoAsset" || keys(value.upload) !== "id,timeoutSeconds,url" ||
          keys(value.videoAsset) !== "id,lessonId,status" || !matches(UUID, value.videoAsset.id) ||
          value.videoAsset.lessonId !== target.split("/").at(-2) || value.videoAsset.status !== "uploading" ||
          !providerId(value.upload.id) || value.upload.timeoutSeconds !== 3600 || typeof value.upload.url !== "string") return false;
      const url = new URL(value.upload.url);
      return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
    }
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function isScopedMuxRoute(route, target) {
  return route.method === "POST" && route.path === "/v1/webhooks/mux" &&
    (route.service ?? "course") === "course" && route.auth === "webhook" && target === "/course/v1/webhooks/mux";
}

// This is a transport selection. The Course receiver still verifies the raw
// signature and must independently lock the selected managed generation.
export function selectScopedMuxCallback(scope, body, signature) {
  if (!scope || !Buffer.isBuffer(body) || !body.length || body.length > SCOPED_MUX_BODY_LIMIT ||
      !isUtf8(body) || typeof signature !== "string" || !signature || signature.length > 1024) return null;
  try {
    const event = JSON.parse(body.toString("utf8")), data = event.data;
    if (event.type !== scope.eventType || event.environment?.id !== scope.environmentId ||
        !providerId(event.id) || !providerId(data?.id)) return null;
    const marker = `lash-her-course:${scope.environmentId}:${scope.attemptId}`;
    const supplied = [data.passthrough, data.new_asset_settings?.passthrough].filter(value => value !== undefined);
    if (supplied.some(value => value !== marker)) return null;
    if (event.type === UPLOAD_ASSET_CREATED) {
      if (data.id !== scope.uploadId || !providerId(data.asset_id) || (scope.assetId !== null && data.asset_id !== scope.assetId)) return null;
    } else if (TRACK_TYPES.has(event.type)) {
      if (data.asset_id !== scope.assetId) return null;
    } else if (scope.assetId === null ? !supplied.length : data.id !== scope.assetId) return null;
    return { target: `${scope.attemptId}:${scope.generation}`, eventId: event.id,
      ...(scope.oneShot === true && event.type === UPLOAD_ASSET_CREATED ? { assetId: data.asset_id } : {}) };
  } catch {
    return null;
  }
}

// The private TLS hop can finish an HTTP 502 after losing its backend. A
// completed transport only settles the scoped operation with a known receipt.
export function scopedMuxAcknowledged(scope, status, body) {
  if (scope.oneShot === true && status !== 200) return false;
  if (status === 204) return body.length === 0;
  if (body.length > 4096 || !isUtf8(body)) return false;
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (status === 400 || status === 429) {
      const code = status === 400 ? "BAD_REQUEST" : "TOO_MANY_REQUESTS";
      return keys(value) === "error" && keys(value.error) === "code,message" &&
        value.error.code === code && typeof value.error.message === "string";
    }
    return status === 200 && keys(value) === "videoAsset" &&
      keys(value.videoAsset) === "id,lessonId,status" && value.videoAsset.id === scope.attemptId &&
      matches(UUID, value.videoAsset.lessonId) && ASSET_STATUSES.has(value.videoAsset.status);
  } catch {
    return false;
  }
}

// This is a host fence for the existing Course transport, including requests
// from historical frontend deployments. It does not replace application auth,
// the six feature flags, or the later frontend database writer fence (P2-00).
const closedAdmission = () => ({ valid: false, newWork: false, recovery: false });
const inactiveInteractiveAdmission = () => ({ ...closedAdmission(), version: 3, interactiveActive: false });
const inactiveOneShotAdmission = () => ({ ...closedAdmission(), version: 2, muxCallbackActive: false });

function verifyOneShotClosure(value, raw, config, info, storageAuthority, fence) {
  const directory = trustedAdmissionDirectory(config, info, storageAuthority);
  const compact = JSON.stringify(ordered(value));
  const spaced = "{" + Object.entries(ordered(value)).map(([key, item]) => JSON.stringify(key) + ": " + JSON.stringify(item)).join(", ") + "}";
  if (value.newWork || value.recovery || info.nlink !== 1n ||
      (fence.mountDevice !== undefined && (fence.mountDevice !== String(directory.dev) || fence.mountInode !== String(directory.ino))) ||
      ![compact + "\n", spaced + "\n"].some(encoding => raw.equals(Buffer.from(encoding)))) throw new Error();
}

function readAdmission(config, processBinding, storageAuthority, interactiveGroup, wall, oneShotFence) {
  let descriptor;
  let interactiveFile = false, oneShotFile = false;
  try {
    descriptor = openSync(config.admission.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile()) throw new Error();
    if (info.size > MAX_INTERACTIVE_STATE) return inactiveInteractiveAdmission();
    const raw = readFileSync(descriptor);
    if (raw.length > MAX_INTERACTIVE_STATE) return inactiveInteractiveAdmission();
    interactiveFile = raw.includes('"interactive"');
    oneShotFile = reviewedStagingScope(config) && raw.includes('"muxCallback"') && raw.includes('"oneShot"');
    if (!isUtf8(raw)) throw new Error();
    const value = JSON.parse(raw.toString("utf8"));
    interactiveFile ||= value?.version === 3;
    oneShotFile ||= reviewedStagingScope(config) && value?.version === 2 &&
      value.muxCallback != null && Object.hasOwn(value.muxCallback, "oneShot");
    if (value.environment !== config.appEnv ||
        value.releaseId !== config.admission.releaseId || value.candidateSha256 !== config.admission.candidateSha256 ||
        typeof value.actionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value.actionId) ||
        typeof value.newWork !== "boolean" || typeof value.recovery !== "boolean") throw new Error();
    if (value.version === 1) {
      if (raw.length > MAX_ORDINARY_STATE || keys(value) !== STATE_KEYS) throw new Error();
      if (oneShotFence) verifyOneShotClosure(value, raw, config, info, storageAuthority, oneShotFence);
    } else if (value.version === 3) {
      if (keys(value) !== INTERACTIVE_STATE_KEYS || value.newWork || value.recovery) throw new Error();
      interactiveScope(value.interactive, config, info, processBinding, storageAuthority, interactiveGroup, wall);
      const canonical = JSON.stringify(orderedRecursively(value)) + "\n";
      if (!raw.equals(Buffer.from(canonical))) throw new Error();
    } else {
      if (raw.length > MAX_ORDINARY_STATE || value.version !== 2 || keys(value) !== SCOPED_KEYS || value.newWork || value.recovery) throw new Error();
      muxCallbackScope(value.muxCallback, config, info, processBinding, storageAuthority, wall);
      const canonical = JSON.stringify(ordered({ ...value, muxCallback: ordered(value.muxCallback) })) + "\n";
      if (!raw.equals(Buffer.from(canonical))) throw new Error();
    }
    return { valid: true, sha256: digest(raw), ...value };
  } catch {
    return oneShotFile ? inactiveOneShotAdmission() : interactiveFile ? inactiveInteractiveAdmission() : closedAdmission();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createAdmissionReader(config, {
  processBinding = readP2GatewayProcessBinding, storageAuthority = rootAdmissionStorage,
  now = Date.now, monotonic = process.hrtime.bigint, interactiveGroup = 65532n,
} = {}) {
  const muxWindows = new Map();
  const interactiveWindows = new Map();
  let currentWindow;
  let interactiveFenced = false, oneShotFence;
  return () => {
    const wall = now();
    const admission = readAdmission(config, processBinding, storageAuthority, interactiveGroup, wall, oneShotFence);
    const oneShot = admission.muxCallback?.oneShot === true;
    // After seeing the marker, malformed or substituted state cannot restore
    // the ordinary read routes. Only trusted closed v1 clears this latch.
    if (admission.muxCallbackActive === false) oneShotFence ??= {};
    if (oneShot) {
      const { mountDevice, mountInode } = admission.muxCallback;
      oneShotFence ??= { sha256: admission.sha256, mountDevice, mountInode };
    }
    if (admission.valid && admission.version === 1) oneShotFence = undefined;
    if (admission.version === 3) interactiveFenced = true;
    else if (admission.valid) interactiveFenced = false;
    const permittedOneShot = oneShot && oneShotFence.sha256 === admission.sha256;
    const scope = oneShotFence && !permittedOneShot ? undefined : admission.interactive ?? admission.muxCallback;
    if (currentWindow && (!scope || currentWindow.id !== admission.actionId || currentWindow.version !== admission.version)) {
      currentWindow.retired = true;
      currentWindow = undefined;
    }
    const refused = () => oneShotFence ? inactiveOneShotAdmission() : interactiveFenced ? inactiveInteractiveAdmission() : closedAdmission();
    if (!scope) return oneShotFence || interactiveFenced ? refused() : admission;
    const windows = interactiveFenced ? interactiveWindows : muxWindows;
    const tick = monotonic();
    let window = windows.get(admission.actionId);
    if (!window) {
      if (windows.size >= (interactiveFenced ? 64 : 16)) return refused();
      const remaining = Date.parse(scope.expiresAt) - wall;
      window = { id: admission.actionId, version: admission.version, sha256: admission.sha256,
        deadline: tick + BigInt(remaining) * 1_000_000n, retired: false };
      windows.set(window.id, window);
    }
    if (window.retired || window.sha256 !== admission.sha256 || tick >= window.deadline) {
      window.retired = true;
      return refused();
    }
    currentWindow = window;
    return admission;
  };
}

const RECOVERY_ROUTES = new Set([
  "POST /v1/internal/entitlements/grants",
  "POST /v1/internal/entitlements/reconcile",
  "POST /v1/internal/entitlements/revocations",
  "POST /v1/webhooks/mux",
]);

export function admissionClass(route) {
  if (route.admission === "recovery") return "recovery";
  if (route.method === "GET") return null;
  // Service-authorized durable financial commands and signed media callbacks
  // may recover independently of customer/student/admin authoring writes.
  if (RECOVERY_ROUTES.has(`${route.method} ${route.path}`)) return "recovery";
  return "newWork";
}
