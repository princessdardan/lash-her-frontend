// Data/components only. No allocated policy or authentic control factory exists.
// The public gateway factory is deliberately incapable of activation or I/O.
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const P2Q_MUX_CAPTURE_ARM_AVAILABLE = false;
export const MUX_CAPTURE_COMPONENT_SCHEMA_SHA256 = "c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a";
export const MUX_CAPTURE_LIMITS = Object.freeze({ body: 65536, signature: 1024, contentType: 128, envelope: 66708, lease: 8192, record: 16384, ledger: 768, requests: 64, milliseconds: 120000 });
const noop = () => undefined, noToken = () => null;
const INACTIVE = Object.freeze({ beginAdmitted: noToken, select: noToken, markUpstreamAttempt: noop, observeUpstream: noop, finish: noop });
export function createP2QMuxCapture(config) { void config; return INACTIVE; }

const SHA = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9_-]{1,255}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const REQUEST = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CASES = Object.freeze({ D1: Object.freeze({ types: ["video.asset.track.ready"], order: [0] }), R1: Object.freeze({ types: ["video.asset.track.ready", "video.asset.track.deleted"], order: [1, 0] }), A1: Object.freeze({ types: ["video.asset.track.ready"], order: [0] }) });
const LEASE_KEYS = ["version", "kind", "actionId", "caseId", "qualificationTargetProfile", "candidateSha256", "operatorSourceClosureSha256", "planSha256", "configurationSha256", "gatewayConfigurationSha256", "gatewayProcessSha256", "gatewayImageSha256", "courseImageSha256", "sourceWitnessSha256", "issuedAt", "expiresAt", "maxCaptures", "maxReplayPosts", "selection", "captureRootIdentity", "actionDirectoryIdentity"];
const EVENT_KEYS = ["id", "type", "createdAt", "environmentId", "objectId", "assetId", "attemptId", "lessonId", "generation"];
const CAPTURE_KEYS = ["version", "kind", "leaseSha256", "slot", "event", "requestId", "headerTimestamp", "capturedAt", "monotonicNanoseconds", "managedResponse", "localResponseFinished", "rawEnvelopeSha256", "rawEnvelopeBytes"];
const INTENT_KEYS = ["version", "kind", "leaseSha256", "sequence", "captureSlot", "sendStartedSha256", "expectedEnvelopeSha256", "eventId", "originalHeaderTimestamp", "issuedAt", "expiresAt"];
const STATUSES = ["pending", "uploading", "processing", "ready", "errored"];
const match = (pattern, value) => typeof value === "string" && pattern.test(value);
const hash = raw => createHash("sha256").update(raw).digest("hex");
function refuse(code = "P2Q_MUX_VALUE_REFUSED") { const error = new Error(code); error.code = code; throw error; }
function need(ok, code) { if (!ok) refuse(code); }
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum; }
function plain(value) { return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function closed(value, names) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return JSON.stringify(Object.keys(descriptors).sort()) === JSON.stringify([...names].sort()) && Object.values(descriptors).every(item => Object.hasOwn(item, "value") && item.enumerable);
}
function canonical(value, depth = 0) {
  need(depth <= 24);
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { need(Number.isFinite(value) && !Object.is(value, -0)); return JSON.stringify(value); }
  if (Array.isArray(value)) return "[" + value.map(item => canonical(item, depth + 1)).join(",") + "]";
  need(plain(value) && Object.getOwnPropertySymbols(value).length === 0);
  return "{" + Object.keys(value).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); need(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
    return JSON.stringify(key) + ":" + canonical(descriptor.value, depth + 1);
  }).join(",") + "}";
}
const recordBytes = value => Buffer.from(canonical(value) + "\n");
function parseCanonical(raw, maximum) {
  try {
    need(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= maximum && isUtf8(raw));
    const value = JSON.parse(raw.toString("utf8")); need(recordBytes(value).equals(raw)); return value;
  } catch { refuse(); }
}
function frozen(value) { if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function iso(value) {
  need(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && !value.startsWith("0000"));
  const time = Date.parse(value); need(Number.isFinite(time) && new Date(time).toISOString() === value); return time;
}
function eventNanoseconds(value) {
  need(typeof value === "string");
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|([+-])(\d\d):(\d\d))$/u.exec(value);
  need(match && !match[1].startsWith("0000"));
  const base = Date.parse(match[1] + ".000Z");
  need(Number.isFinite(base) && new Date(base).toISOString().slice(0, 19) === match[1]);
  const hours = Number(match[5] ?? 0), minutes = Number(match[6] ?? 0); need(hours <= 23 && minutes <= 59);
  const offset = (match[4] === "-" ? -1 : 1) * (hours * 60 + minutes);
  return BigInt(base - offset * 60000) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}
function decimal(value, positive = false, digits = 40) { return typeof value === "string" && (positive ? /^[1-9]\d*$/u : /^(?:0|[1-9]\d*)$/u).test(value) && value.length <= digits; }
function directoryIdentity(value) { return closed(value, ["device", "inode"]) && decimal(value.device) && decimal(value.inode, true); }
function profile(value) { return closed(value, ["version", "id", "sha256"]) && value.version === 1 && /^[a-z][a-z0-9-]{0,63}$/u.test(value.id) && match(SHA, value.sha256) && value.sha256 !== "0".repeat(64); }
function validateLease(value) {
  need(closed(value, LEASE_KEYS) && value.version === 2 && value.kind === "p2q-mux-controlled-capture-v2" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.actionId) && Object.hasOwn(CASES, value.caseId));
  const selected = CASES[value.caseId], row = value.selection;
  need(profile(value.qualificationTargetProfile) && LEASE_KEYS.filter(key => key.endsWith("Sha256")).every(key => match(SHA, value[key])));
  need(closed(row, ["environmentId", "lessonId", "attemptId", "generation", "assetId", "uploadId"]) && match(ID, row.environmentId) && match(UUID, row.lessonId) && match(UUID, row.attemptId) && integer(row.generation, 1, 2147483647) && match(ID, row.assetId) && (row.uploadId === null || match(ID, row.uploadId)));
  need(integer(value.maxCaptures, 1, 2) && value.maxCaptures === selected.types.length && value.maxReplayPosts === selected.order.length && integer(value.maxReplayPosts, 1, 2));
  const start = iso(value.issuedAt), end = iso(value.expiresAt); need(end > start && end - start <= MUX_CAPTURE_LIMITS.milliseconds);
  need(directoryIdentity(value.captureRootIdentity) && directoryIdentity(value.actionDirectoryIdentity)); return value;
}
export function decodeMuxCaptureLeaseValue(raw) { return frozen(validateLease(parseCanonical(raw, MUX_CAPTURE_LIMITS.lease))); }
function ascii(value, maximum) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum && /^[\x20-\x7e]+$/u.test(value); }
export function encodeMuxCaptureEnvelope({ signature, contentType, body }) {
  need(ascii(signature, MUX_CAPTURE_LIMITS.signature) && ascii(contentType, MUX_CAPTURE_LIMITS.contentType) && Buffer.isBuffer(body) && body.length > 0 && body.length <= MUX_CAPTURE_LIMITS.body);
  const header = Buffer.from(signature), type = Buffer.from(contentType), prefix = Buffer.alloc(20);
  prefix.write("P2QMCAP1", 0, "ascii"); prefix.writeUInt32BE(header.length, 8); prefix.writeUInt32BE(type.length, 12); prefix.writeUInt32BE(body.length, 16);
  return Buffer.concat([prefix, header, type, body]);
}
export function decodeMuxCaptureEnvelope(raw) {
  need(Buffer.isBuffer(raw) && raw.length >= 23 && raw.length <= MUX_CAPTURE_LIMITS.envelope && raw.subarray(0, 8).toString("ascii") === "P2QMCAP1");
  const a = raw.readUInt32BE(8), b = raw.readUInt32BE(12), c = raw.readUInt32BE(16); need(a >= 1 && a <= 1024 && b >= 1 && b <= 128 && c >= 1 && c <= 65536 && 20 + a + b + c === raw.length);
  const result = { signature: raw.subarray(20, 20 + a).toString("utf8"), contentType: raw.subarray(20 + a, 20 + a + b).toString("utf8"), body: Buffer.from(raw.subarray(20 + a + b)) };
  need(encodeMuxCaptureEnvelope(result).equals(raw)); return Object.freeze(result);
}
function timestamp(signature) {
  const parts = signature.split(","), times = parts.filter(value => value.startsWith("t="));
  need(times.length === 1 && /^t=[1-9]\d*$/u.test(times[0]) && parts.some(value => /^v1=[a-f0-9]{64}$/u.test(value)));
  const time = Number(times[0].slice(2)); need(integer(time, 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000))); return time;
}
function validEvent(value) {
  return closed(value, EVENT_KEYS) && [value.id, value.objectId, value.assetId, value.environmentId].every(item => match(ID, item)) && ["video.asset.track.ready", "video.asset.track.deleted"].includes(value.type) && match(UUID, value.attemptId) && match(UUID, value.lessonId) && integer(value.generation, 1, 2147483647) && typeof eventNanoseconds(value.createdAt) === "bigint";
}
function managed(value, selection) { return closed(value, ["id", "lessonId", "status"]) && match(UUID, value.id) && match(UUID, value.lessonId) && STATUSES.includes(value.status) && (!selection || value.id === selection.attemptId && value.lessonId === selection.lessonId); }
function validateCommit(value) {
  need(closed(value, CAPTURE_KEYS) && value.version === 2 && value.kind === "P2Q_MUX_CAPTURE_COMMITTED" && match(SHA, value.leaseSha256) && integer(value.slot, 0, 1) && validEvent(value.event) && match(REQUEST, value.requestId) && integer(value.headerTimestamp, 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) && managed(value.managedResponse, value.event) && value.localResponseFinished === true && match(SHA, value.rawEnvelopeSha256) && integer(value.rawEnvelopeBytes, 23, 66708) && decimal(value.monotonicNanoseconds, false, 30));
  iso(value.capturedAt); return value;
}
export function projectMuxCaptureObservation(value) {
  validateCommit(value);
  const { rawEnvelopeSha256, rawEnvelopeBytes, ...safe } = value; void rawEnvelopeSha256; void rawEnvelopeBytes;
  safe.kind = "P2Q_MUX_CAPTURE_OBSERVED"; const result = parseCanonical(recordBytes(safe), MUX_CAPTURE_LIMITS.record); return frozen(result);
}

// Private, non-authoritative component model. Production factory never calls it.
// Tests append exports to a private exact-source copy; no test issuer ships.
const PUBLICATIONS = new WeakMap();
function createComponentState(rawLease, initialClock) {
  const lease = decodeMuxCaptureLeaseValue(rawLease), leaseSha256 = hash(rawLease), spec = CASES[lease.caseId];
  const captures = [], replays = [], pendingRaw = new Set(), active = new Set(), tokens = new WeakMap(), ids = new Set();
  let live = true, failureCode = null, failures = 0, ordinal = 0, observed = 0, lastWall, lastTick, deadline;
  const totals = { newWork: 0, recovery: 0 };
  function fail(code) { failures++; failureCode ??= code; live = false; for (const token of active) tokens.get(token)?.selection?.raw?.fill(0); for (const raw of pendingRaw) raw.fill(0); }
  function at(value) {
    need(closed(value, ["wallMilliseconds", "monotonicNanoseconds"]) && integer(value.wallMilliseconds, 0) && decimal(value.monotonicNanoseconds, false, 30), "P2Q_MUX_CLOCK_REFUSED");
    const wall = value.wallMilliseconds, tick = BigInt(value.monotonicNanoseconds);
    if (deadline === undefined) deadline = tick + BigInt(iso(lease.expiresAt) - wall) * 1000000n;
    need(wall >= iso(lease.issuedAt) && wall < iso(lease.expiresAt) && (lastWall === undefined || wall >= lastWall) && (lastTick === undefined || tick >= lastTick) && tick < deadline, "P2Q_MUX_CLOCK_REFUSED");
    lastWall = wall; lastTick = tick; return { wall, tick };
  }
  at(initialClock);
  function current(token, clock) {
    const item = tokens.get(token); if (!item || item.finished || !live) return null;
    try { return { item, time: at(clock) }; } catch { fail("P2Q_MUX_CLOCK_REFUSED"); return null; }
  }
  function candidate(context, time) {
    need(plain(context) && context.method === "POST" && context.target === "/course/v1/webhooks/mux" && plain(context.headers) && Buffer.isBuffer(context.body) && isUtf8(context.body));
    const signature = Object.getOwnPropertyDescriptor(context.headers, "mux-signature")?.value, contentType = Object.getOwnPropertyDescriptor(context.headers, "content-type")?.value;
    const raw = encodeMuxCaptureEnvelope({ signature, contentType, body: context.body });
    try {
    const signedAt = timestamp(signature); need(signedAt <= Math.floor(time.wall / 1000) && time.wall <= (signedAt + 300) * 1000);
    const body = JSON.parse(context.body.toString("utf8")), selected = lease.selection, marker = `lash-her-course:${selected.environmentId}:${selected.attemptId}`;
    need(plain(body) && match(ID, body.id) && plain(body.environment) && body.environment.id === selected.environmentId && plain(body.data) && match(ID, body.data.id) && body.data.asset_id === selected.assetId && spec.types.includes(body.type));
    need(body.type === "video.asset.track.ready" ? body.data.passthrough === marker : body.data.passthrough === undefined || body.data.passthrough === marker);
    eventNanoseconds(body.created_at);
    return { raw, headerTimestamp: signedAt, event: { id: body.id, type: body.type, createdAt: body.created_at, environmentId: selected.environmentId, objectId: body.data.id, assetId: selected.assetId, attemptId: selected.attemptId, lessonId: selected.lessonId, generation: selected.generation } };
    } catch (error) { raw.fill(0); throw error; }
  }
  const component = {
    beginAdmitted(context, clock) {
      if (!live) return null;
      try {
        const time = at(clock); need(closed(context, ["requestId", "route", "category"]) && match(REQUEST, context.requestId) && !ids.has(context.requestId) && ["newWork", "recovery"].includes(context.category));
        const sourceRoute = context.route; need(plain(sourceRoute) && ["method", "path", "auth", "service"].every(key => !Object.hasOwn(sourceRoute, key) || Object.hasOwn(Object.getOwnPropertyDescriptor(sourceRoute, key), "value")));
        const route = { method: sourceRoute.method, path: sourceRoute.path, auth: sourceRoute.auth, service: sourceRoute.service ?? "course" }, service = route.service;
        need(["course", "community"].includes(service) && ["POST", "PUT", "PATCH", "DELETE"].includes(route?.method) && typeof route.path === "string" && /^\/v1\/[A-Za-z0-9_{}/-]{1,127}$/u.test(route.path));
        need(ordinal < 64, "P2Q_MUX_LEDGER_LIMIT");
        const token = Object.freeze({}), item = { requestId: context.requestId, route, category: context.category, ordinal: ordinal++, service, start: time, upstreamAttempted: false, upstreamStatus: null, finished: false };
        ids.add(item.requestId); totals[item.category]++; active.add(token); tokens.set(token, item); return token;
      } catch (error) { fail(error.code ?? "P2Q_MUX_VALUE_REFUSED"); return null; }
    },
    select(token, context, clock, privateIntent = null) {
      const result = current(token, clock); if (!result || result.item.selection) return null;
      const { item, time } = result;
      if (item.category !== "recovery" || item.service !== "course" || item.route.path !== "/v1/webhooks/mux" || item.route.auth !== "webhook") return null;
      let selected;
      try {
        selected = candidate(context, time);
        if (privateIntent !== null) {
          const intent = parseCanonical(privateIntent, 8192);
          need(closed(intent, INTENT_KEYS) && intent.version === 2 && intent.kind === "P2Q_MUX_REPLAY_INTENT" && intent.leaseSha256 === leaseSha256 && integer(intent.sequence, 0, spec.order.length - 1) && intent.captureSlot === spec.order[intent.sequence] && match(SHA, intent.sendStartedSha256));
          const original = captures[intent.captureSlot]?.record;
          need(original && !replays[intent.sequence] && replays.filter(Boolean).length === intent.sequence && (intent.sequence === 0 || replays[intent.sequence - 1]?.record) && intent.expectedEnvelopeSha256 === original.rawEnvelopeSha256 && intent.expectedEnvelopeSha256 === hash(selected.raw) && intent.eventId === original.event.id && intent.eventId === selected.event.id && intent.originalHeaderTimestamp === original.headerTimestamp && intent.originalHeaderTimestamp === selected.headerTimestamp);
          need(iso(intent.issuedAt) >= iso(lease.issuedAt) && iso(intent.issuedAt) <= time.wall && iso(intent.expiresAt) === Math.min(iso(lease.expiresAt), (original.headerTimestamp + 300) * 1000) && time.wall < iso(intent.expiresAt));
          item.selection = { mode: "replay", intent, event: selected.event, headerTimestamp: selected.headerTimestamp, time }; replays[intent.sequence] = { reserved: true };
          selected.raw.fill(0); return token;
        }
        const slot = spec.types.indexOf(selected.event.type); need(slot >= 0 && !captures[slot]);
        if (slot === 1) { const first = captures[0]?.record; need(first && first.event.id !== selected.event.id && first.event.objectId === selected.event.objectId && eventNanoseconds(first.event.createdAt) < eventNanoseconds(selected.event.createdAt)); }
        captures[slot] = { reserved: true }; item.selection = { mode: "capture", slot, ...selected, time }; return token;
      } catch { selected?.raw.fill(0); return null; }
    },
    markUpstreamAttempt(token, clock) { const result = current(token, clock); if (result) result.item.upstreamAttempted = true; },
    observeUpstream(token, upstream, clock) {
      const result = current(token, clock); if (!result) return;
      const { item } = result;
      if (!integer(upstream?.status, 100, 599)) { fail("P2Q_MUX_RESPONSE_REFUSED"); return; }
      item.upstreamStatus = upstream.status;
      if (!item.selection) return;
      try {
        need(item.upstreamAttempted && upstream.status === 200 && Buffer.isBuffer(upstream.body) && upstream.body.length <= 4096 && isUtf8(upstream.body));
        const value = JSON.parse(upstream.body.toString("utf8")); need(closed(value, ["videoAsset"]) && managed(value.videoAsset, lease.selection));
        item.managedResponse = { ...value.videoAsset };
      } catch { item.rejectedResponse = true; }
    },
    finish(token, response, clock) {
      const item = tokens.get(token); if (!item || item.finished) return null;
      let time;
      try { if (live) time = at(clock); } catch { fail("P2Q_MUX_CLOCK_REFUSED"); }
      item.finished = true; active.delete(token); tokens.delete(token); observed++;
      const local = typeof response?.writableFinished === "boolean" ? response.writableFinished : null;
      const globalRecord = { version: 2, kind: "P2Q_MUX_ADMITTED_REQUEST_OBSERVED", leaseSha256, ordinal: item.ordinal, requestId: item.requestId, category: item.category, service: item.service, method: item.route.method, routeTemplate: item.route.path, startedAt: new Date(item.start.wall).toISOString(), finishedAt: time ? new Date(time.wall).toISOString() : null, upstreamAttempted: item.upstreamAttempted, upstreamStatus: item.upstreamStatus, localResponseFinished: local };
      if (recordBytes(globalRecord).length > 768) { item.selection?.raw?.fill(0); fail("P2Q_MUX_LEDGER_LIMIT"); return null; }
      let capture = null, replay = null, raw = null;
      if (live && time && local === true && item.managedResponse && !item.rejectedResponse && item.selection) {
        const selected = item.selection;
        if (selected.mode === "capture") {
          capture = { version: 2, kind: "P2Q_MUX_CAPTURE_COMMITTED", leaseSha256, slot: selected.slot, event: selected.event, requestId: item.requestId, headerTimestamp: selected.headerTimestamp, capturedAt: new Date(selected.time.wall).toISOString(), monotonicNanoseconds: selected.time.tick.toString(), managedResponse: item.managedResponse, localResponseFinished: true, rawEnvelopeSha256: hash(selected.raw), rawEnvelopeBytes: selected.raw.length };
          validateCommit(capture); raw = Buffer.from(selected.raw); pendingRaw.add(raw); captures[selected.slot].record = capture;
        } else {
          replay = { version: 2, kind: "P2Q_MUX_REPLAY_OBSERVED", leaseSha256, sequence: selected.intent.sequence, captureSlot: selected.intent.captureSlot, sendStartedSha256: selected.intent.sendStartedSha256, requestId: item.requestId, event: selected.event, headerTimestamp: selected.headerTimestamp, observedAt: new Date(time.wall).toISOString(), monotonicNanoseconds: time.tick.toString(), managedResponse: item.managedResponse, localResponseFinished: true };
          replays[selected.intent.sequence].record = replay;
        }
      }
      item.selection?.raw?.fill(0);
      const started = process.hrtime.bigint(), wallStarted = Date.now();
      const publicationLive = () => { const elapsed = process.hrtime.bigint() - started, wallElapsed = Date.now() - wallStarted;
        return live && time && elapsed >= 0n && wallElapsed >= 0 && time.tick + elapsed < deadline && time.wall + Math.max(wallElapsed, Number(elapsed / 1000000n)) < iso(lease.expiresAt); };
      const handle = Object.freeze({}); PUBLICATIONS.set(handle, { live: publicationLive, fail, globalRecord, capture, replay, raw, used: false, lease }); return handle;
    },
    invalidate() { fail("P2Q_MUX_COMPONENT_REVOKED"); },
    snapshot() { return Object.freeze({ version: 2, kind: "P2Q_MUX_COMPONENT_PROJECTION", live, failureCode, observationFailures: failures, admitted: { ...totals }, finished: observed, rawReserved: captures.filter(Boolean).length, rawObserved: captures.filter(item => item?.record).length, replayReserved: replays.filter(Boolean).length, replayObserved: replays.filter(item => item?.record).length, actualDrainProven: false, sourceAuthorityProven: false }); },
  };
  return Object.freeze(component);
}
function componentPublicationView(handle) {
  const item = PUBLICATIONS.get(handle); need(item, "P2Q_MUX_PUBLICATION_REFUSED");
  return { globalRecord: structuredClone(item.globalRecord), capture: item.capture ? structuredClone(item.capture) : null, replay: item.replay ? structuredClone(item.replay) : null, raw: item.raw ? Buffer.from(item.raw) : null };
}
async function publishComponentPublication(handle, directory, identity) {
  const item = PUBLICATIONS.get(handle); need(item && !item.used, "P2Q_MUX_PUBLICATION_REFUSED"); item.used = true;
  let descriptor;
  const live = () => need(item.live(), "P2Q_MUX_PUBLICATION_REFUSED");
  async function checked(operation) { live(); const result = await operation(); live(); return result; }
  async function acquire(operation) { live(); const result = await operation(); try { live(); return result; } catch (error) { await result.close(); throw error; } }
  try {
    need(isAbsolute(directory) && resolve(directory) === directory && closed(identity, ["device", "inode", "uid", "gid", "mode", "fileUid", "fileGid"]) && identity.mode === 0o770 && [identity.uid, identity.gid, identity.fileUid, identity.fileGid].every(value => integer(value)));
    let cursor = parse(directory).root;
    for (const part of directory.slice(cursor.length).split("/").filter(Boolean)) { cursor = join(cursor, part); const info = await checked(() => fs.lstat(cursor)); need(!info.isSymbolicLink() && info.isDirectory()); }
    need(await checked(() => fs.realpath(directory)) === directory);
    const parent = await checked(() => fs.stat(dirname(directory), { bigint: true }));
    need(parent.dev.toString() === item.lease.captureRootIdentity.device && parent.ino.toString() === item.lease.captureRootIdentity.inode && Number(parent.mode & 0o7777n) === 0o770 && Number(parent.uid) === identity.uid && Number(parent.gid) === identity.gid);
    const outer = await checked(() => fs.stat(dirname(dirname(directory)))); need((outer.mode & 0o7777) === 0o700 && outer.uid === identity.uid);
    descriptor = await acquire(() => fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const info = await checked(() => descriptor.stat({ bigint: true }));
    need(info.dev.toString() === identity.device && info.ino.toString() === identity.inode && identity.device === item.lease.actionDirectoryIdentity.device && identity.inode === item.lease.actionDirectoryIdentity.inode && Number(info.uid) === identity.uid && Number(info.gid) === identity.gid && Number(info.mode & 0o7777n) === identity.mode);
    async function write(name, raw) {
      need(/^(?:capture-[01]\.(?:private|committed\.json)|replay-[01]\.observed\.json|admitted-\d\d\.observed\.json)$/u.test(name));
      let file;
      try {
        file = await acquire(() => fs.open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        const stat = await checked(() => file.stat()); need(stat.isFile() && stat.uid === identity.fileUid && stat.gid === identity.fileGid && (stat.mode & 0o7777) === 0o600);
        let position = 0; while (position < raw.length) { const result = await checked(() => file.write(raw, position, raw.length - position)); need(integer(result.bytesWritten, 1, raw.length - position)); position += result.bytesWritten; }
        await checked(() => file.sync());
      } finally { if (file) await file.close(); }
      await checked(() => descriptor.sync());
      const fresh = await checked(() => fs.lstat(directory, { bigint: true })); need(!fresh.isSymbolicLink() && fresh.dev === info.dev && fresh.ino === info.ino && fresh.uid === info.uid && fresh.gid === info.gid && fresh.mode === info.mode);
    }
    if (item.capture) {
      need(item.raw && hash(item.raw) === item.capture.rawEnvelopeSha256 && item.raw.length === item.capture.rawEnvelopeBytes); decodeMuxCaptureEnvelope(item.raw);
      await write(`capture-${item.capture.slot}.private`, item.raw);
      await write(`capture-${item.capture.slot}.committed.json`, recordBytes(item.capture));
    }
    if (item.replay) await write(`replay-${item.replay.sequence}.observed.json`, recordBytes(item.replay));
    await write(`admitted-${String(item.globalRecord.ordinal).padStart(2, "0")}.observed.json`, recordBytes(item.globalRecord));
    return Object.freeze({ currentPublicationCallsReturned: true, historicalProducerAuthorityProven: false });
  } catch { item.fail("P2Q_MUX_PUBLICATION_REFUSED"); refuse("P2Q_MUX_PUBLICATION_REFUSED"); }
  finally { item.raw?.fill(0); if (descriptor) { try { await descriptor.close(); } catch { item.fail("P2Q_MUX_PUBLICATION_REFUSED"); refuse("P2Q_MUX_PUBLICATION_REFUSED"); } } }
}
// Referenced without invoking: these private components cannot activate a gateway.
void createComponentState; void componentPublicationView; void publishComponentPublication;
