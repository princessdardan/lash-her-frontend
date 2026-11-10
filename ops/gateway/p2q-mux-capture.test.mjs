import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fsp from "node:fs/promises";
import { constants, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, realpathSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createP2QMuxCapture, decodeMuxCaptureEnvelope, decodeMuxCaptureLeaseValue, encodeMuxCaptureEnvelope, projectMuxCaptureObservation, MUX_CAPTURE_COMPONENT_SCHEMA_SHA256, P2Q_MUX_CAPTURE_ARM_AVAILABLE } from "./p2q-mux-capture.mjs";

// Explicit component projection: append exports to exact source in this test
// process only. No test issuer/options/env bridge is present in the shipped API.
const source = readFileSync(new URL("./p2q-mux-capture.mjs", import.meta.url), "utf8");
const suffix = "\nexport const projectedComponents={createComponentState,componentPublicationView,publishComponentPublication,recordBytes,eventNanoseconds};\n";
const { projectedComponents: component } = await import("data:text/javascript;base64," + Buffer.from(source + suffix).toString("base64"));
const { createComponentState, componentPublicationView: view, publishComponentPublication: publish, recordBytes, eventNanoseconds } = component;
const sha = raw => createHash("sha256").update(raw).digest("hex");
const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const cloned = value => structuredClone(value);
const CODE = error => typeof error.code === "string" && error.code.startsWith("P2Q_MUX_");
function fixture(caseId = "D1", identities, duration = 120000) {
  const wall = Date.parse("2026-11-06T12:00:00.000Z"), clock = { wallMilliseconds: wall, monotonicNanoseconds: "1000" };
  const lease = { version: 2, kind: "p2q-mux-controlled-capture-v2", actionId: "owned-component", caseId,
    qualificationTargetProfile: { version: 1, id: "owned-unregistered-data", sha256: "1".repeat(64) },
    candidateSha256: "2".repeat(64), operatorSourceClosureSha256: "3".repeat(64), planSha256: "4".repeat(64), configurationSha256: "5".repeat(64), gatewayConfigurationSha256: "6".repeat(64), gatewayProcessSha256: "7".repeat(64), gatewayImageSha256: "8".repeat(64), courseImageSha256: "9".repeat(64), sourceWitnessSha256: "a".repeat(64),
    issuedAt: new Date(wall).toISOString(), expiresAt: new Date(wall + duration).toISOString(), maxCaptures: caseId === "R1" ? 2 : 1, maxReplayPosts: caseId === "R1" ? 2 : 1,
    selection: { environmentId: "owned-environment", lessonId: uuid(1), attemptId: uuid(2), generation: 1, assetId: "owned-asset", uploadId: "owned-upload" },
    captureRootIdentity: identities?.root ?? { device: "1", inode: "2" }, actionDirectoryIdentity: identities?.action ?? { device: "1", inode: "3" } };
  const rawLease = recordBytes(lease), state = createComponentState(rawLease, clock);
  let next = 10;
  return { lease, rawLease, state, clock, nextId: () => uuid(next++), advance(milliseconds) { clock.wallMilliseconds += milliseconds; clock.monotonicNanoseconds = (BigInt(clock.monotonicNanoseconds) + BigInt(milliseconds) * 1000000n).toString(); } };
}
function request(f, type = "video.asset.track.ready", changes = {}) {
  const selected = f.lease.selection;
  const event = { id: type.endsWith("deleted") ? "owned-event-deleted" : "owned-event-ready", type, created_at: new Date(f.clock.wallMilliseconds).toISOString(), environment: { id: selected.environmentId }, data: { id: "owned-track", asset_id: selected.assetId, passthrough: `lash-her-course:${selected.environmentId}:${selected.attemptId}`, ignored_private_url: "https://private.invalid/RAW_URL_CANARY?token=RAW_TOKEN_CANARY" }, ...changes };
  const body = Buffer.from(JSON.stringify(event, null, 2));
  const signedAt = Math.floor(f.clock.wallMilliseconds / 1000), mac = createHmac("sha256", "OWNED_SYNTHETIC_SIGNING_KEY").update(`${signedAt}.`).update(body).digest("hex");
  return { method: "POST", target: "/course/v1/webhooks/mux", headers: { "mux-signature": `t=${signedAt},v1=${mac}`, "content-type": "application/json", authorization: "Bearer AUTH_CANARY_NOT_OUTPUT" }, body };
}
function begin(f, requestId = f.nextId(), route = { method: "POST", path: "/v1/webhooks/mux", auth: "webhook" }, category = "recovery") {
  return f.state.beginAdmitted({ requestId, route, category }, f.clock);
}
function upstream(f, status = 200, row = {}) { return { status, body: Buffer.from(JSON.stringify({ videoAsset: { id: f.lease.selection.attemptId, lessonId: f.lease.selection.lessonId, status: "ready", ...row } })) }; }
function complete(f, context = request(f), intent = null, status = 200, finished = true, requestId = f.nextId()) {
  const token = begin(f, requestId); const selected = f.state.select(token, context, f.clock, intent);
  f.state.markUpstreamAttempt(token, f.clock); f.state.observeUpstream(token, upstream(f, status), f.clock);
  return { selected, token, publication: f.state.finish(token, { writableFinished: finished }, f.clock), context, requestId };
}
function replayIntent(f, original, sequence) {
  const safe = projectMuxCaptureObservation(original.capture);
  const started = { version: 2, kind: "P2Q_MUX_SEND_STARTED", leaseSha256: sha(f.rawLease), sequence, captureSlot: original.capture.slot, captureObservationSha256: sha(recordBytes(safe)), createdAt: new Date(f.clock.wallMilliseconds).toISOString() };
  return recordBytes({ version: 2, kind: "P2Q_MUX_REPLAY_INTENT", leaseSha256: sha(f.rawLease), sequence, captureSlot: original.capture.slot, sendStartedSha256: sha(recordBytes(started)), expectedEnvelopeSha256: original.capture.rawEnvelopeSha256, eventId: original.capture.event.id, originalHeaderTimestamp: original.capture.headerTimestamp, issuedAt: new Date(f.clock.wallMilliseconds).toISOString(), expiresAt: new Date(Math.min(Date.parse(f.lease.expiresAt), (original.capture.headerTimestamp + 300) * 1000)).toISOString() });
}
function rawContext(value) { const raw = decodeMuxCaptureEnvelope(value.raw); return { method: "POST", target: "/course/v1/webhooks/mux", headers: { "mux-signature": raw.signature, "content-type": raw.contentType }, body: raw.body }; }
function ownedTree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "p2q-mux-component-"))); chmodSync(base, 0o700);
  const root = join(base, "capture-root"), action = join(root, "owned-component"); mkdirSync(root, 0o770); chmodSync(root, 0o770); mkdirSync(action, 0o770); chmodSync(action, 0o770);
  const ids = path => { const item = statSync(path, { bigint: true }); return { device: item.dev.toString(), inode: item.ino.toString() }; };
  const stat = statSync(action);
  return { base, root, action, identities: { root: ids(root), action: ids(action) }, identity: { ...ids(action), uid: stat.uid, gid: stat.gid, mode: 0o770, fileUid: process.getuid(), fileGid: process.getgid() }, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

test("public five-hook factory is always a no-I/O no-throw no-op, including current/unknown/forged authority", () => {
  assert.equal(P2Q_MUX_CAPTURE_ARM_AVAILABLE, false);
  assert.equal(MUX_CAPTURE_COMPONENT_SCHEMA_SHA256, "c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a");
  const hostile = new Proxy({}, { get() { throw Error("GETTER_CANARY"); }, ownKeys() { throw Error("KEY_CANARY"); } });
  for (const input of [undefined, null, hostile, { qualificationTargetProfile: { id: "staging-current" }, authority: true }, { allocated: true, firstUse: true, path: "/must-not-read" }]) {
    const value = createP2QMuxCapture(input, { activate: true, verify: () => { throw Error("CALLBACK_CANARY"); } });
    assert.ok(Object.isFrozen(value)); assert.deepEqual(Object.keys(value).sort(), ["beginAdmitted", "finish", "markUpstreamAttempt", "observeUpstream", "select"].sort());
    assert.equal(value.beginAdmitted(hostile), null); assert.equal(value.select(hostile), null);
    for (const method of ["markUpstreamAttempt", "observeUpstream", "finish"]) assert.doesNotThrow(() => value[method](hostile));
  }
  const body = source.slice(source.indexOf("export function createP2QMuxCapture"), source.indexOf("const SHA"));
  assert.equal(/fs\.|process\.env|readFile|createComponentState|options|verify\(/u.test(body), false);
});

test("canonical lease codecs are syntax-only, exact-byte, closed, and reject numeric bool/negative-zero/alternate lexical forms", () => {
  const f = fixture(); assert.equal(decodeMuxCaptureLeaseValue(f.rawLease).qualificationTargetProfile.id, "owned-unregistered-data");
  const current = cloned(f.lease); current.qualificationTargetProfile.id = "staging-current"; assert.equal(decodeMuxCaptureLeaseValue(recordBytes(current)).qualificationTargetProfile.id, "staging-current");
  const zeroDataHash = cloned(f.lease); zeroDataHash.candidateSha256 = "0".repeat(64); assert.equal(decodeMuxCaptureLeaseValue(recordBytes(zeroDataHash)).candidateSha256, "0".repeat(64));
  const mutations = [v => { v.extra = true; }, v => { v.version = true; }, v => { v.maxCaptures = true; }, v => { v.maxReplayPosts = 2; }, v => { v.selection.generation = 0; }, v => { v.selection.generation = true; }, v => { v.selection.generation = 2147483648; }, v => { v.selection.eventTypes = []; }, v => { v.selection.trackId = "caller"; }, v => { v.selection.uploadId = ""; }, v => { v.selection.assetId = false; }, v => { v.qualificationTargetProfile.sha256 = "0".repeat(64); }, v => { v.qualificationTargetProfile.id = "1wrong"; }, v => { v.qualificationTargetProfile.version = true; }, v => { v.actionDirectoryIdentity.inode = "0"; }, v => { v.expiresAt = "2026-11-06T12:02:00.001Z"; }, v => { v.issuedAt = "2026-02-30T12:00:00.000Z"; }, v => { v.candidateSha256 = "X".repeat(64); }, v => { v.caseId = "provider-retry"; }];
  for (const change of mutations) { const value = cloned(f.lease); change(value); assert.throws(() => decodeMuxCaptureLeaseValue(recordBytes(value)), CODE); }
  for (const raw of [Buffer.from(JSON.stringify(f.lease)), Buffer.from(" " + f.rawLease), Buffer.from(f.rawLease.toString().replace('"version":2', '"version":2.0')), Buffer.from(f.rawLease.toString().replace('"version":2', '"version":2e0')), Buffer.from(f.rawLease.toString().replace('"version":2', '"version":2,"version":2'))]) assert.throws(() => decodeMuxCaptureLeaseValue(raw), CODE);
  assert.throws(() => recordBytes({ value: -0 }), CODE);
});

test("private envelope preserves original noncanonical signed bytes; no signing or canonical body rewrite", () => {
  const f = fixture(), context = request(f), raw = encodeMuxCaptureEnvelope({ signature: context.headers["mux-signature"], contentType: context.headers["content-type"], body: context.body }), decoded = decodeMuxCaptureEnvelope(raw);
  assert.deepEqual(decoded.body, context.body); assert.equal(decoded.signature, context.headers["mux-signature"]);
  const t = decoded.signature.split(",")[0].slice(2), mac = createHmac("sha256", "OWNED_SYNTHETIC_SIGNING_KEY").update(t + ".").update(decoded.body).digest("hex");
  assert.equal(decoded.signature, `t=${t},v1=${mac}`);
  const bad = [Buffer.alloc(0), raw.subarray(0, raw.length - 1), Buffer.concat([raw, Buffer.from("x")]), Buffer.from(raw)]; bad[3][0] = 0;
  for (const value of bad) assert.throws(() => decodeMuxCaptureEnvelope(value), CODE);
  for (const change of [v => { v.body = Buffer.alloc(0); }, v => { v.body = Buffer.alloc(65537); }, v => { v.signature = ""; }, v => { v.signature = "x".repeat(1025); }, v => { v.contentType = "x\nInjected: true"; }]) {
    const value = { signature: decoded.signature, contentType: decoded.contentType, body: decoded.body }; change(value); assert.throws(() => encodeMuxCaptureEnvelope(value), CODE);
  }
  decoded.body.fill(0); assert.deepEqual(decodeMuxCaptureEnvelope(raw).body, context.body);
});

test("projected raw capture requires exact managed200, original body, selected environment/asset/passthrough and local finish", () => {
  const f = fixture(), good = request(f), expectedBody = Buffer.from(good.body), token = begin(f);
  assert.equal(f.state.select(token, good, f.clock), token); good.body.fill(0);
  f.state.markUpstreamAttempt(token, f.clock); f.state.observeUpstream(token, upstream(f), f.clock);
  const publication = f.state.finish(token, { writableFinished: true }, f.clock), value = view(publication);
  assert.deepEqual(decodeMuxCaptureEnvelope(value.raw).body, expectedBody); assert.equal(value.capture.managedResponse.id, f.lease.selection.attemptId);
  assert.equal(f.state.finish(token, { writableFinished: true }, f.clock), null);
  assert.equal(f.state.select({}, request(f), f.clock), null);
  const safe = projectMuxCaptureObservation(value.capture), serialized = recordBytes(safe).toString();
  assert.equal(safe.kind, "P2Q_MUX_CAPTURE_OBSERVED"); assert.equal(Object.hasOwn(safe, "rawEnvelopeSha256"), false); assert.equal(Object.hasOwn(safe, "rawEnvelopeBytes"), false);
  for (const secret of ["RAW_URL_CANARY", "RAW_TOKEN_CANARY", "AUTH_CANARY", "OWNED_SYNTHETIC_SIGNING_KEY", value.capture.rawEnvelopeSha256]) assert.equal(serialized.includes(secret), false);
  assert.notEqual(sha(recordBytes(safe)), sha(recordBytes(value.capture))); assert.equal(f.state.snapshot().sourceAuthorityProven, false);
});

test("unaccepted/ambiguous managed200 projections or dropped local response never produce a capture", () => {
  for (const mutate of [v => { v.status = 400; }, v => { v.body = Buffer.from("{}"); }, v => { v.body = Buffer.from(JSON.stringify({ videoAsset: { id: uuid(99), lessonId: uuid(1), status: "ready" } })); }, v => { v.body = Buffer.from(JSON.stringify({ videoAsset: { id: uuid(2), lessonId: uuid(1), status: "ready", private: "CANARY" } })); }]) {
    const f = fixture(), token = begin(f), context = request(f); f.state.select(token, context, f.clock); f.state.markUpstreamAttempt(token, f.clock);
    const response = upstream(f); mutate(response); f.state.observeUpstream(token, response, f.clock);
    assert.equal(view(f.state.finish(token, { writableFinished: true }, f.clock)).capture, null);
    assert.equal(f.state.select(begin(f), context, f.clock), null); // Reserved slot is not recycled.
  }
  const f = fixture(), result = complete(f, request(f), null, 200, false); assert.equal(view(result.publication).capture, null); assert.equal(view(result.publication).globalRecord.localResponseFinished, false);
});

test("wrong environment/ownership, altered header shapes, old/future signatures and route bypass refuse selection only", () => {
  const changes = [v => { v.target = "/v1/webhooks/mux"; }, v => { v.headers["mux-signature"] = "t=1,v1=" + "a".repeat(64); }, v => { v.headers["mux-signature"] = `t=${Math.floor(Date.parse("2026-11-06T12:00:01Z") / 1000)},v1=${"a".repeat(64)}`; }, v => { const b = JSON.parse(v.body); b.environment.id = "foreign"; v.body = Buffer.from(JSON.stringify(b)); }, v => { const b = JSON.parse(v.body); b.data.asset_id = "foreign"; v.body = Buffer.from(JSON.stringify(b)); }, v => { const b = JSON.parse(v.body); b.data.passthrough = "foreign"; v.body = Buffer.from(JSON.stringify(b)); }, v => { v.headers["content-type"] = ""; }];
  for (const change of changes) { const f = fixture(), context = request(f); change(context); assert.equal(f.state.select(begin(f), context, f.clock), null); assert.equal(f.state.snapshot().rawReserved, 0); }
});

test("calendar/nanosecond ordering is exact and rejects normalized invalid dates/leap seconds", () => {
  assert.equal(eventNanoseconds("2026-11-06T12:00:00.123456789Z") - eventNanoseconds("2026-11-06T12:00:00.123456788Z"), 1n);
  assert.equal(eventNanoseconds("2026-11-06T12:00:00.123456789Z"), eventNanoseconds("2026-11-06T13:00:00.123456789+01:00"));
  eventNanoseconds("0001-01-01T00:00:00Z"); eventNanoseconds("9999-12-31T23:59:59.999999999Z");
  for (const value of ["0000-01-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-11-06T12:00:60Z", "2026-11-06T24:00:00Z", "2026-11-06T12:00:00+24:00", "2026-11-06T12:00:00+00:60", "2026-11-06T12:00:00.1234567890Z"]) assert.throws(() => eventNanoseconds(value), CODE);
});

test("two raw slots do not exhaust two separate prescribed reverse-replay metadata slots", () => {
  const f = fixture("R1"), first = view(complete(f).publication); f.advance(1000);
  const second = view(complete(f, request(f, "video.asset.track.deleted")).publication); assert.equal(second.capture.slot, 1);
  f.advance(1000); const response1 = complete(f, rawContext(second), replayIntent(f, second, 0)); const observed1 = view(response1.publication);
  assert.equal(observed1.capture, null); assert.equal(observed1.raw, null); assert.equal(observed1.replay.captureSlot, 1); assert.equal(observed1.replay.requestId, response1.requestId);
  const response2 = complete(f, rawContext(first), replayIntent(f, first, 1)); const observed2 = view(response2.publication);
  assert.equal(observed2.capture, null); assert.equal(observed2.replay.captureSlot, 0); assert.notEqual(observed2.replay.requestId, observed1.replay.requestId);
  assert.equal(f.state.snapshot().rawReserved, 2); assert.equal(f.state.snapshot().replayObserved, 2);
  assert.equal(f.state.select(begin(f), rawContext(second), f.clock, replayIntent(f, second, 0)), null);
});

test("R1 same track, distinct event and strictly increasing creation time required; missing/forged private intents refuse", () => {
  for (const mutate of [b => { b.created_at = "2026-11-06T12:00:00.000Z"; }, b => { b.data.id = "another-track"; }, b => { b.id = "owned-event-ready"; }]) {
    const f = fixture("R1"); complete(f); f.advance(1000); const context = request(f, "video.asset.track.deleted"), b = JSON.parse(context.body); mutate(b); context.body = Buffer.from(JSON.stringify(b));
    assert.equal(f.state.select(begin(f), context, f.clock), null);
  }
  const mutations = [v => { v.extra = true; }, v => { v.sequence = true; }, v => { v.captureSlot = 1; }, v => { v.expectedEnvelopeSha256 = "f".repeat(64); }, v => { v.eventId = "foreign"; }, v => { v.leaseSha256 = "f".repeat(64); }, v => { v.originalHeaderTimestamp++; }, v => { v.expiresAt = "2026-11-06T12:02:01.000Z"; }, v => { v.issuedAt = "2026-11-06T12:00:01.000Z"; }];
  for (const change of mutations) { const f = fixture(), original = view(complete(f).publication), intent = JSON.parse(replayIntent(f, original, 0)); change(intent); assert.equal(f.state.select(begin(f), rawContext(original), f.clock, recordBytes(intent)), null); }
});

test("naturally raced metadata cannot be relabeled as the sender; same intent slot burns and no raw recapture", () => {
  const f = fixture(), original = view(complete(f).publication), intent = replayIntent(f, original, 0);
  const natural = complete(f, rawContext(original), intent); const actualSenderId = f.nextId();
  assert.notEqual(view(natural.publication).replay.requestId, actualSenderId); // Host must refuse this join.
  const sender = complete(f, rawContext(original), intent, 200, true, actualSenderId);
  assert.equal(sender.selected, null); assert.equal(view(sender.publication).capture, null); assert.equal(view(sender.publication).replay, null);
  assert.equal(f.state.snapshot().replayReserved, 1);
});

test("global metadata includes unrelated category traffic, copies route template, and does not claim drain", () => {
  const f = fixture(), route = { method: "DELETE", path: "/v1/admin/courses/{courseId}", service: "community", auth: "application" }, token = begin(f, f.nextId(), route, "newWork");
  route.path = "/SHOULD_NOT_APPEAR/CANARY";
  f.state.markUpstreamAttempt(token, f.clock); f.state.observeUpstream(token, { status: 409, body: Buffer.from("PRIVATE_BODY_CANARY") }, f.clock);
  const value = view(f.state.finish(token, { writableFinished: true }, f.clock));
  assert.equal(value.capture, null); assert.equal(value.globalRecord.category, "newWork"); assert.equal(value.globalRecord.routeTemplate, "/v1/admin/courses/{courseId}"); assert.equal(value.globalRecord.upstreamStatus, 409);
  assert.equal(JSON.stringify(value.globalRecord).includes("CANARY"), false); assert.equal(f.state.snapshot().actualDrainProven, false);
  assert.equal(recordBytes(value.globalRecord).length <= 768, true);
});

test("bounded global ledger and duplicated request IDs fail closed without rejecting ordinary traffic via public hooks", () => {
  const f = fixture(); for (let i = 0; i < 64; i++) assert.ok(begin(f)); assert.equal(begin(f), null); assert.equal(f.state.snapshot().failureCode, "P2Q_MUX_LEDGER_LIMIT");
  const duplicate = fixture(), id = duplicate.nextId(); assert.ok(begin(duplicate, id)); assert.equal(begin(duplicate, id), null); assert.equal(duplicate.state.snapshot().live, false);
});

test("expiry, wall rollback, monotonic expiry and explicit revocation prevent capture/publication", async () => {
  for (const change of [f => f.advance(120000), f => { f.clock.wallMilliseconds--; }, f => { f.clock.monotonicNanoseconds = "120000001000"; }, f => f.state.invalidate()]) {
    const f = fixture(), token = begin(f); f.state.select(token, request(f), f.clock); f.state.markUpstreamAttempt(token, f.clock); change(f);
    f.state.observeUpstream(token, upstream(f), f.clock); const value = view(f.state.finish(token, { writableFinished: false }, f.clock));
    assert.equal(value.capture, null); assert.equal(value.globalRecord.finishedAt, null); assert.equal(f.state.snapshot().live, false);
  }
  const tree = ownedTree(); try { const f = fixture("D1", tree.identities), publication = complete(f).publication; f.state.invalidate(); await assert.rejects(publish(publication, tree.action, tree.identity), CODE); assert.deepEqual(readdirSync(tree.action), []); } finally { tree.cleanup(); }
});

test("actual owned filesystem commits raw0600 then metadata and ledger with directory fsync; no historical authority claim", async () => {
  const tree = ownedTree();
  try {
    const f = fixture("R1", tree.identities), first = complete(f), firstView = view(first.publication), result = await publish(first.publication, tree.action, tree.identity);
    assert.equal(result.currentPublicationCallsReturned, true); assert.equal(result.historicalProducerAuthorityProven, false);
    const rawPath = join(tree.action, "capture-0.private"); assert.deepEqual(readFileSync(rawPath), firstView.raw); assert.equal(statSync(rawPath).mode & 0o7777, 0o600);
    const commit = readFileSync(join(tree.action, "capture-0.committed.json")); assert.deepEqual(commit, recordBytes(firstView.capture));
    f.advance(1000); const second = complete(f, request(f, "video.asset.track.deleted")), secondView = view(second.publication); await publish(second.publication, tree.action, tree.identity);
    const r1 = complete(f, rawContext(secondView), replayIntent(f, secondView, 0)); await publish(r1.publication, tree.action, tree.identity);
    const r2 = complete(f, rawContext(firstView), replayIntent(f, firstView, 1)); await publish(r2.publication, tree.action, tree.identity);
    assert.equal(readdirSync(tree.action).filter(name => name.endsWith(".private")).length, 2);
    assert.equal(readdirSync(tree.action).filter(name => name.startsWith("replay-")).length, 2);
    assert.equal(readdirSync(tree.action).filter(name => name.startsWith("admitted-")).length, 4);
    for (const name of readdirSync(tree.action)) assert.equal(lstatSync(join(tree.action, name)).mode & 0o7777, 0o600);
    const safeReplay = readFileSync(join(tree.action, "replay-0.observed.json"), "utf8"); assert.equal(safeReplay.includes(firstView.capture.rawEnvelopeSha256), false); assert.equal(safeReplay.includes("RAW_TOKEN_CANARY"), false);
    await assert.rejects(publish(first.publication, tree.action, tree.identity), CODE);
  } finally { tree.cleanup(); }
  assert.equal(existsSync(tree.base), false);
});

test("actual wx-only directory cannot support Node O_RDONLY directory fsync; corrected0770 works without O_PATH", async () => {
  const tree = ownedTree(); try {
    chmodSync(tree.action, 0o300); assert.throws(() => { const fd = openSync(tree.action, constants.O_RDONLY | constants.O_DIRECTORY); closeSync(fd); }, e => e.code === "EACCES");
    chmodSync(tree.action, 0o770); const f = fixture("D1", tree.identities); await publish(complete(f).publication, tree.action, tree.identity);
    assert.equal(statSync(join(tree.action, "capture-0.private")).mode & 0o7777, 0o600);
  } finally { chmodSync(tree.action, 0o770); tree.cleanup(); }
});

test("existing/raw symlink, changed inode and commit collision never overwrite or falsely commit", async () => {
  for (const fault of ["symlink", "inode", "commit"]) {
    const tree = ownedTree(); try {
      const f = fixture("D1", tree.identities), publication = complete(f).publication;
      if (fault === "symlink") { const target = join(tree.base, "protected"); writeFileSync(target, "UNCHANGED_CANARY", { mode: 0o600 }); symlinkSync(target, join(tree.action, "capture-0.private")); }
      if (fault === "inode") { renameSync(tree.action, tree.action + "-old"); mkdirSync(tree.action, 0o770); chmodSync(tree.action, 0o770); }
      if (fault === "commit") writeFileSync(join(tree.action, "capture-0.committed.json"), "IMMUTABLE_COMMIT_CANARY", { mode: 0o600 });
      await assert.rejects(publish(publication, tree.action, tree.identity), CODE); assert.equal(f.state.snapshot().sourceAuthorityProven, false);
      if (fault === "symlink") assert.equal(readFileSync(join(tree.base, "protected"), "utf8"), "UNCHANGED_CANARY");
      if (fault === "commit") assert.equal(readFileSync(join(tree.action, "capture-0.committed.json"), "utf8"), "IMMUTABLE_COMMIT_CANARY");
      assert.equal(existsSync(join(tree.action, "admitted-00.observed.json")), false);
    } finally { tree.cleanup(); }
  }
});

test("revocation during awaited directory-open closes acquired FD before refusing, with zero publication", async () => {
  const tree = ownedTree(), f = fixture("D1", tree.identities), publication = complete(f).publication, realOpen = fsp.open;
  let acquired;
  try {
    fsp.open = async (...args) => { const file = await realOpen(...args); if (args[0] === tree.action) { acquired = file; f.state.invalidate(); } return file; }; syncBuiltinESMExports();
    await assert.rejects(publish(publication, tree.action, tree.identity), CODE); assert.ok(acquired); assert.equal(acquired.fd, -1); assert.deepEqual(readdirSync(tree.action), []);
  } finally { fsp.open = realOpen; syncBuiltinESMExports(); tree.cleanup(); }
});

test("file-fsync failure preserves partial private evidence, omits commit and sanitizes error", async () => {
  const tree = ownedTree(), f = fixture("D1", tree.identities), publication = complete(f).publication, realOpen = fsp.open;
  try {
    fsp.open = async (...args) => { const file = await realOpen(...args); if (String(args[0]).endsWith("capture-0.private")) file.sync = async () => { throw Error("PRIVATE_FILESYSTEM_MESSAGE_CANARY"); }; return file; }; syncBuiltinESMExports();
    await assert.rejects(publish(publication, tree.action, tree.identity), error => CODE(error) && !String(error).includes("CANARY"));
    assert.equal(existsSync(join(tree.action, "capture-0.private")), true); assert.equal(existsSync(join(tree.action, "capture-0.committed.json")), false);
    assert.equal(f.state.snapshot().live, false);
  } finally { fsp.open = realOpen; syncBuiltinESMExports(); tree.cleanup(); }
});


test("a failed first reverse-replay observation cannot authorize the next metadata sequence", () => {
  const f = fixture("R1"), first = view(complete(f).publication); f.advance(1000);
  const second = view(complete(f, request(f, "video.asset.track.deleted")).publication);
  const failed = complete(f, rawContext(second), replayIntent(f, second, 0), 400);
  assert.equal(view(failed.publication).replay, null);
  assert.equal(f.state.select(begin(f), rawContext(first), f.clock, replayIntent(f, first, 1)), null);
});


test("revocation clears pending private raw buffers; elapsed publication deadline refuses without another hook", async () => {
  const f = fixture(), pending = complete(f).publication; f.state.invalidate(); assert.ok(view(pending).raw.every(byte => byte === 0));
  const tree = ownedTree(); try {
    const short = fixture("D1", tree.identities, 5), publication = complete(short).publication;
    await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(publish(publication, tree.action, tree.identity), CODE); assert.deepEqual(readdirSync(tree.action), []);
  } finally { tree.cleanup(); }
});
