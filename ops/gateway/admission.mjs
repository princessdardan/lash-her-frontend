import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { dirname } from "node:path";
import { readP2GatewayProcessBinding } from "./p2-certification-fault.mjs";
import { interactiveCourseOperation, interactiveCourseStagePermits } from "./operations.mjs";

const STATE_KEYS = "actionId,candidateSha256,environment,newWork,recovery,releaseId,version";
const SCOPED_KEYS = "actionId,candidateSha256,environment,muxCallback,newWork,recovery,releaseId,version";
const CALLBACK_KEYS = "assetId,attemptId,environmentId,eventType,expiresAt,gatewayProcessSha256,generation,issuedAt,mountDevice,mountInode,uploadId";
const INTERACTIVE_STATE_KEYS = "actionId,candidateSha256,environment,interactive,newWork,recovery,releaseId,version";
const INTERACTIVE_KEYS = "actorId,deploymentHost,epoch,expiresAt,frontendSourceCommit,gatewayProcessSha256,issuedAt,key,mountDevice,mountInode,nonce,requests,stage";
const INTERACTIVE_REQUEST_KEYS = "bodySha256,method,target,uses";
const INTERACTIVE_TARGET = /^\/course\/v1\/[A-Za-z0-9/_-]+(?:\?[!$%&'()*+,./:;=?@\[\]_~A-Za-z0-9-]+)?$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const INTERACTIVE_STAGES = new Set(["authoring", "media", "learning", "learner-access", "lesson-entry", "lesson-denial", "paid-grant", "paid-revoke"]);
const EMPTY_SHA = createHash("sha256").update("").digest("hex");
const INITIAL_LESSON_PROGRESS = Buffer.from('{"event":"lesson_started","expectedProgressRevision":0}');
const LESSON_DENIAL_RESPONSE = Buffer.from('{"error":{"code":"ACTIVE_ENROLLMENT_REQUIRED","message":"Active enrollment required"}}');
const MAX_ORDINARY_STATE = 4096;
const MAX_INTERACTIVE_STATE = 16_384;
const ASSET_TYPES = new Set(["video.asset.created", "video.asset.ready", "video.asset.errored", "video.asset.deleted"]);
const TRACK_TYPES = new Set(["video.asset.track.ready", "video.asset.track.deleted"]);
const ASSET_STATUSES = new Set(["pending", "uploading", "processing", "ready", "errored"]);
const UNCERTAIN_MEDIA_ERRORS = new Set(["CAPTION_OUTCOME_UNKNOWN", "MEDIA_LEASE_LOST"]);
export const SCOPED_MUX_BODY_LIMIT = 65_536;
export const SCOPED_MUX_HEADER = "x-lash-certification-mux-target";
export const SCOPED_INTERACTIVE_HEADER = "x-lash-certification-interactive";

const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const providerId = value => matches(PROVIDER_ID, value);
const keys = value => value !== null && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
const ordered = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

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

function stagingScopeStorage(value, config, info, processBinding, storageAuthority) {
  const directory = lstatSync(dirname(config.admission.file), { bigint: true });
  if (config.appEnv !== "staging" || config.publicHost !== "api-staging.lashher.com" ||
      config.ownerId !== "team_2Hrn5eMZyZxfAWdmYvyKi9t3" || config.projectId !== "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" ||
      !directory.isDirectory() || directory.uid !== info.uid ||
      !storageAuthority(config.admission.file, directory, info) ||
      (directory.mode & 0o022n) !== 0n || (info.mode & 0o022n) !== 0n ||
      value.mountDevice !== String(directory.dev) || value.mountInode !== String(directory.ino) ||
      !matches(SHA, value.gatewayProcessSha256) || value.gatewayProcessSha256 !== processBinding()) throw new Error();
}

function scopeTime(value, now, maximum) {
  const issued = canonicalTime(value.issuedAt), expires = canonicalTime(value.expiresAt);
  if (!Number.isSafeInteger(now) || issued > now || now >= expires || expires <= issued || expires - issued > maximum) throw new Error();
}

function muxCallbackScope(value, config, info, processBinding, storageAuthority, now) {
  if (keys(value) !== CALLBACK_KEYS || !matches(UUID, value.attemptId) || !providerId(value.environmentId) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation > 2_147_483_647 ||
      (value.assetId !== null && !providerId(value.assetId)) || (value.uploadId !== null && !providerId(value.uploadId))) throw new Error();
  stagingScopeStorage(value, config, info, processBinding, storageAuthority);
  const uploadEvent = value.eventType === "video.upload.asset_created";
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
  if (value.stage === "lesson-denial") requireLessonDenialRequests(value.requests);
}

function requireLessonDenialRequests(requests) {
  const student = "/course/v1/student", coursePrefix = `${student}/courses/`, lessonPrefix = `${student}/lessons/`;
  const [course, lesson] = requests;
  if (!course?.target.startsWith(coursePrefix) || !matches(UUID, course.target.slice(coursePrefix.length)) ||
      !lesson?.target.startsWith(lessonPrefix) || !matches(UUID, lesson.target.slice(lessonPrefix.length))) throw new Error();
  const lessonId = lesson.target.slice(lessonPrefix.length);
  const expected = [
    [course.target, 2],
    [lesson.target, 3],
    [`${student}/progress?lessonId=${lessonId}`, 3],
    [`${lesson.target}/quiz`, 3],
    [`${lesson.target}/quiz/attempts`, 3],
    [`${lesson.target}/playback`, 1],
  ];
  if (requests.length !== expected.length || expected.some(([target, uses], index) =>
    requests[index].target !== target || requests[index].uses !== uses)) throw new Error();
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
  const bodySha256 = digest(body);
  const requestIndex = scope.requests.findIndex(row => row.method === method && row.target === target && row.bodySha256 === bodySha256);
  if (requestIndex < 0) return null;
  if (scope.stage === "paid-revoke" && method === "POST" && !scopedPaidRevocation(body, idempotency)) return null;
  if (scope.stage === "lesson-entry" && (idempotency !== "" || (method === "POST" && !body.equals(INITIAL_LESSON_PROGRESS))) ||
      scope.stage === "lesson-denial" && idempotency !== "") return null;
  const message = ["lash-her:p2q:interactive:gateway-request:v1", issued, requestId, method, target, bodySha256,
    digest(applicationToken), digest(idempotency)].join("\n");
  const expected = createHmac("sha256", Buffer.from(scope.key, "hex")).update(message).digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return null;
  return { requestId, requestIndex, uses: scope.requests[requestIndex].uses };
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
  if (status === 204) return !refresh && body.length === 0;
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
    if (event.type === "video.upload.asset_created") {
      if (data.id !== scope.uploadId || !providerId(data.asset_id) || (scope.assetId !== null && data.asset_id !== scope.assetId)) return null;
    } else if (TRACK_TYPES.has(event.type)) {
      if (data.asset_id !== scope.assetId) return null;
    } else if (scope.assetId === null ? !supplied.length : data.id !== scope.assetId) return null;
    return { target: `${scope.attemptId}:${scope.generation}`, eventId: event.id };
  } catch {
    return null;
  }
}

// The private TLS hop can finish an HTTP 502 after losing its backend. A
// completed transport only settles the scoped operation with a known receipt.
export function scopedMuxAcknowledged(scope, status, body) {
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

function readAdmission(config, processBinding, storageAuthority, interactiveGroup, wall) {
  let descriptor;
  let interactiveFile = false;
  try {
    descriptor = openSync(config.admission.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile()) throw new Error();
    if (info.size > MAX_INTERACTIVE_STATE) return inactiveInteractiveAdmission();
    const raw = readFileSync(descriptor);
    if (raw.length > MAX_INTERACTIVE_STATE) return inactiveInteractiveAdmission();
    interactiveFile = raw.includes('"interactive"');
    if (!isUtf8(raw)) throw new Error();
    const value = JSON.parse(raw.toString("utf8"));
    interactiveFile ||= value?.version === 3;
    if (value.environment !== config.appEnv ||
        value.releaseId !== config.admission.releaseId || value.candidateSha256 !== config.admission.candidateSha256 ||
        typeof value.actionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value.actionId) ||
        typeof value.newWork !== "boolean" || typeof value.recovery !== "boolean") throw new Error();
    if (value.version === 1) {
      if (raw.length > MAX_ORDINARY_STATE || keys(value) !== STATE_KEYS) throw new Error();
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
    return interactiveFile ? inactiveInteractiveAdmission() : closedAdmission();
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
  let interactiveFenced = false;
  return () => {
    const wall = now();
    const admission = readAdmission(config, processBinding, storageAuthority, interactiveGroup, wall);
    if (admission.version === 3) interactiveFenced = true;
    else if (admission.valid) interactiveFenced = false;
    const scope = admission.interactive ?? admission.muxCallback;
    if (currentWindow && (!scope || currentWindow.id !== admission.actionId || currentWindow.version !== admission.version)) {
      currentWindow.retired = true;
      currentWindow = undefined;
    }
    const refused = () => interactiveFenced ? inactiveInteractiveAdmission() : closedAdmission();
    if (!scope) return interactiveFenced ? refused() : admission;
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
