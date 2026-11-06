// Joint schema c2c44f38...: DATA codecs, never resource/session authority.
// No live plan, parent factory, response wrapper or private capture material.
import { createHash } from "node:crypto";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";

export const P2Q_MUX_CAPTURE_SCHEMA_SHA256 = "c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a";
export const P2Q_MUX_LIMITS = Object.freeze({ leaseBytes: 8192, safeRecordBytes: 16384, evidenceBytes: 196608,
  armMilliseconds: 120000, signatureAgeSeconds: 300, minimumSendBudgetMilliseconds: 15000, globalRecords: 64 });
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const P2Q_MUX_CASES = freeze({ D1: { events: ["video.asset.track.ready"], slots: [0] },
  R1: { events: ["video.asset.track.ready", "video.asset.track.deleted"], slots: [1, 0] }, A1: { events: ["video.asset.track.ready"], slots: [0] } });
export const P2Q_MUX_OPERATIONS = Object.freeze(["ARM", "OPEN_AUTHORING_WINDOW", "CLOSE_AUTHORING_WINDOW", "OBSERVE_CAPTURE", "AUTHORIZE_CASE",
  "OPEN_REPLAY_WINDOW", "SEND_NEXT", "CLOSE_REPLAY_WINDOW", "FINISH", "ABORT"]);
export class P2QMuxCaptureError extends Error {
  constructor(code = "P2Q_MUX_COMPONENT_VALUE_REFUSED") { super(code); this.code = code; this.name = "P2QMuxCaptureError"; }
}
const demand = ok => { if (!ok) throw new P2QMuxCaptureError(); };
const fields = text => text.split(" ");
const keys = {
  profile: fields("version id sha256"), identity: fields("device inode"), selection: fields("environmentId lessonId attemptId generation assetId uploadId"),
  event: fields("id type createdAt environmentId objectId assetId attemptId lessonId generation"), managed: fields("id lessonId status"),
  lease: fields("version kind actionId caseId qualificationTargetProfile candidateSha256 operatorSourceClosureSha256 planSha256 configurationSha256 gatewayConfigurationSha256 gatewayProcessSha256 gatewayImageSha256 courseImageSha256 sourceWitnessSha256 issuedAt expiresAt maxCaptures maxReplayPosts selection captureRootIdentity actionDirectoryIdentity"),
  safeCapture: fields("version kind leaseSha256 slot event requestId headerTimestamp capturedAt monotonicNanoseconds managedResponse localResponseFinished"),
  safeSendStarted: fields("version kind leaseSha256 sequence captureSlot captureObservationSha256 createdAt"),
  replayObservation: fields("version kind leaseSha256 sequence captureSlot sendStartedSha256 requestId event headerTimestamp observedAt monotonicNanoseconds managedResponse localResponseFinished"),
  globalRequest: fields("version kind leaseSha256 ordinal requestId category service method routeTemplate startedAt finishedAt upstreamAttempted upstreamStatus localResponseFinished"),
  windowSummary: fields("version kind leaseSha256 startedAt closedAt admittedTotalsBefore admittedTotalsAfter records observationFailures"),
  totals: fields("newWork recovery"), wireFrame: fields("version operation"),
};
const kinds = { safeCapture: "P2Q_MUX_CAPTURE_OBSERVED", safeSendStarted: "P2Q_MUX_SEND_STARTED", replayObservation: "P2Q_MUX_REPLAY_OBSERVED",
  globalRequest: "P2Q_MUX_ADMITTED_REQUEST_OBSERVED", windowSummary: "P2Q_MUX_GLOBAL_WINDOW_OBSERVED" };
const hashFields = fields("candidateSha256 operatorSourceClosureSha256 planSha256 configurationSha256 gatewayConfigurationSha256 gatewayProcessSha256 gatewayImageSha256 courseImageSha256 sourceWitnessSha256");
const sha = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const provider = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,255}$/u.test(v);
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const request = v => uuid(v) && v[14] === "4";
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min && v <= max;
const decimal = (v, max) => typeof v === "string" && /^(?:0|[1-9][0-9]*)$/u.test(v) && v.length <= max;
const closed = (value, expected) => {
  demand(value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const own = Reflect.ownKeys(value); demand(own.length === expected.length && own.every(key => typeof key === "string" && expected.includes(key)));
  for (const key of expected) demand(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
};
const list = (value, max) => { demand(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max);
  demand(Reflect.ownKeys(value).length === value.length + 1); for (let i = 0; i < value.length; i++) demand(Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, "value")); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const bytes = value => Buffer.from(JSON.stringify(canonical(value)) + "\n");
const limit = kind => kind === "lease" ? 8192 : kind === "globalRequest" ? 768 : 16384;
const iso = value => { demand(typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value));
  const ms = Date.parse(value); demand(Number.isFinite(ms) && value.slice(0, 4) !== "0000" && new Date(ms).toISOString() === value); return ms; };
function eventInstant(value) {
  demand(typeof value === "string"); const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  demand(m && m[1].slice(0, 4) !== "0000"); const ms = Date.parse(m[1] + ".000Z");
  demand(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === m[1]);
  demand(m[3] === "Z" || Number(m[5]) <= 23 && Number(m[6]) <= 59);
  const offset = m[3] === "Z" ? 0 : (Number(m[5]) * 60 + Number(m[6])) * (m[4] === "+" ? 1 : -1);
  return BigInt(ms) * 1000000n + BigInt((m[2] ?? "").padEnd(9, "0")) - BigInt(offset) * 60000000000n;
}
function selection(value) {
  closed(value, keys.selection); demand(provider(value.environmentId) && provider(value.assetId) && (value.uploadId === null || provider(value.uploadId)) &&
    uuid(value.lessonId) && uuid(value.attemptId) && integer(value.generation, 1, 2147483647));
}
function event(value) {
  closed(value, keys.event); eventInstant(value.createdAt);
  demand(provider(value.id) && provider(value.objectId) && provider(value.assetId) && provider(value.environmentId) &&
    uuid(value.attemptId) && uuid(value.lessonId) && integer(value.generation, 1, 2147483647) && P2Q_MUX_CASES.R1.events.includes(value.type));
}
function managed(value, selected) {
  closed(value, keys.managed); demand(uuid(value.id) && uuid(value.lessonId) && value.id === selected.attemptId && value.lessonId === selected.lessonId &&
    ["pending", "uploading", "processing", "ready", "errored"].includes(value.status));
}
function totals(value) { if (value !== null) { closed(value, keys.totals); demand(integer(value.newWork) && integer(value.recovery)); } }
function validate(kind, value) {
  demand(typeof kind === "string" && Object.hasOwn(keys, kind) && ["lease", ...Object.keys(kinds), "wireFrame"].includes(kind)); closed(value, keys[kind]);
  demand(value.version === 2);
  if (kind === "wireFrame") demand(P2Q_MUX_OPERATIONS.includes(value.operation));
  else if (kind === "lease") {
    closed(value.qualificationTargetProfile, keys.profile);
    demand(value.qualificationTargetProfile.version === 1 && typeof value.qualificationTargetProfile.id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value.qualificationTargetProfile.id) && sha(value.qualificationTargetProfile.sha256) && !/^0+$/u.test(value.qualificationTargetProfile.sha256));
    demand(value.kind === "p2q-mux-controlled-capture-v2" && typeof value.actionId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.actionId) && typeof value.caseId === "string" && Object.hasOwn(P2Q_MUX_CASES, value.caseId));
    for (const key of hashFields) demand(sha(value[key])); selection(value.selection);
    const count = P2Q_MUX_CASES[value.caseId].slots.length;
    demand(value.maxCaptures === count && value.maxReplayPosts === count && iso(value.expiresAt) > iso(value.issuedAt) && iso(value.expiresAt) - iso(value.issuedAt) <= 120000);
    for (const key of ["captureRootIdentity", "actionDirectoryIdentity"]) { closed(value[key], keys.identity); demand(decimal(value[key].device, 40) && decimal(value[key].inode, 40) && value[key].inode !== "0"); }
  } else {
    demand(value.kind === kinds[kind] && sha(value.leaseSha256));
    if (kind === "safeCapture" || kind === "replayObservation") {
      event(value.event); managed(value.managedResponse, value.event);
      demand(request(value.requestId) && integer(value.headerTimestamp, 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) && decimal(value.monotonicNanoseconds, 30) && value.localResponseFinished === true);
      iso(value[kind === "safeCapture" ? "capturedAt" : "observedAt"]);
      if (kind === "safeCapture") demand(integer(value.slot, 0, 1));
      else demand(integer(value.sequence, 0, 1) && integer(value.captureSlot, 0, 1) && sha(value.sendStartedSha256));
    } else if (kind === "safeSendStarted") { demand(integer(value.sequence, 0, 1) && integer(value.captureSlot, 0, 1) && sha(value.captureObservationSha256)); iso(value.createdAt); }
    else if (kind === "globalRequest") {
      demand(integer(value.ordinal, 0, 63) && request(value.requestId) && ["newWork", "recovery"].includes(value.category) && ["course", "community"].includes(value.service) &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(value.method) && typeof value.routeTemplate === "string" && /^\/v1\/[A-Za-z0-9_{}\/-]{1,127}$/u.test(value.routeTemplate));
      const start = iso(value.startedAt); if (value.finishedAt !== null) demand(iso(value.finishedAt) >= start);
      demand(typeof value.upstreamAttempted === "boolean" && (value.upstreamStatus === null || integer(value.upstreamStatus, 100, 599)) &&
        (value.localResponseFinished === null || typeof value.localResponseFinished === "boolean") && (value.upstreamAttempted || value.upstreamStatus === null) &&
        (value.finishedAt !== null || value.localResponseFinished !== true));
    } else {
      const start = iso(value.startedAt); if (value.closedAt !== null) demand(iso(value.closedAt) >= start);
      totals(value.admittedTotalsBefore); totals(value.admittedTotalsAfter); demand(integer(value.observationFailures)); list(value.records, 64);
      const ids = new Set(); for (const [i, row] of value.records.entries()) { validate("globalRequest", row);
        demand(row.ordinal === i && row.leaseSha256 === value.leaseSha256 && !ids.has(row.requestId) && iso(row.startedAt) >= start &&
          (value.closedAt === null || iso(row.startedAt) <= iso(value.closedAt))); ids.add(row.requestId); }
    }
  }
  demand(bytes(value).length <= limit(kind)); return value;
}
export function validateP2QMuxValue(kind, value) {
  try { validate(kind, value); return freeze(structuredClone(value)); } catch { throw new P2QMuxCaptureError(); }
}
export function encodeP2QMuxValue(kind, value) { return bytes(validateP2QMuxValue(kind, value)); }
export function decodeP2QMuxValue(kind, raw) {
  try { demand(typeof raw === "string" || raw instanceof Uint8Array); const input = Buffer.from(raw);
    demand(input.length > 0 && input.length <= limit(kind)); const value = validateP2QMuxValue(kind, decodeQualificationTargetJson(input, "carrier"));
    demand(input.equals(bytes(value))); return value;
  } catch { throw new P2QMuxCaptureError(); }
}
export function p2qMuxValueSha256(kind, value) { return createHash("sha256").update(encodeP2QMuxValue(kind, value)).digest("hex"); }

export function validateP2QMuxCaptureSet(lease, captures) {
  lease = validateP2QMuxValue("lease", lease); list(captures, 2); demand(captures.length === lease.maxCaptures);
  const selected = lease.selection, spec = P2Q_MUX_CASES[lease.caseId], leaseSha = p2qMuxValueSha256("lease", lease);
  for (const [slot, raw] of captures.entries()) { const row = validateP2QMuxValue("safeCapture", raw);
    demand(row.slot === slot && row.leaseSha256 === leaseSha && row.event.type === spec.events[slot]);
    for (const key of ["environmentId", "lessonId", "attemptId", "generation", "assetId"]) demand(row.event[key] === selected[key]);
    const captured = iso(row.capturedAt), signed = row.headerTimestamp * 1000;
    demand(captured >= iso(lease.issuedAt) && captured <= iso(lease.expiresAt) && captured >= signed && captured - signed <= 300000);
  }
  if (lease.caseId === "R1") demand(captures[0].event.id !== captures[1].event.id && captures[0].event.objectId === captures[1].event.objectId && eventInstant(captures[0].event.createdAt) < eventInstant(captures[1].event.createdAt));
  return freeze({ componentOnly: true, dataConsistent: true, actualAuthority: false, replacementStateQualified: false, providerGeneratedDuplicate: false, firstDeliveryInversion: false });
}
export function assessP2QMuxSendBudget(lease, capture, nowIso, elapsedMilliseconds) {
  lease = validateP2QMuxValue("lease", lease); capture = validateP2QMuxValue("safeCapture", capture);
  demand(capture.leaseSha256 === p2qMuxValueSha256("lease", lease) && capture.slot < lease.maxCaptures && integer(elapsedMilliseconds));
  const now = iso(nowIso), issued = iso(lease.issuedAt), captured = iso(capture.capturedAt), signed = capture.headerTimestamp * 1000;
  const deadline = Math.min(iso(lease.expiresAt), issued + 120000, signed + 300000);
  const remaining = Math.min(deadline - now, 120000 - elapsedMilliseconds);
  return freeze({ componentOnly: true, budgetSufficient: now >= issued && now >= captured && captured >= issued && captured >= signed && captured - signed <= 300000 &&
    captured <= iso(lease.expiresAt) && remaining >= 15000, remainingMilliseconds: Math.max(0, remaining), liveSendAuthorized: false, sourceClockQualified: false });
}
export function assessP2QMuxWindowSummary(lease, summary) {
  lease = validateP2QMuxValue("lease", lease); summary = validateP2QMuxValue("windowSummary", summary); demand(summary.leaseSha256 === p2qMuxValueSha256("lease", lease));
  const counts = { newWork: 0, recovery: 0 }; for (const row of summary.records) counts[row.category]++;
  const before = summary.admittedTotalsBefore, after = summary.admittedTotalsAfter;
  const match = before !== null && after !== null && summary.closedAt !== null && summary.observationFailures === 0 &&
    iso(summary.startedAt) >= iso(lease.issuedAt) && iso(summary.closedAt) <= iso(lease.expiresAt) &&
    keys.totals.every(key => after[key] >= before[key] && after[key] - before[key] === counts[key]);
  return freeze({ componentOnly: true, counterLedgerConsistency: match ? "MATCH" : "OPEN", counts, actualDrainQualified: false, providerQueueQualified: false, selectiveAdmissionClaim: false });
}
export function fixedP2QMuxIntents(caseId) {
  demand(typeof caseId === "string" && Object.hasOwn(P2Q_MUX_CASES, caseId)); const count = P2Q_MUX_CASES[caseId].slots.length;
  return freeze(["ARM", "OPEN_AUTHORING_WINDOW", "CLOSE_AUTHORING_WINDOW", ...Array(count).fill("OBSERVE_CAPTURE"), "AUTHORIZE_CASE", "OPEN_REPLAY_WINDOW",
    ...Array(count).fill("SEND_NEXT"), "CLOSE_REPLAY_WINDOW", "FINISH"].map(operation => ({ version: 2, operation })));
}
export function validateP2QMuxIntentPrefix(caseId, frames) {
  const fixed = fixedP2QMuxIntents(caseId); list(frames, fixed.length + 1); let aborted = false;
  for (const [i, raw] of frames.entries()) { const frame = validateP2QMuxValue("wireFrame", raw);
    if (frame.operation === "ABORT") { demand(i === frames.length - 1 && i < fixed.length); aborted = true; }
    else demand(i < fixed.length && frame.operation === fixed[i].operation);
  }
  return freeze({ componentOnly: true, nextOperation: aborted || frames.length === fixed.length ? null : fixed[frames.length].operation, dispatchAuthorized: false });
}
export function p2qMuxEvidenceByteLength(records) {
  list(records, 196608); let total = 0;
  for (const value of records) { const descriptor = value && Object.getOwnPropertyDescriptor(value, "kind"); demand(descriptor && Object.hasOwn(descriptor, "value"));
    const kind = descriptor.value === "p2q-mux-controlled-capture-v2" ? "lease" : Object.keys(kinds).find(key => kinds[key] === descriptor.value);
    demand(kind !== undefined); total += encodeP2QMuxValue(kind, value).length; demand(total <= 196608); }
  return total;
}
// No inputs, profile, JSON, callback, test issuer or registry edit can activate
// this boundary. Real source authority/parent/observer interfaces are absent.
export function dispatchP2QMuxCapture() { throw new P2QMuxCaptureError("P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE"); }
