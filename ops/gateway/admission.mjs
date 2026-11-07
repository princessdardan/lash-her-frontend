import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { dirname } from "node:path";
import { readP2GatewayProcessBinding } from "./p2-certification-fault.mjs";

const STATE_KEYS = "actionId,candidateSha256,environment,newWork,recovery,releaseId,version";
const SCOPED_KEYS = "actionId,candidateSha256,environment,muxCallback,newWork,recovery,releaseId,version";
const CALLBACK_KEYS = "assetId,attemptId,environmentId,eventType,expiresAt,gatewayProcessSha256,generation,issuedAt,mountDevice,mountInode,uploadId";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const ASSET_TYPES = new Set(["video.asset.created", "video.asset.ready", "video.asset.errored", "video.asset.deleted"]);
const TRACK_TYPES = new Set(["video.asset.track.ready", "video.asset.track.deleted"]);
const ASSET_STATUSES = new Set(["pending", "uploading", "processing", "ready", "errored"]);
export const SCOPED_MUX_BODY_LIMIT = 65_536;
export const SCOPED_MUX_HEADER = "x-lash-certification-mux-target";

const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const providerId = value => matches(PROVIDER_ID, value);
const keys = value => value !== null && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
const ordered = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));

function canonicalTime(value) {
  if (typeof value !== "string") throw new Error();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error();
  return time;
}

function muxCallbackScope(value, config, info, processBinding, now) {
  const directory = lstatSync(dirname(config.admission.file), { bigint: true });
  if (config.appEnv !== "staging" || config.publicHost !== "api-staging.lashher.com" ||
      config.ownerId !== "team_2Hrn5eMZyZxfAWdmYvyKi9t3" || config.projectId !== "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" ||
      keys(value) !== CALLBACK_KEYS || !directory.isDirectory() || directory.uid !== info.uid ||
      (directory.mode & 0o022n) !== 0n || (info.mode & 0o022n) !== 0n ||
      value.mountDevice !== String(directory.dev) || value.mountInode !== String(directory.ino) ||
      !matches(SHA, value.gatewayProcessSha256) || value.gatewayProcessSha256 !== processBinding() ||
      !matches(UUID, value.attemptId) || !providerId(value.environmentId) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation > 2_147_483_647 ||
      (value.assetId !== null && !providerId(value.assetId)) || (value.uploadId !== null && !providerId(value.uploadId))) throw new Error();
  const uploadEvent = value.eventType === "video.upload.asset_created";
  const trackEvent = TRACK_TYPES.has(value.eventType);
  if (!(uploadEvent || trackEvent || ASSET_TYPES.has(value.eventType)) ||
      (uploadEvent && value.uploadId === null) || (trackEvent && value.assetId === null)) throw new Error();
  const issued = canonicalTime(value.issuedAt), expires = canonicalTime(value.expiresAt);
  if (!Number.isSafeInteger(now) || issued > now || now >= expires || expires <= issued || expires - issued > 120_000) throw new Error();
  return value;
}

export function isScopedMuxRoute(route, target) {
  return route.method === "POST" && route.path === "/v1/webhooks/mux" &&
    (route.service ?? "course") === "course" && route.auth === "webhook" && target === "/course/v1/webhooks/mux";
}

// This is a transport selection. The Course receiver still verifies the raw
// signature and must independently lock the selected managed generation.
export function scopedMuxTarget(scope, body, signature) {
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
    return `${scope.attemptId}:${scope.generation}`;
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
export function readAdmission(config, { processBinding = readP2GatewayProcessBinding, now = Date.now } = {}) {
  let descriptor;
  try {
    descriptor = openSync(config.admission.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile() || info.size > 4096) throw new Error();
    const raw = readFileSync(descriptor);
    if (raw.length > 4096) throw new Error();
    const value = JSON.parse(raw.toString("utf8"));
    if (value.environment !== config.appEnv ||
        value.releaseId !== config.admission.releaseId || value.candidateSha256 !== config.admission.candidateSha256 ||
        typeof value.actionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value.actionId) ||
        typeof value.newWork !== "boolean" || typeof value.recovery !== "boolean") throw new Error();
    if (value.version === 1) {
      if (keys(value) !== STATE_KEYS) throw new Error();
    } else {
      if (value.version !== 2 || keys(value) !== SCOPED_KEYS || value.newWork || value.recovery) throw new Error();
      muxCallbackScope(value.muxCallback, config, info, processBinding, now());
      const canonical = JSON.stringify(ordered({ ...value, muxCallback: ordered(value.muxCallback) })) + "\n";
      if (!raw.equals(Buffer.from(canonical))) throw new Error();
    }
    return { valid: true, sha256: createHash("sha256").update(raw).digest("hex"), ...value };
  } catch {
    return { valid: false, newWork: false, recovery: false };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
